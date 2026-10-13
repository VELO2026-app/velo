# =============================================================================
# VELO Backend -- MCP personal access tokens (BE-138, MCP phase 0)
# =============================================================================
#
# A student's AI client (Claude Desktop, Claude Code, Cursor, ...) reaches the
# student's own data through /mcp (phase 1) with a personal token the student
# minted in the app. This table is that token. It is NOT a session: sessions
# are short-lived, carry full rights and live in a disposable Redis; a token
# lives in Postgres until the student revokes it (owner ruling: no expiry) and
# carries a chosen subset of scopes.
#
# WHAT IS STORED. Only the sha256 of the full token string, never the token.
# The token -- velo_pat_<prefix>_<secret> -- exists in plain text in exactly
# one place: the response body of the create call. `prefix` is a random,
# non-secret lookup key (unique), shown in the list so the student can tell
# tokens apart; knowing it gives nothing without the 256-bit secret.
#
# SCOPES are a Postgres text array, checked by the schema: never empty, never
# outside the three known scopes. A token's scopes never change after it is
# minted, so there is no in-place mutation to track.
#
# LIFECYCLE. revoked_at set -> the token is dead for good (verification
# refuses it on the very next call; nothing un-revokes). last_used_at is
# refreshed by verification at most once per interval
# (settings.mcp_token_last_used_interval_seconds), so a forgotten token is
# visible in the list. No updated_at: the two lifecycle columns are the only
# writes after the insert, and each has its own name.
#
# OAUTH GRANTS (BE-141, MCP phase 3). A connection an AI client (claude.ai)
# obtained through OAuth is a row of this same table -- the student sees it
# in the same list, revokes it the same way, and /mcp checks it with the same
# gate, scopes, limits and audit. Such a row carries oauth_client_id (the
# registered client, McpOAuthClient below) and two credentials instead of
# one:
#   prefix / token_hash                      -- the CURRENT refresh token
#                                               (velo_ort_...), rotated on
#                                               every use;
#   access_prefix / access_hash /            -- the CURRENT access token
#   access_expires_at                           (velo_oat_...), short-lived.
# A personal token has all four OAuth columns NULL; ck_mcp_tokens_oauth_
# columns_together holds them together. Only hashes are stored, as for the
# personal token.
#
# LIVE NAMES ARE UNIQUE per student, ignoring case (owner ruling BE-139
# item 10). create_mcp_token checks it under the users-row lock and answers
# 409; uq_mcp_tokens_live_name is the database's own guard, and the only one
# for two OAuth grants of one student racing to the same name (service.py,
# issue_oauth_grant).
#
# The writers, the limit on live tokens and the row order they follow are in
# app/modules/mcp/service.py.
# =============================================================================

import enum
from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.core.mixins import UUIDMixin


class McpScope(enum.StrEnum):
    """What a token may do through /mcp.

    READ:           calendar, practice search, the student's own diary.
    DIARY_WRITE:    save into the diary.
    BOOKINGS_WRITE: book, cancel own booking, check in.

    A StrEnum rather than a Literal so the OpenAPI schema carries a named
    type for the frontend. The table's ck_mcp_tokens_scopes_known spells the
    same three values; a fourth scope changes both.
    """

    READ = "read"
    DIARY_WRITE = "diary:write"
    BOOKINGS_WRITE = "bookings:write"


# Literal SQL list for the CHECK, derived from the enum so the two cannot
# drift inside the model. The migration spells it out on purpose (a migration
# is a frozen snapshot and must not import moving code).
_SCOPES_SQL = ", ".join(f"'{s.value}'" for s in McpScope)


class McpTokenKind(enum.StrEnum):
    """What a row of the list is (BE-141): a personal token the student
    minted in the app, or a connection an AI client obtained through OAuth.
    Derived from oauth_client_id, not stored. A StrEnum so the OpenAPI
    schema carries a named type for the frontend."""

    PERSONAL = "personal"
    OAUTH = "oauth"


