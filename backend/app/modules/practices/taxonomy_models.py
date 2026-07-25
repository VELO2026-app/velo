# =============================================================================
# VELO Backend -- Practice Taxonomy Models (R5, batch R stage 1)
# =============================================================================
#
# DB-backed catalog of направления (directions) and виды (styles). Governs
# MASTER METHODS (data.profile.methods) since R5, AND practice-creation
# taxonomy (Practice.data.taxonomy) since T2 (2026-07-15) -- as a UNION with
# the static settings.practice_allowed_directions /
# practice_allowed_styles_by_direction (core/config.py:154-171), never a
# replace: a value is accepted if it's in EITHER source, so the catalog can
# only ever widen what's accepted, never narrow it below today's config-only
# behavior. See practices/service.py: _validate_taxonomy() /
# _validate_style_choice().
#
# ПРОМТ №394 originally scoped this table to master-methods-only "to keep the
# blast radius small" -- that was an explicit DEFERRAL, not a permanent
# boundary (operator roadmap tail T2, DS-build-plan.md OPEN THREADS): unify
# once the catalog was proven live on TEST. T2 is that deferred batch.
#
# Two FK'd tables (not self-referential): a style is always scoped to exactly
# one direction and never nests further, so a plain FK is simpler than a
# recursive taxonomy table for both queries and the future admin CRUD form.
#
# is_active: soft-deactivate only, NEVER hard-delete -- existing masters'
#   stored `methods` strings must keep resolving even after a direction/style
#   is retired from new selection.
# source: 'seed' (from the original config/practiceOptions.ts constants) vs
#   'custom' (born from an approved master custom-method, stage 4 -- not
#   built yet). Lets admin triage which rows were hand-curated vs promoted.
# display_order: preserves the curated ordering the FE currently hardcodes.
# =============================================================================

from uuid import UUID

from sqlalchemy import Boolean, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.core.mixins import TimestampMixin, UUIDMixin


class TaxonomyDirection(UUIDMixin, TimestampMixin, Base):
    """A practice direction (Направление) -- e.g. "meditation" / "Медитация".

    master_id (T22-6, ПРОМТ №561): NULL for every pre-existing / globally
    promoted row (unchanged meaning -- visible to every master's catalog
    fetch). A value scopes the row to exactly one master: it never appears
    in another master's or a non-owner's `GET /taxonomy` response, only in
    the owning master's own. Existence-checks (_validate_taxonomy) and
    value->label lookups (_label_for_direction_value) are deliberately
    master-agnostic -- the per-master boundary is enforced at the catalog
    READ (list_active_taxonomy) and, independently, by
    _assert_master_confirmed_taxonomy already only ever matching against the
    REQUESTING master's own MasterProfile.methods. Styles are never scoped
    (see the migration docstring): the "Свой вариант" picker only ever
    produces a bare custom direction, never a direction+style pair.
    """

    __tablename__ = "practice_directions"

    value: Mapped[str] = mapped_column(String(50), unique=True, nullable=False)
    label: Mapped[str] = mapped_column(String(100), nullable=False)
    display_order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    source: Mapped[str] = mapped_column(String(20), default="custom", server_default="custom")
    master_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
    )

    styles: Mapped[list["TaxonomyStyle"]] = relationship(
        back_populates="direction",
        order_by="TaxonomyStyle.display_order",
    )


class TaxonomyStyle(UUIDMixin, TimestampMixin, Base):
    """A style (Вид) scoped to one direction -- e.g. "hatha" / "Хатха-йога"."""

    __tablename__ = "practice_styles"
    __table_args__ = (
        UniqueConstraint("direction_id", "value", name="uq_practice_styles_direction_value"),
    )

    direction_id: Mapped[UUID] = mapped_column(
        ForeignKey("practice_directions.id", ondelete="CASCADE"),
        nullable=False,
    )
    value: Mapped[str] = mapped_column(String(50), nullable=False)
    label: Mapped[str] = mapped_column(String(100), nullable=False)
    display_order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    source: Mapped[str] = mapped_column(String(20), default="custom", server_default="custom")

    direction: Mapped["TaxonomyDirection"] = relationship(back_populates="styles")
