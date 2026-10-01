"""zoom_meetings: the Zoom-side meeting DELETE goes through the retry poller

delete_meeting_for_practice used to make the Zoom DELETE itself, inside the
practice cancel's transaction -- with the practice and its bookings held
FOR UPDATE, once per occurrence of a series scope cancel -- and set
`deleted` only when Zoom answered. Now an active meeting's row goes
`deleted` in the cancel's transaction (the attendance-segments skip aside)
and is QUEUED for the Zoom-side DELETE; zoom/retry_poller.py makes the call
after commit, in its own transaction. Same form as the registrant cancel
queue (be96a1b2c3d4).

1. `zoom_delete_pending BOOLEAN NOT NULL DEFAULT false` -- "our row is
   deleted, Zoom has not been told yet".
2. `zoom_delete_attempts INTEGER NOT NULL DEFAULT 0` -- failed Zoom DELETE
   attempts, capped by settings.zoom_meeting_delete_max_retries. Its own
   counter: retry_count counts CREATE attempts.

Existing rows get false / 0 -- no backfill (the database is disposable).

Revision ID: bf01a1b2c3d4
Revises: be96a1b2c3d4
Create Date: 2026-10-01
"""

import sqlalchemy as sa
from alembic import op

revision: str = "bf01a1b2c3d4"
down_revision: str | None = "be96a1b2c3d4"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "zoom_meetings",
        sa.Column(
            "zoom_delete_pending",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "zoom_meetings",
        sa.Column(
            "zoom_delete_attempts",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )


def downgrade() -> None:
    op.drop_column("zoom_meetings", "zoom_delete_attempts")
    op.drop_column("zoom_meetings", "zoom_delete_pending")
