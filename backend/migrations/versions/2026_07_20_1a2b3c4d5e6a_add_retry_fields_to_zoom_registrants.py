"""add_retry_fields_to_zoom_registrants

Revision ID: 1a2b3c4d5e6a
Revises: 0f1a2b3c4d5e
Create Date: 2026-07-20 00:00:00.000004+00:00

E21 step E (ПРОМТ №520): registrant creation is queued for the retry
poller (meeting not active yet, or the Zoom call fails) -- these two
columns give it the same retry-count-with-cap + visible-error bookkeeping
ZoomMeeting already has. Purely additive, inert until the retry poller's
registrant phase writes to them.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "1a2b3c4d5e6a"
down_revision: str | None = "0f1a2b3c4d5e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Apply this migration."""
    op.add_column(
        "zoom_registrants",
        sa.Column(
            "retry_count", sa.Integer(), server_default="0", nullable=False,
        ),
    )
    op.add_column(
        "zoom_registrants",
        sa.Column("last_sync_error", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    """Revert this migration."""
    op.drop_column("zoom_registrants", "last_sync_error")
    op.drop_column("zoom_registrants", "retry_count")
