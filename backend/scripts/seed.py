#!/usr/bin/env python3
# =============================================================================
# VELO Backend -- Profile-driven database seed
# =============================================================================
#
# USAGE (through the management command, which gates on VELO_ROLE=test):
#   velo seed                        -- seed from the default profile
#   velo seed --profile 15082026     -- seed from a named profile
#   velo seed --reset                -- wipe seeded data, then seed
#   velo seed --list                 -- list available profiles
#
# DIRECTLY (inside the app container):
#   python scripts/seed.py [--profile NAME] [--reset] [--list] [--dry-run]
#
# -----------------------------------------------------------------------------
# WHY THIS REPLACED THREE SCRIPTS
#
# seed.py (85 KB), seed_practices.py (133 KB + 53 KB of JSON + 7 scenario
# files) and seed_demo.py (17 KB) all seeded overlapping data, and the first
# two were DEAD: they imported app.modules.notifications (a module that no
# longer exists) and wrote Practice.zoom_link (a column T-35 dropped). Neither
# could run at all.
#
# Worse than dead, they were WRONG IN THE SAME WAY: both wrote users and
# profiles with bare ORM, emitting zero outbox events. Comms therefore never
# learned about the seeded people -- notifications never arrive, the contact
# book is empty, "message the master" fails. seed_demo.py existed only to work
# around that, and its header said so.
#
# So this script keeps seed_demo's rule and drops everything else:
# EVERY USER AND PRACTICE IS CREATED THROUGH THE PATHS THE APPLICATION ITSELF
# USES, never by hand:
#   * users      -> auth.service.upsert_user_on_login    (identity snapshot)
#   * master cap -> core.events.sync_membership_delta    (snapshot + join)
#   * practices  -> practices.service.create_practice + update_practice
# Anything seeded by hand is invisible to half the product.
#
# -----------------------------------------------------------------------------
# PROFILES
#
# A profile is one JSON file in scripts/seed_profiles/. It describes WHAT to
# seed; this file describes HOW. Adding a demo means adding a JSON file, not
# editing Python.
#
# DATES ARE RELATIVE, always: "day_offset": -9 means nine days before the run.
# An earlier design used absolute dates pinned to a show date and it was
# wrong -- a profile written for the 15th shows an empty screen on the 22nd,
# silently, because every practice has drifted into the past. Relative offsets
# mean any profile stays alive whenever it runs.
#
# Profile NAMES are still dates (15082026) because they anchor to a specific
# test/demo protocol, not because the data expires. That is versioning of a
# scenario, not a timestamp.
#
# -----------------------------------------------------------------------------
# LIVE ACCOUNTS ARE NEVER TOUCHED BY --reset
#
# Real Telegram accounts on the stand are few and reused. Synthetic students
# get six-digit ids (600001+); every real account is either five-digit (test
# bands) or a genuine ten-digit Telegram id. So --reset can decide what is
# ours with one comparison and no marker columns:
#
#     600000 < telegram_id < 700000   ->  seeded, safe to delete
#     anything else                    ->  a real person, never deleted
#
# A live master keeps their account, their role and their profile; only the
# practices and rows this script created are removed.
# =============================================================================

import argparse
import asyncio
import copy
import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

