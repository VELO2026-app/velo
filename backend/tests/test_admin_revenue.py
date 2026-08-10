# =============================================================================
# VELO Backend -- Tests: Admin Revenue (E9 / 4b)
# =============================================================================
#
# telegram_id range: 93000-93999
#   93900     -- admin caller
#   93800     -- master (earnings / payouts / practice owner)
#   93001+    -- buyers
#
# Revenue/commission/payout are PLATFORM-WIDE, so seed data is present. Totals
# are asserted by DELTA (baseline -> insert -> difference); per_master is keyed
# on an isolated 93xxx master that seed never references.
#
# Cleanup is explicit + FK-safe: financial tables are RESTRICT on user_id, so
# full_cleanup_range cannot delete them -- we clear them before the users.
# company_ledger has no user link, so test rows are tagged "revtest:" and
# deleted by reason.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.bookings.models import Booking, BookingStatus
from app.modules.masters.models import MasterProfile
from app.modules.payments.models import (
    CompanyLedger,
    CompanyLedgerType,
    LedgerStatus,
    MasterLedger,
    Purchase,
    PurchaseStatus,
)
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from app.modules.withdrawals.models import Withdrawal, WithdrawalStatus
from tests.helpers import auth_headers, login_user

REVENUE_URL = "/api/v1/admin/revenue"

_TID_MIN = 93000
_TID_MAX = 93999
_REASON = "revtest:"


# ===================================================================
# Cleanup (explicit, FK-safe)
# ===================================================================


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await _do_cleanup(db_session)
    yield
    await _do_cleanup(db_session)


async def _do_cleanup(session: AsyncSession) -> None:
    await session.rollback()
    subq = select(User.id).where(User.telegram_id.between(_TID_MIN, _TID_MAX))

    # company_ledger: no user link -> delete test rows by reason marker.
    await session.execute(
        CompanyLedger.__table__.delete().where(
            CompanyLedger.reason.like(f"{_REASON}%")
        )
    )
    # Financial rows are RESTRICT on user_id -> delete before the users.
    await session.execute(
        MasterLedger.__table__.delete().where(MasterLedger.user_id.in_(subq))
    )
    await session.execute(
        Purchase.__table__.delete().where(Purchase.user_id.in_(subq))
    )
    await session.execute(
        Withdrawal.__table__.delete().where(Withdrawal.user_id.in_(subq))
    )
    await session.execute(
        Booking.__table__.delete().where(Booking.user_id.in_(subq))
    )
    await session.execute(
        Practice.__table__.delete().where(Practice.master_id.in_(subq))
    )
    await session.execute(
        MasterProfile.__table__.delete().where(MasterProfile.user_id.in_(subq))
    )
    from app.core.audit import AuditLog
    await session.execute(
        AuditLog.__table__.delete().where(AuditLog.actor_id.in_(subq))
    )
    await session.execute(
        User.__table__.delete().where(
            User.telegram_id.between(_TID_MIN, _TID_MAX)
        )
    )
    await session.commit()


# ===================================================================
# Helpers
# ===================================================================


async def _make_admin(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int = 93900,
) -> str:
    auth = await login_user(client, telegram_id=telegram_id, first_name="Admin")
    await db_session.execute(
        update(User)
        .where(User.id == auth["user"]["id"])
        .values(role=UserRole.ADMIN.value)
    )
    await db_session.flush()
    return auth["session_token"]


async def _make_master(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int = 93800,
) -> str:
    auth = await login_user(client, telegram_id=telegram_id, first_name="Master")
    user_id = auth["user"]["id"]
    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER
    await db_session.flush()
    db_session.add(
        MasterProfile(
            user_id=user_id,
            data={"account": {"status": "verified"}, "profile": {"bio": "m"}},
        )
    )
    await db_session.flush()
    return user_id


async def _add_commission(
    db_session: AsyncSession, amount_cents: int, *, created_at: datetime,
) -> None:
    entry = CompanyLedger(
        amount_cents=amount_cents,
        type=CompanyLedgerType.COMMISSION.value,
        status=LedgerStatus.DONE.value,
        reason=f"{_REASON}commission",
    )
    entry.created_at = created_at
    db_session.add(entry)
    await db_session.flush()


