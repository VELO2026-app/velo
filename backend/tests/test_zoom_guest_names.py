# =============================================================================
# VELO -- Tests: zoom_guest_names, the table behind guest display names (GT-21)
# =============================================================================
#
# telegram_id band: 67000-67199.
#
# BAND PROVENANCE. 67000-67199 was reserved by the GT-21 handoff and never
# spent -- that handoff stopped after the schema. Re-checked against the live
# registry rather than trusted: `free_windows(space=(67000, 67999))` returns
# [(67000, 67999)], i.e. nothing in tests/ declares any part of it. 67200-67999
# stays free.
#
# WHY THIS FILE EXISTS, AND WHY IT IS NOT OPTIONAL.
#
# The docstring of migration gt21a1b2c3d4 claimed "the suite checks it on live
# data ... rather than trusting this paragraph". It did not: when that revision
# was written no test in this repo mentioned ZoomGuestName or zoom_guest_names
# in any spelling. That revision is applied and therefore immutable, so the
# claim cannot be edited out; the only honest repair is to make it true, here.
# The correction notice lives in migration gt21bc1d2e3f.
#
# WHAT IS UNDER TEST -- three DATABASE guarantees, none of which has any
# application code behind it yet. GT-21 shipped step A: schema only, no writer,
# /z/{code}/guest still hands out the shared registrant. That is exactly why
# these have to be enforced by the database rather than by a caller: when the
# generator and the claim path land in step B, "a blank name" and "two guests
# with one name on one practice" must already be IMPOSSIBLE, not merely
# un-issued.
#
#   1. CASCADE from practices. tests/helpers.py full_cleanup_range deletes NO
#      zoom table by name -- zoom_meetings, zoom_registrants and
#      zoom_attendance_segments are all swept by its delete(Practice) through
#      ON DELETE CASCADE, and this table has to join that same sweep. Read off
#      the DDL that is obvious; on live data it is a fact.
#   2. UNIQUENESS SCOPED TO ONE PRACTICE. Both halves matter and the second is
#      the load-bearing one: the same name on two DIFFERENT practices must be
#      ALLOWED. A test that only proves the collision fails would pass just as
#      happily against a global unique index, which is the wrong design (owner
#      ruling: the only list a name must be distinguishable in is one meeting's
#      participant list).
#   3. NON-BLANK. varchar(64) held the upper bound; nothing held the lower one,
#      so "" and "   " inserted cleanly until gt21bc1d2e3f.
#
# EVERY "X IS REJECTED" ASSERTION HERE IS PAIRED WITH "Y IS ACCEPTED AND Y IS
# NON-EMPTY". Without the pair, all three tests would pass unchanged in a world
# where the table silently swallowed every insert, or where cleanup had emptied
# it before the assertion ran.
#
# ⚠ BACKEND-ONLY, NOT RUN LOCALLY -- no docker/postgres in this environment
# (same standing caveat as test_zoom_public_link.py and test_zoom_start.py).
# Written to be read and exercised by the deploy battery; collection success is
# not passing.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from app.modules.zoom.models import ZoomGuestName
from tests.helpers import full_cleanup_range, login_user

_TID_MIN = 67000
_TID_MAX = 67199


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """The shared FK-safe helper (TD-032), scoped strictly to this file's own
    band. Note that it names no zoom table: everything here is reached through
    delete(Practice) and ON DELETE CASCADE, which is guarantee 1 above -- the
    cleanup is itself a user of the thing under test."""
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _make_master(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
) -> str:
    auth = await login_user(
        client, telegram_id=telegram_id, first_name="GuestNameMaster",
    )
    user_id = auth["user"]["id"]
    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER.value
    await db_session.flush()
    db_session.add(
        MasterProfile(
            user_id=user_id,
            data={
                "account": {"status": "verified"},
                "profile": {"display_name": "GuestNameMaster"},
            },
        )
    )
    await db_session.flush()
    return user_id


async def _make_practice(
    db_session: AsyncSession, master_id: str, title: str,
) -> Practice:
    practice = Practice(
        master_id=master_id,
        title=title,
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=PracticeStatus.SCHEDULED.value,
        scheduled_at=datetime.now(UTC) + timedelta(days=2),
        duration_minutes=60,
        timezone="UTC",
        max_participants=10,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
        data={},
    )
    db_session.add(practice)
    await db_session.flush()
    return practice


async def _count_names(db_session: AsyncSession, practice_id) -> int:
    return (
        await db_session.execute(
            select(func.count())
            .select_from(ZoomGuestName)
            .where(ZoomGuestName.practice_id == practice_id)
        )
    ).scalar_one()


