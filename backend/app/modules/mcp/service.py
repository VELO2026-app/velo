# =============================================================================
# VELO Backend -- MCP token service (BE-138, MCP phase 0)
# =============================================================================
#
# create / list / revoke for the app (router.py) and verify_mcp_token for the
# /mcp door of phase 1. Model and lifecycle: models.py.
#
# BE-141 (phase 3): the OAuth grant's two credentials, written here too --
# issue_oauth_grant (the authorization code exchanged) and
# load_oauth_refresh / rotate_oauth_refresh (the refresh grant). The OAuth
# protocol around them (discovery, registration, sign-in, consent) is in
# app/modules/mcp/oauth.py.
#
# TOKEN FORMAT: velo_pat_<prefix>_<secret>
#   prefix -- secrets.token_hex(8): 16 chars of [0-9a-f], 64 random bits.
#             Unique in the table; a collision is not retried -- at 64 bits
#             it does not happen, and the UNIQUE constraint stays the guard.
#   secret -- secrets.token_urlsafe(32): 43 chars of [A-Za-z0-9_-], 256 bits.
#   The secret's alphabet contains "_", so the string is never split on "_":
#   it is matched whole against one anchored, fixed-length pattern.
#   Stored: sha256 of the FULL string (hex), which binds prefix and secret.
#   A fast hash is enough because the secret is random, not chosen by a
#   person -- there is nothing to guess.
#
# OAUTH FORMATS (BE-141), same shape and length, another literal:
#   velo_oat_<prefix>_<secret> -- access token; looked up by access_prefix;
#   velo_ort_<prefix>_<secret> -- refresh token; looked up by prefix.
#   The hash covers the literal too, so a string of one kind can never match
#   the stored hash of another, whatever prefix it borrows. What keeps a
#   refresh token from opening /mcp is the kind itself: verify_mcp_token
#   decides, in one place, which column finds the row and which hash it must
#   match, and refuses velo_ort_ outright -- taken like a personal token, a
#   refresh token WOULD find its grant by prefix and match token_hash.
#
# THE TOKEN IS NEVER WRITTEN ANYWHERE but the create response (and, for an
# OAuth grant, the token endpoint's response): not to the log, not to the
# audit row, not into an exception message. Log lines carry
# token ids; refusals carry a reason word, never the presented string or its
# prefix.
#
# LIMIT ON LIVE TOKENS (settings.mcp_tokens_max_active_per_user). Counting
# and inserting is check-then-act, so two creates racing at limit-1 would
# both pass. create_mcp_token serialises a student's creates on the student's
# users row: lock_user_row (FOR NO KEY UPDATE; strength, refresh and the
# users -> master_profiles ORDER are written in the header of
# app/modules/users/service.py) is its first statement, and the count is
# read under it. The insert of the child row then takes KEY SHARE on the same
# users row in the same transaction, which does not conflict with the lock
# this transaction already holds. The waiting is short and against the other
# writers of that row (profile edit, login upsert, balance writers), none of
# which touches mcp_tokens.
#
# ROW ORDER: mcp_tokens -> users, for the EXISTING token rows of a student.
#   verify_mcp_token updates the token row (last_used_at) as the first write
#   of an /mcp request, and the action that follows in the same transaction
#   (phase 2: booking, diary) may then lock that student's users row. A
#   writer that locks users first and then UPDATEs existing token rows of the
#   same student would close a cycle with such a request. So anything that
#   writes both takes the token rows first. create_mcp_token locks users and
#   then INSERTS a new row: a row that does not exist yet cannot be held by
#   anybody else, so the insert is no position in this order -- the same
#   reasoning users/service.py gives for the KEY SHARE of a child insert.
#   reset_user_to_onboarding (users/service.py) is such a writer: it revokes
#   the student's tokens (revoke_all_mcp_tokens) and only then takes
#   lock_user_row. revoke_mcp_token and the last_used_at refresh lock token
#   rows only; several rows of one student are always taken in id order, in
#   one statement (_revoke).
#   issue_oauth_grant (BE-141) follows the order: it revokes the student's
#   live OAuth grants of the same name first (_revoke), then takes
#   lock_user_row for the limit, then inserts. rotate_oauth_refresh is one
#   UPDATE of one token row and locks nothing else.
#
# TWO GRANTS RACING TO ONE NAME (BE-141). Two exchanges for one student and
# one name both revoke the old grant (the second waits on its row lock and
# then finds it already revoked) and both insert. The users-row lock does
# serialise the inserts, but taking it BEFORE the revocation would break the
# order above, so the guard is the database's: uq_mcp_tokens_live_name
# refuses the second insert, and that exchange answers invalid_grant.
#
# Services do not commit (P-01); get_db_session commits once, or rolls back
# when the handler raises -- the 409 after lock_user_row leaves nothing behind
# because of that rollback, not because of anything here.
# =============================================================================

