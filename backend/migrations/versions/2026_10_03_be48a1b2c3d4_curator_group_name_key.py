"""curator_group_name_key

Revision ID: be48a1b2c3d4
Revises: be74a1b2c3d4
Create Date: 2026-10-03

BE-48 / BE-49: two names of ONE curator are the same school name when they
match ignoring case and with whitespace collapsed (owner decisions,
2026-10-03). The exact-match uq_curator_group_curator_name is replaced by a
unique index over the name KEY:

    lower(btrim(regexp_replace(name, '[\\s<U+00A0>]+', ' ', 'g')))

The live definition of the key is curator_group_name_key() in
app/modules/curator_groups/models.py -- the model's index and the service's
pre-checks are built from it. The literal below is this migration's DDL, the
history of what was created; tests/test_curator_group_name_rule.py holds the
index the database actually has to the answers the builder gives.

NO DATA IS TOUCHED. The name stays stored as typed. If a curator already has
two schools whose names collide by the new rule, CREATE UNIQUE INDEX fails
and the migration with it: that is the honest outcome on a disposable
database (handoff section 0, item 3) -- no rename, no merge, no backfill.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "be48a1b2c3d4"
down_revision: str | None = "be74a1b2c3d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# '[\s<U+00A0>]+' -- Postgres's \s plus the no-break space (models.py says why).
_KEY = "lower(btrim(regexp_replace(name, '[\\s\u00a0]+', ' ', 'g')))"


def upgrade() -> None:
    op.drop_index("uq_curator_group_curator_name", table_name="curator_group")
    op.execute(
        "CREATE UNIQUE INDEX uq_curator_group_curator_name_key "
        f"ON curator_group (curator_user_id, {_KEY})"
    )


def downgrade() -> None:
    op.drop_index("uq_curator_group_curator_name_key", table_name="curator_group")
    op.create_index(
        "uq_curator_group_curator_name",
        "curator_group",
        ["curator_user_id", "name"],
        unique=True,
    )
