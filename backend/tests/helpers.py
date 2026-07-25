# =============================================================================
# VELO Backend — Shared Test Helpers
# =============================================================================
#
# Utility functions used across multiple test files.
# Not a conftest (no fixtures here) — just plain functions.
#
# ANTI-REPLAY FIX (build_init_data):
#   _init_data_counter ensures every call produces a unique query_id field.
#   Without it, two login_user() calls for the same telegram_id in the same
#   second (e.g. in _make_verified_master: first login, then re-login after
#   role upgrade) share identical params -> identical HMAC hash -> the 2nd
#   call hits anti-replay protection and gets 400 "initData already used".
#   query_id is a real Telegram initData field, HMAC validation accepts it.
# =============================================================================

import hashlib
import hmac
import itertools
import json
import time
from unittest.mock import patch
from urllib.parse import urlencode

from httpx import AsyncClient
from sqlalchemy import String, cast, delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import AuditLog
from app.core.config import settings
from app.modules.bookings.models import Booking
from app.modules.diary.models import Checkin, DiaryEvent, Feedback
from app.modules.masters.groups_models import (
    GroupInvite,
    MasterGroup,
    MasterGroupMembership,
    MasterStudent,
)
from app.modules.masters.models import MasterProfile
from app.modules.notifications.models import Notification, NotificationDelivery
from app.modules.payments.models import (
    CompanyLedger,
    MasterLedger,
    Payment,
    Purchase,
    UserLedger,
)
from app.modules.practices.models import Practice, PracticeAudienceGroup
from app.modules.promos.models import Promo
from app.modules.reports.models import Report
from app.modules.users.models import User, UserRole
from app.modules.waitlist.models import Waitlist
from app.modules.withdrawals.models import Withdrawal

BOT_TOKEN = "123456:ABC-DEF"

# Module-level counter: makes every build_init_data() call produce a unique
# query_id field in initData. Without this, two login_user() calls for the
# same telegram_id within the same second generate identical auth_date + user
# params -> identical HMAC hash -> anti-replay protection blocks the 2nd call.
# query_id is a real Telegram initData field, so HMAC validation accepts it.
_init_data_counter = itertools.count(1)


def build_init_data(
    user_data: dict,
    bot_token: str = BOT_TOKEN,
    auth_date: int | None = None,
) -> str:
    """Build a valid Telegram initData query string with correct HMAC.

    Includes a unique query_id on every call (via _init_data_counter) so
    that multiple calls for the same telegram_id within the same second
    produce different hashes and don't trigger anti-replay protection.
    """
    if auth_date is None:
        auth_date = int(time.time())

    params = {
        "user": json.dumps(user_data),
        "auth_date": str(auth_date),
        "query_id": str(next(_init_data_counter)),
    }

    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(params.items()))
    secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    computed_hash = hmac.new(
        secret_key, data_check_string.encode(), hashlib.sha256
    ).hexdigest()

    params["hash"] = computed_hash
    return urlencode(params)


async def login_user(
    client: AsyncClient,
    telegram_id: int = 77001,
    first_name: str = "TestUser",
    username: str = "testuser",
) -> dict:
    """Create a user via POST /auth/telegram and return the response dict.

    Uses real PostgreSQL and Redis (runs on test VPS).
    Only patches telegram_bot_token for HMAC validation.
    """
    user_data = {"id": telegram_id, "first_name": first_name, "username": username}
    init_data = build_init_data(user_data)

    with patch.object(settings, "telegram_bot_token", BOT_TOKEN):
        response = await client.post(
            "/api/v1/auth/telegram",
            json={"init_data": init_data},
        )

    assert response.status_code == 200
    return response.json()


def auth_headers(token: str) -> dict:
    """Build Authorization header."""
    return {"Authorization": f"Bearer {token}"}


async def switch_self_to_master(client: AsyncClient, token: str) -> None:
    """Self-switch the caller (a verified applicant) into master mode (T4).

    Since ПРОМТ №295 admin approval sets status=verified but does NOT flip the
    user's role; the account gains master *capability* and self-switches via
    POST /users/me/role. Test factories that mint a master via apply + admin
    verify call this afterwards so the resulting session resolves role=master
    (the proven capability path, mirrors tests/test_role_switch.py). The
    endpoint commits, so a subsequent request / re-login sees role=master.
    """
    resp = await client.post(
        "/api/v1/users/me/role",
        headers=auth_headers(token),
        json={"role": "master"},
    )
    assert resp.status_code == 200, (
        f"self-switch to master failed: {resp.status_code} {resp.text}"
    )


