# =============================================================================
# VELO Backend -- Tests: the school name rule (BE-48 / BE-49)
# =============================================================================
#
# telegram_id band: 70700-70799, declared once below as _TID_MIN/_TID_MAX
# (checked free against tests/telegram_id_bands.py at packaging -- the first
# pick, 70700-70799, was claimed by BE-75 in between and the registry said so).
#
# Two names of ONE curator are the same school name when they match ignoring
# case and with whitespace collapsed (owner decisions, 2026-10-03). The rule
# lives in SQL only -- curator_groups.models.curator_group_name_key -- and is
# enforced twice: the service's pre-checks answer a clean 409 before any
# write, and the unique index uq_curator_group_curator_name_key catches what
# a race slips past the pre-check. The transfer row of the grid lives in
# test_curator_transfer.py beside its helpers.
# =============================================================================

import asyncio
from collections.abc import AsyncGenerator
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import event, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_engine
from app.modules.curator_groups.models import CuratorGroup, curator_group_name_key
from app.modules.masters.models import MasterProfile
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

GROUPS_URL = "/api/v1/masters/me/curator-groups"
GROUP_URL = "/api/v1/masters/me/curator-groups/{group_id}"

_TID_MIN = 70700
_TID_MAX = 70799

NBSP = "\u00a0"

# (a, b, same name by the rule?) -- the battery the builder and the index
# are both held to.
_PAIRS = [
    ("Школа Йоги", "школа йоги", True),  # case
    ("Ёлка", "ёЛКА", True),  # Ё folds like any capital
    ("Школа Йоги", "Школа  Йоги", True),  # doubled inner space
    ("Школа Йоги", "Школа\tЙоги", True),  # tab
    ("Школа Йоги", f"Школа{NBSP}Йоги", True),  # no-break space
    ("Школа Йоги", "Школа\u2003Йоги", True),  # em space (Postgres \s)
    ("Ёлка", "Елка", False),  # ё and е are different letters
    ("Школа Йоги", "ШколаЙоги", False),  # a space is not nothing
    ("Школа Йоги", "Школа Йога", False),  # a different word
]


