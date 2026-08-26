"""create_practice_audience_curator_group

Revision ID: d2e3f4a5b6c7
Revises: c1d2e3f4a5b6
Create Date: 2026-08-26

Curator GROUPS, P5 (tz-curator-groups.md 8.5): the fourth audience.

A strict mirror of practice_audience_group (2026-07-24, master groups P5):
same UNIQUE, same CASCADE both ways, same shape. Two tables rather than one
with a `kind` column, because the two point at DIFFERENT parents --
master_group and curator_group -- and a single table would need two nullable
FKs plus a check constraint to forbid the row that references neither.

NO BACKFILL AND NO DEFAULT CHANGE. practices.audience_kind keeps its
'public' default and every existing row keeps its value; the new enum member
is additive at the application layer only. The column is a varchar, not a PG
ENUM (see Practice.audience_kind), so admitting a fourth value needs no DDL
at all -- this migration creates the join table and nothing else.

CASCADE ON group_id IS LOAD-BEARING. Deleting a school removes its rows
here, the audience predicate then finds no target schools, and the practice
becomes invisible to everyone except its master. That fail-closed outcome is
the ruled behaviour (owner, 2026-08-22), not a side effect of FK setup, and
it is checked on live data by the test suite rather than read off this DDL.

down_revision is c1d2e3f4a5b6 (create_curator_groups_tables) -- the head,
established by scanning BOTH spellings of the revision/down_revision
assignments in migrations/versions (`revision: str = ` and bare
`revision = `). Scanning only one spelling reports three heads, two of them
false; that trap cost a check in GT-1 and is worth naming again here.

downgrade() mirrors upgrade(): index first, then the table. It is not
tested -- migrations are verified by applying them (owner's ruling).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d2e3f4a5b6c7"
down_revision: str | None = "c1d2e3f4a5b6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Apply this migration."""
    op.create_table(
        "practice_audience_curator_group",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "practice_id",
            sa.UUID(),
            sa.ForeignKey("practices.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "group_id",
            sa.UUID(),
            sa.ForeignKey("curator_group.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    # The unique index leads with practice_id, which is also the only column
    # the audience predicate filters on -- so no separate ix_ on it. group_id
    # gets its own: the cascade from curator_group and any future
    # "which practices target this school" lookup both start there. Same
    # rule the curator-group tables were built with in GT-1.
    op.create_index(
        "uq_practice_audience_curator_group",
        "practice_audience_curator_group",
        ["practice_id", "group_id"],
        unique=True,
    )
    op.create_index(
        "ix_practice_audience_curator_group_group_id",
        "practice_audience_curator_group",
        ["group_id"],
    )


def downgrade() -> None:
    """Revert this migration."""
    op.drop_index(
        "ix_practice_audience_curator_group_group_id",
        table_name="practice_audience_curator_group",
    )
    op.drop_index(
        "uq_practice_audience_curator_group",
        table_name="practice_audience_curator_group",
    )
    op.drop_table("practice_audience_curator_group")