async def cleanup_range(
    session: AsyncSession,
    tid_min: int,
    tid_max: int,
) -> None:
    """Delete master profiles and reset roles for a telegram_id range.

    TD-032: lightweight cleanup for tests that only touch master_profiles
    and roles (no bookings, ledger, practices, etc.).
    Use full_cleanup_range for heavier test suites.

    Args:
        session: Active async session (caller must commit after).
        tid_min: Lower bound of the telegram_id range (inclusive).
        tid_max: Upper bound of the telegram_id range (inclusive).
    """
    in_range = User.telegram_id.between(tid_min, tid_max)
    await session.execute(
        delete(MasterProfile).where(
            MasterProfile.user_id.in_(
                select(User.id).where(in_range)
            )
        )
    )
    await session.execute(
        update(User)
        .where(in_range, User.role != UserRole.USER.value)
        .values(role=UserRole.USER.value)
    )


async def full_cleanup_range(
    session: AsyncSession,
    tid_min: int,
    tid_max: int,
    *,
    delete_users: bool = False,
) -> None:
    """Delete all test data for a telegram_id range in FK-safe order.

    TD-032: single source of truth for test cleanup. Replaces per-file
    raw SQL cleanup lists. Covers every table in dependency order so
    FK constraints are never violated.

    When adding a new table to the schema, add a DELETE step here in the
    correct FK position and mark it with a comment:
        # ADD NEW TABLES HERE (above the table they reference)

    Args:
        session: Active async session. Caller must commit after.
        tid_min: Lower bound of telegram_id range (inclusive).
        tid_max: Upper bound of telegram_id range (inclusive).
        delete_users: If True, hard-delete users in the range.
                      Use for tests that count absolute user totals
                      (e.g. test_admin_stats). Default: False (role reset).
    """
    await session.rollback()

    # Reusable subqueries.
    user_ids_subq = select(User.id).where(
        User.telegram_id.between(tid_min, tid_max)
    )
    practice_ids_subq = select(Practice.id).where(
        Practice.master_id.in_(user_ids_subq)
    )
    group_ids_subq = select(MasterGroup.id).where(
        MasterGroup.master_id.in_(user_ids_subq)
    )
    purchase_ids_subq = select(Purchase.id).where(
        Purchase.user_id.in_(user_ids_subq)
    )
    withdrawal_ids_subq = select(Withdrawal.id).where(
        Withdrawal.user_id.in_(user_ids_subq)
    )

    # String-cast subqueries for JSONB / text-value comparisons.
    user_ids_str_subq = select(cast(User.id, String)).where(
        User.telegram_id.between(tid_min, tid_max)
    )
    practice_ids_str_subq = select(cast(Practice.id, String)).where(
        Practice.master_id.in_(user_ids_subq)
    )

    # -----------------------------------------------------------------------
    # 1. notification_deliveries
    #    FK -> notifications.id (CASCADE), FK -> users.id (CASCADE).
    # -----------------------------------------------------------------------
    await session.execute(
        delete(NotificationDelivery).where(
            NotificationDelivery.user_id.in_(user_ids_subq)
        )
    )

    # -----------------------------------------------------------------------
    # 2. notifications
    #    No direct FK to users. Linked via:
    #      target_value              — string UUID of the target user
    #      action_data->>'practice_id' — JSONB reference to a practice
    # -----------------------------------------------------------------------
    await session.execute(
        delete(Notification).where(
            or_(
                Notification.target_value.in_(user_ids_str_subq),
                Notification.action_data["practice_id"].astext.in_(
                    practice_ids_str_subq
                ),
            )
        )
    )

    # -----------------------------------------------------------------------
    # 3. checkins   FK -> users.id (CASCADE), practices.id (SET NULL)
    # 4. feedbacks  FK -> users.id (CASCADE), practices.id (SET NULL)
    # 4b. diary_events  FK -> users.id (CASCADE). Append-only feed journal
    #     (Diary redesign). No table references it yet (relations socket is
    #     future), so it can be deleted here with the other diary tables.
    # ADD NEW TABLES HERE (diary-like domain tables before audit_logs)
    # -----------------------------------------------------------------------
    await session.execute(
        delete(Checkin).where(Checkin.user_id.in_(user_ids_subq))
    )
    await session.execute(
        delete(Feedback).where(Feedback.user_id.in_(user_ids_subq))
    )
    await session.execute(
        delete(DiaryEvent).where(DiaryEvent.user_id.in_(user_ids_subq))
    )

    # -----------------------------------------------------------------------
    # 5. audit_logs  FK -> users.id (actor_id)
    # -----------------------------------------------------------------------
    await session.execute(
        delete(AuditLog).where(AuditLog.actor_id.in_(user_ids_subq))
    )

    # -----------------------------------------------------------------------
    # 6. company_ledger
    #    No user FK. reference_id points to purchases, practices, or
    #    withdrawals in this range.
    # ADD NEW TABLES HERE (before company_ledger if they reference it)
    # -----------------------------------------------------------------------
    await session.execute(
        delete(CompanyLedger).where(
            or_(
                CompanyLedger.reference_id.in_(purchase_ids_subq),
                CompanyLedger.reference_id.in_(practice_ids_subq),
                CompanyLedger.reference_id.in_(withdrawal_ids_subq),
            )
        )
    )

    # -----------------------------------------------------------------------
    # 7. master_ledger  FK -> users.id (RESTRICT), practices.id (SET NULL)
    # 8. user_ledger    FK -> users.id (RESTRICT)
    # 9. payments       FK -> users.id (RESTRICT)
    # -----------------------------------------------------------------------
    await session.execute(
        delete(MasterLedger).where(MasterLedger.user_id.in_(user_ids_subq))
    )
    await session.execute(
        delete(UserLedger).where(UserLedger.user_id.in_(user_ids_subq))
    )
    await session.execute(
        delete(Payment).where(Payment.user_id.in_(user_ids_subq))
    )

    # -----------------------------------------------------------------------
    # 10. purchases
    #     FK -> users.id (RESTRICT), bookings.id (RESTRICT),
    #           practices.id (RESTRICT), promos.id (SET NULL).
    #     Must precede bookings (RESTRICT on booking_id).
    # -----------------------------------------------------------------------
    await session.execute(
        delete(Purchase).where(Purchase.user_id.in_(user_ids_subq))
    )

    # -----------------------------------------------------------------------
    # 11. waitlist    FK -> users.id (CASCADE), practices.id (CASCADE)
    # 12. bookings    FK -> users.id (CASCADE), practices.id (CASCADE)
    # 13. withdrawals FK -> users.id (CASCADE)
    # 14. reports     FK -> users.id (CASCADE, reporter_id)
    # ADD NEW TABLES HERE (domain tables that FK -> users / practices)
    # -----------------------------------------------------------------------
    await session.execute(
        delete(Waitlist).where(Waitlist.user_id.in_(user_ids_subq))
    )
    await session.execute(
        delete(Booking).where(Booking.user_id.in_(user_ids_subq))
    )
    await session.execute(
        delete(Withdrawal).where(Withdrawal.user_id.in_(user_ids_subq))
    )
    await session.execute(
        delete(Report).where(Report.reporter_id.in_(user_ids_subq))
    )

    # -----------------------------------------------------------------------
    # 15. promos  FK -> users.id (CASCADE, master_id), practices.id (SET NULL)
    # -----------------------------------------------------------------------
    await session.execute(
        delete(Promo).where(Promo.master_id.in_(user_ids_subq))
    )

    # -----------------------------------------------------------------------
    # Master GROUPS (P1-P5, ПРОМТ №590-594): practice_audience_group and
    # group_invite both FK -> master_group.id (CASCADE); practice_audience_
    # group ALSO FK -> practices.id (CASCADE) -- must precede BOTH master_
    # group (below) and practices (below). master_group_membership FK ->
    # master_group.id + users.id (both CASCADE) -- precedes master_group too.
    # Deleted here, ABOVE practices/master_group, for that reason.
    # -----------------------------------------------------------------------
    await session.execute(
        delete(PracticeAudienceGroup).where(
            or_(
                PracticeAudienceGroup.practice_id.in_(practice_ids_subq),
                PracticeAudienceGroup.group_id.in_(group_ids_subq),
            )
        )
    )
    await session.execute(
        delete(GroupInvite).where(GroupInvite.group_id.in_(group_ids_subq))
    )
    await session.execute(
        delete(MasterGroupMembership).where(
            or_(
                MasterGroupMembership.group_id.in_(group_ids_subq),
                MasterGroupMembership.student_user_id.in_(user_ids_subq),
            )
        )
    )

    # -----------------------------------------------------------------------
    # 16. practices       FK -> users.id (master_id)
    # 17. master_profiles FK -> users.id
    # ADD NEW TABLES HERE (before master_profiles / practices)
    # -----------------------------------------------------------------------
    await session.execute(
        delete(Practice).where(Practice.master_id.in_(user_ids_subq))
    )
    await session.execute(
        delete(MasterProfile).where(MasterProfile.user_id.in_(user_ids_subq))
    )

    # -----------------------------------------------------------------------
    # master_group / master_student (P1, ПРОМТ №590): both FK -> users.id
    # only (CASCADE), no ordering dependency between them -- both must still
    # precede nothing further downstream. master_group.id is what group_
    # ids_subq (above) resolves, so this delete must come AFTER the three
    # child-table deletes above, not before.
    # -----------------------------------------------------------------------
    await session.execute(
        delete(MasterGroup).where(MasterGroup.master_id.in_(user_ids_subq))
    )
    await session.execute(
        delete(MasterStudent).where(
            or_(
                MasterStudent.master_id.in_(user_ids_subq),
                MasterStudent.student_user_id.in_(user_ids_subq),
            )
        )
    )

    # -----------------------------------------------------------------------
    # 18. Reset role + balance (when keeping users).
    # 19. users — only when delete_users=True.
    # -----------------------------------------------------------------------
    if not delete_users:
        await session.execute(
            update(User)
            .where(User.telegram_id.between(tid_min, tid_max))
            .values(role=UserRole.USER.value, balance_cents=0)
        )
    else:
        await session.execute(
            delete(User).where(User.telegram_id.between(tid_min, tid_max))
        )
