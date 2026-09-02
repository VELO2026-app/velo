# =============================================================================
# VELO Backend -- Curator Groups Models (P1, tz-curator-groups.md 3.1)
# =============================================================================
#
# Four tables land in ONE migration, but only the first two have a writer in
# this delivery. That is deliberate and not a "dead branch": the writers of
# curator_group_invite (GT-3) and curator_group_transfer (GT-4) are named and
# scheduled, and one migration per line is cheaper than three.
#
# The curator is NOT a curator_group_member row (I-2): their relation is
# DERIVED from curator_group.curator_user_id. Storing it twice would mean two
# places to keep in step, and the first divergence would be silent -- the same
# reasoning that keeps «Ученики»/«Удалённые» out of master_group.
#
# A pending transfer is a ROW, not a pair of nullable columns on the group
# (3.1): "no offer" is "no row", cancelling is a DELETE, and there is no
# half-NULL state anyone has to interpret.
# =============================================================================

import enum
from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy import text as sa_text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.core.mixins import TimestampMixin, UUIDMixin


class CuratorMemberKind(enum.StrEnum):
    """What kind of relation one membership row describes.

    ONE enum serves both curator_group_member.kind and
    curator_group_invite.kind (GT-3): the value sets are identical
    ('master' | 'student') and a second enum spelling the same two strings
    would be a copy -- the first edit to one of them would leave the other
    lying.

    Stored as String(10), never a PG ENUM -- same choice as
    Practice.audience_kind (practices/models.py): a PG ENUM needs a migration
    to gain a value, a varchar does not.
    """

    MASTER = "master"
    STUDENT = "student"


class CuratorGroup(UUIDMixin, TimestampMixin, Base):
    """A school/community owned by one Master-Curator.

    UNIQUE (curator_user_id, name) -- names are unique WITHIN one curator,
    not globally (I-7): two different curators may both run a group called
    «Школа дыхания» and neither blocks the other. Enforced at the DB level,
    pre-checked in the service for a clean 409 and backstopped by catching
    the IntegrityError -- same three-part discipline as create_group()
    in masters/groups_service.py.

    description is Text, not String(N): the 500-char cap lives at the schema
    layer (CuratorGroupDescriptionStr), same split as MasterGroup.description
    and Practice.description.
    """

    __tablename__ = "curator_group"
    __table_args__ = (
        UniqueConstraint(
            "curator_user_id", "name", name="uq_curator_group_curator_name",
        ),
    )

    curator_user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, default=None)

    def __repr__(self) -> str:
        return (
            f"<CuratorGroup id={self.id} "
            f"curator_user_id={self.curator_user_id} name={self.name!r}>"
        )


class CuratorGroupMember(UUIDMixin, Base):
    """One person's membership in one curator group.

    UNIQUE (group_id, user_id) -- ONE relation per pair, with `kind` inside
    it (I-2). Not UNIQUE (group_id, user_id, kind): that would permit the
    same person to hold BOTH a master and a student row in one group, and
    every counter, roster and predicate downstream would then have to decide
    which one wins.

    ondelete=CASCADE on both FKs: deleting the group drops its memberships,
    deleting the user drops theirs -- nothing else to reconcile, and the test
    cleanup relies on the user-side cascade rather than a step of its own.
    """

    __tablename__ = "curator_group_member"
    __table_args__ = (
        UniqueConstraint(
            "group_id", "user_id", name="uq_curator_group_member_group_user",
        ),
    )

    group_id: Mapped[UUID] = mapped_column(
        ForeignKey("curator_group.id", ondelete="CASCADE"),
        nullable=False,
    )
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    kind: Mapped[str] = mapped_column(String(10), nullable=False)
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )

    def __repr__(self) -> str:
        return (
            f"<CuratorGroupMember group_id={self.group_id} "
            f"user_id={self.user_id} kind={self.kind!r}>"
        )


