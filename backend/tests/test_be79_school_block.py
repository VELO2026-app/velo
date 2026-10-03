# =============================================================================
# VELO Backend -- Tests: a curator blocks a member of the school (BE-79, 1a)
# =============================================================================
#
# telegram_id band: 70800-70849 (curator 70801, a second curator 70802,
# masters 70803-70804, students 70810-70813). Declared module-level below as
# _TID_MIN/_TID_MAX, ONCE -- tests/telegram_id_bands.py parses it. Checked
# free on 229f2f8: free_windows(space=(70000, 72999)) returned (70800, 70849).
#
# WHAT A BLOCK IS. The membership row is DELETED and a curator_group_block
# row carrying its kind and joined_at takes its place, in one transaction;
# an unblock swaps them back. So every assertion about "the person is not in
# the school" is an assertion about a missing member row, and every one is
# paired here with the block row that must be there instead -- "no member
# row" alone is just as true of somebody who left.
#
# THIS DELIVERY (1a) covers the swap itself, the door (join by link and its
# preview), the curator's list, the journal and the notifications. Access to
# the school's PUBLIC practices, the cancellation of bookings and the blocked
# master's edits are delivery 1b; what a blocked person loses through the
# member row alone ("my schools", the roster) is asserted here because it
# comes with the swap, not with any new check.
#
# THE RACES use tests/curator_race_harness.py: the holder is paused at a
# named call inside its window, the rival runs into it, and Postgres --
# not a sleep -- says whether the rival waited. Each race asserts the ONE
# invariant the code promises: a member row and a block row of one person
# never both exist, and no transaction died in a deadlock.
# =============================================================================

import asyncio
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from unittest.mock import patch
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_session_factory
from app.core.events.models import OutboxEvent
from app.modules.curator_groups import service as curator_service
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupBlock,
    CuratorGroupEvent,
    CuratorGroupEventKind,
    CuratorGroupMember,
    CuratorGroupTransfer,
    CuratorMemberKind,
)
from app.modules.masters.models import MasterProfile
from app.modules.users.models import User, UserRole
from tests.curator_race_harness import race
from tests.helpers import auth_headers, fresh_execute, full_cleanup_range, login_user

GROUPS_URL = "/api/v1/masters/me/curator-groups"
INVITES_URL = "/api/v1/masters/me/curator-groups/{group_id}/invites"
PREVIEW_URL = "/api/v1/curator-groups/invites/{token}"
JOIN_URL = "/api/v1/curator-groups/join"
MINE_URL = "/api/v1/curator-groups/mine"
MEMBERS_URL = "/api/v1/masters/me/curator-groups/{group_id}/members"
BLOCK_URL = "/api/v1/masters/me/curator-groups/{group_id}/members/{user_id}/block"
UNBLOCK_URL = "/api/v1/masters/me/curator-groups/{group_id}/blocks/{user_id}"
BLOCKS_URL = "/api/v1/masters/me/curator-groups/{group_id}/blocks"

_BOT_URL = "https://t.me/velo_test_bot"
_DEEPLINK = "?startapp=curator_group_invite__"

_TID_MIN = 70800
_TID_MAX = 70849

_TID_CURATOR = 70801
_TID_CURATOR_B = 70802
_TID_MASTER = 70803
_TID_HEIR = 70804
_TID_STUDENT = 70810
_TID_STUDENT_B = 70811
_TID_STRANGER = 70812


# ===========================================================================
# Helpers -- copied, the convention of every curator test file
# ===========================================================================


async def _verified_master(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
) -> dict:
    auth = await login_user(client, telegram_id=telegram_id, first_name="M")
    user_id = UUID(auth["user"]["id"])
    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER
    db_session.add(
        MasterProfile(
            user_id=user_id,
            data={
                "account": {"status": "verified", "can_create_groups": True},
                "profile": {"bio": "m"},
            },
        )
    )
    await db_session.flush()
    await db_session.commit()
    return auth


async def _student(client: AsyncClient, telegram_id: int) -> dict:
    return await login_user(client, telegram_id=telegram_id, first_name="Аня")


def _h(auth: dict) -> dict:
    return auth_headers(auth["session_token"])


def _uid(auth: dict) -> UUID:
    return UUID(auth["user"]["id"])


