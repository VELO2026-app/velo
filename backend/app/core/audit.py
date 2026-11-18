# =============================================================================
# VELO Backend -- Audit Service (Pre-6.2)
# =============================================================================
#
# Immutable audit log for financial and administrative operations.
# Required by law for financial transactions (5-year retention).
#
# MODEL:
#   AuditLog -- append-only table. No UPDATE, no DELETE in application code.
#   Not using UUIDMixin/TimestampMixin because:
#     - No updated_at (immutable records)
#     - Explicit column definitions for clarity in an audit context
#
# SERVICE:
#   record_audit() -- creates an AuditLog entry in the current session.
#   Does NOT commit (P-01) -- caller's session handles it.
#   Reads the request id, the client address and the User-Agent from the
#   request's context (core/middleware.py).
#
# ACTOR TYPES:
#   "user"   -- regular user performing an action
#   "admin"  -- admin performing moderation/verification
#   "system" -- automated action (cron, listener, webhook)
#
# MANDATORY EVENTS (actual names used in code):
#   payment_topup_created       -- user initiates Stripe checkout
#   payment_topup_confirmed     -- Stripe webhook confirms payment
#   payment_topup_failed        -- Stripe checkout expired / failed
#   purchase_created            -- user books a paid practice
#   purchase_completed          -- practice finalized or late cancel
#   purchase_refunded           -- user cancel > 24h or master cancel
#   master_verified             -- admin verifies master application
#   master_rejected             -- admin rejects master application
#   practice_cancelled_by_master -- master cancels own practice
#
# FUTURE (not yet implemented):
#   withdrawal_requested, withdrawal_confirmed,
#   role_changed, user_blocked
#
# REQUEST ID LINKAGE (BE-190):
#   The request id (written into the trace_id column, see below), the
#   client address and the User-Agent come from RequestContextMiddleware.
#   The id links an audit entry to the log lines of its request and to
#   comms; the address and agent capture the request's origin for security
#   forensics. They are kept HERE, never in a log line (protocol 9.4).
# =============================================================================

from datetime import datetime
from uuid import UUID, uuid4

import structlog
from sqlalchemy import DateTime, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.core.middleware import (
    client_ip,
    client_user_agent,
    current_request_id,
)

logger = structlog.get_logger()

# L-05: user_agent column is String(500). Bots and crawlers can send
# arbitrarily long User-Agent headers that would cause DataError.
_MAX_USER_AGENT_LEN = 500

# The width of AuditLog.trace_id, which carries the request id.
_AUDIT_REQUEST_ID_LEN = 36


def _audit_request_id(request_id: str | None) -> str | None:
    """The request id as the audit column can hold it.

    KNOWN CEILING -- a request id longer than 36 characters is not written.
      1. Mechanics: protocol 9.6 lets an incoming X-Request-ID be up to 128
         characters, and AuditLog.trace_id is String(36). Writing a longer
         one would raise on flush and roll back the caller's whole
         transaction -- financial ones included (record_audit writes into
         the caller's session, P-01). Such an entry keeps NULL: its link to
         the request's log lines is lost, the operation is not. Ids velo
         mints are uuid4, 36 characters, and always fit.
      2. Status: acknowledged by design.
      3. Task: none -- the dispatcher opens the card for the column
         migration in `test`; branch deploy-machine carries no migrations
         (par0 §14).
      4. Unfreeze trigger: that migration reaches this branch (the final
         merge of deploy-machine and test).
      5. Agreed fix: rename the column to request_id, String(128), and
         write the id whole; this function goes away.
      6. Rejected: truncating the id -- a cut id names a different request,
         which is worse than none; refusing long ids in the middleware --
         protocol 9.6 says up to 128 is kept.
    """
    if request_id is None or len(request_id) > _AUDIT_REQUEST_ID_LEN:
        return None
    return request_id


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------


class AuditLog(Base):
    """Immutable audit log entry.

    Append-only -- application code must never UPDATE or DELETE rows.
    Retention: 5 years (legal requirement for financial operations).
    """

    __tablename__ = "audit_logs"

    id: Mapped[UUID] = mapped_column(
        primary_key=True,
        default=uuid4,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        index=True,
    )

    # -- What happened --
    event: Mapped[str] = mapped_column(String(100), index=True)

    # -- Who did it --
    # actor_id is None for system actions (cron, webhooks).
    actor_id: Mapped[UUID | None] = mapped_column()
    actor_type: Mapped[str] = mapped_column(String(20))

    # -- What was affected --
    target_type: Mapped[str] = mapped_column(String(50))
    target_id: Mapped[UUID] = mapped_column()

    # -- Context --
    data: Mapped[dict] = mapped_column(
        JSONB,
        default=dict,
        server_default="{}",
    )

    # -- Request context (populated from middleware / contextvars) --
    ip_address: Mapped[str | None] = mapped_column(String(45))
    user_agent: Mapped[str | None] = mapped_column(String(500))
    # The request id of the request that wrote the entry (BE-190; the
    # column keeps its old name until it is migrated -- see
    # _audit_request_id).
    trace_id: Mapped[str | None] = mapped_column(String(36))

    def __repr__(self) -> str:
        return (
            f"<AuditLog id={self.id} event={self.event} "
            f"actor={self.actor_type}:{self.actor_id}>"
        )


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


async def record_audit(
    *,
    event: str,
    actor_id: UUID | None,
    actor_type: str,
    target_type: str,
    target_id: UUID,
    data: dict | None = None,
    session: AsyncSession,
) -> AuditLog:
    """Record an audit log entry.

    Creates an AuditLog row in the current session. Does NOT commit
    (P-01) -- the caller's transaction handles commit/rollback.

    The request id, the client address and the User-Agent are read from
    the request's context (core/middleware.py) automatically.

    Args:
        event: Event name (e.g. "master_verified", "purchase_created").
        actor_id: UUID of the user/admin performing the action. None for system.
        actor_type: "user", "admin", or "system".
        target_type: Type of affected entity (e.g. "master_profile", "purchase").
        target_id: UUID of the affected entity.
        data: Additional context as dict (stored in JSONB).
        session: AsyncSession -- must be an active write session.

    Returns:
        The created AuditLog entry (not yet committed).
    """
    # The request's context (core/middleware.py).
    request_id = _audit_request_id(current_request_id())
    ip_address = client_ip()
    user_agent = client_user_agent()

    # L-05: truncate user_agent to fit String(500) column.
    # Bots and crawlers can send arbitrarily long User-Agent headers.
    if user_agent and len(user_agent) > _MAX_USER_AGENT_LEN:
        user_agent = user_agent[:_MAX_USER_AGENT_LEN]

    entry = AuditLog(
        event=event,
        actor_id=actor_id,
        actor_type=actor_type,
        target_type=target_type,
        target_id=target_id,
        data=data or {},
        trace_id=request_id,
        ip_address=ip_address,
        user_agent=user_agent,
    )
    session.add(entry)

    logger.info(
        "audit_recorded",
        audit_event=event,
        actor_type=actor_type,
        actor_id=str(actor_id) if actor_id else None,
        target_type=target_type,
        target_id=str(target_id),
    )

    return entry
