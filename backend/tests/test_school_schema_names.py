# =============================================================================
# VELO -- Tests: the database names the school "school" (BE-90 step 2)
# =============================================================================
# Owner ruling 2026-11-01: the entity is "school" everywhere. Revision
# be90a1b2c3d4 renamed every database object that carried the old name
# curator_group -- tables, columns, indexes, keys, constraints (Postgres'
# automatic names included), the journal's sequence, the trigger function's
# body and the CHECK's expression.
#
# READ FROM THE CATALOG, NOT FROM THE MODELS. The models were renamed in the
# same delivery; asking them would check the delivery against itself. The
# suite's database is migrated to head once per session (conftest), so
# pg_catalog here is what `alembic upgrade head` produced.
#
# Every "nothing carries the old name" below is paired with "the new names
# are there": an empty catalog -- a wrong schema, a database that was never
# migrated -- would otherwise pass every absence check.
#
# THE DATA HALF is the last test: the revision itself, run backwards and
# forwards inside ONE transaction that is rolled back (DDL is transactional
# in Postgres), with rows written in the old shape between the two. Nothing
# it does outlives the test.
#
# No telegram ids: the users it writes carry none, and they are rolled back.
# =============================================================================

import importlib.util
import json
from pathlib import Path
from uuid import uuid4

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_engine

_REVISION = (
    Path(__file__).resolve().parent.parent
    / "migrations" / "versions" / "2026_11_01_be90a1b2c3d4_schools_rename.py"
)

_OLD = "%curator_group%"

_TABLES = {
    "school",
    "school_member",
    "school_block",
    "school_invite",
    "school_transfer",
    "school_master_offer",
    "school_event",
}


async def _strings(session: AsyncSession, sql: str) -> set[str]:
    return set((await session.execute(text(sql), {"old": _OLD})).scalars())


@pytest.mark.asyncio
async def test_the_seven_school_tables_exist_and_none_has_the_old_name(
    db_session: AsyncSession,
):
    tables = await _strings(
        db_session,
        "SELECT c.relname FROM pg_class c"
        " JOIN pg_namespace n ON n.oid = c.relnamespace"
        " WHERE n.nspname = 'public' AND c.relkind = 'r'"
        " AND c.relname LIKE 'school%'",
    )
    assert tables == _TABLES
    old = await _strings(
        db_session,
        "SELECT c.relname FROM pg_class c"
        " JOIN pg_namespace n ON n.oid = c.relnamespace"
        " WHERE n.nspname = 'public' AND c.relname LIKE :old",
    )
    # Tables, indexes, sequences and views alike: relkind is not filtered.
    assert old == set()


@pytest.mark.asyncio
async def test_no_column_constraint_or_index_carries_the_old_name(
    db_session: AsyncSession,
):
    school_columns = await _strings(
        db_session,
        "SELECT table_name || '.' || column_name"
        " FROM information_schema.columns"
        " WHERE table_schema = 'public' AND column_name = 'school_id'",
    )
    assert school_columns == {f"{t}.school_id" for t in _TABLES - {"school"}} | {
        "practices.school_id",
    }
    assert await _strings(
        db_session,
        "SELECT table_name || '.' || column_name"
        " FROM information_schema.columns"
        " WHERE table_schema = 'public' AND column_name LIKE :old",
    ) == set()
    # A school table keeps no group_id: the column moved with the table.
    assert await _strings(
        db_session,
        "SELECT table_name FROM information_schema.columns"
        " WHERE table_schema = 'public' AND column_name = 'group_id'"
        " AND table_name LIKE 'school%'",
    ) == set()

    constraints = await _strings(
        db_session,
        "SELECT conname FROM pg_constraint WHERE conname LIKE 'school%'"
        " OR conname LIKE 'fk_practices_school%'",
    )
    assert "school_pkey" in constraints
    assert "fk_practices_school_id_school" in constraints
    assert await _strings(
        db_session,
        "SELECT conname FROM pg_constraint WHERE conname LIKE :old",
    ) == set()
    # Definitions too: a CHECK or a key whose NAME was renamed could still
    # spell the old column or value in its body.
    assert await _strings(
        db_session,
        "SELECT conname FROM pg_constraint"
        " WHERE pg_get_constraintdef(oid) LIKE :old",
    ) == set()
    assert await _strings(
        db_session,
        "SELECT indexname FROM pg_indexes"
        " WHERE schemaname = 'public' AND indexdef LIKE :old",
    ) == set()


@pytest.mark.asyncio
async def test_the_school_audience_rule_speaks_the_new_names(
    db_session: AsyncSession,
):
    check = (
        await db_session.execute(
            text(
                "SELECT pg_get_constraintdef(oid) FROM pg_constraint"
                " WHERE conname = 'ck_practices_school_audience_has_school'"
            )
        )
    ).scalar_one()
    assert "'schools'" in check and "school_id" in check
    assert "curator_groups" not in check

    body = (
        await db_session.execute(
            text(
                "SELECT prosrc FROM pg_proc"
                " WHERE proname = 'practices_school_lost_goes_public'"
            )
        )
    ).scalar_one()
    assert "NEW.school_id IS NULL" in body and "'schools'" in body
    assert "curator_group" not in body

    trigger = (
        await db_session.execute(
            text(
                "SELECT pg_get_triggerdef(oid) FROM pg_trigger"
                " WHERE tgname = 'trg_practices_school_lost_goes_public'"
            )
        )
    ).scalar_one()
    assert "UPDATE OF school_id ON" in trigger