async def _school(client: AsyncClient, curator: dict, name: str = "Школа") -> str:
    resp = await client.post(GROUPS_URL, json={"name": name}, headers=_h(curator))
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _token(client: AsyncClient, curator: dict, group_id: str) -> str:
    with patch.object(settings, "telegram_bot_url", _BOT_URL):
        resp = await client.post(
            INVITES_URL.format(group_id=group_id), json={}, headers=_h(curator),
        )
    assert resp.status_code == 200, resp.text
    return resp.json()["invite_url"].split(_DEEPLINK, 1)[1]


async def _join(client: AsyncClient, auth: dict, token: str):
    return await client.post(JOIN_URL, json={"token": token}, headers=_h(auth))


async def _seed_member(
    db_session: AsyncSession, group_id: str, auth: dict, kind: CuratorMemberKind,
    joined_at: datetime | None = None,
) -> None:
    row = CuratorGroupMember(
        group_id=UUID(group_id), user_id=_uid(auth), kind=kind.value,
    )
    if joined_at is not None:
        row.joined_at = joined_at
    db_session.add(row)
    await db_session.flush()
    await db_session.commit()


async def _block(client, curator, group_id, person):
    return await client.post(
        BLOCK_URL.format(group_id=group_id, user_id=person["user"]["id"]),
        headers=_h(curator),
    )


async def _unblock(client, curator, group_id, person):
    return await client.delete(
        UNBLOCK_URL.format(group_id=group_id, user_id=person["user"]["id"]),
        headers=_h(curator),
    )


async def _rows(group_id: str, person: dict) -> dict:
    """The two rows the invariant is about, read through a fresh session."""
    member = (
        await fresh_execute(
            select(CuratorGroupMember).where(
                CuratorGroupMember.group_id == UUID(group_id),
                CuratorGroupMember.user_id == _uid(person),
            )
        )
    ).scalar_one_or_none()
    block = (
        await fresh_execute(
            select(CuratorGroupBlock).where(
                CuratorGroupBlock.group_id == UUID(group_id),
                CuratorGroupBlock.user_id == _uid(person),
            )
        )
    ).scalar_one_or_none()
    return {"member": member, "block": block}


async def _journal(group_id: str) -> list[str]:
    rows = (
        await fresh_execute(
            select(CuratorGroupEvent.event).where(
                CuratorGroupEvent.group_id == UUID(group_id)
            )
        )
    ).all()
    return [e for (e,) in rows]


async def _types_for(person: dict) -> list[str]:
    rows = (
        await fresh_execute(
            select(OutboxEvent).where(
                OutboxEvent.payload["target_value"].astext == person["user"]["id"],
            )
        )
    ).scalars().all()
    return [(row.payload or {}).get("type", "") for row in rows]


async def _mine_ids(client: AsyncClient, auth: dict) -> list[str]:
    resp = await client.get(MINE_URL, headers=_h(auth))
    assert resp.status_code == 200, resp.text
    return [item["id"] for item in resp.json()["items"]]


async def _member_ids(client, curator, group_id) -> list[str]:
    resp = await client.get(
        MEMBERS_URL.format(group_id=group_id), headers=_h(curator),
        params={"limit": 100},
    )
    assert resp.status_code == 200, resp.text
    return [item["user_id"] for item in resp.json()["items"]]


