"""add_report_ingested_at_to_zoom_meetings

Revision ID: 2b3c4d5e6a7b
Revises: 1a2b3c4d5e6a
Create Date: 2026-07-20 00:00:00.000005+00:00

E21 step F (ПРОМТ №521): marks a meeting as "we successfully pulled its
report", regardless of whether any rows came back (a genuinely-empty
meeting is a valid, successful pull -- distinct from "not tried yet" or
"tried and Zoom errored"). This is what lets the report poller stop
re-polling a meeting once it has been decided, and is the anchor the
undecided-bound fallback checks against (still NULL past the deadline ->
fall back to the legacy proxy).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "2b3c4d5e6a7b"
down_revision: str | None = "1a2b3c4d5e6a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Apply this migration."""
    op.add_column(
        "zoom_meetings",
        sa.Column(
            "report_ingested_at", sa.DateTime(timezone=True), nullable=True,
        ),
    )


def downgrade() -> None:
    """Revert this migration."""
    op.drop_column("zoom_meetings", "report_ingested_at")
