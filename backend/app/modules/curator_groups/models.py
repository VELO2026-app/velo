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
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint, func
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