async def _blocks(client, curator, group_id) -> dict:
    resp = await client.get(BLOCKS_URL.format(group_id=group_id), headers=_h(curator))
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ===========================================================================
# Block and unblock -- the swap
# ===========================================================================


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", [CuratorMemberKind.STUDENT, CuratorMemberKind.MASTER])
async def test_a_block_swaps_the_membership_for_a_block_and_an_unblock_swaps_it_back(
    client: AsyncClient, db_session: AsyncSession, kind: CuratorMemberKind,
) -> None:
    """Student and master alike: the row goes, the block keeps its kind and
    its joined_at, and an unblock restores exactly that -- the same
    relation from the same day. A second member stays put throughout."""
    curator = await _verified_master(client, db_session, _TID_CURATOR)
    person = (
        await _verified_master(client, db_session, _TID_MASTER)
        if kind is CuratorMemberKind.MASTER
        else await _student(client, _TID_STUDENT)
    )
    bystander = await _student(client, _TID_STUDENT_B)
    group_id = await _school(client, curator)
    joined = datetime.now(UTC) - timedelta(days=30)
    await _seed_member(db_session, group_id, person, kind, joined_at=joined)
    await _seed_member(db_session, group_id, bystander, CuratorMemberKind.STUDENT)

    resp = await _block(client, curator, group_id, person)
    assert resp.status_code == 204, resp.text

    rows = await _rows(group_id, person)
    assert rows["member"] is None
    assert rows["block"] is not None
    assert rows["block"].kind == kind.value
    assert rows["block"].joined_at == joined
    assert rows["block"].blocked_by_user_id == _uid(curator)
    members = await _member_ids(client, curator, group_id)
    assert person["user"]["id"] not in members
    assert bystander["user"]["id"] in members
    listed = await _blocks(client, curator, group_id)
    assert listed["total"] == 1
    assert [i["user_id"] for i in listed["items"]] == [person["user"]["id"]]
    assert listed["items"][0]["kind"] == kind.value

    resp = await _unblock(client, curator, group_id, person)
    assert resp.status_code == 204, resp.text

    rows = await _rows(group_id, person)
    assert rows["block"] is None
    assert rows["member"] is not None
    assert rows["member"].kind == kind.value
    assert rows["member"].joined_at == joined
    assert person["user"]["id"] in await _member_ids(client, curator, group_id)
    assert (await _blocks(client, curator, group_id))["items"] == []


