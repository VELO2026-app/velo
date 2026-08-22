"""create_curator_groups_tables

Revision ID: c1d2e3f4a5b6
Revises: ab1c2d3e4f5a
Create Date: 2026-08-22

Curator GROUPS, P1 (tz-curator-groups.md 3.1): four new tables.

FOUR NOW, NOT ONE PER FEATURE. curator_group and curator_group_member get a
writer in this delivery; curator_group_invite and curator_group_transfer do
not -- their writers are GT-3 and GT-4, which will then ship code only. A
table without a writer is not a dead branch when the writer is named and
scheduled; it is one migration instead of three against a live database.

curator_group -- the school. UNIQUE (curator_user_id, name) makes names
unique WITHIN one curator, not globally: two curators may each run a
«Школа дыхания». The curator is held here and nowhere else -- there is no
curator row in curator_group_member (I-2).

curator_group_member -- ONE relation per (group, user), with the kind inside
it. Not UNIQUE (group_id, user_id, kind): that would let one person hold a
master row AND a student row in the same group, and every counter and
predicate downstream would need a rule for which one wins.

curator_group_invite -- one live link per kind, hence UNIQUE (group_id,
kind); UNIQUE (token) is the join-time lookup key. Raw token, mirroring
group_invite (2026_07_24_6f7a8b9c0d1f): the link only grants "join this
group" and the curator can revoke it at any time.

curator_group_transfer -- at most one pending offer per group, hence UNIQUE
(group_id). A row IS the offer: cancelling is a DELETE, and there is no
half-NULL pair of columns on the group to interpret.

Brand-new tables -- no pre-existing rows, so unlike the practice dup-guard
migration there is no dedup step before the unique indexes.

UNIQUE CONSTRAINTS ARE CREATED AS UNIQUE INDEXES named uq_*, matching
2026_07_24_5e6a7b8c9d0e (master groups) and mirrored by UniqueConstraint(...,
name=...) on the models, so both sides carry the same names.

ix_* ON FK COLUMNS THAT A UNIQUE INDEX DOES NOT ALREADY LEAD WITH. The
master-groups precedent indexes master_group.master_id and
master_group_membership.student_user_id but NOT membership.group_id --
because uq_master_group_membership_group_student already leads with
group_id, and a second index on the same leading column is dead weight
Postgres still has to maintain. Same rule applied here: group_id gets no
separate index on member/invite/transfer, since each of those tables has a
unique index starting with it.

downgrade() is a strict mirror of upgrade(), indexes first and tables in
reverse creation order -- the server runs it before anyone reads it.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c1d2e3f4a5b6"
down_revision: str | None = "ab1c2d3e4f5a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Apply this migration."""
    op.create_table(
        "curator_group",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "curator_user_id",
            sa.UUID(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_curator_group_curator_user_id",
        "curator_group",
        ["curator_user_id"],
    )
    op.create_index(
        "uq_curator_group_curator_name",
        "curator_group",
        ["curator_user_id", "name"],
        unique=True,
    )

    op.create_table(
        "curator_group_member",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "group_id",
            sa.UUID(),
            sa.ForeignKey("curator_group.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.UUID(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(length=10), nullable=False),
        sa.Column(
            "joined_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_curator_group_member_user_id",
        "curator_group_member",
        ["user_id"],
    )
    op.create_index(
        "uq_curator_group_member_group_user",
        "curator_group_member",
        ["group_id", "user_id"],
        unique=True,
    )

    op.create_table(
        "curator_group_invite",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "group_id",
            sa.UUID(),
            sa.ForeignKey("curator_group.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(length=10), nullable=False),
        sa.Column("token", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "uq_curator_group_invite_group_kind",
        "curator_group_invite",
        ["group_id", "kind"],
        unique=True,
    )
    op.create_index(
        "uq_curator_group_invite_token",
        "curator_group_invite",
        ["token"],
        unique=True,
    )

    op.create_table(
        "curator_group_transfer",
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
            "requested_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_curator_group_transfer_to_user_id",
        "curator_group_transfer",
        ["to_user_id"],
    )
    op.create_index(
        "uq_curator_group_transfer_group",
        "curator_group_transfer",
        ["group_id"],
        unique=True,
    )


def downgrade() -> None:
    """Revert this migration."""
    op.drop_index(
        "uq_curator_group_transfer_group", table_name="curator_group_transfer",
    )
    op.drop_index(
        "ix_curator_group_transfer_to_user_id",
        table_name="curator_group_transfer",
    )
    op.drop_table("curator_group_transfer")

    op.drop_index(
        "uq_curator_group_invite_token", table_name="curator_group_invite",
    )
    op.drop_index(
        "uq_curator_group_invite_group_kind", table_name="curator_group_invite",
    )
    op.drop_table("curator_group_invite")

    op.drop_index(
        "uq_curator_group_member_group_user", table_name="curator_group_member",
    )
    op.drop_index(
        "ix_curator_group_member_user_id", table_name="curator_group_member",
    )
    op.drop_table("curator_group_member")

    op.drop_index("uq_curator_group_curator_name", table_name="curator_group")
    op.drop_index("ix_curator_group_curator_user_id", table_name="curator_group")
    op.drop_table("curator_group")