async def _add_master_ledger(
    db_session: AsyncSession,
    user_id: str,
    amount_cents: int,
    *,
    title: str,
    created_at: datetime,
) -> None:
    entry = MasterLedger(
        user_id=user_id,
        amount_cents=amount_cents,
        is_frozen=False,
        status=LedgerStatus.DONE.value,
        reason=f"{_REASON}ledger",
        title=title,
    )
    entry.created_at = created_at
    db_session.add(entry)
    await db_session.flush()


async def _add_withdrawal(
    db_session: AsyncSession,
    user_id: str,
    *,
    amount_cents: int,
    fee_cents: int,
    status: str = WithdrawalStatus.APPROVED.value,
    approved_at: datetime | None,
) -> None:
    db_session.add(
        Withdrawal(
            user_id=user_id,
            amount_cents=amount_cents,
            fee_cents=fee_cents,
            status=status,
            approved_at=approved_at,
        )
    )
    await db_session.flush()


async def _add_purchase(
    client: AsyncClient,
    db_session: AsyncSession,
    master_id: str,
    buyer_tg: int,
    *,
    paid_cents: int,
    status: str = PurchaseStatus.COMPLETED.value,
    completed_at: datetime | None,
) -> None:
    """Create practice + booking + purchase so revenue (GMV) has real data."""
    practice = Practice(
        master_id=master_id,
        title="Rev Practice",
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=PracticeStatus.COMPLETED.value,
        scheduled_at=datetime.now(UTC) - timedelta(hours=3),
        duration_minutes=60,
        timezone="UTC",
        max_participants=20,
        current_participants=0,
        is_free=False,
        price_cents=paid_cents,
        currency="eur",
    )
    db_session.add(practice)
    await db_session.flush()

    auth = await login_user(client, telegram_id=buyer_tg, first_name=f"B{buyer_tg}")
    buyer_id = auth["user"]["id"]
    booking = Booking(
        practice_id=practice.id,
        user_id=buyer_id,
        status=BookingStatus.ATTENDED.value,
    )
    db_session.add(booking)
    await db_session.flush()

    purchase = Purchase(
        user_id=buyer_id,
        practice_id=practice.id,
        booking_id=booking.id,
        amount_cents=paid_cents,
        discount_cents=0,
        paid_cents=paid_cents,
        status=status,
        completed_at=completed_at,
    )
    db_session.add(purchase)
    await db_session.flush()


