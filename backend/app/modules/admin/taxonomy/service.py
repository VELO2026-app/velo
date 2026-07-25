# =============================================================================
# VELO Backend -- Admin Taxonomy Service (R5, batch R stage 2)
# =============================================================================
#
# CRUD over the DB-backed direction/style catalog (practice_directions /
# practice_styles). Governs MASTER METHODS (R5) and, since T2 (2026-07-15,
# practices/service.py: _validate_taxonomy()), practice-creation taxonomy too
# -- as a UNION with settings.practice_allowed_directions /
# practice_allowed_styles_by_direction, so a row added/edited/deactivated
# here now also affects what POST/PATCH /api/v1/practices accepts.
#
# list_taxonomy / create_* / update_* are admin-only (enforced in
# admin/taxonomy/router.py). list_active_taxonomy (R5 stage 3a) is the one
# exception -- it backs a non-admin-gated route in
# practices/taxonomy_router.py, reused from here rather than duplicated.
#
# Deactivation is a partial PATCH with is_active=false -- there is no
# hard-delete path (existing masters' stored methods strings must keep
# resolving against a retired direction/style).
# =============================================================================

from uuid import UUID

import structlog
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.audit import record_audit
from app.core.exceptions import BadRequestError, NotFoundError
from app.modules.admin.taxonomy.schemas import (
    CreateDirectionRequest,
    CreateStyleRequest,
    TaxonomyDirectionResponse,
    TaxonomyListResponse,
    TaxonomyStyleResponse,
    UpdateTaxonomyItemRequest,
)
from app.modules.practices.taxonomy_models import TaxonomyDirection, TaxonomyStyle
from app.modules.users.models import User

logger = structlog.get_logger()


async def list_taxonomy(session: AsyncSession) -> TaxonomyListResponse:
    """Full catalog: every direction (incl. inactive) with its styles.

    Admin management view -- unlike a public consumer, inactive rows stay
    visible so the admin can reactivate them.
    """
    stmt = (
        select(TaxonomyDirection)
        .options(selectinload(TaxonomyDirection.styles))
        .order_by(TaxonomyDirection.display_order)
    )
    directions = (await session.execute(stmt)).scalars().all()
    return TaxonomyListResponse(
        directions=[
            TaxonomyDirectionResponse.model_validate(d, from_attributes=True)
            for d in directions
        ]
    )


async def list_active_taxonomy(
    session: AsyncSession,
    *,
    master_id: UUID | None = None,
) -> TaxonomyListResponse:
    """Active-only catalog, for authenticated non-admin consumers (R5 stage 3a
    -- the master methods picker). An inactive direction is dropped entirely
    (its styles too); an active direction keeps only its active styles.

    master_id (T22-6, ПРОМТ №561): the requesting user's own id. A direction
    row scoped to a DIFFERENT master (or to no one, if master_id is None --
    e.g. a non-master user) is excluded -- global rows (master_id IS NULL)
    are always included regardless. This is the enforcement point for "a
    master-only custom method never appears in another master's picker":
    the row exists in the DB, but only its owner's fetch ever sees it.

    Reused by GET /api/v1/taxonomy (practices/taxonomy_router.py) -- that
    route lives outside the admin package (any authenticated user, not just
    admins, needs to read the active catalog) but imports this function
    directly rather than duplicating the query.
    """
    scope = (
        TaxonomyDirection.master_id.is_(None)
        if master_id is None
        else or_(
            TaxonomyDirection.master_id.is_(None),
            TaxonomyDirection.master_id == master_id,
        )
    )
    stmt = (
        select(TaxonomyDirection)
        .where(TaxonomyDirection.is_active.is_(True), scope)
        .options(selectinload(TaxonomyDirection.styles))
        .order_by(TaxonomyDirection.display_order)
    )
    directions = (await session.execute(stmt)).scalars().all()

    result: list[TaxonomyDirectionResponse] = []
    for d in directions:
        item = TaxonomyDirectionResponse.model_validate(d, from_attributes=True)
        item.styles = [
            TaxonomyStyleResponse.model_validate(s, from_attributes=True)
            for s in d.styles
            if s.is_active
        ]
        result.append(item)
    return TaxonomyListResponse(directions=result)


