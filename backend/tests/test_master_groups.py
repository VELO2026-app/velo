# =============================================================================
# VELO Backend -- Tests: Master Groups (P1, ПРОМТ №590; P3 addenda ПРОМТ №592)
# =============================================================================
#
# telegram_id range: 99700-99799
#
# ⚠ BACKEND-ONLY, UNPROVEN LOCALLY -- no Postgres reachable in this
# environment (see test_zoom_lifecycle.py's module docstring for the exact
# local blocker). Deferred to the deploy gate. Written to be read and to run
# in CI; never executed via pytest this session.
#
# Coverage:
#   Group CRUD: create (+ dup-name 409, empty-name 422), rename (+ dup 409,
#     system-slug 400), delete (+ system-slug 400, memberships cascade)
#   GET /masters/me/groups: «Ученики» first, custom by created_at,
#     «Удалённые» LAST and omitted when empty; members_count correctness
#   Membership: add (+ idempotent, system-slug 400, unknown-student 404),
#     remove (+ idempotent no-op, system-slug 400)
#   Tag: upsert / clear (row deleted unless still blocked)
#   Block: blocked_at set, removed from every custom group, FUTURE
#     CONFIRMED bookings on this master's practices cancelled + refunded
#     (asserted via the reused refund_booking() path's own effect --
#     Purchase.status -> REFUNDED), excluded from derived «Ученики»
#   Unblock: back in «Ученики», custom membership NOT restored, tag kept
#   Derived «Ученики»: non-cancelled (pending/confirmed/attended/no_show)
#     minus blocked -- widened from the ATTENDED-only students_service query
#   P3 addenda: GET /masters/me/tags (distinct alphabetical, deduped, empty
#     when unused); GET .../students/{id}/groups (this master's custom
#     groups only -- never another master's, never the two virtuals)
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.bookings.models import Booking, BookingStatus
from app.modules.masters.groups_models import (
    MasterGroupMembership,
    MasterStudent,
)
from app.modules.masters.models import MasterProfile
from app.modules.payments.models import Purchase, PurchaseStatus
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

GROUPS_URL = "/api/v1/masters/me/groups"
GROUP_URL = "/api/v1/masters/me/groups/{group_id}"
GROUP_MEMBERS_URL = "/api/v1/masters/me/groups/{group_id}/members"
GROUP_MEMBER_URL = "/api/v1/masters/me/groups/{group_id}/members/{student_id}"
TAG_URL = "/api/v1/masters/me/students/{student_id}/tag"
BLOCK_URL = "/api/v1/masters/me/students/{student_id}/block"
MY_TAGS_URL = "/api/v1/masters/me/tags"
STUDENT_GROUPS_URL = "/api/v1/masters/me/students/{student_id}/groups"
GROUP_INVITE_URL = "/api/v1/masters/me/groups/{group_id}/invite"
JOIN_GROUP_URL = "/api/v1/masters/groups/join"

_TID_MIN = 99700
_TID_MAX = 99799


# ===================================================================
# Cleanup
# ===================================================================


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    # TD-032: full_cleanup_range is the single source of FK-safe delete
    # order (ledgers, the 5 group tables, practices/bookings/purchases,
    # users) -- a hand-rolled DELETE list here previously omitted
    # user_ledger/master_ledger and orphaned refund rows into a
    # ForeignKeyViolationError once the master-groups fixtures started
    # committing (№600).
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ===================================================================
# Helpers
# ===================================================================


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
) -> dict:
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
    # The role + profile are read back by get_current_master() through the
    # request's OWN session (get_db_reader() -> a separate connection from
    # this fixture's db_session) -- a flush alone is invisible across
    # sessions under READ COMMITTED. Must commit for the API call to see it.
    await db_session.commit()
    return auth


async def _login(
    client: AsyncClient, telegram_id: int, first_name: str | None = None
) -> str:
    auth = await login_user(
        client, telegram_id=telegram_id, first_name=first_name or f"U{telegram_id}"
    )
    return auth["user"]["id"]


async def _practice(
    db_session: AsyncSession,
    master_id: str,
    *,
    scheduled_hours_from_now: float,
    status: str = PracticeStatus.SCHEDULED.value,
    price_cents: int = 0,
    is_free: bool = True,
) -> Practice:
    practice = Practice(
        master_id=master_id,
        title="Groups Test Practice",
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=status,
        scheduled_at=datetime.now(UTC) + timedelta(hours=scheduled_hours_from_now),
        duration_minutes=60,
        timezone="UTC",
        max_participants=20,
        current_participants=0,
        is_free=is_free,
        price_cents=price_cents,
        currency="eur",
    )
    db_session.add(practice)
    await db_session.flush()
    return practice


