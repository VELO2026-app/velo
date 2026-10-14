"""mcp tokens

Revision ID: be138a1b2c3d
Revises: be108a1b2c3d
Create Date: 2026-10-11

BE-138 (MCP phase 0): a student's personal access token for /mcp. Model and
lifecycle: McpToken in app/modules/mcp/models.py; writers and the row order
they follow: app/modules/mcp/service.py.

NO DATA IS TOUCHED: no token exists before this table does.

Names follow reflections and are read from pg_constraint / pg_indexes:
mcp_tokens_pkey, mcp_tokens_user_id_fkey, ix_mcp_tokens_user_id and the
default unique-constraint name mcp_tokens_prefix_key. The three CHECKs are
named.

The scope list in ck_mcp_tokens_scopes_known is spelled out here rather than
derived from McpScope: a migration is a frozen snapshot and must not change
when the enum does. A new scope is a new migration.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "be138a1b2c3d"
down_revision: str | None = "be108a1b2c3d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "mcp_tokens",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("prefix", sa.String(length=16), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column(
            "scopes",
            postgresql.ARRAY(sa.String(length=20)),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="mcp_tokens_user_id_fkey",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="mcp_tokens_pkey"),
        sa.UniqueConstraint("prefix", name="mcp_tokens_prefix_key"),
        sa.CheckConstraint(
            "btrim(name) <> ''",
            name="ck_mcp_tokens_name_not_blank",
        ),
        sa.CheckConstraint(
            "cardinality(scopes) >= 1",
            name="ck_mcp_tokens_scopes_not_empty",
        ),
        sa.CheckConstraint(
            "scopes <@ ARRAY['read', 'diary:write', 'bookings:write']::varchar[]",
            name="ck_mcp_tokens_scopes_known",
        ),
    )
    op.create_index("ix_mcp_tokens_user_id", "mcp_tokens", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_mcp_tokens_user_id", table_name="mcp_tokens")
    op.drop_table("mcp_tokens")