@pytest.mark.asyncio
async def test_journal_and_notifications_follow_the_block_once(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """One member_blocked and one notification for a block; a second block
    of the same person is a 204 that writes neither. The unblock writes its
    own pair."""
    curator = await _verified_master(client, db_session, _TID_CURATOR)
    person = await _student(client, _TID_STUDENT)
    group_id = await _school(client, curator)
    await _seed_member(db_session, group_id, person, CuratorMemberKind.STUDENT)

    assert (await _block(client, curator, group_id, person)).status_code == 204
    assert (await _block(client, curator, group_id, person)).status_code == 204

    journal = await _journal(group_id)
    assert journal.count(CuratorGroupEventKind.MEMBER_BLOCKED.value) == 1
    types = await _types_for(person)
    assert types.count("curator_group.member_blocked") == 1
    assert "curator_group.member_unblocked" not in types

    assert (await _unblock(client, curator, group_id, person)).status_code == 204

    journal = await _journal(group_id)
    assert journal.count(CuratorGroupEventKind.MEMBER_UNBLOCKED.value) == 1
    assert (await _types_for(person)).count("curator_group.member_unblocked") == 1


@pytest.mark.asyncio
async def test_who_cannot_be_blocked_or_unblocked(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The curator -> 409 cannot_block_curator; a stranger -> 404; somebody
    else's school -> 404; unblocking a person who is not blocked -> 404.
    The pair: the same curator blocks a real member in the same breath."""
    curator = await _verified_master(client, db_session, _TID_CURATOR)
    other_curator = await _verified_master(client, db_session, _TID_CURATOR_B)
    member = await _student(client, _TID_STUDENT)
    stranger = await _student(client, _TID_STRANGER)
    group_id = await _school(client, curator)
    other_group = await _school(client, other_curator, "Чужая")
    await _seed_member(db_session, group_id, member, CuratorMemberKind.STUDENT)
    await _seed_member(db_session, other_group, stranger, CuratorMemberKind.STUDENT)

    own = await _block(client, curator, group_id, curator)
    assert own.status_code == 409, own.text
    assert own.json()["error"] == "cannot_block_curator"
    assert (await _block(client, curator, group_id, stranger)).status_code == 404
    assert (await _block(client, curator, other_group, stranger)).status_code == 404
    assert (await _unblock(client, curator, group_id, member)).status_code == 404
    assert (await _rows(other_group, stranger))["member"] is not None

    assert (await _block(client, curator, group_id, member)).status_code == 204
    assert (await _rows(group_id, member))["block"] is not None


# ===========================================================================
# The door: join by link, preview, "my schools"
# ===========================================================================


@pytest.mark.asyncio
async def test_a_blocked_person_cannot_come_back_by_the_link(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Joined by the link, blocked, then the link again: 403
    blocked_in_group, and the preview says why. A stranger holding the same
    link still joins -- the link works, it is the person who is refused.
    After an unblock the same person is a member and the preview says so."""
    curator = await _verified_master(client, db_session, _TID_CURATOR)
    person = await _student(client, _TID_STUDENT)
    stranger = await _student(client, _TID_STRANGER)
    group_id = await _school(client, curator)
    token = await _token(client, curator, group_id)
    assert (await _join(client, person, token)).status_code == 200
    assert (await _block(client, curator, group_id, person)).status_code == 204

    refused = await _join(client, person, token)
    assert refused.status_code == 403, refused.text
    assert refused.json()["error"] == "blocked_in_group"
    preview = await client.get(PREVIEW_URL.format(token=token), headers=_h(person))
    assert preview.status_code == 200, preview.text
    assert preview.json()["can_join"] is False
    assert preview.json()["reason"] == "blocked_in_group"
    rows = await _rows(group_id, person)
    assert rows["member"] is None and rows["block"] is not None

    assert (await _join(client, stranger, token)).status_code == 200
    assert (await _rows(group_id, stranger))["member"] is not None

    assert (await _unblock(client, curator, group_id, person)).status_code == 204
    preview = await client.get(PREVIEW_URL.format(token=token), headers=_h(person))
    assert preview.json()["reason"] == "already_member"


@pytest.mark.asyncio
async def test_my_schools_loses_the_blocked_school_and_keeps_the_others(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A curator of another school who is a member here: blocked here, this
    school leaves his "my schools", his own stays. Unblocked, it is back."""
    curator = await _verified_master(client, db_session, _TID_CURATOR)
    other_curator = await _verified_master(client, db_session, _TID_CURATOR_B)
    group_id = await _school(client, curator)
    own_group = await _school(client, other_curator, "Своя")
    await _seed_member(db_session, group_id, other_curator, CuratorMemberKind.MASTER)
    assert set(await _mine_ids(client, other_curator)) == {group_id, own_group}

    assert (await _block(client, curator, group_id, other_curator)).status_code == 204
    assert await _mine_ids(client, other_curator) == [own_group]

    assert (await _unblock(client, curator, group_id, other_curator)).status_code == 204
    assert set(await _mine_ids(client, other_curator)) == {group_id, own_group}


# ===========================================================================
# Races
# ===========================================================================


def _actor_call(fn, *args, actor_id: UUID, **kwargs):
    async def _call(session: AsyncSession) -> None:
        actor = await session.get(User, actor_id)
        await fn(*args, session, actor=actor, **kwargs)
    return _call


async def _block_call(curator: dict, group_id: str, person: dict):
    return _actor_call(
        curator_service.block_curator_group_member,
        _uid(curator), UUID(group_id), _uid(person),
        actor_id=_uid(curator),
    )


async def _assert_one_of_two(group_id: str, person: dict) -> dict:
    rows = await _rows(group_id, person)
    assert not (rows["member"] is not None and rows["block"] is not None), (
        "a member row and a block row of one person at once"
    )
    return rows


@pytest.mark.asyncio
async def test_k1_a_block_landing_inside_a_join_does_not_let_the_person_back(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """K1. The join is paused right AFTER its first block check said "not
    blocked"; the block runs into that window and commits; the join resumes,
    finds no member row and inserts one. Without the re-read of the block
    after the INSERT the person is back in the school with a block row
    beside the member row. With it: 403 blocked_in_group, and the block row
    is the only row there."""
    curator = await _verified_master(client, db_session, _TID_CURATOR)
    person = await _student(client, _TID_STUDENT)
    group_id = await _school(client, curator)
    token = await _token(client, curator, group_id)
    assert (await _join(client, person, token)).status_code == 200

    async def _join_call(session: AsyncSession) -> None:
        actor = await session.get(User, _uid(person))
        await curator_service.join_curator_group_by_token(
            token, _uid(person), session, actor=actor,
        )

    result = await race(
        monkeypatch,
        holder=_join_call,
        pause_in=(curator_service, "_blocked_in_group"),
        pause="after",
        rival=await _block_call(curator, group_id, person),
    )

    assert not result.holder.deadlocked and not result.rival.deadlocked
    assert result.rival.committed, result.rival.error
    assert not result.holder.committed
    assert getattr(result.holder.error, "code", None) == "blocked_in_group"
    rows = await _assert_one_of_two(group_id, person)
    assert rows["block"] is not None and rows["member"] is None


@pytest.mark.asyncio
async def test_k4_leaving_while_being_blocked_leaves_only_the_block(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """K4. The block holds the member row it deleted (paused before it drops
    the transfer); the person's own leave runs into it and waits on that
    row. Released, the block commits; the leave finds no row and writes no
    member_left. One block, no membership, no deadlock -- and the holder
    held member and block rows while the rival held nothing."""
    curator = await _verified_master(client, db_session, _TID_CURATOR)
    person = await _student(client, _TID_STUDENT)
    group_id = await _school(client, curator)
    await _seed_member(db_session, group_id, person, CuratorMemberKind.STUDENT)

    async def _leave_call(session: AsyncSession) -> None:
        actor = await session.get(User, _uid(person))
        await curator_service.leave_curator_group(
            UUID(group_id), _uid(person), session, actor=actor,
        )

    result = await race(
        monkeypatch,
        holder=await _block_call(curator, group_id, person),
        pause_in=(curator_service, "_drop_pending_transfer_for"),
        rival=_leave_call,
    )

    assert not result.holder.deadlocked and not result.rival.deadlocked
    assert result.rival_waited, "the leave never met the block's row lock"
    assert result.holder.committed, result.holder.error
    rows = await _assert_one_of_two(group_id, person)
    assert rows["block"] is not None
    assert CuratorGroupEventKind.MEMBER_LEFT.value not in await _journal(group_id)


async def _heir_with_offer(client, db_session) -> tuple[dict, dict, str]:
    curator = await _verified_master(client, db_session, _TID_CURATOR)
    heir = await _verified_master(client, db_session, _TID_HEIR)
    group_id = await _school(client, curator)
    await _seed_member(db_session, group_id, heir, CuratorMemberKind.MASTER)
    db_session.add(CuratorGroupTransfer(group_id=UUID(group_id), to_user_id=_uid(heir)))
    await db_session.flush()
    await db_session.commit()
    return curator, heir, group_id


async def _curator_of(group_id: str) -> UUID:
    return (
        await fresh_execute(
            select(CuratorGroup.curator_user_id).where(
                CuratorGroup.id == UUID(group_id)
            )
        )
    ).scalar_one()


@pytest.mark.asyncio
async def test_k5_a_block_inside_an_accepted_transfer_finds_the_heir_gone(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """K5, accept first. The heir's accept holds his member row and the
    claimed offer (paused at _has_master_capability, the pause point of
    test_curator_transfer_race.py); the curator's block of the heir waits on
    that member row. Released, the school changes hands; the block finds no
    member row and no block row -> 404, nothing written."""
    curator, heir, group_id = await _heir_with_offer(client, db_session)

    accept = _actor_call(
        curator_service.accept_curator_group_transfer,
        UUID(group_id), _uid(heir), actor_id=_uid(heir),
    )
    result = await race(
        monkeypatch,
        holder=accept,
        pause_in=(curator_service, "_has_master_capability"),
        rival=await _block_call(curator, group_id, heir),
    )

    assert not result.holder.deadlocked and not result.rival.deadlocked
    assert result.rival_waited, "the block never met the accept's row lock"
    assert result.holder.committed, result.holder.error
    assert not result.rival.committed
    assert getattr(result.rival.error, "status_code", None) == 404
    assert await _curator_of(group_id) == _uid(heir)
    rows = await _assert_one_of_two(group_id, heir)
    assert rows == {"member": None, "block": None}


@pytest.mark.asyncio
async def test_k5_an_accept_inside_a_block_does_not_move_the_school(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """K5, block first. The block holds the heir's deleted member row
    (paused before it drops the transfer); the heir's accept runs into it
    and waits on that row. Released, the block commits with the offer
    dropped; the accept finds nothing to accept. The school stays with its
    curator, the heir is blocked, no deadlock."""
    curator, heir, group_id = await _heir_with_offer(client, db_session)

    accept = _actor_call(
        curator_service.accept_curator_group_transfer,
        UUID(group_id), _uid(heir), actor_id=_uid(heir),
    )
    result = await race(
        monkeypatch,
        holder=await _block_call(curator, group_id, heir),
        pause_in=(curator_service, "_drop_pending_transfer_for"),
        rival=accept,
    )

    assert not result.holder.deadlocked and not result.rival.deadlocked
    assert result.rival_waited, "the accept never met the block's row lock"
    assert result.holder.committed, result.holder.error
    assert not result.rival.committed
    assert await _curator_of(group_id) == _uid(curator)
    rows = await _assert_one_of_two(group_id, heir)
    assert rows["block"] is not None
    transfers = (
        await fresh_execute(
            select(CuratorGroupTransfer).where(
                CuratorGroupTransfer.group_id == UUID(group_id)
            )
        )
    ).scalars().all()
    assert transfers == []


@pytest.mark.asyncio
async def test_k7_an_unblock_and_a_join_at_once_leave_one_membership(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """K7, symmetric, so asyncio.gather is the right tool: the unblock and
    the person's own join race. Whatever the order, one member row, no
    block row, and neither side failed with a 500."""
    curator = await _verified_master(client, db_session, _TID_CURATOR)
    person = await _student(client, _TID_STUDENT)
    group_id = await _school(client, curator)
    token = await _token(client, curator, group_id)
    assert (await _join(client, person, token)).status_code == 200
    assert (await _block(client, curator, group_id, person)).status_code == 204

    unblocked, joined = await asyncio.gather(
        _unblock(client, curator, group_id, person),
        _join(client, person, token),
    )

    assert unblocked.status_code == 204, unblocked.text
    assert joined.status_code in (200, 403), joined.text
    rows = await _assert_one_of_two(group_id, person)
    assert rows["member"] is not None and rows["block"] is None


@pytest.mark.asyncio
async def test_deleting_the_school_takes_its_blocks_with_it(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """FK CASCADE from the group: a deleted school leaves no block row."""
    curator = await _verified_master(client, db_session, _TID_CURATOR)
    person = await _student(client, _TID_STUDENT)
    group_id = await _school(client, curator)
    await _seed_member(db_session, group_id, person, CuratorMemberKind.STUDENT)
    assert (await _block(client, curator, group_id, person)).status_code == 204
    assert (await _rows(group_id, person))["block"] is not None

    resp = await client.delete(f"{GROUPS_URL}/{group_id}", headers=_h(curator))
    assert resp.status_code in (200, 204), resp.text

    assert (await _rows(group_id, person))["block"] is None
    factory = get_session_factory()
    async with factory() as probe:
        assert await probe.get(CuratorGroup, UUID(group_id)) is None


@pytest.mark.asyncio
async def test_k5_a_former_curator_cannot_block_in_the_school_he_just_lost(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """K5, a bystander. The heir's accept is paused AFTER it wrote the new
    owner onto the group row (at _frozen_name, the pause point
    test_curator_lock_order.py uses for removal); the outgoing curator,
    who still owns the school by every committed row, blocks an ordinary
    student meanwhile. The block swaps the student's rows and then waits on
    the group row in _lock_group_as_owner. Released, the school belongs to
    the heir, and the block's re-check under that lock refuses it. Without
    the re-check a former curator would block people in the new owner's
    school. The student stays a member, no block row.

    MEASURED FIRST WITH THE WRONG PAUSE: paused at _has_master_capability,
    before the owner switch, the block commits whole while the school is
    still the old curator's -- a legitimate order, not this window."""
    curator, heir, group_id = await _heir_with_offer(client, db_session)
    bystander = await _student(client, _TID_STUDENT)
    await _seed_member(db_session, group_id, bystander, CuratorMemberKind.STUDENT)

    accept = _actor_call(
        curator_service.accept_curator_group_transfer,
        UUID(group_id), _uid(heir), actor_id=_uid(heir),
    )
    result = await race(
        monkeypatch,
        holder=accept,
        pause_in=(curator_service, "_frozen_name"),
        rival=await _block_call(curator, group_id, bystander),
    )

    assert not result.holder.deadlocked and not result.rival.deadlocked
    assert result.rival_waited, "the block never met the accept's locks"
    assert result.holder.committed, result.holder.error
    assert not result.rival.committed
    assert await _curator_of(group_id) == _uid(heir)
    rows = await _assert_one_of_two(group_id, bystander)
    assert rows["member"] is not None and rows["block"] is None
