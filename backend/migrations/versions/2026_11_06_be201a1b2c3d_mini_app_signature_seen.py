"""mini app signature measurement

Revision ID: be201a1b2c3d
Revises: be90a1b2c3d4
Create Date: 2026-11-06

BE-201: the measurement BE-183 is decided on -- how many people sign in
from the Mini App without Telegram's `signature` field -- moves from a log
event (BE-187) into the database, where it survives deploys. Model:
MiniAppSignatureSeen (app/modules/auth/models.py); writer and reader:
app/modules/auth/signature_stats.py.

  - mini_app_signature_seen: one row per person, keyed by users.id
    (deleting the person deletes the row). last_with_signature_at and
    last_without_signature_at, both nullable -- when the person last came
    with / without the field. No index beyond the primary key: the table
    holds at most one row per person and is only counted whole.

NO DATA IS TOUCHED: one new table, and the database is disposable
(par0 §4) -- the measurement starts from the deploy that creates it.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "be201a1b2c3d"
down_revision: str | None = "be90a1b2c3d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "mini_app_signature_seen",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "last_with_signature_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column(
            "last_without_signature_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.PrimaryKeyConstraint("user_id", name="mini_app_signature_seen_pkey"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="mini_app_signature_seen_user_id_fkey",
            ondelete="CASCADE",
        ),
    )


def downgrade() -> None:
    op.drop_table("mini_app_signature_seen")
