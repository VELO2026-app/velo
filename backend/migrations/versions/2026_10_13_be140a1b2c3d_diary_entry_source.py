"""diary entry source and request id

Revision ID: be140a1b2c3d
Revises: be138a1b2c3d
Create Date: 2026-10-13

BE-140 (MCP phase 2): where a diary entry was written, and the client's
retry key of save_to_diary. Model: DiaryEntry in app/modules/diary/models.py.

  diary_entries.created_via  'app' | 'mcp', NOT NULL, server default 'app'
                             -- every existing row was written in the app.
  diary_entries.request_id   NULL or a non-empty key; unique per student
                             among non-NULL keys (partial unique index).

THE FEED SNAPSHOT is backfilled too. upsert_entry_event puts created_via in
diary_events.snapshot from now on; an existing entry's event would otherwise
lack the key until the entry is next edited -- two shapes of one snapshot,
which the project does not keep ("no legacy"). Every existing entry is an
app entry, so the backfill writes 'app'. Downgrade removes the key again.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "be140a1b2c3d"
down_revision: str | None = "be138a1b2c3d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "diary_entries",
        sa.Column(
            "created_via",
            sa.String(length=10),
            server_default="app",
            nullable=False,
        ),
    )
    op.add_column(
        "diary_entries",
        sa.Column("request_id", sa.String(length=128), nullable=True),
    )
    op.create_check_constraint(
        "ck_diary_entry_created_via",
        "diary_entries",
        "created_via IN ('app', 'mcp')",
    )
    op.create_check_constraint(
        "ck_diary_entry_request_id_not_empty",
        "diary_entries",
        "request_id IS NULL OR length(request_id) > 0",
    )
    op.create_index(
        "uq_diary_entries_user_request",
        "diary_entries",
        ["user_id", "request_id"],
        unique=True,
        postgresql_where=sa.text("request_id IS NOT NULL"),
    )
    op.execute(
        "UPDATE diary_events "
        'SET snapshot = snapshot || \'{"created_via": "app"}\'::jsonb '
        "WHERE source_type = 'diary_entry'"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE diary_events SET snapshot = snapshot - 'created_via' "
        "WHERE source_type = 'diary_entry'"
    )
    op.drop_index("uq_diary_entries_user_request", table_name="diary_entries")
    op.drop_constraint(
        "ck_diary_entry_request_id_not_empty", "diary_entries", type_="check"
    )
    op.drop_constraint("ck_diary_entry_created_via", "diary_entries", type_="check")
    op.drop_column("diary_entries", "request_id")
    op.drop_column("diary_entries", "created_via")
