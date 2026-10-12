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
# The writers, the limit on live tokens and the row order they follow are in
# app/modules/mcp/service.py.
# =============================================================================

import enum
from datetime import datetime
from uuid import UUID

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import ARRAY
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
    )

    def __repr__(self) -> str:
        # The hash is deliberately absent: a repr ends up in logs and
        # tracebacks, and nothing derived from the token belongs there.
        return (
            f"<McpToken id={self.id} user={self.user_id} "
            f"revoked={self.revoked_at is not None}>"
        )
