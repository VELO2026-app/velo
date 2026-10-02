# =============================================================================
# VELO Backend -- Tests: BE-106 -- seed passes what_to_prepare/contraindications;
# set_role/seed write a FRESH verification block; seed --reset-all.
# =============================================================================
#
# telegram_id band: 71000-71099. Declared module-level below as
# _TID_MIN/_TID_MAX, ONCE. Checked free before it was claimed:
# free_windows(space=(55000, 99999)) returned (71000, 79299).
# Practice titles carry the "[t106" prefix, which also scopes the cleanup.
# =============================================================================

import copy
from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from uuid import UUID

import pytest
from httpx import AsyncClient
from pydantic import ValidationError
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session_factory
from app.modules.curator_groups.models import CuratorGroup
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice
from app.modules.users.models import User, UserRole
from scripts import seed, set_role
from tests.helpers import auth_headers, fresh_get, full_cleanup_range, login_user

_TID_MIN = 71000
_TID_MAX = 71099

_TID_MASTER = 71001
_TID_A = 71010
_TID_LIVE = 71090

_PREFIX = "[t106"
_SCHOOL = "t106 shared school"
APPLY_URL = "/api/v1/masters/apply"

_OLD_BLOCK = {
    "verified_at": "2026-01-01T00:00:00+00:00",
    "verified_by": "someone-earlier",
    "notes": "an earlier verification",
}


async def _wipe(db_session: AsyncSession) -> None:
    await db_session.execute(delete(Practice).where(Practice.title.startswith(_PREFIX)))
    await db_session.execute(delete(CuratorGroup).where(CuratorGroup.name == _SCHOOL))
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX)
    await db_session.commit()


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await _wipe(db_session)
    yield
    await _wipe(db_session)


def _master_spec(tid: int = _TID_MASTER) -> dict:
    return {
        "key": "m",
        "telegram_id": tid,
        "display_name": "Seed Master",
        "bio": "bio",
        "methods": ["meditation — presence"],
        "experience_years": 1,
    }


def _practice_spec(title: str, **extra) -> dict:
    return {
        "title": f"{_PREFIX}] {title}",
        "master": "m",
        "state": "draft",
        "day_offset": 3,
        "hour": 10,
        "duration_minutes": 30,
        "direction": "meditation",
        "style": "presence",
        "description": "d",
        **extra,
    }


async def _seed_practice(spec: dict) -> Practice:
    async with get_session_factory()() as s:
        master = await seed.ensure_master(s, _master_spec())
        practice = await seed.ensure_practice(s, master, spec)
        await s.commit()
        return practice


# ---------------------------------------------------------------------------
# Item 1: the two practice fields
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("extra", "want_prepare", "want_contra"),
    [
        ({"what_to_prepare": "mat", "contraindications": "none"}, "mat", "none"),
        ({"what_to_prepare": "mat"}, "mat", None),
        ({"contraindications": "none"}, None, "none"),
        ({}, None, None),
    ],
)
async def test_the_seed_carries_both_fields(
    db_session: AsyncSession,
    extra,
    want_prepare,
    want_contra,
) -> None:
    practice = await _seed_practice(_practice_spec("fields", **extra))
    stored = await fresh_get(Practice, practice.id)
    assert stored is not None and stored.description == "d"  # the pair: it was written
    assert stored.what_to_prepare == want_prepare
    assert stored.contraindications == want_contra