async def _get_revenue(
    client: AsyncClient, token: str, period: str = "week", offset: int = 0,
) -> dict:
    resp = await client.get(
        REVENUE_URL,
        params={"period": period, "offset": offset},
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    return resp.json()


# ===================================================================
# Totals (delta vs seed baseline)
# ===================================================================


@pytest.mark.asyncio
async def test_revenue_totals_delta(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """revenue (GMV), commission, and payout move by exactly what we add."""
    token = await _make_admin(client, db_session)
    master_id = await _make_master(client, db_session)
    await db_session.commit()

    base = await _get_revenue(client, token)

    now = datetime.now(UTC)
    await _add_purchase(
        client, db_session, master_id, 93001, paid_cents=10000, completed_at=now,
    )
    await _add_commission(db_session, 1000, created_at=now)
    await _add_commission(db_session, 500, created_at=now)
    await _add_withdrawal(
        db_session, master_id, amount_cents=3000, fee_cents=100, approved_at=now,
    )
    await db_session.commit()

    new = await _get_revenue(client, token)

    assert new["revenue_cents"] - base["revenue_cents"] == 10000
    assert new["commission_cents"] - base["commission_cents"] == 1500
    # payout is net: 3000 - 100 = 2900
    assert new["payout_cents"] - base["payout_cents"] == 2900


@pytest.mark.asyncio
async def test_revenue_excludes_pending_purchase(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A pending purchase is not counted in revenue (GMV)."""
    token = await _make_admin(client, db_session)
    master_id = await _make_master(client, db_session)
    await db_session.commit()

    base = await _get_revenue(client, token)
    await _add_purchase(
        client, db_session, master_id, 93010, paid_cents=7777,
        status=PurchaseStatus.PENDING.value, completed_at=None,
    )
    await db_session.commit()

    new = await _get_revenue(client, token)
    assert new["revenue_cents"] - base["revenue_cents"] == 0


@pytest.mark.asyncio
async def test_revenue_excludes_rejected_withdrawal(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A rejected withdrawal does not count toward payout."""
    token = await _make_admin(client, db_session)
    master_id = await _make_master(client, db_session)
    await db_session.commit()

    base = await _get_revenue(client, token)
    await _add_withdrawal(
        db_session, master_id, amount_cents=5000, fee_cents=100,
        status=WithdrawalStatus.REJECTED.value, approved_at=None,
    )
    await db_session.commit()

    new = await _get_revenue(client, token)
    assert new["payout_cents"] - base["payout_cents"] == 0


@pytest.mark.asyncio
async def test_revenue_period_excludes_other_week(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Commission booked two weeks ago is outside the current week."""
    token = await _make_admin(client, db_session)
    await _make_master(client, db_session)
    await db_session.commit()

    base = await _get_revenue(client, token, "week")
    await _add_commission(
        db_session, 9999, created_at=datetime.now(UTC) - timedelta(days=14),
    )
    await db_session.commit()

    new = await _get_revenue(client, token, "week")
    assert new["commission_cents"] - base["commission_cents"] == 0


@pytest.mark.asyncio
async def test_revenue_offset_navigates_previous_week(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """W9 regression (PROMPT №387): offset=-1 shows a commission booked exactly
    one week ago; offset=0 (current week) does not. Before the fix,
    getAdminRevenue had no offset parameter at all -- the revenue card
    silently ignored the dashboard's week-stepper while its sibling metrics
    (checkin/feedback/return) respected it.
    """
    token = await _make_admin(client, db_session)
    await _make_master(client, db_session)
    await db_session.commit()

    base_current = await _get_revenue(client, token, "week", offset=0)
    base_previous = await _get_revenue(client, token, "week", offset=-1)

    await _add_commission(
        db_session, 9999, created_at=datetime.now(UTC) - timedelta(weeks=1),
    )
    await db_session.commit()

    new_current = await _get_revenue(client, token, "week", offset=0)
    new_previous = await _get_revenue(client, token, "week", offset=-1)

    assert new_current["commission_cents"] - base_current["commission_cents"] == 0
    assert new_previous["commission_cents"] - base_previous["commission_cents"] == 9999


# ===================================================================
# per_master (isolated master)
# ===================================================================


@pytest.mark.asyncio
async def test_revenue_per_master(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """per_master carries net earnings + net payouts for an isolated master."""
    token = await _make_admin(client, db_session)
    master_id = await _make_master(client, db_session)
    now = datetime.now(UTC)

    # Earnings: +12000 sale, -2000 commission -> net 10000.
    await _add_master_ledger(
        db_session, master_id, 12000, title="Оплата за практику", created_at=now,
    )
    await _add_master_ledger(
        db_session, master_id, -2000, title="Комиссия", created_at=now,
    )
    # Payout: 3000 - 100 fee -> net 2900.
    await _add_withdrawal(
        db_session, master_id, amount_cents=3000, fee_cents=100, approved_at=now,
    )
    await db_session.commit()

    data = await _get_revenue(client, token)
    mine = [m for m in data["per_master"] if m["master_id"] == master_id]
    assert len(mine) == 1
    assert mine[0]["earned_cents"] == 10000
    assert mine[0]["payout_cents"] == 2900
    assert mine[0]["name"] == "Master"


# ===================================================================
# auth
# ===================================================================


@pytest.mark.asyncio
async def test_revenue_no_auth(client: AsyncClient) -> None:
    resp = await client.get(REVENUE_URL)
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_revenue_non_admin(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    auth = await login_user(client, telegram_id=93050, first_name="Plain")
    resp = await client.get(REVENUE_URL, headers=auth_headers(auth["session_token"]))
    assert resp.status_code == 403
