# =============================================================================
# Test: Practice Series -- recurrence spec + occurrence generation (E3, Batch 1)
# =============================================================================
#
# Covers the series ENGINE:
#   - recurrence spec validation on CreatePracticeRequest (422 paths);
#   - child-occurrence generation on publication (draft -> scheduled);
#   - period semantics (daily / weekly-on-days / biweekly), end conditions
#     (after_count / until_date / never), the occurrence cap, DST-safety,
#     field inheritance, the no-spec no-op, and the idempotency guard.
#
# Generation is observed through the public feed with an explicit
# ?status=scheduled (which bypasses the future-only gate and returns the root
# plus its generated children); PracticeResponse carries parent_practice_id, so
# children are identified without reaching into the DB. The two white-box checks
# (spec persistence + idempotency) open a fresh session via get_session_factory.
#
# telegram_id ranges (own cleanup band, no overlap with other suites):
#   61001       -- master user
#   61900       -- admin user
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import date, datetime, timedelta, timezone
from uuid import UUID
from zoneinfo import ZoneInfo

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, login_user, full_cleanup_range, switch_self_to_master

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
PRACTICES_URL = "/api/v1/practices"
APPLY_URL = "/api/v1/masters/apply"
VERIFY_URL = "/api/v1/admin/masters/{user_id}/verify"

_MASTER_TID = 61001
_ADMIN_TID = 61900


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """Clean all test data before/after each test (ORM, no raw SQL)."""
    await _do_cleanup(db_session)
    yield
    await _do_cleanup(db_session)


async def _do_cleanup(session: AsyncSession) -> None:
    """Full ORM cleanup for telegram_id 61000-61999."""
    await full_cleanup_range(session, 61000, 61999, delete_users=False)
    await session.commit()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _valid_apply_body() -> dict:
    """Return a valid MasterApplyRequest body."""
    return {
        "profile": {
            "display_name": "Series Master",
            "email": "series@test.com",
        },
        "experience": {
            # T21-6/T21-7 (ПРОМТ №547/548): _assert_master_confirmed_taxonomy
            # requires the calling master to hold the exact direction/style
            # being created/updated. Widened by exactly the one pair this
            # file's own tests exercise beyond the default (yoga+hatha, in
            # test_series_children_inherit_root_fields) -- raw VALUE form,
            # matching this fixture's own pre-existing style and the
            # value-canonical comparison chosen in ПРОМТ №547.
            "methods": ["meditation", "yoga — hatha"],
            "experience_years": 5,
            "bio": "Experienced practitioner",
        },
        "documents": [],
    }


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int = _MASTER_TID,
) -> dict:
    """Create user, apply as master, verify via admin. Returns master auth."""
    auth = await login_user(
        client, telegram_id=telegram_id, first_name="Master",
    )
    await client.post(
        APPLY_URL,
        json=_valid_apply_body(),
        headers=auth_headers(auth["session_token"]),
    )

    # Promote + (re)login admin so the session carries the ADMIN role.
    await login_user(client, telegram_id=_ADMIN_TID, first_name="Admin")
    await db_session.execute(
        update(User)
        .where(User.telegram_id == _ADMIN_TID)
        .values(role=UserRole.ADMIN.value)
    )
    await db_session.commit()
    admin_auth = await login_user(
        client, telegram_id=_ADMIN_TID, first_name="Admin",
    )

    user_id = auth["user"]["id"]
    verify_resp = await client.post(
        VERIFY_URL.format(user_id=user_id),
        json={},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert verify_resp.status_code == 200

    # Re-login to pick up the master role in the session.
    await switch_self_to_master(client, auth["session_token"])
    return await login_user(
        client, telegram_id=telegram_id, first_name="Master",
    )


def _valid_practice_body(**overrides: object) -> dict:
    """Return a valid CreatePracticeRequest body (UTC tz by default)."""
    base: dict = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Series Practice",
        "description": "Guided session",
        "scheduled_at": (
            datetime.now(timezone.utc) + timedelta(days=8)
        ).isoformat(),
        "duration_minutes": 60,
        "timezone": "UTC",
        "max_participants": 20,
        "is_free": True,
        "price_cents": 0,
        "currency": "eur",
    }
    base.update(overrides)
    return base


def _series_body(recurrence: dict | None, **overrides: object) -> dict:
    """A series CreatePracticeRequest body, optionally carrying a recurrence."""
    body = _valid_practice_body(practice_type="series", **overrides)
    if recurrence is not None:
        body["recurrence"] = recurrence
    return body


