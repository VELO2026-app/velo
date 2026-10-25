# =============================================================================
# VELO Backend -- support threads and tickets (B34, BE-162)
# =============================================================================
#
# TWO TABLES, TWO QUESTIONS.
#
#   support_threads -- WHICH comms threads are a person's support
#     conversation, and whose. One row per comms thread, however many a
#     person has (BE-162). The pointer exists for the reason chat_threads
#     does (chats/models.py): comms reads any thread id it is given, so
#     "is this person the client of thread T" is ours to answer. Kept
#     separate from ChatThread: a support thread's operator is a comms
#     SECTION, not a users.id.
#
#   support_tickets -- WHAT a thread is to support: every appeal through
#     the support form is a ticket (owner ruling BE-162) -- its own comms
#     thread of kind `ticket`, a topic and a category as CODES, our own
#     status, the admin who took it. One row per ticket thread; its key IS
#     the thread row's id. No message text, ever: the conversation lives in
#     comms.
#
# A THREAD WITHOUT A TICKET is the person's HISTORY: the one eternal `dm`
# thread support used before BE-162 (owner: it stays history, no tickets
# after the fact). Nothing creates such a row any more -- every new support
# thread is born with its ticket, in the same transaction
# (service.py::create_ticket) -- so a person has at most the one history
# thread they already had, and it is read-only for admins.
#
# The support section id itself is NEVER a column here or anywhere else
# (support-sections-integration.md section 3, binding): it does not survive
# a comms teardown. Only thread ids are stored.
# =============================================================================
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.core.mixins import TimestampMixin, UUIDMixin


class SupportThread(UUIDMixin, TimestampMixin, Base):
    """velo's pointer to one comms support thread of one person."""

    __tablename__ = "support_threads"

    # The comms thread id (UUID, opaque to us). Unique: one pointer per
    # thread -- a ticket replayed under its client key returns the SAME
    # thread from comms, and this constraint is what turns the replay into
    # "the ticket exists" (service.py::create_ticket).
    comms_thread_id: Mapped[UUID] = mapped_column(nullable=False)
    # The person whose support conversation this is (comms' `client`).
    # Not unique since BE-162: a person has a thread per ticket.
    client_user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )

    __table_args__ = (
        UniqueConstraint(
            "comms_thread_id", name="uq_support_threads_comms_id",
        ),
    )


# =============================================================================
# Tickets (BE-162)
# =============================================================================

# Categories (owner ruling BE-162, item 7) -- codes; the labels are the
# front's, in the reader's language.
CATEGORY_TECH = "tech"
CATEGORY_PRACTICES = "practices"
CATEGORY_PAYMENTS = "payments"
CATEGORY_COMPLAINT_MASTER = "complaint_master"
CATEGORY_COMPLAINT_USER = "complaint_user"
CATEGORY_OTHER = "other"
CATEGORIES = (
    CATEGORY_TECH,
    CATEGORY_PRACTICES,
    CATEGORY_PAYMENTS,
    CATEGORY_COMPLAINT_MASTER,
    CATEGORY_COMPLAINT_USER,
    CATEGORY_OTHER,
)


@dataclass(frozen=True)
class Topic:
    """One topic of the support forms: its category, and its label in the
    two profile languages -- read ONLY by the admin signal
    (service.py::_topic_lines), which is rendered by comms and cannot look
    a code up; every screen draws its own labels from the code."""

    category: str
    ru: str
    en: str


# THE ONE PLACE "topic -> category" lives (BE-162, the card's table).
# Codes are the forms' own values (frontend SupportView / MasterSupportView);
# `technical` and `other` are on both forms. Which form shows which topic is
# the form's business: any known code is accepted from anyone.
TOPIC_OTHER = "other"
TOPICS: dict[str, Topic] = {
    # the user's form
    "payment": Topic(
        CATEGORY_PAYMENTS,
        "Проблема с оплатой / транзакцией",
        "A problem with a payment / transaction",
    ),
    "complaint_master": Topic(
        CATEGORY_COMPLAINT_MASTER, "Жалоба на мастера", "A complaint about a master",
    ),
    "practice": Topic(
        CATEGORY_PRACTICES, "Проблема с практикой", "A problem with a practice",
    ),
    # the master's form
    "withdrawal": Topic(
        CATEGORY_PAYMENTS, "Проблема с выводом", "A problem with a withdrawal",
    ),
    "practices": Topic(
        CATEGORY_PRACTICES, "Вопрос по практикам", "A question about practices",
    ),
    "add_direction": Topic(
        CATEGORY_PRACTICES,
        "Добавить направление практики",
        "Add a practice direction",
    ),
    "complaint_user": Topic(
        CATEGORY_COMPLAINT_USER, "Жалоба на пользователя", "A complaint about a user",
    ),
    # both forms
    "technical": Topic(CATEGORY_TECH, "Технические проблемы", "Technical problems"),
    TOPIC_OTHER: Topic(CATEGORY_OTHER, "Другое", "Other"),
}

