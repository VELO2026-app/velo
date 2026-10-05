# =============================================================================
# VELO Backend -- Tests: external activity and its diary projection (BE-27)
# =============================================================================
#
# telegram_id band: 89600-89679 (owner 89601-89602, outsider 89630).
# Declared module-level below as _TID_MIN/_TID_MAX, ONCE --
# tests/telegram_id_bands.py parses that declaration out of the AST on every
# run, and a file using ids without declaring a band fails
# test_blind_zone_has_not_grown. Checked free before it was claimed:
# free_windows(space=(89000, 89999)) returned
# [(89023, 89399), (89600, 89679), (89860, 89869)].
#
# WHAT THIS FILE IS ABOUT. A person records something they did OUTSIDE velo
# and it appears in their own diary immediately, at the time of the EVENT
# rather than of the entry. It is the only record in the diary the person
# creates on their own initiative about the world outside the product.
#
# THREE PROPERTIES ARE LOAD-BEARING and each has a test whose only job is to
# catch its inversion:
#
#   - occurred_at is the ACTIVITY's time, not the write time. Get this
#     wrong and the feature silently degrades into "notes with a type":
#     everything sorts by when it was typed.
#   - the activity and its diary event live or die together. A caught
#     projection error would leave a row the person can never see.
#   - the Python enum and the DB CHECK constraint say the same seven
#     things. They are two literals in two files and nothing but a test
#     keeps them equal.
#
# EVERY REFUSAL IS PAIRED WITH AN ACCEPTANCE, and every "no row" assertion
# is made against a counted table rather than against a 422 alone: a
# validation test that only reads the status code passes just as happily
# when the endpoint is broken for everything.
# =============================================================================

import re
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta, timezone
from unittest.mock import patch
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import AuditLog
from app.core.config import settings
from app.modules.diary.models import (
    DiaryEvent,
    DiaryEventKind,
    DiaryEventSourceType,
    ExternalActivity,
    ExternalActivityType,
)
from app.modules.users.models import User
from tests.helpers import auth_headers, full_cleanup_range, login_user

ACTIVITIES_URL = "/api/v1/diary/external-activities"
FEED_URL = "/api/v1/diary/feed"

_TID_MIN = 89600
_TID_MAX = 89679

_TID_OWNER = 89601
_TID_OTHER = 89602

_PRESET_TYPES = [
    t.value for t in ExternalActivityType if t is not ExternalActivityType.CUSTOM
]


# ===========================================================================
# Local helpers. Copied rather than imported, the convention in every test
# file here. No default telegram_id on any of them.
# ===========================================================================


def _body(**overrides: object) -> dict:
    base: dict = {
        "occurred_at": (
            datetime.now(UTC) - timedelta(days=2)
        ).isoformat(),
        "activity_type": "meditation",
        "mood": 6,
    }
    base.update(overrides)
    return base


async def _post(client: AsyncClient, auth: dict, **overrides: object):
    return await client.post(
        ACTIVITIES_URL,
        json=_body(**overrides),
        headers=auth_headers(auth["session_token"]),
    )


