# =============================================================================
# VELO Backend -- Tests: Master Groups (P1, PROMPT №590; P3 addenda PROMPT
# №592; T-37 contact-list union PROMPT №706; CANCELLED amendment PROMPT №707)
# =============================================================================
#
# telegram_id ranges: 99700-99799 (original), 89800-89809 (T-37) + 89840-89849
# (its amendment -- the original band is exhausted, see _TID_MIN_T37's own
# comment; MOVED 2026-08-14 (PROMPT №710), see that comment for why)
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
#   T-37: the further CONTACT-LIST widening -- chat-only, waitlist-at-any-
#     status-only, and group-membership-only contacts each appear alone;
#     dedup across all four sources for one student; the blocked_at exclusion
#     applies uniformly to the new sources, not just bookings
#   T-37 amendment (2026-08-14): a CANCELLED-only booking is ALSO a contact;
#     blocked_at still excludes a cancelled-only contact; a mixed cancelled+
#     attended contact dedups to one row and sorts by COUNTABLE bookings only
#     (proves booking_contacts and booking_for_count are genuinely separate
#     queries, not one subquery serving both roles)
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
from app.modules.chats.models import ChatThread
from app.modules.masters.groups_models import (
    MasterGroup,
    MasterGroupMembership,
    MasterStudent,
)
from app.modules.masters.models import MasterProfile
from app.modules.payments.models import Purchase, PurchaseStatus
from app.modules.practices.models import (
    AudienceKind,
    Practice,
    PracticeAudienceGroup,
    PracticeStatus,
    PracticeType,
)
from app.modules.users.models import User, UserRole
from app.modules.waitlist.models import Waitlist, WaitlistStatus
from tests.helpers import (
    auth_headers,
    fresh_execute,
    fresh_get,
    full_cleanup_range,
    login_user,
)

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
GROUP_SEARCH_URL = "/api/v1/masters/me/groups/search"

_TID_MIN = 99700
_TID_MAX = 99799

# T-37 (PROMPT №706): this file's own 99700-99799 band is exhausted (93 of
# 100 ids already in use, no run of >=8 free) -- new fixtures below take a
# SEPARATE band instead of fighting for the last 7 scattered slots. Per the
# fleet's telegram_id registry: velo's free window is 89760-89899, we hold
# 89800-89839 within it. T-37 itself used the first 10 (89800-89809).
#
# ⚠ MOVED 2026-08-14 (PROMPT №710): the 2026-08-14 CANCELLED-contact amendment
# (PROMPT №707) originally extended this SAME band with the next 10
# (89810-89819) -- and that decade COLLIDED, id-for-id, with
# `test_chats_t3_students.py`'s own BAND_MIN+15..+16 (89815/89816), which
# claims cleanup over the WHOLE 89800-89839 span and is ALREADY PUBLISHED
# (commit `69035333`, on `origin/test`) while this file's amendment
# (`14244b22`) is not. Published claim wins: the amendment's decade moved to
# `_TID_MIN_T37B`/`_TID_MAX_T37B` below, a range with ZERO hits anywhere in
# `backend/tests/` (grepped, not assumed). The ORIGINAL T-37 decade
# (89800-89809) did NOT move -- it is not literally written by
# `test_chats_t3_students.py` (that file's own header says only its offsets
# 15..39 are in use, i.e. 89815-89839), so no id-level collision exists there;
# it remains inside that file's broader cleanup SWEEP, which is a pre-existing
# condition of the published band, not something this amendment introduced.
_TID_MIN_T37 = 89800
_TID_MAX_T37 = 89809

# The amendment's own decade (PROMPT №707), relocated (PROMPT №710) to a
# provably free run -- confirmed by a full-repo scan of every telegram_id
# literal and band constant in `backend/tests/*.py`: 89840-89898 has zero
# hits anywhere (89760-89799 is also free, vacated by `69035333`, but
# 89840-89849 keeps this file's two T-37 decades adjacent in the registry).
_TID_MIN_T37B = 89840
_TID_MAX_T37B = 89849


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
    #
    # T-37: extra_ranges, NOT a second call -- full_cleanup_range's own
    # docstring warns that two back-to-back calls silently undo each other
    # (the H-R1/H-R2 rollback trap); one call cleaning both bands is what it
    # exists for. chat_threads is not in full_cleanup_range's own delete list
    # (ChatThread has ondelete="CASCADE" on both user FKs, so deleting the
    # range's users here cascades their chat rows automatically).
    await full_cleanup_range(
        db_session, _TID_MIN, _TID_MAX,
        delete_users=True, extra_ranges=[
            (_TID_MIN_T37, _TID_MAX_T37), (_TID_MIN_T37B, _TID_MAX_T37B),
        ],
    )
    await db_session.commit()
    yield
    await full_cleanup_range(
        db_session, _TID_MIN, _TID_MAX,
        delete_users=True, extra_ranges=[
            (_TID_MIN_T37, _TID_MAX_T37), (_TID_MIN_T37B, _TID_MAX_T37B),
        ],
    )
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


