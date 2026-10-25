"""BE-162 delivery 2: the spam bin -- tombstones and the comms purge queue.

Revision ID: be162c5d6e7f
Revises: be162b3c4d5e
Create Date: 2026-10-25

support_spam_tombstones keeps the date of the appeal and the category of
a spam ticket the bin emptied -- nothing else (owner ruling).
support_thread_purges holds a comms thread whose velo rows are gone until
comms confirms its DELETE (support/models.py).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "be162c5d6e7f"
down_revision: str | None = "be162b3c4d5e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_CATEGORIES = (
    "tech",
    "practices",
    "payments",
    "complaint_master",
    "complaint_user",
    "other",
)


def upgrade() -> None:
    op.create_table(
        "support_spam_tombstones",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("appealed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("category", sa.String(length=32), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "category IN ({})".format(", ".join(f"'{c}'" for c in _CATEGORIES)),
            name="ck_support_spam_tombstones_category",
        ),
    )
    op.create_index(
        "ix_support_spam_tombstones_appealed",
        "support_spam_tombstones",
        ["appealed_at"],
    )
    op.create_table(
        "support_thread_purges",
        sa.Column(
            "comms_thread_id", postgresql.UUID(as_uuid=True), nullable=False,
        ),
        sa.Column("queued_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("last_error_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("comms_thread_id"),
    )


def downgrade() -> None:
    op.drop_table("support_thread_purges")
    op.drop_index(
        "ix_support_spam_tombstones_appealed",
        table_name="support_spam_tombstones",
    )
    op.drop_table("support_spam_tombstones")