# ---------------------------------------------------------------------------
# 1. Cascade from practices
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_deleting_a_practice_takes_its_guest_names_with_it(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Deleting the practice removes its guest-name rows through the FK, with
    no help from application code and no mention of the table in cleanup.

    The "before" half is not decoration. Asserting only "zero rows afterwards"
    passes identically in a world where the insert never landed, or where the
    autouse cleanup had already emptied the table -- so the rows are counted
    and their content checked while the practice is still alive.
    """
    master_id = await _make_master(client, db_session, _TID_MIN + 1)
    practice = await _make_practice(db_session, master_id, "Каскад")

    db_session.add_all(
        [
            ZoomGuestName(practice_id=practice.id, display_name="Пылающий Шива"),
            ZoomGuestName(practice_id=practice.id, display_name="Громкий Один"),
        ]
    )
    await db_session.commit()

    rows = (
        await db_session.execute(
            select(ZoomGuestName).where(ZoomGuestName.practice_id == practice.id)
        )
    ).scalars().all()
    assert len(rows) == 2
    assert all(row.display_name.strip() for row in rows)
    assert {row.display_name for row in rows} == {"Пылающий Шива", "Громкий Один"}

    await db_session.execute(delete(Practice).where(Practice.id == practice.id))
    await db_session.commit()

    assert await _count_names(db_session, practice.id) == 0


# ---------------------------------------------------------------------------
# 2. Uniqueness, scoped to one practice
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_one_name_cannot_be_issued_twice_on_the_same_practice(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The second identical name on one practice is refused by the database.

    The savepoint is what makes this assertable at all: without begin_nested()
    the IntegrityError would poison the outer transaction and the paired "the
    first row is still there" check below could not run.
    """
    master_id = await _make_master(client, db_session, _TID_MIN + 2)
    practice = await _make_practice(db_session, master_id, "Уникальность")

    db_session.add(
        ZoomGuestName(practice_id=practice.id, display_name="Тихий Нерей")
    )
    await db_session.commit()

    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            db_session.add(
                ZoomGuestName(practice_id=practice.id, display_name="Тихий Нерей")
            )
            await db_session.flush()

    surviving = (
        await db_session.execute(
            select(ZoomGuestName).where(ZoomGuestName.practice_id == practice.id)
        )
    ).scalars().all()
    assert len(surviving) == 1
    assert surviving[0].display_name == "Тихий Нерей"


@pytest.mark.asyncio
async def test_the_same_name_is_free_again_on_a_different_practice(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Uniqueness is per practice, not global -- the half that actually pins
    the design down.

    The previous test passes just as happily against a GLOBAL unique index,
    which is the wrong shape: the only place a name has to be distinguishable
    is one meeting's participant list (owner ruling). This test is what makes
    the two designs tell apart.
    """
    master_id = await _make_master(client, db_session, _TID_MIN + 3)
    first = await _make_practice(db_session, master_id, "Практика А")
    second = await _make_practice(db_session, master_id, "Практика Б")

    db_session.add_all(
        [
            ZoomGuestName(practice_id=first.id, display_name="Светлая Фрейя"),
            ZoomGuestName(practice_id=second.id, display_name="Светлая Фрейя"),
        ]
    )
    await db_session.commit()

    assert await _count_names(db_session, first.id) == 1
    assert await _count_names(db_session, second.id) == 1


# ---------------------------------------------------------------------------
# 3. Non-blank (GT-21b item 4)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_blank_display_name_is_refused_by_the_database(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Empty and whitespace-only names are rejected by the CHECK, not by a
    caller -- there is no caller yet, and by the time step B writes one the
    state has to be unreachable rather than merely un-issued.

    Both spellings are exercised because they fail differently in principle:
    "" would be caught by a NOT NULL-style emptiness test, "   " only by one
    that trims first. varchar(64) never held either.
    """
    master_id = await _make_master(client, db_session, _TID_MIN + 4)
    practice = await _make_practice(db_session, master_id, "Пустое имя")
    await db_session.commit()

    for blank in ("", "   ", "\t\n "):
        with pytest.raises(IntegrityError):
            async with db_session.begin_nested():
                db_session.add(
                    ZoomGuestName(practice_id=practice.id, display_name=blank)
                )
                await db_session.flush()

    assert await _count_names(db_session, practice.id) == 0

    # The paired half: a name that merely CONTAINS whitespace is fine. Without
    # it, a constraint that rejected every insert would pass the loop above.
    db_session.add(
        ZoomGuestName(practice_id=practice.id, display_name=" Дерзкий Тюр ")
    )
    await db_session.commit()
    assert await _count_names(db_session, practice.id) == 1
