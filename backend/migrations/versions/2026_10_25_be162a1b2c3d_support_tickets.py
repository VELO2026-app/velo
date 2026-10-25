"""BE-162: support tickets -- a thread per appeal.

Revision ID: be162a1b2c3d
Revises: be166a1b2c3d
Create Date: 2026-10-25

support_threads stops being "one thread per person": every appeal through
the support form is a ticket with its own comms thread, so the unique
constraint on client_user_id goes. support_tickets carries what a thread
is to support -- topic and category as codes, our status, the admin who
took it (support/models.py).

NO DATA IS TOUCHED: a person's existing support thread simply has no
ticket row, which is what "history" means (owner ruling BE-162: no
tickets after the fact).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "be162a1b2c3d"
down_revision: str | None = "be166a1b2c3d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TOPICS = (
    "payment",
    "complaint_master",
    "practice",
    "withdrawal",
    "practices",
    "add_direction",
    "complaint_user",
    "technical",
    "other",
)
_CATEGORIES = (
    "tech",
    "practices",
    "payments",
    "complaint_master",
    "complaint_user",
    "other",
)
_STATUSES = ("open", "resolved", "rejected", "duplicate", "spam")


def _sql_in(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{v}'" for v in values)


def upgrade() -> None:
    op.drop_constraint(
        "uq_support_threads_client", "support_threads", type_="unique",
    )
    op.create_table(
        "support_tickets",
        sa.Column(
            "support_thread_id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        sa.Column("topic", sa.String(length=32), nullable=False),
        sa.Column("category", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column(
            "claimed_by_user_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
        sa.Column(
            "status_changed_at", sa.DateTime(timezone=True), nullable=False,
        ),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["support_thread_id"],
            ["support_threads.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["claimed_by_user_id"], ["users.id"], ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("support_thread_id"),
        sa.CheckConstraint(
            f"topic IN ({_sql_in(_TOPICS)})", name="ck_support_tickets_topic",
        ),
        sa.CheckConstraint(
            f"category IN ({_sql_in(_CATEGORIES)})",
            name="ck_support_tickets_category",
        ),
        sa.CheckConstraint(
            f"status IN ({_sql_in(_STATUSES)})",
            name="ck_support_tickets_status",
        ),
    )
    op.create_index(
        "ix_support_tickets_created",
        "support_tickets",
        ["created_at", "support_thread_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_support_tickets_created", table_name="support_tickets")
    op.drop_table("support_tickets")
    # A person with more than one support thread cannot go back to "one
    # thread per person": the constraint below then refuses, by design --
    # the database is disposable (par0 section 4), the downgrade is for an
    # empty one.
    op.create_unique_constraint(
        "uq_support_threads_client", "support_threads", ["client_user_id"],
    )
