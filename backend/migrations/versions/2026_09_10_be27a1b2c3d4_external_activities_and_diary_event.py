"""external activities + external_activity diary event

BE-27: a person records something they did OUTSIDE velo -- a massage, a
dance, an hour of meditation -- and it lands in their diary immediately, in
the shared chronology, at the time of the EVENT rather than of the entry.

1. `external_activities` -- the new domain table. Not a DiaryEntry and not
   a Checkin: it carries its own activity vocabulary, its own free-text
   name for the `custom` case, and its own feed card. Three CHECK
   constraints ride with it -- the closed activity enum, the 1..10 mood
   range, and the custom-name rule written as ONE equality of booleans so
   that "custom without a name" and "a name on a preset type" cannot be
   relaxed independently.

2. `external_activity` appended to BOTH diary CHECK constraints -- the kind
   and the source type. There is no ALTER for a CHECK in postgres, so each
   is dropped and recreated with the value added; existing rows satisfy the
   widened form by construction, so no backfill and no validation risk.
   Same shape as t2a1b2c3d4e5, which did this for thread_started.

DOWNGRADE DELETES THE PROJECTED EVENTS FIRST, for the reason that migration
gives for its own DELETE: rows of the new kind would violate the narrowed
constraint, and the ALTER would fail on live data rather than on a review.
Downgrading this migration is a decision to un-ship the feature; the
activities themselves go with their table one statement later.

Revision ID: be27a1b2c3d4
Revises: gt27a1b2c3d4
Create Date: 2026-09-10
"""

import sqlalchemy as sa
from alembic import op

revision: str = "be27a1b2c3d4"
down_revision: str | None = "gt27a1b2c3d4"
branch_labels: str | None = None
depends_on: str | None = None

_KIND_OLD = (
    "kind IN ("
    "'booking_confirmed', 'booking_cancelled_by_user', "
    "'practice_rescheduled', 'practice_cancelled_by_master', "
    "'practice_outcome', 'checkin', 'feedback', 'note', 'dream', "
    "'thread_started')"
)
_KIND_NEW = (
    "kind IN ("
    "'booking_confirmed', 'booking_cancelled_by_user', "
    "'practice_rescheduled', 'practice_cancelled_by_master', "
    "'practice_outcome', 'checkin', 'feedback', 'note', 'dream', "
    "'thread_started', 'external_activity')"
)
# SIX values in the OLD source list, not five: `thread` was added by
# t2a1b2c3d4e5 and is live. Dropping it here would narrow the constraint
# past existing rows on downgrade.
_SOURCE_OLD = (
    "source_type IN ("
    "'booking', 'practice', 'checkin', 'feedback', 'diary_entry', 'thread')"
)
_SOURCE_NEW = (
    "source_type IN ("
    "'booking', 'practice', 'checkin', 'feedback', 'diary_entry', "
    "'thread', 'external_activity')"
)


def upgrade() -> None:
    op.create_table(
        "external_activities",
        sa.Column(
            "id",
            sa.UUID(),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column(
            "occurred_at", sa.DateTime(timezone=True), nullable=False,
        ),
        sa.Column("activity_type", sa.String(length=30), nullable=False),
        sa.Column(
            "custom_activity_name", sa.String(length=120), nullable=True,
        ),
        sa.Column("mood", sa.Integer(), nullable=False),
        sa.Column("thoughts", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        # NULLABLE, and no server default: TimestampMixin declares
        # updated_at as `datetime | None` with onupdate only, so the ORM
        # sends an explicit NULL on INSERT. A NOT NULL column here is
        # rejected by that INSERT no matter what default the DDL carries --
        # the value is supplied, and it is None.
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "activity_type IN ("
            "'vocal', 'nail_standing', 'meditation', 'massage', "
            "'yoga', 'dance', 'custom')",
            name="ck_external_activity_type",
        ),
        sa.CheckConstraint(
            "mood BETWEEN 1 AND 10",
            name="ck_external_activity_mood",
        ),
        sa.CheckConstraint(
            "(activity_type = 'custom') = (custom_activity_name IS NOT NULL)",
            name="ck_external_activity_custom",
        ),
    )
    op.create_index(
        "ix_external_activities_user_occurred",
        "external_activities",
        ["user_id", "occurred_at"],
    )

    op.drop_constraint("ck_diary_event_kind", "diary_events", type_="check")
    op.create_check_constraint("ck_diary_event_kind", "diary_events", _KIND_NEW)
    op.drop_constraint(
        "ck_diary_event_source_type", "diary_events", type_="check",
    )
    op.create_check_constraint(
        "ck_diary_event_source_type", "diary_events", _SOURCE_NEW,
    )


def downgrade() -> None:
    # The projected events go before the constraints narrow, or the ALTER
    # fails on them (t2a1b2c3d4e5's own reasoning, same situation). The
    # activities follow with their table below.
    op.execute("DELETE FROM diary_events WHERE kind = 'external_activity'")

    op.drop_constraint(
        "ck_diary_event_source_type", "diary_events", type_="check",
    )
    op.create_check_constraint(
        "ck_diary_event_source_type", "diary_events", _SOURCE_OLD,
    )
    op.drop_constraint("ck_diary_event_kind", "diary_events", type_="check")
    op.create_check_constraint("ck_diary_event_kind", "diary_events", _KIND_OLD)

    op.drop_index(
        "ix_external_activities_user_occurred",
        table_name="external_activities",
    )
    op.drop_table("external_activities")