def _revision_module():
    spec = importlib.util.spec_from_file_location("rev_be90", _REVISION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _old_shape_rows(conn, ids: dict) -> None:
    """Rows as the database held them before be90a1b2c3d4: the old table and
    column names, the old audience value, the old journal kinds, the right
    under its old key."""
    conn.execute(
        text("INSERT INTO users (id) VALUES (:c), (:s)"),
        {"c": ids["curator"], "s": ids["student"]},
    )
    conn.execute(
        text(
            "INSERT INTO master_profiles (user_id, data) VALUES"
            " (:c, CAST(:with_right AS jsonb)), (:s, CAST(:without AS jsonb))"
        ),
        {
            "c": ids["curator"], "s": ids["student"],
            "with_right": json.dumps(
                {"account": {"can_create_groups": False, "keep": 1}}
            ),
            "without": json.dumps({"other": 1}),
        },
    )
    conn.execute(
        text(
            "INSERT INTO curator_group (id, name, curator_user_id)"
            " VALUES (:g, 'be90 school', :c)"
        ),
        {"g": ids["school"], "c": ids["curator"]},
    )
    conn.execute(
        text(
            "INSERT INTO curator_group_member (id, group_id, kind, user_id)"
            " VALUES (:m, :g, 'student', :s)"
        ),
        {"m": uuid4(), "g": ids["school"], "s": ids["student"]},
    )
    for kind in ("group_created", "group_renamed", "member_joined"):
        conn.execute(
            text(
                "INSERT INTO curator_group_event (id, actor_id, event, group_id)"
                " VALUES (:e, :c, :k, :g)"
            ),
            {"e": uuid4(), "c": ids["curator"], "k": kind, "g": ids["school"]},
        )
    for key, audience, school in (
        ("in_school", "curator_groups", ids["school"]),
        ("public_in_school", "public", ids["school"]),
        ("plain", "public", None),
    ):
        conn.execute(
            text(
                "INSERT INTO practices (id, timezone, master_id, practice_type,"
                " title, scheduled_at, duration_minutes, audience_kind,"
                " curator_group_id) VALUES (:p, 'UTC', :c, 'online', :t, now(),"
                " 60, :a, :g)"
            ),
            {"p": ids[key], "c": ids["curator"], "t": f"be90-{key}",
             "a": audience, "g": school},
        )


@pytest.mark.asyncio
async def test_the_revision_moves_the_data_and_keeps_the_rule(
    db_session: AsyncSession,
):
    """Grid of the gate, one row per state the revision meets.

    practices: a school practice for the school's students -> 'schools';
    a public practice of a school and a practice outside any school ->
    untouched. Journal: the four group_* kinds -> school_*, any other kind
    untouched. master_profiles: the right moves to its new key with its value
    (False here, so a migration that wrote True or dropped the value fails);
    a profile without it is left as it was. Then the rule the trigger keeps:
    a school practice that loses its school becomes public -- on the column
    and the value the revision wrote into the function's body.
    """
    await db_session.commit()
    rev = _revision_module()
    ids = {k: uuid4() for k in (
        "curator", "student", "school", "in_school", "public_in_school", "plain",
    )}

    def run(conn) -> dict:
        with Operations.context(MigrationContext.configure(conn)):
            rev.downgrade()
            _old_shape_rows(conn, ids)
            rev.upgrade()
        out: dict = {}
        out["audience"] = dict(conn.execute(
            text("SELECT id, audience_kind FROM practices WHERE id IN (:a, :b, :c)"),
            {"a": ids["in_school"], "b": ids["public_in_school"], "c": ids["plain"]},
        ).all())
        out["events"] = sorted(conn.execute(
            text("SELECT event FROM school_event WHERE school_id = :g"),
            {"g": ids["school"]},
        ).scalars())
        out["profiles"] = dict(conn.execute(
            text("SELECT user_id, data FROM master_profiles WHERE user_id IN (:c, :s)"),
            {"c": ids["curator"], "s": ids["student"]},
        ).all())
        conn.execute(
            text("UPDATE practices SET school_id = NULL WHERE id = :p"),
            {"p": ids["in_school"]},
        )
        out["after_loss"] = conn.execute(
            text("SELECT audience_kind FROM practices WHERE id = :p"),
            {"p": ids["in_school"]},
        ).scalar_one()
        return out

    async with get_engine().connect() as conn:
        tx = await conn.begin()
        try:
            got = await conn.run_sync(run)
        finally:
            await tx.rollback()

    assert got["audience"] == {
        ids["in_school"]: "schools",
        ids["public_in_school"]: "public",
        ids["plain"]: "public",
    }
    assert got["events"] == ["member_joined", "school_created", "school_renamed"]
    assert got["profiles"][ids["curator"]] == {
        "account": {"can_create_schools": False, "keep": 1},
    }
    assert got["profiles"][ids["student"]] == {"other": 1}
    assert got["after_loss"] == "public"
