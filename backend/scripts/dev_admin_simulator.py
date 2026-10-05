#!/usr/bin/env python3
# =============================================================================
# VELO Backend -- LOCAL DEV ONLY: the admin simulator
# =============================================================================
#
# Auto-approves the user's admin-gated requests by calling the REAL admin
# services in-process. Exists because the app has no non-Telegram login:
# a standalone "admin bot" cannot authenticate against the HTTP API, so the
# simulator works at the service layer, exactly where the admin routers land.
#
#   --watch / --once  pending master applications -> verify_master(),
#                     pending method-change requests -> approve_method_change()
#   --promote <user>  user -> master via make_master() (creates the profile,
#                     re-verifies pending/rejected/suspended, sets the role)
#   --suspend <user>  master -> user via revoke_master() (suspended)
#   --reset-master <user>  fresh cycle: delete the MasterProfile row and set
#                     role=user -- there is NO api/cli path for this, it is
#                     a local-only jump
#   --block/--unblock <user>  users.is_active toggle
#
# EVERYTHING here is a local-dev convenience. NEVER point it at a shared,
# staging or production database: it approves applications without a human
# admin and --reset-master deletes profile rows.
#
# Audit: the real services record audit entries. The acting "admin" is the
# first role=admin user if one exists, otherwise the target user themselves
# (the notes field says dev_admin_simulator).
#
# USAGE (from backend/):
#   .venv/bin/python scripts/dev_admin_simulator.py --watch --only @vladimir_kotkot
#   .venv/bin/python scripts/dev_admin_simulator.py --promote @vladimir_kotkot
#   .venv/bin/python scripts/dev_admin_simulator.py --suspend @vladimir_kotkot
#   .venv/bin/python scripts/dev_admin_simulator.py --reset-master @vladimir_kotkot --dry-run
# =============================================================================

import argparse
import asyncio
import sys
from pathlib import Path
from uuid import UUID

_backend_dir = Path(__file__).resolve().parent.parent
if str(_backend_dir) not in sys.path:
    sys.path.insert(0, str(_backend_dir))

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import dispose_engine, get_session_factory
from app.core.exceptions import VeloError
from app.modules.admin.masters.service import (
    approve_method_change,
    revoke_master,
    verify_master,
)
from app.modules.admin.users.service import make_master
from app.modules.curator_groups.models import CuratorGroupMasterOffer
from app.modules.curator_groups.service import accept_curator_group_master_offer
# MasterProfile.user is a STRING forward-ref relationship ("User"): a
# standalone script only registers the classes it imports, and without User
# mapped the first ORM operation dies in configure_mappers(). Same reason
# normalize_master_methods.py imports its models explicitly.
from app.modules.masters.models import MasterProfile
from app.modules.users.models import User, UserRole

SIM_NOTES = "dev_admin_simulator"


def log(msg: str) -> None:
    print(f"[SIM] {msg}", flush=True)


async def resolve_user(session: AsyncSession, ref: str) -> User:
    """Find one user by UUID, telegram username (with/without @) or name part."""
    ref = ref.strip()
    if not ref:
        raise SystemExit("empty user reference")
    user = None
    try:
        user = await session.get(User, UUID(ref))
    except ValueError:
        pass
    if user is None:
        handle = ref.lstrip("@").lower()
        rows = (
            await session.execute(select(User).order_by(User.created_at.desc()).limit(500))
        ).scalars().all()
        candidates = [
            u
            for u in rows
            if handle in ((u.credentials or {}).get("telegram_username") or "").lower()
            or handle in f"{u.first_name or ''} {u.last_name or ''}".lower()
        ]
        if len(candidates) > 1:
            listing = ", ".join(
                f"{u.id} ({u.first_name} @{(u.credentials or {}).get('telegram_username')})"
                for u in candidates[:5]
            )
            raise SystemExit(f"ambiguous reference {ref!r}: {listing}")
        user = candidates[0] if candidates else None
    if user is None:
        raise SystemExit(f"user not found: {ref}")
    return user


async def first_admin(session: AsyncSession) -> User | None:
    return (
        await session.execute(select(User).where(User.role == UserRole.ADMIN).limit(1))
    ).scalar_one_or_none()


def describe(user: User | None, profile: MasterProfile | None) -> str:
    if user is None:
        return "<user row missing>"
    status = (profile.data or {}).get("account", {}).get("status") if profile else None
    tg = (user.credentials or {}).get("telegram_username")
    return f"{user.first_name} (@{tg}) role={user.role} profile={status}"