import hashlib
import hmac
import re
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import NoReturn
from uuid import UUID

import structlog
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from app.core.audit import record_audit
from app.core.config import settings
from app.core.exceptions import ConflictError, NotFoundError, UnauthorizedError
from app.modules.mcp.models import McpScope, McpToken
from app.modules.mcp.schemas import McpTokenCreate
from app.modules.users.models import User
from app.modules.users.service import lock_user_row

logger = structlog.get_logger()

TOKEN_LITERAL = "velo_pat_"
ACCESS_LITERAL = "velo_oat_"  # BE-141
REFRESH_LITERAL = "velo_ort_"  # BE-141
_PREFIX_BYTES = 8  # token_hex -> 16 chars
_SECRET_BYTES = 32  # token_urlsafe -> 43 chars, always (32 bytes, no padding)
_PREFIX_LEN = 2 * _PREFIX_BYTES
_SECRET_LEN = 43
TOKEN_LENGTH = len(TOKEN_LITERAL) + _PREFIX_LEN + 1 + _SECRET_LEN
_TOKEN_RE = re.compile(
    rf"velo_(pat|oat|ort)_([0-9a-f]{{{_PREFIX_LEN}}})_[A-Za-z0-9_-]{{{_SECRET_LEN}}}"
)

AUDIT_TOKEN_CREATED = "mcp_token_created"
AUDIT_TOKEN_REVOKED = "mcp_token_revoked"
AUDIT_OAUTH_GRANTED = "mcp_oauth_granted"  # BE-141
AUDIT_TARGET_TYPE = "mcp_token"


@dataclass(frozen=True)
class McpTokenAuth:
    """A token that passed verification, and whose it is."""

    user: User
    token: McpToken
    scopes: frozenset[McpScope]


def _hash_token(token: str) -> str:
    """sha256 hex of the full token string. ASCII by construction: the
    caller has already matched it against _TOKEN_RE."""
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def _mint(literal: str) -> tuple[str, str]:
    """A fresh token of one kind: (token string, its prefix)."""
    prefix = secrets.token_hex(_PREFIX_BYTES)
    return f"{literal}{prefix}_{secrets.token_urlsafe(_SECRET_BYTES)}", prefix


def _parse(raw: object) -> tuple[str, str] | None:
    """(kind, prefix) of a string in one of the three exact formats, or
    None. kind is "pat", "oat" or "ort"."""
    if not isinstance(raw, str) or len(raw) != TOKEN_LENGTH:
        return None
    match = _TOKEN_RE.fullmatch(raw)
    if match is None:
        return None
    return match.group(1), match.group(2)


def _canonical_scopes(scopes: list[McpScope] | None) -> list[str]:
    """Requested scopes in enum order; None means all of them (owner ruling).
    Repeats and emptiness are refused by the schema before this point."""
    wanted = set(McpScope) if scopes is None else set(scopes)
    return [s.value for s in McpScope if s in wanted]


async def _audit(
    event: str, user: User, token: McpToken, session: AsyncSession
) -> None:
    """One audit row per token event. data names the token by id, name and
    scopes -- nothing derived from the token string."""
    await record_audit(
        event=event,
        actor_id=user.id,
        actor_type="user",
        target_type=AUDIT_TARGET_TYPE,
        target_id=token.id,
        data={
            "token_id": str(token.id),
            "name": token.name,
            "scopes": list(token.scopes),
        },
        session=session,
    )


# ---------------------------------------------------------------------------
# App side: create / list / revoke
# ---------------------------------------------------------------------------


