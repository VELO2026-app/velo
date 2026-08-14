"""create support_threads table

B34 (support backend): the local pointer for one user's eternal comms
support thread (operator_kind="section"). Same reason as `chat_threads`
(migration t2a1b2c3d4e5) -- comms' read API is operator-scoped, so it
cannot answer "is this user the client of thread T", and the pointer is
the read-authz anchor. Kept as its own table rather than widening
`chat_threads`: that table's two user FKs are both non-nullable because a
DM's operator is always a master, and a support thread's operator is a
comms section id, not a users.id.

`client_user_id` is UNIQUE -- one support thread per user, matching the
kind="dm" dedup decision made on the comms side at thread creation
(support/service.py). No section id column anywhere: it must never be
persisted (support-sections-integration.md #3).

Revision ID: ab1c2d3e4f5a
Revises: hr13a1b2c3d4
Create Date: 2026-08-14
"""

import sqlalchemy as sa
from alembic import op

revision: str = "ab1c2d3e4f5a"
down_revision: str | None = "hr13a1b2c3d4"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_table(
        "support_threads",
        sa.Column(
            "id",
            sa.UUID(),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("comms_thread_id", sa.UUID(), nullable=False),
        sa.Column(
            "client_user_id",
            sa.UUID(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        # Nullable, no server default: TimestampMixin sets it on UPDATE
        # only, exactly like every other table using the mixin.
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint(
            "comms_thread_id", name="uq_support_threads_comms_id",
        ),
        sa.UniqueConstraint(
            "client_user_id", name="uq_support_threads_client",
        ),
    )
    op.create_index(
        "ix_support_threads_client_user_id",
        "support_threads",
        ["client_user_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_support_threads_client_user_id", table_name="support_threads",
    )
    op.drop_table("support_threads")