@pytest.fixture(autouse=True)
async def _clean_band(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


async def _curator(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int
) -> dict:
    """A verified master allowed to found schools."""
    auth = await login_user(client, telegram_id=telegram_id, first_name="Куратор")
    user = await db_session.get(User, UUID(auth["user"]["id"]))
    user.role = UserRole.MASTER
    db_session.add(
        MasterProfile(
            user_id=user.id,
            data={
                "account": {"status": "verified", "can_create_groups": True},
                "profile": {"bio": "m"},
            },
        )
    )
    await db_session.commit()
    return auth


async def _create(client: AsyncClient, who: dict, name: str):
    return await client.post(
        GROUPS_URL, json={"name": name}, headers=auth_headers(who["session_token"])
    )


# =============================================================================
# The builder and the index give the same answers (drift guard)
# =============================================================================


@pytest.mark.parametrize(("a", "b", "same"), _PAIRS)
async def test_the_index_rejects_exactly_what_the_builder_calls_the_same(
    client: AsyncClient,
    db_session: AsyncSession,
    a: str,
    b: str,
    same: bool,
):
    """The builder (models.py) and the index the MIGRATION created must agree
    on every pair: if the two literals ever drift, some pair here splits."""
    key_equal = (
        await db_session.execute(
            select(curator_group_name_key(a) == curator_group_name_key(b))
        )
    ).scalar_one()
    assert key_equal is same

    curator = await _curator(client, db_session, 70701)
    owner = UUID(curator["user"]["id"])
    db_session.add(CuratorGroup(curator_user_id=owner, name=a))
    await db_session.commit()
    rejected = False
    try:
        async with db_session.begin_nested():
            db_session.add(CuratorGroup(curator_user_id=owner, name=b))
            await db_session.flush()
    except IntegrityError:
        rejected = True
    await db_session.rollback()
    assert rejected is same


async def test_the_index_is_the_new_one_and_the_old_is_gone(db_session: AsyncSession):
    """The migration's result, read from pg_indexes, not from the model."""
    names = set(
        (
            await db_session.execute(
                text(
                    "SELECT indexname FROM pg_indexes WHERE tablename = 'curator_group'"
                    " AND indexname LIKE 'uq_curator_group_curator_name%'"
                )
            )
        ).scalars()
    )
    assert names == {"uq_curator_group_curator_name_key"}


# =============================================================================
# Create and rename, through the API
# =============================================================================


@pytest.mark.parametrize(
    ("second", "expected"),
    [
        ("Школа Елены", 409),  # exact
        ("школа ЕЛЕНЫ", 409),  # case
        ("  Школа   Елены ", 409),  # spaces: edges stripped, inner collapsed
        (f"Школа{NBSP}Елены", 409),  # no-break space
        ("Школа\tЕлены", 409),  # tab
        ("Школа Ёлены", 201),  # е -> ё: a different letter, a different name
    ],
)
async def test_create_clashes_by_the_rule(
    client: AsyncClient,
    db_session: AsyncSession,
    second: str,
    expected: int,
):
    curator = await _curator(client, db_session, 70710)
    assert (await _create(client, curator, "Школа Елены")).status_code == 201
    resp = await _create(client, curator, second)
    assert resp.status_code == expected, resp.text
    if expected == 409:
        assert resp.json()["error"] == "curator_group_name_taken"
        # The same phrase on the client for both refusals (BE-50): one code.


async def test_another_curator_may_use_the_same_name_by_the_rule(
    client: AsyncClient,
    db_session: AsyncSession,
):
    first = await _curator(client, db_session, 70720)
    second = await _curator(client, db_session, 70721)
    assert (await _create(client, first, "Школа Йоги")).status_code == 201
    assert (await _create(client, second, "школа  йоги")).status_code == 201


async def test_rename_onto_a_sibling_clashes_by_the_rule(
    client: AsyncClient,
    db_session: AsyncSession,
):
    curator = await _curator(client, db_session, 70730)
    headers = auth_headers(curator["session_token"])
    await _create(client, curator, "Школа Елены")
    other = (await _create(client, curator, "Вторая")).json()
    url = GROUP_URL.format(group_id=other["id"])

    clash = await client.patch(
        url, json={"name": f"школа{NBSP} елены"}, headers=headers
    )
    assert clash.status_code == 409
    assert clash.json()["error"] == "curator_group_name_taken"
    # ё against е is a different name: the rename goes through.
    fine = await client.patch(url, json={"name": "Школа Ёлены"}, headers=headers)
    assert fine.status_code == 200, fine.text


# =============================================================================
# The pre-check answers BEFORE any write; the index answers the race
# =============================================================================


async def test_the_pre_check_refuses_before_any_insert(
    client: AsyncClient,
    db_session: AsyncSession,
):
    """A clash by the rule is refused by the pre-check, not by the index: no
    INSERT INTO curator_group is even attempted. (Without the pre-check the
    index would still answer 409 -- this is what tells the two apart.)"""
    curator = await _curator(client, db_session, 70740)
    assert (await _create(client, curator, "Школа Йоги")).status_code == 201

    inserts: list[str] = []

    def _watch(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("INSERT INTO CURATOR_GROUP "):
            inserts.append(statement)

    sync_engine = get_engine().sync_engine
    event.listen(sync_engine, "before_cursor_execute", _watch)
    try:
        resp = await _create(client, curator, "школа  йоги")
    finally:
        event.remove(sync_engine, "before_cursor_execute", _watch)
    assert resp.status_code == 409
    assert inserts == []
    # The pair: the watcher does see an insert when one happens.
    event.listen(sync_engine, "before_cursor_execute", _watch)
    try:
        assert (await _create(client, curator, "Другая")).status_code == 201
    finally:
        event.remove(sync_engine, "before_cursor_execute", _watch)
    assert len(inserts) == 1


async def test_two_spellings_racing_end_as_one_school(
    client: AsyncClient,
    db_session: AsyncSession,
):
    """Two creators racing with two spellings of one name: exactly one 201,
    the other the same 409 -- whichever of the pre-check or the index stops
    it. A symmetric race, so gather is enough (no lock order is involved)."""
    curator = await _curator(client, db_session, 70750)
    a, b = await asyncio.gather(
        _create(client, curator, "Школа Йоги"),
        _create(client, curator, "школа ЙОГИ"),
    )
    assert sorted((a.status_code, b.status_code)) == [201, 409]
    loser = a if a.status_code == 409 else b
    assert loser.json()["error"] == "curator_group_name_taken"
    count = (
        await db_session.execute(
            select(func.count())
            .select_from(CuratorGroup)
            .where(CuratorGroup.curator_user_id == UUID(curator["user"]["id"]))
        )
    ).scalar_one()
    assert count == 1
