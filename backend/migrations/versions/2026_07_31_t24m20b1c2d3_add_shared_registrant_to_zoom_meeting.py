"""add_shared_registrant_to_zoom_meeting

Revision ID: t24m20b1c2d3
Revises: t24m10a1b2c3
Create Date: 2026-07-31

T24-38 (PROMPT №642): the shared, registration-free Zoom link. Two NEW
columns on zoom_meetings, both nullable, no server_default -- purely
additive, every existing meeting row gets NULL (= "not minted yet"), which
is exactly how the master-facing control already treats a not-yet-ready
link (hidden until non-null). No backfill, no data rewrite, no constraint
an existing row could violate, no new/changed unique index -- safe on the
live prod table.

Deliberately two plain columns on zoom_meetings, NOT a new ZoomRegistrant
row: see that model's shared_registrant_id/shared_join_url docstring
(zoom/models.py) for why living outside zoom_registrants is what keeps a
guest joining through this link structurally unable to match anyone in the
attendance ladder.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "t24m20b1c2d3"
down_revision: str | None = "t24m10a1b2c3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Apply this migration."""
    op.add_column(
        "zoom_meetings",
        sa.Column("shared_registrant_id", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "zoom_meetings",
        sa.Column("shared_join_url", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    """Revert this migration."""
    op.drop_column("zoom_meetings", "shared_join_url")
    op.drop_column("zoom_meetings", "shared_registrant_id")
