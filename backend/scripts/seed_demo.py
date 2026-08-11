#!/usr/bin/env python3
# =============================================================================
# VELO Backend -- Demo-data seed for the stand (velo seed-demo)   [T-31]
# =============================================================================
#
# Populates the stand with a REAL master (the boss's second Telegram account)
# and optional synthetic masters, each with published future practices -- so
# the T-15 e2e checklist has a living catalog to walk through.
#
# Invoked from the host through the `velo` wrapper (which gates on
# VELO_ROLE=test -- this script itself has no host-role visibility):
#     velo seed-demo --master-tg <telegram_id> [--extra-masters N]
# which runs, inside the app container:
#     python scripts/seed_demo.py --master-tg <id> [--extra-masters N]
#
# WHY NOT `velo seed` (scripts/seed.py): that script predates Phase 6 / T0
# identity-sync and writes Users/profiles with bare ORM -- zero outbox
# events, so the comms projection never learns the seeded masters and the
# checklist's "message the master" step fails on an empty contact book.
# THIS script goes through the emitting paths only:
#   * user creation      -> auth.service.upsert_user_on_login (emits the
#                           identity snapshot, auth/service.py);
#   * master capability  -> sync_membership_delta(GROUP_MASTERS, had, has)
#                           (app/core/events/sync.py) -- the same call
#                           verify_master and `velo setrole` make; on ADD it
#                           emits snapshot-then-join (ordering belt), on no
#                           delta it emits nothing (idempotent re-runs);
#   * practices          -> practices.service.create_practice + publish via
#                           update_practice(status="scheduled") -- the real
#                           service path (validation, dedup, zoom-safe:
#                           publish survives zoom failure by design).
#
# NON-DESTRUCTIVE ON EXISTING USERS: if a user with the given telegram_id
# already exists, upsert_user_on_login is NOT called (its ON CONFLICT UPDATE
# would overwrite live credentials -- username/avatar -- with our stubs).
# The membership delta still emits the snapshot first on ADD, so the comms
# projection is fed either way.
#
# IDEMPOTENCY: re-running creates nothing new -- users are found by
# telegram_id, capability deltas are silent when nothing changed, practices
# are matched by their fixed "[demo]" titles among the master's future
# practices and skipped when present.
#
# SYNTHETIC RANGE: telegram_id 70000-70099 (registry §5; test bands
# 62xxx/83xxx/89xxx/9xxxx stay untouched). --extra-masters is capped at 99.
#
# ORM conventions mirrored from scripts/set_role.py (verified against the
# codebase): own async session via get_session_factory(), explicit commit,
# dispose_engine() in finally; User.role is a plain str column -- assign
# UserRole.X.value; MasterProfile JSONB only through set_jsonb().
# =============================================================================

from __future__ import annotations

import argparse
import asyncio
import copy
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

