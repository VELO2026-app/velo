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
#   published_at ts     -> shipped (kept for audit; no deletes in T0);
#   attempts            -> failed publish attempts (observability +
#                          the poison-row WARN threshold; NEVER a drop
#                          limit -- outbox rows are not discarded).
#
# SESSION RULES: no commit here (P-01); emit_event() inserts into the
# caller's session/transaction.
# =============================================================================

from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, DateTime, Identity, Index, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


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

    # Partial index: the relay's steady-state scan is
    # `WHERE published_at IS NULL ORDER BY id` -- index only the
    # pending tail, not the ever-growing published history.
    __table_args__ = (
        Index(
            "ix_outbox_events_unpublished",
            "id",
            postgresql_where=published_at.is_(None),
        ),
    )

    def __repr__(self) -> str:
        state = "published" if self.published_at else "pending"
        return (
            f"<OutboxEvent id={self.id} type={self.event_type} "
            f"{state} attempts={self.attempts}>"
        )
