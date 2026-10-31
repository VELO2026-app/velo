"""BE-46 FIX: mark the blocks that were made with a link.

Revision ID: be46a1b2c3d4
Revises: be162c5d6e7f
Create Date: 2026-10-31

master_student gains blocked_with_link (masters/groups_models.py). Since
BE-46 a master blocks only a person linked to him, so block_student marks
every new block. A block also removes the person's custom-group
memberships -- and when that was the only link, nothing else tells a lawful
block from one written on a stranger's id before BE-46. The mark does:
the dossier and «Удалённые» open for a marked block (has_master_link,
INTERNAL) and stay shut for an unmarked one with no link.

BACKFILL: an existing block is marked when the person is linked to this
master NOW -- a booking at any status or a waitlist entry on one of his
practices, a membership of one of his groups, or a conversation with him
as its master. Those are has_master_link's sources; they are written out in
SQL here because a revision is a frozen snapshot and imports no application
code. A lawful block whose only link was a membership (which the block
itself deleted) cannot be told from a stranger's: no table keeps a trace of
the membership. It stays unmarked -- still blocked, no longer shown (owner,
2026-10-31: option (a)). BLOCKED_WITHOUT_LINK_SQL counts those rows; the
BE-46 report gives the owner the `velo` command to run it before release.

DEPLOY WINDOW: `velo update` starts the new app before it runs this
revision, as for every revision here (neighbours add columns the same way).
For those seconds every query that reads master_student by entity fails on
the missing column -- the dossier, block and unblock, a tag, «Ученики» and
«Удалённые»; nothing is written wrong, the requests answer 500 until the
column exists.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "be46a1b2c3d4"
down_revision: str | None = "be162c5d6e7f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# "This person is linked to this master now", for a master_student row ms.
# The same four sources as has_master_link (masters/groups_service.py).
_LINKED_NOW = """
    EXISTS (
        SELECT 1 FROM bookings b JOIN practices p ON p.id = b.practice_id
        WHERE b.user_id = ms.student_user_id AND p.master_id = ms.master_id
    )
    OR EXISTS (
        SELECT 1 FROM waitlist w JOIN practices p ON p.id = w.practice_id
        WHERE w.user_id = ms.student_user_id AND p.master_id = ms.master_id
    )
    OR EXISTS (
        SELECT 1 FROM master_group_membership m
        JOIN master_group g ON g.id = m.group_id
        WHERE m.student_user_id = ms.student_user_id
          AND g.master_id = ms.master_id
    )
    OR EXISTS (
        SELECT 1 FROM chat_threads t
        WHERE t.client_user_id = ms.student_user_id
          AND t.operator_user_id = ms.master_id
    )
"""

BACKFILL_SQL = f"""
UPDATE master_student AS ms
SET blocked_with_link = true
WHERE ms.blocked_at IS NOT NULL
  AND NOT ms.blocked_with_link
  AND ({_LINKED_NOW})
"""

# For the owner, BEFORE release -- so it names no column of this revision:
# the blocks the backfill will leave unmarked, i.e. not shown anywhere
# afterwards. Read-only.
BLOCKED_WITHOUT_LINK_SQL = f"""
SELECT ms.master_id, ms.student_user_id, ms.blocked_at
FROM master_student AS ms
WHERE ms.blocked_at IS NOT NULL
  AND NOT ({_LINKED_NOW})
ORDER BY ms.master_id, ms.blocked_at
"""


def upgrade() -> None:
    op.add_column(
        "master_student",
        sa.Column(
            "blocked_with_link",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.create_check_constraint(
        "ck_master_student_link_needs_block",
        "master_student",
        "NOT blocked_with_link OR blocked_at IS NOT NULL",
    )
    op.execute(BACKFILL_SQL)


def downgrade() -> None:
    op.drop_constraint(
        "ck_master_student_link_needs_block", "master_student", type_="check",
    )
    op.drop_column("master_student", "blocked_with_link")
