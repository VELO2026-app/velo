# =============================================================================
# VELO Backend -- support thread pointer (B34)
# =============================================================================
#
# The local pointer for ONE eternal comms thread per (user, support section).
# Same reason chat_threads exists (chats/models.py): comms' read API is
# operator-scoped, and a section thread's operator is the section, not the
# caller, so comms cannot answer "is this user the client of thread T" any
# more than it can for a DM. Kept deliberately separate from ChatThread
# rather than reusing it: ChatThread has two NON-NULLABLE user FKs
# (client_user_id, operator_user_id) because a DM's operator is always a
# master (a user row); a support thread's operator is a comms SECTION id,
# which is not a users.id and cannot be forced into that column without
# either a nullable FK (weakening the DM invariant) or a fake user row.
# ONE ROW PER USER: `client_user_id` is UNIQUE. This is the local mirror of
# the design decision made in support/service.py (kind="dm", no subject) --
# comms itself already dedups to one eternal thread per (client, section)
# pair; the local unique constraint keeps the pointer table honest under
# the same invariant instead of silently allowing a second local row to
# point at a comms thread that already exists for that user.
#
# The support section id itself is NEVER a column here or anywhere else
# (support-sections-integration.md §3, binding): it does not survive a
# comms teardown, so persisting it would go stale. Only the resulting
# THREAD id is stored, exactly like chat_threads.
# =============================================================================

from uuid import UUID

from sqlalchemy import ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.core.mixins import TimestampMixin, UUIDMixin


class SupportThread(UUIDMixin, TimestampMixin, Base):
    """velo's pointer to one user's eternal comms support thread."""

    __tablename__ = "support_threads"

    # The comms thread id (UUID, opaque to us). Unique: create-or-get in
    # comms returns the SAME thread for a repeated (client, section) pair.
    comms_thread_id: Mapped[UUID] = mapped_column(nullable=False)

    # The user who opened the thread. Unique: one support thread per user,
    # for the life of the account (mirrors comms' own dm-kind dedup).
    client_user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )

    __table_args__ = (
        UniqueConstraint(
            "comms_thread_id", name="uq_support_threads_comms_id",
        ),
        UniqueConstraint(
            "client_user_id", name="uq_support_threads_client",
        ),
    )
