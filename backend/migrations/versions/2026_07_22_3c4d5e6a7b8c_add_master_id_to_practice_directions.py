"""add_master_id_to_practice_directions

Revision ID: 3c4d5e6a7b8c
Revises: 2b3c4d5e6a7b
Create Date: 2026-07-22 00:00:00.000000+00:00

T22-6 (ПРОМТ №561): master-scoped taxonomy. Today, an admin approving a
custom method "for this master only" writes the raw label into
MasterProfile.data.profile.methods and creates NO catalog row at all --
the direction has zero representation anywhere a practice could reference
it, so it silently never appears as a create-practice option. This column
lets that approval create a REAL TaxonomyDirection row that is private to
one master: NULL means the existing global/shared row (unchanged meaning,
every pre-existing row keeps master_id=NULL), a value means "visible only
to this master's own catalog fetch, invisible to everyone else's."

Nullable and unwritten by anything before this prompt -- purely additive,
inert on deploy. ON DELETE CASCADE: a deleted user's private taxonomy row
has no remaining owner and no meaning, so it goes with them (mirrors
practice_styles.direction_id's CASCADE on its own parent).

Only practice_directions, not practice_styles: measured (admin/masters/
service.py's _promote_custom_methods docstring) that the "Свой вариант"
picker only ever produces a single free-text field with no direction+style
structure -- there is no reachable case today where a master-only custom
entry is a style under an existing direction. Adding scoping to styles too
would be schema for a case that cannot occur.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "3c4d5e6a7b8c"
down_revision: str | None = "2b3c4d5e6a7b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Apply this migration."""
    op.add_column(
        "practice_directions",
        sa.Column("master_id", sa.UUID(), nullable=True),
    )
    op.create_foreign_key(
        "fk_practice_directions_master_id_users",
        "practice_directions",
        "users",
        ["master_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index(
        "ix_practice_directions_master_id",
        "practice_directions",
        ["master_id"],
    )


def downgrade() -> None:
    """Revert this migration."""
    op.drop_index("ix_practice_directions_master_id", table_name="practice_directions")
    op.drop_constraint(
        "fk_practice_directions_master_id_users",
        "practice_directions",
        type_="foreignkey",
    )
    op.drop_column("practice_directions", "master_id")
