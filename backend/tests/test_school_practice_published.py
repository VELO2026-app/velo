# =============================================================================
# VELO Backend -- Tests: the school hears about a new practice (BE-30)
# =============================================================================
#
# telegram_id band: 67800-67899 (masters 67801-67803, members 67810-67815).
# Declared module-level below as _TID_MIN/_TID_MAX, ONCE --
# tests/telegram_id_bands.py parses that declaration out of the AST on every
# run, and a file using ids without declaring a band fails
# test_blind_zone_has_not_grown. Checked free before it was claimed:
# free_windows(space=(67000, 67999)) returned [(67800, 67999)].
#
# THE INVARIANT THIS FILE EXISTS FOR, stated the only way both halves can
# hold at once: THE JOURNAL LINE AND THE FAN-OUT HAPPEN TOGETHER OR NOT AT
# ALL, COUNTED BY SCHOOL AND NOT BY PERSON.
#
# One-to-one is false in both directions and the tests prove each: a school
# with no members produces a line and zero messages; a person in two target
# schools produces one message against two lines. Anyone who reads item 4 as
# "one notification per journal line" will find two tests here that fail
# under that reading, on purpose.
#
# THE OTHER NUMBER THAT MATTERS IS FORTY. A series root materialises up to
# practice_series_max_occurrences children, and the announcement is hooked
# ONLY on the draft -> scheduled branch, which children never pass. GT-30's
# master reminder is hooked in both places for the opposite reason -- forty
# sessions are forty things to be reminded of. Copying that shape here would
# have made two hundred members times forty occurrences.
#
# TWO NEIGHBOURING STATES THAT LOOK THE SAME AND ARE NOT:
#   - the school is dark (its curator lost verification) -- the practice is
#     still announced, because the gate that would refuse the publication
#     sits on the audience path and this is not it, and because
#     re-verification makes school and practice visible again;
#   - the AUTHOR left the school -- nothing is announced, because
#     _master_in_curator_group_clause already says the school no longer
#     accepts his practices, and that is permanent until he rejoins.
# One predicate separates them: it asks about the master, never about the
# curator. That is checked here rather than assumed, because if it ever
# covered both, the dark-school tests below would quietly stop testing
# anything.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch
from uuid import UUID

import pytest
import yaml
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events.models import OutboxEvent
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupEvent,
    CuratorGroupEventKind,
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

PRACTICES_URL = "/api/v1/practices"
_TYPE = "curator_group.practice_published"
_PROFILE_CANDIDATES = (
    Path(__file__).resolve().parents[2] / "comms-profile",
    Path("/comms-profile"),
)

_TID_MIN = 67800
_TID_MAX = 67899

_TID_AUTHOR = 67801
_TID_CURATOR = 67802
_TID_OTHER_CURATOR = 67803
_TID_STUDENT = 67810
_TID_STUDENT_B = 67811
_TID_SUSPENDED = 67812


# ===========================================================================
# Local helpers. Copied rather than imported, the convention here.
# ===========================================================================


async def _master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
    *,
    verified: bool = True,
    first_name: str = "Мастер",
) -> dict:
    """A master, verified or suspended -- the difference matters twice here."""
    auth = await login_user(
        client, telegram_id=telegram_id, first_name=first_name,
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
                    "status": "verified" if verified else "suspended",
                },
                "profile": {"bio": "m"},
            },
        )
    )
    await db_session.flush()
    await db_session.commit()
    return await login_user(
        client, telegram_id=telegram_id, first_name=first_name,
    )


async def _student(
    client: AsyncClient, telegram_id: int, first_name: str = "Ученик",
) -> dict:
    return await login_user(
        client, telegram_id=telegram_id, first_name=first_name,
    )


async def _school(
    db_session: AsyncSession, curator: dict, name: str = "Тихое утро",
) -> CuratorGroup:
    group = CuratorGroup(
        curator_user_id=UUID(curator["user"]["id"]), name=name,
    )
    db_session.add(group)
    await db_session.flush()
    await db_session.commit()
    return group