class McpOAuthClient(Base):
    """An OAuth client of /mcp (BE-141), known one of two ways:

      CIMD -- client_id is an https URL on an allowed host, and the client's
              metadata is the JSON document served there (Client ID Metadata
              Document). Fetched on first use and kept for
              settings.mcp_oauth_cimd_cache_seconds; fetched_at says when.
              claude.ai prefers it once the metadata advertises it.
      DCR  -- registered through /register (RFC 7591), the fallback;
              client_id is the SDK's uuid; fetched_at is NULL.

    Public clients only (token_endpoint_auth_method "none") either way:
    there is no client secret, so nothing secret is stored here.
    client_info is the metadata as the MCP SDK's OAuthClientInformationFull
    dumps it; the SDK validates it on the way in and on the way out.

    KNOWN CEILING -- the DCR rows only grow.
      Mechanics: a client that registers instead of using CIMD gets a new
        row on every fresh connection (claude.ai does so when CIMD is not
        advertised), and registration is anonymous; nothing removes those
        rows. CIMD narrowed this (owner ruling): claude.ai is ONE row per
        document URL however many students connect, refreshed in place.
        What still grows is DCR -- clients that do not speak CIMD and stray
        registrations, bounded in rate by
        settings.mcp_oauth_register_per_source, not in total.
      Status: acknowledged by design (gate BE-141, R7; narrowed by the CIMD
        ruling).
      Task: none -- nothing observed yet; the stand has a handful of
        students.
      Trigger: more than 10000 DCR rows
        (SELECT count(*) FROM mcp_oauth_clients WHERE fetched_at IS NULL)
        > 10000.
      Fix form: purge DCR clients older than a day that no mcp_tokens row
        references (the FK is RESTRICT, so a referenced client cannot be
        purged by mistake).
      Rejected: deleting a client when its grant is revoked -- the revoked
        row stays in the student's list and keeps pointing at it; turning
        DCR off -- the owner keeps it as the fallback for clients without
        CIMD.
    """

    __tablename__ = "mcp_oauth_clients"

    client_id: Mapped[str] = mapped_column(Text, primary_key=True)
    client_info: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )
    # CIMD: when the document was last fetched; NULL for a DCR client.
    fetched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    def __repr__(self) -> str:
        return f"<McpOAuthClient id={self.client_id}>"


class McpToken(UUIDMixin, Base):
    """A student's personal access token for /mcp. See the module header."""

    __tablename__ = "mcp_tokens"

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )
    name: Mapped[str] = mapped_column(String(100))
    prefix: Mapped[str] = mapped_column(String(16), unique=True)
    token_hash: Mapped[str] = mapped_column(String(64))
    scopes: Mapped[list[str]] = mapped_column(ARRAY(String(20)))

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
    )

    # BE-141: OAuth grants only -- see the module header.
    oauth_client_id: Mapped[str | None] = mapped_column(
        Text,
        ForeignKey("mcp_oauth_clients.client_id", ondelete="RESTRICT"),
    )
    access_prefix: Mapped[str | None] = mapped_column(String(16), unique=True)
    access_hash: Mapped[str | None] = mapped_column(String(64))
    access_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
    )

    @property
    def kind(self) -> McpTokenKind:
        return (
            McpTokenKind.PERSONAL
            if self.oauth_client_id is None
            else McpTokenKind.OAUTH
        )

    __table_args__ = (
        CheckConstraint(
            "btrim(name) <> ''",
            name="ck_mcp_tokens_name_not_blank",
        ),
        CheckConstraint(
            "cardinality(scopes) >= 1",
            name="ck_mcp_tokens_scopes_not_empty",
        ),
        CheckConstraint(
            f"scopes <@ ARRAY[{_SCOPES_SQL}]::varchar[]",
            name="ck_mcp_tokens_scopes_known",
        ),
        CheckConstraint(
            "(oauth_client_id IS NULL) = (access_prefix IS NULL)"
            " AND (access_prefix IS NULL) = (access_hash IS NULL)"
            " AND (access_hash IS NULL) = (access_expires_at IS NULL)",
            name="ck_mcp_tokens_oauth_columns_together",
        ),
        Index(
            "uq_mcp_tokens_live_name",
            "user_id",
            text("lower(name)"),
            unique=True,
            postgresql_where=text("revoked_at IS NULL"),
        ),
    )

    def __repr__(self) -> str:
        # The hash is deliberately absent: a repr ends up in logs and
        # tracebacks, and nothing derived from the token belongs there.
        return (
            f"<McpToken id={self.id} user={self.user_id} "
            f"revoked={self.revoked_at is not None}>"
        )