async def create_mcp_token(
    user: User,
    body: McpTokenCreate,
    session: AsyncSession,
) -> tuple[str, McpToken]:
    """Mint a token for `user`. Returns (token string, row).

    The token string exists only in the return value; the row holds its hash.
    The caller hands the string to the student once and keeps it nowhere.

    Raises:
        ConflictError 409 (mcp_token_limit_reached): the student already
            holds settings.mcp_tokens_max_active_per_user live tokens --
            checked first.
        ConflictError 409 (mcp_token_name_taken): a live token of the
            student already has this name, ignoring case.
    """
    # The per-student mutex for the limit -- see LIMIT ON LIVE TOKENS above.
    await lock_user_row(session, user.id)

    live = await session.scalar(
        select(func.count())
        .select_from(McpToken)
        .where(McpToken.user_id == user.id, McpToken.revoked_at.is_(None))
    )
    if live >= settings.mcp_tokens_max_active_per_user:
        raise ConflictError(
            "Too many active tokens",
            code="mcp_token_limit_reached",
        )

    # The name is unique among the student's LIVE tokens (owner ruling,
    # BE-139 item 10 -- it replaces the gate ruling of BE-138 that allowed
    # repeats: two "TEST" rows could not be told apart in the list).
    # Case-insensitive, compared AFTER the schema's strip; a revoked token's
    # name is free again. Read under the same users-row lock as the limit,
    # so two creates with one name serialise and the second sees the first.
    # lower() runs in SQL on BOTH sides: Python's and Postgres' case folding
    # differ for some characters, and one engine deciding both is the point.
    taken = await session.scalar(
        select(func.count())
        .select_from(McpToken)
        .where(
            McpToken.user_id == user.id,
            McpToken.revoked_at.is_(None),
            func.lower(McpToken.name) == func.lower(body.name),
        )
    )
    if taken:
        raise ConflictError(
            "A live token with this name already exists",
            code="mcp_token_name_taken",
        )

    token, prefix = _mint(TOKEN_LITERAL)

    row = McpToken(
        user_id=user.id,
        name=body.name,
        prefix=prefix,
        token_hash=_hash_token(token),
        scopes=_canonical_scopes(body.scopes),
    )
    session.add(row)
    await session.flush()
    # created_at is a server default; load it for the response.
    await session.refresh(row)

    await _audit(AUDIT_TOKEN_CREATED, user, row, session)
    logger.info("mcp_token_created", user_id=str(user.id), token_id=str(row.id))
    return token, row


async def list_mcp_tokens(user: User, session: AsyncSession) -> list[McpToken]:
    """All of the student's tokens, revoked included, newest first.

    KNOWN CEILING -- the list is unbounded.
      Mechanics: revoked tokens are kept and listed (revoked_at is a list
        field) and there is no pagination, so every create/revoke cycle adds
        a row the student will see forever; only live tokens are limited.
      Status: acknowledged by design (gate BE-138, R7).
      Task: none -- nothing observed yet; a student creates tokens by hand.
      Trigger: any student with more than 100 rows in mcp_tokens
        (SELECT user_id FROM mcp_tokens GROUP BY 1 HAVING count(*) > 100).
      Fix form: page the list, or stop listing tokens revoked more than N
        days ago -- the rows themselves stay.
      Rejected: deleting the row on revoke -- the audit rows' target and the
        list's revoked_at history would point at nothing.
    """
    result = await session.execute(
        select(McpToken)
        .where(McpToken.user_id == user.id)
        .order_by(McpToken.created_at.desc(), McpToken.id.desc())
    )
    return list(result.scalars())