# -- sys.path bootstrap (same shape as set_role.py) --------------------------
_SCRIPTS_DIR = Path(__file__).resolve().parent
_BACKEND_DIR = _SCRIPTS_DIR.parent
for _p in (_SCRIPTS_DIR, _BACKEND_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

from sqlalchemy import delete, select  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession  # noqa: E402

from app.core.database import dispose_engine, get_session_factory  # noqa: E402
from app.core.events import GROUP_MASTERS, sync_membership_delta  # noqa: E402
from app.modules.auth.service import upsert_user_on_login  # noqa: E402
from app.modules.bookings.models import Booking  # noqa: E402
from app.modules.diary.models import Checkin, CheckType, Feedback  # noqa: E402
from app.modules.masters.models import MasterProfile  # noqa: E402
from app.modules.practices.models import Practice, PracticeStatus  # noqa: E402
from app.modules.practices.schemas import (  # noqa: E402
    CreatePracticeRequest,
    UpdatePracticeRequest,
)
from app.modules.practices.service import (  # noqa: E402
    create_practice,
    update_practice,
)
from app.modules.users.models import User, UserRole  # noqa: E402

PROFILES_DIR = _SCRIPTS_DIR / "seed_profiles"

# Synthetic students live here and nowhere else. See the header: this range is
# the ONLY thing --reset uses to tell seeded people from real ones.
SYNTH_MIN = 600001
SYNTH_MAX = 699999

# -- Console output (set_role.py palette) ------------------------------------
C = "\033[0;36m"
Y = "\033[1;33m"
G = "\033[0;32m"
R = "\033[0;31m"
N = "\033[0m"


def info(msg: str) -> None:
    print(f"{C}{msg}{N}")


def ok(msg: str) -> None:
    print(f"{G}{msg}{N}")


def warn(msg: str) -> None:
    print(f"{Y}{msg}{N}")


def err(msg: str) -> None:
    print(f"{R}{msg}{N}")


# ---------------------------------------------------------------------------
# Profile loading
# ---------------------------------------------------------------------------


def list_profiles() -> list[str]:
    if not PROFILES_DIR.is_dir():
        return []
    return sorted(p.stem for p in PROFILES_DIR.glob("*.json"))


def load_profile(name: str) -> dict:
    path = PROFILES_DIR / f"{name}.json"
    if not path.is_file():
        available = ", ".join(list_profiles()) or "none"
        raise SystemExit(
            f"Profile '{name}' not found in {PROFILES_DIR}.\n"
            f"Available: {available}"
        )
    return json.loads(path.read_text(encoding="utf-8"))


def at(day_offset: int, hour: int, minute: int = 0) -> datetime:
    """Relative offset -> an absolute UTC timestamp.

    Everything in a profile is expressed against the moment of the run, so a
    profile never expires (see the header). Minutes default to 0 because most
    practices start on the hour.
    """
    base = datetime.now(UTC) + timedelta(days=day_offset)
    return base.replace(hour=hour, minute=minute, second=0, microsecond=0)


# ---------------------------------------------------------------------------
# People
# ---------------------------------------------------------------------------


def _master_capability(profile: MasterProfile | None) -> bool:
    """A verified MasterProfile -- the comms-group reading (set_role.py)."""
    return (
        profile is not None
        and (profile.data or {}).get("account", {}).get("status") == "verified"
    )


def _verified_profile_data(fields: dict) -> dict:
    """Fresh verified MasterProfile.data, in set_role.py's shape."""
    now_iso = datetime.now(UTC).isoformat()
    return {
        "account": {
            "status": "verified",
            "applied_at": now_iso,
            "verification": {
                "verified_at": now_iso,
                "verified_by": "cli_seed",
                "notes": "seeded via velo seed",
            },
            "rejections": [],
        },
        "profile": {
            "display_name": fields["display_name"],
            "email": None,
            "phone": None,
            "bio": fields.get("bio"),
            "methods": fields.get("methods", []),
            "experience_years": fields.get("experience_years", 0),
            "certifications": [],
        },
        "documents": [],
        "availability": {"is_accepting": True, "note": None},
        "settings": {
            "auto_confirm_bookings": True,
            "max_participants_default": 20,
        },
        "stats": {"total_practices": 0},
    }


def _set_role_master(user: User) -> None:
    """Role flip + clear a stale admin round-trip marker (set_role.py)."""
    user.role = UserRole.MASTER.value
    creds = copy.deepcopy(user.credentials or {})
    if (creds.get("role_switch") or {}).get("home_role"):
        creds.pop("role_switch", None)
        user.set_jsonb("credentials", creds)


async def ensure_user(
    session: AsyncSession,
    telegram_id: int,
    first_name: str,
    *,
    last_name: str | None = None,
) -> User:
    """Find-or-create, and for an EXISTING row change nothing.

    A real account that logged in before the seed already carries its true
    name and avatar from Telegram. Re-running the login upsert here would
    overwrite them with our stubs, so an existing user is returned untouched.
    """
    user = (
        await session.execute(
            select(User).where(User.telegram_id == telegram_id)
        )
    ).scalar_one_or_none()
    if user is not None:
        return user
    return await upsert_user_on_login(
        {
            "id": telegram_id,
            "first_name": first_name,
            "last_name": last_name,
            "username": None,
            "language_code": "ru",
        },
        session,
    )


async def ensure_master(
    session: AsyncSession, spec: dict
) -> User:
    """A verified master, through the same delta the app uses.

    Handles the three states a stand account can be in: absent, present but
    never a master, and present with an unverified profile (someone applied
    through the UI before the seed ran). The third case is re-verified in
    place rather than rejected -- a pending application on the demo master
    would leave every seeded practice unpublishable.
    """
    user = await ensure_user(
        session, spec["telegram_id"], spec["display_name"]
    )
    await session.flush()

    profile = await session.get(MasterProfile, user.id)
    had_master = _master_capability(profile)

    if profile is None:
        session.add(
            MasterProfile(user_id=user.id, data=_verified_profile_data(spec))
        )
    else:
        # An existing profile, which on a reused stand account is the norm.
        # Two things are fixed here and nothing else:
        #
        # 1. status -> verified, when it is not already. A pending
        #    application on the demo master would make every seeded practice
        #    unpublishable.
        # 2. THE METHODS THE PROFILE ASKS FOR ARE MERGED IN. This is not
        #    cosmetic: create_practice runs _assert_master_confirmed_taxonomy
        #    (practices/service.py:609), which refuses any direction/style the
        #    master has not confirmed. Without this merge the seed silently
        #    depends on whatever the person happened to type into their
        #    profile earlier -- and fails with "style 'presence' for direction
        #    'meditation' is not among your confirmed methods".
        #
        # MERGED, not replaced: this is a real person's profile. Methods they
        # added themselves stay; the profile only guarantees that what it is
        # about to seed is confirmed.
        data = copy.deepcopy(profile.data or {})
        acct = data.setdefault("account", {})
        if not had_master:
            acct["status"] = "verified"
            acct.setdefault(
                "verification",
                {
                    "verified_at": datetime.now(UTC).isoformat(),
                    "verified_by": "cli_seed",
                    "notes": "re-verified via velo seed",
                },
            )
            data.setdefault("availability", {})["is_accepting"] = True

        prof = data.setdefault("profile", {})
        existing_methods = list(prof.get("methods") or [])
        added = [
            m for m in spec.get("methods", []) if m not in existing_methods
        ]
        if added:
            prof["methods"] = existing_methods + added
            info(f"  methods added to existing profile: {', '.join(added)}")
        profile.set_jsonb("data", data)

    if user.role != UserRole.MASTER.value:
        _set_role_master(user)

    # snapshot + masters.join on ADD, silence when already a master
    await sync_membership_delta(
        session, user, group_key=GROUP_MASTERS, had=had_master, has=True
    )
    return user


# ---------------------------------------------------------------------------
# Practices
# ---------------------------------------------------------------------------


async def ensure_practice(
    session: AsyncSession,
    master: User,
    spec: dict,
) -> Practice | None:
    """Create one practice in the state the profile asks for.

    Idempotent by title within this master: re-running the seed does not
    duplicate. Titles carry the "[seed]" prefix from the profile, which is
    also what --reset matches on.

    THE STATE LADDER, and why 'completed' skips publication:
      draft      -> created and left alone. No Zoom meeting exists, which is
                    the point: the master can publish it by hand during a demo
                    and walk the real create-meeting -> check-in -> join flow.
      scheduled  -> created, then published through update_practice, which is
                    what creates the real Zoom meeting. Costs one Zoom API
                    call and one real meeting per practice.
      completed  -> created, then moved to completed DIRECTLY, without ever
                    passing through publication. These exist to fill history,
                    reviews and attendance; nobody joins a practice that
                    already happened, so minting a real Zoom meeting for each
                    of them would only litter the Zoom account -- and every
                    --reset would litter it again.
    """
    title = spec["title"]
    existing = (
        await session.execute(
            select(Practice).where(
                Practice.master_id == master.id,
                Practice.title == title,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing

    scheduled_at = at(
        spec["day_offset"], spec.get("hour", 10), spec.get("minute", 0)
    )
    state = spec.get("state", "scheduled")
    now = datetime.now(UTC)

    if state != "completed" and scheduled_at <= now:
        raise SystemExit(
            f"Profile error: '{title}' is state={state} but its day_offset "
            f"puts it at {scheduled_at:%Y-%m-%d %H:%M} UTC, which is already "
            f"past. Only state=completed may sit in the past."
        )

    # CreatePracticeRequest refuses a past scheduled_at (schemas.py:297) -- a
    # correct rule for the API, and one a seed of HISTORY cannot satisfy. So a
    # completed practice is created at a placeholder far in the future, passes
    # validation like any other, and is then moved back to where the profile
    # wants it. Going through the service still buys what it is here for:
    # taxonomy confirmation, audience wiring and the dedup window.
    #
    # The placeholder is derived from the real date (+400 days) rather than
    # being a constant, so two completed practices never collide inside the
    # service's create-dedup window.
    create_at = (
        scheduled_at + timedelta(days=400) if state == "completed"
        else scheduled_at
    )

    body = CreatePracticeRequest(
        practice_type=spec.get("practice_type", "live"),
        title=title,
        description=spec.get("description"),
        scheduled_at=create_at,
        duration_minutes=spec["duration_minutes"],
        timezone=spec.get("timezone", "Europe/Moscow"),
        direction=spec["direction"],
        style=spec.get("style"),
        difficulty=spec.get("difficulty", "beginner"),
        max_participants=spec.get("max_participants"),
        is_free=spec.get("is_free", True),
        price_cents=spec.get("price_cents", 0),
        currency=spec.get("currency", "eur"),
    )
    practice, _deduped = await create_practice(master, body, session)
    await session.flush()

    if state == "scheduled":
        await update_practice(
            practice.id,
            master,
            UpdatePracticeRequest(status="scheduled"),
            session,
        )
    elif state == "completed":
        # Back to the real date, and straight to completed without ever
        # publishing -- see the docstring for why no Zoom meeting is minted.
        practice.scheduled_at = scheduled_at
        practice.status = PracticeStatus.COMPLETED.value
    await session.flush()
    return practice


# ---------------------------------------------------------------------------
# Bookings, check-ins, feedback
# ---------------------------------------------------------------------------


async def ensure_booking(
    session: AsyncSession,
    practice: Practice,
    student: User,
    status: str,
) -> Booking:
    """A booking written directly, and deliberately so.

    The booking SERVICE charges a wallet, writes three ledger rows and holds
    a row lock -- correct for a real booking, wrong for seeding history that
    is supposed to already exist. Money is not what any demo screen reads
    here; attendance, check-ins and reviews are, and those hang off the
    booking row itself.
    """
    booking = (
        await session.execute(
            select(Booking).where(
                Booking.practice_id == practice.id,
                Booking.user_id == student.id,
            )
        )
    ).scalar_one_or_none()
    if booking is not None:
        return booking
    booking = Booking(
        practice_id=practice.id,
        user_id=student.id,
        status=status,
    )
    session.add(booking)
    await session.flush()
    return booking


async def ensure_checkin(
    session: AsyncSession,
    booking: Booking,
    mood: int,
    comment: str | None,
    check_type: str,
) -> None:
    """One check-in. Unique per (booking, check_type), so a booking can
    carry both the pre- and the post-practice one -- which is what the
    master's screens show side by side."""
    exists = (
        await session.execute(
            select(Checkin.id).where(
                Checkin.booking_id == booking.id,
                Checkin.check_type == check_type,
            )
        )
    ).first()
    if exists:
        return
    session.add(
        Checkin(
            practice_id=booking.practice_id,
            user_id=booking.user_id,
            booking_id=booking.id,
            mood=mood,
            comment=comment,
            check_type=check_type,
        )
    )


async def ensure_feedback(
    session: AsyncSession,
    booking: Booking,
    rating: int,
    comment: str | None,
) -> None:
    """One review. Unique per (practice, user).

    Only feedback on the master's COMPLETED practices reaches «Отзывы» and
    «Ключевые отзывы» (masters/reviews_service.py), and only a rating <= 3
    puts a student into «Требуют внимания» (students_service.py). A profile
    that wants both blocks populated must therefore seed both high and low
    ratings on completed practices -- there is no other way to light them up.
    """
    exists = (
        await session.execute(
            select(Feedback.id).where(
                Feedback.practice_id == booking.practice_id,
                Feedback.user_id == booking.user_id,
            )
        )
    ).first()
    if exists:
        return
    session.add(
        Feedback(
            practice_id=booking.practice_id,
            user_id=booking.user_id,
            booking_id=booking.id,
            rating=rating,
            comment=comment,
        )
    )


# ---------------------------------------------------------------------------
# Reset
# ---------------------------------------------------------------------------


async def reset_seed_data(session: AsyncSession, profile: dict) -> dict:
    """Remove what the seed created -- and nothing else.

    THE ONE RULE THIS FILE PROTECTS: live accounts survive. Real Telegram
    accounts on the stand are few and reused, so deleting one costs a person
    their history and their role. Synthetic students carry six-digit ids
    (SYNTH_MIN..SYNTH_MAX) and are the only users ever deleted here; a live
    master keeps their account, their MASTER role and their profile, and
    loses only the practices this script made for them.

    Practices are matched by title prefix, not by a marker column: the
    profile owns the prefix, so a demo can be wiped without touching a
    practice somebody created by hand on the same stand.
    """
    prefix = profile.get("title_prefix", "[seed]")
    counts = {"practices": 0, "students": 0}

    practice_ids = list(
        (
            await session.execute(
                select(Practice.id).where(Practice.title.startswith(prefix))
            )
        ).scalars()
    )
    if practice_ids:
        # Bookings cascade to check-ins and feedback (ondelete=CASCADE on
        # booking_id), so deleting the practices is enough -- but bookings
        # are removed explicitly first so the count is honest and the order
        # does not depend on FK configuration staying as it is today.
        await session.execute(
            delete(Booking).where(Booking.practice_id.in_(practice_ids))
        )
        await session.execute(
            delete(Practice).where(Practice.id.in_(practice_ids))
        )
        counts["practices"] = len(practice_ids)

    synth_ids = list(
        (
            await session.execute(
                select(User.id).where(
                    User.telegram_id >= SYNTH_MIN,
                    User.telegram_id <= SYNTH_MAX,
                )
            )
        ).scalars()
    )
    if synth_ids:
        await session.execute(delete(User).where(User.id.in_(synth_ids)))
        counts["students"] = len(synth_ids)

    await session.flush()
    return counts


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


async def seed_profile(
    session: AsyncSession, profile: dict, *, dry_run: bool
) -> dict:
    """Walk the profile top to bottom and report what was made."""
    stats = {
        "masters": 0,
        "students": 0,
        "practices": 0,
        "bookings": 0,
        "checkins": 0,
        "feedbacks": 0,
    }
    prefix = profile.get("title_prefix", "[seed]")

    if dry_run:
        info("DRY RUN -- nothing is written")
        for m in profile.get("masters", []):
            print(f"  master  {m['telegram_id']}  {m['display_name']}")
        for s in profile.get("students", []):
            print(f"  student {s['telegram_id']}  {s['first_name']}")
        for p in profile.get("practices", []):
            when = at(p["day_offset"], p.get("hour", 10), p.get("minute", 0))
            print(
                f"  practice [{p.get('state', 'scheduled'):9}] "
                f"{when:%Y-%m-%d %H:%M}  {p['duration_minutes']:>3} min  "
                f"{prefix} {p['title']}"
            )
        return stats

    # -- masters --
    masters: dict[str, User] = {}
    for spec in profile.get("masters", []):
        master = await ensure_master(session, spec)
        masters[spec["key"]] = master
        stats["masters"] += 1
        ok(f"master  {spec['telegram_id']}  {spec['display_name']}")

    # -- students --
    students: dict[str, User] = {}
    for spec in profile.get("students", []):
        student = await ensure_user(
            session, spec["telegram_id"], spec["first_name"]
        )
        students[spec["key"]] = student
        stats["students"] += 1
    await session.flush()
    ok(f"students {stats['students']}")

    # -- practices, and everything hanging off them --
    for spec in profile.get("practices", []):
        master = masters[spec["master"]]
        spec = {**spec, "title": f"{prefix} {spec['title']}"}
        practice = await ensure_practice(session, master, spec)
        if practice is None:
            continue
        stats["practices"] += 1

        for att in spec.get("attendees", []):
            student = students[att["student"]]
            booking = await ensure_booking(
                session, practice, student, att["booking_status"]
            )
            stats["bookings"] += 1

            for ci in att.get("checkins", []):
                await ensure_checkin(
                    session,
                    booking,
                    ci["mood"],
                    ci.get("comment"),
                    ci.get("type", CheckType.PRE.value),
                )
                stats["checkins"] += 1

            if "feedback" in att:
                await ensure_feedback(
                    session,
                    booking,
                    att["feedback"]["rating"],
                    att["feedback"].get("comment"),
                )
                stats["feedbacks"] += 1

        ok(
            f"practice [{spec.get('state', 'scheduled'):9}] "
            f"{spec['title']}"
        )

    return stats


async def main_async(args: argparse.Namespace) -> int:
    if args.list:
        names = list_profiles()
        if not names:
            warn(f"No profiles in {PROFILES_DIR}")
            return 1
        info("Available profiles:")
        for n in names:
            data = load_profile(n)
            print(f"  {n:12}  {data.get('description', '')}")
        return 0

    profile = load_profile(args.profile)
    info(f"Profile: {args.profile} -- {profile.get('description', '')}")

    session_factory = get_session_factory()
    try:
        async with session_factory() as session:
            if args.reset:
                counts = await reset_seed_data(session, profile)
                warn(
                    f"reset: removed {counts['practices']} practices, "
                    f"{counts['students']} synthetic students "
                    f"(live accounts untouched)"
                )
                await session.commit()

            if args.reset_only:
                return 0

            async with session_factory() as session2:
                stats = await seed_profile(
                    session2, profile, dry_run=args.dry_run
                )
                if not args.dry_run:
                    await session2.commit()

        if not args.dry_run:
            ok(
                "seeded: "
                + ", ".join(f"{v} {k}" for k, v in stats.items() if v)
            )
        return 0
    finally:
        await dispose_engine()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Seed the stand from a profile (test contour only)."
    )
    parser.add_argument(
        "--profile",
        default="default",
        help="profile name in scripts/seed_profiles/ (default: default)",
    )
    parser.add_argument(
        "--reset",
        action="store_true",
        help="remove previously seeded data first (live accounts survive)",
    )
    parser.add_argument(
        "--reset-only",
        action="store_true",
        help="remove seeded data and stop, without seeding again",
    )
    parser.add_argument(
        "--list", action="store_true", help="list available profiles"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print the plan without writing anything",
    )
    args = parser.parse_args()
    if args.reset_only:
        args.reset = True
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())