async def scan(
    session: AsyncSession, only: str | None
) -> tuple[list[MasterProfile], list[MasterProfile]]:
    """Pending applications + pending method-change requests (Python-side)."""
    profiles = (await session.execute(select(MasterProfile))).scalars().all()
    users = {u.id: u for u in (await session.execute(select(User))).scalars().all()}

    def matches(p: MasterProfile) -> bool:
        if not only:
            return True
        needle = only.lstrip("@").lower()
        u = users.get(p.user_id)
        if u is None:
            return False
        return needle in ((u.credentials or {}).get("telegram_username") or "").lower() or (
            needle in f"{u.first_name or ''} {u.last_name or ''}".lower()
        )

    applications: list[MasterProfile] = []
    method_changes: list[MasterProfile] = []
    for p in profiles:
        data = p.data or {}
        if (data.get("account") or {}).get("status") == "pending" and matches(p):
            applications.append(p)
        if (data.get("profile") or {}).get("method_change_request") and matches(p):
            method_changes.append(p)
    return applications, method_changes


async def watch_pass(
    session: AsyncSession, only: str | None, can_create_groups: bool, dry_run: bool
) -> None:
    applications, method_changes = await scan(session, only)
    if not applications and not method_changes:
        log("nothing pending")
    for profile in applications:
        target = await session.get(User, profile.user_id)
        actor = target if target is not None else await first_admin(session)
        label = describe(target, profile)
        if dry_run:
            log(f"[DRY] would verify application: {label}")
            continue
        try:
            await verify_master(
                profile.user_id,
                actor,
                f"{SIM_NOTES}: auto-approved master application",
                session,
                can_create_groups=can_create_groups,
            )
            await session.commit()
            log(f"VERIFIED application: {label}")
        except VeloError as e:
            await session.rollback()
            log(f"skip application {profile.user_id}: {e.message}")
    for profile in method_changes:
        target = await session.get(User, profile.user_id)
        actor = target if target is not None else await first_admin(session)
        label = describe(target, profile)
        proposed = (
            (profile.data or {}).get("profile", {}).get("method_change_request", {}).get("proposed_methods", [])
        )
        if dry_run:
            log(f"[DRY] would approve method change for {label}: {proposed}")
            continue
        try:
            await approve_method_change(profile.user_id, actor, session)
            await session.commit()
            log(f"APPROVED method change: {label} -> {proposed}")
        except VeloError as e:
            await session.rollback()
            log(f"skip method change {profile.user_id}: {e.message}")


async def run_watch(
    once: bool, interval: float, only: str | None, can_create_groups: bool, dry_run: bool
) -> None:
    factory = get_session_factory()
    while True:
        async with factory() as session:
            await watch_pass(session, only, can_create_groups, dry_run)
        if once:
            return
        try:
            await asyncio.sleep(interval)
        except asyncio.CancelledError:
            return


async def actor_or_self(session: AsyncSession, target: User) -> User:
    return await first_admin(session) or target


async def run_promote(ref: str, dry_run: bool) -> None:
    factory = get_session_factory()
    async with factory() as session:
        user = await resolve_user(session, ref)
        log(f"target: {describe(user, await session.get(MasterProfile, user.id))}")
        if dry_run:
            log("[DRY] would call make_master() -- verified profile + role=master")
            return
        if user.role == UserRole.MASTER:
            log("already a master -- nothing to do (make_master is idempotent-reject)")
            return
        await make_master(user.id, await actor_or_self(session, user), session)
        await session.commit()
        await session.refresh(user)
        log(f"PROMOTED: {describe(user, await session.get(MasterProfile, user.id))}")


async def run_suspend(ref: str, dry_run: bool) -> None:
    factory = get_session_factory()
    async with factory() as session:
        user = await resolve_user(session, ref)
        log(f"target: {describe(user, await session.get(MasterProfile, user.id))}")
        if dry_run:
            log("[DRY] would call revoke_master() -- role=user, status=suspended")
            return
        await revoke_master(user.id, await actor_or_self(session, user), session)
        await session.commit()
        await session.refresh(user)
        log(f"SUSPENDED: {describe(user, await session.get(MasterProfile, user.id))}")