async def _booking(
    db_session: AsyncSession,
    practice: Practice,
    user_id: str,
    *,
    status: str = BookingStatus.CONFIRMED.value,
) -> Booking:
    booking = Booking(practice_id=practice.id, user_id=user_id, status=status)
    db_session.add(booking)
    await db_session.flush()
    return booking


async def _purchase(
    db_session: AsyncSession,
    practice: Practice,
    booking: Booking,
    user_id: str,
    *,
    paid_cents: int = 0,
) -> Purchase:
    purchase = Purchase(
        user_id=user_id,
        practice_id=practice.id,
        booking_id=booking.id,
        amount_cents=paid_cents,
        paid_cents=paid_cents,
        status=PurchaseStatus.PENDING.value,
    )
    db_session.add(purchase)
    await db_session.flush()
    return purchase


# ===================================================================
# Group CRUD
# ===================================================================


@pytest.mark.asyncio
async def test_create_group(client: AsyncClient, db_session: AsyncSession) -> None:
    master = await _make_verified_master(client, db_session, 99701)

    resp = await client.post(
        GROUPS_URL,
        json={"name": "VIP"},
        headers=auth_headers(master["session_token"]),
    )

    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "VIP"
    assert body["members_count"] == 0


@pytest.mark.asyncio
async def test_create_group_duplicate_name_409(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99702)
    headers = auth_headers(master["session_token"])

    first = await client.post(GROUPS_URL, json={"name": "Утро"}, headers=headers)
    assert first.status_code == 201

    dup = await client.post(GROUPS_URL, json={"name": "Утро"}, headers=headers)
    assert dup.status_code == 409


