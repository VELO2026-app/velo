"""create_zoom_meetings_table

Revision ID: 7c8d9e0f1a2b
Revises: d6e7f8a9b0c1
Create Date: 2026-07-20 00:00:00.000000+00:00

E21 step A (ПРОМТ №519): one Zoom meeting per practice (1:1). Inert on
deploy -- nothing writes to this table yet until step D lands in the same
prompt's follow-up code (meeting creation wired into publish).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "7c8d9e0f1a2b"
down_revision: str | None = "d6e7f8a9b0c1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Apply this migration."""
    op.create_table(
        "zoom_meetings",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "practice_id",
            sa.UUID(),
            sa.ForeignKey("practices.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("zoom_meeting_id", sa.String(length=64), nullable=True),
        sa.Column("zoom_meeting_uuid", sa.String(length=64), nullable=True),
        sa.Column("host_zoom_user_id", sa.String(length=64), nullable=True),
        sa.Column(
            "status",
            sa.String(length=20),
            server_default="create_failed",
            nullable=False,
        ),
        sa.Column(
            "retry_count", sa.Integer(), server_default="0", nullable=False,
        ),
        sa.Column("last_sync_error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("practice_id", name="uq_zoom_meetings_practice_id"),
    )
    op.create_index(
        "ix_zoom_meetings_practice_id", "zoom_meetings", ["practice_id"],
    )


def downgrade() -> None:
    """Revert this migration."""
    op.drop_index("ix_zoom_meetings_practice_id", table_name="zoom_meetings")
    op.drop_table("zoom_meetings")
