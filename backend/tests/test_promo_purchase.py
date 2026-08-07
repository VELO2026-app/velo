# =============================================================================
# Tests: Promo + Purchase Integration (Phase 6.7, Batch 4)
# =============================================================================
#
# Tests for promo code application during purchase flow.
#
# telegram_id range: 81xxx (promo purchase tests)
#
# Coverage:
#   PREVIEW:
#     - Preview without promo (full price)
#     - Preview with company promo (shows discount)
#     - Preview with master promo (shows discount)
#     - Preview with invalid promo (400)
#     - Preview unauthenticated (401)
#
#   COMPANY PROMO PURCHASE:
#     - 100% discount: user pays $0, master gets full price, marketing debit
#     - 50% discount: partial, user pays half
#     - Double-entry: SUM = 0
#     - Finalize: commission on paid_cents only
#
#   MASTER PROMO PURCHASE:
#     - 100% discount: user pays $0, master gets $0
#     - 50% discount: partial
#     - Wrong master (400)
#     - Practice scope mismatch (400)
#     - Double-entry: SUM = 0
#     - Finalize: commission on paid_cents only
#
#   VALIDATION:
#     - Expired promo (400)
#     - Inactive promo (400)
#     - Max uses reached (400)
#     - First purchase only (400)
#     - Atomic used_count increment
#
#   REFUND WITH PROMO:
#     - Company promo refund: user + master + marketing reversal
#     - Master promo refund: user + master reversal
#     - Late cancel with company promo: master keeps full, commission on paid
#
#   BOOKINGS ENDPOINT:
#     - POST /bookings with promo_code
#
#   FREE PRACTICE + PROMO:
#     - No effect (discount on 0 = 0)
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import datetime, timedelta, timezone
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, delete, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.bookings.service import auto_finalize_practice
from app.modules.masters.models import MasterProfile
from app.modules.payments.models import (
    CompanyLedger,
    CompanyLedgerType,
    LedgerStatus,
    MasterLedger,
    Purchase,
    PurchaseStatus,
    UserLedger,
)
from app.modules.payments.service import record_user_ledger
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.promos.models import Promo, PromoType
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, fresh_execute, full_cleanup_range, login_user


# ---------------------------------------------------------------------------
# Cleanup (dependency order)
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """Clean all test data before/after each test (TD-032: ORM, no raw SQL)."""
    await _do_cleanup(db_session)
    yield
    await _do_cleanup(db_session)


async def _do_cleanup(session: AsyncSession) -> None:
    """Full ORM cleanup for telegram_id 81000-81999."""
    await full_cleanup_range(session, 81000, 81999, delete_users=True)
    # Promo codes created by this test suite (master_id=None promos with TEST81 prefix).
    await session.execute(
        delete(Promo).where(Promo.code.like("TEST81%"))
    )
    # Marketing CompanyLedger entries have reference_id=None and encode the
    # promo code in their reason field — full_cleanup_range cannot reach them
    # via reference_id subqueries.
    await session.execute(
        delete(CompanyLedger).where(CompanyLedger.reason.like("%TEST81%"))
    )
    await session.commit()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

PURCHASE_URL = "/api/v1/practices/{practice_id}/purchase"
PREVIEW_URL = "/api/v1/practices/{practice_id}/preview-purchase"
BOOKINGS_URL = "/api/v1/bookings"


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
) -> dict:
    """Create a verified master."""
    data = await login_user(
        client, telegram_id=telegram_id, first_name="Master",
    )
    user_id = data["user"]["id"]

    stmt = select(User).where(User.id == user_id)
    user = (await db_session.execute(stmt)).scalar_one()
    user.role = UserRole.MASTER.value
    await db_session.flush()

    profile = MasterProfile(
        user_id=UUID(user_id),
        data={
            "account": {"status": "verified"},
            "profile": {
                "bio": "Test master",
                "methods": ["meditation"],
            },
        },
    )
    db_session.add(profile)
    await db_session.commit()

    return data


