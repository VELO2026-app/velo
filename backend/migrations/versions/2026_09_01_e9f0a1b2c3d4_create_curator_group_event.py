"""create curator_group_event -- the school journal (GT-16)

One table: the feed a curator reads to see what happened in their school.

down_revision is d2e3f4a5b6c7 (create_practice_audience_curator_group),
which is the head as of this writing. IT WAS FOUND BY ENUMERATING BOTH
SPELLINGS. 56 of the 58 revisions in this tree write
`revision: str = "..."` and two write the bare `revision = "..."`; a scan
that knows only the annotated form reports three heads, two of them
false. See the same warning in the head revision's own docstring.

WHY THE PRIMARY KEY IS A UUID AND THE ORDER IS A SEPARATE BIGINT: the
model's docstring carries the argument in full. Short version -- order by
now() is broken (it is the TRANSACTION timestamp, so two events written by
one request share it byte for byte), order by a random uuid4 is no order
at all, and a monotonic integer IS order. The outbox
(core/events/models.py) made that case first, but there the integer
REPLACED the key because the outbox id never leaves the backend. This id
is returned to a human, and a globally monotonic integer in one curator's
feed leaks platform-wide activity, so identity and order are two columns
here.

actor_id HAS NO FOREIGN KEY, deliberately, exactly as audit_logs.actor_id
has none: the row must outlive the person, and the actor's name is copied
into `data` at write time. Do not add one.

`downgrade` is a mirror and is not tested; migrations are verified by
running them forward.

Revision ID: e9f0a1b2c3d4
Revises: d2e3f4a5b6c7
Create Date: 2026-09-01
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e9f0a1b2c3d4"
down_revision: str | None = "d2e3f4a5b6c7"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_table(
        "curator_group_event",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        # Order, not identity. Identity(always=False) == BIGSERIAL's
        # modern spelling, and the same form the outbox uses.
        sa.Column(
            "seq",
            sa.BigInteger(),
            sa.Identity(always=False),
            nullable=False,
        ),
        sa.Column(
            "group_id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        # No ForeignKey -- see the module docstring.
        sa.Column(
            "actor_id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        sa.Column("event", sa.String(length=50), nullable=False),
        sa.Column(
            "data",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["group_id"],
            ["curator_group.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("seq", name="uq_curator_group_event_seq"),
    )
    # The one query this table serves: one group's feed, newest first.
    op.create_index(
        "ix_curator_group_event_group_seq",
        "curator_group_event",
        ["group_id", sa.text("seq DESC")],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_curator_group_event_group_seq",
        table_name="curator_group_event",
    )
    op.drop_table("curator_group_event")
