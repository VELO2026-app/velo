"""mcp oauth

Revision ID: be141a1b2c3d
Revises: be140a1b2c3d
Create Date: 2026-10-13

BE-141 (MCP phase 3): claude.ai connects to /mcp through OAuth. Model:
McpOAuthClient and the OAuth columns of McpToken in
app/modules/mcp/models.py; writers and their row order:
app/modules/mcp/service.py.

  - mcp_oauth_clients: the clients, public (no secret) -- by Client ID
    Metadata Document (client_id is an https URL, hence text; fetched_at set)
    or registered through RFC 7591 (fetched_at NULL);
  - mcp_tokens gains oauth_client_id (FK, RESTRICT), access_prefix (unique),
    access_hash, access_expires_at -- all NULL for a personal token, all set
    for an OAuth grant (ck_mcp_tokens_oauth_columns_together);
  - uq_mcp_tokens_live_name: a live name is unique per student, ignoring
    case -- the database's own guard of the BE-139 item 10 rule.

NO DATA IS TOUCHED: the new columns are NULL on every existing row, which is
what a personal token carries, and the database is disposable (par0 §4) --
nothing older than this migration is accommodated.

Names are spelled out and read back from pg_constraint / pg_indexes:
mcp_oauth_clients_pkey, mcp_tokens_oauth_client_id_fkey,
mcp_tokens_access_prefix_key, ck_mcp_tokens_oauth_columns_together,
uq_mcp_tokens_live_name.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "be141a1b2c3d"
down_revision: str | None = "be140a1b2c3d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "mcp_oauth_clients",
        sa.Column("client_id", sa.Text(), nullable=False),
        sa.Column(
            "client_info",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("client_id", name="mcp_oauth_clients_pkey"),
    )
    op.add_column(
        "mcp_tokens",
        sa.Column("oauth_client_id", sa.Text(), nullable=True),
    )
    op.add_column(
        "mcp_tokens",
        sa.Column("access_prefix", sa.String(length=16), nullable=True),
    )
    op.add_column(
        "mcp_tokens",
        sa.Column("access_hash", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "mcp_tokens",
        sa.Column("access_expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_foreign_key(
        "mcp_tokens_oauth_client_id_fkey",
        "mcp_tokens",
        "mcp_oauth_clients",
        ["oauth_client_id"],
        ["client_id"],
        ondelete="RESTRICT",
    )
    op.create_unique_constraint(
        "mcp_tokens_access_prefix_key", "mcp_tokens", ["access_prefix"]
    )
    op.create_check_constraint(
        "ck_mcp_tokens_oauth_columns_together",
        "mcp_tokens",
        "(oauth_client_id IS NULL) = (access_prefix IS NULL)"
        " AND (access_prefix IS NULL) = (access_hash IS NULL)"
        " AND (access_hash IS NULL) = (access_expires_at IS NULL)",
    )
    op.create_index(
        "uq_mcp_tokens_live_name",
        "mcp_tokens",
        ["user_id", sa.text("lower(name)")],
        unique=True,
        postgresql_where=sa.text("revoked_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_mcp_tokens_live_name", table_name="mcp_tokens")
    op.drop_constraint(
        "ck_mcp_tokens_oauth_columns_together", "mcp_tokens", type_="check"
    )
    op.drop_constraint("mcp_tokens_access_prefix_key", "mcp_tokens", type_="unique")
    op.drop_constraint(
        "mcp_tokens_oauth_client_id_fkey", "mcp_tokens", type_="foreignkey"
    )
    op.drop_column("mcp_tokens", "access_expires_at")
    op.drop_column("mcp_tokens", "access_hash")
    op.drop_column("mcp_tokens", "access_prefix")
    op.drop_column("mcp_tokens", "oauth_client_id")
    op.drop_table("mcp_oauth_clients")
