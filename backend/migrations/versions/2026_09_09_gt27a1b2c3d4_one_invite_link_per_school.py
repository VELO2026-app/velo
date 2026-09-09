"""one invite link per school; school masters are appointed, not linked (GT-27)

Curator GROUPS: the second invite link is cancelled by owner ruling. Until
now a school had TWO reusable links, UNIQUE (group_id, kind), and opening the
master one promoted an existing student to kind='master' on join. From here a
school has ONE link, everyone who opens it joins as a student, and a school
master is APPOINTED by the curator -- taking effect only once the appointee
confirms.

THE DELETE IS THE POINT OF THIS MIGRATION, not a way around a constraint.
Dropping `kind` would leave two rows per school that used both links, and
UNIQUE (group_id) would then refuse to build. The choice of which row
survives is not arbitrary and not ours to make at random: the MASTER link is
the thing the ruling cancels, so its rows go and the student link stays. That
is the ruling expressed in data, and it makes the outcome deterministic
without assuming anything about what a given stand happens to hold.

Deliberately NOT relying on "the database is empty". A migration whose
correctness depends on that assumption fails as a half-applied revision --
alembic is not transactional across DDL steps in the general case -- and
picking apart a stand stuck between two of them costs more than the DELETE.

TWO CONSEQUENCES, both intended, both stated so nobody reads them as damage:
  * a school whose ONLY link was the master one is left with no link at all.
    Correct: the get-or-mint endpoint is idempotent, so the curator opens the
    sheet and gets a fresh one.
  * master tokens already handed out stop resolving. Also correct: the path
    they opened no longer exists, and a token that still worked would be the
    cancelled path surviving in someone's chat history.

downgrade() DOES NOT BRING THE ROWS BACK, and that is not an omission: a
downgrade mirrors the SCHEMA, never the data. It restores the column as
nullable-free with a default so the old unique index can be rebuilt, and
whoever runs it gets a school with one student link where two links used to
be. Said here so the next reader does not go looking for the missing half.

curator_group_master_offer -- the appointment, mirroring
curator_group_transfer: a row IS the offer, accept and decline both DELETE
it. The one difference is the constraint. A transfer is UNIQUE (group_id) --
a school changes hands once. Appointments are ordinary and several can be
outstanding at the same time, so it is UNIQUE (group_id, to_user_id), which
also makes a repeated offer to the same person idempotent instead of a 409.

UNIQUE CONSTRAINTS AS UNIQUE INDEXES named uq_*, and no separate ix_ on a FK
column a unique index already leads with -- both rules taken from
2026_08_22_c1d2e3f4a5b6, which created these tables. group_id therefore gets
no index of its own on either table; to_user_id gets one, because the "what
was I offered" read comes in by user.

Revision ID: gt27a1b2c3d4
Revises: gt21cd3e4f5a
Create Date: 2026-09-09
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "gt27a1b2c3d4"
down_revision: str | None = "gt21cd3e4f5a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Apply this migration."""
    # 1. The cancelled path, removed from the data before the schema stops
    #    being able to express it. Order matters: the column has to still
    #    exist for this predicate to be writable.
    op.execute(
        sa.text("DELETE FROM curator_group_invite WHERE kind = 'master'")
    )

    # 2. The old pair constraint goes before the column it names.
    op.drop_index(
        "uq_curator_group_invite_group_kind",
        table_name="curator_group_invite",
    )
    op.drop_column("curator_group_invite", "kind")

    # 3. One link per school, now expressible.
    op.create_index(
        "uq_curator_group_invite_group",
        "curator_group_invite",
        ["group_id"],
        unique=True,
    )

    # 4. The appointment.
    op.create_table(
        "curator_group_master_offer",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "group_id",
            sa.UUID(),
            sa.ForeignKey("curator_group.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "to_user_id",
            sa.UUID(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "offered_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "uq_curator_group_master_offer_group_user",
        "curator_group_master_offer",
        ["group_id", "to_user_id"],
        unique=True,
    )
    op.create_index(
        "ix_curator_group_master_offer_to_user_id",
        "curator_group_master_offer",
        ["to_user_id"],
    )


def downgrade() -> None:
    """Revert this migration (schema only -- see the module docstring)."""
    op.drop_index(
        "ix_curator_group_master_offer_to_user_id",
        table_name="curator_group_master_offer",
    )
    op.drop_index(
        "uq_curator_group_master_offer_group_user",
        table_name="curator_group_master_offer",
    )
    op.drop_table("curator_group_master_offer")

    op.drop_index(
        "uq_curator_group_invite_group",
        table_name="curator_group_invite",
    )
    # server_default so existing rows get a value; the column was NOT NULL
    # before and stays so. Every surviving link is a student link, which is
    # what the rows actually are.
    op.add_column(
        "curator_group_invite",
        sa.Column(
            "kind",
            sa.String(length=10),
            nullable=False,
            server_default="student",
        ),
    )
    op.create_index(
        "uq_curator_group_invite_group_kind",
        "curator_group_invite",
        ["group_id", "kind"],
        unique=True,
    )
