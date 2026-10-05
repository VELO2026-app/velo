"""practice_owning_school

Revision ID: be74a1b2c3d4
Revises: bf01a1b2c3d4
Create Date: 2026-10-01

BE-74: a practice BELONGS TO at most one school. practices.curator_group_id
is the one record of that fact, and practice_audience_curator_group -- the
"addressed to several schools" table of P5/GT-11 -- is dropped whole. The
audience 'curator_groups' ("students of the school") now reads the owning
school off the practice itself; two records of one fact are not kept
(owner ruling, 2026-10-01: exactly one school per practice).

A PRACTICE THAT LOSES ITS SCHOOL BECOMES PUBLIC IF IT WAS FOR THE SCHOOL'S
STUDENTS (owner ruling, 2026-10-01). This migration is the ONE record of that
rule: the trigger below. Whatever clears practices.curator_group_id -- the
explicit UPDATE in delete_curator_group, or this FK's ON DELETE SET NULL,
which Postgres runs as an UPDATE of the column and which therefore fires the
same trigger (checked on 16.15 before this was written) -- a 'curator_groups'
practice comes out of it 'public'. A trigger and not code, because the FK
action is not code: a practice inserted after delete_curator_group's UPDATE
and committed before its DELETE, the seed's cleanup deleting a school a live
master still has a practice in, and the cascade from a curator's users row
all reach the column without passing through Python.

ck_practices_school_audience_has_school makes the state the rule removes --
'curator_groups' with no school -- impossible, so no reader keeps a branch
for it. The model declares the same CHECK (practices/models.py) by name.

NO DATA IS CARRIED OVER. The database is disposable (handoff section 0,
item 3): the old table is dropped without copying its rows into the column.
The one UPDATE below is not a carry-over but the rule above applied to the
rows the dropped table leaves without a school: every 'curator_groups'
practice has a NULL owner after add_column, and without it the CHECK could
not be added on a database that has one.

ondelete="SET NULL" on the new FK. delete_curator_group clears the column
explicitly before it deletes the school (lock order: practice before
group); the FK action stays behind it for the paths named above.

The FK is named (fk_practices_curator_group_id_curator_group) and the model
declares the same name. The index is the plain ix_ the model's index=True
names -- the school page filters on this column.

down_revision is bf01a1b2c3d4 (zoom_meeting_delete_queue), the head on
2026-10-01 after git fetch, read by `alembic heads` -- it moved once during
this work (from be96a1b2c3d4), so re-read it before packaging.

downgrade() recreates the table empty, in the shape the 2026-08-26
migration built it, then drops the column. Not tested -- migrations are
verified by applying them (owner's ruling).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "be74a1b2c3d4"
down_revision: str | None = "bf01a1b2c3d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_CHECK = "ck_practices_school_audience_has_school"
_FUNCTION = "practices_school_lost_goes_public"
_TRIGGER = "trg_practices_school_lost_goes_public"


def upgrade() -> None:
    """Apply this migration."""
    op.add_column(
        "practices",
        sa.Column("curator_group_id", sa.UUID(), nullable=True),
    )
    op.create_foreign_key(
        "fk_practices_curator_group_id_curator_group",
        "practices",
        "curator_group",
        ["curator_group_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_practices_curator_group_id",
        "practices",
        ["curator_group_id"],
    )
    # The table's indexes go with it.
    op.drop_table("practice_audience_curator_group")

    op.execute(
        "UPDATE practices SET audience_kind = 'public' "
        "WHERE audience_kind = 'curator_groups'"
    )
    op.create_check_constraint(
        _CHECK,
        "practices",
        "audience_kind <> 'curator_groups' OR curator_group_id IS NOT NULL",
    )
    op.execute(
        f"""
        CREATE FUNCTION {_FUNCTION}() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF OLD.curator_group_id IS NOT NULL
               AND NEW.curator_group_id IS NULL
               AND NEW.audience_kind = 'curator_groups' THEN
                NEW.audience_kind := 'public';
            END IF;
            RETURN NEW;
        END
        $$
        """
    )
    op.execute(
        f"""
        CREATE TRIGGER {_TRIGGER}
        BEFORE UPDATE OF curator_group_id ON practices
        FOR EACH ROW EXECUTE FUNCTION {_FUNCTION}()
        """
    )


def downgrade() -> None:
    """Revert this migration."""
    op.execute(f"DROP TRIGGER IF EXISTS {_TRIGGER} ON practices")
    op.execute(f"DROP FUNCTION IF EXISTS {_FUNCTION}()")
    op.drop_constraint(_CHECK, "practices", type_="check")
    op.create_table(
        "practice_audience_curator_group",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("practice_id", sa.UUID(), nullable=False),
        sa.Column("group_id", sa.UUID(), nullable=False),
        sa.ForeignKeyConstraint(
            ["practice_id"], ["practices.id"], ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["group_id"], ["curator_group.id"], ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
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
    op.drop_index(
        "ix_practices_curator_group_id", table_name="practices",
    )
    op.drop_constraint(
        "fk_practices_curator_group_id_curator_group",
        "practices",
        type_="foreignkey",
    )
    op.drop_column("practices", "curator_group_id")
