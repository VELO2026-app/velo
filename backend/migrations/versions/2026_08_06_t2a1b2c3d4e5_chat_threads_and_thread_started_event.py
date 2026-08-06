"""chat threads pointer + thread_started diary event

Seam T2 (velo side): the messaging proxy needs two things the schema does
not have yet.

1. `chat_threads` -- velo's pointer to a comms thread plus its two
   participants. It exists for READ AUTHZ: the comms read API is
   operator-scoped, so it cannot answer "is this student a participant of
   thread T", and without an answer a forged thread id in a URL would open
   somebody else's conversation. No message content is mirrored.

2. `thread_started` as a DiaryEvent kind, with `thread` as a source type.
   Both CHECK constraints are recreated with the value appended -- there is
   no ALTER for a CHECK in postgres. Existing rows satisfy the widened
   constraint by construction, so no backfill and no validation risk.

3. A PARTIAL unique index on (source_type, source_id) WHERE
   kind = 'thread_started'. Partial is not a nicety: booking and practice
   sources legitimately carry SEVERAL events each (confirmed + cancelled;
   rescheduled + cancelled + outcome), so a global unique on that pair
   would fail on existing data. Scoped to this kind, it makes the
   "one conversation-started row per thread" rule true even under two
   concurrent create-or-get calls, which is what upsert-if-absent alone
   cannot guarantee.

Revision ID: t2a1b2c3d4e5
Revises: hr30a1b2c3d4
Create Date: 2026-08-06
"""

import sqlalchemy as sa
from alembic import op

revision: str = "t2a1b2c3d4e5"
down_revision: str | None = "hr30a1b2c3d4"
branch_labels: str | None = None
depends_on: str | None = None

_KIND_OLD = (
    "kind IN ("
    "'booking_confirmed', 'booking_cancelled_by_user', "
    "'practice_rescheduled', 'practice_cancelled_by_master', "
    "'practice_outcome', 'checkin', 'feedback', 'note', 'dream')"
)
_KIND_NEW = (
    "kind IN ("
    "'booking_confirmed', 'booking_cancelled_by_user', "
    "'practice_rescheduled', 'practice_cancelled_by_master', "
    "'practice_outcome', 'checkin', 'feedback', 'note', 'dream', "
    "'thread_started')"
)
_SOURCE_OLD = (
    "source_type IN ("
    "'booking', 'practice', 'checkin', 'feedback', 'diary_entry')"
)
_SOURCE_NEW = (
    "source_type IN ("
    "'booking', 'practice', 'checkin', 'feedback', 'diary_entry', 'thread')"
)


def upgrade() -> None:
    op.create_table(
        "chat_threads",
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
            "operator_user_id",
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
        # Nullable and without a server default, exactly like every other
        # table's: TimestampMixin sets it on UPDATE only, so a row that has
        # never been updated legitimately has none.
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("comms_thread_id", name="uq_chat_threads_comms_id"),
        sa.UniqueConstraint(
            "client_user_id", "operator_user_id", name="uq_chat_threads_pair",
        ),
    )
    op.create_index(
        "ix_chat_threads_client_user_id", "chat_threads", ["client_user_id"],
    )
    op.create_index(
        "ix_chat_threads_operator_user_id",
        "chat_threads",
        ["operator_user_id"],
    )
    op.create_index(
        "ix_chat_threads_client_created",
        "chat_threads",
        ["client_user_id", "created_at"],
    )

    op.drop_constraint("ck_diary_event_kind", "diary_events", type_="check")
    op.create_check_constraint("ck_diary_event_kind", "diary_events", _KIND_NEW)
    op.drop_constraint(
        "ck_diary_event_source_type", "diary_events", type_="check",
    )
    op.create_check_constraint(
        "ck_diary_event_source_type", "diary_events", _SOURCE_NEW,
    )

    op.create_index(
        "uq_diary_events_thread_started",
        "diary_events",
        ["source_type", "source_id"],
        unique=True,
        postgresql_where=sa.text("kind = 'thread_started'"),
    )


def downgrade() -> None:
    op.drop_index("uq_diary_events_thread_started", table_name="diary_events")

    # Rows of the new kind would violate the narrowed constraints; they are
    # dropped, not left to fail the ALTER. A downgrade of this migration is a
    # decision to un-ship the chat, and the conversations themselves live in
    # comms -- only the diary echo of them goes.
    op.execute("DELETE FROM diary_events WHERE kind = 'thread_started'")

    op.drop_constraint(
        "ck_diary_event_source_type", "diary_events", type_="check",
    )
    op.create_check_constraint(
        "ck_diary_event_source_type", "diary_events", _SOURCE_OLD,
    )
    op.drop_constraint("ck_diary_event_kind", "diary_events", type_="check")
    op.create_check_constraint("ck_diary_event_kind", "diary_events", _KIND_OLD)

    op.drop_index("ix_chat_threads_client_created", table_name="chat_threads")
    op.drop_index(
        "ix_chat_threads_operator_user_id", table_name="chat_threads",
    )
    op.drop_index("ix_chat_threads_client_user_id", table_name="chat_threads")
    op.drop_table("chat_threads")
