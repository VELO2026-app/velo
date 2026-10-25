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

from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
)
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


# =============================================================================
# Support translation jobs (BE-166)
# =============================================================================
#
# OUR WORK QUEUE, NOT A COPY OF THE CONVERSATION: no message text and no
# translation is stored here (comms, 3.8.0: two copies of a conversation
# drift apart). The texts live in comms -- the message in the thread, the
# translation as the message's VARIANT next to it (comms
# deploy/INTEGRATION.md section 12). A row is one attempt of one llm job
# that translates one message into one language, and it exists for what
# only the product can do: write comms' variant request once comms has
# taken the job (request_written_at -- the push listener's sweep retries
# until then), tie a job key back to its message, tell the user once that a
# reply could not be translated (user_notified_at), and let an admin retry.
#
#   direction  to_support -- a user's message, into the support language;
#              to_user -- an admin's reply, into the user's language.
#   outcome    NULL while the job is ours to wait for; then
#              variant     -- the translation was written as a variant;
#              not_needed  -- the model found it already in `locale`;
#              declined    -- written declined: the language is closed for
#                             this message for good (comms never replaces
#                             a variant);
#              failed      -- the job ended without an answer, or comms
#                             refused it at intake: retryable by an admin;
#              retried     -- the answer could not be read, and the next
#                             attempt was queued automatically.

TO_SUPPORT = "to_support"
TO_USER = "to_user"
DIRECTIONS = (TO_SUPPORT, TO_USER)

OUTCOME_VARIANT = "variant"
OUTCOME_NOT_NEEDED = "not_needed"
OUTCOME_DECLINED = "declined"
OUTCOME_FAILED = "failed"
OUTCOME_RETRIED = "retried"
OUTCOMES = (
    OUTCOME_VARIANT,
    OUTCOME_NOT_NEEDED,
    OUTCOME_DECLINED,
    OUTCOME_FAILED,
    OUTCOME_RETRIED,
)


def _sql_in(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{v}'" for v in values)


class SupportTranslationJob(UUIDMixin, TimestampMixin, Base):
    """One attempt to translate one support message into one language."""

    __tablename__ = "support_translation_jobs"

    support_thread_id: Mapped[UUID] = mapped_column(
        ForeignKey("support_threads.id", ondelete="CASCADE"),
        index=True,
    )
    comms_message_id: Mapped[UUID] = mapped_column()
    direction: Mapped[str] = mapped_column(String(16))
    # The variant's language (comms section 12's opaque token; ours are the
    # backend's language codes).
    locale: Mapped[str] = mapped_column(String(8))
    attempt: Mapped[int] = mapped_column(Integer)
    job_key: Mapped[str] = mapped_column(String(200), unique=True)
    request_written_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True,
    )
    outcome: Mapped[str | None] = mapped_column(String(16), nullable=True)
    user_notified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True,
    )

    __table_args__ = (
        UniqueConstraint(
            "comms_message_id", "locale", "attempt",
            name="uq_support_translation_jobs_attempt",
        ),
        CheckConstraint(
            f"direction IN ({_sql_in(DIRECTIONS)})",
            name="ck_support_translation_jobs_direction",
        ),
        CheckConstraint(
            f"outcome IS NULL OR outcome IN ({_sql_in(OUTCOMES)})",
            name="ck_support_translation_jobs_outcome",
        ),
        CheckConstraint(
            "attempt >= 1", name="ck_support_translation_jobs_attempt",
        ),
    )

