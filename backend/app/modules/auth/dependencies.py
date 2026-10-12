# =============================================================================
# VELO Backend — Auth Dependencies
# =============================================================================
#
# TD-029 fix: added get_current_user_write.
#   PATCH /users/me previously opened two DB sessions:
#     1. get_current_user → get_db_reader (read-only)
#     2. Depends(get_db_session) in the router → write session
#   The service had to call session.merge(user) to transfer the object
#   from the reader to the writer, which is unnecessary overhead.
#
#   get_current_user_write uses get_db_session instead of get_db_reader.
#   FastAPI caches Depends within a request, so if the router also
#   declares Depends(get_db_session), both receive the SAME session
#   instance — one connection total, no merge needed.
#
# BE-146: ONE POOLED CONNECTION AT A TIME PER REQUEST.
#   get_current_user / get_optional_user / get_current_master used to load
#   through Depends(get_db_reader). That reader is a request-scoped yield
#   dependency: its connection stayed checked out until AFTER the response
#   was sent. On an endpoint that also takes get_db_session the request
#   therefore held the reader's connection while acquiring the writer's --
#   and with every pool slot (30 per worker) held by such a first
#   connection, all of them waited for a second one that nobody could
#   return: the pool stood still until pool_timeout (30 s) answered 500.
#   84 endpoints were in that class (measured over the dependency tree).
#
#   Now these dependencies load through _auth_session(): a session of their
#   own, opened only after the token passed the Redis check, closed before
#   the dependency returns. The connection is back in the pool before the
#   endpoint body runs; the endpoint's own session (reader or writer) is the
#   only one it holds. The returned User / MasterProfile is DETACHED with
#   its columns loaded (close() expunges, it does not expire). Neither model
#   is lazily loaded anywhere it comes from here (User has no
#   relationships; MasterProfile.user is never read off an auth object).
#
#   WHY NOT get_current_user_write EVERYWHERE (rejected at the BE-146 gate).
#   An object already in a session's identity map is NOT refreshed by a
#   later locking read of the same row without populate_existing -- the lock
#   is taken, the attributes stay as first loaded. Loading the caller into
#   the write session up front would make every such lock re-check a stale
#   value: purchase.py's balance check and withdrawals' available_cents
#   check among them. A detached auth object keeps every locking read in
#   the write session a fresh load, exactly as it was with the reader.
#   tests/test_be146_one_connection_per_request.py pins both halves: no
#   route combines the reader with the writer, and no auth dependency
#   returns with a connection still checked out.
#
# DEPENDENCY OVERVIEW:
#   get_current_user       — any authenticated user, own short session
#   get_current_user_write — any authenticated user, write session (TD-029)
#   get_optional_user      — optional auth, own short session
#   get_current_admin      — admin role required (wraps get_current_user)
#   get_current_master     — verified master required (wraps
#                            get_current_user; profile in its own short
#                            session)
# =============================================================================

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from uuid import UUID

from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db_session, get_session_factory
from app.core.exceptions import ForbiddenError, UnauthorizedError
from app.modules.auth.service import get_session
from app.modules.masters.models import MasterProfile
from app.modules.users.models import User, UserRole

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _extract_token(request: Request) -> str | None:
    """Extract Bearer token from Authorization header.

    Returns None if header is missing or malformed.
    """
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    token = auth[len("Bearer "):]
    return token or None


def _parse_user_id(session_data: dict) -> UUID:
    """Parse user_id from Redis session data.

    Prevents asyncpg DataError (-> 500) if Redis contains corrupted
    or non-UUID values. Returns clean 401 instead.

    Covers: missing key, malformed string, None, non-string types.
    """
    try:
        return UUID(session_data["user_id"])
    except (KeyError, ValueError, TypeError, AttributeError):
        raise UnauthorizedError("Invalid session data") from None


# ---------------------------------------------------------------------------
# Core auth helpers (extracted to avoid duplication between the two variants)
# ---------------------------------------------------------------------------


async def _authenticated_user_id(request: Request) -> UUID:
    """Token -> Redis -> user id. Raises UnauthorizedError.

    Touches no database: every refusal here costs no pooled connection.
    """
    token = _extract_token(request)
    if not token:
        raise UnauthorizedError("Authorization header required")

    session_data = await get_session(token)
    if not session_data:
        raise UnauthorizedError("Invalid or expired session")

    return _parse_user_id(session_data)


async def _active_user(user_id: UUID, session: AsyncSession) -> User:
    """Load the session's user; 401 if gone, 403 if deactivated."""
    stmt = select(User).where(User.id == user_id)
    result = await session.execute(stmt)
    user = result.scalar_one_or_none()

    # Return 401, not 404 -- valid Redis session but deleted user means
    # the session is effectively stale. 404 would leak that user_id existed.
    if not user:
        raise UnauthorizedError("Invalid or expired session")

    if not user.is_active:
        raise ForbiddenError("Account is deactivated")

    return user