async def _create_series_and_publish(
    client: AsyncClient,
    auth: dict,
    recurrence: dict | None,
    **overrides: object,
) -> str:
    """Create a series practice and publish it (draft -> scheduled).

    Returns the root practice id. Generation fires on the publish PATCH.
    """
    create = await client.post(
        PRACTICES_URL,
        json=_series_body(recurrence, **overrides),
        headers=auth_headers(auth["session_token"]),
    )
    assert create.status_code == 201, create.text
    root_id = create.json()["id"]

    patch = await client.patch(
        f"{PRACTICES_URL}/{root_id}",
        json={"status": "scheduled"},
        headers=auth_headers(auth["session_token"]),
    )
    assert patch.status_code == 200, patch.text
    return root_id


async def _scheduled_items(
    client: AsyncClient,
    auth: dict,
    master_id: str,
) -> list[dict]:
    """All scheduled practices for a master (explicit status bypasses the gate)."""
    resp = await client.get(
        f"{PRACTICES_URL}?master_id={master_id}&status=scheduled&limit=100",
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 200
    return resp.json()["items"]


def _children_of(items: list[dict], root_id: str) -> list[dict]:
    """Children of a root, sorted by scheduled_at ascending."""
    kids = [i for i in items if i.get("parent_practice_id") == root_id]
    return sorted(kids, key=lambda i: i["scheduled_at"])


def _root_of(items: list[dict], root_id: str) -> dict:
    """The root item itself from a scheduled listing."""
    return next(i for i in items if i["id"] == root_id)


def _future_utc_on_weekday(
    target_iso_weekday: int, hour: int = 19, min_ahead_days: int = 8,
) -> datetime:
    """First UTC datetime >= now+min_ahead_days at `hour` on the given weekday."""
    dt = (datetime.now(timezone.utc) + timedelta(days=min_ahead_days)).replace(
        hour=hour, minute=0, second=0, microsecond=0,
    )
    while dt.isoweekday() != target_iso_weekday:
        dt += timedelta(days=1)
    return dt


def _next_offset_change_date(
    start: date, tz_name: str, hour: int = 19,
) -> date:
    """First date (scanning from `start`) whose `hour`-local UTC offset differs
    from the previous day -- i.e. the day a DST transition first takes effect at
    that wall-clock hour. 19:00 never falls in a DST gap, so it is always real.
    """
    tz = ZoneInfo(tz_name)
    cursor = start
    prev = datetime(cursor.year, cursor.month, cursor.day, hour, tzinfo=tz).utcoffset()
    for _ in range(800):
        cursor += timedelta(days=1)
        cur = datetime(
            cursor.year, cursor.month, cursor.day, hour, tzinfo=tz,
        ).utcoffset()
        if cur != prev:
            return cursor
        prev = cur
    raise AssertionError("no DST transition found in scan window")


# ---------------------------------------------------------------------------
# Validation (422 paths) -- no generation, rejected at create time
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_recurrence_on_non_series_type_rejected(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A recurrence spec with a non-series practice_type is a 422."""
    auth = await _make_verified_master(client, db_session)
    resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(
            practice_type="live",
            recurrence={"period": "daily", "end": "never"},
        ),
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_recurrence_after_count_over_cap_rejected(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """An explicit after_count above the occurrence cap is a 422."""
    auth = await _make_verified_master(client, db_session)
    over = settings.practice_series_max_occurrences + 1
    resp = await client.post(
        PRACTICES_URL,
        json=_series_body(
            {"period": "daily", "end": "after_count", "count": over},
        ),
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_recurrence_weekly_without_days_rejected(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """weekly/biweekly require at least one weekday -> 422 when omitted."""
    auth = await _make_verified_master(client, db_session)
    resp = await client.post(
        PRACTICES_URL,
        json=_series_body(
            {"period": "weekly", "end": "after_count", "count": 4},
        ),
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Persistence + basic generation
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_recurrence_spec_persisted_on_root(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The recurrence spec is stored in the root's data.recurrence sandbox."""
    auth = await _make_verified_master(client, db_session)
    root_id = await _create_series_and_publish(
        client, auth,
        {"period": "daily", "end": "after_count", "count": 3},
    )

    from app.core.database import get_session_factory
    from app.modules.practices.models import Practice

    factory = get_session_factory()
    async with factory() as s:
        root = await s.get(Practice, UUID(root_id))
        assert root is not None
        spec = (root.data or {}).get("recurrence")
        assert spec is not None
        assert spec["period"] == "daily"
        assert spec["end"] == "after_count"
        assert spec["count"] == 3


@pytest.mark.asyncio
async def test_series_after_count_generates_children(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """after_count=N publishes N total occurrences: the root + N-1 children.

    Every child is status=scheduled, links back via parent_practice_id, and the
    daily occurrences are exactly one calendar day apart.
    """
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]
    root_id = await _create_series_and_publish(
        client, auth,
        {"period": "daily", "end": "after_count", "count": 5},
    )

    items = await _scheduled_items(client, auth, master_id)
    children = _children_of(items, root_id)
    assert len(children) == 4  # total 5 incl. root

    for c in children:
        assert c["status"] == "scheduled"
        assert c["practice_type"] == "series"
        assert c["parent_practice_id"] == root_id

    # Root + children are consecutive calendar days (UTC tz, no DST drift).
    starts = [datetime.fromisoformat(_root_of(items, root_id)["scheduled_at"])]
    starts += [datetime.fromisoformat(c["scheduled_at"]) for c in children]
    for earlier, later in zip(starts, starts[1:]):
        assert (later - earlier) == timedelta(days=1)


@pytest.mark.asyncio
async def test_series_children_inherit_root_fields(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Children copy the root's content/pricing/taxonomy fields."""
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]
    root_id = await _create_series_and_publish(
        client, auth,
        {"period": "daily", "end": "after_count", "count": 3},
        title="Weekly Flow",
        duration_minutes=90,
        max_participants=12,
        direction="yoga",
        difficulty="medium",
        style="hatha",
    )

    items = await _scheduled_items(client, auth, master_id)
    children = _children_of(items, root_id)
    assert len(children) == 2
    for c in children:
        assert c["title"] == "Weekly Flow"
        assert c["duration_minutes"] == 90
        assert c["timezone"] == "UTC"
        assert c["max_participants"] == 12
        assert c["is_free"] is True
        assert c["price_cents"] == 0
        assert c["direction"] == "yoga"
        assert c["difficulty"] == "medium"
        assert c["style"] == "hatha"
        assert c["current_participants"] == 0


@pytest.mark.asyncio
async def test_series_without_recurrence_generates_no_children(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A series practice WITHOUT a spec stays single (seed demo case)."""
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]
    root_id = await _create_series_and_publish(client, auth, None)

    items = await _scheduled_items(client, auth, master_id)
    assert _children_of(items, root_id) == []


# ---------------------------------------------------------------------------
# Period semantics
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_series_weekly_on_selected_days(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """weekly recurs on the chosen ISO weekdays.

    Anchored on a Wednesday with days Mon/Wed/Fri and after_count=4, the three
    children land on the next Fri, Mon, Wed (in that order).
    """
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]
    anchor = _future_utc_on_weekday(3)  # Wednesday
    root_id = await _create_series_and_publish(
        client, auth,
        {"period": "weekly", "days": [1, 3, 5], "end": "after_count", "count": 4},
        scheduled_at=anchor.isoformat(),
    )

    items = await _scheduled_items(client, auth, master_id)
    children = _children_of(items, root_id)
    assert len(children) == 3
    weekdays = [
        datetime.fromisoformat(c["scheduled_at"]).isoweekday() for c in children
    ]
    assert weekdays == [5, 1, 3]  # Fri, Mon, Wed


@pytest.mark.asyncio
async def test_series_biweekly_every_other_week(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """biweekly skips a week between occurrences (14-day spacing)."""
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]
    anchor = _future_utc_on_weekday(1)  # Monday
    root_id = await _create_series_and_publish(
        client, auth,
        {"period": "biweekly", "days": [1], "end": "after_count", "count": 3},
        scheduled_at=anchor.isoformat(),
    )

    items = await _scheduled_items(client, auth, master_id)
    children = _children_of(items, root_id)
    assert len(children) == 2
    root_start = datetime.fromisoformat(_root_of(items, root_id)["scheduled_at"])
    starts = [root_start] + [
        datetime.fromisoformat(c["scheduled_at"]) for c in children
    ]
    for earlier, later in zip(starts, starts[1:]):
        assert (later - earlier) == timedelta(days=14)
    for c in children:
        assert datetime.fromisoformat(c["scheduled_at"]).isoweekday() == 1


@pytest.mark.asyncio
async def test_series_until_date_inclusive(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """until_date includes an occurrence landing exactly on the boundary date,
    and produces none beyond it."""
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]
    anchor = _future_utc_on_weekday(1)  # Monday
    until = anchor.date() + timedelta(days=21)  # +3 weekly occurrences
    root_id = await _create_series_and_publish(
        client, auth,
        {
            "period": "weekly",
            "days": [1],
            "end": "until_date",
            "until_date": until.isoformat(),
        },
        scheduled_at=anchor.isoformat(),
    )

    items = await _scheduled_items(client, auth, master_id)
    children = _children_of(items, root_id)
    assert len(children) == 3
    child_dates = [
        datetime.fromisoformat(c["scheduled_at"]).date() for c in children
    ]
    assert max(child_dates) == until
    assert all(d <= until for d in child_dates)


@pytest.mark.asyncio
async def test_series_never_caps_at_max_occurrences(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """end='never' generates exactly cap-1 children (cap total incl. root)."""
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]
    root_id = await _create_series_and_publish(
        client, auth, {"period": "daily", "end": "never"},
    )

    items = await _scheduled_items(client, auth, master_id)
    children = _children_of(items, root_id)
    assert len(children) == settings.practice_series_max_occurrences - 1


# ---------------------------------------------------------------------------
# DST-safety
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_series_daily_dst_safe(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Across a DST transition the LOCAL wall-clock time is preserved.

    A daily Europe/Berlin series anchored two days before the next real DST
    transition (found dynamically, so the test never depends on a fixed past
    date) keeps every occurrence at 19:00 local while the underlying UTC hour
    shifts -- proving per-occurrence local->UTC conversion, not naive UTC math.
    """
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]

    tz_name = "Europe/Berlin"
    scan_start = (datetime.now(timezone.utc) + timedelta(days=8)).date()
    change_day = _next_offset_change_date(scan_start, tz_name)
    anchor_date = change_day - timedelta(days=2)
    anchor_local = datetime(
        anchor_date.year, anchor_date.month, anchor_date.day, 19, 0,
        tzinfo=ZoneInfo(tz_name),
    )
    root_id = await _create_series_and_publish(
        client, auth,
        {"period": "daily", "end": "after_count", "count": 4},
        timezone=tz_name,
        scheduled_at=anchor_local.astimezone(timezone.utc).isoformat(),
    )

    items = await _scheduled_items(client, auth, master_id)
    occurrences = [_root_of(items, root_id)] + _children_of(items, root_id)
    assert len(occurrences) == 4  # root + 3 children spanning the transition

    tz = ZoneInfo(tz_name)
    local_hours = {
        datetime.fromisoformat(o["scheduled_at"]).astimezone(tz).hour
        for o in occurrences
    }
    utc_hours = {
        datetime.fromisoformat(o["scheduled_at"]).astimezone(timezone.utc).hour
        for o in occurrences
    }
    assert local_hours == {19}  # local wall-clock constant across the boundary
    assert len(utc_hours) == 2  # UTC hour shifts by the DST offset


# ---------------------------------------------------------------------------
# Idempotency guard
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_series_generation_idempotent(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Re-running generation on an already-materialized root is a no-op."""
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]
    root_id = await _create_series_and_publish(
        client, auth,
        {"period": "daily", "end": "after_count", "count": 4},
    )

    before = _children_of(await _scheduled_items(client, auth, master_id), root_id)
    assert len(before) == 3

    from app.core.database import get_session_factory
    from app.modules.practices.models import Practice
    from app.modules.practices.series_service import generate_series_occurrences

    factory = get_session_factory()
    async with factory() as s:
        root = await s.get(Practice, UUID(root_id))
        created = await generate_series_occurrences(root, s)
        assert created == 0
        await s.commit()

    after = _children_of(await _scheduled_items(client, auth, master_id), root_id)
    assert len(after) == 3


@pytest.mark.asyncio
async def test_series_until_date_in_past_rejected_on_publish(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A past until_date yields no children, so publishing is a 400 rather than
    a silent single-occurrence "series".

    The schema accepts the syntactically valid date; the degenerate outcome is
    caught at publication, when generation produces zero children (W-1).
    """
    auth = await _make_verified_master(client, db_session)

    # Daily series whose until_date sits well before the (future) root, so no
    # occurrence beyond the root itself can be emitted.
    past = (date.today() - timedelta(days=30)).isoformat()
    create = await client.post(
        PRACTICES_URL,
        json=_series_body(
            {"period": "daily", "end": "until_date", "until_date": past},
        ),
        headers=auth_headers(auth["session_token"]),
    )
    assert create.status_code == 201, create.text
    root_id = create.json()["id"]

    publish = await client.patch(
        f"{PRACTICES_URL}/{root_id}",
        json={"status": "scheduled"},
        headers=auth_headers(auth["session_token"]),
    )
    assert publish.status_code == 400, publish.text