async def run_reset_master(ref: str, dry_run: bool) -> None:
    factory = get_session_factory()
    async with factory() as session:
        user = await resolve_user(session, ref)
        profile = await session.get(MasterProfile, user.id)
        log(f"target: {describe(user, profile)}")
        if dry_run:
            log("[DRY] would DELETE the master_profiles row and set role=user")
            return
        if profile is not None:
            await session.delete(profile)
        user.role = UserRole.USER
        await session.commit()
        await session.refresh(user)
        log(f"RESET: {describe(user, None)} (profile row deleted -- apply fresh)")


async def run_block(ref: str, blocked: bool, dry_run: bool) -> None:
    factory = get_session_factory()
    async with factory() as session:
        user = await resolve_user(session, ref)
        log(f"target: {describe(user, None)} is_active={user.is_active}")
        if dry_run:
            log(f"[DRY] would set is_active={not blocked}")
            return
        user.is_active = not blocked
        await session.commit()
        log(f"{'BLOCKED' if blocked else 'UNBLOCKED'}: {user.first_name} is_active={user.is_active}")


async def run_accept_offer(ref: str, dry_run: bool) -> None:
    """Consent to an outstanding master offer ON THE CANDIDATE'S BEHALF.

    The offer flow (GT-27) waits for the candidate's own consent -- locally a
    seeded candidate has no Telegram account, so nobody can press accept in
    the app; this replays that consent through the real accept service.
    """
    factory = get_session_factory()
    async with factory() as session:
        user = await resolve_user(session, ref)
        offers = (
            await session.execute(
                select(CuratorGroupMasterOffer).where(
                    CuratorGroupMasterOffer.to_user_id == user.id
                )
            )
        ).scalars().all()
        if not offers:
            raise SystemExit(f"no outstanding master offer for {user.first_name}")
        if dry_run:
            for o in offers:
                log(f"[DRY] would accept master offer: group={o.group_id} for {user.first_name}")
            return
        for offer in offers:
            await accept_curator_group_master_offer(
                offer.group_id, user.id, session, actor=user
            )
            await session.commit()
            log(
                f"ACCEPTED master offer: user={user.first_name} group={offer.group_id} "
                "-- member promoted to master"
            )


async def main() -> None:
    parser = argparse.ArgumentParser(
        description="LOCAL DEV ONLY -- admin simulator (auto-approve). "
        "Never point at a shared/staging/production database."
    )
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--watch", action="store_true", help="loop: auto-approve pending requests")
    action.add_argument("--promote", metavar="USER", help="user -> master (make_master)")
    action.add_argument("--suspend", metavar="USER", help="master -> user (revoke_master)")
    action.add_argument("--reset-master", metavar="USER", help="delete master profile + role=user (fresh cycle)")
    action.add_argument(
        "--accept-offer", metavar="USER",
        help="consent to an outstanding school master-offer on the candidate's behalf",
    )
    action.add_argument("--block", metavar="USER", help="users.is_active -> False")
    action.add_argument("--unblock", metavar="USER", help="users.is_active -> True")
    parser.add_argument("--only", metavar="USER", help="watch filter: telegram username / name part")
    parser.add_argument(
        "--once", action="store_true", help="with --watch: single scan and exit (no loop)"
    )
    parser.add_argument("--interval", type=float, default=2.0, help="watch poll seconds (default 2)")
    parser.add_argument(
        "--can-create-groups", action="store_true", help="grant the school-founding right on verify"
    )
    parser.add_argument("--dry-run", action="store_true", help="print actions without writing")
    args = parser.parse_args()

    try:
        if args.watch or args.once:
            await run_watch(
                once=args.once,
                interval=args.interval,
                only=args.only,
                can_create_groups=args.can_create_groups,
                dry_run=args.dry_run,
            )
        elif args.promote:
            await run_promote(args.promote, args.dry_run)
        elif args.suspend:
            await run_suspend(args.suspend, args.dry_run)
        elif args.reset_master:
            await run_reset_master(args.reset_master, args.dry_run)
        elif args.accept_offer:
            await run_accept_offer(args.accept_offer, args.dry_run)
        elif args.block:
            await run_block(args.block, blocked=True, dry_run=args.dry_run)
        elif args.unblock:
            await run_block(args.unblock, blocked=False, dry_run=args.dry_run)
    except KeyboardInterrupt:
        log("stopped")
    finally:
        await dispose_engine()


if __name__ == "__main__":
    asyncio.run(main())

