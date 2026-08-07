# =============================================================================
# Tests: Cancellation & Refunds (Phase 6.5)
# =============================================================================
#
# telegram_id range: 76000-76999
#   76001-76099: masters
#   76100-76199: regular users
#
# Scenarios tested:
#   A) User cancel > 24h before  -> 100% refund (Purchase -> REFUNDED)
#   B) User cancel < 24h before  -> 0% refund   (Purchase -> COMPLETED)
#   C) Master cancels practice   -> 100% refund to all
#
# Invariants verified:
#   - SUM(all ledgers) == 0 after each operation
#   - User balance restoration (refund) or preservation (late cancel)
#   - Master balance changes (frozen decreases, available updates)
#   - Purchase status transitions
#   - Audit log entries
#   - Waitlist cleared on master cancel
#   - PATCH status=cancelled blocked (must use POST /cancel)
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import datetime, timedelta, timezone
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import AuditLog
from app.core.config import settings
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.masters.models import MasterProfile
from app.modules.payments.models import (
    CompanyLedger,
    LedgerStatus,
    MasterLedger,
    Purchase,
    PurchaseStatus,
    UserLedger,
)
from app.modules.payments.service import record_user_ledger
from app.modules.practices.models import PracticeStatus
from app.modules.users.models import User, UserRole
from app.modules.waitlist.models import Waitlist, WaitlistStatus
from tests.helpers import auth_headers, fresh_execute, login_user


# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

_TID_RANGE = (
    "SELECT id FROM users WHERE telegram_id BETWEEN 76000 AND 76999"
)
_MASTER_RANGE = (
    "SELECT id FROM users WHERE telegram_id BETWEEN 76000 AND 76099"
)

_CLEANUP_QUERIES = [
    text(
        "DELETE FROM audit_logs WHERE actor_id IN (" + _TID_RANGE + ")"
    ),
    text(
        "DELETE FROM company_ledger WHERE reference_id IN "
        "(SELECT id FROM purchases WHERE user_id IN (" + _TID_RANGE + "))"
    ),
    text(
        "DELETE FROM master_ledger WHERE user_id IN (" + _TID_RANGE + ")"
    ),
    text(
        "DELETE FROM user_ledger WHERE user_id IN (" + _TID_RANGE + ")"
    ),
    text(
        "UPDATE bookings SET purchase_id = NULL "
        "WHERE user_id IN (" + _TID_RANGE + ")"
    ),
    text(
        "DELETE FROM purchases WHERE user_id IN (" + _TID_RANGE + ")"
    ),
    text(
        "DELETE FROM waitlist WHERE user_id IN (" + _TID_RANGE + ")"
    ),
    text(
        "DELETE FROM bookings WHERE user_id IN (" + _TID_RANGE + ")"
    ),
    text(
        "DELETE FROM practices WHERE master_id IN (" + _MASTER_RANGE + ")"
    ),
    text(
        "DELETE FROM master_profiles WHERE user_id IN (" + _TID_RANGE + ")"
    ),
    text(
        "UPDATE users SET role = 'user', balance_cents = 0 "
        "WHERE telegram_id BETWEEN 76000 AND 76999"
    ),
]


async def _full_cleanup(db_session: AsyncSession) -> None:
    """Run all cleanup queries in dependency order."""
    for stmt in _CLEANUP_QUERIES:
        await db_session.execute(stmt)
    await db_session.commit()


@pytest.fixture(autouse=True)
async def cleanup(
    db_session: AsyncSession,
) -> AsyncGenerator[None, None]:
    """Clean all cancellation-test data before and after each test."""
    await _full_cleanup(db_session)
    yield
    await _full_cleanup(db_session)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

BOOKINGS_URL = "/api/v1/bookings"
PRACTICES_URL = "/api/v1/practices"
CANCEL_PRACTICE_URL = "/api/v1/practices/{practice_id}/cancel"


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int = 76001,
) -> dict:
    """Create a verified master via login + direct DB update."""
    user_data = await login_user(
        client, telegram_id=telegram_id, first_name="Master",
    )
    user_id = user_data["user"]["id"]

    stmt = select(User).where(User.id == user_id)
    result = await db_session.execute(stmt)
    user = result.scalar_one()
    user.role = UserRole.MASTER.value
    await db_session.flush()

    profile = MasterProfile(
        user_id=UUID(user_id),
        data={"account": {"status": "verified"}},
    )
    db_session.add(profile)
    await db_session.commit()

    return user_data


