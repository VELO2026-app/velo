"""drop practices.zoom_link

T-35 (all Zoom links go through our own /z/{code} handle). The manual,
hand-typed zoom_link was the second way into a practice that attendance
could not see: a person who joined through it was never a Zoom
registrant, so the matcher had nothing to match and the booking ended
up NO_SHOW for someone who was demonstrably present. The shared guest
link had the same property and is now reachable only behind the
wrapper, which resolves per-viewer; this column had no such wrapper and
no reason to survive one.

It was also unnecessary as an escape hatch. The case it existed for --
"Zoom meeting creation failed, give the master something to paste" --
already has a real answer: the retry poller (zoom/retry_poller.py) plus
the owner-only retry endpoint. Fixing creation is honest; handing over a
link that silently breaks attendance is not.

DATA IS LOST, AND THAT IS THE DECISION (owner ruling: this project keeps
no legacy). Whatever URLs masters typed into this column are dropped
with it. No backfill into another column, no transitional dual format,
no read-side fallback anywhere in the application.

The downgrade re-creates the column NULLABLE and EMPTY -- schema
reversibility only. Alembic can put the column back; nothing can put the
values back, and pretending otherwise in a docstring is how a later
reader gets surprised.

Revision ID: hr35a1b2c3d4
Revises: hr13a1b2c3d4
Create Date: 2026-08-14
"""

import sqlalchemy as sa
from alembic import op

revision: str = "hr35a1b2c3d4"
down_revision: str | None = "hr13a1b2c3d4"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.drop_column("practices", "zoom_link")


def downgrade() -> None:
    # String(500) matches the column this migration dropped. Nullable with
    # no server_default, exactly as it was -- an empty column, not the old
    # data.
    op.add_column(
        "practices",
        sa.Column("zoom_link", sa.String(length=500), nullable=True),
    )
