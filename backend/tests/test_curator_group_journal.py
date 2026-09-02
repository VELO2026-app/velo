# =============================================================================
# VELO Backend -- Tests: the school journal (GT-16)
# =============================================================================
#
# telegram_id band: 65200-65399 (curator 65201, masters 65202-65205,
# students 65210-65219, outsider 65230, admin 65290). Declared once,
# module-level, as _TID_MIN/_TID_MAX -- tests/telegram_id_bands.py reads
# that declaration out of the AST on every run, and a file using ids
# without declaring a band fails test_blind_zone_has_not_grown. Checked
# free against the live registry before it was claimed:
# free_windows(space=(65000, 65999)) returned [(65200, 65999)].
#
# WHAT THIS FILE IS ABOUT. Until GT-16 a school kept no history: a member
# walked out and nothing was left behind. The journal is thirteen kinds of
# event, written synchronously in the transaction of the action they
# record, read by the curator alone, newest first, and dying with the
# school.
#
# THREE PROPERTIES ARE LOAD-BEARING and each has a test whose only job is
# to catch its inversion:
#
#   - a rolled-back action leaves NO event. That is the whole reason the
#     write is synchronous rather than an outbox row, and the twin is a
#     409 on a duplicate school name.
#   - an idempotent no-op leaves NO event. Four functions delete blind;
#     removing the same person twice must not write "member removed"
#     twice. This is what RETURNING bought.
#   - the actor and the target of one event are DIFFERENT PEOPLE where
#     they should be, and transfer_accepted is where reversing them is a
#     three-line mistake -- by the time the event is written the school
#     already belongs to the actor, so reading "the group's curator" as
#     the target records the actor twice. A test asserting only "an event
#     was written" passes that bug happily.
#
# ⚠ BACKEND-ONLY, UNPROVEN LOCALLY -- no Postgres in the authoring
# environment. Written to be read and to run on the server; never executed
# via pytest this session. See the delivery report for what WAS checked.
#
# CLEANUP is full_cleanup_range(..., delete_users=True) and nothing else.
# The helper knows nothing about curator tables and does not need to:
# curator_group.curator_user_id cascades from users, and
# curator_group_event.group_id cascades from curator_group. Deleting the
# band's users therefore takes the schools and their journals with them.
# That chain holds because every school here is owned by a curator inside
# the band -- see the delivery report's note on the one shape it would not
# cover.
# =============================================================================

from collections.abc import AsyncGenerator
from unittest.mock import patch
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupEvent,
    CuratorGroupEventKind,
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.masters.models import MasterProfile
from app.modules.users.models import User, UserRole
from tests.helpers import (
    auth_headers,
    fresh_execute,
    full_cleanup_range,
    login_user,
)

GROUPS_URL = "/api/v1/masters/me/curator-groups"
GROUP_URL = "/api/v1/masters/me/curator-groups/{group_id}"
JOURNAL_URL = "/api/v1/masters/me/curator-groups/{group_id}/journal"
# The group as a member of it sees it -- the only GET that serves one
# group. GROUP_URL above carries only PATCH and DELETE, so a GET there
# would be a 405 that looks like a failing assertion.
PAGE_URL = "/api/v1/curator-groups/{group_id}"
MEMBER_URL = "/api/v1/masters/me/curator-groups/{group_id}/members/{user_id}"
INVITES_URL = "/api/v1/masters/me/curator-groups/{group_id}/invites"
INVITE_KIND_URL = (
    "/api/v1/masters/me/curator-groups/{group_id}/invites/{kind}"
)
JOIN_URL = "/api/v1/curator-groups/join"
LEAVE_URL = "/api/v1/curator-groups/{group_id}/membership"
OFFER_URL = "/api/v1/masters/me/curator-groups/{group_id}/transfer"
ACCEPT_URL = "/api/v1/curator-groups/{group_id}/transfer/accept"
DECLINE_URL = "/api/v1/curator-groups/{group_id}/transfer/decline"

_TID_MIN = 65200
_TID_MAX = 65399

_TID_CURATOR = 65201
_TID_HEIR = 65202
_TID_MASTER_B = 65203
_TID_STUDENT = 65210
_TID_STUDENT_B = 65211
_TID_OUTSIDER = 65230
_TID_ADMIN = 65290

_BOT_URL = "https://t.me/velo_test_bot"
_DEEPLINK = "?startapp=curator_group_invite__"


# ===========================================================================
# Local helpers. Copied rather than imported, which is the convention in
# every curator test file. No default telegram_id on any of them: a
# default would have to live inside 65200-65399 too, or
# test_no_default_id_sits_outside_its_own_band would flag it.
# ===========================================================================


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
    first_name: str = "Master",
    last_name: str | None = None,
) -> dict:
    """A verified master who may found schools.

    can_create_groups is set (GT-15) because every test here starts by
    creating a school; the right itself is covered in
    test_curator_group_permission.py.
    """
    auth = await login_user(
        client, telegram_id=telegram_id, first_name=first_name,
    )
    user_id = UUID(auth["user"]["id"])

    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER
    if last_name is not None:
        user.last_name = last_name
    await db_session.flush()

    db_session.add(
        MasterProfile(
            user_id=user_id,
            data={
                "account": {
                    "status": "verified",
                    "can_create_groups": True,
                },
                "profile": {"bio": "m"},
            },
        )
    )
    await db_session.flush()
    await db_session.commit()
    return auth