async def create_direction(
    body: CreateDirectionRequest,
    admin: User,
    session: AsyncSession,
) -> TaxonomyDirection:
    """Add a new direction. source='custom' (admin-added, not seeded).

    Unique on `value`; a duplicate -> 400 (mirrors the promo-code conflict
    pattern in admin/promos/service.py -- savepoint + IntegrityError catch).
    """
    direction = TaxonomyDirection(
        value=body.value,
        label=body.label,
        display_order=body.display_order,
        source="custom",
    )
    try:
        async with session.begin_nested():
            session.add(direction)
            await session.flush()
    except IntegrityError:
        raise BadRequestError(
            f"Direction '{body.value}' already exists"
        ) from None

    # `styles` is a lazy relationship, unloaded on a freshly created object --
    # TaxonomyDirectionResponse serializes it, and an implicit lazy load
    # during Pydantic validation crashes (MissingGreenlet) in async
    # SQLAlchemy. Explicitly load it now (resolves to [] for a brand new
    # direction) so the caller can safely model_validate the returned object.
    await session.refresh(direction, attribute_names=["styles"])

    await record_audit(
        event="taxonomy_direction_created",
        actor_id=admin.id,
        actor_type="admin",
        target_type="taxonomy_direction",
        target_id=direction.id,
        data={"value": body.value, "label": body.label},
        session=session,
    )
    logger.info(
        "taxonomy_direction_created",
        direction_id=str(direction.id),
        value=body.value,
        admin_id=str(admin.id),
    )
    return direction


async def create_style(
    direction_id: UUID,
    body: CreateStyleRequest,
    admin: User,
    session: AsyncSession,
) -> TaxonomyStyle:
    """Add a new style under a direction. source='custom'.

    404 if the direction doesn't exist. Unique on (direction_id, value); a
    duplicate under the same direction -> 400.
    """
    direction = await session.get(TaxonomyDirection, direction_id)
    if direction is None:
        raise NotFoundError("Direction not found")

    style = TaxonomyStyle(
        direction_id=direction_id,
        value=body.value,
        label=body.label,
        display_order=body.display_order,
        source="custom",
    )
    try:
        async with session.begin_nested():
            session.add(style)
            await session.flush()
    except IntegrityError:
        raise BadRequestError(
            f"Style '{body.value}' already exists under this direction"
        ) from None

    await record_audit(
        event="taxonomy_style_created",
        actor_id=admin.id,
        actor_type="admin",
        target_type="taxonomy_style",
        target_id=style.id,
        data={"direction_id": str(direction_id), "value": body.value, "label": body.label},
        session=session,
    )
    logger.info(
        "taxonomy_style_created",
        style_id=str(style.id),
        direction_id=str(direction_id),
        value=body.value,
        admin_id=str(admin.id),
    )
    return style


async def update_direction(
    direction_id: UUID,
    body: UpdateTaxonomyItemRequest,
    admin: User,
    session: AsyncSession,
) -> TaxonomyDirection:
    """Partial update (label / display_order / is_active). 404 if missing."""
    direction = await session.get(TaxonomyDirection, direction_id)
    if direction is None:
        raise NotFoundError("Direction not found")

    changes = body.model_dump(exclude_unset=True)
    for field, value in changes.items():
        setattr(direction, field, value)
    await session.flush()

    # Same lazy-load trap as create_direction -- `styles` may not be loaded
    # on this object (e.g. it was fetched via session.get(), which does not
    # eager-load relationships), and TaxonomyDirectionResponse serializes it.
    await session.refresh(direction, attribute_names=["styles"])

    await record_audit(
        event="taxonomy_direction_updated",
        actor_id=admin.id,
        actor_type="admin",
        target_type="taxonomy_direction",
        target_id=direction.id,
        data=changes,
        session=session,
    )
    logger.info(
        "taxonomy_direction_updated",
        direction_id=str(direction_id),
        changes=changes,
        admin_id=str(admin.id),
    )
    return direction


async def update_style(
    style_id: UUID,
    body: UpdateTaxonomyItemRequest,
    admin: User,
    session: AsyncSession,
) -> TaxonomyStyle:
    """Partial update (label / display_order / is_active). 404 if missing."""
    style = await session.get(TaxonomyStyle, style_id)
    if style is None:
        raise NotFoundError("Style not found")

    changes = body.model_dump(exclude_unset=True)
    for field, value in changes.items():
        setattr(style, field, value)
    await session.flush()

    await record_audit(
        event="taxonomy_style_updated",
        actor_id=admin.id,
        actor_type="admin",
        target_type="taxonomy_style",
        target_id=style.id,
        data=changes,
        session=session,
    )
    logger.info(
        "taxonomy_style_updated",
        style_id=str(style_id),
        changes=changes,
        admin_id=str(admin.id),
    )
    return style
