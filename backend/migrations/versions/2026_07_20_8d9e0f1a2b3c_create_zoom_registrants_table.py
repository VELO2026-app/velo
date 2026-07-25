"""create_zoom_registrants_table

Revision ID: 8d9e0f1a2b3c
Revises: 7c8d9e0f1a2b
Create Date: 2026-07-20 00:00:00.000001+00:00

E21 step A (ПРОМТ №519): one row per booking (role=student) plus one row
per practice for the master (role=host, booking_id NULL) -- host exclusion
is our own explicit fact, not inferred from any Zoom-provided field (E21
research: no reliable host flag exists on either Zoom surface). Inert on
deploy -- registrant creation is not wired to bookings until a later step.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "8d9e0f1a2b3c"
down_revision: str | None = "7c8d9e0f1a2b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Apply this migration."""
    op.create_table(
        "zoom_registrants",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "zoom_meeting_id",
            sa.UUID(),
            sa.ForeignKey("zoom_meetings.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.UUID(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "booking_id",
            sa.UUID(),
            sa.ForeignKey("bookings.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "role",
            sa.String(length=10),
            server_default="student",
            nullable=False,
        ),
        sa.Column("zoom_registrant_id", sa.String(length=64), nullable=True),
        sa.Column("registration_email", sa.String(length=255), nullable=False),
        sa.Column("join_url", sa.Text(), nullable=True),
        sa.Column(
            "status",
            sa.String(length=20),
            server_default="pending",
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_zoom_registrants_zoom_meeting_id",
        "zoom_registrants",
        ["zoom_meeting_id"],
    )
    op.create_index(
        "ix_zoom_registrants_user_id", "zoom_registrants", ["user_id"],
    )
    # One ACTIVE registrant per (meeting, user) -- same partial-unique shape
    # as uq_booking_practice_user_active (bookings). Historical/cancelled
    # duplicates allowed (re-registering after cancel-and-rebook).
    op.create_index(
        "uq_zoom_registrant_meeting_user_active",
        "zoom_registrants",
        ["zoom_meeting_id", "user_id"],
        unique=True,
        postgresql_where=sa.text("status != 'cancelled'"),
    )


def downgrade() -> None:
    """Revert this migration."""
    op.drop_index(
        "uq_zoom_registrant_meeting_user_active",
        table_name="zoom_registrants",
    )
    op.drop_index(
        "ix_zoom_registrants_user_id", table_name="zoom_registrants",
    )
    op.drop_index(
        "ix_zoom_registrants_zoom_meeting_id", table_name="zoom_registrants",
    )
    op.drop_table("zoom_registrants")
