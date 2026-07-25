"""create_master_groups_tables

Revision ID: 5e6a7b8c9d0e
Revises: 4d5e6a7b8c9d
Create Date: 2026-07-24

Master GROUPS, P1 (ПРОМТ №590): three new tables. Mirrors the master-scope
FK pattern already proven by practice_directions.master_id
(2026_07_22_3c4d5e6a7b8c_add_master_id_to_practice_directions.py).

master_group -- CUSTOM groups only. "Ученики" / "Удалённые" are NOT rows --
they are derived/virtual (see masters/groups_service.py). UNIQUE
(master_id, name) forbids duplicate group names per master. Brand-new
table -- no pre-existing rows, so unlike the practice dup-guard migration
(MIG1) there is no backfill/dedup step needed before the unique index.

master_group_membership -- membership in a CUSTOM group only (the two
virtual groups have no membership rows -- they are computed from bookings /
master_student.blocked_at). ondelete=CASCADE on group_id: deleting a group
drops its memberships, and the people fall back to the derived "Ученики" --
nothing else to reconcile.

master_student -- the per-(master, student) annotation: a single tag and/or
a block. A row exists ONLY when the master has tagged or blocked that
student -- a plain derived student with neither has no row here.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "5e6a7b8c9d0e"
down_revision: str | None = "4d5e6a7b8c9d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Apply this migration."""
    op.create_table(
        "master_group",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "master_id",
            sa.UUID(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_master_group_master_id", "master_group", ["master_id"],
    )
    op.create_index(
        "uq_master_group_master_name",
        "master_group",
        ["master_id", "name"],
        unique=True,
    )

    op.create_table(
        "master_group_membership",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "group_id",
            sa.UUID(),
            sa.ForeignKey("master_group.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "student_user_id",
            sa.UUID(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "added_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_master_group_membership_student_user_id",
        "master_group_membership",
        ["student_user_id"],
    )
    op.create_index(
        "uq_master_group_membership_group_student",
        "master_group_membership",
        ["group_id", "student_user_id"],
        unique=True,
    )

    op.create_table(
        "master_student",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "master_id",
            sa.UUID(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "student_user_id",
            sa.UUID(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("tag", sa.String(length=100), nullable=True),
        sa.Column("blocked_at", sa.DateTime(timezone=True), nullable=True),
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
        "uq_master_student_master_student",
        "master_student",
        ["master_id", "student_user_id"],
        unique=True,
    )


def downgrade() -> None:
    """Revert this migration."""
    op.drop_index("uq_master_student_master_student", table_name="master_student")
    op.drop_table("master_student")

    op.drop_index(
        "uq_master_group_membership_group_student",
        table_name="master_group_membership",
    )
    op.drop_index(
        "ix_master_group_membership_student_user_id",
        table_name="master_group_membership",
    )
    op.drop_table("master_group_membership")

    op.drop_index("uq_master_group_master_name", table_name="master_group")
    op.drop_index("ix_master_group_master_id", table_name="master_group")
    op.drop_table("master_group")