async def _revoke(
    user: User,
    session: AsyncSession,
    token_id: UUID | None = None,
    oauth_name: str | None = None,
) -> list[McpToken]:
    """THE revocation path: the student's still live tokens -- one by id, or
    all of them -- are revoked, each with one audit row and one log line.

    The rows are taken by the subquery, in id order, FOR NO KEY UPDATE (the
    strength of the UPDATE that follows: revoked_at is no key column), in
    one statement. Two all-token revocations of one student therefore lock
    in the same order and queue instead of deadlocking. A row that another
    transaction revokes while this one waits is re-checked against
    `revoked_at IS NULL` once the lock is granted (READ COMMITTED) and drops
    out: a token is revoked, and audited, once.

    oauth_name (BE-141, issue_oauth_grant): only the student's live OAuth
    grants of this name, ignoring case -- a personal token is never among
    them.
    """
    live = (
        select(McpToken.id)
        .where(McpToken.user_id == user.id, McpToken.revoked_at.is_(None))
        .order_by(McpToken.id)
        .with_for_update(key_share=True)
    )
    if token_id is not None:
        live = live.where(McpToken.id == token_id)
    if oauth_name is not None:
        live = live.where(
            McpToken.oauth_client_id.is_not(None),
            func.lower(McpToken.name) == func.lower(oauth_name),
        )

    revoked = list(
        (
            await session.execute(
                update(McpToken)
                .where(McpToken.id.in_(live))
                .values(revoked_at=func.now())
                .returning(McpToken),
                execution_options={"synchronize_session": False},
            )
        ).scalars()
    )
    for row in sorted(revoked, key=lambda r: r.id):
        await _audit(AUDIT_TOKEN_REVOKED, user, row, session)
        logger.info("mcp_token_revoked", user_id=str(user.id), token_id=str(row.id))
    return revoked


async def revoke_mcp_token(
    user: User,
    token_id: UUID,
    session: AsyncSession,
) -> McpToken:
    """Revoke one of the student's own tokens. Idempotent.

    _revoke is the lock and the answer at once: it matches only the
    student's own, still live row. When it matches nothing, the row is read:
    the student's own already revoked token is returned as it stands (its
    original revoked_at, no second audit row -- a repeated tap or a retry is
    not a second revocation); anything else -- someone else's token or no
    token at all -- is the same 404, so existence is not disclosed.

    Raises:
        NotFoundError 404 (mcp_token_not_found).
    """
    revoked = await _revoke(user, session, token_id=token_id)
    if revoked:
        return revoked[0]

    already = (
        await session.execute(
            select(McpToken).where(McpToken.id == token_id, McpToken.user_id == user.id)
        )
    ).scalar_one_or_none()
    if already is None:
        raise NotFoundError("Token not found", code="mcp_token_not_found")
    return already


async def revoke_all_mcp_tokens(user: User, session: AsyncSession) -> list[McpToken]:
    """Revoke every live token of the student; return the ones revoked now.

    Called by users/service.py reset_user_to_onboarding ("delete account",
    owner ruling for BE-138): the account is reset, so the AI clients lose
    access. Same path as a manual revocation, one audit row per token; an
    already revoked token is untouched and gets no second row.

    ROW ORDER (module header): a caller that also locks the users row calls
    this FIRST -- mcp_tokens before users.
    """
    return await _revoke(user, session)


# ---------------------------------------------------------------------------
# /mcp side: verification
# ---------------------------------------------------------------------------


def _refuse(reason: str, token_id: UUID | None = None) -> NoReturn:
    """Every refusal is the same exception with the same text, whatever the
    reason, so the answer is no oracle for which part of a guess was right.
    The reason goes to the log as a word; the presented string, its prefix
    and its hash never do."""
    logger.info(
        "mcp_token_rejected",
        reason=reason,
        token_id=str(token_id) if token_id else None,
    )
    raise UnauthorizedError("Invalid token")


