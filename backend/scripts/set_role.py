#!/usr/bin/env python3
# =============================================================================
# VELO Backend -- Role management CLI (velo setrole)
# =============================================================================
#
# Sets a user's role (admin / master / user) by Telegram ID, or -- with no
# arguments -- lists the current admins and masters.
#
# Invoked from the host through the `velo` wrapper:
#     velo setrole <telegram_id> <A|M|U> [--yes]
#     velo setrole                      # list current admins & masters
# which runs, inside the app container:
#     python scripts/set_role.py <args>
#
# NON-STANDARD BITS THIS SCRIPT RELIES ON (verified against the codebase):
#   * ORM only -- no raw SQL. Own async session via get_session_factory(),
#     explicit commit, dispose_engine() in finally (same shape as seed*.py).
#     `async with session_factory() as session:` does NOT auto-commit.
#   * User.role loads as a plain str (column String(20), not an Enum type),
#     so compare with UserRole.X (StrEnum == its value) and print it directly;
#     `.value` on the loaded attribute would AttributeError. Writes assign the
#     enum's .value.
#   * MasterProfile JSONB is mutated ONLY through set_jsonb() (JSONBMixin);
#     never mutate profile.data in place (SQLAlchemy would miss the change).
#   * frozen_cents / available_cents are read-only cached balances owned by the
#     ledger listeners -- this script only READS them, never writes.
#
# ROLE TRANSITIONS:
#   -> admin : plain role flip.
#   -> master: the master guard needs a verified MasterProfile, so:
#               - a verified profile already exists -> just flip the role;
#               - a profile exists but is not verified -> re-verify it (no prompt);
#               - no profile -> prompt for the fields (empty input -> stub;
#                 string stubs carry the word "Отредактировать"), create a
#                 verified profile, then flip the role.
#   -> user  : downgrade guard (option B). Blocked while the account still has
#              a "live" master side: scheduled/live practices, a non-zero
#              balance, or a pending withdrawal. When allowed: flip the role and
#              soft-freeze the profile (account.status=suspended,
#              availability.is_accepting=false) -- nothing is deleted.
# =============================================================================

from __future__ import annotations

import argparse
import asyncio
import copy
import sys
from datetime import UTC, datetime
from pathlib import Path

