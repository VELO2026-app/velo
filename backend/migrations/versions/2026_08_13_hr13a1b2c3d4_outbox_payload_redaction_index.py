"""outbox payload redaction: partial index for the retention pass

T-13 (PII lifetime in the outbox). The relay now redacts the payload of
rows shipped more than 7 days ago. That pass runs the OPPOSITE
predicate to the relay's publish scan, so the existing partial index
`ix_outbox_events_unpublished` (WHERE published_at IS NULL) cannot serve
it -- without this one, every pass is a sequential scan of a table that
only grows.

WHY THE PREDICATE IS THE WORK ITSELF, not `published_at IS NOT NULL`:
the obvious form would index the whole shipped history and therefore
grow monotonically with the table -- correct today, a tax forever. With
"not yet redacted" in the predicate a row LEAVES the index the moment it
is redacted, so the index only ever holds the window still awaiting
work: about seven days of traffic, however old the table gets.

The 7-day boundary is deliberately absent from the predicate: now() is
not IMMUTABLE and Postgres rejects it in an index. That restriction is
what makes the index non-degrading, so it costs nothing -- the age
comparison is a range scan on published_at, the indexed column.

`ix_outbox_events_unpublished` is NOT touched: it serves publication,
which is not this migration's business.

Revision ID: hr13a1b2c3d4
Revises: t24m20b1c2d3
Create Date: 2026-08-13
"""

import sqlalchemy as sa
from alembic import op

revision: str = "hr13a1b2c3d4"
down_revision: str | None = "t24m20b1c2d3"
branch_labels: str | None = None
depends_on: str | None = None

# The predicate is written once, here, and must stay character-identical
# to the one in models.py and in the relay's UPDATE. The planner only
# uses a partial index when it can prove the query's predicate implies
# the index's -- a drifted copy does not fail loudly, it just quietly
# stops being used.
_PREDICATE = "published_at IS NOT NULL AND payload <> '{\"redacted\": true}'::jsonb"


def upgrade() -> None:
    op.create_index(
        "ix_outbox_events_pending_redaction",
        "outbox_events",
        ["published_at"],
        unique=False,
        postgresql_where=sa.text(_PREDICATE),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_outbox_events_pending_redaction",
        table_name="outbox_events",
    )