async def _create_practice(
    client: AsyncClient,
    master_data: dict,
    *,
    is_free: bool = True,
    price_cents: int = 0,
    max_participants: int | None = None,
    hours_ahead: int = 168,
) -> str:
    """Create a scheduled practice with configurable scheduled_at.

    hours_ahead controls how far in the future scheduled_at is:
      hours_ahead=168 (7 days) -> cancel is > 24h -> refund
      hours_ahead=1            -> cancel is < 24h -> early finalize
    """
    body: dict = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Cancel Test Practice",
        "scheduled_at": (
            datetime.now(timezone.utc) + timedelta(hours=hours_ahead)
        ).isoformat(),
        "duration_minutes": 60,
        "timezone": "UTC",
        "is_free": is_free,
        "price_cents": price_cents,
        "currency": "eur",
    }
    if max_participants is not None:
        body["max_participants"] = max_participants

    token = master_data["session_token"]

    resp = await client.post(
        PRACTICES_URL,
        json=body,
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    practice_id = resp.json()["id"]

    resp = await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"status": "scheduled"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 200

    return practice_id


async def _topup_user(user_id: str, amount_cents: int) -> None:
    """Top up user balance via a separate session."""
    from app.core.database import get_session_factory
    factory = get_session_factory()
    async with factory() as session:
        await record_user_ledger(
            user_id=UUID(user_id),
            amount_cents=amount_cents,
            reason="test:topup",
            session=session,
        )
        await session.commit()


async def _book_user(
    client: AsyncClient,
    user_data: dict,
    practice_id: str,
) -> str:
    """Book a user into a practice, return booking_id."""
    resp = await client.post(
        BOOKINGS_URL,
        json={"practice_id": practice_id},
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 201
    return resp.json()["id"]


async def _cancel_booking(
    client: AsyncClient,
    user_data: dict,
    booking_id: str,
) -> int:
    """Cancel a booking, return HTTP status code."""
    resp = await client.delete(
        f"{BOOKINGS_URL}/{booking_id}",
        headers=auth_headers(user_data["session_token"]),
    )
    return resp.status_code


# ===================================================================
# SCENARIO A: User cancels > 24h before -> 100% refund
# ===================================================================


@pytest.mark.asyncio
async def test_refund_paid_cancel_early(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Cancel > 24h before: paid user gets 100% refund, Purchase -> REFUNDED."""
    master_data = await _make_verified_master(
        client, db_session, telegram_id=76001,
    )
    practice_id = await _create_practice(
        client, master_data,
        is_free=False, price_cents=5000, hours_ahead=168,
    )

    user_data = await login_user(
        client, telegram_id=76100, first_name="Buyer",
    )
    user_id = user_data["user"]["id"]
    await _topup_user(user_id, 5000)

    booking_id = await _book_user(client, user_data, practice_id)

    # Verify balance after booking: user=0, master frozen=5000.
    db_session.expire_all()
    user = (await db_session.execute(
        select(User).where(User.id == user_id),
    )).scalar_one()
    assert user.balance_cents == 0

    # Cancel (> 24h before).
    status_code = await _cancel_booking(client, user_data, booking_id)
    assert status_code == 200

    # Verify Purchase -> REFUNDED.
    db_session.expire_all()
    purchase = (await db_session.execute(
        select(Purchase).where(Purchase.booking_id == booking_id),
    )).scalar_one()
    assert purchase.status == PurchaseStatus.REFUNDED.value

    # Verify user balance restored.
    user = (await db_session.execute(
        select(User).where(User.id == user_id),
    )).scalar_one()
    assert user.balance_cents == 5000

    # Verify master frozen decreased back to 0.
    master_id = master_data["user"]["id"]
    profile = (await db_session.execute(
        select(MasterProfile).where(
            MasterProfile.user_id == master_id,
        ),
    )).scalar_one()
    assert profile.frozen_cents == 0


@pytest.mark.asyncio
async def test_refund_free_cancel_early(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Cancel > 24h before: free practice -> REFUNDED with zero-amount entries."""
    master_data = await _make_verified_master(
        client, db_session, telegram_id=76002,
    )
    practice_id = await _create_practice(
        client, master_data, is_free=True, hours_ahead=168,
    )

    user_data = await login_user(
        client, telegram_id=76101, first_name="FreeBuyer",
    )

    booking_id = await _book_user(client, user_data, practice_id)
    status_code = await _cancel_booking(client, user_data, booking_id)
    assert status_code == 200

    db_session.expire_all()
    purchase = (await db_session.execute(
        select(Purchase).where(Purchase.booking_id == booking_id),
    )).scalar_one()
    assert purchase.status == PurchaseStatus.REFUNDED.value
    assert purchase.paid_cents == 0


@pytest.mark.asyncio
async def test_refund_double_entry_sum_zero(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """After refund: SUM(all ledgers) == 0 for the practice."""
    master_data = await _make_verified_master(
        client, db_session, telegram_id=76003,
    )
    practice_id = await _create_practice(
        client, master_data,
        is_free=False, price_cents=3000, hours_ahead=168,
    )

    user_data = await login_user(
        client, telegram_id=76102, first_name="Buyer",
    )
    await _topup_user(user_data["user"]["id"], 3000)

    booking_id = await _book_user(client, user_data, practice_id)
    await _cancel_booking(client, user_data, booking_id)

    db_session.expire_all()
    pid = UUID(practice_id)

    # User ledger sum for this practice.
    user_sum = (await db_session.execute(
        select(func.coalesce(func.sum(UserLedger.amount_cents), 0))
        .where(UserLedger.reason.like(f"%practice={pid}%"))
    )).scalar_one()

    # Master ledger sum for this practice.
    master_sum = (await db_session.execute(
        select(func.coalesce(func.sum(MasterLedger.amount_cents), 0))
        .where(
            MasterLedger.practice_id == pid,
            MasterLedger.status == LedgerStatus.DONE.value,
        )
    )).scalar_one()

    assert user_sum + master_sum == 0


# ===================================================================
# SCENARIO B: User cancels < 24h before -> 0% refund (early finalize)
# ===================================================================


@pytest.mark.asyncio
async def test_late_cancel_paid_early_finalize(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Cancel < 24h before: no refund, Purchase -> COMPLETED with commission."""
    master_data = await _make_verified_master(
        client, db_session, telegram_id=76004,
    )
    # Practice starts in 1 hour -> well within 24h deadline.
    practice_id = await _create_practice(
        client, master_data,
        is_free=False, price_cents=10000, hours_ahead=1,
    )

    user_data = await login_user(
        client, telegram_id=76103, first_name="LateBuyer",
    )
    user_id = user_data["user"]["id"]
    await _topup_user(user_id, 10000)

    booking_id = await _book_user(client, user_data, practice_id)
    status_code = await _cancel_booking(client, user_data, booking_id)
    assert status_code == 200

    db_session.expire_all()

    # Purchase -> COMPLETED (not REFUNDED).
    purchase = (await db_session.execute(
        select(Purchase).where(Purchase.booking_id == booking_id),
    )).scalar_one()
    assert purchase.status == PurchaseStatus.COMPLETED.value

    # Commission calculated.
    expected_commission = int(10000 * settings.commission_percent / 100)
    assert purchase.commission_cents == expected_commission
    assert purchase.completed_at is not None

    # User balance stays 0 (no refund).
    user = (await db_session.execute(
        select(User).where(User.id == user_id),
    )).scalar_one()
    assert user.balance_cents == 0

    # Master: frozen=0, available = 10000 - commission.
    master_id = master_data["user"]["id"]
    profile = (await db_session.execute(
        select(MasterProfile).where(
            MasterProfile.user_id == master_id,
        ),
    )).scalar_one()
    assert profile.frozen_cents == 0
    assert profile.available_cents == 10000 - expected_commission

    # Company ledger got commission.
    cl = (await db_session.execute(
        select(CompanyLedger).where(
            CompanyLedger.reference_id == purchase.id,
        ),
    )).scalar_one()
    assert cl.amount_cents == expected_commission


@pytest.mark.asyncio
async def test_late_cancel_free_early_finalize(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Cancel < 24h before: free practice -> COMPLETED, zero commission."""
    master_data = await _make_verified_master(
        client, db_session, telegram_id=76005,
    )
    practice_id = await _create_practice(
        client, master_data, is_free=True, hours_ahead=1,
    )

    user_data = await login_user(
        client, telegram_id=76104, first_name="FreeLate",
    )

    booking_id = await _book_user(client, user_data, practice_id)
    status_code = await _cancel_booking(client, user_data, booking_id)
    assert status_code == 200

    db_session.expire_all()
    purchase = (await db_session.execute(
        select(Purchase).where(Purchase.booking_id == booking_id),
    )).scalar_one()
    assert purchase.status == PurchaseStatus.COMPLETED.value
    assert purchase.commission_cents == 0


@pytest.mark.asyncio
async def test_late_cancel_double_entry_sum_zero(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """After late cancel: SUM(user + master + company ledgers) == 0."""
    master_data = await _make_verified_master(
        client, db_session, telegram_id=76006,
    )
    practice_id = await _create_practice(
        client, master_data,
        is_free=False, price_cents=8000, hours_ahead=1,
    )

    user_data = await login_user(
        client, telegram_id=76105, first_name="Buyer",
    )
    await _topup_user(user_data["user"]["id"], 8000)

    booking_id = await _book_user(client, user_data, practice_id)
    await _cancel_booking(client, user_data, booking_id)

    db_session.expire_all()
    pid = UUID(practice_id)

    # User ledger (purchase debit only, no refund).
    user_purchase_sum = (await db_session.execute(
        select(func.coalesce(func.sum(UserLedger.amount_cents), 0))
        .where(UserLedger.reason.like(f"%practice={pid}%"))
    )).scalar_one()

    # Master ledger for this practice (all entries).
    master_sum = (await db_session.execute(
        select(func.coalesce(func.sum(MasterLedger.amount_cents), 0))
        .where(
            MasterLedger.practice_id == pid,
            MasterLedger.status == LedgerStatus.DONE.value,
        )
    )).scalar_one()

    # Company ledger via purchase.
    purchase = (await db_session.execute(
        select(Purchase).where(Purchase.booking_id == booking_id),
    )).scalar_one()
    company_sum = (await db_session.execute(
        select(func.coalesce(func.sum(CompanyLedger.amount_cents), 0))
        .where(CompanyLedger.reference_id == purchase.id)
    )).scalar_one()

    assert user_purchase_sum + master_sum + company_sum == 0


# ===================================================================
# SCENARIO C: Master cancels entire practice -> 100% refund all
# ===================================================================


@pytest.mark.asyncio
async def test_master_cancel_practice_refunds_all(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Master cancels practice: all active bookings refunded."""
    master_data = await _make_verified_master(
        client, db_session, telegram_id=76007,
    )
    practice_id = await _create_practice(
        client, master_data,
        is_free=False, price_cents=4000, hours_ahead=168,
        max_participants=5,
    )

    # Two users book.
    user1 = await login_user(
        client, telegram_id=76106, first_name="User1",
    )
    await _topup_user(user1["user"]["id"], 4000)
    bid1 = await _book_user(client, user1, practice_id)

    user2 = await login_user(
        client, telegram_id=76107, first_name="User2",
    )
    await _topup_user(user2["user"]["id"], 4000)
    bid2 = await _book_user(client, user2, practice_id)

    # Master cancels practice.
    resp = await client.post(
        CANCEL_PRACTICE_URL.format(practice_id=practice_id),
        headers=auth_headers(master_data["session_token"]),
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "cancelled"

    db_session.expire_all()

    # Both purchases -> REFUNDED.
    for bid in [bid1, bid2]:
        purchase = (await fresh_execute(
            select(Purchase).where(Purchase.booking_id == bid),
        )).scalar_one()
        assert purchase.status == PurchaseStatus.REFUNDED.value

    # Both bookings -> cancelled.
    for bid in [bid1, bid2]:
        booking = (await db_session.execute(
            select(Booking).where(Booking.id == bid),
        )).scalar_one()
        assert booking.status == BookingStatus.CANCELLED.value

    # Both users get money back.
    for uid in [user1["user"]["id"], user2["user"]["id"]]:
        user = (await db_session.execute(
            select(User).where(User.id == uid),
        )).scalar_one()
        assert user.balance_cents == 4000

    # Master frozen = 0.
    profile = (await db_session.execute(
        select(MasterProfile).where(
            MasterProfile.user_id == master_data["user"]["id"],
        ),
    )).scalar_one()
    assert profile.frozen_cents == 0


@pytest.mark.asyncio
async def test_master_cancel_free_practice(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Master cancels free practice: zero-amount refunds created."""
    master_data = await _make_verified_master(
        client, db_session, telegram_id=76008,
    )
    practice_id = await _create_practice(
        client, master_data, is_free=True, hours_ahead=168,
        max_participants=5,
    )

    user_data = await login_user(
        client, telegram_id=76108, first_name="FreeUser",
    )
    bid = await _book_user(client, user_data, practice_id)

    resp = await client.post(
        CANCEL_PRACTICE_URL.format(practice_id=practice_id),
        headers=auth_headers(master_data["session_token"]),
    )
    assert resp.status_code == 200

    db_session.expire_all()
    purchase = (await fresh_execute(
        select(Purchase).where(Purchase.booking_id == bid),
    )).scalar_one()
    assert purchase.status == PurchaseStatus.REFUNDED.value
    assert purchase.paid_cents == 0


@pytest.mark.asyncio
async def test_master_cancel_clears_waitlist(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Master cancels practice: all active waitlist entries -> left."""
    master_data = await _make_verified_master(
        client, db_session, telegram_id=76009,
    )
    practice_id = await _create_practice(
        client, master_data, is_free=True, max_participants=1,
        hours_ahead=168,
    )

    # Fill the single slot.
    user1 = await login_user(
        client, telegram_id=76109, first_name="Filler",
    )
    await _book_user(client, user1, practice_id)

    # Second user joins waitlist.
    user2 = await login_user(
        client, telegram_id=76110, first_name="Waiter",
    )
    wl_resp = await client.post(
        f"{PRACTICES_URL}/{practice_id}/waitlist",
        headers=auth_headers(user2["session_token"]),
    )
    assert wl_resp.status_code == 201

    # Master cancels.
    resp = await client.post(
        CANCEL_PRACTICE_URL.format(practice_id=practice_id),
        headers=auth_headers(master_data["session_token"]),
    )
    assert resp.status_code == 200

    # Waitlist entry -> left.
    db_session.expire_all()
    wl = (await fresh_execute(
        select(Waitlist).where(
            Waitlist.practice_id == UUID(practice_id),
            Waitlist.user_id == UUID(user2["user"]["id"]),
        ),
    )).scalar_one()
    assert wl.status == WaitlistStatus.LEFT.value


# ===================================================================
# GUARDS & EDGE CASES
# ===================================================================


@pytest.mark.asyncio
async def test_cancel_idempotent_no_double_refund(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Cancelling already-cancelled booking -> 400, no double refund."""
    master_data = await _make_verified_master(
        client, db_session, telegram_id=76010,
    )
    practice_id = await _create_practice(
        client, master_data,
        is_free=False, price_cents=5000, hours_ahead=168,
    )

    user_data = await login_user(
        client, telegram_id=76111, first_name="Buyer",
    )
    await _topup_user(user_data["user"]["id"], 5000)

    booking_id = await _book_user(client, user_data, practice_id)

    # First cancel: success.
    status1 = await _cancel_booking(client, user_data, booking_id)
    assert status1 == 200

    # Second cancel: 400 (already cancelled).
    status2 = await _cancel_booking(client, user_data, booking_id)
    assert status2 == 400

    # Balance is exactly 5000 (not 10000).
    db_session.expire_all()
    user = (await db_session.execute(
        select(User).where(User.id == user_data["user"]["id"]),
    )).scalar_one()
    assert user.balance_cents == 5000


@pytest.mark.asyncio
async def test_cancel_practice_not_owner_404(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Non-owner master cancelling practice: 404 (P-08)."""
    master1 = await _make_verified_master(
        client, db_session, telegram_id=76011,
    )
    master2 = await _make_verified_master(
        client, db_session, telegram_id=76012,
    )
    practice_id = await _create_practice(
        client, master1, is_free=True, hours_ahead=168,
    )

    resp = await client.post(
        CANCEL_PRACTICE_URL.format(practice_id=practice_id),
        headers=auth_headers(master2["session_token"]),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_cancel_practice_wrong_status_400(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Cannot cancel a draft practice: 400."""
    master_data = await _make_verified_master(
        client, db_session, telegram_id=76013,
    )

    # Create but don't publish (stays draft).
    body = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Draft Practice",
        "scheduled_at": (
            datetime.now(timezone.utc) + timedelta(days=7)
        ).isoformat(),
        "duration_minutes": 60,
        "timezone": "UTC",
        "is_free": True,
        "price_cents": 0,
        "currency": "eur",
    }
    resp = await client.post(
        PRACTICES_URL,
        json=body,
        headers=auth_headers(master_data["session_token"]),
    )
    assert resp.status_code == 201
    practice_id = resp.json()["id"]

    resp = await client.post(
        CANCEL_PRACTICE_URL.format(practice_id=practice_id),
        headers=auth_headers(master_data["session_token"]),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_patch_status_cancelled_blocked(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """PATCH status=cancelled is blocked (must use POST /cancel).

    I-04: 'cancelled' removed from UpdatePracticeRequest Literal,
    so FastAPI rejects with 422 before reaching service layer.
    """
    master_data = await _make_verified_master(
        client, db_session, telegram_id=76014,
    )
    practice_id = await _create_practice(
        client, master_data, is_free=True, hours_ahead=168,
    )

    resp = await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"status": "cancelled"},
        headers=auth_headers(master_data["session_token"]),
    )
    # I-04: Pydantic Literal validation rejects before service (422 not 400).
    assert resp.status_code == 422


# ===================================================================
# AUDIT LOG TESTS
# ===================================================================


@pytest.mark.asyncio
async def test_audit_log_refund(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Refund creates audit entry with event=purchase_refunded."""
    master_data = await _make_verified_master(
        client, db_session, telegram_id=76015,
    )
    practice_id = await _create_practice(
        client, master_data,
        is_free=False, price_cents=2000, hours_ahead=168,
    )

    user_data = await login_user(
        client, telegram_id=76112, first_name="AuditBuyer",
    )
    await _topup_user(user_data["user"]["id"], 2000)

    booking_id = await _book_user(client, user_data, practice_id)
    await _cancel_booking(client, user_data, booking_id)

    db_session.expire_all()
    purchase = (await db_session.execute(
        select(Purchase).where(Purchase.booking_id == booking_id),
    )).scalar_one()

    audit = (await db_session.execute(
        select(AuditLog).where(
            AuditLog.event == "purchase_refunded",
            AuditLog.target_id == purchase.id,
        ),
    )).scalar_one()
    assert audit.data["trigger"] == "user_cancel"
    assert audit.data["refunded_cents"] == 2000


@pytest.mark.asyncio
async def test_audit_log_late_cancel(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Late cancel creates audit entry with event=purchase_completed, trigger=late_cancel."""
    master_data = await _make_verified_master(
        client, db_session, telegram_id=76016,
    )
    practice_id = await _create_practice(
        client, master_data,
        is_free=False, price_cents=3000, hours_ahead=1,
    )

    user_data = await login_user(
        client, telegram_id=76113, first_name="LateAudit",
    )
    await _topup_user(user_data["user"]["id"], 3000)

    booking_id = await _book_user(client, user_data, practice_id)
    await _cancel_booking(client, user_data, booking_id)

    db_session.expire_all()
    purchase = (await db_session.execute(
        select(Purchase).where(Purchase.booking_id == booking_id),
    )).scalar_one()

    audit = (await db_session.execute(
        select(AuditLog).where(
            AuditLog.event == "purchase_completed",
            AuditLog.target_id == purchase.id,
        ),
    )).scalar_one()
    assert audit.data["trigger"] == "late_cancel"
    assert audit.data["commission_cents"] == int(
        3000 * settings.commission_percent / 100,
    )


@pytest.mark.asyncio
async def test_audit_log_master_cancel(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Master cancel creates audit entry with event=practice_cancelled_by_master."""
    master_data = await _make_verified_master(
        client, db_session, telegram_id=76017,
    )
    practice_id = await _create_practice(
        client, master_data, is_free=True, hours_ahead=168,
    )

    resp = await client.post(
        CANCEL_PRACTICE_URL.format(practice_id=practice_id),
        headers=auth_headers(master_data["session_token"]),
    )
    assert resp.status_code == 200

    db_session.expire_all()
    audit = (await fresh_execute(
        select(AuditLog).where(
            AuditLog.event == "practice_cancelled_by_master",
            AuditLog.target_id == UUID(practice_id),
        ),
    )).scalar_one()
    assert audit.actor_id == UUID(master_data["user"]["id"])
