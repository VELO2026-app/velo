"""reflection

Revision ID: be108a1b2c3d
Revises: be79a1b2c3d4
Create Date: 2026-10-04

BE-108: a user whose booking ended no_show shares how he is -- once, with no
time window, the comment possibly empty. One row per (practice, user), the
same uniqueness feedbacks carries. Model and lifecycle: Reflection in
app/modules/diary/models.py.

NO DATA IS TOUCHED: no reflection exists before this table does.

Names follow feedbacks, read from pg_constraint / pg_indexes: reflections_pkey,
reflections_<col>_fkey, ix_reflections_<col>, and the named unique constraint
uq_reflection_practice_user.

The foreign keys are created practice -> user -> booking. Their RI triggers
then fire on INSERT in that order, practice first -- the row order every
writer of practices and bookings follows. The writer does not rest on it:
it takes the practice row FOR KEY SHARE itself before the INSERT.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "be108a1b2c3d"
down_revision: str | None = "be79a1b2c3d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "reflections",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("practice_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("booking_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["practice_id"], ["practices.id"],
            name="reflections_practice_id_fkey", ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"],
            name="reflections_user_id_fkey", ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["booking_id"], ["bookings.id"],
            name="reflections_booking_id_fkey", ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="reflections_pkey"),
        sa.UniqueConstraint(
            "practice_id", "user_id", name="uq_reflection_practice_user",
        ),
    )
    op.create_index(
        "ix_reflections_practice_id", "reflections", ["practice_id"],
    )
    op.create_index("ix_reflections_user_id", "reflections", ["user_id"])
    op.create_index(
        "ix_reflections_booking_id", "reflections", ["booking_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_reflections_booking_id", table_name="reflections")
    op.drop_index("ix_reflections_user_id", table_name="reflections")
    op.drop_index("ix_reflections_practice_id", table_name="reflections")
    op.drop_table("reflections")
