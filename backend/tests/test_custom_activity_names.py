# =============================================================================
# VELO Backend -- Tests: the composer remembers your own custom names (BE-37)
# =============================================================================
#
# telegram_id band: 68400-68499 (owner 68401, stranger 68402).
# Declared module-level below as _TID_MIN/_TID_MAX, ONCE --
# tests/telegram_id_bands.py parses that declaration out of the AST on every
# run, and a file using ids without declaring a band fails
# test_blind_zone_has_not_grown. Checked free before it was claimed:
# free_windows(space=(68000, 68999)) returned [(68400, 68999)].
#
# THREE PROPERTIES CARRY THIS FEATURE, and each has a test whose only job is
# to catch its inversion:
#
#   - ONLY YOUR OWN NAMES. Asserted as a pair in one test -- mine present
#     AND the stranger's absent -- because either half alone passes in a
#     world where the endpoint returns nothing.
#   - CASE IS FOLDED, SPELLING IS THE FRESHEST. "Йога" and "йога" are one
#     activity typed twice; showing both spends two of eight slots on one
#     thing.
#   - THE ORDER IS A PROPERTY OF THE DATA, NOT OF THE RUN. Two ties exist
#     and both are broken explicitly -- see the ordering tests. Neither
#     tie-break is by id: it is a UUID, stable inside a run and random
#     between them, which is the defect this line shipped in BE-30 and
#     repaired in GT-35.
#
# THE SUITE RUNS TWICE ON THE STAND AND ONCE HERE, so a test that asserts an
# order has to assert it against something the data decides. Where that is
# what is being tested, the call is made twice inside the test itself.
#
# ROWS ARE SEEDED, NOT POSTED. The write path is BE-27's and is tested
# there; building twelve activities through the endpoint would test it
# again and slowly. The seeds carry the shape the writer produces: a name
# exactly when the type is custom.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.modules.diary.models import ExternalActivity
from tests.helpers import auth_headers, full_cleanup_range, login_user

NAMES_URL = "/api/v1/diary/external-activities/custom-names"

_TID_MIN = 68400
_TID_MAX = 68499

_TID_OWNER = 68401
_TID_STRANGER = 68402

_BASE = datetime.now(UTC) - timedelta(days=60)


# ===========================================================================
# Local helpers. Copied rather than imported, the convention here.
# ===========================================================================


async def _person(client: AsyncClient, telegram_id: int) -> dict:
    return await login_user(client, telegram_id=telegram_id)


async def _seed(
    db_session: AsyncSession,
    who: dict,
    name: str | None,
    day: float,
    *,
    activity_type: str = "custom",
) -> None:
    """One external activity, placed on the timeline by `day`.

    `name=None` with a preset type is the other side of the DB constraint:
    a name exists exactly when the type is custom, and the suggestions must
    not pick those rows up.
    """
    db_session.add(
        ExternalActivity(
            user_id=UUID(who["user"]["id"]),
            occurred_at=_BASE + timedelta(days=day),
            activity_type=activity_type,
            custom_activity_name=name,
            mood=6,
        )
    )
    await db_session.flush()
    await db_session.commit()