@pytest.mark.asyncio
async def test_a_second_seed_run_finds_the_practice_and_adds_nothing(
    db_session: AsyncSession,
) -> None:
    """REPEAT: idempotent by title -- one practice, fields as first written."""
    spec = _practice_spec("repeat", what_to_prepare="mat")
    first = await _seed_practice(spec)
    second = await _seed_practice({**spec, "what_to_prepare": "other"})
    assert second.id == first.id
    rows = (
        (
            await db_session.execute(
                select(Practice).where(Practice.title == spec["title"])
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1 and rows[0].what_to_prepare == "mat"


@pytest.mark.asyncio
async def test_a_field_over_the_limit_fails_loudly_and_writes_nothing(
    db_session: AsyncSession,
) -> None:
    """SHORTAGE: CreatePracticeRequest refuses it; the seed transaction rolls back."""
    spec = _practice_spec("too long", contraindications="x" * 5001)
    with pytest.raises(ValidationError, match="contraindications"):
        await _seed_practice(spec)
    rows = (
        (
            await db_session.execute(
                select(Practice).where(Practice.title == spec["title"])
            )
        )
        .scalars()
        .all()
    )
    assert rows == []
    # Pair: the same spec within the limit is written.
    ok = await _seed_practice({**spec, "contraindications": "x" * 5000})
    assert (await fresh_get(Practice, ok.id)).contraindications == "x" * 5000


# ---------------------------------------------------------------------------
# Item 2: a FRESH verification block on the way into verified
# ---------------------------------------------------------------------------


async def _profile_in(
    client: AsyncClient,
    db_session: AsyncSession,
    tid: int,
    status: str,
    block,
) -> UUID:
    auth = await login_user(client, telegram_id=tid, first_name="P")
    resp = await client.post(
        APPLY_URL,
        json={
            "profile": {"display_name": "P"},
            "experience": {"methods": ["meditation"], "experience_years": 0},
        },
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 201, resp.text
    uid = UUID(auth["user"]["id"])
    profile = await db_session.get(MasterProfile, uid)
    data = copy.deepcopy(profile.data)
    data["account"]["status"] = status
    data["account"]["verification"] = copy.deepcopy(block)
    await db_session.execute(
        update(MasterProfile).where(MasterProfile.user_id == uid).values(data=data)
    )
    await db_session.commit()
    return uid


async def _run_set_role(uid: UUID) -> None:
    async with get_session_factory()() as s:
        user = await s.get(User, uid)
        assert await set_role.to_master(s, user, assume_yes=True)
        await s.commit()


async def _run_seed(uid: UUID, tid: int) -> None:
    async with get_session_factory()() as s:
        await seed.ensure_master(s, _master_spec(tid))
        await s.commit()


async def _block(uid: UUID) -> dict | None:
    profile = await fresh_get(MasterProfile, uid)
    return profile.data["account"].get("verification")


_TOOLS = {
    "set_role": ("cli_setrole", "re-verified via velo setrole"),
    "seed": ("cli_seed", "re-verified via velo seed"),
}


@pytest.mark.asyncio
@pytest.mark.parametrize("tool", sorted(_TOOLS))
@pytest.mark.parametrize(
    ("status", "block"),
    [
        ("pending", None),
        ("rejected", None),
        ("cancelled_by_user", None),
        ("suspended", _OLD_BLOCK),
    ],
)
async def test_the_cli_writes_a_fresh_block(
    client: AsyncClient,
    db_session: AsyncSession,
    tool,
    status,
    block,
) -> None:
    """EMPTINESS (explicit None) and the earlier block are both replaced."""
    tid = _TID_A + sorted(_TOOLS).index(tool)
    uid = await _profile_in(client, db_session, tid, status, block)
    started = datetime.now(UTC)
    if tool == "set_role":
        await _run_set_role(uid)
    else:
        await _run_seed(uid, tid)

    profile = await fresh_get(MasterProfile, uid)
    assert profile.data["account"]["status"] == "verified"
    new = profile.data["account"]["verification"]
    verified_by, notes = _TOOLS[tool]
    assert new["verified_by"] == verified_by
    assert new["notes"] == notes
    assert datetime.fromisoformat(new["verified_at"]) >= started


@pytest.mark.asyncio
@pytest.mark.parametrize("tool", sorted(_TOOLS))
async def test_a_verified_profile_keeps_its_block_byte_for_byte(
    client: AsyncClient,
    db_session: AsyncSession,
    tool,
) -> None:
    """SHORTAGE: already verified -- the tool switches the role, not the block."""
    tid = _TID_A + 5 + sorted(_TOOLS).index(tool)
    uid = await _profile_in(client, db_session, tid, "verified", _OLD_BLOCK)
    if tool == "set_role":
        await _run_set_role(uid)
    else:
        await _run_seed(uid, tid)
    assert await _block(uid) == _OLD_BLOCK
    # Pair: the call did something -- the role moved.
    user = await fresh_get(User, uid)
    assert user.role == UserRole.MASTER.value


# ---------------------------------------------------------------------------
# Item 3: --reset-all
# ---------------------------------------------------------------------------


def _profiles() -> dict[str, dict]:
    """Two profiles sharing one school pair (curator + name), as on the stand."""
    master = {"key": "m", "telegram_id": _TID_MASTER}
    school = {"curator": "m", "name": _SCHOOL}
    return {
        "p-a": {
            "title_prefix": "[t106a]",
            "masters": [master],
            "curator_groups": [school],
        },
        "p-b": {
            "title_prefix": "[t106b]",
            "masters": [master],
            "curator_groups": [school],
        },
    }


@pytest.fixture
def two_profiles(monkeypatch: pytest.MonkeyPatch) -> dict[str, dict]:
    profiles = _profiles()
    monkeypatch.setattr(seed, "list_profiles", lambda: sorted(profiles))
    monkeypatch.setattr(seed, "load_profile", lambda name: profiles[name])
    return profiles


async def _reset_all() -> dict[str, dict]:
    async with get_session_factory()() as s:
        result = await seed.reset_all_profiles(s)
        await s.commit()
        return result


async def _titles(prefix: str) -> list[str]:
    async with get_session_factory()() as s:
        return list(
            (
                await s.execute(
                    select(Practice.title).where(Practice.title.startswith(prefix))
                )
            ).scalars()
        )


@pytest.mark.asyncio
async def test_reset_all_wipes_every_profile_and_spares_live_accounts(
    client: AsyncClient,
    db_session: AsyncSession,
    two_profiles,
) -> None:
    await _seed_practice({**_practice_spec("a"), "title": "[t106a] one"})
    await _seed_practice({**_practice_spec("b"), "title": "[t106b] two"})
    master = (
        await db_session.execute(select(User).where(User.telegram_id == _TID_MASTER))
    ).scalar_one()
    db_session.add(CuratorGroup(curator_user_id=master.id, name=_SCHOOL))
    await db_session.commit()
    live = await login_user(client, telegram_id=_TID_LIVE, first_name="Live")
    assert await _titles("[t106a]") and await _titles("[t106b]")

    result = await _reset_all()

    assert set(result) == {"p-a", "p-b"}
    assert result["p-a"]["practices"] == 1 and result["p-b"]["practices"] == 1
    # The shared school goes once, on the first profile; the second finds 0.
    assert result["p-a"]["curator_groups"] == 1
    assert result["p-b"]["curator_groups"] == 0
    assert await _titles("[t106a]") == [] and await _titles("[t106b]") == []
    # Live accounts survive: the master keeps role and profile, the user stays.
    kept = await fresh_get(User, master.id)
    assert kept is not None and kept.role == UserRole.MASTER.value
    assert await fresh_get(MasterProfile, master.id) is not None
    assert await fresh_get(User, UUID(live["user"]["id"])) is not None


@pytest.mark.asyncio
async def test_reset_all_on_a_clean_stand_is_zeros_not_an_error(
    db_session: AsyncSession,
    two_profiles,
) -> None:
    """REPEAT: a second --reset-all finds nothing and says so."""
    first = await _reset_all()
    second = await _reset_all()
    zero = {"practices": 0, "students": 0, "curator_groups": 0}
    assert second == {"p-a": zero, "p-b": zero}
    assert set(first) == {"p-a", "p-b"}  # the pair: both profiles were visited
