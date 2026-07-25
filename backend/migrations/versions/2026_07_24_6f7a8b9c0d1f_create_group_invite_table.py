"""create_group_invite_table

Revision ID: 6f7a8b9c0d1f
Revises: 5e6a7b8c9d0e
Create Date: 2026-07-24

Master GROUPS, P4 (ПРОМТ №593): group invite links.

REUSABLE + STABLE by design, unlike the single-use, Redis-only, sha256'd
master_onboarding invite (admin/masters/service.py) -- the master pastes
this into a channel and taps «Пригласить» repeatedly expecting the SAME
link back, and it must still resolve on join whenever a follower opens it
later. Storing the raw token (not a hash) is acceptable here: a group
invite only grants "join this contact group" (low-sensitivity, and
master-reversible any time by removing the member), unlike the
master_onboarding invite which grants a master-role application slot.

UNIQUE(group_id) -- ONE active invite per group; create-or-return
(groups_service.get_or_create_group_invite) is a plain select-then-insert
against this constraint. UNIQUE(token) -- the join-time lookup key.
ondelete=CASCADE on group_id: deleting a group drops its invite, nothing
else to reconcile.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "6f7a8b9c0d1f"
down_revision: str | None = "5e6a7b8c9d0e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Apply this migration."""
    op.create_table(
        "group_invite",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "group_id",
            sa.UUID(),
            sa.ForeignKey("master_group.id", ondelete="CASCADE"),
            nullable=False,
        ),
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
        "uq_group_invite_group_id", "group_invite", ["group_id"], unique=True,
    )
    op.create_index(
        "uq_group_invite_token", "group_invite", ["token"], unique=True,
    )


def downgrade() -> None:
    """Revert this migration."""
    op.drop_index("uq_group_invite_token", table_name="group_invite")
    op.drop_index("uq_group_invite_group_id", table_name="group_invite")
    op.drop_table("group_invite")