async def _join(
    db_session: AsyncSession,
    school: CuratorGroup,
    auth: dict,
    kind: CuratorMemberKind = CuratorMemberKind.STUDENT,
) -> CuratorGroupMember:
    row = CuratorGroupMember(
        group_id=school.id,
        user_id=UUID(auth["user"]["id"]),
        kind=kind.value,
    )
    db_session.add(row)
    await db_session.flush()
    await db_session.commit()
    return row


async def _suspend_curator(
    db_session: AsyncSession, curator: dict,
) -> None:
    """Take the school dark by unverifying its curator -- I-6, no row moved."""
    profile = (
        await db_session.execute(
            select(MasterProfile).where(
                MasterProfile.user_id == UUID(curator["user"]["id"]),
            )
        )
    ).scalars().one()
    profile.data = {
        **profile.data,
        "account": {**profile.data["account"], "status": "suspended"},
    }
    await db_session.flush()
    await db_session.commit()


async def _draft(
    client: AsyncClient,
    author: dict,
    schools: list[CuratorGroup],
    *,
    title: str = "Утренняя практика",
    recurrence: dict | None = None,
) -> str:
    body: dict = {
        "practice_type": "series" if recurrence else "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": title,
        "description": "x",
        "scheduled_at": (datetime.now(UTC) + timedelta(days=8)).isoformat(),
        "duration_minutes": 60,
        "timezone": "UTC",
        "max_participants": 20,
        "is_free": True,
        "price_cents": 0,
        "currency": "eur",
    }
    if schools:
        body["audience_kind"] = "curator_groups"
        body["curator_group_ids"] = [str(s.id) for s in schools]
    if recurrence:
        body["recurrence"] = recurrence
    created = await client.post(
        PRACTICES_URL, json=body, headers=auth_headers(author["session_token"]),
    )
    assert created.status_code == 201, created.text
    return created.json()["id"]


async def _publish(client: AsyncClient, author: dict, practice_id: str):
    return await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"status": "scheduled"},
        headers=auth_headers(author["session_token"]),
    )


async def _publish_ok(
    client: AsyncClient, author: dict, practice_id: str,
) -> None:
    resp = await _publish(client, author, practice_id)
    assert resp.status_code == 200, resp.text


async def _notified(session: AsyncSession, who: dict) -> list[dict]:
    """Announcement payloads addressed to one person.

    Scoped to the addressee on purpose: the outbox is one table for the
    whole suite and every other file that publishes a school practice now
    writes into it too. An unscoped count would pass for the wrong reason
    the day this file's own emit broke.
    """
    rows = (
        await session.execute(
            select(OutboxEvent)
            .where(
                OutboxEvent.payload["type"].astext == _TYPE,
                OutboxEvent.payload["target_value"].astext
                == who["user"]["id"],
            )
            .order_by(OutboxEvent.id)
        )
    ).scalars().all()
    return [row.payload for row in rows]


async def _lines(
    session: AsyncSession, school: CuratorGroup,
) -> list[CuratorGroupEvent]:
    return list(
        (
            await session.execute(
                select(CuratorGroupEvent)
                .where(
                    CuratorGroupEvent.group_id == school.id,
                    CuratorGroupEvent.event
                    == CuratorGroupEventKind.PRACTICE_PUBLISHED.value,
                )
                .order_by(CuratorGroupEvent.id)
            )
        ).scalars().all()
    )


def _profile_dir() -> Path:
    for candidate in _PROFILE_CANDIDATES:
        if (candidate / "types.yaml").is_file():
            return candidate
    raise AssertionError(
        "comms-profile/types.yaml found in none of: "
        + ", ".join(str(c) for c in _PROFILE_CANDIDATES)
        + " -- inside a container this means the read-only mount declared "
          "for the app service in docker-compose.yml is missing."
    )


