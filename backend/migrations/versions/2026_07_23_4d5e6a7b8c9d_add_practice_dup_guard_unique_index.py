"""add_practice_dup_guard_unique_index

Revision ID: 4d5e6a7b8c9d
Revises: 3c4d5e6a7b8c
Create Date: 2026-07-23

A4 V7: _find_recent_duplicate_practice (practices/service.py) was a pure
in-app select-then-insert check -- two concurrent POST /practices for the
same master (double-tap, two tabs) both pass the SELECT before either
commits, so both INSERT. Each triggers create_meeting_for_practice under
the single shared S2S Zoom host identity (/users/me/meetings), so this
race burns the platform-wide (not per-master) Zoom meeting-creation quota
on duplicates.

Mirrors uq_zoom_registrant_meeting_user_active / uq_booking_practice_
user_active: a partial unique index, not an app-level check, is what
actually excludes the race at the DB level. Scoped to the exact same
identity _find_recent_duplicate_practice already uses (master_id, title,
scheduled_at, recurrence) -- WHERE status != 'deleted' so a soft-deleted
practice never blocks a legitimate new one reusing the same slot.

recurrence lives in data->'recurrence' (JSONB, absent for a one-off
practice). COALESCE(..., 'null'::jsonb) is required: two rows with a SQL
NULL there would NOT collide in a unique index (NULL <> NULL), which
would silently exempt the (more common) non-recurring case from this
guard entirely.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "4d5e6a7b8c9d"
down_revision: str | None = "3c4d5e6a7b8c"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Apply this migration."""
    # MIG1: this table predates the dup-guard, so it may already hold duplicates
    # from the pre-fix TOCTOU race. Soft-delete all but the earliest of each
    # (master_id, title, scheduled_at, recurrence) group so the unique index
    # below builds on any non-empty database.
    op.execute(
        """
        UPDATE practices SET status = 'deleted'
        WHERE id IN (
            SELECT id FROM (
                SELECT id, row_number() OVER (
                    PARTITION BY master_id, title, scheduled_at,
                                 COALESCE(data -> 'recurrence', 'null'::jsonb)
                    ORDER BY created_at
                ) AS rn
                FROM practices WHERE status <> 'deleted'
            ) s WHERE s.rn > 1
        )
        """
    )
    op.create_index(
        "uq_practice_master_title_scheduled_recurrence",
        "practices",
        [
            "master_id",
            "title",
            "scheduled_at",
            sa.text("(COALESCE(data -> 'recurrence', 'null'::jsonb))"),
        ],
        unique=True,
        postgresql_where=sa.text("status != 'deleted'"),
    )


def downgrade() -> None:
    """Revert this migration."""
    op.drop_index(
        "uq_practice_master_title_scheduled_recurrence",
        table_name="practices",
    )
