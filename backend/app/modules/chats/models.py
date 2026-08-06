# =============================================================================
# VELO Backend -- chat thread pointer (Phase 6 / T2)
# =============================================================================
#
# The conversation itself lives in comms: messages, unread state, ordering,
# dedup -- none of it is duplicated here. This table holds one thing comms
# cannot answer for us, and it is the reason it exists at all:
#
#   WHO IS ALLOWED TO TOUCH THREAD X.
#
# The comms trust model (frozen 3b) says the product proxy is the sole owner
# of "user X may act only as user X". comms will happily post a message to
# any thread id with any sender we send it. But its read API is
# OPERATOR-scoped (`GET /threads?operator=`), so there is no way to ask it
# "is this student a participant of thread T" -- and without an answer, a
# forged thread id in a URL would read somebody else's conversation.
#
# Hence a local pointer row, written when the proxy creates-or-gets a thread.
# It also gives the student side a list of its own chats, which the
# operator-scoped comms API cannot produce either.
#
# What this table is NOT: a mirror. No message bodies, no unread counters, no
# last-activity -- those stay in comms and are read through it, so the two
# sides cannot disagree about conversation state (ID-4: comms is not asked
# for domain facts, and velo does not shadow-copy its facts either).
# =============================================================================

from uuid import UUID

from sqlalchemy import ForeignKey, Index, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.core.mixins import TimestampMixin, UUIDMixin


class ChatThread(UUIDMixin, TimestampMixin, Base):
    """velo's pointer to one comms thread, plus its two participants."""

    __tablename__ = "chat_threads"

    # The comms thread id (UUID, opaque to us). Unique: create-or-get in
    # comms returns the SAME thread for a repeated (client, operator) pair,
    # so a second proxy call must find this row, not add another.
    comms_thread_id: Mapped[UUID] = mapped_column(nullable=False)

    # The two participants, both velo users. `client` is the student who
    # opened the chat; `operator` is the master. comms knows them as opaque
    # recipient ids -- the same values, because identity sync maps
    # recipient_id <- User.id one to one (core/events/sync.py).
    client_user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )
    operator_user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )

    __table_args__ = (
        UniqueConstraint("comms_thread_id", name="uq_chat_threads_comms_id"),
        # The dedup key mirrored: one eternal DM per (student, master) pair.
        # Not a constraint the proxy relies on for correctness -- comms owns
        # dedup -- but a second row for the same pair would mean the two
        # sides disagree, and that should fail loudly rather than rot.
        UniqueConstraint(
            "client_user_id",
            "operator_user_id",
            name="uq_chat_threads_pair",
        ),
        # The student's own list: WHERE client_user_id = ? ORDER BY created_at.
        Index(
            "ix_chat_threads_client_created",
            "client_user_id",
            "created_at",
        ),
    )
