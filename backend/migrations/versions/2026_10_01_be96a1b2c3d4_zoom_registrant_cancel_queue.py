"""zoom_registrants: the Zoom-side cancel goes through the retry poller (BE-96)

Until BE-96 cancel_registrant_for_booking made the Zoom HTTP call itself,
inside the caller's transaction -- block_student held FOR UPDATE on the
practices and bookings for N sequential calls, cancel_booking held its
practice for one. Now our row goes `cancelled` in the caller's transaction
and is QUEUED for the Zoom-side cancel; zoom/retry_poller.py makes the call
after commit, in its own transaction.

1. `zoom_cancel_pending BOOLEAN NOT NULL DEFAULT false` -- "our row is
   cancelled, Zoom has not been told yet". A flag and not a new status: the
   partial unique index uq_zoom_registrant_meeting_user_active counts every
   status other than 'cancelled' as active, so a `cancel_pending` status
   would block the rebook's new registrant and bring back the reuse BE-71
   closed.
2. `zoom_cancel_attempts INTEGER NOT NULL DEFAULT 0` -- failed Zoom cancel
   attempts, capped by settings.zoom_registrant_cancel_max_retries. Its own
   counter: retry_count counts CREATE attempts and has its own cap.

Existing rows get false / 0 -- no backfill (the database is disposable,
par0 sec 3).

Revision ID: be96a1b2c3d4
Revises: cm21a1b2c3d4
Create Date: 2026-10-01
"""

import sqlalchemy as sa
from alembic import op

revision: str = "be96a1b2c3d4"
down_revision: str | None = "cm21a1b2c3d4"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "zoom_registrants",
        sa.Column(
            "zoom_cancel_pending",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "zoom_registrants",
        sa.Column(
            "zoom_cancel_attempts",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )


def downgrade() -> None:
    op.drop_column("zoom_registrants", "zoom_cancel_attempts")
    op.drop_column("zoom_registrants", "zoom_cancel_pending")