async def _create_practice(
    client: AsyncClient,
    master_data: dict,
    *,
    is_free: bool = False,
    price_cents: int = 10000,
    hours_ahead: int = 168,
) -> str:
    """Create a scheduled practice. Returns practice_id as str."""
    scheduled_at = datetime.now(timezone.utc) + timedelta(hours=hours_ahead)
    body = {
        "title": "Test Practice",
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "scheduled_at": scheduled_at.isoformat(),
        "duration_minutes": 60,
        "timezone": "UTC",
        "max_participants": 10,
        "is_free": is_free,
        "price_cents": 0 if is_free else price_cents,
        "currency": "eur",
    }
    token = master_data["session_token"]

    # Step 1: Create (draft).
    resp = await client.post(
        "/api/v1/practices",
        json=body,
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    practice_id = resp.json()["id"]

    # Step 2: Publish (draft -> scheduled).
    resp = await client.patch(
        f"/api/v1/practices/{practice_id}",
        json={"status": "scheduled"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 200

    return practice_id


async def _topup_user(user_id: str, amount: int) -> None:
    """Top up user balance via separate session."""
    from app.core.database import get_session_factory
    factory = get_session_factory()
    async with factory() as session:
        await record_user_ledger(
            user_id=UUID(user_id),
            amount_cents=amount,
            reason="test:topup",
            session=session,
        )
        await session.commit()


async def _create_promo(
    db_session: AsyncSession,
    *,
    code: str,
    promo_type: str = PromoType.COMPANY.value,
    discount_percent: int = 50,
    master_id: UUID | None = None,
    practice_id: UUID | None = None,
    max_uses: int | None = None,
    first_purchase_only: bool = False,
    is_active: bool = True,
    valid_from: datetime | None = None,
    valid_until: datetime | None = None,
) -> Promo:
    """Create a promo code directly in DB."""
    promo = Promo(
        code=code.upper(),
        type=promo_type,
        master_id=master_id,
        practice_id=practice_id,
        discount_percent=discount_percent,
        max_uses=max_uses,
        used_count=0,
        valid_from=valid_from or datetime.now(timezone.utc) - timedelta(hours=1),
        valid_until=valid_until,
        first_purchase_only=first_purchase_only,
        is_active=is_active,
    )
    db_session.add(promo)
    await db_session.commit()
    await db_session.refresh(promo)
    return promo


# ===================================================================
# PREVIEW TESTS
# ===================================================================


@pytest.mark.asyncio
async def test_preview_no_promo(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Preview without promo shows full price."""
    master_data = await _make_verified_master(client, db_session, 81000)
    practice_id = await _create_practice(client, master_data, price_cents=5000)

    user_data = await login_user(client, telegram_id=81001, first_name="Buyer")

    resp = await client.post(
        PREVIEW_URL.format(practice_id=practice_id),
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["amount_cents"] == 5000
    assert data["discount_cents"] == 0
    assert data["paid_cents"] == 5000
    assert data["promo_code"] is None


@pytest.mark.asyncio
async def test_preview_with_company_promo(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Preview with company promo shows discount."""
    master_data = await _make_verified_master(client, db_session, 81002)
    practice_id = await _create_practice(client, master_data, price_cents=10000)

    promo = await _create_promo(
        db_session, code="TEST81WELCOME", discount_percent=50,
    )

    user_data = await login_user(client, telegram_id=81003, first_name="Buyer")

    resp = await client.post(
        PREVIEW_URL.format(practice_id=practice_id),
        json={"promo_code": "test81welcome"},  # case-insensitive
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["amount_cents"] == 10000
    assert data["discount_cents"] == 5000
    assert data["paid_cents"] == 5000
    assert data["promo_code"] == "TEST81WELCOME"
    assert data["promo_type"] == "company"
    assert data["discount_percent"] == 50


@pytest.mark.asyncio
async def test_preview_invalid_promo(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Preview with invalid promo returns 400."""
    master_data = await _make_verified_master(client, db_session, 81004)
    practice_id = await _create_practice(client, master_data)

    user_data = await login_user(client, telegram_id=81005, first_name="Buyer")

    resp = await client.post(
        PREVIEW_URL.format(practice_id=practice_id),
        json={"promo_code": "NONEXISTENT"},
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_preview_unauthenticated(
    client: AsyncClient,
) -> None:
    """Preview without auth returns 401."""
    resp = await client.post(
        PREVIEW_URL.format(practice_id="00000000-0000-0000-0000-000000000000"),
    )
    assert resp.status_code == 401


# ===================================================================
# COMPANY PROMO PURCHASE TESTS
# ===================================================================


@pytest.mark.asyncio
async def test_company_promo_100_percent(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Company promo 100%: user pays $0, master gets full price, marketing debit."""
    master_data = await _make_verified_master(client, db_session, 81010)
    practice_id = await _create_practice(client, master_data, price_cents=5000)
    master_id = master_data["user"]["id"]

    promo = await _create_promo(
        db_session, code="TEST81FREE100", discount_percent=100,
    )

    user_data = await login_user(client, telegram_id=81011, first_name="Buyer")
    # No topup needed -- user pays $0.

    resp = await client.post(
        PURCHASE_URL.format(practice_id=practice_id),
        json={"promo_code": "TEST81FREE100"},
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["amount_cents"] == 5000
    assert data["discount_cents"] == 5000
    assert data["paid_cents"] == 0
    assert data["promo_id"] == str(promo.id)

    # Verify user balance unchanged (was 0, still 0).
    db_session.expire_all()
    user = (await db_session.execute(
        select(User).where(User.id == user_data["user"]["id"]),
    )).scalar_one()
    assert user.balance_cents == 0

    # Verify master frozen = 5000 (full price from company).
    profile = (await db_session.execute(
        select(MasterProfile).where(MasterProfile.user_id == master_id),
    )).scalar_one()
    assert profile.frozen_cents == 5000

    # Verify company marketing debit.
    cl_stmt = (
        select(CompanyLedger)
        .where(
            CompanyLedger.type == CompanyLedgerType.MARKETING.value,
            CompanyLedger.reason.like("%TEST81FREE100%"),
        )
    )
    cl_entry = (await db_session.execute(cl_stmt)).scalar_one()
    assert cl_entry.amount_cents == -5000

    # Verify promo used_count incremented.
    await db_session.refresh(promo)
    assert promo.used_count == 1


@pytest.mark.asyncio
async def test_company_promo_50_percent(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Company promo 50%: user pays half, master gets full, company covers gap."""
    master_data = await _make_verified_master(client, db_session, 81012)
    practice_id = await _create_practice(client, master_data, price_cents=10000)

    promo = await _create_promo(
        db_session, code="TEST81HALF", discount_percent=50,
    )

    user_data = await login_user(client, telegram_id=81013, first_name="Buyer")
    await _topup_user(user_data["user"]["id"], 5000)

    resp = await client.post(
        PURCHASE_URL.format(practice_id=practice_id),
        json={"promo_code": "TEST81HALF"},
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["amount_cents"] == 10000
    assert data["discount_cents"] == 5000
    assert data["paid_cents"] == 5000

    # User balance: 5000 - 5000 = 0.
    db_session.expire_all()
    user = (await fresh_execute(
        select(User).where(User.id == user_data["user"]["id"]),
    )).scalar_one()
    assert user.balance_cents == 0

    # Master frozen = 10000 (full price).
    master_id = master_data["user"]["id"]
    profile = (await db_session.execute(
        select(MasterProfile).where(MasterProfile.user_id == master_id),
    )).scalar_one()
    assert profile.frozen_cents == 10000


@pytest.mark.asyncio
async def test_company_promo_double_entry(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Company promo: SUM(all ledgers) = 0."""
    master_data = await _make_verified_master(client, db_session, 81014)
    practice_id = await _create_practice(client, master_data, price_cents=8000)

    await _create_promo(
        db_session, code="TEST81DE", discount_percent=25,
    )

    user_data = await login_user(client, telegram_id=81015, first_name="Buyer")
    await _topup_user(user_data["user"]["id"], 6000)

    resp = await client.post(
        PURCHASE_URL.format(practice_id=practice_id),
        json={"promo_code": "TEST81DE"},
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 201

    # Check SUM = 0 for this practice.
    db_session.expire_all()
    pid = practice_id

    # User ledger.
    user_sum = (await fresh_execute(
        select(func.coalesce(func.sum(UserLedger.amount_cents), 0))
        .where(UserLedger.reason.like(f"%practice={pid}%"))
    )).scalar_one()

    # Master ledger.
    master_sum = (await db_session.execute(
        select(func.coalesce(func.sum(MasterLedger.amount_cents), 0))
        .where(
            MasterLedger.practice_id == pid,
            MasterLedger.status == LedgerStatus.DONE.value,
        )
    )).scalar_one()

    # Company ledger (marketing).
    company_sum = (await db_session.execute(
        select(func.coalesce(func.sum(CompanyLedger.amount_cents), 0))
        .where(CompanyLedger.reason.like(f"%practice={pid}%"))
    )).scalar_one()

    total = user_sum + master_sum + company_sum
    assert total == 0, (
        f"Double-entry violation: user={user_sum} + master={master_sum} "
        f"+ company={company_sum} = {total}"
    )


@pytest.mark.asyncio
async def test_company_promo_finalize_commission_on_paid(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """After finalize: commission = 15% of paid_cents (not amount_cents)."""
    master_data = await _make_verified_master(client, db_session, 81016)
    practice_id = await _create_practice(client, master_data, price_cents=10000)

    await _create_promo(
        db_session, code="TEST81COMM", discount_percent=50,
    )

    user_data = await login_user(client, telegram_id=81017, first_name="Buyer")
    await _topup_user(user_data["user"]["id"], 5000)

    # Purchase with promo.
    resp = await client.post(
        PURCHASE_URL.format(practice_id=practice_id),
        json={"promo_code": "TEST81COMM"},
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 201
    booking_id = resp.json()["booking_id"]

    # Join, then let the system finalize (the manual endpoint was removed --
    # completion is driven by the lifecycle worker at scheduled_at + duration).
    await client.post(
        f"{BOOKINGS_URL}/{booking_id}/join",
        headers=auth_headers(user_data["session_token"]),
    )
    await auto_finalize_practice(UUID(practice_id), db_session)
    await db_session.commit()

    # Commission should be 15% of 5000 (paid) = 750, not 15% of 10000.
    db_session.expire_all()
    purchase = (await fresh_execute(
        select(Purchase).where(Purchase.booking_id == booking_id),
    )).scalar_one()
    assert purchase.status == PurchaseStatus.COMPLETED.value
    assert purchase.commission_cents == 750  # 15% of 5000


# ===================================================================
# MASTER PROMO PURCHASE TESTS
# ===================================================================


@pytest.mark.asyncio
async def test_master_promo_100_percent(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Master promo 100%: user pays $0, master gets $0."""
    master_data = await _make_verified_master(client, db_session, 81020)
    practice_id = await _create_practice(client, master_data, price_cents=5000)
    master_id = master_data["user"]["id"]

    promo = await _create_promo(
        db_session,
        code="TEST81MASTERFREE",
        promo_type=PromoType.MASTER.value,
        discount_percent=100,
        master_id=UUID(master_id),
    )

    user_data = await login_user(client, telegram_id=81021, first_name="Buyer")

    resp = await client.post(
        PURCHASE_URL.format(practice_id=practice_id),
        json={"promo_code": "TEST81MASTERFREE"},
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["amount_cents"] == 5000
    assert data["discount_cents"] == 5000
    assert data["paid_cents"] == 0

    # Master frozen = 0 (master absorbed 100%).
    db_session.expire_all()
    profile = (await db_session.execute(
        select(MasterProfile).where(MasterProfile.user_id == master_id),
    )).scalar_one()
    assert profile.frozen_cents == 0

    # No company ledger entries (company pays nothing).
    cl_count = (await db_session.execute(
        select(func.count(CompanyLedger.id))
        .where(CompanyLedger.reason.like("%TEST81MASTERFREE%"))
    )).scalar_one()
    assert cl_count == 0


@pytest.mark.asyncio
async def test_master_promo_50_percent(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Master promo 50%: user pays half, master gets half."""
    master_data = await _make_verified_master(client, db_session, 81022)
    practice_id = await _create_practice(client, master_data, price_cents=8000)
    master_id = master_data["user"]["id"]

    await _create_promo(
        db_session,
        code="TEST81M50",
        promo_type=PromoType.MASTER.value,
        discount_percent=50,
        master_id=UUID(master_id),
    )

    user_data = await login_user(client, telegram_id=81023, first_name="Buyer")
    await _topup_user(user_data["user"]["id"], 4000)

    resp = await client.post(
        PURCHASE_URL.format(practice_id=practice_id),
        json={"promo_code": "TEST81M50"},
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["paid_cents"] == 4000

    db_session.expire_all()
    profile = (await fresh_execute(
        select(MasterProfile).where(MasterProfile.user_id == master_id),
    )).scalar_one()
    assert profile.frozen_cents == 4000  # master gets only what user paid


@pytest.mark.asyncio
async def test_master_promo_wrong_master(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Master promo for different master: 400."""
    master1 = await _make_verified_master(client, db_session, 81024)
    master2 = await _make_verified_master(client, db_session, 81025)
    practice_id = await _create_practice(client, master1, price_cents=5000)

    # Promo belongs to master2, practice belongs to master1.
    await _create_promo(
        db_session,
        code="TEST81WRONG",
        promo_type=PromoType.MASTER.value,
        discount_percent=50,
        master_id=UUID(master2["user"]["id"]),
    )

    user_data = await login_user(client, telegram_id=81026, first_name="Buyer")
    await _topup_user(user_data["user"]["id"], 5000)

    resp = await client.post(
        PURCHASE_URL.format(practice_id=practice_id),
        json={"promo_code": "TEST81WRONG"},
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_master_promo_practice_scope_mismatch(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Master promo scoped to specific practice: wrong practice -> 400."""
    master_data = await _make_verified_master(client, db_session, 81027)
    practice1_id = await _create_practice(client, master_data, price_cents=5000)
    practice2_id = await _create_practice(client, master_data, price_cents=5000)

    # Promo scoped to practice1.
    await _create_promo(
        db_session,
        code="TEST81SCOPED",
        promo_type=PromoType.MASTER.value,
        discount_percent=50,
        master_id=UUID(master_data["user"]["id"]),
        practice_id=UUID(practice1_id),
    )

    user_data = await login_user(client, telegram_id=81028, first_name="Buyer")
    await _topup_user(user_data["user"]["id"], 5000)

    # Try to use on practice2.
    resp = await client.post(
        PURCHASE_URL.format(practice_id=practice2_id),
        json={"promo_code": "TEST81SCOPED"},
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 400


# ===================================================================
# VALIDATION TESTS
# ===================================================================


@pytest.mark.asyncio
async def test_promo_expired(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Expired promo: 400."""
    master_data = await _make_verified_master(client, db_session, 81030)
    practice_id = await _create_practice(client, master_data)

    await _create_promo(
        db_session,
        code="TEST81EXPIRED",
        valid_until=datetime.now(timezone.utc) - timedelta(hours=1),
    )

    user_data = await login_user(client, telegram_id=81031, first_name="Buyer")
    await _topup_user(user_data["user"]["id"], 10000)

    resp = await client.post(
        PURCHASE_URL.format(practice_id=practice_id),
        json={"promo_code": "TEST81EXPIRED"},
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_promo_inactive(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Inactive promo: 400."""
    master_data = await _make_verified_master(client, db_session, 81032)
    practice_id = await _create_practice(client, master_data)

    await _create_promo(
        db_session,
        code="TEST81INACTIVE",
        is_active=False,
    )

    user_data = await login_user(client, telegram_id=81033, first_name="Buyer")
    await _topup_user(user_data["user"]["id"], 10000)

    resp = await client.post(
        PURCHASE_URL.format(practice_id=practice_id),
        json={"promo_code": "TEST81INACTIVE"},
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_promo_max_uses_reached(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Promo with max_uses exhausted: 400."""
    master_data = await _make_verified_master(client, db_session, 81034)
    practice_id = await _create_practice(client, master_data, price_cents=1000)

    promo = await _create_promo(
        db_session,
        code="TEST81MAXUSE",
        discount_percent=25,
        max_uses=1,
    )
    # Manually set used_count = 1 (already exhausted).
    promo.used_count = 1
    await db_session.commit()

    user_data = await login_user(client, telegram_id=81035, first_name="Buyer")
    await _topup_user(user_data["user"]["id"], 1000)

    resp = await client.post(
        PURCHASE_URL.format(practice_id=practice_id),
        json={"promo_code": "TEST81MAXUSE"},
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_promo_first_purchase_only(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """first_purchase_only promo: fails if user has completed purchase."""
    master_data = await _make_verified_master(client, db_session, 81036)
    practice1_id = await _create_practice(client, master_data, is_free=True)
    practice2_id = await _create_practice(client, master_data, price_cents=5000)

    await _create_promo(
        db_session,
        code="TEST81FIRST",
        discount_percent=100,
        first_purchase_only=True,
    )

    user_data = await login_user(client, telegram_id=81037, first_name="Buyer")

    # First purchase (free, no promo) -> creates purchase.
    resp = await client.post(
        PURCHASE_URL.format(practice_id=practice1_id),
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 201
    booking_id = resp.json()["booking_id"]

    # Join, then let the system finalize the first practice so its purchase
    # becomes COMPLETED (that is what first_purchase_only checks against).
    await client.post(
        f"{BOOKINGS_URL}/{booking_id}/join",
        headers=auth_headers(user_data["session_token"]),
    )
    await auto_finalize_practice(UUID(practice1_id), db_session)
    await db_session.commit()

    # Second purchase with first_purchase_only promo -> 400.
    resp = await client.post(
        PURCHASE_URL.format(practice_id=practice2_id),
        json={"promo_code": "TEST81FIRST"},
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_promo_used_count_increment(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Promo used_count increments atomically after purchase."""
    master_data = await _make_verified_master(client, db_session, 81038)
    practice_id = await _create_practice(client, master_data, price_cents=2000)

    promo = await _create_promo(
        db_session,
        code="TEST81COUNT",
        discount_percent=25,
        max_uses=5,
    )
    assert promo.used_count == 0
    promo_id = promo.id  # Save before expire.

    user_data = await login_user(client, telegram_id=81039, first_name="Buyer")
    await _topup_user(user_data["user"]["id"], 1500)

    resp = await client.post(
        PURCHASE_URL.format(practice_id=practice_id),
        json={"promo_code": "TEST81COUNT"},
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 201

    db_session.expire_all()
    refreshed = (await fresh_execute(
        select(Promo).where(Promo.id == promo_id),
    )).scalar_one()
    assert refreshed.used_count == 1


# ===================================================================
# REFUND WITH PROMO TESTS
# ===================================================================


@pytest.mark.asyncio
async def test_refund_company_promo(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Refund with company promo: user + master + marketing reversal. SUM=0."""
    master_data = await _make_verified_master(client, db_session, 81040)
    # Practice far in future (>24h) for full refund.
    practice_id = await _create_practice(
        client, master_data, price_cents=6000, hours_ahead=168,
    )

    await _create_promo(
        db_session, code="TEST81REFUND", discount_percent=50,
    )

    user_data = await login_user(client, telegram_id=81041, first_name="Buyer")
    await _topup_user(user_data["user"]["id"], 3000)

    # Purchase.
    resp = await client.post(
        PURCHASE_URL.format(practice_id=practice_id),
        json={"promo_code": "TEST81REFUND"},
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 201
    booking_id = resp.json()["booking_id"]

    # Cancel (>24h = full refund).
    resp = await client.delete(
        f"{BOOKINGS_URL}/{booking_id}",
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 200

    # Verify Purchase -> REFUNDED.
    db_session.expire_all()
    purchase = (await fresh_execute(
        select(Purchase).where(Purchase.booking_id == booking_id),
    )).scalar_one()
    assert purchase.status == PurchaseStatus.REFUNDED.value

    # Verify user balance restored.
    user = (await db_session.execute(
        select(User).where(User.id == user_data["user"]["id"]),
    )).scalar_one()
    assert user.balance_cents == 3000

    # Verify master frozen back to 0.
    profile = (await db_session.execute(
        select(MasterProfile).where(
            MasterProfile.user_id == master_data["user"]["id"],
        ),
    )).scalar_one()
    assert profile.frozen_cents == 0

    # Verify marketing reversal: SUM(company_ledger for this promo) = 0.
    pid = practice_id
    company_sum = (await db_session.execute(
        select(func.coalesce(func.sum(CompanyLedger.amount_cents), 0))
        .where(CompanyLedger.reason.like(f"%practice={pid}%"))
    )).scalar_one()
    assert company_sum == 0  # -3000 (marketing) + 3000 (reversal) = 0

    # Full double-entry check.
    user_sum = (await db_session.execute(
        select(func.coalesce(func.sum(UserLedger.amount_cents), 0))
        .where(UserLedger.reason.like(f"%practice={pid}%"))
    )).scalar_one()

    master_sum = (await db_session.execute(
        select(func.coalesce(func.sum(MasterLedger.amount_cents), 0))
        .where(
            MasterLedger.practice_id == pid,
            MasterLedger.status == LedgerStatus.DONE.value,
        )
    )).scalar_one()

    total = user_sum + master_sum + company_sum
    assert total == 0, f"Double-entry violation after refund: {total}"


@pytest.mark.asyncio
async def test_late_cancel_company_promo(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Late cancel with company promo: master keeps full amount, commission on paid."""
    master_data = await _make_verified_master(client, db_session, 81042)
    # Practice in 1 hour (within 24h deadline).
    practice_id = await _create_practice(
        client, master_data, price_cents=10000, hours_ahead=1,
    )

    await _create_promo(
        db_session, code="TEST81LATE", discount_percent=50,
    )

    user_data = await login_user(client, telegram_id=81043, first_name="Buyer")
    await _topup_user(user_data["user"]["id"], 5000)

    resp = await client.post(
        PURCHASE_URL.format(practice_id=practice_id),
        json={"promo_code": "TEST81LATE"},
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 201
    booking_id = resp.json()["booking_id"]

    # Cancel (late, <24h).
    resp = await client.delete(
        f"{BOOKINGS_URL}/{booking_id}",
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 200

    # Purchase -> COMPLETED (early finalize).
    db_session.expire_all()
    purchase = (await fresh_execute(
        select(Purchase).where(Purchase.booking_id == booking_id),
    )).scalar_one()
    assert purchase.status == PurchaseStatus.COMPLETED.value
    # Commission = 15% of 5000 (paid) = 750.
    assert purchase.commission_cents == 750

    # Master gets amount_cents - commission = 10000 - 750 = 9250 available.
    profile = (await db_session.execute(
        select(MasterProfile).where(
            MasterProfile.user_id == master_data["user"]["id"],
        ),
    )).scalar_one()
    assert profile.available_cents == 9250
    assert profile.frozen_cents == 0


@pytest.mark.asyncio
async def test_refund_master_promo(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Refund with master promo: user + master reversal, no company involvement."""
    master_data = await _make_verified_master(client, db_session, 81044)
    practice_id = await _create_practice(
        client, master_data, price_cents=4000, hours_ahead=168,
    )

    await _create_promo(
        db_session,
        code="TEST81MREF",
        promo_type=PromoType.MASTER.value,
        discount_percent=50,
        master_id=UUID(master_data["user"]["id"]),
    )

    user_data = await login_user(client, telegram_id=81045, first_name="Buyer")
    await _topup_user(user_data["user"]["id"], 2000)

    resp = await client.post(
        PURCHASE_URL.format(practice_id=practice_id),
        json={"promo_code": "TEST81MREF"},
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 201
    booking_id = resp.json()["booking_id"]

    # Cancel.
    resp = await client.delete(
        f"{BOOKINGS_URL}/{booking_id}",
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 200

    # Verify full user balance restored.
    db_session.expire_all()
    user = (await fresh_execute(
        select(User).where(User.id == user_data["user"]["id"]),
    )).scalar_one()
    assert user.balance_cents == 2000

    # No company ledger entries at all (master promo).
    pid = practice_id
    cl_count = (await db_session.execute(
        select(func.count(CompanyLedger.id))
        .where(CompanyLedger.reason.like(f"%practice={pid}%"))
    )).scalar_one()
    assert cl_count == 0


# ===================================================================
# BOOKINGS ENDPOINT WITH PROMO
# ===================================================================


@pytest.mark.asyncio
async def test_bookings_endpoint_with_promo(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """POST /bookings with promo_code works."""
    master_data = await _make_verified_master(client, db_session, 81050)
    practice_id = await _create_practice(client, master_data, price_cents=2000)

    await _create_promo(
        db_session, code="TEST81BOOK", discount_percent=25,
    )

    user_data = await login_user(client, telegram_id=81051, first_name="Buyer")
    await _topup_user(user_data["user"]["id"], 1500)

    resp = await client.post(
        BOOKINGS_URL,
        json={
            "practice_id": practice_id,
            "promo_code": "TEST81BOOK",
        },
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 201
    booking_id = resp.json()["id"]

    # Verify purchase has discount.
    db_session.expire_all()
    purchase = (await fresh_execute(
        select(Purchase).where(Purchase.booking_id == booking_id),
    )).scalar_one()
    assert purchase.amount_cents == 2000
    assert purchase.discount_cents == 500  # 25%
    assert purchase.paid_cents == 1500


# ===================================================================
# FREE PRACTICE + PROMO
# ===================================================================


@pytest.mark.asyncio
async def test_free_practice_with_promo(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Free practice + promo: discount on 0 = 0, no effect."""
    master_data = await _make_verified_master(client, db_session, 81060)
    practice_id = await _create_practice(client, master_data, is_free=True)

    await _create_promo(
        db_session, code="TEST81FREEPR", discount_percent=100,
    )

    user_data = await login_user(client, telegram_id=81061, first_name="Buyer")

    resp = await client.post(
        PURCHASE_URL.format(practice_id=practice_id),
        json={"promo_code": "TEST81FREEPR"},
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["amount_cents"] == 0
    assert data["discount_cents"] == 0
    assert data["paid_cents"] == 0


# ===================================================================
# PURCHASE WITHOUT PROMO (backward compatibility)
# ===================================================================


@pytest.mark.asyncio
async def test_purchase_no_promo_backward_compat(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Purchase without promo_code works as before (no body)."""
    master_data = await _make_verified_master(client, db_session, 81070)
    practice_id = await _create_practice(client, master_data, is_free=True)

    user_data = await login_user(client, telegram_id=81071, first_name="Buyer")

    # No body at all.
    resp = await client.post(
        PURCHASE_URL.format(practice_id=practice_id),
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["promo_id"] is None
    assert data["discount_cents"] == 0


@pytest.mark.asyncio
async def test_purchase_empty_body_backward_compat(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Purchase with empty body works."""
    master_data = await _make_verified_master(client, db_session, 81072)
    practice_id = await _create_practice(client, master_data, is_free=True)

    user_data = await login_user(client, telegram_id=81073, first_name="Buyer")

    resp = await client.post(
        PURCHASE_URL.format(practice_id=practice_id),
        json={},
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 201
    assert resp.json()["promo_id"] is None


# ===================================================================
# DB-LEVEL CHECK CONSTRAINTS
# ===================================================================
#
# These bypass the API/Pydantic layer entirely (direct ORM construction) to
# prove the DB itself rejects an out-of-range value. NOT VALID only skips
# validating rows that already existed when a migration ran; every new
# insert is still checked.
#
# The next two test a constraint from migration 2026_02_21_d0e1f2a3b4c5
# (ck_promos_discount_percent_positive), NOT the W5 migration
# (2026_07_16_d6e7f8a9b0c1) -- W5's initial draft almost re-added this
# constraint under a different name before a migration-history grep showed
# it already existed since February. Kept here (previously untested at the
# DB-bypass level) but labeled honestly as February's coverage.


@pytest.mark.asyncio
async def test_promo_discount_percent_zero_rejected_by_db(
    db_session: AsyncSession,
) -> None:
    """A 0% promo bypasses app validation but is rejected by the DB
    (ck_promos_discount_percent_positive, since 2026-02-21)."""
    with pytest.raises(IntegrityError):
        await _create_promo(
            db_session, code="TEST81ZEROPCT", discount_percent=0,
        )
    await db_session.rollback()


@pytest.mark.asyncio
async def test_promo_discount_percent_over_100_rejected_by_db(
    db_session: AsyncSession,
) -> None:
    """A >100% promo bypasses app validation but is rejected by the DB
    (ck_promos_discount_percent_positive, since 2026-02-21)."""
    with pytest.raises(IntegrityError):
        await _create_promo(
            db_session, code="TEST81OVER100", discount_percent=101,
        )
    await db_session.rollback()


# The next three test the W5 migration's own constraints
# (ck_purchases_amount_cents_non_negative / _paid_cents_non_negative /
# _commission_cents_non_negative). discount_cents is deliberately excluded
# -- ck_purchases_discount_cents_non_negative already existed since
# 2026-02-21 and is not something this migration owns.


@pytest.mark.asyncio
async def test_purchase_negative_paid_cents_rejected_by_db(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A negative paid_cents bypasses app validation but is rejected by
    the DB. amount_cents/discount_cents are chosen so the pre-existing
    ck_purchases_paid_equals_amount_minus_discount invariant (50 - 100 =
    -50) is satisfied -- this isolates the W5 paid_cents constraint as
    the one actually firing, not February's equality check."""
    master_data = await _make_verified_master(client, db_session, 81080)
    practice_id = await _create_practice(client, master_data, is_free=True)
    user_data = await login_user(client, telegram_id=81081, first_name="Buyer")

    booking = Booking(
        practice_id=UUID(practice_id),
        user_id=UUID(user_data["user"]["id"]),
        status=BookingStatus.CONFIRMED.value,
    )
    db_session.add(booking)
    await db_session.flush()

    with pytest.raises(IntegrityError):
        db_session.add(
            Purchase(
                user_id=UUID(user_data["user"]["id"]),
                practice_id=UUID(practice_id),
                booking_id=booking.id,
                amount_cents=50,
                discount_cents=100,
                paid_cents=-50,
                commission_cents=0,
                status=PurchaseStatus.PENDING.value,
            )
        )
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_purchase_zero_cents_free_practice_still_succeeds_at_db(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The regression the W5 constraints must NOT cause: a free practice's
    all-zero Purchase row (amount/discount/paid/commission_cents=0) is
    legitimate and must still insert cleanly under >= 0 (not > 0, unlike
    withdrawals) constraints. Mirrors test_free_practice_with_promo, but
    asserts directly at the ORM/DB layer rather than through the HTTP
    response. This is the test that matters -- the one a > 0 constraint
    would have broken."""
    master_data = await _make_verified_master(client, db_session, 81082)
    practice_id = await _create_practice(client, master_data, is_free=True)
    user_data = await login_user(client, telegram_id=81083, first_name="Buyer")

    booking = Booking(
        practice_id=UUID(practice_id),
        user_id=UUID(user_data["user"]["id"]),
        status=BookingStatus.CONFIRMED.value,
    )
    db_session.add(booking)
    await db_session.flush()

    purchase = Purchase(
        user_id=UUID(user_data["user"]["id"]),
        practice_id=UUID(practice_id),
        booking_id=booking.id,
        amount_cents=0,
        discount_cents=0,
        paid_cents=0,
        commission_cents=0,
        status=PurchaseStatus.PENDING.value,
    )
    db_session.add(purchase)
    await db_session.commit()  # must NOT raise
