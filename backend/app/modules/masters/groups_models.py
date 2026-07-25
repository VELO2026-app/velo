# =============================================================================
# VELO Backend -- Master Groups Models (P1, ПРОМТ №590)
# =============================================================================
#
# Three tables. "Ученики" / "Удалённые" are NOT rows here -- they are DERIVED
# (see groups_service.py's virtual-group queries):
#   - "Ученики"   = users with >= 1 non-CANCELLED booking on this master's
#                   practices, minus anyone MasterStudent.blocked_at'd.
#   - "Удалённые" = MasterStudent rows with blocked_at set.
#
# MasterGroup / MasterGroupMembership only ever describe CUSTOM groups.
# MasterStudent is the per-(master, student) annotation (tag and/or block) --
# a row exists ONLY when the master has tagged or blocked that student.
#
# Mirrors the master-scope FK pattern already proven by
# TaxonomyDirection.master_id (practices/taxonomy_models.py:42).
# =============================================================================

from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.core.mixins import UUIDMixin


class MasterGroup(UUIDMixin, Base):
    """A master-created custom student group.

    UNIQUE (master_id, name) -- no two custom groups of the same master may
    share a name (case-sensitive; enforced at the DB level, pre-checked in
    the service for a clean 409 and backstopped by catching the resulting
    IntegrityError, same discipline as practices/service.py's dup-guard).
    """

    __tablename__ = "master_group"
    __table_args__ = (
        UniqueConstraint("master_id", "name", name="uq_master_group_master_name"),
    )

    master_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )

    def __repr__(self) -> str:
        return (
            f"<MasterGroup id={self.id} master_id={self.master_id} "
            f"name={self.name!r}>"
        )


class MasterGroupMembership(UUIDMixin, Base):
    """One student's membership in one CUSTOM group.

    UNIQUE (group_id, student_user_id) -- a student appears at most once per
    group; POST .../members is idempotent-safe against this constraint.
    ondelete=CASCADE on group_id: deleting a group drops its memberships --
    the student falls back to the derived "Ученики", nothing else to do.
    """

    __tablename__ = "master_group_membership"
    __table_args__ = (
        UniqueConstraint(
            "group_id", "student_user_id",
            name="uq_master_group_membership_group_student",
        ),
    )

    group_id: Mapped[UUID] = mapped_column(
        ForeignKey("master_group.id", ondelete="CASCADE"),
        nullable=False,
    )
    student_user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    added_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )

    def __repr__(self) -> str:
        return (
            f"<MasterGroupMembership group_id={self.group_id} "
            f"student_user_id={self.student_user_id}>"
        )


class GroupInvite(UUIDMixin, Base):
    """A CUSTOM group's reusable join link (P4, ПРОМТ №593).

    REUSABLE + STABLE by design -- unlike the single-use, Redis-only,
    sha256'd master_onboarding invite (admin/masters/service.py), the master
    pastes this into a channel and taps «Пригласить» repeatedly expecting the
    SAME link back every time, and it must still resolve on join whenever a
    follower opens it days later. Storing the raw token (not a hash) is
    acceptable here: a group invite only grants "join this contact group"
    (low-sensitivity, and master-reversible any time by removing the member),
    unlike the master_onboarding invite which grants a master-role
    application slot.

    UNIQUE group_id: ONE active invite per group -- create-or-return
    (groups_service.get_or_create_group_invite) is a plain select-then-insert
    against this constraint.
    """

    __tablename__ = "group_invite"

    group_id: Mapped[UUID] = mapped_column(
        ForeignKey("master_group.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    token: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )

    def __repr__(self) -> str:
        return f"<GroupInvite id={self.id} group_id={self.group_id}>"


class MasterStudent(UUIDMixin, Base):
    """Per-(master, student) annotation: a single tag and/or a block.

    A row exists ONLY when the master has tagged OR blocked this student --
    a plain derived "Ученик" with neither has no row. ONE tag per student
    (owner Q1=A): a second PUT .../tag overwrites, it does not append.
    UNIQUE (master_id, student_user_id) enforces "one row per pair" and is
    the upsert target (PUT .../tag creates-or-updates against it).
    """

    __tablename__ = "master_student"
    __table_args__ = (
        UniqueConstraint(
            "master_id", "student_user_id",
            name="uq_master_student_master_student",
        ),
    )

    master_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    student_user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    tag: Mapped[str | None] = mapped_column(String(100), default=None)
    blocked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )
    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), onupdate=func.now(),
    )

    def __repr__(self) -> str:
        return (
            f"<MasterStudent master_id={self.master_id} "
            f"student_user_id={self.student_user_id} "
            f"blocked={self.blocked_at is not None}>"
        )