class CuratorGroupInvite(UUIDMixin, Base):
    """A group's reusable join link, one per kind (GT-3 writes it).

    UNIQUE (group_id, kind) -- one live link per kind, so create-or-return is
    a plain select-then-insert against the constraint (the shape
    get_or_create_group_invite already proved for master_group).
    UNIQUE (token) -- the join-time lookup key.

    Raw token, not a hash: mirrors group_invite's own reasoning -- the link
    only grants "join this group", is revocable by the curator at any time,
    and must keep resolving for whoever opens it days later.

    NO WRITER IN THIS DELIVERY. The table is created now so that GT-3 ships
    code only; the writer is named, not hypothetical.
    """

    __tablename__ = "curator_group_invite"
    __table_args__ = (
        UniqueConstraint(
            "group_id", "kind", name="uq_curator_group_invite_group_kind",
        ),
        UniqueConstraint("token", name="uq_curator_group_invite_token"),
    )

    group_id: Mapped[UUID] = mapped_column(
        ForeignKey("curator_group.id", ondelete="CASCADE"),
        nullable=False,
    )
    kind: Mapped[str] = mapped_column(String(10), nullable=False)
    token: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )

    def __repr__(self) -> str:
        return (
            f"<CuratorGroupInvite group_id={self.group_id} kind={self.kind!r}>"
        )


class CuratorGroupTransfer(UUIDMixin, Base):
    """A pending offer to hand the group to a master member (GT-4 writes it).

    UNIQUE (group_id) -- at most one pending offer per group (I-10). A second
    offer is a 409 rather than a silent overwrite, and that is enforceable
    here rather than only in code.

    NO WRITER IN THIS DELIVERY -- see CuratorGroupInvite.
    """

    __tablename__ = "curator_group_transfer"
    __table_args__ = (
        UniqueConstraint("group_id", name="uq_curator_group_transfer_group"),
    )

    group_id: Mapped[UUID] = mapped_column(
        ForeignKey("curator_group.id", ondelete="CASCADE"),
        nullable=False,
    )
    to_user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    requested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )

    def __repr__(self) -> str:
        return (
            f"<CuratorGroupTransfer group_id={self.group_id} "
            f"to_user_id={self.to_user_id}>"
        )


class CuratorGroupEventKind(enum.StrEnum):
    """What happened in a school. The vocabulary of its journal (GT-16).

    Stored as String(50), never a PG ENUM -- same choice as
    CuratorMemberKind above and Practice.audience_kind: this set is
    EXPECTED to grow (notifications land on it next, practice publication
    after that), and a varchar gains a value without a migration.

    A DELETED SCHOOL HAS NO "school deleted" EVENT and never will. The
    journal cascades with the group, so the row would be written and
    dropped inside one transaction -- a value here for it would be a
    vocabulary entry no reader can ever meet.
    """

    GROUP_CREATED = "group_created"
    GROUP_RENAMED = "group_renamed"
    GROUP_DESCRIPTION_CHANGED = "group_description_changed"
    MEMBER_JOINED = "member_joined"
    MEMBER_PROMOTED = "member_promoted"
    MEMBER_REMOVED = "member_removed"
    MEMBER_LEFT = "member_left"
    INVITE_CREATED = "invite_created"
    INVITE_REVOKED = "invite_revoked"
    TRANSFER_OFFERED = "transfer_offered"
    TRANSFER_ACCEPTED = "transfer_accepted"
    TRANSFER_DECLINED = "transfer_declined"
    TRANSFER_CANCELLED = "transfer_cancelled"


# The keys of CuratorGroupEvent.data, spelled ONCE. JSONB has no model
# behind it, so a mistyped key does not fail -- it writes a key nobody
# reads and the journal quietly loses the half of the sentence it was
# supposed to carry. Only the keys written from MORE THAN ONE place are
# named here; a key with a single writer cannot drift from itself.
EVENT_DATA_KIND = "kind"                  # join, promote, remove, leave
EVENT_DATA_ACTOR_NAME = "actor_name"      # all twelve
EVENT_DATA_TARGET_USER_ID = "target_user_id"   # remove, offer, accept, decline
EVENT_DATA_TARGET_NAME = "target_name"         # remove, offer, accept, decline


