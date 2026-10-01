# =============================================================================
# VELO Backend -- Tests: the schools killswitch off the routers (BE-43)
# =============================================================================
#
# telegram_id band: 69400-69499 (curator 69401, master 69402, student 69410).
# Declared module-level below as _TID_MIN/_TID_MAX, ONCE --
# tests/telegram_id_bands.py parses that declaration out of the AST on every
# run, and a file using ids without declaring a band fails
# test_blind_zone_has_not_grown. Checked free before it was claimed:
# free_windows(space=(69000, 69999)) returned [(69400, 69999)].
#
# WHY test_curator_groups_killswitch.py DOES NOT COVER THIS, and why that
# is not a gap in it. BE-35 replaced its hand-written list of five calls
# with one derived from the two school routers, and it honestly walks all
# twenty-eight operations. Both paths below are OUTSIDE those routers: a
# curator cancels through practices/, and the announcement rides the
# publication branch. The killswitch on the routers guards THE SURFACE,
# NOT THE MECHANISM -- the two are different things and the older file is
# right about the one it names.
#
# EACH TEST IS A PAIR IN ITSELF: flag off, then flag on, same fixture, same
# call. A test that only checked the "off" half would pass in a world where
# the entitlement and the fan-out were broken outright, which is the failure
# these two are least able to tell apart from success.
#
# THE PAIRS ARE NARROW ON PURPOSE. The "works as before" half is covered in
# full elsewhere -- test_practice_cancel_by_curator.py for the entitlement
# and test_school_practice_published.py for the announcement. These tests do
# not repeat that; they assert only that the flag, and nothing else, is what
# changed the answer.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from unittest.mock import patch
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.events.models import OutboxEvent
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupEvent,
    CuratorGroupEventKind,
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

PRACTICES_URL = "/api/v1/practices"
CANCEL_URL = "/api/v1/practices/{practice_id}/cancel"

_TID_MIN = 69400
_TID_MAX = 69499

_TID_CURATOR = 69401
_TID_MASTER = 69402
_TID_STUDENT = 69410

_FLAG = "curator_groups_enabled"
_ANNOUNCE_TYPE = "curator_group.practice_published"


def _off():
    """The killswitch pulled, for the duration of a `with` block."""
    return patch.object(settings, _FLAG, False)


def _on():
    """The killswitch in its default position, stated explicitly.

    Written as a patch rather than relying on the ambient default, so the
    two halves of each test read symmetrically and neither depends on what
    another test left behind. Same helper pair, same reason, as
    test_curator_groups_killswitch.py.
    """
    return patch.object(settings, _FLAG, True)


# ===========================================================================
# Local helpers. Copied rather than imported, the convention here.
# ===========================================================================


async def _verified_master(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
) -> dict:
    auth = await login_user(
        client, telegram_id=telegram_id, first_name="Master",
    )
    user_id = UUID(auth["user"]["id"])
    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER
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
    return await login_user(
        client, telegram_id=telegram_id, first_name="Master",
    )


async def _school_with_practice(
    client: AsyncClient, db_session: AsyncSession,
) -> tuple[dict, dict, CuratorGroup, str]:
    """A school, a member master, and that master's published practice.

    Built with the flag in its default position: the fixture has to be
    reachable, and what the tests measure is the flag's effect on two
    later calls, not on the setup.
    """
    curator = await _verified_master(client, db_session, _TID_CURATOR)
    master = await _verified_master(client, db_session, _TID_MASTER)
    student = await login_user(
        client, telegram_id=_TID_STUDENT, first_name="Ученик",
    )

    school = CuratorGroup(
        curator_user_id=UUID(curator["user"]["id"]), name="Школа BE-43",
    )
    db_session.add(school)
    await db_session.flush()
    for auth, kind in (
        (master, CuratorMemberKind.MASTER),
        (student, CuratorMemberKind.STUDENT),
    ):
        db_session.add(
            CuratorGroupMember(
                group_id=school.id,
                user_id=UUID(auth["user"]["id"]),
                kind=kind.value,
            )
        )
    await db_session.flush()
    await db_session.commit()

    created = await client.post(
        PRACTICES_URL,
        json={
            "practice_type": "live",
            "direction": "meditation",
            "difficulty": "beginner",
            "title": "Практика школы",
            "description": "x",
            "scheduled_at": (
                datetime.now(UTC) + timedelta(days=8)
            ).isoformat(),
            "duration_minutes": 60,
            "timezone": "UTC",
            "max_participants": 20,
            "is_free": True,
            "price_cents": 0,
            "currency": "eur",
            "audience_kind": "curator_groups",
            "curator_group_ids": [str(school.id)],
        },
        headers=auth_headers(master["session_token"]),
    )
    assert created.status_code == 201, created.text
    return curator, master, school, created.json()["id"]


