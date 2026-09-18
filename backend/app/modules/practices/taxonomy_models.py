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
# PROMPT №394 originally scoped this table to master-methods-only "to keep the
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

    master_id (T22-6, PROMPT №561): NULL for every pre-existing / globally
    promoted row (unchanged meaning -- visible to every master's catalog
    fetch). A value scopes the row to exactly one master: it never appears
    in another master's or a non-owner's `GET /taxonomy` response, only in
    the owning master's own. EXISTENCE-checks (_validate_taxonomy) stay
    deliberately master-agnostic -- master onboarding's picker needs the
    unfiltered catalog and must never route through a confirmation check
    (T21-6). VALUE->LABEL LOOKUPS (_label_for_direction_value) USED TO BE
    master-agnostic for the same reason and ARE NOT SINCE BE-38.

    The old reasoning was that the per-master boundary is held twice
    elsewhere: at the catalog READ (list_active_taxonomy) and, separately,
    by _assert_master_confirmed_taxonomy only ever matching against the
    REQUESTING master's own MasterProfile.methods. THE SECOND HALF WAS
    FALSE. That match is by LABEL, and labels are not unique across
    masters: _scope_custom_methods_to_master deduplicates a new private row
    against global rows and this master's own and deliberately not against
    other masters' private ones. Two masters who both write "Сказкотерапия"
    own two rows with one label, and each could name the other's value --
    a practice pointing at a row its own master cannot see, and one that
    dies when the other master's row is deactivated. The label lookup is
    scoped now, and the gate tells "no row for you" apart from "no row at
    all"; see practices/service.py. Styles are never scoped
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
