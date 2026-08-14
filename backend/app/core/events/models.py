# =============================================================================
# VELO Backend -- Transactional Outbox: OutboxEvent model (Phase 6 / T0)
# =============================================================================
#
# The domain-event outbox of integration design ID-2: a row in THIS
# table is written in THE SAME transaction as the domain change, and a
# background relay (relay.py) ships unpublished rows to the comms
# Redis Stream. Domain change committed <=> event committed; no
# distributed transaction, at-least-once by replay.
#
# WHY BIGSERIAL (BigInteger + Identity), NOT the project-wide UUID pk:
#   the relay publishes strictly in id order ("порядок по id", T0
#   item 3) -- a monotonically increasing integer IS the publication
#   order. Random UUIDs have no order; a timestamp is not unique.
#   This is a deliberate, documented deviation from UUIDMixin.
#
# PAYLOAD is the event's `data` document of the FROZEN comms wire
# contract (comms app/transport/events.py, Phase 3c), INCLUDING the
# required version field "v". The envelope {event, data} is assembled
# by the relay at XADD time -- storing data alone keeps the row 1:1
# with "everything that evolves lives inside data".
#
# LIFECYCLE COLUMNS:
#   published_at NULL   -> pending, the relay's scan predicate;
#   published_at ts     -> shipped;
#   attempts            -> failed publish attempts (observability +
#                          the poison-row WARN threshold; NEVER a drop
#                          limit -- outbox rows are not discarded).
#
# ROW LIFETIME AND PII (T-13). The payload of a shipped row is a
# personal-data document -- user_upserted carries a snapshot of the
# person (telegram_id, e-mail, locale, timezone), notification_request
# carries the text parameters of a message to them. What happens to it:
#
#   - THE SKELETON IS KEPT FOREVER. All seven columns other than
#     payload -- id, event_type, created_at, published_at, attempts,
#     next_attempt_at, dead_lettered_at -- are not personal data, cost
#     almost nothing, answer the audit question that is actually asked
#     ("did this event ever leave?"), and keep id monotonic.
#   - THE PAYLOAD IS REDACTED 7 days after published_at, replaced by
#     {"redacted": true}. The column is NOT NULL and the marker is more
#     honest than an empty object: it says something WAS removed rather
#     than that nothing was there. 7 days is the shape of the question
#     it has to survive -- replay after downtime needs a day, audit
#     needs the payload not at all, and a complaint ("I never got the
#     reschedule notice") is a weekly cycle: noticed in a day or two,
#     investigated later.
#   - ROWS ARE NEVER DELETED. Not after a year, not ever. A delete
#     invites the question "did it eat something that mattered", and
#     answering it costs twins forever; redaction gives the whole value
#     without that risk.
#   - UNPUBLISHED ROWS ARE UNTOUCHABLE, whatever their age. See the
#     redaction predicate in relay.py -- for a row that never shipped,
#     the payload is the only copy of what must still be delivered and
#     the only evidence of why it would not go.
#
# The work is done by the relay itself (relay.py, redact_published_
# payloads), on its own slow cadence -- no cron, no timer, no script.
#
# SESSION RULES: no commit here (P-01); emit_event() inserts into the
# caller's session/transaction.
# =============================================================================

from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    DateTime,
    Identity,
    Index,
    Integer,
    String,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# T-13. What a redacted payload looks like, and the SQL that recognises
# one. Declared here, next to the column and the index that depend on
# them, and imported by the relay -- the redaction predicate has to be
# written identically in three places (the index, the UPDATE's WHERE,
# the new value) or the index silently stops being used.
REDACTED_PAYLOAD: dict[str, Any] = {"redacted": True}
_REDACTED_PAYLOAD_SQL = "'{\"redacted\": true}'::jsonb"
_NOT_YET_REDACTED_SQL = f"payload <> {_REDACTED_PAYLOAD_SQL}"

# How long a shipped payload lives. A CONSTANT, not a setting: a knob
# nobody has asked to turn is a knob without a consumer, and every
# relay setting lives in core/config.py, which is the production gate
# this task is explicitly not allowed to touch.
PAYLOAD_RETENTION_DAYS = 7


class OutboxEvent(Base):
    """One outgoing event awaiting (or past) publication to comms."""

    __tablename__ = "outbox_events"

    # Publication order. See header for why not UUID.
    id: Mapped[int] = mapped_column(
        BigInteger,
        Identity(always=False),
        primary_key=True,
    )

    # Envelope event name (comms contract: notification_request /
    # user_upserted / group_changed). Width mirrors the widest name
    # with headroom; the known-set check lives in service.emit_event.
    event_type: Mapped[str] = mapped_column(String(50), nullable=False)

    # The event `data` document (with "v"), JSON-scalar values only --
    # enforced at emit time, since JSONB would happily store what the
    # comms validator later dead-letters.
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    published_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        default=None,
    )

    attempts: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=0,
        server_default="0",
    )

    # H-R3 (relay hardening): exponential-backoff carrier. NULL = "may be
    # picked up immediately" (also the state of every pre-migration row --
    # no backfill needed). Set ONLY by the relay's per-event (poison)
    # failure branch; the infra branch never touches it (an outage is not
    # the row's fault). timezone=True mirrors published_at -- all
    # comparisons are aware UTC (П-1).
    next_attempt_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        default=None,
    )

    # H-R3: dead-letter marker. NULL = alive. Set once, when attempts
    # reaches comms_relay_max_attempts; the relay's select excludes dead
    # rows, published_at stays NULL (the truth of the state: it was never
    # shipped). Revived by the comms-outbox requeue CLI (attempts kept --
    # history; an unfixed poison re-dies fast, by design).
    dead_lettered_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        default=None,
    )

    # Partial index: the relay's steady-state scan is
    # `WHERE published_at IS NULL ORDER BY id` -- index only the
    # pending tail, not the ever-growing published history.
    __table_args__ = (
        Index(
            "ix_outbox_events_unpublished",
            "id",
            postgresql_where=published_at.is_(None),
        ),
        # T-13: the redaction pass runs the OPPOSITE predicate, which
        # the index above (by construction) does not cover -- without
        # this one every pass is a sequential scan of a table that only
        # grows.
        #
        # WHY THE PREDICATE IS THE WORK ITSELF, and not the obvious
        # `published_at IS NOT NULL`: that obvious form would index the
        # entire shipped history, so the index would grow monotonically
        # exactly like the table -- correct today, a tax forever. With
        # "not yet redacted" in the predicate a row LEAVES the index the
        # moment it is redacted, so the index only ever holds the window
        # of rows still awaiting work -- roughly seven days of traffic,
        # no matter how many years the table has been running.
        #
        # The 7-day boundary is deliberately NOT here: now() is not
        # IMMUTABLE and Postgres would reject it. That restriction is
        # what makes the index non-degrading, so it costs nothing --
        # the age comparison becomes a range scan on published_at, the
        # indexed column.
        #
        # The UPDATE in relay.py MUST repeat both conditions verbatim.
        # The planner only uses a partial index when it can prove the
        # query's predicate implies the index's; a WHERE carrying just
        # the date would not be matched, and the scan would come back.
        Index(
            "ix_outbox_events_pending_redaction",
            "published_at",
            postgresql_where=text(
                f"published_at IS NOT NULL AND {_NOT_YET_REDACTED_SQL}"
            ),
        ),
    )

    def __repr__(self) -> str:
        state = "published" if self.published_at else "pending"
        return (
            f"<OutboxEvent id={self.id} type={self.event_type} "
            f"{state} attempts={self.attempts}>"
        )