@asynccontextmanager
async def _auth_session() -> AsyncIterator[AsyncSession]:
    """A session of the auth dependency's own, closed before it returns.

    READ-ONLY BY CONSTRUCTION: the auth path writes nothing -- no flush, no
    commit; the users row is only SELECTed (the Redis session is not touched
    either: get_session is a plain GET). Closing therefore discards nothing
    and returns the connection to the pool, on success and on every raise
    alike (BE-146, see the module header).
    """
    async with get_session_factory()() as session:
        yield session


async def _load_user_from_request(
    request: Request,
    session: AsyncSession,
) -> User:
    """Shared auth logic for a caller-supplied session: token → Redis → DB.

    Raises UnauthorizedError or ForbiddenError on failure.
    Used by get_current_user_write (the write session).
    """
    user_id = await _authenticated_user_id(request)
    return await _active_user(user_id, session)


# ---------------------------------------------------------------------------
# Public dependencies
# ---------------------------------------------------------------------------


async def get_current_user(request: Request) -> User:
    """Require authenticated user. Returns User or raises 401.

    Loads the user in its own short session, closed before this returns
    (BE-146): the User is detached, its columns loaded. Use for any
    endpoint that does not write the users row itself, and as the base for
    role checks; an endpoint that mutates the caller's own row takes
    get_current_user_write.

    Use as: user: User = Depends(get_current_user)
    """
    user_id = await _authenticated_user_id(request)
    async with _auth_session() as session:
        return await _active_user(user_id, session)


async def get_current_user_write(
    request: Request,
    session: AsyncSession = Depends(get_db_session),
) -> User:
    """Require authenticated user, bound to the write session.

    TD-029: Use on mutating endpoints that need the user object in
    the same write session as their DB writes. FastAPI caches
    Depends(get_db_session) within a request, so declaring
    Depends(get_current_user_write) + Depends(get_db_session) in
    the same endpoint yields ONE shared session — no session.merge()
    needed in the service layer.

    Use as: user: User = Depends(get_current_user_write)
    """
    return await _load_user_from_request(request, session)


async def get_optional_user(request: Request) -> User | None:
    """Optional authentication. Returns User or None.

    Use for endpoints that work for both anonymous and logged-in users.
    The user is loaded in its own short session (BE-146), opened only when
    a token resolved to a user id.
    """
    token = _extract_token(request)
    if not token:
        return None

    session_data = await get_session(token)
    if not session_data:
        return None

    user_id = _parse_user_id(session_data)
    async with _auth_session() as session:
        stmt = select(User).where(User.id == user_id)
        result = await session.execute(stmt)
        user = result.scalar_one_or_none()

    if not user or not user.is_active:
        return None

    return user


async def get_current_admin(
    user: User = Depends(get_current_user),
) -> User:
    """Require admin role. Returns User or raises 403.

    Use as: admin: User = Depends(get_current_admin)
    """
    if user.role != UserRole.ADMIN:
        raise ForbiddenError("Admin access required")
    return user


async def get_current_master(
    user: User = Depends(get_current_user),
) -> tuple[User, MasterProfile]:
    """Require verified master. Returns (User, MasterProfile) or raises 403.

    Checks:
      1. User role is MASTER
      2. MasterProfile exists
      3. MasterProfile status is "verified"

    The profile is loaded in its own short session, closed before this
    returns (BE-146): detached, columns loaded. An endpoint that writes the
    profile re-reads it in its write session (masters/router.py does).

    Use as:
        master_tuple: tuple[User, MasterProfile] = Depends(get_current_master)
        user, profile = master_tuple
    """
    if user.role != UserRole.MASTER:
        raise ForbiddenError("Master access required")

    async with _auth_session() as session:
        stmt = select(MasterProfile).where(
            MasterProfile.user_id == user.id
        )
        result = await session.execute(stmt)
        profile = result.scalar_one_or_none()

    # Distinct machine-readable codes (№257): the frontend master-zone entry
    # must tell "no application at all" (-> lead to /master/apply) apart from
    # "application exists but not verified" (-> /master/pending verdict flow).
    # Both stay 403; only the code differs.
    if not profile:
        raise ForbiddenError(
            "Master profile not found",
            code="master_profile_not_found",
        )

    profile_status = profile.data.get("account", {}).get("status")
    if profile_status != "verified":
        raise ForbiddenError(
            "Master profile not verified",
            code="master_profile_not_verified",
        )

    return user, profile
