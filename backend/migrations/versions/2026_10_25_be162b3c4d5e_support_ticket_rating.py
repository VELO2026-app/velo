"""BE-162 delivery 3: who resolved a ticket, and its rating.

Revision ID: be162b3c4d5e
Revises: be162a1b2c3d
Create Date: 2026-10-25

support_tickets gains the admin who last resolved it and the person's
rating -- 1..5 stars, an optional comment, when, and who had resolved the
ticket at that moment (support/models.py). All nullable: a ticket is
unrated and unresolved until it is.

The ticket -> thread key becomes DEFERRABLE INITIALLY DEFERRED: with three
SET NULL references to users on a ticket, deleting its person and two of
its admins in one statement made the second SET NULL re-check the key
against a thread the cascade had already removed (support/models.py).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "be162b3c4d5e"
down_revision: str | None = "be162a1b2c3d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "support_tickets",
        sa.Column(
            "resolved_by_user_id", postgresql.UUID(as_uuid=True), nullable=True,
        ),
    )
    op.add_column("support_tickets", sa.Column("rating", sa.Integer(), nullable=True))
    op.add_column(
        "support_tickets", sa.Column("rating_comment", sa.Text(), nullable=True),
    )
    op.add_column(
        "support_tickets",
        sa.Column("rated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "support_tickets",
        sa.Column(
            "rated_resolver_user_id", postgresql.UUID(as_uuid=True), nullable=True,
        ),
    )
    op.create_foreign_key(
        "support_tickets_resolved_by_user_id_fkey",
        "support_tickets",
        "users",
        ["resolved_by_user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "support_tickets_rated_resolver_user_id_fkey",
        "support_tickets",
        "users",
        ["rated_resolver_user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_check_constraint(
        "ck_support_tickets_rating",
        "support_tickets",
        "rating IS NULL OR rating BETWEEN 1 AND 5",
    )
    op.create_check_constraint(
        "ck_support_tickets_rated_at",
        "support_tickets",
        "(rating IS NULL) = (rated_at IS NULL)",
    )
    op.execute(
        "ALTER TABLE support_tickets ALTER CONSTRAINT "
        "support_tickets_support_thread_id_fkey DEFERRABLE INITIALLY DEFERRED"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE support_tickets ALTER CONSTRAINT "
        "support_tickets_support_thread_id_fkey NOT DEFERRABLE"
    )
    op.drop_constraint("ck_support_tickets_rated_at", "support_tickets", type_="check")
    op.drop_constraint("ck_support_tickets_rating", "support_tickets", type_="check")
    op.drop_constraint(
        "support_tickets_rated_resolver_user_id_fkey",
        "support_tickets",
        type_="foreignkey",
    )
    op.drop_constraint(
        "support_tickets_resolved_by_user_id_fkey",
        "support_tickets",
        type_="foreignkey",
    )
    for column in (
        "rated_resolver_user_id",
        "rated_at",
        "rating_comment",
        "rating",
        "resolved_by_user_id",
    ):
        op.drop_column("support_tickets", column)