@pytest.mark.asyncio
async def test_create_group_empty_name_422(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99703)

    resp = await client.post(
        GROUPS_URL,
        json={"name": ""},
        headers=auth_headers(master["session_token"]),
    )

    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_two_masters_can_use_the_same_group_name(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """UNIQUE is scoped to (master_id, name) -- a name collision only
    matters within one master's own groups."""
    master_a = await _make_verified_master(client, db_session, 99704)
    master_b = await _make_verified_master(client, db_session, 99705)

    resp_a = await client.post(
        GROUPS_URL,
        json={"name": "Продвинутые"},
        headers=auth_headers(master_a["session_token"]),
    )
    resp_b = await client.post(
        GROUPS_URL,
        json={"name": "Продвинутые"},
        headers=auth_headers(master_b["session_token"]),
    )

    assert resp_a.status_code == 201
    assert resp_b.status_code == 201


@pytest.mark.asyncio
async def test_rename_group(client: AsyncClient, db_session: AsyncSession) -> None:
    master = await _make_verified_master(client, db_session, 99706)
    headers = auth_headers(master["session_token"])
    created = await client.post(GROUPS_URL, json={"name": "Старое"}, headers=headers)
    group_id = created.json()["id"]

    resp = await client.patch(
        GROUP_URL.format(group_id=group_id),
        json={"name": "Новое"},
        headers=headers,
    )

    assert resp.status_code == 200
    assert resp.json()["name"] == "Новое"


@pytest.mark.asyncio
async def test_rename_group_to_existing_name_409(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99707)
    headers = auth_headers(master["session_token"])
    await client.post(GROUPS_URL, json={"name": "Группа A"}, headers=headers)
    created_b = await client.post(
        GROUPS_URL, json={"name": "Группа B"}, headers=headers
    )
    group_b_id = created_b.json()["id"]

    resp = await client.patch(
        GROUP_URL.format(group_id=group_b_id),
        json={"name": "Группа A"},
        headers=headers,
    )

    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_rename_system_group_400(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99708)
    headers = auth_headers(master["session_token"])

    resp = await client.patch(
        GROUP_URL.format(group_id="students"),
        json={"name": "Хочу переименовать"},
        headers=headers,
    )

    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_delete_system_group_400(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99709)
    headers = auth_headers(master["session_token"])

    resp = await client.delete(GROUP_URL.format(group_id="deleted"), headers=headers)

    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_delete_group_cascades_memberships(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99710)
    headers = auth_headers(master["session_token"])
    created = await client.post(GROUPS_URL, json={"name": "Временная"}, headers=headers)
    group_id = created.json()["id"]

    student_id = await _login(client, 99730, "Student")
    await client.post(
        GROUP_MEMBERS_URL.format(group_id=group_id),
        json={"student_user_id": student_id},
        headers=headers,
    )
    membership_before = (
        (
            await db_session.execute(
                select(MasterGroupMembership).where(
                    MasterGroupMembership.group_id == UUID(group_id),
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(membership_before) == 1

    resp = await client.delete(GROUP_URL.format(group_id=group_id), headers=headers)
    assert resp.status_code == 204

    remaining = (
        (
            await db_session.execute(
                select(MasterGroupMembership).where(
                    MasterGroupMembership.group_id == UUID(group_id),
                )
            )
        )
        .scalars()
        .all()
    )
    assert remaining == []


# ===================================================================
# GET /masters/me/groups -- list ordering + members_count
# ===================================================================


@pytest.mark.asyncio
async def test_groups_list_order_and_deleted_omitted_when_empty(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99711)
    headers = auth_headers(master["session_token"])
    await client.post(GROUPS_URL, json={"name": "Custom A"}, headers=headers)
    await client.post(GROUPS_URL, json={"name": "Custom B"}, headers=headers)

    resp = await client.get(GROUPS_URL, headers=headers)

    assert resp.status_code == 200
    items = resp.json()["items"]
    kinds = [i["kind"] for i in items]
    # «Ученики» first, two customs, NO «Удалённые» (nobody blocked yet).
    assert kinds == ["students", "custom", "custom"]
    assert items[0]["id"] == "students"
    assert items[0]["name"] == "Ученики"
    assert [i["name"] for i in items[1:]] == ["Custom A", "Custom B"]


@pytest.mark.asyncio
async def test_groups_list_shows_deleted_last_when_non_empty(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99712)
    headers = auth_headers(master["session_token"])
    await client.post(GROUPS_URL, json={"name": "Custom"}, headers=headers)

    student_id = await _login(client, 99731, "ToBlock")
    resp = await client.post(BLOCK_URL.format(student_id=student_id), headers=headers)
    assert resp.status_code == 200

    listing = await client.get(GROUPS_URL, headers=headers)
    items = listing.json()["items"]

    assert [i["kind"] for i in items] == ["students", "custom", "deleted"]
    assert items[-1]["id"] == "deleted"
    assert items[-1]["name"] == "Удалённые"
    assert items[-1]["members_count"] == 1


@pytest.mark.asyncio
async def test_group_members_count_reflects_real_membership(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99713)
    headers = auth_headers(master["session_token"])
    created = await client.post(GROUPS_URL, json={"name": "Counted"}, headers=headers)
    group_id = created.json()["id"]

    s1 = await _login(client, 99732, "S1")
    s2 = await _login(client, 99733, "S2")
    await client.post(
        GROUP_MEMBERS_URL.format(group_id=group_id),
        json={"student_user_id": s1},
        headers=headers,
    )
    await client.post(
        GROUP_MEMBERS_URL.format(group_id=group_id),
        json={"student_user_id": s2},
        headers=headers,
    )

    listing = await client.get(GROUPS_URL, headers=headers)
    custom = next(i for i in listing.json()["items"] if i["kind"] == "custom")
    assert custom["members_count"] == 2


# ===================================================================
# Membership
# ===================================================================


@pytest.mark.asyncio
async def test_add_member_idempotent(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    master = await _make_verified_master(client, db_session, 99714)
    headers = auth_headers(master["session_token"])
    created = await client.post(GROUPS_URL, json={"name": "Idem"}, headers=headers)
    group_id = created.json()["id"]
    student_id = await _login(client, 99734, "Student")

    first = await client.post(
        GROUP_MEMBERS_URL.format(group_id=group_id),
        json={"student_user_id": student_id},
        headers=headers,
    )
    second = await client.post(
        GROUP_MEMBERS_URL.format(group_id=group_id),
        json={"student_user_id": student_id},
        headers=headers,
    )

    assert first.status_code == 204
    assert second.status_code == 204  # no-op, not an error

    members = await client.get(
        GROUP_MEMBERS_URL.format(group_id=group_id), headers=headers
    )
    assert members.json()["total"] == 1


@pytest.mark.asyncio
async def test_add_member_system_slug_400(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99715)
    headers = auth_headers(master["session_token"])
    student_id = await _login(client, 99735, "Student")

    resp = await client.post(
        GROUP_MEMBERS_URL.format(group_id="students"),
        json={"student_user_id": student_id},
        headers=headers,
    )

    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_add_member_unknown_student_404(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99716)
    headers = auth_headers(master["session_token"])
    created = await client.post(GROUPS_URL, json={"name": "Real"}, headers=headers)
    group_id = created.json()["id"]

    resp = await client.post(
        GROUP_MEMBERS_URL.format(group_id=group_id),
        json={"student_user_id": str(uuid4())},
        headers=headers,
    )

    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_remove_member(client: AsyncClient, db_session: AsyncSession) -> None:
    master = await _make_verified_master(client, db_session, 99717)
    headers = auth_headers(master["session_token"])
    created = await client.post(GROUPS_URL, json={"name": "Removable"}, headers=headers)
    group_id = created.json()["id"]
    student_id = await _login(client, 99736, "Student")
    await client.post(
        GROUP_MEMBERS_URL.format(group_id=group_id),
        json={"student_user_id": student_id},
        headers=headers,
    )

    resp = await client.delete(
        GROUP_MEMBER_URL.format(group_id=group_id, student_id=student_id),
        headers=headers,
    )
    assert resp.status_code == 204

    members = await client.get(
        GROUP_MEMBERS_URL.format(group_id=group_id), headers=headers
    )
    assert members.json()["total"] == 0


@pytest.mark.asyncio
async def test_remove_member_not_a_member_is_a_noop(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99718)
    headers = auth_headers(master["session_token"])
    created = await client.post(GROUPS_URL, json={"name": "Empty"}, headers=headers)
    group_id = created.json()["id"]
    student_id = await _login(client, 99737, "NeverAdded")

    resp = await client.delete(
        GROUP_MEMBER_URL.format(group_id=group_id, student_id=student_id),
        headers=headers,
    )

    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_remove_member_system_slug_400(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99719)
    headers = auth_headers(master["session_token"])
    student_id = await _login(client, 99738, "Student")

    resp = await client.delete(
        GROUP_MEMBER_URL.format(group_id="students", student_id=student_id),
        headers=headers,
    )

    assert resp.status_code == 400


# ===================================================================
# Tag
# ===================================================================


@pytest.mark.asyncio
async def test_set_and_clear_tag(client: AsyncClient, db_session: AsyncSession) -> None:
    master = await _make_verified_master(client, db_session, 99720)
    headers = auth_headers(master["session_token"])
    student_id = await _login(client, 99739, "Student")

    set_resp = await client.put(
        TAG_URL.format(student_id=student_id),
        json={"tag": "Платит вовремя"},
        headers=headers,
    )
    assert set_resp.status_code == 200
    assert set_resp.json()["tag"] == "Платит вовремя"

    row = (
        await db_session.execute(
            select(MasterStudent).where(
                MasterStudent.master_id == master["user"]["id"],
                MasterStudent.student_user_id == student_id,
            )
        )
    ).scalar_one()
    assert row.tag == "Платит вовремя"

    clear_resp = await client.put(
        TAG_URL.format(student_id=student_id),
        json={"tag": None},
        headers=headers,
    )
    assert clear_resp.status_code == 200
    assert clear_resp.json()["tag"] is None

    remaining = (
        await db_session.execute(
            select(MasterStudent).where(
                MasterStudent.master_id == master["user"]["id"],
                MasterStudent.student_user_id == student_id,
            )
        )
    ).scalar_one_or_none()
    # Neither tagged nor blocked -> the row is gone entirely.
    assert remaining is None


@pytest.mark.asyncio
async def test_tag_overwrites_not_appends(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99721)
    headers = auth_headers(master["session_token"])
    student_id = await _login(client, 99740, "Student")

    await client.put(
        TAG_URL.format(student_id=student_id), json={"tag": "Первый"}, headers=headers
    )
    second = await client.put(
        TAG_URL.format(student_id=student_id),
        json={"tag": "Второй"},
        headers=headers,
    )

    assert second.json()["tag"] == "Второй"
    rows = (
        (
            await db_session.execute(
                select(MasterStudent).where(
                    MasterStudent.master_id == master["user"]["id"],
                    MasterStudent.student_user_id == student_id,
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1  # one row, overwritten -- not a second row


# ===================================================================
# Block / unblock
# ===================================================================


@pytest.mark.asyncio
async def test_block_sets_blocked_at_and_removes_from_custom_groups(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99722)
    master_id = master["user"]["id"]
    headers = auth_headers(master["session_token"])
    created = await client.post(GROUPS_URL, json={"name": "Was In"}, headers=headers)
    group_id = created.json()["id"]
    student_id = await _login(client, 99741, "Student")
    await client.post(
        GROUP_MEMBERS_URL.format(group_id=group_id),
        json={"student_user_id": student_id},
        headers=headers,
    )

    resp = await client.post(BLOCK_URL.format(student_id=student_id), headers=headers)

    assert resp.status_code == 200
    assert resp.json()["cancelled_bookings_count"] == 0

    row = (
        await db_session.execute(
            select(MasterStudent).where(
                MasterStudent.master_id == master_id,
                MasterStudent.student_user_id == student_id,
            )
        )
    ).scalar_one()
    assert row.blocked_at is not None

    memberships = (
        (
            await db_session.execute(
                select(MasterGroupMembership).where(
                    MasterGroupMembership.student_user_id == student_id,
                )
            )
        )
        .scalars()
        .all()
    )
    assert memberships == []


@pytest.mark.asyncio
async def test_block_cancels_and_refunds_future_confirmed_bookings(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The reused path: refund_booking() (payments/refund.py), same call
    shape refund_all_bookings_for_practice() already uses for a
    master-initiated cancel. Asserted via ITS effect: Purchase -> REFUNDED,
    no ledger internals re-implemented here."""
    master = await _make_verified_master(client, db_session, 99723)
    master_id = master["user"]["id"]
    headers = auth_headers(master["session_token"])
    student_id = await _login(client, 99742, "Student")

    future_practice = await _practice(
        db_session,
        master_id,
        scheduled_hours_from_now=48,
        price_cents=1000,
        is_free=False,
    )
    future_booking = await _booking(db_session, future_practice, student_id)
    future_purchase = await _purchase(
        db_session,
        future_practice,
        future_booking,
        student_id,
        paid_cents=1000,
    )

    # A PAST confirmed booking -- must NOT be touched (only FUTURE counts).
    past_practice = await _practice(
        db_session,
        master_id,
        scheduled_hours_from_now=-5,
        status=PracticeStatus.COMPLETED.value,
    )
    past_booking = await _booking(db_session, past_practice, student_id)

    # A future booking that is only PENDING, not CONFIRMED -- must NOT be
    # touched (task's literal scope: booking status CONFIRMED).
    pending_practice = await _practice(
        db_session, master_id, scheduled_hours_from_now=72
    )
    pending_booking = await _booking(
        db_session,
        pending_practice,
        student_id,
        status=BookingStatus.PENDING.value,
    )
    # Same cross-session visibility rule as _make_verified_master: the BLOCK
    # endpoint reads practices/bookings through its own request session.
    await db_session.commit()

    resp = await client.post(BLOCK_URL.format(student_id=student_id), headers=headers)

    assert resp.status_code == 200
    assert resp.json()["cancelled_bookings_count"] == 1

    await db_session.refresh(future_booking)
    assert future_booking.status == BookingStatus.CANCELLED.value
    await db_session.refresh(future_purchase)
    assert future_purchase.status == PurchaseStatus.REFUNDED.value

    await db_session.refresh(past_booking)
    assert past_booking.status == BookingStatus.CONFIRMED.value  # untouched

    await db_session.refresh(pending_booking)
    assert pending_booking.status == BookingStatus.PENDING.value  # untouched


@pytest.mark.asyncio
async def test_blocked_student_excluded_from_derived_students(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99724)
    master_id = master["user"]["id"]
    headers = auth_headers(master["session_token"])
    student_id = await _login(client, 99743, "Student")
    past_practice = await _practice(
        db_session,
        master_id,
        scheduled_hours_from_now=-5,
        status=PracticeStatus.COMPLETED.value,
    )
    await _booking(
        db_session, past_practice, student_id, status=BookingStatus.ATTENDED.value
    )
    await db_session.commit()

    before = await client.get(
        GROUP_MEMBERS_URL.format(group_id="students"),
        headers=headers,
    )
    assert before.json()["total"] == 1

    await client.post(BLOCK_URL.format(student_id=student_id), headers=headers)

    after = await client.get(
        GROUP_MEMBERS_URL.format(group_id="students"),
        headers=headers,
    )
    assert after.json()["total"] == 0


@pytest.mark.asyncio
async def test_unblock_returns_to_students_without_restoring_custom_group_but_keeps_tag(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99725)
    master_id = master["user"]["id"]
    headers = auth_headers(master["session_token"])
    created = await client.post(GROUPS_URL, json={"name": "Original"}, headers=headers)
    group_id = created.json()["id"]
    student_id = await _login(client, 99744, "Student")
    await client.post(
        GROUP_MEMBERS_URL.format(group_id=group_id),
        json={"student_user_id": student_id},
        headers=headers,
    )
    await client.put(
        TAG_URL.format(student_id=student_id),
        json={"tag": "Постоянный клиент"},
        headers=headers,
    )
    past_practice = await _practice(
        db_session,
        master_id,
        scheduled_hours_from_now=-5,
        status=PracticeStatus.COMPLETED.value,
    )
    await _booking(
        db_session, past_practice, student_id, status=BookingStatus.ATTENDED.value
    )
    await db_session.commit()

    await client.post(BLOCK_URL.format(student_id=student_id), headers=headers)

    unblock_resp = await client.delete(
        BLOCK_URL.format(student_id=student_id), headers=headers
    )
    assert unblock_resp.status_code == 204

    # Back in the derived «Ученики».
    students = await client.get(
        GROUP_MEMBERS_URL.format(group_id="students"), headers=headers
    )
    assert students.json()["total"] == 1
    assert students.json()["items"][0]["tag"] == "Постоянный клиент"  # tag kept

    # NOT restored to the custom group (owner-settled).
    custom_members = await client.get(
        GROUP_MEMBERS_URL.format(group_id=group_id), headers=headers
    )
    assert custom_members.json()["total"] == 0

    row = (
        await db_session.execute(
            select(MasterStudent).where(
                MasterStudent.master_id == master_id,
                MasterStudent.student_user_id == student_id,
            )
        )
    ).scalar_one()
    assert row.blocked_at is None
    assert row.tag == "Постоянный клиент"


@pytest.mark.asyncio
async def test_unblock_not_blocked_404(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    master = await _make_verified_master(client, db_session, 99726)
    headers = auth_headers(master["session_token"])
    student_id = await _login(client, 99745, "NeverBlocked")

    resp = await client.delete(BLOCK_URL.format(student_id=student_id), headers=headers)

    assert resp.status_code == 404


# ===================================================================
# Derived «Ученики» -- non-cancelled minus blocked
# ===================================================================


@pytest.mark.asyncio
async def test_derived_students_widened_beyond_attended_only(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """owner Q2=A: pending/confirmed/attended/no_show ALL count -- only
    cancelled is excluded. Wider than students_service's ATTENDED-only
    aggregate (a DIFFERENT, still-existing endpoint)."""
    master = await _make_verified_master(client, db_session, 99727)
    master_id = master["user"]["id"]
    headers = auth_headers(master["session_token"])

    counted_statuses = [
        BookingStatus.PENDING.value,
        BookingStatus.CONFIRMED.value,
        BookingStatus.ATTENDED.value,
        BookingStatus.NO_SHOW.value,
    ]
    for i, status in enumerate(counted_statuses):
        student_id = await _login(client, 99746 + i, f"S{i}")
        practice = await _practice(
            db_session,
            master_id,
            scheduled_hours_from_now=-5,
            status=PracticeStatus.COMPLETED.value,
        )
        await _booking(db_session, practice, student_id, status=status)

    cancelled_student_id = await _login(client, 99760, "Cancelled")
    cancelled_practice = await _practice(
        db_session,
        master_id,
        scheduled_hours_from_now=-5,
        status=PracticeStatus.COMPLETED.value,
    )
    await _booking(
        db_session,
        cancelled_practice,
        cancelled_student_id,
        status=BookingStatus.CANCELLED.value,
    )
    await db_session.commit()

    resp = await client.get(
        GROUP_MEMBERS_URL.format(group_id="students"), headers=headers
    )

    assert resp.status_code == 200
    assert resp.json()["total"] == len(counted_statuses)  # cancelled excluded


# ===================================================================
# P3 addenda (ПРОМТ №592): GET /masters/me/tags, GET .../students/{id}/groups
# ===================================================================


@pytest.mark.asyncio
async def test_my_tags_returns_distinct_alphabetical_tags(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99728)
    headers = auth_headers(master["session_token"])
    s1 = await _login(client, 99747, "S1")
    s2 = await _login(client, 99748, "S2")
    s3 = await _login(client, 99749, "S3")

    await client.put(
        TAG_URL.format(student_id=s1), json={"tag": "Постоянный"}, headers=headers,
    )
    await client.put(
        TAG_URL.format(student_id=s2), json={"tag": "Новичок"}, headers=headers,
    )
    # Same tag reused by a second student -- must not duplicate in the palette.
    await client.put(
        TAG_URL.format(student_id=s3), json={"tag": "Постоянный"}, headers=headers,
    )

    resp = await client.get(MY_TAGS_URL, headers=headers)

    assert resp.status_code == 200
    assert resp.json()["tags"] == ["Новичок", "Постоянный"]  # alphabetical, deduped


@pytest.mark.asyncio
async def test_my_tags_empty_when_nobody_tagged(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99729)
    headers = auth_headers(master["session_token"])

    resp = await client.get(MY_TAGS_URL, headers=headers)

    assert resp.status_code == 200
    assert resp.json()["tags"] == []


@pytest.mark.asyncio
async def test_student_groups_lists_only_this_masters_custom_groups(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master_a = await _make_verified_master(client, db_session, 99750)
    headers_a = auth_headers(master_a["session_token"])
    master_b = await _make_verified_master(client, db_session, 99751)
    headers_b = auth_headers(master_b["session_token"])

    group_a1 = await client.post(GROUPS_URL, json={"name": "VIP"}, headers=headers_a)
    # Created but never joined -- proves the response isn't "every group this
    # master has", only groups this STUDENT is actually a member of.
    await client.post(GROUPS_URL, json={"name": "Утро"}, headers=headers_a)
    group_b = await client.post(
        GROUPS_URL, json={"name": "Другой мастер"}, headers=headers_b,
    )

    student_id = await _login(client, 99752, "Student")
    await client.post(
        GROUP_MEMBERS_URL.format(group_id=group_a1.json()["id"]),
        json={"student_user_id": student_id},
        headers=headers_a,
    )
    # Membership under master_b must never leak into master_a's response.
    await client.post(
        GROUP_MEMBERS_URL.format(group_id=group_b.json()["id"]),
        json={"student_user_id": student_id},
        headers=headers_b,
    )

    resp = await client.get(
        STUDENT_GROUPS_URL.format(student_id=student_id), headers=headers_a,
    )

    assert resp.status_code == 200
    names = [g["name"] for g in resp.json()["groups"]]
    assert names == ["VIP"]
    assert "Утро" not in names  # never joined
    assert "Другой мастер" not in names  # a different master's group


@pytest.mark.asyncio
async def test_student_groups_empty_when_no_custom_membership(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99753)
    headers = auth_headers(master["session_token"])
    student_id = await _login(client, 99754, "Student")

    resp = await client.get(
        STUDENT_GROUPS_URL.format(student_id=student_id), headers=headers,
    )

    assert resp.status_code == 200
    assert resp.json()["groups"] == []


# ===================================================================
# P4 addenda (ПРОМТ №593): group invite links
# ===================================================================
#
# BOT_URL is monkeypatched (same pattern as test_master_invite.py) so the
# composed link is deterministic regardless of the ambient .env.

_BOT_URL = "https://t.me/velo_testbot"


@pytest.mark.asyncio
async def test_group_invite_returns_stable_url_on_repeat_calls(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.core.config import settings

    monkeypatch.setattr(settings, "telegram_bot_url", _BOT_URL)

    master = await _make_verified_master(client, db_session, 99761)
    headers = auth_headers(master["session_token"])
    group = await client.post(GROUPS_URL, json={"name": "VIP"}, headers=headers)
    group_id = group.json()["id"]

    resp1 = await client.post(
        GROUP_INVITE_URL.format(group_id=group_id), headers=headers,
    )
    resp2 = await client.post(
        GROUP_INVITE_URL.format(group_id=group_id), headers=headers,
    )

    assert resp1.status_code == 200
    assert resp2.status_code == 200
    url1 = resp1.json()["invite_url"]
    url2 = resp2.json()["invite_url"]
    assert url1 == url2  # idempotent -- the master re-taps expecting the SAME link
    assert url1.startswith(f"{_BOT_URL}?startapp=group_invite__")


@pytest.mark.asyncio
async def test_group_invite_system_slug_rejected_400(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.core.config import settings

    monkeypatch.setattr(settings, "telegram_bot_url", _BOT_URL)

    master = await _make_verified_master(client, db_session, 99762)
    headers = auth_headers(master["session_token"])

    resp = await client.post(
        GROUP_INVITE_URL.format(group_id="students"), headers=headers,
    )

    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_group_invite_other_masters_group_404(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.core.config import settings

    monkeypatch.setattr(settings, "telegram_bot_url", _BOT_URL)

    master_a = await _make_verified_master(client, db_session, 99763)
    headers_a = auth_headers(master_a["session_token"])
    master_b = await _make_verified_master(client, db_session, 99764)
    headers_b = auth_headers(master_b["session_token"])

    group = await client.post(GROUPS_URL, json={"name": "Чужая"}, headers=headers_a)
    group_id = group.json()["id"]

    resp = await client.post(
        GROUP_INVITE_URL.format(group_id=group_id), headers=headers_b,
    )

    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_join_group_adds_membership_and_is_idempotent(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.core.config import settings

    monkeypatch.setattr(settings, "telegram_bot_url", _BOT_URL)

    master = await _make_verified_master(client, db_session, 99765)
    headers = auth_headers(master["session_token"])
    group = await client.post(GROUPS_URL, json={"name": "VIP"}, headers=headers)
    group_id = group.json()["id"]

    invite_resp = await client.post(
        GROUP_INVITE_URL.format(group_id=group_id), headers=headers,
    )
    token = invite_resp.json()["invite_url"].rsplit("group_invite__", 1)[1]

    joiner_auth = await login_user(client, telegram_id=99766, first_name="Joiner")
    joiner_id = joiner_auth["user"]["id"]
    joiner_headers = auth_headers(joiner_auth["session_token"])

    resp = await client.post(
        JOIN_GROUP_URL, json={"token": token}, headers=joiner_headers,
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["group_id"] == group_id
    assert body["group_name"] == "VIP"
    assert "Master" in body["master_name"]

    members = await client.get(
        GROUP_MEMBERS_URL.format(group_id=group_id), headers=headers,
    )
    assert members.json()["total"] == 1
    assert members.json()["items"][0]["id"] == joiner_id

    # Re-joining via the same link is a no-op success, not a 409.
    resp2 = await client.post(
        JOIN_GROUP_URL, json={"token": token}, headers=joiner_headers,
    )
    assert resp2.status_code == 200
    members2 = await client.get(
        GROUP_MEMBERS_URL.format(group_id=group_id), headers=headers,
    )
    assert members2.json()["total"] == 1  # still just the one member


@pytest.mark.asyncio
async def test_join_group_blocked_joiner_gets_403(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.core.config import settings

    monkeypatch.setattr(settings, "telegram_bot_url", _BOT_URL)

    master = await _make_verified_master(client, db_session, 99767)
    headers = auth_headers(master["session_token"])
    group = await client.post(GROUPS_URL, json={"name": "VIP"}, headers=headers)
    group_id = group.json()["id"]
    invite_resp = await client.post(
        GROUP_INVITE_URL.format(group_id=group_id), headers=headers,
    )
    token = invite_resp.json()["invite_url"].rsplit("group_invite__", 1)[1]

    blocked_auth = await login_user(client, telegram_id=99768, first_name="Blocked")
    blocked_id = blocked_auth["user"]["id"]
    blocked_headers = auth_headers(blocked_auth["session_token"])
    await client.post(BLOCK_URL.format(student_id=blocked_id), headers=headers)

    resp = await client.post(
        JOIN_GROUP_URL, json={"token": token}, headers=blocked_headers,
    )

    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_join_group_invalid_token_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    joiner_auth = await login_user(client, telegram_id=99769, first_name="Joiner")
    joiner_headers = auth_headers(joiner_auth["session_token"])

    resp = await client.post(
        JOIN_GROUP_URL,
        json={"token": "totally-unknown-token-0000000000"},
        headers=joiner_headers,
    )

    assert resp.status_code == 404