async def _names(client: AsyncClient, who: dict) -> list[str]:
    resp = await client.get(
        NAMES_URL, headers=auth_headers(who["session_token"]),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


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
# Whose names, and which
# ===========================================================================


@pytest.mark.asyncio
async def test_my_names_come_back_and_a_strangers_do_not(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The pair, in one test, because neither half means anything alone.

    "The stranger's name is absent" passes on an endpoint that returns an
    empty list for everyone; "my name is present" passes on an endpoint
    that returns everybody's. Privacy here is by construction -- the query
    filters on user_id and takes no parameter that could widen it -- and
    this is what holds that claim up.
    """
    owner = await _person(client, _TID_OWNER)
    stranger = await _person(client, _TID_STRANGER)
    await _seed(db_session, owner, "Бальные танцы", 1)
    await _seed(db_session, stranger, "Капоэйра", 2)

    assert await _names(client, owner) == ["Бальные танцы"]
    assert await _names(client, stranger) == ["Капоэйра"]


@pytest.mark.asyncio
async def test_preset_activities_contribute_nothing(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Only custom rows carry a name, and only they are read.

    The filter is on `custom_activity_name IS NOT NULL` rather than on the
    type, because a null in a list of names is the thing to prevent and
    the null check is what prevents it. The preset row here has no name by
    the DB constraint, so it cannot appear -- and the custom row alongside
    it is what shows the endpoint is alive while it does not.
    """
    owner = await _person(client, _TID_OWNER)
    await _seed(db_session, owner, None, 1, activity_type="meditation")
    await _seed(db_session, owner, None, 2, activity_type="massage")

    assert await _names(client, owner) == []

    await _seed(db_session, owner, "Бальные танцы", 3)
    assert await _names(client, owner) == ["Бальные танцы"]


@pytest.mark.asyncio
async def test_a_person_with_no_activities_gets_an_empty_list(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Nothing to suggest is an empty list, not an error and not a 404."""
    owner = await _person(client, _TID_OWNER)

    resp = await client.get(
        NAMES_URL, headers=auth_headers(owner["session_token"]),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"items": []}


@pytest.mark.asyncio
async def test_an_unauthenticated_request_is_refused(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """401 without a token, 200 with one -- the pair in one test."""
    owner = await _person(client, _TID_OWNER)
    await _seed(db_session, owner, "Бальные танцы", 1)

    anonymous = await client.get(NAMES_URL)
    assert anonymous.status_code == 401, anonymous.text

    assert await _names(client, owner) == ["Бальные танцы"]


# ===========================================================================
# Folding case
# ===========================================================================


@pytest.mark.asyncio
async def test_three_spellings_are_one_name_in_its_freshest_form(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """"Йога", "ЙОГА", "йога" -- one slot, spelled as last typed.

    Showing all three would spend three of eight slots on one activity,
    which at a limit of eight is most of the screen. The freshest spelling
    is returned rather than the first or a folded one, because the person
    last chose to write it that way.

    CYRILLIC FOLDING IS A PROPERTY OF THE DATABASE, not of Python: the
    grouping happens in SQL. If a deployment ever runs on a collation
    where lower() leaves Cyrillic alone, this test fails there -- loudly,
    which is the point of asserting the exact list. Which SPELLING wins a
    tie is a separate question and is pinned to byte order in the query;
    see the ordering tests.
    """
    owner = await _person(client, _TID_OWNER)
    await _seed(db_session, owner, "Йога", 1)
    await _seed(db_session, owner, "ЙОГА", 3)
    await _seed(db_session, owner, "йога", 5)

    assert await _names(client, owner) == ["йога"]


@pytest.mark.asyncio
async def test_names_differing_inside_are_two_names(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Inner spacing is NOT normalised, and that is a decision.

    Folding case is reading the same word typed twice; folding inner
    whitespace is guessing at what somebody meant. The second is a
    different decision and was not taken, so two spellings that differ
    inside stay two names -- pinned here so nobody "fixes" it into one on
    the strength of the case-folding above.
    """
    owner = await _person(client, _TID_OWNER)
    await _seed(db_session, owner, "Йога нидра", 1)
    await _seed(db_session, owner, "Йога  нидра", 2)

    assert sorted(await _names(client, owner)) == [
        "Йога  нидра", "Йога нидра",
    ]


# ===========================================================================
# Order, and the two ties inside it
# ===========================================================================


@pytest.mark.asyncio
async def test_the_freshest_use_comes_first(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """By last use, not by first, and not by when the row was written.

    The oldest name is seeded LAST, so a query ordering by insertion would
    produce exactly the reverse of this.
    """
    owner = await _person(client, _TID_OWNER)
    await _seed(db_session, owner, "Свежее", 9)
    await _seed(db_session, owner, "Среднее", 5)
    await _seed(db_session, owner, "Старое", 1)

    assert await _names(client, owner) == ["Свежее", "Среднее", "Старое"]


@pytest.mark.asyncio
async def test_two_names_used_at_the_same_moment_both_survive(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A tie must not cost a name, and their ORDER is not asserted.

    This test used to demand ["Бальные танцы", "Массаж"] and was green --
    but on the strength of the DATA, not of the code: the two differ by
    their first letter at the same case, which every collation orders the
    same way. Put two names of different case in this fixture and the
    literal flips between a linguistic collation and a byte one. A test
    that holds because of the rows it happens to use is a delayed failure.

    What matters and is asserted: neither name is swallowed when their
    freshest use coincides. Which comes first is a tie-break, and a
    tie-break's result is not a promise to anybody.
    """
    owner = await _person(client, _TID_OWNER)
    await _seed(db_session, owner, "Массаж", 7)
    await _seed(db_session, owner, "Бальные танцы", 7)

    assert sorted(await _names(client, owner)) == [
        "Бальные танцы", "Массаж",
    ]


@pytest.mark.asyncio
async def test_two_spellings_at_the_same_moment_are_still_one_name(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Folding does not need a fresher use to prefer; it needs one row.

    WHICH SPELLING WINS IS NOT ASSERTED, AND THAT IS THE POINT. The query
    breaks the tie on the name, and string order in postgres comes from
    the database's collation: "ЙОГА" sorts before "Йога" under C.UTF-8 and
    after it under a linguistic one. Nobody decided which spelling of a
    person's own name deserves the slot, so there is nothing here to pin
    -- and an earlier version of this test pinned it anyway, passed on one
    database and failed on the stand.

    What the tie-break is for is that the answer does not move between
    runs on a given server. That property is not observable from a test:
    two calls in one process share a plan and would agree even without it.
    So it is left unasserted rather than asserted falsely.
    """
    owner = await _person(client, _TID_OWNER)
    await _seed(db_session, owner, "ЙОГА", 4)
    await _seed(db_session, owner, "Йога", 4)

    items = await _names(client, owner)

    assert len(items) == 1
    assert items[0] in ("ЙОГА", "Йога")


# ===========================================================================
# The limit
# ===========================================================================


@pytest.mark.asyncio
async def test_more_names_than_the_limit_are_cut_by_recency(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The limit counts NAMES, and the ones dropped are the stalest.

    Nine names are seeded and the oldest is the one that goes. The number
    comes from settings rather than a literal 8, so lowering the setting
    moves the test with the product instead of leaving it asserting
    history.
    """
    owner = await _person(client, _TID_OWNER)
    limit = settings.external_activity_name_suggestions
    for index in range(limit + 1):
        await _seed(db_session, owner, f"Имя-{index:02d}", index + 1)

    items = await _names(client, owner)

    assert len(items) == limit
    assert items[0] == f"Имя-{limit:02d}"
    assert "Имя-00" not in items


@pytest.mark.asyncio
async def test_the_limit_counts_folded_names_and_not_rows(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Repeating one name does not consume the whole list.

    The same activity typed twenty times is one suggestion; a limit
    applied to ROWS instead of names would fill the screen with it and
    push out everything else. That is the arithmetic this test pins.
    """
    owner = await _person(client, _TID_OWNER)
    for day in range(20):
        await _seed(db_session, owner, "Йога", day + 1)
    await _seed(db_session, owner, "Бальные танцы", 30)

    assert await _names(client, owner) == ["Бальные танцы", "Йога"]