# ===========================================================================
# Cleanup
# ===========================================================================


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    async def _wipe() -> None:
        ids = (
            await db_session.execute(
                select(User.id).where(
                    User.telegram_id.between(_TID_MIN, _TID_MAX),
                )
            )
        ).scalars().all()
        for uid in ids:
            await db_session.execute(
                OutboxEvent.__table__.delete().where(
                    OutboxEvent.payload["target_value"].astext == str(uid),
                )
            )
        await full_cleanup_range(
            db_session, _TID_MIN, _TID_MAX, delete_users=True,
        )
        await db_session.commit()

    await _wipe()
    yield
    await _wipe()


# ===========================================================================
# The announcement itself
# ===========================================================================


@pytest.mark.asyncio
async def test_publishing_tells_the_school_and_writes_its_journal(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """One line, one message, and the message points at the practice.

    open_practice rather than open_curator_group: the person is being told
    about a practice, and a link to the school page would leave them
    hunting for it on a list. Same choice and same reason as
    practice.cancelled_by_curator (BE-21).
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    author = await _master(client, db_session, _TID_AUTHOR, first_name="Ната")
    student = await _student(client, _TID_STUDENT)
    school = await _school(db_session, curator)
    await _join(db_session, school, author, CuratorMemberKind.MASTER)
    await _join(db_session, school, student)

    practice_id = await _draft(client, author, [school])
    await _publish_ok(client, author, practice_id)

    assert len(await _lines(db_session, school)) == 1
    messages = await _notified(db_session, student)
    assert len(messages) == 1
    assert messages[0]["action_data"]["action"] == "open_practice"
    assert messages[0]["action_data"]["params"]["practice_id"] == practice_id
    assert messages[0]["action_data"]["group_name"] == school.name
    assert messages[0]["action_data"]["actor_name"] == "Ната"


@pytest.mark.asyncio
async def test_the_author_is_not_told_about_their_own_publication(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """He is the one who pressed the button.

    Paired with the student's message in the same test: silence on its own
    would also be what a dead fan-out produces.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    author = await _master(client, db_session, _TID_AUTHOR)
    student = await _student(client, _TID_STUDENT)
    school = await _school(db_session, curator)
    await _join(db_session, school, author, CuratorMemberKind.MASTER)
    await _join(db_session, school, student)

    await _publish_ok(
        client, author, await _draft(client, author, [school]),
    )

    assert await _notified(db_session, author) == []
    assert len(await _notified(db_session, student)) == 1


@pytest.mark.asyncio
async def test_the_curator_is_told_and_is_not_when_they_published_it(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The curator holds no membership row (I-2) and is added explicitly --
    unless they are the author, where "did it themselves" wins over "it is
    their school". Two requirements meet in one person and this is which
    one takes it."""
    curator = await _master(client, db_session, _TID_CURATOR)
    author = await _master(client, db_session, _TID_AUTHOR)
    school = await _school(db_session, curator)
    await _join(db_session, school, author, CuratorMemberKind.MASTER)

    await _publish_ok(
        client, author, await _draft(client, author, [school]),
    )
    assert len(await _notified(db_session, curator)) == 1

    await _publish_ok(
        client, curator, await _draft(client, curator, [school]),
    )
    assert len(await _notified(db_session, curator)) == 1
    assert len(await _lines(db_session, school)) == 2


@pytest.mark.asyncio
async def test_a_suspended_master_member_is_still_told(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Membership, not the roster.

    A suspended master is hidden from the school's roster (I-4) but still
    sees its practices -- _viewer_in_curator_group_clause says losing sight
    of them is not part of what suspension means. Skipping him here would
    contradict the screen he can open.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    author = await _master(client, db_session, _TID_AUTHOR)
    shadowed = await _master(
        client, db_session, _TID_SUSPENDED, verified=False,
    )
    school = await _school(db_session, curator)
    await _join(db_session, school, author, CuratorMemberKind.MASTER)
    await _join(db_session, school, shadowed, CuratorMemberKind.MASTER)

    await _publish_ok(
        client, author, await _draft(client, author, [school]),
    )

    assert len(await _notified(db_session, shadowed)) == 1


# ===========================================================================
# The counts the invariant is stated in
# ===========================================================================


@pytest.mark.asyncio
async def test_one_person_in_two_target_schools_is_told_once(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """ONE message against TWO journal lines -- the pair is per school.

    Both numbers are asserted in the same test because each alone is
    satisfiable by the wrong implementation: one message could mean one
    school was processed, and two lines could sit beside two messages.
    Both school names ride in the single message, joined, so the person is
    not told it came from only one of them.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    author = await _master(client, db_session, _TID_AUTHOR)
    student = await _student(client, _TID_STUDENT)
    morning = await _school(db_session, curator, name="Утро")
    evening = await _school(db_session, curator, name="Вечер")
    for school in (morning, evening):
        await _join(db_session, school, author, CuratorMemberKind.MASTER)
        await _join(db_session, school, student)

    await _publish_ok(
        client, author, await _draft(client, author, [morning, evening]),
    )

    messages = await _notified(db_session, student)
    assert len(messages) == 1
    assert len(await _lines(db_session, morning)) == 1
    assert len(await _lines(db_session, evening)) == 1
    assert messages[0]["action_data"]["group_name"] == "Утро, Вечер"


@pytest.mark.asyncio
async def test_a_series_of_forty_occurrences_announces_once(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The number this whole feature was shaped around.

    practice_series_max_occurrences is 40 and a school runs to hundreds of
    members, so hooking the announcement where GT-30 hooks its reminder --
    publication AND the child generator -- would produce eight thousand
    messages from one press. Asserted by COUNT and not by "a message
    arrived", because arrival is true in the broken version too.

    The children are asserted to exist in the same test: one message over
    a series that silently failed to materialise would prove nothing.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    author = await _master(client, db_session, _TID_AUTHOR)
    student = await _student(client, _TID_STUDENT)
    school = await _school(db_session, curator)
    await _join(db_session, school, author, CuratorMemberKind.MASTER)
    await _join(db_session, school, student)

    practice_id = await _draft(
        client,
        author,
        [school],
        recurrence={"period": "daily", "end": "after_count", "count": 40},
    )
    await _publish_ok(client, author, practice_id)

    children = (
        await db_session.execute(
            select(Practice.id).where(
                Practice.parent_practice_id == UUID(practice_id),
            )
        )
    ).scalars().all()
    assert len(children) == 39, "root plus 39 children makes the forty"

    assert len(await _notified(db_session, student)) == 1
    assert len(await _lines(db_session, school)) == 1


@pytest.mark.asyncio
async def test_a_school_with_no_members_gets_its_line_and_no_messages(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The other direction in which one-to-one is false.

    An empty school is not an error and not a skip: the line is written
    because the practice really was published to it, and somebody joining
    tomorrow will find it in the journal.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    author = await _master(client, db_session, _TID_AUTHOR)
    empty = await _school(db_session, curator, name="Пустая")
    await _join(db_session, empty, author, CuratorMemberKind.MASTER)

    await _publish_ok(
        client, author, await _draft(client, author, [empty]),
    )

    assert len(await _lines(db_session, empty)) == 1
    # Only the curator hears about it -- the author is excluded and there
    # is nobody else. Asserted so "no messages" is shown to be the roster
    # and not a dead emit.
    assert len(await _notified(db_session, curator)) == 1


# ===========================================================================
# Where the announcement does NOT happen
# ===========================================================================


@pytest.mark.asyncio
async def test_a_practice_outside_any_school_announces_nothing(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Public practices have no school to tell.

    The school practice in the same test is what keeps this from passing
    on a fan-out that never runs.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    author = await _master(client, db_session, _TID_AUTHOR)
    student = await _student(client, _TID_STUDENT)
    school = await _school(db_session, curator)
    await _join(db_session, school, author, CuratorMemberKind.MASTER)
    await _join(db_session, school, student)

    await _publish_ok(client, author, await _draft(client, author, []))
    assert await _notified(db_session, student) == []
    assert await _lines(db_session, school) == []

    await _publish_ok(
        client, author, await _draft(client, author, [school]),
    )
    assert len(await _notified(db_session, student)) == 1


@pytest.mark.asyncio
async def test_an_author_who_left_the_school_announces_nothing(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The audience row survives the departure; the broadcast does not.

    Nothing rewrites practice_audience_curator_group when a master leaves,
    and the publish path does not re-check membership -- the gate that
    would sits on the audience branch, which a status-only PATCH never
    enters. So the publication itself SUCCEEDS, and it is
    _master_in_curator_group_clause that keeps the announcement from going
    out: the school can no longer see his practices, so telling its
    members one has arrived would be an arrival nobody can open.

    NOT the BE-24 history/state split reappearing. That one preserves what
    already happened; this is a present-tense "look, it is here".
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    author = await _master(client, db_session, _TID_AUTHOR)
    student = await _student(client, _TID_STUDENT)
    school = await _school(db_session, curator)
    membership = await _join(
        db_session, school, author, CuratorMemberKind.MASTER,
    )
    await _join(db_session, school, student)

    practice_id = await _draft(client, author, [school])

    await db_session.delete(
        await db_session.get(CuratorGroupMember, membership.id)
    )
    await db_session.commit()

    published = await _publish(client, author, practice_id)
    assert published.status_code == 200, published.text

    assert await _notified(db_session, student) == []
    assert await _lines(db_session, school) == []


@pytest.mark.asyncio
async def test_a_dark_school_is_still_announced_to(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The neighbouring state, and it resolves the other way.

    A school whose curator lost verification goes dark for reads, but
    publishing into it still succeeds and the announcement still goes out.
    The reason it is not the previous test: re-verifying the curator brings
    school and practice back with nobody touching a row, so the message is
    early rather than wrong -- while a departed master's practice never
    becomes visible until he rejoins.

    THE PUBLISHER HERE IS A MEMBER MASTER, NOT THE CURATOR, and that is
    forced: get_current_master refuses an unverified caller, so a dark
    school's own curator cannot publish anything. This is the only shape in
    which the state is reachable at all.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    author = await _master(client, db_session, _TID_AUTHOR)
    student = await _student(client, _TID_STUDENT)
    school = await _school(db_session, curator)
    await _join(db_session, school, author, CuratorMemberKind.MASTER)
    await _join(db_session, school, student)

    practice_id = await _draft(client, author, [school])
    await _suspend_curator(db_session, curator)

    await _publish_ok(client, author, practice_id)

    assert len(await _notified(db_session, student)) == 1
    assert len(await _lines(db_session, school)) == 1


@pytest.mark.asyncio
async def test_rescheduling_after_publication_announces_nothing_again(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A second message would say the course opened twice.

    Not a decision but a consequence: a reschedule takes its own branch and
    never re-enters draft -> scheduled. Pinned anyway, because the day
    somebody moves the hook it is the assertion that notices.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    author = await _master(client, db_session, _TID_AUTHOR)
    student = await _student(client, _TID_STUDENT)
    school = await _school(db_session, curator)
    await _join(db_session, school, author, CuratorMemberKind.MASTER)
    await _join(db_session, school, student)

    practice_id = await _draft(client, author, [school])
    await _publish_ok(client, author, practice_id)

    moved = await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={
            "scheduled_at": (
                datetime.now(UTC) + timedelta(days=12)
            ).isoformat(),
        },
        headers=auth_headers(author["session_token"]),
    )
    assert moved.status_code == 200, moved.text

    assert len(await _notified(db_session, student)) == 1
    assert len(await _lines(db_session, school)) == 1


@pytest.mark.asyncio
async def test_a_failed_publication_leaves_neither_half(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Rollback takes the line and the messages together.

    The journal write is synchronous session.add and the notifications are
    outbox rows; both ride the caller's transaction, so an error anywhere
    in the publication takes both. Asserted against a forced failure rather
    than reasoned from the docstrings, and the clean publication that
    follows shows the failure was the patch.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    author = await _master(client, db_session, _TID_AUTHOR)
    student = await _student(client, _TID_STUDENT)
    school = await _school(db_session, curator)
    await _join(db_session, school, author, CuratorMemberKind.MASTER)
    await _join(db_session, school, student)

    practice_id = await _draft(client, author, [school])

    with patch(
        "app.modules.curator_groups.service.emit_notification",
        side_effect=RuntimeError("outbox exploded"),
    ), pytest.raises(RuntimeError, match="outbox exploded"):
        await _publish(client, author, practice_id)

    assert await _notified(db_session, student) == []
    assert await _lines(db_session, school) == []

    await _publish_ok(client, author, practice_id)
    assert len(await _notified(db_session, student)) == 1
    assert len(await _lines(db_session, school)) == 1


# ===========================================================================
# The predicate that separates the two neighbouring states
# ===========================================================================


@pytest.mark.asyncio
async def test_the_membership_predicate_ignores_the_curators_status(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """One predicate, one subject: the master, never the curator.

    If master_broadcasts_to_group_clause ever also required a verified
    curator, the dark-school test above would pass while testing nothing --
    it would be asserting the departed-master path under another name. This
    checks the separation directly: the same author, the same school, with
    the curator verified and then not, keeps the same answer.
    """
    from app.modules.practices.audience_service import (
        master_broadcasts_to_group_clause,
    )

    curator = await _master(client, db_session, _TID_CURATOR)
    author = await _master(client, db_session, _TID_AUTHOR)
    school = await _school(db_session, curator)
    await _join(db_session, school, author, CuratorMemberKind.MASTER)

    async def _accepts() -> bool:
        return bool(
            (
                await db_session.execute(
                    select(CuratorGroup.id).where(
                        CuratorGroup.id == school.id,
                        master_broadcasts_to_group_clause(
                            UUID(author["user"]["id"]),
                        ),
                    )
                )
            ).scalar_one_or_none()
        )

    assert await _accepts() is True
    await _suspend_curator(db_session, curator)
    assert await _accepts() is True


# ===========================================================================
# The profile
# ===========================================================================


class TestProfile:
    def test_the_new_type_is_declared_in_all_three_files(self) -> None:
        """Type plus both locales, by key, machine-checked.

        A type present in types.yaml and missing from a sheet renders
        nothing in that language; present in a sheet and missing from the
        dictionary, it renders for a type nobody can send.
        """
        profile = _profile_dir()
        types = yaml.safe_load((profile / "types.yaml").read_text())
        assert _TYPE in types

        for locale in ("ru", "en"):
            sheets = yaml.safe_load(
                (profile / "templates" / f"{locale}.yaml").read_text()
            )
            assert _TYPE in sheets, locale
            assert set(sheets) <= set(types), locale

    def test_the_new_type_is_silenceable_with_the_school_family(self) -> None:
        """curator_groups, and for the reason that made the category.

        It scales: every published practice, from every master of the
        school, to every member. member_joined is in the same bucket for
        the same reason, while the four types that tell one person their
        own standing changed carry no category at all -- silencing those
        would lose a role, silencing this loses an announcement still
        visible on the school's page.
        """
        types = yaml.safe_load((_profile_dir() / "types.yaml").read_text())
        assert types[_TYPE]["category"] == "curator_groups"
        assert types["curator_group.member_joined"]["category"] == (
            "curator_groups"
        )
        assert types["curator_group.transfer_offered"] is None
