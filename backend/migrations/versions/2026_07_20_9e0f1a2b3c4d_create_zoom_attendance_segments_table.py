"""create_zoom_attendance_segments_table

Revision ID: 9e0f1a2b3c4d
Revises: 8d9e0f1a2b3c
Create Date: 2026-07-20 00:00:00.000002+00:00

E21 step A (ПРОМТ №519): append-only raw report rows. Zoom returns
MULTIPLE rows per person on rejoin and does not sum them -- neither does
this table; summing happens in the attendance-decision step that lands
after this one. No updated_at (immutable journal, same shape as
user_ledger / master_ledger). matched_registrant_row_id NULL is the
unmatched bucket -- no separate table for it. Inert on deploy -- nothing
writes here until the report-poller step lands.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "9e0f1a2b3c4d"
down_revision: str | None = "8d9e0f1a2b3c"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Apply this migration."""
    op.create_table(
        "zoom_attendance_segments",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "zoom_meeting_id",
            sa.UUID(),
            sa.ForeignKey("zoom_meetings.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "matched_registrant_row_id",
            sa.UUID(),
            sa.ForeignKey("zoom_registrants.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("match_method", sa.String(length=20), nullable=True),
        sa.Column("zoom_registrant_id_raw", sa.String(length=64), nullable=True),
        sa.Column("join_time", sa.DateTime(timezone=True), nullable=True),
        sa.Column("leave_time", sa.DateTime(timezone=True), nullable=True),
        sa.Column("duration_seconds", sa.Integer(), nullable=True),
        sa.Column(
            "raw_row",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column(
            "source", sa.String(length=20), server_default="report", nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_zoom_attendance_segments_zoom_meeting_id",
        "zoom_attendance_segments",
        ["zoom_meeting_id"],
    )
    op.create_index(
        "ix_zoom_attendance_segments_matched_registrant_row_id",
        "zoom_attendance_segments",
        ["matched_registrant_row_id"],
    )
    op.create_index(
        "ix_zoom_attendance_segments_created_at",
        "zoom_attendance_segments",
        ["created_at"],
    )


def downgrade() -> None:
    """Revert this migration."""
    op.drop_index(
        "ix_zoom_attendance_segments_created_at",
        table_name="zoom_attendance_segments",
    )
    op.drop_index(
        "ix_zoom_attendance_segments_matched_registrant_row_id",
        table_name="zoom_attendance_segments",
    )
    op.drop_index(
        "ix_zoom_attendance_segments_zoom_meeting_id",
        table_name="zoom_attendance_segments",
    )
    op.drop_table("zoom_attendance_segments")