async def verify_mcp_token(raw: str | None, session: AsyncSession) -> McpTokenAuth:
    """Raw presented token -> (user, token, scopes), or UnauthorizedError.

    Two kinds open /mcp (BE-141): a personal token (velo_pat_, looked up by
    prefix) and an OAuth access token (velo_oat_, looked up by
    access_prefix, refused once access_expires_at has passed). A refresh
    token (velo_ort_) never does: it is the token endpoint's business.

    Refused: anything not matching one of the exact formats (no trimming --
    the function judges what the transport hands it); a refresh token; an
    unknown prefix; a hash mismatch (compared in constant time); an expired
    access token; a revoked token; a deactivated user (users.is_active
    False -- the same refusal get_current_user makes for a session). A
    refusal writes nothing.

    The row is read from the database on every call and nothing is cached
    between calls (each request has its own session), so a revocation
    committed before the call refuses it.
    A call already past this read when the revocation commits completes --
    "the next call" is the one refused.

    On success last_used_at is refreshed at most once per
    settings.mcp_token_last_used_interval_seconds per token: see
    _touch_last_used. Does not commit (P-01).
    """
    parsed = _parse(raw)
    if parsed is None:
        _refuse("malformed")
    kind, prefix = parsed
    # The ONE place the kind decides: which column finds the row and which
    # hash it must match.
    if kind == "pat":
        lookup, stored_field = McpToken.prefix, "token_hash"
    elif kind == "oat":
        lookup, stored_field = McpToken.access_prefix, "access_hash"
    else:
        # velo_ort_: a refresh token is the token endpoint's, never a bearer.
        # Taken like a personal token it would find its grant by prefix and
        # match token_hash -- which is the refresh token's hash.
        _refuse("refresh_as_bearer")
    found = (
        await session.execute(
            select(McpToken, User)
            .join(User, User.id == McpToken.user_id)
            .where(lookup == prefix)
        )
    ).one_or_none()
    if found is None:
        _refuse("unknown_prefix")
    token, user = found

    if not hmac.compare_digest(_hash_token(raw), getattr(token, stored_field)):
        _refuse("hash_mismatch", token.id)
    if kind == "oat" and token.access_expires_at <= datetime.now(UTC):
        _refuse("access_expired", token.id)
    if token.revoked_at is not None:
        _refuse("revoked", token.id)
    if not user.is_active:
        _refuse("user_inactive", token.id)

    await _touch_last_used(token, session)
    return McpTokenAuth(
        user=user,
        token=token,
        scopes=frozenset(McpScope(s) for s in token.scopes),
    )


async def _touch_last_used(token: McpToken, session: AsyncSession) -> None:
    """Refresh last_used_at unless it is younger than the interval.

    The guard that holds the property is in the UPDATE's WHERE, on the
    database clock: two concurrent calls that both read a stale value both
    issue the UPDATE, the second waits on the row lock, re-evaluates the
    WHERE against the first one's committed value and matches nothing -- one
    write. The check before it, on the value just read, only saves the
    statement on the common path (a token in steady use); it does not decide
    anything the WHERE would not.

    `revoked_at IS NULL` in the WHERE keeps a revocation that commits in
    between from being followed by a "used" stamp.
    """
    interval = timedelta(seconds=settings.mcp_token_last_used_interval_seconds)
    if (
        token.last_used_at is not None
        and token.last_used_at > datetime.now(UTC) - interval
    ):
        return

    stamped = (
        await session.execute(
            update(McpToken)
            .where(
                McpToken.id == token.id,
                McpToken.revoked_at.is_(None),
                or_(
                    McpToken.last_used_at.is_(None),
                    McpToken.last_used_at < func.now() - interval,
                ),
            )
            .values(last_used_at=func.now())
            .returning(McpToken.last_used_at),
            execution_options={"synchronize_session": False},
        )
    ).scalar_one_or_none()
    if stamped is not None:
        set_committed_value(token, "last_used_at", stamped)


# ---------------------------------------------------------------------------
# OAuth grants (BE-141): the token endpoint's side
# ---------------------------------------------------------------------------