class CuratorGroupEvent(Base):
    """One thing that happened in one school, for its curator to read.

    NOT audit_logs, and the difference is not stylistic. audit_logs is a
    legal record: admin and finance actions, five-year retention, deletion
    forbidden by code, and NOTHING in app/modules ever selects from it --
    it is a write-only desk. This is a read table with pagination and
    ownership, it records what MEMBERS did, and it dies with the school.
    That last one settles it on its own: audit_logs has no ON DELETE and
    must not have one, while this table's whole lifetime is the group's.

    What IS borrowed from AuditLog is its shape -- indexed `event` string,
    an `actor_id` with no ForeignKey, and a JSONB `data` for context.

    == WHY actor_id CARRIES NO FOREIGN KEY ==

    Same as AuditLog.actor_id, and for the same reason: the row must
    outlive the person. A FK with ON DELETE SET NULL would reach the same
    place, but at the price of a constraint whose only job is to erase
    history, and then "who did this" would be answerable only while the
    actor still has an account. Instead the actor's NAME is copied into
    `data` at write time (see below) and the id is kept as a plain column.

    THIS IS A DELIBERATE DENORMALISATION. Do not "fix" it by adding a
    ForeignKey, and do not replace the stored name with a join to users:
    the journal is history, and "Мария удалила Петра" has to keep saying
    Мария even after Мария has renamed herself or left. A live join turns
    a record of the past into a retelling in the present tense. The same
    freezing applies to the OTHER side of the sentence -- see
    EVENT_DATA_TARGET_NAME: four events have an actor and a target who are
    different people, and a frozen actor beside a live target would leave
    "Мария удалила 9f3c..." exactly as useless as the reverse.

    actor_id is NOT NULL. All thirteen event kinds are somebody's action;
    a nullable column would be a column for a state no writer can produce.
    System-generated events (notifications may bring some) get a migration
    when they arrive -- the database is disposable and there is no legacy.

    == WHY THERE IS A `seq` NEXT TO THE UUID KEY ==

    Ordering is `ORDER BY seq DESC` and nothing else. Not created_at: in
    Postgres now() is the TRANSACTION timestamp, so two events written by
    one request (renaming a school and changing its description in one
    PATCH) carry a byte-identical created_at, and a tie-break on a random
    uuid4 would put them in an arbitrary relative order. Not
    clock_timestamp() either -- an order derived from a clock is an order
    by coincidence, correct only until somebody changes how time is
    stored. A monotonic integer IS order.

    That argument is not ours: core/events/models.py made it first for the
    outbox, whose relay publishes strictly in id order. THE DIFFERENCE
    HERE, and the reason seq is a separate column instead of replacing the
    key: the outbox id never leaves the backend, while this table's id is
    returned to a human. A globally monotonic integer in one curator's
    feed is a counter of platform-wide activity -- read the feed twice a
    day apart and the gap tells you how many events every other school
    had. So identity stays a UUID like its four neighbours and goes out in
    the response; ORDER lives in seq, which does not.

    created_at answers WHEN. seq answers IN WHAT ORDER. Those are
    different questions and this table answers them with different
    columns.

    SEQ IS AN ORDER AND NOT A COUNT. The sequence is shared by every
    school and does not roll back, so a failed action (a 409 on a
    duplicate school name) consumes a value and leaves a gap. Gaps are
    normal. The difference between two seq values counts NOTHING -- not
    events in this school, not events anywhere; anyone building "how many
    were there" on it is reading a guarantee that was never made.

    SEQ IS INSERT ORDER, NOT COMMIT ORDER. Two concurrent transactions can
    take 5 and 6 and commit in the opposite order. Harmless for a school's
    feed, where one curator's actions are sequential -- but written down,
    because the next reader will otherwise infer a guarantee this column
    does not give. The outbox lives with the same property.

    == WHAT THE NEW CURATOR SEES AFTER A TRANSFER ==

    Everything, including the previous curator's actions -- who they
    removed, who walked out. THIS IS A DECISION, not a side effect of the
    row hanging off group_id: a school is handed over WITH its history,
    because an owner who cannot see what they inherited cannot run it. If
    a future change wants to narrow this, it has to argue against that
    sentence rather than discover the behaviour.

    == data, PER EVENT KIND ==

    Written once here because JSONB has no schema and this contract is
    what the notification work will be built from. `data` is never NULL;
    an event with no context stores {}.

    | event                     | data keys                              |
    |---------------------------|----------------------------------------|
    | group_created             | actor_name                             |
    | group_renamed             | actor_name, old_name, new_name         |
    | group_description_changed | actor_name                             |
    | member_joined             | actor_name, kind                       |
    | member_promoted           | actor_name                             |
    | member_removed            | actor_name, kind, target_user_id,      |
    |                           | target_name[, transfer_cancelled]      |
    | member_left               | actor_name, kind[, transfer_cancelled] |
    | invite_created            | actor_name, kind                       |
    | invite_revoked            | actor_name, kind                       |
    | transfer_offered          | actor_name, target_user_id, target_name|
    | transfer_accepted         | actor_name, target_user_id, target_name|
    | transfer_declined         | actor_name, target_user_id, target_name|
    | transfer_cancelled        | actor_name, target_user_id, target_name|

    NO INVITE TOKEN IS EVER STORED IN data, in any form, for any reason.
    The token is a raw secret (secrets.token_urlsafe(32)) and this is a
    paginated feed. Today only the curator reads it and the curator
    already holds the token -- but the feed will outlive that: the
    notification work is built from these same rows, and widening who may
    read them is under discussion. The invite events record the link's
    KIND, never its value. Adding the token "for debugging" would put a
    live credential into a readable list.

    On the four transfer events target_* is the OTHER party, and on
    transfer_accepted specifically that is the PREVIOUS curator -- by the
    time the row is written the group already belongs to the actor, so
    reading "the group's curator" there would record the actor twice.

    == WHY NOT UUIDMixin / TimestampMixin ==

    Both are declared by hand for the same reason AuditLog declares its
    own: seq has to sit next to the key it does not replace, and there is
    no updated_at -- the journal is append-only, so a column that could
    only ever equal created_at would invite an UPDATE that must not
    happen.
    """

    __tablename__ = "curator_group_event"
    __table_args__ = (
        # The ONE query this table serves: one group's feed, newest first,
        # limit/offset. group_id equality then seq descending -- the index
        # answers both the ordering and the COUNT(*) without touching the
        # heap.
        Index(
            "ix_curator_group_event_group_seq",
            "group_id",
            sa_text("seq DESC"),
        ),
    )

    id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True),
        primary_key=True,
        default=uuid4,
    )

    # Order. See the header for why this exists beside id and why it is
    # not created_at.
    seq: Mapped[int] = mapped_column(
        BigInteger,
        Identity(always=False),
        nullable=False,
        unique=True,
    )

    group_id: Mapped[UUID] = mapped_column(
        ForeignKey("curator_group.id", ondelete="CASCADE"),
        nullable=False,
    )

    # Who did it. No ForeignKey -- see the header. Not indexed: nothing
    # queries the journal by actor, and an index for a query nobody makes
    # is a write cost with no reader.
    actor_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True),
        nullable=False,
    )

    event: Mapped[str] = mapped_column(String(50), nullable=False)

    data: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=sa_text("'{}'::jsonb"),
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    def __repr__(self) -> str:
        return (
            f"<CuratorGroupEvent seq={self.seq} group_id={self.group_id} "
            f"event={self.event!r}>"
        )
