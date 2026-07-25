"""add_zoom_attendance_columns_to_bookings

Revision ID: 0f1a2b3c4d5e
Revises: 9e0f1a2b3c4d
Create Date: 2026-07-20 00:00:00.000003+00:00

E21 step A (ПРОМТ №519): the two columns the choke point
(bookings/service.py:648-661) will read once the attendance-decision step
lands. Both nullable and unwritten by anything in this prompt -- purely
additive, inert on deploy. NULL means "not decided via Zoom" and the
existing joined_at/checkin_skipped proxy stays the fallback (kept, not
removed -- see E21 plan sec 4).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0f1a2b3c4d5e"
down_revision: str | None = "9e0f1a2b3c4d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Apply this migration."""
    op.add_column(
        "bookings",
        sa.Column("zoom_minutes_present", sa.Integer(), nullable=True),
    )
    op.add_column(
        "bookings",
        sa.Column("attendance_decided_via", sa.String(length=20), nullable=True),
    )


def downgrade() -> None:
    """Revert this migration."""
    op.drop_column("bookings", "attendance_decided_via")
    op.drop_column("bookings", "zoom_minutes_present")