async def _created(client: AsyncClient, auth: dict, **overrides: object) -> dict:
    resp = await _post(client, auth, **overrides)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _feed(
    client: AsyncClient, auth: dict, **params: object,
) -> dict:
    resp = await client.get(
        FEED_URL,
        params=params or None,
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _locs(client: AsyncClient, auth: dict, **overrides: object):
    """The `loc` of every validation error, as the frontend receives them.

    Reads the wire body rather than calling the pydantic model directly:
    what matters is what reaches the client through FastAPI's 422, and a
    model-level check would prove the validator raised without proving the
    address survived the trip. It does not survive unchanged, either:
    FastAPI prefixes every loc with "body", so the wire form is
    ["body", "<field>"] and the model-validator form was ["body"] alone --
    measured here rather than quoted from pydantic.
    """
    resp = await _post(client, auth, **overrides)
    assert resp.status_code == 422, resp.text
    return sorted(tuple(e["loc"]) for e in resp.json()["detail"])


async def _count_activities(session: AsyncSession, auth: dict) -> int:
    return (
        await session.execute(
            select(func.count(ExternalActivity.id)).where(
                ExternalActivity.user_id == UUID(auth["user"]["id"]),
            )
        )
    ).scalar_one()


async def _events(session: AsyncSession, auth: dict) -> list[DiaryEvent]:
    return list(
        (
            await session.execute(
                select(DiaryEvent)
                .where(
                    DiaryEvent.user_id == UUID(auth["user"]["id"]),
                    DiaryEvent.kind
                    == DiaryEventKind.EXTERNAL_ACTIVITY.value,
                )
                .order_by(DiaryEvent.occurred_at)
            )
        ).scalars().all()
    )


async def _constraint_literals(
    session: AsyncSession, name: str,
) -> set[str]:
    """The quoted values inside a CHECK constraint, read from the DB.

    Reads pg_get_constraintdef rather than the migration file: the point is
    what the database enforces, and a test that re-read the source would
    only prove the source equals itself.
    """
    definition = (
        await session.execute(
            text(
                "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                "WHERE conname = :name"
            ),
            {"name": name},
        )
    ).scalar_one()
    return set(re.findall(r"'([a-z_]+)'::", definition)) or set(
        re.findall(r"'([a-z_]+)'", definition)
    )


# ===========================================================================
# Cleanup
# ===========================================================================


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ===========================================================================
# Happy path
# ===========================================================================


@pytest.mark.asyncio
@pytest.mark.parametrize("activity_type", _PRESET_TYPES)
async def test_every_preset_type_is_accepted(
    client: AsyncClient, db_session: AsyncSession, activity_type: str,
) -> None:
    """All six preset types, each on its own, with no custom name.

    Parametrized over the enum rather than over a hand-written list: a
    seventh preset added to ExternalActivityType is covered the moment it
    exists, instead of the day somebody remembers this file.
    """
    owner = await login_user(client, telegram_id=_TID_OWNER)
    created = await _created(client, owner, activity_type=activity_type)

    assert created["activity_type"] == activity_type
    assert created["custom_activity_name"] is None
    assert await _count_activities(db_session, owner) == 1


@pytest.mark.asyncio
async def test_custom_with_a_name_is_accepted_and_echoed(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The seventh type is the one that carries a name."""
    owner = await login_user(client, telegram_id=_TID_OWNER)
    created = await _created(
        client,
        owner,
        activity_type="custom",
        custom_activity_name="Ледяная купель",
    )

    assert created["activity_type"] == "custom"
    assert created["custom_activity_name"] == "Ледяная купель"
    assert await _count_activities(db_session, owner) == 1


@pytest.mark.asyncio
async def test_one_activity_and_exactly_one_event_are_written(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """One POST, one row, one projection -- not two of either.

    The event's source pointer is asserted to land on the activity's own
    id and source type: a pointer into the wrong table is the failure this
    feature is most likely to ship with, and it is invisible from the feed
    card, which reads the snapshot.
    """
    owner = await login_user(client, telegram_id=_TID_OWNER)
    created = await _created(client, owner)

    assert await _count_activities(db_session, owner) == 1
    events = await _events(db_session, owner)
    assert len(events) == 1
    assert events[0].source_type == (
        DiaryEventSourceType.EXTERNAL_ACTIVITY.value
    )
    assert str(events[0].source_id) == created["id"]


@pytest.mark.asyncio
async def test_the_feed_shows_it_with_the_events_own_time_and_snapshot(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """occurred_at is the ACTIVITY's time, not the write time.

    THE ASSERTION THAT MATTERS IS THE INEQUALITY. Comparing occurred_at to
    the value sent proves the field was carried; comparing it to created_at
    proves it was not quietly replaced by the write time, which is what
    every other projection in this module passes and what a copy-paste
    would have produced here.
    """
    owner = await login_user(client, telegram_id=_TID_OWNER)
    when = datetime.now(UTC) - timedelta(days=5)
    created = await _created(
        client, owner, occurred_at=when.isoformat(), thoughts="Спина отпустила",
    )

    body = await _feed(client, owner)
    mine = [i for i in body["items"] if i["source_id"] == created["id"]]
    assert len(mine) == 1
    item = mine[0]

    assert item["kind"] == "external_activity"
    assert item["source_type"] == "external_activity"
    assert datetime.fromisoformat(item["occurred_at"]) == when
    assert datetime.fromisoformat(item["occurred_at"]) != (
        datetime.fromisoformat(item["created_at"])
    )
    assert item["snapshot"]["activity_type"] == "meditation"
    assert item["snapshot"]["mood"] == 6
    assert item["snapshot"]["thoughts_preview"] == "Спина отпустила"


@pytest.mark.asyncio
async def test_an_offset_other_than_utc_stores_the_same_instant(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """+03:00 and Z for the same moment are one stored value.

    Two activities, same instant written two ways: the feed must order
    them adjacently at an identical occurred_at rather than three hours
    apart, which is what storing the wall clock would produce.
    """
    owner = await login_user(client, telegram_id=_TID_OWNER)
    moment = datetime.now(UTC) - timedelta(days=1)
    in_utc = await _created(client, owner, occurred_at=moment.isoformat())
    in_msk = await _created(
        client,
        owner,
        occurred_at=moment.astimezone(timezone(timedelta(hours=3))).isoformat(),
    )

    assert (
        datetime.fromisoformat(in_utc["occurred_at"])
        == datetime.fromisoformat(in_msk["occurred_at"])
    )


# ===========================================================================
# Refusals. Every one is paired with a row count, not just a status.
# ===========================================================================


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("label", "overrides"),
    [
        ("custom без имени", {"activity_type": "custom"}),
        (
            "имя из пробелов у custom",
            {"activity_type": "custom", "custom_activity_name": "   "},
        ),
        (
            "имя у преднастроенного",
            {"activity_type": "yoga", "custom_activity_name": "Йога"},
        ),
        ("неизвестный тип", {"activity_type": "breathwork"}),
        ("mood 0", {"mood": 0}),
        ("mood 11", {"mood": 11}),
        ("mood не число", {"mood": "шесть"}),
    ],
)
async def test_a_malformed_body_is_422_and_writes_nothing(
    client: AsyncClient,
    db_session: AsyncSession,
    label: str,
    overrides: dict,
) -> None:
    """Seven refusals, each checked against an empty table.

    The row count is the half that makes this mean something: a 422 is
    also what a completely broken endpoint returns, and the same test would
    pass while nothing worked.
    """
    owner = await login_user(client, telegram_id=_TID_OWNER)
    resp = await _post(client, owner, **overrides)

    assert resp.status_code == 422, f"{label}: {resp.text}"
    assert await _count_activities(db_session, owner) == 0

    # ...and the endpoint is alive, in the same test.
    assert (await _post(client, owner)).status_code == 201
    assert await _count_activities(db_session, owner) == 1


@pytest.mark.asyncio
async def test_a_naive_timestamp_is_refused(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """No offset, no answer.

    A naive value would be stored as if it were UTC and would silently
    move the activity by the person's own offset -- a bug that looks like
    a timezone feature working badly rather than like an error.
    """
    owner = await login_user(client, telegram_id=_TID_OWNER)
    naive = (datetime.now(UTC) - timedelta(days=1)).replace(tzinfo=None)

    resp = await _post(client, owner, occurred_at=naive.isoformat())

    assert resp.status_code == 422, resp.text
    assert "occurred_at" in resp.text
    assert await _count_activities(db_session, owner) == 0


@pytest.mark.asyncio
async def test_a_future_timestamp_is_refused_and_now_is_allowed(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A diary of what happened cannot hold what has not.

    The boundary is asserted from both sides in one test: an hour ahead is
    refused, and a moment just past is accepted -- so "future" is a real
    edge and not a clock skew that would refuse everything.
    """
    owner = await login_user(client, telegram_id=_TID_OWNER)
    ahead = datetime.now(UTC) + timedelta(hours=1)

    refused = await _post(client, owner, occurred_at=ahead.isoformat())
    assert refused.status_code == 422, refused.text
    assert await _count_activities(db_session, owner) == 0

    just_past = datetime.now(UTC) - timedelta(seconds=5)
    accepted = await _post(client, owner, occurred_at=just_past.isoformat())
    assert accepted.status_code == 201, accepted.text


@pytest.mark.asyncio
async def test_text_over_the_configured_limits_is_refused(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Both limits, and both read from settings rather than retyped.

    Hard-coded 10000 and 120 here would keep passing after somebody
    lowered the setting, which is the moment the check stops describing
    the product.
    """
    owner = await login_user(client, telegram_id=_TID_OWNER)

    long_thoughts = "я" * (settings.diary_entry_content_max_length + 1)
    resp = await _post(client, owner, thoughts=long_thoughts)
    assert resp.status_code == 422, resp.text

    long_name = "и" * (settings.external_activity_name_max_length + 1)
    resp = await _post(
        client,
        owner,
        activity_type="custom",
        custom_activity_name=long_name,
    )
    assert resp.status_code == 422, resp.text
    assert await _count_activities(db_session, owner) == 0

    at_limit = "и" * settings.external_activity_name_max_length
    ok = await _post(
        client, owner, activity_type="custom", custom_activity_name=at_limit,
    )
    assert ok.status_code == 201, ok.text


@pytest.mark.asyncio
async def test_blank_thoughts_become_absence_not_a_blank_line(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Whitespace is absence everywhere it travels.

    Checked in three places at once, because the value is copied into
    three: the response, the snapshot preview and text_search. A blank
    string surviving into text_search would make the feed's ilike match
    this activity for any query containing a space.
    """
    owner = await login_user(client, telegram_id=_TID_OWNER)
    created = await _created(client, owner, thoughts="   ")

    assert created["thoughts"] is None

    events = await _events(db_session, owner)
    assert len(events) == 1
    assert events[0].snapshot["thoughts_preview"] is None
    assert events[0].text_search is None


@pytest.mark.asyncio
async def test_an_unauthenticated_request_is_401_and_an_authenticated_one_works(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The refusal and the acceptance in one test.

    401 rather than 403: this router's own precedent
    (test_diary_entries.py, POST /diary with no auth), verified rather
    than assumed.
    """
    anonymous = await client.post(ACTIVITIES_URL, json=_body())
    assert anonymous.status_code == 401, anonymous.text

    owner = await login_user(client, telegram_id=_TID_OWNER)
    assert (await _post(client, owner)).status_code == 201


# ===========================================================================
# The transaction, the chronology and the chips
# ===========================================================================


@pytest.mark.asyncio
async def test_a_failing_projection_leaves_no_orphan_activity(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The activity and its event live or die together.

    The projection is made to raise, and the assertion is on the TABLE,
    not on the status code: an activity that survived a failed projection
    would be a row the person can never see in the feed and can never
    delete, since BE-27 ships no delete. This is why the service has no
    try/except around the projection -- catching would produce exactly
    that orphan.

    pytest.raises AND NOT a 500 assertion: the ASGI transport the suite
    uses re-raises an unhandled error into the test rather than turning it
    into a response, so an `assert status >= 500` here would be a line that
    never runs. What the person would see in production is a 500 from the
    app's own handler; what this test can observe is that the request
    failed and the table stayed empty.

    The unpatched POST at the end proves the failure was the patch and not
    the endpoint.
    """
    owner = await login_user(client, telegram_id=_TID_OWNER)

    with patch(
        "app.modules.diary.external_activity_service."
        "add_external_activity_event",
        side_effect=RuntimeError("projection exploded"),
    ), pytest.raises(RuntimeError, match="projection exploded"):
        await client.post(
            ACTIVITIES_URL,
            json=_body(),
            headers=auth_headers(owner["session_token"]),
        )

    assert await _count_activities(db_session, owner) == 0
    assert await _events(db_session, owner) == []

    assert (await _post(client, owner)).status_code == 201
    assert await _count_activities(db_session, owner) == 1


@pytest.mark.asyncio
async def test_the_practices_chip_includes_it_and_the_entries_chip_does_not(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Contract: the new kind joins the existing `practices` chip.

    Both chips are asserted, because "present under practices" alone would
    also pass if the chip filter had stopped filtering entirely.
    """
    owner = await login_user(client, telegram_id=_TID_OWNER)
    created = await _created(client, owner)

    under_practices = await _feed(client, owner, category="practices")
    assert created["id"] in [
        i["source_id"] for i in under_practices["items"]
    ]

    under_entries = await _feed(client, owner, category="entries")
    assert created["id"] not in [
        i["source_id"] for i in under_entries["items"]
    ]


@pytest.mark.asyncio
async def test_two_activities_at_the_same_instant_both_survive_paging(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A tie in occurred_at must not swallow or duplicate a row.

    The feed's cursor packs (occurred_at, id) precisely so equal timestamps
    stay totally ordered. Three activities share one instant and are read
    two at a time: the union across pages has to be three distinct ids,
    which is false both when the tie loses a row and when it repeats one.
    """
    owner = await login_user(client, telegram_id=_TID_OWNER)
    moment = (datetime.now(UTC) - timedelta(days=3)).isoformat()
    made = {
        (await _created(client, owner, occurred_at=moment))["id"]
        for _ in range(3)
    }
    assert len(made) == 3

    seen: list[str] = []
    cursor = None
    for _ in range(4):
        params: dict = {"limit": 2}
        if cursor:
            params["cursor"] = cursor
        page = await _feed(client, owner, **params)
        seen.extend(i["source_id"] for i in page["items"])
        cursor = page["next_cursor"]
        if not cursor:
            break

    assert made <= set(seen)
    assert len(seen) == len(set(seen))


@pytest.mark.asyncio
async def test_it_sorts_by_the_event_time_among_other_diary_records(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Older than everything and newer than everything, in one feed.

    Two activities entered in the same second, one dated last year and one
    dated a minute ago, must land at opposite ends -- which is only true
    if the sort key is occurred_at and not created_at.
    """
    owner = await login_user(client, telegram_id=_TID_OWNER)
    old = await _created(
        client,
        owner,
        occurred_at=(datetime.now(UTC) - timedelta(days=365)).isoformat(),
    )
    recent = await _created(
        client,
        owner,
        occurred_at=(datetime.now(UTC) - timedelta(minutes=1)).isoformat(),
    )

    ids = [i["source_id"] for i in (await _feed(client, owner))["items"]]
    assert ids.index(recent["id"]) < ids.index(old["id"])


@pytest.mark.asyncio
async def test_another_persons_activity_is_not_in_my_feed(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The diary is per person, and this is the cheap proof of it."""
    owner = await login_user(client, telegram_id=_TID_OWNER)
    other = await login_user(client, telegram_id=_TID_OTHER)
    mine = await _created(client, owner)
    theirs = await _created(client, other)

    ids = [i["source_id"] for i in (await _feed(client, owner))["items"]]
    assert mine["id"] in ids
    assert theirs["id"] not in ids


@pytest.mark.asyncio
async def test_deleting_the_person_takes_the_activity_and_the_event(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Both FKs cascade from users, and neither row is left behind."""
    owner = await login_user(client, telegram_id=_TID_OWNER)
    await _created(client, owner)
    assert await _count_activities(db_session, owner) == 1

    await db_session.delete(
        await db_session.get(User, UUID(owner["user"]["id"]))
    )
    await db_session.commit()

    assert await _count_activities(db_session, owner) == 0
    assert await _events(db_session, owner) == []


# ===========================================================================
# The audit row
# ===========================================================================


@pytest.mark.asyncio
async def test_the_audit_row_records_structure_and_not_the_persons_text(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """An audit trail is read by operators; a diary is not.

    The row exists and carries the type and the time. The two free-text
    fields -- the thoughts and the name the person invented -- are asserted
    ABSENT from the whole serialized row, so a future `data={**payload}`
    fails here rather than in a support queue.
    """
    owner = await login_user(client, telegram_id=_TID_OWNER)
    await _created(
        client,
        owner,
        activity_type="custom",
        custom_activity_name="Ледяная купель",
        thoughts="Очень личное",
    )

    row = (
        await db_session.execute(
            select(AuditLog).where(
                AuditLog.event == "external_activity_created",
                AuditLog.actor_id == UUID(owner["user"]["id"]),
            )
        )
    ).scalars().one()

    assert row.data["activity_type"] == "custom"
    assert "occurred_at" in row.data
    serialized = str(row.data)
    assert "Ледяная купель" not in serialized
    assert "Очень личное" not in serialized


# ===========================================================================
# The two literals that must agree
# ===========================================================================


@pytest.mark.asyncio
async def test_the_activity_enum_and_the_db_constraint_agree(
    db_session: AsyncSession,
) -> None:
    """Seven values, written twice, kept equal by this test alone.

    ExternalActivityType lives in Python; ck_external_activity_type lives
    in a migration that must never be edited once applied. Nothing but this
    comparison connects them, and the failure mode without it is a value
    the API accepts and the database rejects -- a 500 on a valid request.
    """
    in_db = await _constraint_literals(db_session, "ck_external_activity_type")
    assert in_db == {t.value for t in ExternalActivityType}


@pytest.mark.asyncio
async def test_the_diary_dictionaries_and_their_constraints_agree(
    db_session: AsyncSession,
) -> None:
    """The same guard for the two dictionaries BE-27 widened.

    Both were widened in two places -- the Python enum and the CHECK -- and
    the source-type list already had a value (`thread`) that a careless
    rewrite would have dropped.
    """
    kinds = await _constraint_literals(db_session, "ck_diary_event_kind")
    assert kinds == {k.value for k in DiaryEventKind}

    sources = await _constraint_literals(
        db_session, "ck_diary_event_source_type",
    )
    assert sources == {s.value for s in DiaryEventSourceType}


def test_the_new_kind_is_wired_into_both_config_lists() -> None:
    """A kind absent from diary_feed_categories never reaches its chip.

    diary_feed_allowed_kinds is asserted too, and deliberately -- not
    because it gates anything (it gates nothing; see its own comment in
    config.py) but because a list that has drifted from the enum lies to
    whoever reads it next.
    """
    kind = DiaryEventKind.EXTERNAL_ACTIVITY.value
    assert kind in settings.diary_feed_categories["practices"]
    assert kind in settings.diary_feed_allowed_kinds


# ===========================================================================
# GT-32a -- where a validation error is addressed
#
# Contract 4.1 justifies 422 with "so the frontend can bind them to
# fields". Two refusals used to arrive with an empty loc, because pydantic
# gives a model validator no field to point at; the rule now lives in a
# field_validator on custom_activity_name.
# ===========================================================================


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("label", "overrides"),
    [
        ("ключа нет вовсе", {"activity_type": "custom"}),
        (
            "ключ есть, значение null",
            {"activity_type": "custom", "custom_activity_name": None},
        ),
        (
            "значение из пробелов",
            {"activity_type": "custom", "custom_activity_name": "   "},
        ),
        (
            "имя у преднастроенного",
            {"activity_type": "yoga", "custom_activity_name": "Йога"},
        ),
    ],
)
async def test_the_custom_name_refusal_names_its_field(
    client: AsyncClient,
    db_session: AsyncSession,
    label: str,
    overrides: dict,
) -> None:
    """All four shapes of the cross-field refusal point at the input.

    THE FIRST CASE IS THE ONE THAT NEARLY BROKE. A field_validator does not
    run when the key is absent from the body, so moving the rule off the
    model validator without validate_default=True would have turned "custom
    with no name" -- the commonest of the two mistakes -- into a 201. The
    other three would still have carried a proper loc and the fix would
    have looked done.
    """
    owner = await login_user(client, telegram_id=_TID_OWNER)

    assert await _locs(client, owner, **overrides) == [
        ("body", "custom_activity_name")
    ], label
    assert await _count_activities(db_session, owner) == 0


@pytest.mark.asyncio
async def test_the_other_five_refusals_keep_the_field_they_had(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Moving one validator must not move the addresses of the rest.

    Pinned rather than assumed: a field_validator changes execution order
    relative to the model validator that used to run last, and occurred_at
    and mood are the two that could have been dragged along. An empty body
    is included because it is the case where every required field reports
    at once.
    """
    owner = await login_user(client, telegram_id=_TID_OWNER)
    ahead = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    naive = (datetime.now(UTC) - timedelta(days=1)).replace(
        tzinfo=None,
    ).isoformat()
    long_name = "и" * (settings.external_activity_name_max_length + 1)

    assert await _locs(
        client, owner, occurred_at=ahead,
    ) == [("body", "occurred_at")]
    assert await _locs(
        client, owner, occurred_at=naive,
    ) == [("body", "occurred_at")]
    assert await _locs(client, owner, activity_type="breathwork") == [
        ("body", "activity_type")
    ]
    assert await _locs(client, owner, mood=11) == [("body", "mood")]
    assert await _locs(
        client, owner, activity_type="custom", custom_activity_name=long_name,
    ) == [("body", "custom_activity_name")]

    empty = await client.post(
        ACTIVITIES_URL, json={}, headers=auth_headers(owner["session_token"]),
    )
    assert empty.status_code == 422, empty.text
    assert sorted(tuple(e["loc"]) for e in empty.json()["detail"]) == [
        ("body", "activity_type"),
        ("body", "mood"),
        ("body", "occurred_at"),
    ]


@pytest.mark.asyncio
async def test_an_unknown_type_with_a_name_refuses_once_by_the_type(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """One refusal, and it points at the field that is actually wrong.

    info.data holds only the fields that PASSED, so an unknown
    activity_type is simply absent from it and the name rule steps aside.
    Reading it with an index instead of .get() would raise a KeyError here
    -- a 500 in place of a 422; returning a second refusal about the name
    would send the person to correct an input that is fine.
    """
    owner = await login_user(client, telegram_id=_TID_OWNER)

    assert await _locs(
        client, owner, activity_type="breathwork", custom_activity_name="x",
    ) == [("body", "activity_type")]
    assert await _count_activities(db_session, owner) == 0


@pytest.mark.asyncio
async def test_a_bad_mood_and_a_missing_name_now_both_report(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """TWO refusals where there used to be one -- a named change, not a bug.

    A field-level failure cancels a model validator, so before GT-32a this
    body answered with `mood` alone and the person learned about the
    missing name only after fixing the score. Field validators do not
    cancel each other, so both now report, each against its own input.
    Anybody who finds two errors here and expects one should read this
    docstring rather than "fix" it back.
    """
    owner = await login_user(client, telegram_id=_TID_OWNER)

    assert await _locs(
        client, owner, activity_type="custom", mood=11,
    ) == [("body", "custom_activity_name"), ("body", "mood")]
    assert await _count_activities(db_session, owner) == 0