async def _publish(
    client: AsyncClient, master: dict, practice_id: str,
):
    return await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"status": "scheduled"},
        headers=auth_headers(master["session_token"]),
    )


async def _announcements(
    db_session: AsyncSession, school: CuratorGroup,
) -> tuple[int, int]:
    """(journal lines, notifications) produced for one school."""
    lines = (
        await db_session.execute(
            select(CuratorGroupEvent.id).where(
                CuratorGroupEvent.group_id == school.id,
                CuratorGroupEvent.event
                == CuratorGroupEventKind.PRACTICE_PUBLISHED.value,
            )
        )
    ).scalars().all()
    messages = (
        await db_session.execute(
            select(OutboxEvent.id).where(
                OutboxEvent.payload["type"].astext == _ANNOUNCE_TYPE,
            )
        )
    ).scalars().all()
    return len(lines), len(messages)


# ===========================================================================
# Cleanup
# ===========================================================================


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    async def _wipe() -> None:
        await full_cleanup_range(
            db_session, _TID_MIN, _TID_MAX, delete_users=True,
        )
        await db_session.commit()

    await _wipe()
    yield
    await _wipe()


# ===========================================================================
# Hole one: the curator's entitlement to cancel another master's practice
# ===========================================================================


@pytest.mark.asyncio
async def test_the_curators_right_to_cancel_stops_with_the_flag(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Schools off, and the lever a school gave goes with them.

    cancel_service asks curated_group_ids_for_practice directly, which no
    router dependency ever sees. Until BE-43 the flag left this
    entitlement standing: schools were "off" and a curator could still
    cancel a practice belonging to somebody else's master.

    THE 404 IS THE RIGHT REFUSAL, not a distinct code. An empty
    entitlement is indistinguishable from "no such practice" by design
    (P-08): the answer must not reveal that the practice exists, that it
    is a school practice, or whose school it is.

    The "on" half is deliberately the same call on the same fixture -- it
    is the flag, and nothing about the setup, that changes the answer. The
    full behaviour of curator cancellation is covered in
    test_practice_cancel_by_curator.py and not repeated here.
    """
    curator, master, _school, practice_id = await _school_with_practice(
        client, db_session,
    )
    await _publish(client, master, practice_id)
    headers = auth_headers(curator["session_token"])

    with _off():
        refused = await client.post(
            CANCEL_URL.format(practice_id=practice_id), json={},
            headers=headers,
        )
    assert refused.status_code == 404, refused.text

    practice = await db_session.get(Practice, UUID(practice_id))
    await db_session.refresh(practice)
    assert practice.status == PracticeStatus.SCHEDULED.value, (
        "refused, but the practice was cancelled anyway"
    )

    with _on():
        allowed = await client.post(
            CANCEL_URL.format(practice_id=practice_id), json={},
            headers=headers,
        )
    assert allowed.status_code == 200, allowed.text


# ===========================================================================
# Hole two: the fan-out on publication
# ===========================================================================


@pytest.mark.asyncio
async def test_publishing_announces_nothing_with_the_flag_off(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Schools off, so there is nobody to tell.

    The publication branch calls announce_published_practice
    unconditionally, and no router guards that path either. Until BE-43
    the flag left it running: a journal line in every target school and a
    notification to every member, about a practice the audience predicate
    then hides from all of them. The message arrived and the link behind
    it was a 404.

    BOTH HALVES ARE COUNTED, not merely present or absent: zero lines and
    zero messages with the flag off, and non-zero of each with it on. A
    bare "nothing was written" passes just as well when the fan-out is
    broken outright, which is exactly what this pair exists to tell apart.
    The full shape of the announcement is covered in
    test_school_practice_published.py.
    """
    _curator, master, school, practice_id = await _school_with_practice(
        client, db_session,
    )

    with _off():
        published = await _publish(client, master, practice_id)
    assert published.status_code == 200, published.text

    lines, messages = await _announcements(db_session, school)
    assert (lines, messages) == (0, 0), (
        f"flag off, yet {lines} journal lines and {messages} messages"
    )

    _c2, master2, school2, practice2 = await _school_with_practice_for_on(
        client, db_session,
    )
    with _on():
        published2 = await _publish(client, master2, practice2)
    assert published2.status_code == 200, published2.text

    lines2, messages2 = await _announcements(db_session, school2)
    assert lines2 > 0 and messages2 > 0, (
        f"flag on, but {lines2} journal lines and {messages2} messages"
    )


async def _school_with_practice_for_on(
    client: AsyncClient, db_session: AsyncSession,
) -> tuple[dict, dict, CuratorGroup, str]:
    """A SECOND school and practice, for the "on" half of the pair above.

    A fresh fixture rather than the same one: publication is a one-way
    transition (draft -> scheduled has no way back), so the practice used
    for the "off" half can never be published again.
    """
    curator = await login_user(
        client, telegram_id=_TID_CURATOR, first_name="Master",
    )
    master = await login_user(
        client, telegram_id=_TID_MASTER, first_name="Master",
    )
    student = await login_user(
        client, telegram_id=_TID_STUDENT, first_name="Ученик",
    )
    school = CuratorGroup(
        curator_user_id=UUID(curator["user"]["id"]),
        name="Школа BE-43 вторая",
    )
    db_session.add(school)
    await db_session.flush()
    for auth, kind in (
        (master, CuratorMemberKind.MASTER),
        (student, CuratorMemberKind.STUDENT),
    ):
        db_session.add(
            CuratorGroupMember(
                group_id=school.id,
                user_id=UUID(auth["user"]["id"]),
                kind=kind.value,
            )
        )
    await db_session.flush()
    await db_session.commit()

    created = await client.post(
        PRACTICES_URL,
        json={
            "practice_type": "live",
            "direction": "meditation",
            "difficulty": "beginner",
            "title": "Вторая практика школы",
            "description": "x",
            "scheduled_at": (
                datetime.now(UTC) + timedelta(days=9)
            ).isoformat(),
            "duration_minutes": 60,
            "timezone": "UTC",
            "max_participants": 20,
            "is_free": True,
            "price_cents": 0,
            "currency": "eur",
            "audience_kind": "curator_groups",
            "curator_group_ids": [str(school.id)],
        },
        headers=auth_headers(master["session_token"]),
    )
    assert created.status_code == 201, created.text
    return curator, master, school, created.json()["id"]


@pytest.mark.asyncio
async def test_publishing_twice_with_the_flag_off_writes_nothing_twice(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The repeat axis: a second publication adds no line either.

    Not a duplicate of the test above. That one asks whether the early
    return fires; this one asks whether anything accumulates behind it --
    a guard that returned on the first call and fell through on the second
    would satisfy the first test and fail this one.

    The second PATCH is refused by the status machine (there is no path
    out of `scheduled`), and that is the point: even the attempt leaves
    the journal empty.
    """
    _curator, master, school, practice_id = await _school_with_practice(
        client, db_session,
    )

    with _off():
        first = await _publish(client, master, practice_id)
        assert first.status_code == 200, first.text
        await _publish(client, master, practice_id)

    assert await _announcements(db_session, school) == (0, 0)


@pytest.mark.asyncio
async def test_a_practice_without_schools_is_unaffected_by_the_flag(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The emptiness axis: no schools, so the flag changes nothing.

    Publication succeeds and announces nothing in both positions -- the
    early return added by BE-43 and the audience_kind test beside it reach
    the same answer by different roads, and neither may turn a public
    practice into an error.

    The pair for "no journal" is the previous test's "on" half: a live
    school does produce one. Without that, "nothing was written" here
    would be equally true of a fan-out that never writes at all.
    """
    master = await _verified_master(client, db_session, _TID_MASTER)
    created = await client.post(
        PRACTICES_URL,
        json={
            "practice_type": "live",
            "direction": "meditation",
            "difficulty": "beginner",
            "title": "Публичная практика",
            "description": "x",
            "scheduled_at": (
                datetime.now(UTC) + timedelta(days=8)
            ).isoformat(),
            "duration_minutes": 60,
            "timezone": "UTC",
            "max_participants": 20,
            "is_free": True,
            "price_cents": 0,
            "currency": "eur",
        },
        headers=auth_headers(master["session_token"]),
    )
    assert created.status_code == 201, created.text
    practice_id = created.json()["id"]

    with _off():
        published = await _publish(client, master, practice_id)
    assert published.status_code == 200, published.text

    messages = (
        await db_session.execute(
            select(OutboxEvent.id).where(
                OutboxEvent.payload["type"].astext == _ANNOUNCE_TYPE,
            )
        )
    ).scalars().all()
    assert messages == []