# -- sys.path bootstrap ------------------------------------------------------
# Put backend/ on sys.path so `app.*` imports resolve when the file is run as
# `python scripts/set_role.py` (the script dir, not backend/, is sys.path[0]).
_SCRIPTS_DIR = Path(__file__).resolve().parent
_BACKEND_DIR = _SCRIPTS_DIR.parent
for _p in (_SCRIPTS_DIR, _BACKEND_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

from sqlalchemy import func, select  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession  # noqa: E402

from app.core.database import dispose_engine, get_session_factory  # noqa: E402
from app.core.events import (  # noqa: E402  # Phase 6 / T0
    GROUP_ADMINS,
    GROUP_MASTERS,
    sync_membership_delta,
)
from app.modules.masters.models import MasterProfile  # noqa: E402
from app.modules.practices.models import Practice, PracticeStatus  # noqa: E402
from app.modules.users.models import User, UserRole  # noqa: E402
from app.modules.users.schemas import (  # noqa: E402
    credentials_without_admin_home,
    has_admin_home,
)
from app.modules.withdrawals.models import Withdrawal, WithdrawalStatus  # noqa: E402

# -- Console output ----------------------------------------------------------
C = "\033[0;36m"   # cyan
Y = "\033[1;33m"   # yellow
G = "\033[0;32m"   # green
R = "\033[0;31m"   # red
N = "\033[0m"      # reset


def info(msg: str) -> None:
    print(msg)


def ok(msg: str) -> None:
    print(f"{G}{msg}{N}")


def warn(msg: str) -> None:
    print(f"{Y}{msg}{N}")


def err(msg: str) -> None:
    print(f"{R}{msg}{N}")


# String stub placeholder for master-profile fields left blank on create.
EDIT = "Отредактировать"

# Accepted role spellings -> canonical UserRole (A/a/Admin/admin, etc.).
_ROLE_ALIASES = {
    "a": UserRole.ADMIN,
    "admin": UserRole.ADMIN,
    "m": UserRole.MASTER,
    "master": UserRole.MASTER,
    "u": UserRole.USER,
    "user": UserRole.USER,
}


def normalize_role(raw: str) -> UserRole:
    """Map any accepted spelling of a role to its canonical UserRole."""
    key = raw.strip().lower()
    if key not in _ROLE_ALIASES:
        raise ValueError(
            f"Unknown role '{raw}'. Use A/M/U (admin / master / user)."
        )
    return _ROLE_ALIASES[key]


# -- Small read helpers ------------------------------------------------------

def _username(user: User) -> str:
    """@username from the credentials JSONB, or an em dash when absent."""
    uname = (user.credentials or {}).get("telegram_username")
    return f"@{uname}" if uname else "—"


def _full_name(user: User) -> str:
    """'First Last' (surname appended only if present), or an em dash."""
    name = " ".join(
        p for p in (user.first_name or "", user.last_name or "") if p
    ).strip()
    return name or "—"


async def _find_user(session: AsyncSession, telegram_id: int) -> User | None:
    stmt = select(User).where(User.telegram_id == telegram_id)
    return (await session.execute(stmt)).scalar_one_or_none()


async def _scheduled_or_live_practices(session: AsyncSession, user_id) -> int:
    """Count of this master's practices that are still bookable/running."""
    stmt = (
        select(func.count())
        .select_from(Practice)
        .where(
            Practice.master_id == user_id,
            Practice.status.in_(
                [PracticeStatus.SCHEDULED.value, PracticeStatus.LIVE.value]
            ),
        )
    )
    return int((await session.execute(stmt)).scalar_one())


async def _pending_withdrawals(session: AsyncSession, user_id) -> int:
    stmt = (
        select(func.count())
        .select_from(Withdrawal)
        .where(
            Withdrawal.user_id == user_id,
            Withdrawal.status == WithdrawalStatus.PENDING.value,
        )
    )
    return int((await session.execute(stmt)).scalar_one())


# -- Display -----------------------------------------------------------------

async def _print_summary(session: AsyncSession, user: User) -> None:
    """Print the target user's current data (shown before any change)."""
    info(f"  telegram_id : {user.telegram_id}")
    info(f"  name        : {_full_name(user)}")
    info(f"  username    : {_username(user)}")
    info(f"  role        : {user.role}")

    profile = await session.get(MasterProfile, user.id)
    if profile is None:
        info("  master      : (no profile)")
        return

    acct = (profile.data or {}).get("account", {})
    avail = (profile.data or {}).get("availability", {})
    sched = await _scheduled_or_live_practices(session, user.id)
    pend = await _pending_withdrawals(session, user.id)
    info(
        "  master      : "
        f"status={acct.get('status', 'unknown')}, "
        f"is_accepting={avail.get('is_accepting')}, "
        f"available={profile.available_cents}c, frozen={profile.frozen_cents}c, "
        f"scheduled/live={sched}, pending_withdrawals={pend}"
    )


def _confirm(prompt: str, assume_yes: bool) -> bool:
    """y/n confirmation (Enter/anything-but-yes = no). --yes -> True."""
    if assume_yes:
        return True
    return input(f"{prompt} (y/n): ").strip().lower() in ("y", "yes")


# -- List mode ---------------------------------------------------------------

async def list_privileged(session: AsyncSession) -> None:
    """Print current admins and masters (regular users are omitted)."""
    stmt = select(User).where(
        User.role.in_([UserRole.ADMIN.value, UserRole.MASTER.value])
    )
    users = list((await session.execute(stmt)).scalars().all())
    admins = [u for u in users if u.role == UserRole.ADMIN]
    masters = [u for u in users if u.role == UserRole.MASTER]

    def _key(u: User):
        # telegram_id is nullable in principle -> keep Nones last, no TypeError.
        return (u.telegram_id is None, u.telegram_id)

    def _dump(title: str, rows: list[User]) -> None:
        print(f"{C}{title} ({len(rows)}):{N}")
        if not rows:
            print("  (none)")
            return
        for u in sorted(rows, key=_key):
            print(f"  {u.telegram_id} · {_full_name(u)} · {_username(u)}")

    _dump("Admins", admins)
    _dump("Masters", masters)


# -- Master profile build (mirrors masters/service._build_data) --------------

def _stub_fields(user: User) -> dict:
    """All-blank profile -> stub values (used with --yes, no prompting)."""
    return {
        "display_name": user.first_name or EDIT,
        "methods": [],
        "experience_years": 0,
        "bio": EDIT,
        "email": None,
        "phone": None,
    }


def _prompt_fields(user: User) -> dict:
    """Ask for each field; empty input -> stub (strings carry EDIT)."""
    warn(
        f"No master profile found. Enter profile fields "
        f"(Enter = leave blank -> stubbed with '{EDIT}'):"
    )
    display_name = input("  display_name: ").strip() or (user.first_name or EDIT)

    methods_raw = input(
        "  methods (comma-separated, e.g. yoga,meditation): "
    ).strip()
    methods = [m.strip() for m in methods_raw.split(",") if m.strip()]

    exp_raw = input("  experience_years (integer): ").strip()
    try:
        experience_years = int(exp_raw) if exp_raw else 0
    except ValueError:
        warn(f"  '{exp_raw}' is not an integer -> 0")
        experience_years = 0

    return {
        "display_name": display_name,
        "methods": methods,
        "experience_years": experience_years,
        "bio": input("  bio: ").strip() or EDIT,
        "email": input("  email: ").strip() or None,
        "phone": input("  phone: ").strip() or None,
    }


def _build_verified_data(fields: dict) -> dict:
    """Build a fresh, verified MasterProfile.data from operator-provided fields.

    Structure mirrors masters/service._build_data (is_accepting /
    auto_confirm_bookings / max_participants_default) with account.status
    pre-set to 'verified'.
    """
    now_iso = datetime.now(UTC).isoformat()
    return {
        "account": {
            "status": "verified",
            "applied_at": now_iso,
            "verification": {
                "verified_at": now_iso,
                "verified_by": "cli_setrole",
                "notes": "master granted via velo setrole",
            },
            "rejections": [],
        },
        "profile": {
            "display_name": fields["display_name"],
            "email": fields["email"],
            "phone": fields["phone"],
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
        "seed": {"source": "cli_setrole", "granted_at": now_iso},
    }


def _set_role(user: User, role: UserRole) -> None:
    """Assign the role and clear any switched-away-admin round-trip marker.

    Stores the plain string (column is String(20)). An authoritative CLI role
    change makes THIS role the account's new home, so a stale
    credentials.role_switch.home_role="admin" must not survive -- otherwise a
    demoted ex-admin (-> user) could self-restore admin via POST /users/me/role,
    which derive_allowed_roles() would honour (R-1). Writes credentials only
    when the marker was actually present, to avoid a needless UPDATE.
    """
    user.role = role.value
    cleared = credentials_without_admin_home(user.credentials)
    if cleared != (user.credentials or {}):
        user.set_jsonb("credentials", cleared)


# -- Transition handlers (each returns True if a change needs committing) -----

# Phase 6 / T0: every authoritative role change here projects its
# CAPABILITY delta into the comms contact book (group:masters keys on a
# verified MasterProfile, group:admins on role==admin OR the
# switched-away-admin marker). emit goes through the same session --
# the CLI's single commit at the end covers domain change + events
# together (ID-2).


def _admin_capability(user: User) -> bool:
    """role==admin OR the round-trip marker -- the comms-group reading."""
    return user.role == UserRole.ADMIN or has_admin_home(user.credentials)


def _master_capability(profile: MasterProfile | None) -> bool:
    """A verified MasterProfile -- the comms-group reading."""
    return (
        profile is not None
        and (profile.data or {}).get("account", {}).get("status") == "verified"
    )


async def to_admin(session: AsyncSession, user: User, assume_yes: bool) -> bool:
    if user.role == UserRole.ADMIN:
        warn("Already admin — nothing to do.")
        return False
    if not _confirm("Set role to admin?", assume_yes):
        warn("Cancelled.")
        return False
    had_admin = _admin_capability(user)
    _set_role(user, UserRole.ADMIN)
    # Master capability is untouched (profile not written) -- only the
    # admins delta can fire. A marker-holder returning via CLI keeps
    # capability across the flip -> no event, by design.
    await sync_membership_delta(
        session,
        user,
        group_key=GROUP_ADMINS,
        had=had_admin,
        has=_admin_capability(user),
    )
    ok("Role set to admin.")
    return True


async def to_master(session: AsyncSession, user: User, assume_yes: bool) -> bool:
    profile = await session.get(MasterProfile, user.id)
    # Phase 6 / T0: capabilities at entry, deltas emitted on every
    # True-return path below (see the block comment above to_admin).
    had_master = _master_capability(profile)
    had_admin = _admin_capability(user)

    async def _emit_deltas() -> None:
        await sync_membership_delta(
            session, user, group_key=GROUP_MASTERS, had=had_master, has=True
        )
        await sync_membership_delta(
            session,
            user,
            group_key=GROUP_ADMINS,
            had=had_admin,
            has=_admin_capability(user),
        )

    if profile is not None:
        status = (profile.data or {}).get("account", {}).get("status")

        if status == "verified" and user.role == UserRole.MASTER:
            warn("Already a verified master — nothing to do.")
            return False

        if status == "verified":
            if not _confirm("Set role to master?", assume_yes):
                warn("Cancelled.")
                return False
            _set_role(user, UserRole.MASTER)
            await _emit_deltas()
            ok("Role set to master.")
            return True

        # Profile exists but is not verified (pending / rejected / suspended):
        # re-verify the existing data in place, no re-prompt.
        if not _confirm(
            f"Re-verify existing profile (status='{status}') and set role master?",
            assume_yes,
        ):
            warn("Cancelled.")
            return False
        data = copy.deepcopy(profile.data or {})
        acct = data.setdefault("account", {})
        acct["status"] = "verified"
        acct.setdefault(
            "verification",
            {
                "verified_at": datetime.now(UTC).isoformat(),
                "verified_by": "cli_setrole",
                "notes": "re-verified via velo setrole",
            },
        )
        data.setdefault("availability", {})["is_accepting"] = True
        profile.set_jsonb("data", data)
        _set_role(user, UserRole.MASTER)
        await _emit_deltas()
        ok("Existing profile re-verified; role set to master.")
        return True

    # No profile: collect fields (or stub with --yes), create a verified one.
    fields = _stub_fields(user) if assume_yes else _prompt_fields(user)
    if not _confirm(
        f"Create verified master profile "
        f"(display_name='{fields['display_name']}') and set role master?",
        assume_yes,
    ):
        warn("Cancelled.")
        return False
    session.add(MasterProfile(user_id=user.id, data=_build_verified_data(fields)))
    _set_role(user, UserRole.MASTER)
    await _emit_deltas()
    ok("Verified master profile created; role set to master.")
    return True


async def to_user(session: AsyncSession, user: User, assume_yes: bool) -> bool:
    profile = await session.get(MasterProfile, user.id)

    # Downgrade guard (option B): block while the master side is still "live".
    if profile is not None:
        blocks: list[str] = []
        sched = await _scheduled_or_live_practices(session, user.id)
        if sched > 0:
            blocks.append(f"{sched} practice(s) in scheduled/live status")
        if profile.frozen_cents > 0 or profile.available_cents > 0:
            blocks.append(
                f"non-zero balance (available={profile.available_cents}c, "
                f"frozen={profile.frozen_cents}c)"
            )
        pend = await _pending_withdrawals(session, user.id)
        if pend > 0:
            blocks.append(f"{pend} pending withdrawal(s)")
        if blocks:
            err("Cannot downgrade to user — resolve these first:")
            for b in blocks:
                err(f"  - {b}")
            return False

    if user.role == UserRole.USER and profile is None:
        warn("Already a plain user — nothing to do.")
        return False

    if not _confirm("Set role to user?", assume_yes):
        warn("Cancelled.")
        return False

    # Phase 6 / T0: capabilities before the writes (see to_admin block).
    had_master = _master_capability(profile)
    had_admin = _admin_capability(user)

    _set_role(user, UserRole.USER)

    # Soft-freeze the master side: keep every row, just park the profile.
    if profile is not None:
        data = copy.deepcopy(profile.data or {})
        data.setdefault("account", {})["status"] = "suspended"
        data.setdefault("availability", {})["is_accepting"] = False
        profile.set_jsonb("data", data)
        ok("Role set to user; master profile suspended (is_accepting=false).")
    else:
        ok("Role set to user.")

    # verified -> suspended drops master capability; the authoritative
    # flip cleared the admin marker -> admin capability is gone too.
    await sync_membership_delta(
        session, user, group_key=GROUP_MASTERS, had=had_master, has=False
    )
    await sync_membership_delta(
        session,
        user,
        group_key=GROUP_ADMINS,
        had=had_admin,
        has=_admin_capability(user),
    )
    return True


_HANDLERS = {
    UserRole.ADMIN: to_admin,
    UserRole.MASTER: to_master,
    UserRole.USER: to_user,
}


# -- CLI ---------------------------------------------------------------------

def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="velo setrole",
        description=(
            "Set a user's role (admin/master/user) by Telegram ID. "
            "With no arguments, lists the current admins and masters."
        ),
    )
    p.add_argument(
        "telegram_id",
        nargs="?",
        type=int,
        help="Target user's Telegram ID. Omit to list admins & masters.",
    )
    p.add_argument(
        "role",
        nargs="?",
        help="Target role: A/M/U (admin/master/user).",
    )
    p.add_argument(
        "--yes",
        "-y",
        action="store_true",
        help="Skip the y/n confirmation (and skip profile prompts: stub them).",
    )
    return p.parse_args()


async def main() -> int:
    args = _parse_args()
    session_factory = get_session_factory()
    try:
        async with session_factory() as session:
            # No telegram_id -> list mode (read-only, no commit).
            if args.telegram_id is None:
                await list_privileged(session)
                return 0

            if args.role is None:
                err("Usage: velo setrole <telegram_id> <A|M|U>")
                return 1
            try:
                role = normalize_role(args.role)
            except ValueError as exc:
                err(str(exc))
                return 1

            user = await _find_user(session, args.telegram_id)
            if user is None:
                err(
                    f"User with telegram_id={args.telegram_id} not found. "
                    f"The account must open the bot at least once (create a "
                    f"User row), then retry."
                )
                return 1

            print(f"{C}Current:{N}")
            await _print_summary(session, user)
            print(f"{C}Change:{N} role {user.role} -> {role.value}")

            applied = await _HANDLERS[role](session, user, args.yes)
            if applied:
                await session.commit()
                ok("Committed.")
            return 0
    finally:
        await dispose_engine()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