async def _make_group(
    client: AsyncClient, curator: dict, name: str = "Школа дыхания",
) -> str:
    resp = await client.post(
        GROUPS_URL,
        json={"name": name},
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _invite(
    client: AsyncClient, curator: dict, group_id: str, kind: str,
) -> str:
    """Mint a link under a patched bot url and return the raw token."""
    with patch.object(settings, "telegram_bot_url", _BOT_URL):
        resp = await client.post(
            INVITES_URL.format(group_id=group_id),
            json={"kind": kind},
            headers=auth_headers(curator["session_token"]),
        )
    assert resp.status_code == 200, resp.text
    return resp.json()["invite_url"].split(_DEEPLINK, 1)[1]


async def _join(client: AsyncClient, auth: dict, token: str):
    return await client.post(
        JOIN_URL,
        json={"token": token},
        headers=auth_headers(auth["session_token"]),
    )


async def _seed_member(
    db_session: AsyncSession, group_id: str, auth: dict, kind: str,
) -> None:
    """Put somebody in the school without going through a link.

    Used where the test is about what happens NEXT (a removal, a
    transfer): joining by token would write a member_joined of its own and
    the assertions would have to step around it.
    """
    db_session.add(
        CuratorGroupMember(
            group_id=UUID(group_id),
            user_id=UUID(auth["user"]["id"]),
            kind=kind,
        )
    )
    await db_session.commit()


async def _journal(
    client: AsyncClient, curator: dict, group_id: str, **params,
):
    return await client.get(
        JOURNAL_URL.format(group_id=group_id),
        params=params or None,
        headers=auth_headers(curator["session_token"]),
    )


async def _events(
    client: AsyncClient, curator: dict, group_id: str,
) -> list[dict]:
    """The whole feed, newest first, asserted 200 on the way through."""
    resp = await _journal(client, curator, group_id, limit=100)
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


async def _kinds(
    client: AsyncClient, curator: dict, group_id: str,
) -> list[str]:
    return [e["event"] for e in await _events(client, curator, group_id)]


async def _row_count(group_id: str) -> int:
    """Journal rows straight from the database, bypassing the endpoint.

    Used where the claim is "nothing was written": going through the
    endpoint would also pass if the endpoint were filtering rows out.
    """
    return (
        await fresh_execute(
            select(func.count())
            .select_from(CuratorGroupEvent)
            .where(CuratorGroupEvent.group_id == UUID(group_id))
        )
    ).scalar_one()


async def _make_admin(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
) -> str:
    auth = await login_user(client, telegram_id=telegram_id, first_name="Admin")
    await db_session.execute(
        update(User)
        .where(User.id == UUID(auth["user"]["id"]))
        .values(role=UserRole.ADMIN.value)
    )
    await db_session.commit()
    return auth["session_token"]


# ===========================================================================
# Cleanup
# ===========================================================================


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(
        db_session, _TID_MIN, _TID_MAX, delete_users=True,
    )
    await db_session.commit()
    yield
    await full_cleanup_range(
        db_session, _TID_MIN, _TID_MAX, delete_users=True,
    )
    await db_session.commit()


# ===========================================================================
# Reading -- shape, emptiness, ownership
# ===========================================================================


@pytest.mark.asyncio
async def test_a_new_school_has_a_journal_with_one_entry_in_it(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Creating the school is itself the first event.

    Asserted on the full item shape rather than just the count, because
    this is the one test that fixes the contract every other one reads
    through: id, event, actor as an OBJECT (not a bare id), data, and a
    timestamp. actor.display_name is the name frozen at write time, which
    is why it can be compared against what the fixture set.
    """
    curator = await _make_verified_master(
        client, db_session, _TID_CURATOR, first_name="Мария",
    )
    group_id = await _make_group(client, curator)

    resp = await _journal(client, curator, group_id)
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["total"] == 1
    assert body["limit"] == 20
    assert body["offset"] == 0
    assert len(body["items"]) == 1

    item = body["items"][0]
    assert item["event"] == CuratorGroupEventKind.GROUP_CREATED.value
    assert item["actor"]["user_id"] == curator["user"]["id"]
    assert item["actor"]["display_name"] == "Мария"
    assert item["data"] == {"actor_name": "Мария"}
    assert UUID(item["id"])
    assert item["created_at"]


@pytest.mark.asyncio
async def test_a_school_whose_only_event_was_pruned_reads_empty_not_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """An empty feed is 200 with total 0, never a 404.

    A school with no events is a normal school, so the emptiness has to be
    reachable to test: the group_created row is deleted directly, which is
    the only way to get there. Paired with a positive half -- the school
    itself still answers on its own endpoint -- so "empty" cannot be
    produced by the school having gone missing.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group_id = await _make_group(client, curator)

    await db_session.execute(
        CuratorGroupEvent.__table__.delete().where(
            CuratorGroupEvent.group_id == UUID(group_id)
        )
    )
    await db_session.commit()

    resp = await _journal(client, curator, group_id)
    assert resp.status_code == 200, resp.text
    assert resp.json()["items"] == []
    assert resp.json()["total"] == 0

    page = await client.get(
        PAGE_URL.format(group_id=group_id),
        headers=auth_headers(curator["session_token"]),
    )
    assert page.status_code == 200


@pytest.mark.asyncio
async def test_only_the_curator_reads_the_journal(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A master member, a student and an outsider all get 404.

    404 and not 403, the shape every curator endpoint uses: 403 would
    confirm to a stranger that the school exists. All three are in one
    test because the interesting claim is that MEMBERSHIP DOES NOT HELP --
    the master and the student are inside the school and still cannot
    read it, which a test using only an outsider would not show.

    The curator's own 200 is asserted last so that "404" cannot come from
    a wrong URL or a missing route.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    member = await _make_verified_master(client, db_session, _TID_MASTER_B)
    student = await login_user(client, telegram_id=_TID_STUDENT)
    outsider = await login_user(client, telegram_id=_TID_OUTSIDER)
    group_id = await _make_group(client, curator)

    await _seed_member(
        db_session, group_id, member, CuratorMemberKind.MASTER.value,
    )
    await _seed_member(
        db_session, group_id, student, CuratorMemberKind.STUDENT.value,
    )

    for auth in (member, student, outsider):
        resp = await _journal(client, auth, group_id)
        assert resp.status_code == 404, resp.text

    assert (await _journal(client, curator, group_id)).status_code == 200


@pytest.mark.asyncio
async def test_the_journal_of_a_group_that_is_not_mine_is_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Another curator's school, and an id belonging to nobody.

    Both are included because they reach 404 by different routes -- one
    row exists and is owned by someone else, the other does not exist at
    all -- and an ownership check that handled only one of them would
    still pass a single-case test.
    """
    mine = await _make_verified_master(client, db_session, _TID_CURATOR)
    theirs = await _make_verified_master(client, db_session, _TID_HEIR)
    their_group = await _make_group(client, theirs, name="Их школа")

    for group_id in (their_group, str(uuid4())):
        resp = await _journal(client, mine, group_id)
        assert resp.status_code == 404, resp.text


@pytest.mark.asyncio
async def test_a_malformed_group_id_is_422_not_500(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """FastAPI rejects the path parameter before the service is reached."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)

    resp = await client.get(
        JOURNAL_URL.format(group_id="not-a-uuid"),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 422


# ===========================================================================
# Order and pagination
# ===========================================================================


@pytest.mark.asyncio
async def test_three_single_row_pages_neither_repeat_nor_lose_anything(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Walked one row at a time, the feed yields each event exactly once.

    THE POINT IS THE UNION, not the individual pages: pagination breaks by
    repeating a row on two pages or dropping one between them, and both
    failures are invisible to a test that checks page contents against an
    expected order. Three distinct ids whose set has size three is the
    assertion that catches either.

    Ordering here is by seq, which is why this is stable at all. Two of
    these three events are written by ONE request (the PATCH below changes
    name and description together) and therefore share created_at to the
    byte -- under an ORDER BY created_at with a uuid tie-break their
    relative order would be arbitrary and this test would flake.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group_id = await _make_group(client, curator)

    patched = await client.patch(
        GROUP_URL.format(group_id=group_id),
        json={"name": "Тихое утро", "description": "Мягкие практики"},
        headers=auth_headers(curator["session_token"]),
    )
    assert patched.status_code == 200, patched.text

    total = (await _journal(client, curator, group_id)).json()["total"]
    assert total == 3

    seen: list[str] = []
    for offset in (0, 1, 2):
        resp = await _journal(client, curator, group_id, limit=1, offset=offset)
        assert resp.status_code == 200, resp.text
        assert resp.json()["total"] == 3
        assert len(resp.json()["items"]) == 1
        seen.append(resp.json()["items"][0]["id"])

    assert len(set(seen)) == 3


@pytest.mark.asyncio
async def test_the_newest_event_is_first_and_the_oldest_is_last(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Newest first, like every list in the project.

    Asserted against events from THREE separate requests, so the order
    under test is the order things happened rather than the order rows
    were inserted inside one statement.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group_id = await _make_group(client, curator)

    for name in ("Второе имя", "Третье имя"):
        resp = await client.patch(
            GROUP_URL.format(group_id=group_id),
            json={"name": name},
            headers=auth_headers(curator["session_token"]),
        )
        assert resp.status_code == 200, resp.text

    kinds = await _kinds(client, curator, group_id)
    assert kinds == [
        CuratorGroupEventKind.GROUP_RENAMED.value,
        CuratorGroupEventKind.GROUP_RENAMED.value,
        CuratorGroupEventKind.GROUP_CREATED.value,
    ]

    items = await _events(client, curator, group_id)
    assert items[0]["data"]["new_name"] == "Третье имя"
    assert items[1]["data"]["new_name"] == "Второе имя"


@pytest.mark.asyncio
async def test_an_offset_past_the_end_is_an_empty_page_with_a_real_total(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """items empty, total unchanged -- not a 404 and not total 0.

    The pair is the claim: an empty `items` beside a non-zero `total` is
    what tells a client it has walked off the end rather than found an
    empty school.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group_id = await _make_group(client, curator)

    resp = await _journal(client, curator, group_id, limit=20, offset=50)
    assert resp.status_code == 200, resp.text
    assert resp.json()["items"] == []
    assert resp.json()["total"] == 1


@pytest.mark.asyncio
async def test_the_ordering_column_is_not_exposed(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """`seq` never appears in the response, in any item.

    Deliberate and worth a test of its own: seq is monotonic across every
    school on the platform, so handing it to one curator would hand them a
    counter of everybody else's activity. Paired with "and the fields that
    SHOULD be there are" -- otherwise this passes on an empty payload.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group_id = await _make_group(client, curator)

    item = (await _events(client, curator, group_id))[0]
    assert "seq" not in item
    assert set(item) == {"id", "event", "actor", "data", "created_at"}


# ===========================================================================
# The rollback twin -- why the write is synchronous
# ===========================================================================


@pytest.mark.asyncio
async def test_an_action_that_fails_leaves_no_event_behind(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A 409 on a duplicate school name writes neither a school nor a line.

    THIS IS THE TWIN FOR WRITING SYNCHRONOUSLY. An event recorded outside
    the action's transaction would survive this rollback and the journal
    would report a school that was never created -- worse than no journal,
    because the reader has no way to tell which entries to distrust.

    Counted in the database rather than through the endpoint: the claim is
    that no ROW exists, and a filtering endpoint would hide a row that
    does.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    first = await _make_group(client, curator, name="Тихое утро")

    clash = await client.post(
        GROUPS_URL,
        json={"name": "Тихое утро"},
        headers=auth_headers(curator["session_token"]),
    )
    assert clash.status_code == 409, clash.text

    groups = (
        await fresh_execute(
            select(func.count())
            .select_from(CuratorGroup)
            .where(
                CuratorGroup.curator_user_id == UUID(curator["user"]["id"])
            )
        )
    ).scalar_one()
    assert groups == 1

    events = (
        await fresh_execute(
            select(func.count()).select_from(CuratorGroupEvent)
        )
    ).scalar_one()
    assert events == 1
    assert await _row_count(first) == 1


# ===========================================================================
# Idempotent no-ops write nothing -- what RETURNING bought
# ===========================================================================


@pytest.mark.asyncio
async def test_removing_the_same_member_twice_records_one_removal(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Both calls answer 204; only the first is news.

    The second DELETE finds no row, and a helper that recorded on
    `rowcount`-less faith would write "member removed" for somebody who
    was already gone. The event also carries the member's KIND, which
    exists ONLY in the row being deleted -- so this asserts the value that
    RETURNING is there to rescue.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(
        client, telegram_id=_TID_STUDENT, first_name="Пётр",
    )
    group_id = await _make_group(client, curator)
    await _seed_member(
        db_session, group_id, student, CuratorMemberKind.STUDENT.value,
    )

    url = MEMBER_URL.format(
        group_id=group_id, user_id=student["user"]["id"],
    )
    for _ in range(2):
        resp = await client.delete(
            url, headers=auth_headers(curator["session_token"]),
        )
        assert resp.status_code == 204, resp.text

    removals = [
        e
        for e in await _events(client, curator, group_id)
        if e["event"] == CuratorGroupEventKind.MEMBER_REMOVED.value
    ]
    assert len(removals) == 1
    assert removals[0]["data"]["kind"] == CuratorMemberKind.STUDENT.value
    assert removals[0]["data"]["target_user_id"] == student["user"]["id"]
    assert removals[0]["data"]["target_name"] == "Пётр"


@pytest.mark.asyncio
async def test_removing_somebody_who_was_never_a_member_records_nothing(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """204, and the feed still holds only the creation event.

    Different from the test above: there was never a row at all, so the
    "no second event" claim cannot be satisfied by a first one having
    consumed it. Paired with a count of what IS there, so "nothing was
    added" is not the same assertion as "the feed is broken".
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    outsider = await login_user(client, telegram_id=_TID_OUTSIDER)
    group_id = await _make_group(client, curator)

    resp = await client.delete(
        MEMBER_URL.format(
            group_id=group_id, user_id=outsider["user"]["id"],
        ),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 204, resp.text

    assert await _kinds(client, curator, group_id) == [
        CuratorGroupEventKind.GROUP_CREATED.value
    ]


@pytest.mark.asyncio
async def test_leaving_a_school_you_were_never_in_records_nothing(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """204 for the caller, one entry in the feed.

    leave_curator_group deletes blind for the same reason remove does, and
    the same no-op rule applies -- but through a different endpoint and a
    different actor, so it is a separate hole to close.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    outsider = await login_user(client, telegram_id=_TID_OUTSIDER)
    group_id = await _make_group(client, curator)

    resp = await client.delete(
        LEAVE_URL.format(group_id=group_id),
        headers=auth_headers(outsider["session_token"]),
    )
    assert resp.status_code == 204, resp.text

    assert await _row_count(group_id) == 1


@pytest.mark.asyncio
async def test_pressing_invite_twice_mints_one_link_and_records_one_event(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Create-or-return means the second press is not news.

    Both calls return the SAME token -- asserted, because "one event" would
    also be true if the second call had failed. And the event records the
    link's KIND and nothing else: the token is a raw secret and the
    journal is a readable list, so the test states positively that no
    field of the entry contains it.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group_id = await _make_group(client, curator)

    first = await _invite(
        client, curator, group_id, CuratorMemberKind.STUDENT.value,
    )
    second = await _invite(
        client, curator, group_id, CuratorMemberKind.STUDENT.value,
    )
    assert first == second

    created = [
        e
        for e in await _events(client, curator, group_id)
        if e["event"] == CuratorGroupEventKind.INVITE_CREATED.value
    ]
    assert len(created) == 1
    assert created[0]["data"]["kind"] == CuratorMemberKind.STUDENT.value
    assert first not in str(created[0])


@pytest.mark.asyncio
async def test_revoking_a_link_is_recorded_and_revoking_nothing_is_not(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The link that existed is news; the one that never did is not.

    Two kinds in one test on purpose: student links are minted here and
    master links are not, so revoking the master kind exercises the
    never-existed path against the same school, in the same feed, with the
    same curator. A test that only revoked the live link would leave the
    no-op branch uncovered.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group_id = await _make_group(client, curator)
    await _invite(client, curator, group_id, CuratorMemberKind.STUDENT.value)

    for kind in (
        CuratorMemberKind.MASTER.value,
        CuratorMemberKind.STUDENT.value,
    ):
        resp = await client.delete(
            INVITE_KIND_URL.format(group_id=group_id, kind=kind),
            headers=auth_headers(curator["session_token"]),
        )
        assert resp.status_code == 204, resp.text

    revoked = [
        e
        for e in await _events(client, curator, group_id)
        if e["event"] == CuratorGroupEventKind.INVITE_REVOKED.value
    ]
    assert len(revoked) == 1
    assert revoked[0]["data"]["kind"] == CuratorMemberKind.STUDENT.value


@pytest.mark.asyncio
async def test_renaming_to_the_current_name_records_nothing(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A PATCH that changes no field writes no event.

    Two separate claims, and both matter: a rename to the same name and a
    description set to the value it already holds. Either one written
    unconditionally would fill a feed with entries saying nothing changed.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group_id = await _make_group(client, curator, name="Тихое утро")

    first = await client.patch(
        GROUP_URL.format(group_id=group_id),
        json={"name": "Тихое утро", "description": "Мягкие практики"},
        headers=auth_headers(curator["session_token"]),
    )
    assert first.status_code == 200, first.text
    assert await _kinds(client, curator, group_id) == [
        CuratorGroupEventKind.GROUP_DESCRIPTION_CHANGED.value,
        CuratorGroupEventKind.GROUP_CREATED.value,
    ]

    again = await client.patch(
        GROUP_URL.format(group_id=group_id),
        json={"name": "Тихое утро", "description": "Мягкие практики"},
        headers=auth_headers(curator["session_token"]),
    )
    assert again.status_code == 200, again.text
    assert await _row_count(group_id) == 2


@pytest.mark.asyncio
async def test_a_rename_and_a_description_edit_are_two_separate_events(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """One PATCH, two entries, each naming what it changed.

    Not one "group updated": a rename may be worth telling members about
    and a description edit is not, and a combined event would force that
    decision to be re-derived from `data` by whoever builds notifications.
    The rename carries both the old and the new name -- the old one exists
    nowhere else once the row is written.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group_id = await _make_group(client, curator, name="Старое имя")

    resp = await client.patch(
        GROUP_URL.format(group_id=group_id),
        json={"name": "Новое имя", "description": "Описание"},
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 200, resp.text

    items = await _events(client, curator, group_id)
    kinds = [e["event"] for e in items]
    assert kinds.count(CuratorGroupEventKind.GROUP_RENAMED.value) == 1
    assert (
        kinds.count(CuratorGroupEventKind.GROUP_DESCRIPTION_CHANGED.value)
        == 1
    )

    renamed = next(
        e
        for e in items
        if e["event"] == CuratorGroupEventKind.GROUP_RENAMED.value
    )
    assert renamed["data"]["old_name"] == "Старое имя"
    assert renamed["data"]["new_name"] == "Новое имя"


# ===========================================================================
# Joining, promotion, leaving
# ===========================================================================


@pytest.mark.asyncio
async def test_joining_by_a_master_link_is_one_arrival_not_a_promotion(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A newcomer using a master link writes member_joined ONCE.

    Not member_joined followed by member_promoted: nobody was promoted,
    they arrived as a master. The kind is asserted on the entry, so the
    "once" cannot be satisfied by writing the wrong single event.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    joiner = await _make_verified_master(client, db_session, _TID_MASTER_B)
    group_id = await _make_group(client, curator)

    token = await _invite(
        client, curator, group_id, CuratorMemberKind.MASTER.value,
    )
    resp = await _join(client, joiner, token)
    assert resp.status_code == 200, resp.text

    kinds = await _kinds(client, curator, group_id)
    assert kinds.count(CuratorGroupEventKind.MEMBER_JOINED.value) == 1
    assert CuratorGroupEventKind.MEMBER_PROMOTED.value not in kinds

    joined = next(
        e
        for e in await _events(client, curator, group_id)
        if e["event"] == CuratorGroupEventKind.MEMBER_JOINED.value
    )
    assert joined["data"]["kind"] == CuratorMemberKind.MASTER.value
    assert joined["actor"]["user_id"] == joiner["user"]["id"]


@pytest.mark.asyncio
async def test_a_student_upgraded_by_a_master_link_is_promoted_not_joined(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Student first, then a master link: exactly one promotion, no arrival.

    And pressing the master link a THIRD time writes nothing at all -- the
    upgrade already happened, so idempotence in the endpoint has to mean
    idempotence in the feed or the same link would fill it.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    joiner = await _make_verified_master(client, db_session, _TID_MASTER_B)
    group_id = await _make_group(client, curator)

    student_token = await _invite(
        client, curator, group_id, CuratorMemberKind.STUDENT.value,
    )
    assert (await _join(client, joiner, student_token)).status_code == 200

    master_token = await _invite(
        client, curator, group_id, CuratorMemberKind.MASTER.value,
    )
    assert (await _join(client, joiner, master_token)).status_code == 200

    kinds = await _kinds(client, curator, group_id)
    assert kinds.count(CuratorGroupEventKind.MEMBER_JOINED.value) == 1
    assert kinds.count(CuratorGroupEventKind.MEMBER_PROMOTED.value) == 1

    before = await _row_count(group_id)
    assert (await _join(client, joiner, master_token)).status_code == 200
    assert await _row_count(group_id) == before


@pytest.mark.asyncio
async def test_a_member_joining_and_leaving_leaves_both_records_intact(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Two entries survive together; the departure does not erase the arrival.

    The whole point of the journal: the membership row is gone after the
    exit, and without these two entries there would be no trace that the
    person was ever there. Asserted on the actor of each, so a feed that
    kept two rows about the wrong people would still fail.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(
        client, telegram_id=_TID_STUDENT, first_name="Нина",
    )
    group_id = await _make_group(client, curator)

    token = await _invite(
        client, curator, group_id, CuratorMemberKind.STUDENT.value,
    )
    assert (await _join(client, student, token)).status_code == 200

    left = await client.delete(
        LEAVE_URL.format(group_id=group_id),
        headers=auth_headers(student["session_token"]),
    )
    assert left.status_code == 204, left.text

    members = (
        await fresh_execute(
            select(func.count())
            .select_from(CuratorGroupMember)
            .where(CuratorGroupMember.group_id == UUID(group_id))
        )
    ).scalar_one()
    assert members == 0

    items = await _events(client, curator, group_id)
    by_kind = {e["event"]: e for e in items}
    assert (
        by_kind[CuratorGroupEventKind.MEMBER_LEFT.value]["actor"]["user_id"]
        == student["user"]["id"]
    )
    assert (
        by_kind[CuratorGroupEventKind.MEMBER_JOINED.value]["actor"]["user_id"]
        == student["user"]["id"]
    )
    assert (
        by_kind[CuratorGroupEventKind.MEMBER_LEFT.value]["data"]["kind"]
        == CuratorMemberKind.STUDENT.value
    )


# ===========================================================================
# Transfers -- where actor and target are different people
# ===========================================================================


@pytest.mark.asyncio
async def test_accepting_a_transfer_records_two_different_people(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The actor is the new curator, the target is the PREVIOUS one.

    THIS TEST EXISTS TO CATCH ONE REORDERING. By the time the event is
    written the group already belongs to the actor, so recording "the
    group's curator" as the target -- or moving the record above the
    capture of previous_curator_id -- produces "Пётр принял школу от
    Петра". A test asserting only that transfer_accepted was written
    passes that bug.

    Both ids AND both names are asserted, and the two people are given
    different first names by the fixtures so a swap cannot hide behind
    equal strings.
    """
    curator = await _make_verified_master(
        client, db_session, _TID_CURATOR, first_name="Мария",
    )
    heir = await _make_verified_master(
        client, db_session, _TID_HEIR, first_name="Пётр",
    )
    group_id = await _make_group(client, curator)
    await _seed_member(
        db_session, group_id, heir, CuratorMemberKind.MASTER.value,
    )

    offered = await client.post(
        OFFER_URL.format(group_id=group_id),
        json={"to_user_id": heir["user"]["id"]},
        headers=auth_headers(curator["session_token"]),
    )
    assert offered.status_code == 200, offered.text

    accepted = await client.post(
        ACCEPT_URL.format(group_id=group_id),
        headers=auth_headers(heir["session_token"]),
    )
    assert accepted.status_code == 200, accepted.text

    # Read as the NEW curator: the old one is not the owner any more.
    event = next(
        e
        for e in await _events(client, heir, group_id)
        if e["event"] == CuratorGroupEventKind.TRANSFER_ACCEPTED.value
    )
    assert event["actor"]["user_id"] == heir["user"]["id"]
    assert event["actor"]["display_name"] == "Пётр"
    assert event["data"]["target_user_id"] == curator["user"]["id"]
    assert event["data"]["target_name"] == "Мария"
    assert event["actor"]["user_id"] != event["data"]["target_user_id"]


@pytest.mark.asyncio
async def test_the_new_curator_inherits_the_whole_history(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Every entry written under the previous owner is still readable.

    A DECISION, not a side effect of the row hanging off group_id: a
    school is handed over WITH its history, because an owner who cannot
    see what they inherited cannot run it. The inherited feed here
    includes a removal the previous curator performed -- the kind of entry
    a new owner most needs and would most obviously be missing.

    The other half is asserted too: the FORMER curator can no longer read
    it, because they are no longer the owner.
    """
    curator = await _make_verified_master(
        client, db_session, _TID_CURATOR, first_name="Мария",
    )
    heir = await _make_verified_master(client, db_session, _TID_HEIR)
    student = await login_user(client, telegram_id=_TID_STUDENT)
    group_id = await _make_group(client, curator)

    await _seed_member(
        db_session, group_id, heir, CuratorMemberKind.MASTER.value,
    )
    await _seed_member(
        db_session, group_id, student, CuratorMemberKind.STUDENT.value,
    )

    removed = await client.delete(
        MEMBER_URL.format(
            group_id=group_id, user_id=student["user"]["id"],
        ),
        headers=auth_headers(curator["session_token"]),
    )
    assert removed.status_code == 204, removed.text
    before = await _kinds(client, curator, group_id)

    offered = await client.post(
        OFFER_URL.format(group_id=group_id),
        json={"to_user_id": heir["user"]["id"]},
        headers=auth_headers(curator["session_token"]),
    )
    assert offered.status_code == 200, offered.text
    accepted = await client.post(
        ACCEPT_URL.format(group_id=group_id),
        headers=auth_headers(heir["session_token"]),
    )
    assert accepted.status_code == 200, accepted.text

    inherited = await _kinds(client, heir, group_id)
    assert CuratorGroupEventKind.MEMBER_REMOVED.value in inherited
    for kind in before:
        assert kind in inherited

    former = await _journal(client, curator, group_id)
    assert former.status_code == 404


@pytest.mark.asyncio
async def test_declining_an_offer_names_the_curator_who_made_it(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The decliner is the actor; the target is the curator who offered.

    curator_group_transfer has no from_user_id -- whoever offered is
    IMPLICITLY the group's curator -- so this entry's target cannot be read
    out of the row being deleted, and the service pays one SELECT for it.
    Asserting the target here is what proves that SELECT happens and
    fetches the right person.

    The feed is read by the curator because declining does not change who
    owns the school.
    """
    curator = await _make_verified_master(
        client, db_session, _TID_CURATOR, first_name="Мария",
    )
    heir = await _make_verified_master(
        client, db_session, _TID_HEIR, first_name="Пётр",
    )
    group_id = await _make_group(client, curator)
    await _seed_member(
        db_session, group_id, heir, CuratorMemberKind.MASTER.value,
    )

    offered = await client.post(
        OFFER_URL.format(group_id=group_id),
        json={"to_user_id": heir["user"]["id"]},
        headers=auth_headers(curator["session_token"]),
    )
    assert offered.status_code == 200, offered.text

    declined = await client.post(
        DECLINE_URL.format(group_id=group_id),
        headers=auth_headers(heir["session_token"]),
    )
    assert declined.status_code == 204, declined.text

    items = await _events(client, curator, group_id)
    event = next(
        e
        for e in items
        if e["event"] == CuratorGroupEventKind.TRANSFER_DECLINED.value
    )
    assert event["actor"]["user_id"] == heir["user"]["id"]
    assert event["data"]["target_user_id"] == curator["user"]["id"]
    assert event["data"]["target_name"] == "Мария"

    offer_event = next(
        e
        for e in items
        if e["event"] == CuratorGroupEventKind.TRANSFER_OFFERED.value
    )
    assert offer_event["data"]["target_user_id"] == heir["user"]["id"]
    assert offer_event["data"]["target_name"] == "Пётр"


@pytest.mark.asyncio
async def test_declining_an_offer_that_was_never_made_records_nothing(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """204 for the caller, nothing added to the feed.

    Decline answers 204 rather than 404 precisely because it changes
    nothing, and the journal has to agree with that: an entry here would
    let anybody write into somebody else's feed by declining offers that
    do not exist.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    outsider = await _make_verified_master(client, db_session, _TID_HEIR)
    group_id = await _make_group(client, curator)

    resp = await client.post(
        DECLINE_URL.format(group_id=group_id),
        headers=auth_headers(outsider["session_token"]),
    )
    assert resp.status_code == 204, resp.text

    assert await _row_count(group_id) == 1


@pytest.mark.asyncio
async def test_cancelling_an_offer_is_recorded_and_cancelling_nothing_is_not(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The withdrawn offer names its addressee; a second withdrawal is silent.

    RETURNING carries the addressee out of the row being deleted -- after
    the DELETE nothing remembers who the offer was for. Both calls answer
    204, so the difference is only visible in the feed.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    heir = await _make_verified_master(
        client, db_session, _TID_HEIR, first_name="Пётр",
    )
    group_id = await _make_group(client, curator)
    await _seed_member(
        db_session, group_id, heir, CuratorMemberKind.MASTER.value,
    )

    offered = await client.post(
        OFFER_URL.format(group_id=group_id),
        json={"to_user_id": heir["user"]["id"]},
        headers=auth_headers(curator["session_token"]),
    )
    assert offered.status_code == 200, offered.text

    url = OFFER_URL.format(group_id=group_id)
    for _ in range(2):
        resp = await client.delete(
            url, headers=auth_headers(curator["session_token"]),
        )
        assert resp.status_code == 204, resp.text

    cancelled = [
        e
        for e in await _events(client, curator, group_id)
        if e["event"] == CuratorGroupEventKind.TRANSFER_CANCELLED.value
    ]
    assert len(cancelled) == 1
    assert cancelled[0]["data"]["target_user_id"] == heir["user"]["id"]
    assert cancelled[0]["data"]["target_name"] == "Пётр"


@pytest.mark.asyncio
async def test_a_departure_that_retracts_an_offer_says_so_in_one_event(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The retraction rides on the departure; it is not an event of its own.

    Removing the person you offered the school to cancels the offer in the
    same transaction. That retraction has NO ACTOR -- nobody cancelled it,
    it stopped having an addressee -- so it belongs inside the departure's
    record rather than beside it. Asserted both ways: the flag is on the
    removal, and no transfer_cancelled entry was written.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    heir = await _make_verified_master(client, db_session, _TID_HEIR)
    group_id = await _make_group(client, curator)
    await _seed_member(
        db_session, group_id, heir, CuratorMemberKind.MASTER.value,
    )

    offered = await client.post(
        OFFER_URL.format(group_id=group_id),
        json={"to_user_id": heir["user"]["id"]},
        headers=auth_headers(curator["session_token"]),
    )
    assert offered.status_code == 200, offered.text

    removed = await client.delete(
        MEMBER_URL.format(group_id=group_id, user_id=heir["user"]["id"]),
        headers=auth_headers(curator["session_token"]),
    )
    assert removed.status_code == 204, removed.text

    items = await _events(client, curator, group_id)
    kinds = [e["event"] for e in items]
    assert CuratorGroupEventKind.TRANSFER_CANCELLED.value not in kinds

    removal = next(
        e
        for e in items
        if e["event"] == CuratorGroupEventKind.MEMBER_REMOVED.value
    )
    assert removal["data"]["transfer_cancelled"] is True


# ===========================================================================
# Survival -- the actor, and the school
# ===========================================================================


@pytest.mark.asyncio
async def test_an_entry_outlives_the_person_who_made_it(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The student is deleted from the system; the entry keeps their name.

    actor_id carries NO foreign key, deliberately, so deleting a user
    neither drops the row nor nulls the column -- and the name was frozen
    into `data` when the thing happened. This is the test that would fail
    if somebody "fixed" the missing FK, and the one that would fail if the
    read joined users instead of reading the row.

    Read after the user is gone, and the id is still there: an entry that
    kept the name but lost the id would be half a record.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(
        client, telegram_id=_TID_STUDENT, first_name="Нина",
    )
    group_id = await _make_group(client, curator)

    token = await _invite(
        client, curator, group_id, CuratorMemberKind.STUDENT.value,
    )
    assert (await _join(client, student, token)).status_code == 200
    student_id = student["user"]["id"]

    await db_session.execute(
        User.__table__.delete().where(User.id == UUID(student_id))
    )
    await db_session.commit()

    joined = next(
        e
        for e in await _events(client, curator, group_id)
        if e["event"] == CuratorGroupEventKind.MEMBER_JOINED.value
    )
    assert joined["actor"]["user_id"] == student_id
    assert joined["actor"]["display_name"] == "Нина"


@pytest.mark.asyncio
async def test_deleting_the_school_takes_its_journal_with_it(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Counted on live data, not read off the DDL.

    The cascade is the reason this table is not audit_logs, so it is
    asserted by making rows and watching them go: audit_logs has no ON
    DELETE and must not have one, while this journal's whole lifetime is
    the school's.

    A SECOND school is created and left alone -- otherwise "zero rows
    afterwards" would also pass if the DELETE had emptied the table.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    doomed = await _make_group(client, curator, name="Уходит")
    kept = await _make_group(client, curator, name="Остаётся")

    await _invite(client, curator, doomed, CuratorMemberKind.STUDENT.value)
    assert await _row_count(doomed) == 2
    assert await _row_count(kept) == 1

    resp = await client.delete(
        GROUP_URL.format(group_id=doomed),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 204, resp.text

    assert await _row_count(doomed) == 0
    assert await _row_count(kept) == 1


@pytest.mark.asyncio
async def test_a_suspended_curator_cannot_read_but_their_entries_survive(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Revoking the master blocks the endpoint and touches no row.

    get_current_master refuses before the journal is reached, so the 403
    says nothing about the school. The rows are then counted straight from
    the database -- through the endpoint they would be unreachable, and
    "unreachable" is not "gone".
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group_id = await _make_group(client, curator)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)

    before = await _row_count(group_id)
    assert before == 1

    revoked = await client.post(
        f"/api/v1/admin/masters/{curator['user']['id']}/revoke",
        headers=auth_headers(admin_token),
    )
    assert revoked.status_code == 200, revoked.text

    blocked = await _journal(client, curator, group_id)
    assert blocked.status_code == 403

    assert await _row_count(group_id) == before