async def _waitlist_entry(
    db_session: AsyncSession,
    practice: Practice,
    user_id: str,
    *,
    position: int,
    status: str = WaitlistStatus.WAITING.value,
) -> Waitlist:
    entry = Waitlist(
        practice_id=practice.id,
        user_id=user_id,
        position=position,
        status=status,
        joined_at=datetime.now(UTC),
    )
    db_session.add(entry)
    await db_session.flush()
    return entry


async def _chat_thread(
    db_session: AsyncSession,
    master_id: str,
    client_id: str,
) -> ChatThread:
    """T-37: a chat-contact fixture. comms_thread_id is a fake local UUID --
    the union source only reads client_user_id/operator_user_id, and this
    table's own module docstring says comms is never asked for domain facts,
    so nothing here should (or does) reach a live comms stack."""
    thread = ChatThread(
        comms_thread_id=uuid4(),
        client_user_id=client_id,
        operator_user_id=master_id,
    )
    db_session.add(thread)
    await db_session.flush()
    return thread


async def _group_membership(
    db_session: AsyncSession,
    master_id: str,
    student_id: str,
    *,
    group_name: str = "T37 Group",
) -> MasterGroupMembership:
    """T-37: a custom-group-membership fixture, written directly (bypassing
    add_group_member/join_group_by_token) since both produce the IDENTICAL
    row -- the schema cannot distinguish an invite-token join from a
    hand-added member (owner-ruled 2026-08-14), so there is nothing a service
    call would add over a direct insert for this test's purpose."""
    group = MasterGroup(master_id=master_id, name=group_name)
    db_session.add(group)
    await db_session.flush()
    membership = MasterGroupMembership(group_id=group.id, student_user_id=student_id)
    db_session.add(membership)
    await db_session.flush()
    return membership


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
async def test_create_group_with_description(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Owner Q4 (PROMPT №610): description round-trips on create."""
    master = await _make_verified_master(client, db_session, 99776)

    resp = await client.post(
        GROUPS_URL,
        json={"name": "Группа с описанием", "description": "Для продвинутых учеников"},
        headers=auth_headers(master["session_token"]),
    )

    assert resp.status_code == 201
    body = resp.json()
    assert body["description"] == "Для продвинутых учеников"


@pytest.mark.asyncio
async def test_create_group_without_description(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Omitting `description` entirely -- the field is optional -- stores
    NULL, same as an explicit blank/whitespace-only value (normalized in
    create_group(), asserted here via the response, not just the DB row)."""
    master = await _make_verified_master(client, db_session, 99777)
    headers = auth_headers(master["session_token"])

    resp = await client.post(GROUPS_URL, json={"name": "Без описания"}, headers=headers)
    assert resp.status_code == 201
    assert resp.json()["description"] is None

    blank_resp = await client.post(
        GROUPS_URL,
        json={"name": "Пустое описание", "description": "   "},
        headers=headers,
    )
    assert blank_resp.status_code == 201
    assert blank_resp.json()["description"] is None


@pytest.mark.asyncio
async def test_rename_group_leaves_description_untouched(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """RenameGroupRequest has no `description` field (see groups_schemas.py's
    own docstring) -- renaming a group must not disturb its description."""
    master = await _make_verified_master(client, db_session, 99778)
    headers = auth_headers(master["session_token"])
    created = await client.post(
        GROUPS_URL,
        json={"name": "Старое", "description": "Исходное описание"},
        headers=headers,
    )
    group_id = created.json()["id"]

    resp = await client.patch(
        GROUP_URL.format(group_id=group_id),
        json={"name": "Новое"},
        headers=headers,
    )

    assert resp.status_code == 200
    assert resp.json()["name"] == "Новое"
    assert resp.json()["description"] == "Исходное описание"


@pytest.mark.asyncio
async def test_list_groups_includes_description(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """GET /masters/me/groups: the custom group carries its description;
    the virtual «Ученики» group (never a MasterGroup row) carries None."""
    master = await _make_verified_master(client, db_session, 99779)
    headers = auth_headers(master["session_token"])
    await client.post(
        GROUPS_URL,
        json={"name": "Листинг", "description": "Видно в списке"},
        headers=headers,
    )

    resp = await client.get(GROUPS_URL, headers=headers)

    assert resp.status_code == 200
    items = {item["name"]: item for item in resp.json()["items"]}
    assert items["Листинг"]["description"] == "Видно в списке"
    assert items["Ученики"]["description"] is None


@pytest.mark.asyncio
async def test_edit_description_only_leaves_name_untouched(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Owner Q10 (PROMPT №611): PATCH with description sent alongside the
    SAME name updates only the description -- name-unchanged must not skip
    the description write (the trap in the old early-return shape)."""
    master = await _make_verified_master(client, db_session, 99780)
    headers = auth_headers(master["session_token"])
    created = await client.post(GROUPS_URL, json={"name": "Группа X"}, headers=headers)
    group_id = created.json()["id"]
    assert created.json()["description"] is None

    resp = await client.patch(
        GROUP_URL.format(group_id=group_id),
        json={"name": "Группа X", "description": "Добавлено позже"},
        headers=headers,
    )

    assert resp.status_code == 200
    assert resp.json()["name"] == "Группа X"
    assert resp.json()["description"] == "Добавлено позже"


@pytest.mark.asyncio
async def test_edit_description_and_rename_together(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Owner Q10: the frontend's combined dialog sends both fields at once
    -- both must land in the same PATCH."""
    master = await _make_verified_master(client, db_session, 99781)
    headers = auth_headers(master["session_token"])
    created = await client.post(
        GROUPS_URL,
        json={"name": "Старое имя", "description": "Старое описание"},
        headers=headers,
    )
    group_id = created.json()["id"]

    resp = await client.patch(
        GROUP_URL.format(group_id=group_id),
        json={"name": "Новое имя", "description": "Новое описание"},
        headers=headers,
    )

    assert resp.status_code == 200
    assert resp.json()["name"] == "Новое имя"
    assert resp.json()["description"] == "Новое описание"


@pytest.mark.asyncio
async def test_clearing_description_via_patch_sets_null(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Owner Q10: an explicitly SENT blank/whitespace description clears it
    to NULL -- distinct from omitting the key entirely (which leaves it
    untouched, see test_rename_group_leaves_description_untouched above)."""
    master = await _make_verified_master(client, db_session, 99782)
    headers = auth_headers(master["session_token"])
    created = await client.post(
        GROUPS_URL,
        json={"name": "Очищаемая", "description": "Будет стёрто"},
        headers=headers,
    )
    group_id = created.json()["id"]

    resp = await client.patch(
        GROUP_URL.format(group_id=group_id),
        json={"name": "Очищаемая", "description": "   "},
        headers=headers,
    )

    assert resp.status_code == 200
    assert resp.json()["description"] is None


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
            await fresh_execute(
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
        await fresh_execute(
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
            await fresh_execute(
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
        await fresh_execute(
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

    future_booking = await fresh_get(Booking, future_booking.id)
    assert future_booking.status == BookingStatus.CANCELLED.value
    await db_session.refresh(future_purchase)
    assert future_purchase.status == PurchaseStatus.REFUNDED.value

    await db_session.refresh(past_booking)
    assert past_booking.status == BookingStatus.CONFIRMED.value  # untouched

    await db_session.refresh(pending_booking)
    assert pending_booking.status == BookingStatus.PENDING.value  # untouched


@pytest.mark.asyncio
async def test_block_emits_reminder_cancel_for_cancelled_bookings(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """T1: blocking refunds future bookings, so their pending reminder
    series must be expired too (a refunded, blocked user must not still
    get "Practice tomorrow"). Each cancelled booking emits ONE
    reminder_cancel correlated by its booking_id -- same per-booking
    cancel as bookings/service.py::cancel_booking."""
    from app.core.events.models import OutboxEvent

    master = await _make_verified_master(client, db_session, 99755)
    master_id = master["user"]["id"]
    headers = auth_headers(master["session_token"])
    student_id = await _login(client, 99756, "Student")

    future_practice = await _practice(
        db_session, master_id, scheduled_hours_from_now=48,
        price_cents=1000, is_free=False,
    )
    future_booking = await _booking(db_session, future_practice, student_id)
    await _purchase(
        db_session, future_practice, future_booking, student_id,
        paid_cents=1000,
    )
    await db_session.commit()

    resp = await client.post(
        BLOCK_URL.format(student_id=student_id), headers=headers,
    )
    assert resp.status_code == 200
    assert resp.json()["cancelled_bookings_count"] == 1

    # Exactly one reminder_cancel, correlated by the cancelled booking.
    rows = (
        await fresh_execute(
            select(OutboxEvent).where(
                OutboxEvent.event_type == "reminder_cancel",
                OutboxEvent.payload["correlation_value"].astext
                == str(future_booking.id),
            )
        )
    ).scalars().all()
    assert len(rows) == 1
    payload = rows[0].payload
    assert payload["correlation_key"] == "booking_id"
    assert payload["target_type"] == "user"
    assert payload["target_value"] == str(student_id)


@pytest.mark.asyncio
async def test_block_removes_waitlist_entries_for_this_master_only(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Owner Q13 (PROMPT №613): block_student removes ACTIVE (waiting/
    notified) waitlist entries for THIS master's practices -- scoped
    exactly like the future-booking cancel above, never touching another
    master's queue for the same student (that's the next test)."""
    master = await _make_verified_master(client, db_session, 99755)
    master_id = master["user"]["id"]
    headers = auth_headers(master["session_token"])
    student_id = await _login(client, 99783, "Waiter")

    waiting_practice = await _practice(
        db_session, master_id, scheduled_hours_from_now=48,
    )
    waiting_entry = await _waitlist_entry(
        db_session, waiting_practice, student_id, position=1,
    )

    notified_practice = await _practice(
        db_session, master_id, scheduled_hours_from_now=72,
    )
    notified_entry = await _waitlist_entry(
        db_session,
        notified_practice,
        student_id,
        position=1,
        status=WaitlistStatus.NOTIFIED.value,
    )

    # A CONVERTED entry (already resolved) -- must NOT be touched, it's not
    # ACTIVE.
    converted_practice = await _practice(
        db_session, master_id, scheduled_hours_from_now=96,
    )
    converted_entry = await _waitlist_entry(
        db_session,
        converted_practice,
        student_id,
        position=1,
        status=WaitlistStatus.CONVERTED.value,
    )
    await db_session.commit()

    resp = await client.post(
        BLOCK_URL.format(student_id=student_id), headers=headers,
    )
    assert resp.status_code == 200

    await db_session.refresh(waiting_entry)
    assert waiting_entry.status == WaitlistStatus.REMOVED.value
    await db_session.refresh(notified_entry)
    assert notified_entry.status == WaitlistStatus.REMOVED.value
    await db_session.refresh(converted_entry)
    assert converted_entry.status == WaitlistStatus.CONVERTED.value  # untouched


@pytest.mark.asyncio
async def test_block_never_touches_a_different_masters_waitlist(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The same student, waiting for a DIFFERENT master's practice, keeps
    their spot when master A blocks them."""
    master_a = await _make_verified_master(client, db_session, 99756)
    headers_a = auth_headers(master_a["session_token"])
    master_b = await _make_verified_master(client, db_session, 99757)
    master_b_id = master_b["user"]["id"]
    student_id = await _login(client, 99784, "Waiter")

    other_practice = await _practice(
        db_session, master_b_id, scheduled_hours_from_now=48,
    )
    other_entry = await _waitlist_entry(
        db_session, other_practice, student_id, position=1,
    )
    await db_session.commit()

    resp = await client.post(
        BLOCK_URL.format(student_id=student_id), headers=headers_a,
    )
    assert resp.status_code == 200

    await db_session.refresh(other_entry)
    assert other_entry.status == WaitlistStatus.WAITING.value  # untouched


@pytest.mark.asyncio
async def test_block_promotes_the_next_waiting_person_not_the_blocked_one(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Owner Q13: a blocked student who was NOTIFIED (holding a freed spot)
    must not sit on it until the confirm window times out -- the next real
    person in line gets notified immediately, same trigger leave_waitlist's
    own decline already uses."""
    master = await _make_verified_master(client, db_session, 99758)
    master_id = master["user"]["id"]
    headers = auth_headers(master["session_token"])
    blocked_id = await _login(client, 99785, "Blocked")
    next_id = await _login(client, 99786, "NextInLine")

    practice = await _practice(db_session, master_id, scheduled_hours_from_now=48)
    blocked_entry = await _waitlist_entry(
        db_session,
        practice,
        blocked_id,
        position=1,
        status=WaitlistStatus.NOTIFIED.value,
    )
    next_entry = await _waitlist_entry(
        db_session, practice, next_id, position=2,
    )
    await db_session.commit()

    resp = await client.post(
        BLOCK_URL.format(student_id=blocked_id), headers=headers,
    )
    assert resp.status_code == 200

    await db_session.refresh(blocked_entry)
    assert blocked_entry.status == WaitlistStatus.REMOVED.value
    await db_session.refresh(next_entry)
    assert next_entry.status == WaitlistStatus.NOTIFIED.value


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
        await fresh_execute(
            select(MasterStudent).where(
                MasterStudent.master_id == master_id,
                MasterStudent.student_user_id == student_id,
            )
        )
    ).scalar_one()
    assert row.blocked_at is None
    assert row.tag == "Постоянный клиент"


@pytest.mark.asyncio
async def test_unblock_does_not_restore_waitlist_entry(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Owner Q13: unblock_student does NOT bring back a waitlist spot
    block_student removed -- same "no restoration" rule custom-group
    membership already follows (test above). REMOVED stays REMOVED; the
    student can join this practice's waitlist again like anyone else
    (REMOVED is a REJOINABLE status, waitlist/models.py), just not at
    their old position."""
    master = await _make_verified_master(client, db_session, 99759)
    master_id = master["user"]["id"]
    headers = auth_headers(master["session_token"])
    student_id = await _login(client, 99794, "Waiter")

    practice = await _practice(db_session, master_id, scheduled_hours_from_now=48)
    entry = await _waitlist_entry(db_session, practice, student_id, position=1)
    await db_session.commit()

    await client.post(BLOCK_URL.format(student_id=student_id), headers=headers)
    unblock_resp = await client.delete(
        BLOCK_URL.format(student_id=student_id), headers=headers,
    )
    assert unblock_resp.status_code == 204

    await db_session.refresh(entry)
    assert entry.status == WaitlistStatus.REMOVED.value  # NOT restored to waiting


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
# T-37 (PROMPT №706): "Ученики" widened to a CONTACT-LIST union -- chat
# threads, waitlist entries (any status), and custom-group membership, on
# top of the pre-existing non-cancelled-booking source. Separate band
# (_TID_MIN_T37/_TID_MAX_T37): see its declaration above for why.
# ===================================================================


@pytest.mark.asyncio
async def test_derived_students_includes_chat_only_contact(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A chat thread with no booking at all is still contact."""
    master = await _make_verified_master(client, db_session, 89800)
    master_id = master["user"]["id"]
    headers = auth_headers(master["session_token"])

    student_id = await _login(client, 89801, "ChatOnly")
    await _chat_thread(db_session, master_id, student_id)
    await db_session.commit()

    resp = await client.get(
        GROUP_MEMBERS_URL.format(group_id="students"), headers=headers
    )

    assert resp.status_code == 200
    assert resp.json()["total"] == 1
    assert resp.json()["items"][0]["id"] == student_id


@pytest.mark.asyncio
async def test_derived_students_includes_waitlist_contact_at_any_status(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Owner-ruled 2026-08-14: a DECLINED waitlist row still counts -- same
    reasoning as a cancelled booking counting elsewhere. Not restricted to
    ACTIVE_STATUSES."""
    master = await _make_verified_master(client, db_session, 89802)
    master_id = master["user"]["id"]
    headers = auth_headers(master["session_token"])

    student_id = await _login(client, 89803, "Declined")
    practice = await _practice(db_session, master_id, scheduled_hours_from_now=5)
    await _waitlist_entry(
        db_session, practice, student_id,
        position=1, status=WaitlistStatus.DECLINED.value,
    )
    await db_session.commit()

    resp = await client.get(
        GROUP_MEMBERS_URL.format(group_id="students"), headers=headers
    )

    assert resp.status_code == 200
    assert resp.json()["total"] == 1
    assert resp.json()["items"][0]["id"] == student_id


@pytest.mark.asyncio
async def test_derived_students_includes_group_member_with_no_booking(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Owner-ruled 2026-08-14 (option A): ANY custom-group membership counts
    -- the schema cannot distinguish an invite-token join from a hand-added
    member, so a hand-added member (this fixture) now appears in the general
    "Ученики" list too, not only their custom group."""
    master = await _make_verified_master(client, db_session, 89804)
    master_id = master["user"]["id"]
    headers = auth_headers(master["session_token"])

    student_id = await _login(client, 89805, "GroupOnly")
    await _group_membership(db_session, master_id, student_id)
    await db_session.commit()

    resp = await client.get(
        GROUP_MEMBERS_URL.format(group_id="students"), headers=headers
    )

    assert resp.status_code == 200
    assert resp.json()["total"] == 1
    assert resp.json()["items"][0]["id"] == student_id


@pytest.mark.asyncio
async def test_derived_students_dedupes_across_sources(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A student who is a booking contact AND a chat contact AND a group
    member appears exactly ONCE -- UNION (not UNION ALL) is the dedup."""
    master = await _make_verified_master(client, db_session, 89806)
    master_id = master["user"]["id"]
    headers = auth_headers(master["session_token"])

    student_id = await _login(client, 89807, "Everywhere")
    practice = await _practice(
        db_session, master_id,
        scheduled_hours_from_now=-5, status=PracticeStatus.COMPLETED.value,
    )
    await _booking(db_session, practice, student_id, status=BookingStatus.ATTENDED.value)
    await _chat_thread(db_session, master_id, student_id)
    await _group_membership(db_session, master_id, student_id)
    await db_session.commit()

    resp = await client.get(
        GROUP_MEMBERS_URL.format(group_id="students"), headers=headers
    )

    assert resp.status_code == 200
    assert resp.json()["total"] == 1


@pytest.mark.asyncio
async def test_derived_students_blocked_excluded_even_as_chat_only_contact(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The blocked_at exclusion applies uniformly across all four sources,
    not just the booking one -- a chat-only contact who is ALSO blocked must
    not reappear through the new union sources."""
    master = await _make_verified_master(client, db_session, 89808)
    master_id = master["user"]["id"]
    headers = auth_headers(master["session_token"])

    student_id = await _login(client, 89809, "BlockedChatOnly")
    await _chat_thread(db_session, master_id, student_id)
    db_session.add(MasterStudent(master_id=master_id, student_user_id=student_id, blocked_at=datetime.now(UTC)))
    await db_session.commit()

    resp = await client.get(
        GROUP_MEMBERS_URL.format(group_id="students"), headers=headers
    )

    assert resp.status_code == 200
    assert resp.json()["total"] == 0


# ===================================================================
# 2026-08-14 amendment (PROMPT №707): a CANCELLED booking is ALSO a contact
# -- owner-ruled, same "must not lose someone the master had contact with"
# logic already applied to group membership and declined waitlist rows.
# booking_contacts (the union source) now has NO status filter; the SEPARATE
# booking_for_count subquery keeps != CANCELLED, so a cancelled-only contact
# is visible but is not counted as a practice anywhere.
# Band: _TID_MIN_T37B/_TID_MAX_T37B (89840-89849) -- moved here from
# 89810-89819 (PROMPT №710), which collided id-for-id with
# `test_chats_t3_students.py`'s published 89800-89839 cleanup span.
# ===================================================================


@pytest.mark.asyncio
async def test_derived_students_includes_cancelled_only_contact(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A booking whose ONLY status is CANCELLED still makes its holder a
    contact -- the 2026-08-14 amendment to T-37."""
    master = await _make_verified_master(client, db_session, 89840)
    master_id = master["user"]["id"]
    headers = auth_headers(master["session_token"])

    student_id = await _login(client, 89841, "CancelledOnly")
    practice = await _practice(db_session, master_id, scheduled_hours_from_now=5)
    await _booking(
        db_session, practice, student_id, status=BookingStatus.CANCELLED.value,
    )
    await db_session.commit()

    resp = await client.get(
        GROUP_MEMBERS_URL.format(group_id="students"), headers=headers
    )

    assert resp.status_code == 200
    assert resp.json()["total"] == 1
    assert resp.json()["items"][0]["id"] == student_id


@pytest.mark.asyncio
async def test_derived_students_blocked_excluded_even_as_cancelled_only_contact(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The blocked_at exclusion applies to the widened booking source too --
    a cancelled-only contact who is ALSO blocked must not appear."""
    master = await _make_verified_master(client, db_session, 89842)
    master_id = master["user"]["id"]
    headers = auth_headers(master["session_token"])

    student_id = await _login(client, 89843, "BlockedCancelledOnly")
    practice = await _practice(db_session, master_id, scheduled_hours_from_now=5)
    await _booking(
        db_session, practice, student_id, status=BookingStatus.CANCELLED.value,
    )
    db_session.add(
        MasterStudent(
            master_id=master_id, student_user_id=student_id,
            blocked_at=datetime.now(UTC),
        )
    )
    await db_session.commit()

    resp = await client.get(
        GROUP_MEMBERS_URL.format(group_id="students"), headers=headers
    )

    assert resp.status_code == 200
    assert resp.json()["total"] == 0


@pytest.mark.asyncio
async def test_derived_students_practices_count_excludes_cancelled_when_mixed(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A contact with ONE cancelled and ONE attended booking is still a
    single contact (dedup), and their practices_count -- read here via the
    ORDER BY it drives, since GroupMemberItem exposes no count field --
    reflects only the attended booking. Two students, ordered
    most-active-first: the mixed one (1 countable) must sort AHEAD of a
    cancelled-only one (0 countable) despite the cancelled-only student
    having a LOWER telegram_id / earlier login."""
    master = await _make_verified_master(client, db_session, 89844)
    master_id = master["user"]["id"]
    headers = auth_headers(master["session_token"])

    cancelled_only_id = await _login(client, 89845, "CancelledOnly2")
    p1 = await _practice(db_session, master_id, scheduled_hours_from_now=5)
    await _booking(db_session, p1, cancelled_only_id, status=BookingStatus.CANCELLED.value)

    mixed_id = await _login(client, 89846, "MixedContact")
    p2 = await _practice(
        db_session, master_id,
        scheduled_hours_from_now=-5, status=PracticeStatus.COMPLETED.value,
    )
    await _booking(db_session, p2, mixed_id, status=BookingStatus.CANCELLED.value)
    p3 = await _practice(
        db_session, master_id,
        scheduled_hours_from_now=-3, status=PracticeStatus.COMPLETED.value,
    )
    await _booking(db_session, p3, mixed_id, status=BookingStatus.ATTENDED.value)
    await db_session.commit()

    resp = await client.get(
        GROUP_MEMBERS_URL.format(group_id="students"), headers=headers
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2  # deduped: mixed_id appears once, not twice
    ids_in_order = [item["id"] for item in body["items"]]
    assert ids_in_order == [mixed_id, cancelled_only_id]  # 1 countable > 0


# ===================================================================
# P3 addenda (PROMPT №592): GET /masters/me/tags, GET .../students/{id}/groups
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
# P4 addenda (PROMPT №593): group invite links
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


# ===================================================================
# delete_group: orphan-audience guard (P5, PROMPT №606)
# ===================================================================


async def _groups_practice(
    db_session: AsyncSession,
    master_id: str,
    group_ids: list[UUID],
    *,
    status: str = PracticeStatus.SCHEDULED.value,
) -> Practice:
    """A practice targeting `group_ids` as its audience (audience_kind=
    'groups' + one PracticeAudienceGroup row per id) -- mirrors what
    practices/service.py's PATCH switch-matrix would have produced, built
    directly since this file works at the groups_service layer, not
    through the practices API."""
    practice = await _practice(
        db_session, master_id, scheduled_hours_from_now=5, status=status,
    )
    practice.audience_kind = AudienceKind.GROUPS.value
    await db_session.flush()
    for group_id in group_ids:
        db_session.add(
            PracticeAudienceGroup(practice_id=practice.id, group_id=group_id)
        )
    await db_session.flush()
    return practice


@pytest.mark.asyncio
async def test_delete_group_blocked_when_sole_audience_of_a_practice(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99770)
    headers = auth_headers(master["session_token"])
    created = await client.post(GROUPS_URL, json={"name": "VIP"}, headers=headers)
    group_id = created.json()["id"]

    practice = await _groups_practice(
        db_session, master["user"]["id"], [UUID(group_id)],
    )
    await db_session.commit()

    resp = await client.delete(GROUP_URL.format(group_id=group_id), headers=headers)

    assert resp.status_code == 409
    assert resp.json()["error"] == "group_in_use"

    # The group and its audience link both survive -- the guard rejected
    # BEFORE session.delete(), not after.
    remaining_links = (
        (
            await db_session.execute(
                select(PracticeAudienceGroup).where(
                    PracticeAudienceGroup.practice_id == practice.id,
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(remaining_links) == 1


@pytest.mark.asyncio
async def test_delete_group_allowed_when_practice_has_another_group_too(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The group being deleted is NOT the practice's sole audience -- the
    practice keeps a valid (non-empty) audience after the cascade, exactly
    what a PATCH dropping this same group from group_ids is already
    allowed to do. Must NOT block."""
    master = await _make_verified_master(client, db_session, 99771)
    headers = auth_headers(master["session_token"])
    doomed = await client.post(GROUPS_URL, json={"name": "Doomed"}, headers=headers)
    doomed_id = doomed.json()["id"]
    survivor = await client.post(GROUPS_URL, json={"name": "Survivor"}, headers=headers)
    survivor_id = survivor.json()["id"]

    practice = await _groups_practice(
        db_session, master["user"]["id"], [UUID(doomed_id), UUID(survivor_id)],
    )
    await db_session.commit()

    resp = await client.delete(GROUP_URL.format(group_id=doomed_id), headers=headers)

    assert resp.status_code == 204

    remaining_links = (
        (
            await db_session.execute(
                select(PracticeAudienceGroup).where(
                    PracticeAudienceGroup.practice_id == practice.id,
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(remaining_links) == 1
    assert remaining_links[0].group_id == UUID(survivor_id)


@pytest.mark.asyncio
async def test_delete_group_allowed_when_sole_audience_of_a_completed_practice(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A finished practice's audience is already inert (see
    _sole_audience_practice_titles's own docstring) -- must NOT block a
    cleanup."""
    master = await _make_verified_master(client, db_session, 99772)
    headers = auth_headers(master["session_token"])
    created = await client.post(GROUPS_URL, json={"name": "Past"}, headers=headers)
    group_id = created.json()["id"]

    await _groups_practice(
        db_session,
        master["user"]["id"],
        [UUID(group_id)],
        status=PracticeStatus.COMPLETED.value,
    )
    await db_session.commit()

    resp = await client.delete(GROUP_URL.format(group_id=group_id), headers=headers)

    assert resp.status_code == 204


# ===================================================================
# GET /masters/me/groups/search: cross-group people-search (P6, PROMPT №606)
# ===================================================================


@pytest.mark.asyncio
async def test_search_group_memberships_one_row_per_membership(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A student in TWO custom groups appears as TWO rows, each naming a
    different group -- owner-ruled, not deduped to one row with two chips."""
    master = await _make_verified_master(client, db_session, 99773)
    headers = auth_headers(master["session_token"])
    group_a = await client.post(GROUPS_URL, json={"name": "Утро"}, headers=headers)
    group_a_id = group_a.json()["id"]
    group_b = await client.post(GROUPS_URL, json={"name": "VIP"}, headers=headers)
    group_b_id = group_b.json()["id"]

    student_id = await _login(client, 99790, "Дважды")
    await client.post(
        GROUP_MEMBERS_URL.format(group_id=group_a_id),
        json={"student_user_id": student_id},
        headers=headers,
    )
    await client.post(
        GROUP_MEMBERS_URL.format(group_id=group_b_id),
        json={"student_user_id": student_id},
        headers=headers,
    )

    resp = await client.get(GROUP_SEARCH_URL, headers=headers)

    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    rows = [item for item in body["items"] if item["student_user_id"] == student_id]
    assert len(rows) == 2
    group_names = {row["group_name"] for row in rows}
    assert group_names == {"Утро", "VIP"}
    for row in rows:
        assert row["name"] == "Дважды"


@pytest.mark.asyncio
async def test_search_group_memberships_name_filter(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _make_verified_master(client, db_session, 99774)
    headers = auth_headers(master["session_token"])
    group = await client.post(GROUPS_URL, json={"name": "Группа"}, headers=headers)
    group_id = group.json()["id"]

    match_id = await _login(client, 99791, "Найдётся")
    other_id = await _login(client, 99792, "Другой")
    for sid in (match_id, other_id):
        await client.post(
            GROUP_MEMBERS_URL.format(group_id=group_id),
            json={"student_user_id": sid},
            headers=headers,
        )

    resp = await client.get(
        GROUP_SEARCH_URL, params={"search": "Найдётся"}, headers=headers,
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["items"][0]["student_user_id"] == match_id


@pytest.mark.asyncio
async def test_search_group_memberships_excludes_virtual_groups(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A student with an attended booking (derived «Ученики») but no
    CUSTOM group membership at all must yield ZERO rows -- the virtuals
    are computed, not MasterGroupMembership rows, and this search is over
    real group ASSIGNMENTS."""
    master = await _make_verified_master(client, db_session, 99775)
    headers = auth_headers(master["session_token"])
    master_id = master["user"]["id"]

    practice = await _practice(db_session, master_id, scheduled_hours_from_now=-2)
    student_id = await _login(client, 99793, "Ученик")
    await _booking(
        db_session, practice, student_id, status=BookingStatus.ATTENDED.value,
    )
    await db_session.commit()

    resp = await client.get(GROUP_SEARCH_URL, headers=headers)

    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 0
    assert body["items"] == []