class OAuthGrantRefusedError(Exception):
    """issue_oauth_grant would not issue. `reason` is a word for the log;
    the token endpoint answers every reason with the same invalid_grant."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class OAuthTokens:
    """The two credentials of a grant, in plain text -- they exist only in
    this value, on their way into the token response."""

    access_token: str
    refresh_token: str
    expires_in: int
    scopes: list[str]
    row: McpToken


_NAME_MAX = 100  # McpToken.name, String(100)


async def oauth_grant_name(
    session: AsyncSession, user_id: UUID, client_name: str | None, redirect_host: str
) -> str | None:
    """The list name of an OAuth grant for this student, or None when no
    name is free.

    The base is the client's self-declared name (cut to the column), or the
    host of its redirect URI when it declared none. A live grant of another
    client with the same name is no obstacle -- the new grant replaces it
    (issue_oauth_grant). A live PERSONAL token with that name is: the host is
    appended, "Claude · claude.ai" (owner ruling); when a personal token holds
    that name too, None.

    Read without a lock: the consent page asks it to warn early, and the
    exchange asks it again and relies on uq_mcp_tokens_live_name for the
    race (module header).
    """
    base = (client_name or "").strip()[:_NAME_MAX] or redirect_host[:_NAME_MAX]
    suffix = f" · {redirect_host}"
    suffixed = (base[: max(0, _NAME_MAX - len(suffix))] + suffix)[:_NAME_MAX]

    async def held_by_personal(name: str) -> bool:
        return bool(
            await session.scalar(
                select(func.count())
                .select_from(McpToken)
                .where(
                    McpToken.user_id == user_id,
                    McpToken.revoked_at.is_(None),
                    McpToken.oauth_client_id.is_(None),
                    func.lower(McpToken.name) == func.lower(name),
                )
            )
        )

    if not await held_by_personal(base):
        return base
    if not await held_by_personal(suffixed):
        return suffixed
    return None


async def live_tokens_besides(
    session: AsyncSession, user_id: UUID, oauth_name: str
) -> int:
    """Live tokens of the student that a new grant named `oauth_name` would
    NOT replace -- what counts against the limit once it is issued."""
    return await session.scalar(
        select(func.count())
        .select_from(McpToken)
        .where(
            McpToken.user_id == user_id,
            McpToken.revoked_at.is_(None),
            ~(
                McpToken.oauth_client_id.is_not(None)
                & (func.lower(McpToken.name) == func.lower(oauth_name))
            ),
        )
    )


def _access_expiry() -> datetime:
    return datetime.now(UTC) + timedelta(seconds=settings.mcp_oauth_access_ttl_seconds)


async def issue_oauth_grant(
    session: AsyncSession,
    *,
    user_id: UUID,
    client_id: str,
    client_name: str | None,
    redirect_host: str,
    scopes: list[str],
) -> OAuthTokens:
    """The authorization code was good: create the grant -- one mcp_tokens
    row -- and its first access and refresh tokens.

    A live OAuth grant of the student with the same name is revoked first
    (reconnecting does not breed "Claude 2"; claude.ai registers a new client
    on every connection, so "the same client" is the same name). Then, under
    the users-row lock, the student must be active and under the limit of
    live tokens. ROW ORDER and the race to one name: module header.

    Raises OAuthGrantRefusedError (the caller's transaction must roll back -- the
    revocation above is part of it): user_gone, user_inactive, name_taken,
    limit_reached, name_race. Does not commit (P-01).
    """
    user = await session.get(User, user_id)
    if user is None:
        raise OAuthGrantRefusedError("user_gone")
    name = await oauth_grant_name(session, user_id, client_name, redirect_host)
    if name is None:
        raise OAuthGrantRefusedError("name_taken")

    await _revoke(user, session, oauth_name=name)
    locked = await lock_user_row(session, user_id)
    if locked is None:
        raise OAuthGrantRefusedError("user_gone")
    if not locked.is_active:
        raise OAuthGrantRefusedError("user_inactive")
    live = await session.scalar(
        select(func.count())
        .select_from(McpToken)
        .where(McpToken.user_id == user_id, McpToken.revoked_at.is_(None))
    )
    if live >= settings.mcp_tokens_max_active_per_user:
        raise OAuthGrantRefusedError("limit_reached")

    access, access_prefix = _mint(ACCESS_LITERAL)
    refresh, refresh_prefix = _mint(REFRESH_LITERAL)
    row = McpToken(
        user_id=user_id,
        name=name,
        prefix=refresh_prefix,
        token_hash=_hash_token(refresh),
        scopes=_canonical_scopes([McpScope(s) for s in scopes]),
        oauth_client_id=client_id,
        access_prefix=access_prefix,
        access_hash=_hash_token(access),
        access_expires_at=_access_expiry(),
    )
    session.add(row)
    try:
        await session.flush()
    except IntegrityError as exc:
        # uq_mcp_tokens_live_name: another exchange of this student took the
        # name between our read and this insert (module header). Any other
        # constraint here would be a defect, and is not dressed up as this.
        if "uq_mcp_tokens_live_name" not in str(exc.orig):
            raise
        raise OAuthGrantRefusedError("name_race") from None
    await session.refresh(row)

    await record_audit(
        event=AUDIT_OAUTH_GRANTED,
        actor_id=user_id,
        actor_type="user",
        target_type=AUDIT_TARGET_TYPE,
        target_id=row.id,
        data={
            "token_id": str(row.id),
            "name": row.name,
            "scopes": list(row.scopes),
            "client_id": client_id,
        },
        session=session,
    )
    logger.info(
        "mcp_oauth_granted",
        user_id=str(user_id),
        token_id=str(row.id),
        client_id=client_id,
    )
    return OAuthTokens(
        access_token=access,
        refresh_token=refresh,
        expires_in=settings.mcp_oauth_access_ttl_seconds,
        scopes=list(row.scopes),
        row=row,
    )


async def load_oauth_refresh(
    session: AsyncSession, raw: str, client_id: str
) -> McpToken | None:
    """The grant this refresh token belongs to, or None -- for the SDK's
    checks that run before the exchange (the requested scopes against the
    grant's).

    Only identity is settled here: a velo_ort_ string whose prefix finds a
    grant and whose hash matches it (constant time). Without the hash the
    SDK would compare scopes for an unproven string and answer
    invalid_scope instead of invalid_grant -- telling a guesser that the
    prefix is live. Client, revocation and the student's active flag are
    decided by rotate_oauth_refresh alone: it decides under the row lock, so
    a revocation or deactivation committed after this read still counts,
    and a second copy here would change no answer. Reads only.
    """
    parsed = _parse(raw)
    if parsed is None or parsed[0] != "ort":
        return None
    row = (
        await session.execute(select(McpToken).where(McpToken.prefix == parsed[1]))
    ).scalar_one_or_none()
    if row is None or not hmac.compare_digest(_hash_token(raw), row.token_hash):
        return None
    return row


async def rotate_oauth_refresh(
    session: AsyncSession, raw: str, client_id: str
) -> OAuthTokens | None:
    """Spend a refresh token: replace BOTH credentials of its grant and
    return the new pair, or None when the token is no longer the grant's
    current one.

    One UPDATE whose WHERE names the presented token's prefix and hash, the
    client, a live grant and an active student -- THE decision for all of
    them (load_oauth_refresh settles only identity). It takes the row lock,
    and a second refresh with the same token -- a parallel one or a retry --
    waits, re-evaluates the WHERE against the committed new values and
    matches nothing. The old access token dies with it (one access token per
    grant). The scopes never change.

    KNOWN CEILING -- strict rotation, no grace window.
      Mechanics: the refresh token is single-use. If the token response is
        lost (a timeout on the client's side, a crash after the commit) or
        the client refreshes twice in parallel, the client holds a token
        that no longer matches, gets invalid_grant, and claude.ai asks the
        student to connect again.
      Status: acknowledged by design (gate BE-141, R5).
      Task: none -- nothing observed yet.
      Trigger: a student reports claude.ai asking to reconnect although the
        connection was not revoked; the app log shows mcp_oauth_refresh_
        refused with reason stale for a grant whose revoked_at is NULL.
      Fix form: keep the previous refresh hash for a short window (two
        columns: previous_hash, previous_valid_until) and accept it once,
        answering with the current pair.
      Rejected: a refresh token that never rotates -- Anthropic's connector
        documentation and the MCP authorization spec require rotation (or
        sender-constraining) for public clients, and claude.ai registers as
        one.
    """
    parsed = _parse(raw)
    if parsed is None or parsed[0] != "ort":
        return None
    access, access_prefix = _mint(ACCESS_LITERAL)
    refresh, refresh_prefix = _mint(REFRESH_LITERAL)
    row = (
        await session.execute(
            update(McpToken)
            .where(
                McpToken.prefix == parsed[1],
                McpToken.token_hash == _hash_token(raw),
                McpToken.oauth_client_id == client_id,
                McpToken.revoked_at.is_(None),
                McpToken.user_id == User.id,
                User.is_active.is_(True),
            )
            .values(
                prefix=refresh_prefix,
                token_hash=_hash_token(refresh),
                access_prefix=access_prefix,
                access_hash=_hash_token(access),
                access_expires_at=_access_expiry(),
            )
            .returning(McpToken),
            execution_options={"synchronize_session": False},
        )
    ).scalar_one_or_none()
    if row is None:
        logger.info("mcp_oauth_refresh_refused", reason="stale")
        return None
    logger.info("mcp_oauth_refreshed", token_id=str(row.id))
    return OAuthTokens(
        access_token=access,
        refresh_token=refresh,
        expires_in=settings.mcp_oauth_access_ttl_seconds,
        scopes=list(row.scopes),
        row=row,
    )