# -- sys.path bootstrap (same shape as set_role.py) --------------------------
_SCRIPTS_DIR = Path(__file__).resolve().parent
_BACKEND_DIR = _SCRIPTS_DIR.parent
for _p in (_SCRIPTS_DIR, _BACKEND_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

from sqlalchemy import func, select  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession  # noqa: E402

from app.core.database import dispose_engine, get_session_factory  # noqa: E402
from app.core.events import (  # noqa: E402  # Phase 6 / T0
    GROUP_MASTERS,
    sync_membership_delta,
)
from app.core.events.models import OutboxEvent  # noqa: E402
from app.modules.auth.service import upsert_user_on_login  # noqa: E402
from app.modules.masters.models import MasterProfile  # noqa: E402
from app.modules.practices.schemas import (  # noqa: E402
    CreatePracticeRequest,
    UpdatePracticeRequest,
)
from app.modules.practices.service import (  # noqa: E402
    create_practice,
    update_practice,
)
from app.modules.users.models import User, UserRole  # noqa: E402

# -- Console output (set_role.py palette) ------------------------------------
C = "\033[0;36m"
Y = "\033[1;33m"
G = "\033[0;32m"
R = "\033[0;31m"
N = "\033[0m"


def ok(msg: str) -> None:
    print(f"{G}{msg}{N}")


def warn(msg: str) -> None:
    print(f"{Y}{msg}{N}")


def err(msg: str) -> None:
    print(f"{R}{msg}{N}")


# -- Synthetic band (registry §5) --------------------------------------------
SYNTH_BASE = 70000
SYNTH_CAP = 99  # ids 70001..70099

# -- Demo profile texts -------------------------------------------------------
BOSS_PROFILE = {
    "display_name": "Мастер Velo",
    "bio": "Демо-профиль для показа. Ведёт живые практики на стенде.",
    "methods": ["meditation — presence", "yoga — hatha", "yoga — nidra"],
    "experience_years": 7,
}

SYNTH_PROFILES = [
    {"display_name": "Анна Тишина", "bio": "Медитации тишины и присутствия.",
     "methods": ["meditation — silence", "meditation — presence"], "experience_years": 5},
    {"display_name": "Виктор Дыхание", "bio": "Дыхательные практики для начинающих.",
     "methods": ["breathwork"], "experience_years": 3},
    {"display_name": "Мария Круг", "bio": "Женские круги и шеринги.",
     "methods": ["circles — sharing"], "experience_years": 6},
]

# Fixed demo practices: matched by title on re-runs (idempotency marker).
BOSS_PRACTICES = [
    dict(title="[demo] Утренняя медитация", practice_type="live",
         direction="meditation", style="presence", difficulty="beginner",
         days_ahead=2, hour=9, duration=45, is_free=True, price_cents=0),
    dict(title="[demo] Хатха-йога вечером", practice_type="live",
         direction="yoga", style="hatha", difficulty="medium",
         days_ahead=3, hour=19, duration=60, is_free=False, price_cents=1500),
    dict(title="[demo] Йога-нидра: глубокое расслабление", practice_type="live",
         direction="yoga", style="nidra", difficulty="beginner",
         days_ahead=5, hour=20, duration=60, is_free=True, price_cents=0),
]

SYNTH_PRACTICES = [
    [dict(title="[demo] Медитация тишины", practice_type="live",
          direction="meditation", style="silence", difficulty="beginner",
          days_ahead=2, hour=8, duration=30, is_free=True, price_cents=0),
     dict(title="[demo] Практика присутствия", practice_type="live",
          direction="meditation", style="presence", difficulty="medium",
          days_ahead=4, hour=18, duration=45, is_free=False, price_cents=900)],
    [dict(title="[demo] Дыхание: базовый круг", practice_type="live",
          direction="breathwork", style=None, difficulty="beginner",
          days_ahead=3, hour=10, duration=40, is_free=True, price_cents=0)],
    [dict(title="[demo] Женский круг: шеринг", practice_type="live",
          direction="circles", style="sharing", difficulty="beginner",
          days_ahead=6, hour=17, duration=90, is_free=False, price_cents=1200)],
]


def _master_capability(profile: MasterProfile | None) -> bool:
    """A verified MasterProfile -- the comms-group reading (set_role.py)."""
    return (
        profile is not None
        and (profile.data or {}).get("account", {}).get("status") == "verified"
    )


def _build_verified_data(fields: dict) -> dict:
    """Fresh verified MasterProfile.data (set_role.py shape, seed_demo source)."""
    now_iso = datetime.now(UTC).isoformat()
    return {
        "account": {
            "status": "verified",
            "applied_at": now_iso,
            "verification": {
                "verified_at": now_iso,
                "verified_by": "cli_seed_demo",
                "notes": "demo master seeded via velo seed-demo (T-31)",
            },
            "rejections": [],
        },
        "profile": {
            "display_name": fields["display_name"],
            "email": None,
            "phone": None,
            "bio": fields["bio"],
            "methods": fields["methods"],
            "experience_years": fields["experience_years"],
            "certifications": [],
        },
        "documents": [],
        "availability": {"is_accepting": True, "note": None},
        "settings": {
            "auto_confirm_bookings": True,
            "max_participants_default": 20,
        },
        "stats": {
            "total_practices": 0,
            "total_participants": 0,
            "avg_rating": None,
        },
        "seed": {"source": "cli_seed_demo", "granted_at": now_iso},
    }


def _set_role_master(user: User) -> None:
    """Role flip + clear a stale admin round-trip marker (set_role.py:_set_role)."""
    user.role = UserRole.MASTER.value
    creds = copy.deepcopy(user.credentials or {})
    if (creds.get("role_switch") or {}).get("home_role"):
        creds.pop("role_switch", None)
        user.set_jsonb("credentials", creds)


async def _ensure_master(
    session: AsyncSession,
    telegram_id: int,
    fields: dict,
) -> tuple[User, str]:
    """User (create-if-absent) + verified master capability, emitting paths only.

    Returns (user, action) where action is created/updated/unchanged.
    """
    user = (
        await session.execute(
            select(User).where(User.telegram_id == telegram_id)
        )
    ).scalar_one_or_none()

    if user is None:
        # New user -> the login upsert (emits the identity snapshot).
        user = await upsert_user_on_login(
            {
                "id": telegram_id,
                "first_name": fields["display_name"],
                "last_name": None,
                "username": None,
                "language_code": "ru",
            },
            session,
        )
        action = "created"
    else:
        # Existing user: do NOT re-upsert (would overwrite live credentials
        # with stubs). The membership delta below feeds comms on ADD.
        action = "unchanged"

    profile = await session.get(MasterProfile, user.id)
    had_master = _master_capability(profile)

    if profile is None:
        session.add(
            MasterProfile(user_id=user.id, data=_build_verified_data(fields))
        )
        action = "created" if action == "created" else "updated"
    elif not had_master:
        # Existing but unverified profile: re-verify in place, keep its data
        # (set_role.py "-> master" branch).
        data = copy.deepcopy(profile.data or {})
        acct = data.setdefault("account", {})
        acct["status"] = "verified"
        acct.setdefault(
            "verification",
            {
                "verified_at": datetime.now(UTC).isoformat(),
                "verified_by": "cli_seed_demo",
                "notes": "re-verified via velo seed-demo (T-31)",
            },
        )
        data.setdefault("availability", {})["is_accepting"] = True
        profile.set_jsonb("data", data)
        action = "updated"

    if user.role != UserRole.MASTER:
        _set_role_master(user)
        if action == "unchanged":
            action = "updated"

    # The capability delta: snapshot + masters.join on ADD, silence on no-op.
    await sync_membership_delta(
        session, user, group_key=GROUP_MASTERS, had=had_master, has=True
    )
    return user, action


async def _ensure_practices(
    session: AsyncSession,
    master: User,
    specs: list[dict],
    counters: dict,
) -> None:
    """Create-and-publish missing demo practices; skip by [demo] title."""
    from app.modules.practices.models import Practice  # noqa: E402 (local: keep header lean)

    existing = set(
        (
            await session.execute(
                select(Practice.title).where(
                    Practice.master_id == master.id,
                    Practice.title.in_([s["title"] for s in specs]),
                    Practice.scheduled_at > datetime.now(UTC),
                    Practice.status.notin_(["cancelled", "deleted"]),
                )
            )
        ).scalars()
    )
    for spec in specs:
        if spec["title"] in existing:
            counters["practices_skipped"] += 1
            print(f"    practice: {spec['title']} -- skipped (exists)")
            continue
        when = (
            datetime.now(UTC) + timedelta(days=spec["days_ahead"])
        ).replace(hour=spec["hour"], minute=0, second=0, microsecond=0)
        body = CreatePracticeRequest(
            practice_type=spec["practice_type"],
            title=spec["title"],
            description="Демо-практика для показа стенда.",
            scheduled_at=when,
            duration_minutes=spec["duration"],
            timezone="Europe/Moscow",
            max_participants=12,
            is_free=spec["is_free"],
            price_cents=spec["price_cents"],
            direction=spec["direction"],
            style=spec["style"],
            difficulty=spec["difficulty"],
        )
        practice, deduped = await create_practice(master, body, session)
        if deduped:
            counters["practices_skipped"] += 1
            print(f"    practice: {spec['title']} -- skipped (dedup window)")
            continue
        # draft -> scheduled: the only PATCH-driven publish path; survives
        # zoom-create failure by design (publish_succeeds_when_zoom_create_fails).
        await update_practice(
            practice.id, master, UpdatePracticeRequest(status="scheduled"), session
        )
        counters["practices_created"] += 1
        print(f"    practice: {spec['title']} -- created & published")


async def _outbox_count(session: AsyncSession) -> int:
    return (
        await session.execute(select(func.count()).select_from(OutboxEvent))
    ).scalar_one()


async def run(master_tg: int, extra_masters: int) -> int:
    session_factory = get_session_factory()
    counters = {
        "masters_created": 0,
        "masters_updated": 0,
        "masters_unchanged": 0,
        "practices_created": 0,
        "practices_skipped": 0,
    }
    try:
        async with session_factory() as session:
            outbox_before = await _outbox_count(session)

            print(f"{C}== Boss master (tg {master_tg}) =={N}")
            boss, action = await _ensure_master(session, master_tg, BOSS_PROFILE)
            counters[f"masters_{action}"] += 1
            print(f"  master {BOSS_PROFILE['display_name']}: {action}")
            await _ensure_practices(session, boss, BOSS_PRACTICES, counters)

            for i in range(extra_masters):
                tg = SYNTH_BASE + 1 + i
                prof = SYNTH_PROFILES[i % len(SYNTH_PROFILES)]
                if i >= len(SYNTH_PROFILES):
                    prof = dict(prof, display_name=f"{prof['display_name']} {i + 1}")
                print(f"{C}== Synthetic master (tg {tg}) =={N}")
                user, action = await _ensure_master(session, tg, prof)
                counters[f"masters_{action}"] += 1
                print(f"  master {prof['display_name']}: {action}")
                specs = SYNTH_PRACTICES[i % len(SYNTH_PRACTICES)]
                await _ensure_practices(session, user, specs, counters)

            outbox_after = await _outbox_count(session)
            await session.commit()

        ok(
            "Done: masters created={masters_created} updated={masters_updated} "
            "unchanged={masters_unchanged}; practices created={practices_created} "
            "skipped={practices_skipped}".format(**counters)
        )
        ok(f"outbox: {outbox_after - outbox_before} event(s) emitted this run")
        if outbox_after == outbox_before and counters["masters_created"]:
            err("outbox is silent but masters were created -- the comms trap; report this")
            return 1
        return 0
    finally:
        await dispose_engine()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Seed demo masters and practices on the stand (T-31)."
    )
    parser.add_argument(
        "--master-tg", type=int, required=True,
        help="Telegram id of the REAL master account (the boss's second one)",
    )
    parser.add_argument(
        "--extra-masters", type=int, default=0,
        help=f"Synthetic masters from the {SYNTH_BASE + 1}+ band (max {SYNTH_CAP})",
    )
    args = parser.parse_args()

    if not (0 < args.master_tg):
        err("--master-tg must be a positive Telegram id")
        return 2
    if SYNTH_BASE <= args.master_tg <= SYNTH_BASE + SYNTH_CAP:
        err(
            f"--master-tg {args.master_tg} falls into the synthetic band "
            f"{SYNTH_BASE}-{SYNTH_BASE + SYNTH_CAP}; use the real account id"
        )
        return 2
    if not (0 <= args.extra_masters <= SYNTH_CAP):
        err(f"--extra-masters must be 0..{SYNTH_CAP}")
        return 2

    return asyncio.run(run(args.master_tg, args.extra_masters))


if __name__ == "__main__":
    sys.exit(main())