# Statuses (owner ruling BE-162, item 4) -- ours. comms knows only `open`
# and `resolved`: every status but OPEN is `resolved` there, and nothing
# ever moves a ticket's thread to `closed` (comms would tell the person).
STATUS_OPEN = "open"
STATUS_RESOLVED = "resolved"
STATUS_REJECTED = "rejected"
STATUS_DUPLICATE = "duplicate"
STATUS_SPAM = "spam"
STATUSES = (
    STATUS_OPEN,
    STATUS_RESOLVED,
    STATUS_REJECTED,
    STATUS_DUPLICATE,
    STATUS_SPAM,
)
# Where an admin may move an OPEN ticket. Back to OPEN only a person's
# message does (service.py::send_dialog_message); an admin's "back to work"
# is delivery 2.
CLOSING_STATUSES = (STATUS_RESOLVED, STATUS_REJECTED, STATUS_DUPLICATE, STATUS_SPAM)


def _sql_in(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{v}'" for v in values)


class SupportTicket(TimestampMixin, Base):
    """One appeal through the support form: its thread, topic, category,
    status and the admin who took it. `created_at` is the date of the
    appeal."""

    __tablename__ = "support_tickets"

    # The ticket IS its thread: the key is the support_threads row's id.
    # DEFERRED (BE-162 delivery 3): a ticket names people three times with
    # ON DELETE SET NULL (taken, resolved, rated). Deleting its person and
    # its admins in ONE statement deletes the thread by cascade and updates
    # the ticket twice by SET NULL; the second update re-checks this key
    # against a thread already gone, before the cascade reaches the ticket
    # itself -- a 23503 on a delete that ends consistent. Checked at commit,
    # the key sees the end state: the ticket gone with its thread.
    support_thread_id: Mapped[UUID] = mapped_column(
        ForeignKey(
            "support_threads.id",
            ondelete="CASCADE",
            deferrable=True,
            initially="DEFERRED",
        ),
        primary_key=True,
    )
    topic: Mapped[str] = mapped_column(String(32))
    category: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(16), default=STATUS_OPEN)
    # Who took it (claim). Their signal is theirs alone (owner ruling 6).
    claimed_by_user_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    status_changed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
    )
    # The admin who last moved the ticket to RESOLVED (BE-162, delivery 3):
    # the "who resolved" of the card. A later reopen keeps it; a later
    # RESOLVED overwrites it.
    resolved_by_user_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    # THE RATING (owner ruling: one per ticket, asked for at RESOLVED):
    # 1..5 stars, an optional comment kept with the ticket -- not a chat
    # message, never translated here (owner, BE-162 delivery 3 gate) --,
    # when, and who had resolved the ticket WHEN it was rated: the admin
    # the rating is about. `resolved_by_user_id` may move on after that (a
    # reopen, another admin resolves); the rating stays with whom it rated.
    rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    rating_comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    rated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True,
    )
    rated_resolver_user_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    # Bumped by every change of the row a status change must not miss --
    # a person's message, a status change: the admin's status change is a
    # compare-and-set on it (service.py::set_ticket_status), since comms is
    # called between reading the ticket and writing it.
    version: Mapped[int] = mapped_column(Integer, default=1)

    __table_args__ = (
        CheckConstraint(
            f"topic IN ({_sql_in(tuple(TOPICS))})",
            name="ck_support_tickets_topic",
        ),
        CheckConstraint(
            f"category IN ({_sql_in(CATEGORIES)})",
            name="ck_support_tickets_category",
        ),
        CheckConstraint(
            f"status IN ({_sql_in(STATUSES)})",
            name="ck_support_tickets_status",
        ),
        CheckConstraint(
            "rating IS NULL OR rating BETWEEN 1 AND 5",
            name="ck_support_tickets_rating",
        ),
        # A rating is a whole: the stars and when, or nothing.
        CheckConstraint(
            "(rating IS NULL) = (rated_at IS NULL)",
            name="ck_support_tickets_rated_at",
        ),
        Index(
            "ix_support_tickets_created",
            "created_at",
            "support_thread_id",
        ),
    )


# =============================================================================
# The spam bin (BE-162 delivery 2)
# =============================================================================


class SupportSpamTombstone(UUIDMixin, Base):
    """What is left of a spam ticket the bin emptied (owner ruling: after
    the deletion the statistics keep only the date and the category, no
    text): the date of the appeal and its category -- nothing that names
    a person, a thread or an admin. Written in the transaction that deletes
    the ticket (service.purge_spam_step); read by service.support_stats."""

    __tablename__ = "support_spam_tombstones"

    appealed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    category: Mapped[str] = mapped_column(String(32))

    __table_args__ = (
        CheckConstraint(
            f"category IN ({_sql_in(CATEGORIES)})",
            name="ck_support_spam_tombstones_category",
        ),
        Index("ix_support_spam_tombstones_appealed", "appealed_at"),
    )


class SupportThreadPurge(Base):
    """A comms thread whose rows velo has already deleted and comms has not
    yet: the second phase of emptying the spam bin. A row lives from the
    transaction that deletes the ticket until comms answers the DELETE
    (204, also for a thread already gone) -- comms down leaves it for the
    next step. `attempts` and `last_error_at` are there to be seen."""

    __tablename__ = "support_thread_purges"

    comms_thread_id: Mapped[UUID] = mapped_column(primary_key=True)
    queued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_error_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True,
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

