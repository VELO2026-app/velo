# =============================================================================
# Migration: Drop notifications + notification_deliveries (Phase 6 / T1)
# =============================================================================
# The T1 cutover (integration design ID-1/ID-7/ID-8): the old
# notification engine (modules/notifications, Phase 7.x) is cut out of
# the codebase in the same delivery, and its tables go with it -- the
# history is TEST DATA by the boss's ruling (ID-7), dropped without a
# data migration; comms starts with a clean inbox.
#
# downgrade() recreates the empty schema exactly as the Phase 7.1
# migration (f2a3b4c5d6e7) built it -- structure only, the dropped
# rows are gone by design.
# =============================================================================

"""drop_notifications_tables

Revision ID: 9c0d1e2f3a4b
Revises: 8b9c0d1e2f3a
Create Date: 2026-07-28
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "9c0d1e2f3a4b"
down_revision: str | None = "8b9c0d1e2f3a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Drop notification_deliveries, then notifications (FK order)."""
    op.drop_table("notification_deliveries")
    op.drop_table("notifications")


def downgrade() -> None:
    """Recreate the empty Phase 7.1 schema (structure only, ID-7)."""
    # -- notifications (mirror of f2a3b4c5d6e7 upgrade) --
    op.create_table(
        "notifications",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("type", sa.String(50), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("target_type", sa.String(20), nullable=False),
        sa.Column("target_value", sa.String(200), nullable=False),
        sa.Column(
            "action_data",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column(
            "priority", sa.Integer(), server_default="5", nullable=False,
        ),
        sa.Column(
            "scheduled_at", sa.DateTime(timezone=True), nullable=False,
        ),
        sa.Column(
            "expiry_at", sa.DateTime(timezone=True), nullable=True,
        ),
        sa.Column(
            "status",
            sa.String(20),
            server_default="pending",
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=True,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_notifications_type", "notifications", ["type"])
    op.create_index(
        "ix_notifications_status", "notifications", ["status"],
    )
    op.create_index(
        "ix_notifications_processor_poll",
        "notifications",
        ["status", "scheduled_at", "priority"],
    )

    # -- notification_deliveries --
    op.create_table(
        "notification_deliveries",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "notification_id",
            sa.UUID(),
            sa.ForeignKey("notifications.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.UUID(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("channel", sa.String(20), nullable=False),
        sa.Column(
            "channel_options",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column(
            "status",
            sa.String(20),
            server_default="pending",
            nullable=False,
        ),
        sa.Column(
            "sent_at", sa.DateTime(timezone=True), nullable=True,
        ),
        sa.Column(
            "attempts", sa.Integer(), server_default="0", nullable=False,
        ),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=True,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_notification_deliveries_notification_id",
        "notification_deliveries",
        ["notification_id"],
    )
    op.create_index(
        "ix_notification_deliveries_user_id",
        "notification_deliveries",
        ["user_id"],
    )
    op.create_index(
        "ix_notification_deliveries_status",
        "notification_deliveries",
        ["status"],
    )
    op.create_check_constraint(
        "ck_notification_deliveries_attempts_non_negative",
        "notification_deliveries",
        "attempts >= 0",
    )
