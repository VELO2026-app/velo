# =============================================================================
# VELO Backend -- Practice Service (Phase 4.2 + 4.3/4.4, updated Phase 6.5,
#                                   updated Frontend F3 prep, + Calendar taxonomy)
# =============================================================================
#
# Business logic for practice CRUD (master-facing) and public listing.
#
# MASTER_NAME / MASTER_METHODS (Frontend F3 prep, DS-sprint):
#   practice_to_response() builds PracticeResponse with master_name and
#   master_methods. master_name is the full "First Last" name, built by
#   master_full_name() from User.first_name + User.last_name in every JOIN /
#   mutation path (MVP rule: Telegram name, surname appended only if present).
#   master_methods come from MasterProfile.data via OUTER JOIN; get_practice()
#   outer-joins MasterProfile to return methods. If MasterProfile is missing,
#   master_methods defaults to [].
#   List functions pass master_methods=[] (methods not shown in list cards).
#
# CALENDAR TAXONOMY (Calendar iteration):
#   direction / style / difficulty are catalog facets stored in the
#   Practice.data JSONB sandbox under data.taxonomy (schema-on-read). They
#   are NOT columns:
#     - create_practice() writes them into data.taxonomy via set_jsonb().
#     - update_practice() handles them in a SEPARATE JSONB branch -- they are
#       pulled out of update_data BEFORE the setattr() loop, otherwise
#       setattr(practice, "direction", ...) would create a dead Python
#       attribute that never reaches the DB (same trap as onboarding_completed
#       in users/service.py).
#     - practice_to_response() extracts them back out for the API response.
#   JSONB SAFETY: always deepcopy + set_jsonb("data", ...). Never mutate
#   practice.data in place (SQLAlchemy would miss the change).
#
# OWNERSHIP:
#   All mutating operations (update, delete, cancel) verify master_id == user.id.
#   Non-owners receive 404 (P-08: do not reveal resource existence).
#   get_practice() applies visibility rules: draft/deleted only for owner.
#
# STATE MACHINE:
#   draft          -> scheduled, deleted   (via PATCH)
#   scheduled      -> live                  (auto, by schedule -- NOT via PATCH)
#   scheduled/live -> completed             (auto, by schedule -- NOT via PATCH)
#   completed      -> (terminal)
#   cancelled      -> (terminal)
#   deleted        -> (terminal)
#
# IMPORTANT (Phase 6.5):
#   scheduled -> cancelled and live -> cancelled are NOT allowed via PATCH.
#   The ONLY path to cancelled is through cancel_practice() which handles
#   refunds for all active bookings.
#
# IMPORTANT (Batch 1 -- lifecycle automation):
#   scheduled -> live and live -> completed are NO LONGER allowed via PATCH
#   either. Both are performed by the background lifecycle worker
#   (bookings/autofinalize.py) as the system, driven by the clock:
#     start:  scheduled -> live      once scheduled_at passes;
#     finish: scheduled/live -> completed once scheduled_at + duration passes
#             (auto_finalize_practice runs the full settlement core).
#   So PATCH only ever drives draft -> scheduled (publish) and draft -> deleted.
#
# PRICING (Phase 4.3/4.4):
#   is_free=True  -> price_cents forced to 0 (service overrides any value)
#   is_free=False -> price_cents must be > 0 (service raises 400)
#
# CONCURRENCY:
#   update_practice(), delete_practice(), and cancel_practice() use
#   with_for_update() (P-12) to prevent lost updates on status transitions.
#
# DELETE vs CANCEL:
#   DELETE sets status=deleted (only from draft).
#   CANCEL sets status=cancelled + refunds all bookings (Phase 6.5).
#
# SESSION RULES:
#   No session.commit() here (P-01). Router handles flush + refresh.
# =============================================================================

import copy
from datetime import UTC, datetime, timedelta
from uuid import UUID

import structlog
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import (
    BadRequestError,
    NotFoundError,
)
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.practices.enrichment_service import (
    attendance_counts_for_practices,
    attendance_counts_kwargs,
    series_meta_for_practices,
    series_meta_kwargs,
)
from app.modules.practices.models import (
    AudienceKind,
    Practice,
    PracticeAudienceGroup,
    PracticeStatus,
    PracticeType,
)
from app.modules.practices.schemas import (
    CreatePracticeRequest,
    PracticeResponse,
    UpdatePracticeRequest,
)
from app.modules.practices.series_service import generate_series_occurrences
from app.modules.practices.taxonomy_models import TaxonomyDirection, TaxonomyStyle
from app.modules.masters.groups_models import MasterGroup
from app.modules.masters.models import MasterProfile
from app.modules.users.models import User

logger = structlog.get_logger()

# Statuses visible to any authenticated user.
_PUBLIC_STATUSES = {
    PracticeStatus.SCHEDULED.value,
    PracticeStatus.LIVE.value,
    PracticeStatus.COMPLETED.value,
    PracticeStatus.CANCELLED.value,
}

# Valid state transitions via PATCH. Terminal states (and states whose only
# remaining transitions are automated) have no outgoing edges here.
# Phase 6.5: cancelled is removed -- the ONLY way to reach cancelled is via
# cancel_practice() which handles refunds, preventing an accidental PATCH
# status=cancelled that would skip refund logic.
# Batch 1: scheduled -> live and live -> completed are removed too -- both are
# driven by the clock by the lifecycle worker (bookings/autofinalize.py:
# auto_start_practice / auto_finalize_practice) as the system, not by PATCH.
# So the ONLY PATCH-driven transitions left are draft -> scheduled (publish)
# and draft -> deleted.
_VALID_TRANSITIONS: dict[str, set[str]] = {
    PracticeStatus.DRAFT.value: {
        PracticeStatus.SCHEDULED.value,
        PracticeStatus.DELETED.value,
    },
}

# NOT NULL columns that cannot be set to None via PATCH (P-02).
_NOT_NULL_FIELDS = {
    "title",
    "scheduled_at",
    "duration_minutes",
    "timezone",
    "is_free",
    "price_cents",
    "currency",
}

# Booking statuses that count as "active" for the price-change guard.
_ACTIVE_BOOKING_STATUSES = {
    BookingStatus.PENDING.value,
    BookingStatus.CONFIRMED.value,
}

# Booking statuses that mark a practice as "booked" for the requesting user
# in feed/detail responses (is_booked). Includes ATTENDED so a practice the
# user already attended still shows as theirs. Cancelled/no_show excluded.
_BOOKED_STATUSES = {
    BookingStatus.PENDING.value,
    BookingStatus.CONFIRMED.value,
    BookingStatus.ATTENDED.value,
}

# Booking statuses that grant a user access to the practice's zoom_link
# (M-3 access gate). STRICTER than _BOOKED_STATUSES above: a PENDING booking
# does NOT unlock the link -- only CONFIRMED or ATTENDED does. Used by
# get_practice_detail here and imported by GET /bookings/me to gate zoom_link;
# every other response leaves it None (see the PracticeResponse / PracticeSummary
# zoom_link validators).
ZOOM_VISIBLE_BOOKING_STATUSES = {
    BookingStatus.CONFIRMED.value,
    BookingStatus.ATTENDED.value,
}

# Calendar taxonomy facets -- stored in Practice.data.taxonomy (JSONB),
# NOT as columns. Handled separately from setattr-based column updates.
_TAXONOMY_FIELDS = ("direction", "style", "difficulty")


# ===================================================================
# Helpers
# ===================================================================


async def _owned_group_ids_or_400(
    master_id: UUID, group_ids: list[UUID], session: AsyncSession,
) -> None:
    """Validate every group_id in a create/update audience payload belongs
    to a CUSTOM group owned by master_id (Master GROUPS P5, ПРОМТ №594).

    Rejects another master's group, an unknown id, or a system slug (which
    never resolves to a real MasterGroup row in the first place) with a
    single 400 -- P-08 does not apply here (the master is choosing among
    THEIR OWN resources, not probing another's).
    """
    if not group_ids:
        return
    owned = (
        await session.execute(
            select(MasterGroup.id).where(
                MasterGroup.id.in_(group_ids), MasterGroup.master_id == master_id,
            )
        )
    ).scalars().all()
    if set(owned) != set(group_ids):
        raise BadRequestError(
            "group_ids must be your own custom groups"
        )


async def _set_practice_audience_groups(
    practice_id: UUID, group_ids: list[UUID], session: AsyncSession,
) -> None:
    """REPLACE the practice's full target-group set with group_ids
    (delete-then-insert -- these are small sets, no need for a diff)."""
    await session.execute(
        delete(PracticeAudienceGroup).where(
            PracticeAudienceGroup.practice_id == practice_id,
        )
    )
    for group_id in group_ids:
        session.add(
            PracticeAudienceGroup(practice_id=practice_id, group_id=group_id)
        )
    await session.flush()


async def group_names_for_practice(
    practice: Practice, session: AsyncSession,
) -> list[str]:
    """PracticeResponse.audience_group_names -- the practice's target
    CUSTOM groups' names, alphabetical. Empty for anything but
    audience_kind='groups' (nothing to look up). Public (like
    user_flags_for_practices / series_meta_for_practices) -- called from
    both this module (get_practice_detail) and router.py (create/update
    endpoints' owner-facing responses)."""
    if practice.audience_kind != AudienceKind.GROUPS.value:
        return []
    stmt = (
        select(MasterGroup.name)
        .join(
            PracticeAudienceGroup,
            PracticeAudienceGroup.group_id == MasterGroup.id,
        )
        .where(PracticeAudienceGroup.practice_id == practice.id)
        .order_by(MasterGroup.name)
    )
    return list((await session.execute(stmt)).scalars().all())


def _enforce_pricing(
    is_free: bool,
    price_cents: int,
) -> int:
    """Enforce pricing invariant.

    is_free=True  -> return 0 (override any client value).
    is_free=False -> price_cents must be > 0, else raise 400.
    """
    if is_free:
        return 0
    if price_cents <= 0:
        raise BadRequestError(
            "price_cents must be > 0 for paid practices"
        )
    return price_cents


def _build_taxonomy(
    direction: str,
    difficulty: str,
    style: str | None,
) -> dict:
    """Build the data.taxonomy dict for a practice.

    Calendar facets: direction + difficulty are required on create;
    style is optional (None when not provided).
    """
    return {
        "direction": direction,
        "difficulty": difficulty,
        "style": style,
    }


# ===================================================================
# Taxonomy union validation (T2, 2026-07-15)
# ===================================================================
#
# direction / style are valid if they're in config OR the active DB catalog
# (practice_directions / practice_styles) -- UNION, never replace (operator
# decision): the catalog was seeded 1:1 from this same config, so today both
# give identical results, but union can never reject a config-valid value
# while a replace could. Each VALUE is checked against config FIRST,
# unconditionally -- a config hit returns valid without touching the DB at
# all, so a broken/empty catalog can never affect a config-valid create/
# update. Only on a config MISS is the catalog queried, and that query is
# wrapped so ANY read error degrades to "not found" rather than propagating
# -- the only thing an outage can cost is a catalog-only value. Only ACTIVE
# catalog rows count, matching GET /api/v1/taxonomy's own contract.
# difficulty has no catalog table and is validated in schemas.py, unchanged.


async def _direction_in_catalog(
    direction: str,
    session: AsyncSession,
) -> bool:
    """Active-catalog fallback for direction membership (config already missed)."""
    try:
        stmt = select(TaxonomyDirection.id).where(
            TaxonomyDirection.value == direction,
            TaxonomyDirection.is_active.is_(True),
        )
        result = await session.execute(stmt)
        return result.scalar_one_or_none() is not None
    except Exception:
        logger.warning(
            "taxonomy_catalog_direction_read_failed", direction=direction,
        )
        return False


async def _catalog_styles_for_direction(
    direction: str,
    session: AsyncSession,
) -> set[str]:
    """Active catalog style values under one active direction."""
    try:
        stmt = (
            select(TaxonomyStyle.value)
            .join(
                TaxonomyDirection,
                TaxonomyStyle.direction_id == TaxonomyDirection.id,
            )
            .where(
                TaxonomyDirection.value == direction,
                TaxonomyDirection.is_active.is_(True),
                TaxonomyStyle.is_active.is_(True),
            )
        )
        result = await session.execute(stmt)
        return set(result.scalars().all())
    except Exception:
        logger.warning(
            "taxonomy_catalog_style_read_failed", direction=direction,
        )
        return set()


async def _validate_style_choice(
    direction: str | None,
    style: str | None,
    session: AsyncSession,
) -> None:
    """Validate style membership for an ALREADY-valid direction (union).

    Does not re-check direction membership -- callers use this either for a
    direction just validated by _validate_taxonomy(), or for a practice's
    STORED direction (accepted back when the practice was created/last set).
    """
    if style is None:
        return
    config_styles = settings.practice_allowed_styles_by_direction.get(
        direction, (),
    )
    if style in config_styles:
        return
    catalog_styles = await _catalog_styles_for_direction(direction, session)
    if style in catalog_styles:
        return
    allowed = sorted(set(config_styles) | catalog_styles)
    if allowed:
        raise BadRequestError(
            f"style for direction '{direction}' must be one of {allowed}, "
            f"got '{style}'"
        )
    raise BadRequestError(
        f"direction '{direction}' does not admit a style; got '{style}'"
    )


async def _validate_taxonomy(
    direction: str,
    style: str | None,
    session: AsyncSession,
) -> None:
    """Validate a direction + optional style pair against the GLOBAL union
    (config + active catalog). Deliberately does NOT check whether the
    CALLING MASTER is confirmed for this direction/style -- that is a
    separate, narrower question (see _assert_master_confirmed_taxonomy
    below), checked explicitly at each call site that has a `user` to check
    against. Kept separate rather than folded in here so this function keeps
    its existing, reusable "is this a real taxonomy value at all" meaning
    (master onboarding's own picker legitimately needs the unfiltered
    catalog, and must never route through the master-confirmation check --
    T21-6, ПРОМТ №546)."""
    if direction not in settings.practice_allowed_directions:
        if not await _direction_in_catalog(direction, session):
            raise BadRequestError(
                f"direction must be one of "
                f"{settings.practice_allowed_directions}, got '{direction}'"
            )
    await _validate_style_choice(direction, style, session)


# T21-6 (ПРОМТ №546): flat "Направление — Вид" join, byte-for-byte identical
# to the frontend's methodTaxonomy.ts SEP -- MasterProfile.data.profile.
# methods is a list of these frozen strings (see admin/masters/service.py's
# approve_method_change, which copies proposed_methods verbatim with no
# server-side value<->label resolution at all until now).
_METHOD_LABEL_SEP = " — "


async def _label_for_direction_value(
    direction: str,
    session: AsyncSession,
) -> str | None:
    """Current active-catalog label for a direction value, or None if it
    isn't (or is no longer) an active catalog row."""
    stmt = select(TaxonomyDirection.label).where(
        TaxonomyDirection.value == direction,
        TaxonomyDirection.is_active.is_(True),
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def _label_for_style_value(
    direction: str,
    style: str,
    session: AsyncSession,
) -> str | None:
    """Current active-catalog label for a style value under a direction, or
    None if it isn't (or is no longer) an active catalog row."""
    stmt = (
        select(TaxonomyStyle.label)
        .join(TaxonomyDirection, TaxonomyStyle.direction_id == TaxonomyDirection.id)
        .where(
            TaxonomyDirection.value == direction,
            TaxonomyDirection.is_active.is_(True),
            TaxonomyStyle.value == style,
            TaxonomyStyle.is_active.is_(True),
        )
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def _assert_master_confirmed_taxonomy(
    master_id: UUID,
    direction: str,
    style: str | None,
    session: AsyncSession,
) -> None:
    """Reject a direction/style the calling master has not been CONFIRMED
    for (T21-6). Confirmed = MasterProfile.data.profile.methods -- the live
    field, overwritten only on admin approval (approve_method_change).
    Deliberately does NOT read method_change_request.proposed_methods: a
    pending, unapproved request must never unlock a practice in that
    direction, or the "up to 3 working days" review the UI advertises would
    mean nothing.

    FAILS OPEN (does not restrict) when the master's confirmed methods list
    is EMPTY -- not a loophole, a reflection of reality: a real verified
    master always has at least one confirmed method (masters/schemas.py's
    MasterApplicationRequest requires min_length=1 at application time), so
    an empty list here means either a test fixture that never set up
    profile.methods at all, or a data state that should not be reachable in
    production. Restricting THAT case would be enforcing a rule against
    data that predates the rule, not the rule itself.

    STORED FORMAT IS MIXED (T21-7, ПРОМТ №547, MEASURED on prod): a method
    entry is a frozen catalog LABEL ("Йога — Кундалини-йога") when it was
    written by the wizard (flattenMethods/approve_method_change), but a raw
    catalog VALUE ("yoga") when it was written directly against the API --
    every seed-based master, ~30 backend test fixtures, and at least one live
    prod master (no wizard round-trip ever touched their profile) all store
    values, not labels. The original label-only check treated every entry as
    a label, so it rejected every real, correctly-confirmed direction a
    value-stored master holds.

    Canonical form = VALUE, not label: `direction`/`style` here are ALREADY
    values (the wire format for practice taxonomy), labels are just a
    renamable display string with no version pin, and a value-stored entry
    (the common case: raw seed/API data) needs zero catalog round-trip to
    compare -- only a label-stored entry needs one reverse lookup (label ->
    is this the CURRENT label for the direction/style being requested?).
    So each stored entry is compared against BOTH representations of the
    SAME requested (direction, style): the raw value, and -- if the
    requested direction/style currently has an active catalog row -- its
    current label. Mirrors the frontend's parseMethods split (same SEP,
    same "both halves must resolve" rule for a composite entry) but compares
    toward values instead of building a label to search for, which also
    sidesteps parseMethods' label-drift limitation on this comparison (we
    never resolve a STORED label into a value; we only ever check whether it
    still equals the CURRENT label of the specific direction/style being
    requested).

    A composite entry ("Направление — Вид") is confirmation for that EXACT
    style only -- it does NOT also confirm the bare parent direction (no
    style), and a bare-direction entry does NOT confirm any specific style
    under it. Deliberate, unchanged from before this fix, and matches
    CreatePracticeView.vue's confirmedMethods filter (directionOptions/
    styleOptionsForForm), which already documents and relies on this same
    strict split.

    A STORED entry that resolves to nothing recognizable (neither half
    matches the requested value or label representation -- a stale/custom
    entry, or one written against a since-deactivated/renamed catalog row)
    simply confirms nothing: it is skipped, not an error, and does not by
    itself cause a reject -- the request is rejected only if NO entry in the
    whole list confirms it. If the REQUESTED direction itself has no active
    catalog row at all (dir_label is None below), this still fails OPEN
    exactly as before this fix -- unrelated to the mixed-format bug and
    deliberately not touched here (out of scope for T21-7; see the fail-open
    branch below for the original rationale).
    """
    profile = (
        await session.execute(
            select(MasterProfile).where(MasterProfile.user_id == master_id)
        )
    ).scalar_one_or_none()
    methods: list[str] = (
        (profile.data or {}).get("profile", {}).get("methods", [])
        if profile
        else []
    )
    if not methods:
        return

    dir_label = await _label_for_direction_value(direction, session)
    if dir_label is None:
        # Not an active catalog row at all -- _validate_taxonomy already
        # accepted it via the config-only allow-list (a seed direction with
        # no catalog row). Every direction in today's config is in fact
        # mirrored into the catalog as an active row (R5 seed migration), so
        # this only fires if a direction is later deactivated -- a separate,
        # pre-existing gap (not introduced or widened by T21-7). Nothing to
        # resolve a label-side match against; let the config-level
        # validation's own verdict stand rather than raising a second,
        # redundant error here.
        return
    style_label = (
        await _label_for_style_value(direction, style, session)
        if style is not None
        else None
    )

    for raw in methods:
        sep_idx = raw.find(_METHOD_LABEL_SEP)
        entry_dir = raw if sep_idx == -1 else raw[:sep_idx]
        entry_style = None if sep_idx == -1 else raw[sep_idx + len(_METHOD_LABEL_SEP):]

        if (entry_style is None) != (style is None):
            continue  # bare vs composite -- never cross-confirm (see above).
        if entry_dir != direction and entry_dir != dir_label:
            continue
        if style is None or entry_style == style or (
            style_label is not None and entry_style == style_label
        ):
            return

    if style is None:
        raise BadRequestError(
            f"direction '{direction}' is not among your confirmed methods",
            code="direction_not_confirmed",
        )
    raise BadRequestError(
        f"style '{style}' for direction '{direction}' is not among your "
        f"confirmed methods",
        code="style_not_confirmed",
    )


async def _has_active_bookings(
    practice_id: UUID,
    session: AsyncSession,
) -> bool:
    """Check if a practice has any active (pending/confirmed) bookings.

    CQ-05: used to prevent price changes on practices that already
    have participants who paid the original price.
    """
    stmt = (
        select(func.count(Booking.id))
        .where(
            Booking.practice_id == practice_id,
            Booking.status.in_(_ACTIVE_BOOKING_STATUSES),
        )
    )
    result = await session.execute(stmt)
    return result.scalar_one() > 0


def master_full_name(
    first_name: str | None,
    last_name: str | None,
) -> str:
    """Build the master's display name as "First Last".

    MVP rule (mirrors the frontend masterDisplayName helper): always use the
    Telegram first_name + last_name, ignoring MasterProfile.display_name.
    Telegram guarantees first_name but last_name is optional, so the surname
    is appended only when present; if both are empty we fall back to "Мастер".
    Empty parts are filtered out so there is no trailing space or "None".
    """
    parts = [p for p in (first_name, last_name) if p]
    return " ".join(parts) if parts else "Мастер"


def practice_to_response(
    practice: Practice,
    master_name: str | None = None,
    master_methods: list[str] | None = None,
    *,
    master_avatar_url: str | None = None,
    is_booked: bool = False,
    is_paid: bool = False,
    recurrence_days: list[int] | None = None,
    total_sessions: int | None = None,
    completed_sessions: int | None = None,
    checkin_count: int | None = None,
    attended: int | None = None,
    no_show: int | None = None,
    zoom_link_visible: bool = False,
    zoom_host_join_url: str | None = None,
    zoom_meeting_status: str | None = None,
    deduplicated: bool = False,
    audience_group_names: list[str] | None = None,
) -> PracticeResponse:
    """Build PracticeResponse from ORM object with master_name and master_methods.

    master_name:       full "First Last" built via master_full_name() from the
                       User row in the JOIN (or the mutation's User object).
    master_methods:    MasterProfile.data.profile.methods from outer join in
                       get_practice(). List endpoints pass [] (not shown on cards).
    master_avatar_url: User.avatar_url from JOIN in get_practice() (detail only).
                       List endpoints leave it None -- avatars are not shown on
                       feed cards (V3: feed is untouched).

    Calendar taxonomy (direction / style / difficulty) is extracted from
    practice.data.taxonomy. Missing keys (e.g. practices created before the
    Calendar iteration, whose data sandbox is empty) resolve to None.
    """
    resp = PracticeResponse.model_validate(practice)
    resp.master_name = master_name
    resp.master_avatar_url = master_avatar_url
    resp.master_methods = master_methods or []

    taxonomy = (practice.data or {}).get("taxonomy", {})
    resp.direction = taxonomy.get("direction")
    resp.style = taxonomy.get("style")
    resp.difficulty = taxonomy.get("difficulty")

    # Per-user state for the requesting user (default False -- see schema).
    resp.is_booked = is_booked
    resp.is_paid = is_paid

    # Series card meta (E3 batch 2). None unless the caller resolved it for a
    # series-with-spec; the public feed leaves all three None.
    resp.recurrence_days = recurrence_days
    resp.total_sessions = total_sessions
    resp.completed_sessions = completed_sessions

    # Attendance / check-in counts (E12 + aggregate). None unless the caller
    # resolved them for an owner-facing view (master list / owner detail); the
    # public feed and a non-owner's detail leave all three None.
    resp.checkin_count = checkin_count
    resp.attended = attended
    resp.no_show = no_show

    # zoom_link (M-3 access gate). model_validate auto-populated the real ORM
    # link; expose it ONLY when the caller authorized it (the practice owner,
    # or a requester with a confirmed/attended booking -- see
    # get_practice_detail), otherwise null it explicitly. This gate lives here,
    # not in a schema model_validator: FastAPI re-validates the response and
    # would re-run such a validator, wiping the value set here.
    resp.zoom_link = practice.zoom_link if zoom_link_visible else None

    # T21-1: host join_url -- caller decides whether to fetch/pass it (owner-
    # facing responses only); everyone else gets the schema default (None).
    resp.zoom_host_join_url = zoom_host_join_url

    # A4 V2 (ПРОМТ №572): NOT owner-gated, unlike zoom_host_join_url above --
    # see the schema field's own docstring for why.
    resp.zoom_meeting_status = zoom_meeting_status

    # A4 V6 (ПРОМТ №572): True only on create_practice's two dedup-return
    # paths (see that function's own docstring). Every other caller of this
    # builder (update/delete/cancel/list/detail) leaves the schema default
    # (False) -- deduplication is a CREATE-time concept only.
    resp.deduplicated = deduplicated

    # audience_kind is picked up automatically via from_attributes (matches
    # the ORM column name 1:1). audience_group_names has no ORM attribute --
    # the caller resolves it (async, via _group_names_for_practice) and
    # passes it through; every caller that doesn't leaves the schema
    # default ([]).
    if audience_group_names is not None:
        resp.audience_group_names = audience_group_names

    return resp


async def user_flags_for_practices(
    user_id: UUID,
    practice_ids: list[UUID],
    session: AsyncSession,
) -> dict[UUID, tuple[bool, bool]]:
    """Map practice_id -> (is_booked, is_paid) for the given user.

    One query over the user's bookings restricted to practice_ids on the
    current page (uses ix_bookings_user_id), joined to Practice for the price.

    is_booked -- the user has a booking in _BOOKED_STATUSES for the practice.
    is_paid   -- is_booked AND the practice is paid (price_cents > 0).
                 Definition note: a Booking always carries a purchase_id (even
                 free practices create a zero-amount Purchase), so purchase
                 presence is NOT a paid signal. "Paid" here means the user
                 holds a booking on a priced practice -- this drives the
                 "Оплачено" vs "Бесплатно" badge in the Calendar.

    Practices with no booking for this user are simply absent from the
    map -> caller treats them as (False, False).
    """
    if not practice_ids:
        return {}

    stmt = select(
        Booking.practice_id,
        Practice.price_cents,
    ).join(
        Practice, Booking.practice_id == Practice.id,
    ).where(
        Booking.user_id == user_id,
        Booking.practice_id.in_(practice_ids),
        Booking.status.in_(_BOOKED_STATUSES),
    )
    result = await session.execute(stmt)

    flags: dict[UUID, tuple[bool, bool]] = {}
    for practice_id, price_cents in result.all():
        flags[practice_id] = (True, price_cents > 0)
    return flags


# ===================================================================
# CRUD
# ===================================================================


async def _find_duplicate_practice(
    user_id: UUID,
    body: CreatePracticeRequest,
    session: AsyncSession,
    *,
    since: datetime | None,
) -> Practice | None:
    """Shared match logic behind _find_recent_duplicate_practice (the
    pre-insert, WINDOWED check below) and create_practice's post-race
    lookup (A4 V7, since=None -- called only after losing the INSERT race
    to uq_practice_master_title_scheduled_recurrence, where a matching row
    is now guaranteed to exist regardless of when it was created, so no
    window applies).

    Match key: (master_id, title, scheduled_at, recurrence). Compared in
    Python (not a JSONB query) since recurrence needs a value-equality
    check against a Pydantic model, not a string match.
    """
    stmt = select(Practice).where(
        Practice.master_id == user_id,
        Practice.title == body.title,
        Practice.scheduled_at == body.scheduled_at,
        Practice.status != PracticeStatus.DELETED.value,
    )
    if since is not None:
        stmt = stmt.where(Practice.created_at >= since)
    candidates = (
        await session.execute(stmt.order_by(Practice.created_at.desc()))
    ).scalars().all()

    incoming_recurrence = (
        body.recurrence.model_dump(mode="json") if body.recurrence is not None else None
    )
    for candidate in candidates:
        stored_recurrence = (candidate.data or {}).get("recurrence")
        if stored_recurrence == incoming_recurrence:
            return candidate
    return None


async def _find_recent_duplicate_practice(
    user_id: UUID,
    body: CreatePracticeRequest,
    session: AsyncSession,
) -> Practice | None:
    """ПРОМТ №559 idempotency check: a non-deleted practice this SAME master
    created within the last practice_duplicate_submit_window_minutes, with
    the identical title, scheduled_at, AND recurrence spec, is treated as
    the master's earlier submission having already gone through -- not a
    fresh, different practice.

    MEASURED root cause (ПРОМТ №559): a series publish makes one Zoom API
    call per occurrence, sequentially, inside one request; the frontend's
    own 15s AbortController gives up well before a ~29-occurrence series
    finishes, the master sees a timeout, and presses the button again --
    creating a full duplicate series, not a cosmetic double-click. Since
    (child creation is now deferred to the poller and) the ROOT publish is
    the only synchronous Zoom call left, THIS check, at create_practice
    time, is early enough to prevent the duplicate before any of that work
    starts.

    A4 V7: this SELECT-then-INSERT shape is TOCTOU-safe only up to the
    point of the actual insert -- two genuinely CONCURRENT requests (double-
    tap, two tabs) both run this SELECT before either commits, so both see
    nothing and both proceed to insert. create_practice below closes that
    gap at the DB level (uq_practice_master_title_scheduled_recurrence),
    same pattern as ensure_host_registrant (zoom/service.py, ПРОМТ №525).
    This windowed check remains the fast, common-case path (a retry inside
    the window returns immediately, no INSERT attempted at all); the DB
    constraint is the backstop for the race this check cannot see.

    Match key is (master_id, title, scheduled_at, recurrence) -- exactly
    what the owner specified.

    DOES NOT COVER:
      - Two GENUINELY separate series/practices with an identical title,
        an identical scheduled_at (to the second), and identical recurrence,
        submitted deliberately within the window -- silently merged into
        one. Considered acceptable: two real submissions matching on all
        three fields to the SECOND is a scenario indistinguishable from a
        retry by any server-side signal available here.
      - A retry more than window-minutes after the original -- intentional;
        a stale window would block a master who genuinely re-creates the
        same series hours or days later.
      - Any resource other than Practice (bookings, purchases, etc.).
      - A client whose retry recomputes scheduled_at slightly differently
        between attempts (e.g. from a fresh "now + offset" instead of a
        fixed picked date/time) -- the match is exact, not fuzzy.
    """
    window_start = datetime.now(UTC) - timedelta(
        minutes=settings.practice_duplicate_submit_window_minutes,
    )
    return await _find_duplicate_practice(user_id, body, session, since=window_start)


async def create_practice(
    user: User,
    body: CreatePracticeRequest,
    session: AsyncSession,
) -> tuple[Practice, bool]:
    """Create a new practice in draft status.

    Returns (practice, deduplicated) -- A4 V6 (ПРОМТ №572): deduplicated is
    True on EITHER return-the-existing-practice path below (the window
    check or the post-race lookup), False on a genuine new insert. Before
    this, both paths returned a bare Practice indistinguishable from a
    freshly created one -- the caller (create_practice_endpoint) had no way
    to tell the master "this is your EARLIER submission, not a new one",
    so a second click after a timeout, or the losing side of a genuine
    concurrent double-submit (A4 V7), silently looked like success with no
    signal that nothing new was actually created.

    Calendar taxonomy (direction / difficulty / style) is written into the
    data.taxonomy JSONB sandbox via set_jsonb() -- direction and difficulty
    are required by the schema, style is optional. direction/style membership
    (T2, 2026-07-15) is validated here against the config+catalog union --
    difficulty stays schema-validated (config only, no catalog table).

    T21-6 (ПРОМТ №546): ALSO validated against the calling master's own
    CONFIRMED methods (_assert_master_confirmed_taxonomy) -- a master may
    only create a practice in a direction/style their profile has been
    approved for. This is separate from the global catalog check above and
    does not apply anywhere master onboarding picks methods (a different
    endpoint entirely, which correctly shows the unfiltered catalogue).

    ПРОМТ №559: returns the EXISTING practice, unchanged, instead of
    creating a new one, if _find_recent_duplicate_practice finds a match --
    see that function's docstring for exactly what this does and does not
    cover. No new validation runs in that case; there is nothing new to
    validate.

    A4 V7: the window check above is a fast-path optimization, not the
    actual guarantee -- uq_practice_master_title_scheduled_recurrence (see
    the practices table migration) is what excludes two concurrent
    requests for the same (master, title, scheduled_at, recurrence) at the
    DB level. The insert below runs inside session.begin_nested() (a
    SAVEPOINT) for the same reason as ensure_host_registrant (zoom/
    service.py, ПРОМТ №525): a plain try/except around the flush is not
    enough by itself to keep the CALLER's own transaction usable after a
    database-level abort (PendingRollbackError) -- something has to roll
    back TO. On IntegrityError, the race was LOST: look up the winning row
    (unwindowed -- it is guaranteed to exist and match exactly) and return
    it, exactly like the window check's own duplicate-return path.
    """
    duplicate = await _find_recent_duplicate_practice(user.id, body, session)
    if duplicate is not None:
        logger.info(
            "practice_create_deduplicated",
            master_id=str(user.id),
            existing_practice_id=str(duplicate.id),
            title=body.title,
        )
        return duplicate, True

    await _validate_taxonomy(body.direction, body.style, session)
    await _assert_master_confirmed_taxonomy(user.id, body.direction, body.style, session)
    price_cents = _enforce_pricing(body.is_free, body.price_cents)
    # P5 (ПРОМТ №594): reject a group_id that isn't one of THIS master's own
    # custom groups (another master's group, an unknown id, or a system
    # slug) before anything is inserted.
    await _owned_group_ids_or_400(user.id, body.group_ids, session)

    practice = Practice(
        master_id=user.id,
        practice_type=body.practice_type,
        title=body.title,
        description=body.description,
        what_to_prepare=body.what_to_prepare,
        contraindications=body.contraindications,
        scheduled_at=body.scheduled_at,
        duration_minutes=body.duration_minutes,
        timezone=body.timezone,
        max_participants=body.max_participants,
        zoom_link=body.zoom_link,
        parent_practice_id=body.parent_practice_id,
        is_free=body.is_free,
        price_cents=price_cents,
        currency=body.currency,
        audience_kind=body.audience_kind,
    )

    # Calendar taxonomy -> data.taxonomy (JSONB sandbox).
    # set_jsonb() flags the column modified so SQLAlchemy emits the write;
    # a fresh dict is safe to assign on a not-yet-persisted object.
    data: dict = {
        "taxonomy": _build_taxonomy(
            body.direction, body.difficulty, body.style,
        ),
    }
    # E3: persist the recurrence spec on the series root (schema-on-read, the
    # same JSONB sandbox as taxonomy). Stored as plain JSON (dates -> ISO
    # strings via mode="json") so it round-trips through JSONB; generation
    # parses it back on publication. A series practice without a spec omits the
    # key entirely, and generation no-ops for it.
    if body.recurrence is not None:
        data["recurrence"] = body.recurrence.model_dump(mode="json")
    practice.set_jsonb("data", data)

    try:
        async with session.begin_nested():
            session.add(practice)
            await session.flush()
    except IntegrityError:
        winner = await _find_duplicate_practice(user.id, body, session, since=None)
        if winner is not None:
            logger.info(
                "practice_create_race_lost",
                master_id=str(user.id),
                existing_practice_id=str(winner.id),
                title=body.title,
            )
            return winner, True
        # Practically unreachable: uq_practice_master_title_scheduled_
        # recurrence only fires on an exact (master_id, title,
        # scheduled_at, recurrence) collision, so the winner must exist.
        # Re-raise rather than silently returning nothing a caller isn't
        # prepared to handle.
        raise

    if body.group_ids:
        await _set_practice_audience_groups(practice.id, body.group_ids, session)

    logger.info(
        "practice_created",
        master_id=str(user.id),
        practice_type=body.practice_type,
        title=body.title,
        is_free=body.is_free,
        price_cents=price_cents,
        direction=body.direction,
        difficulty=body.difficulty,
    )

    return practice, False


async def get_practice(
    practice_id: UUID,
    user: User,
    session: AsyncSession,
) -> tuple[Practice, str | None, str | None, list[str]]:
    """Get a practice by id with visibility rules.

    Returns (Practice, master_name, master_avatar_url, master_methods) tuple.

    Uses OUTER JOIN to MasterProfile so that a practice is never hidden
    just because its master profile was deleted (review #3 finding).
    master_methods extracted from MasterProfile.data.profile.methods;
    defaults to [] when profile row is missing.
    master_avatar_url is User.avatar_url (synced from Telegram on login);
    None when the master has no Telegram photo.

    Draft/deleted practices are visible only to the owner master.
    All other statuses are visible to any authenticated user.
    """
    stmt = (
        select(
            Practice,
            User.first_name,
            User.last_name,
            User.avatar_url,
            MasterProfile.data,
        )
        .join(User, Practice.master_id == User.id)
        .outerjoin(MasterProfile, Practice.master_id == MasterProfile.user_id)
        .where(Practice.id == practice_id)
    )
    result = await session.execute(stmt)
    row = result.one_or_none()

    if not row:
        raise NotFoundError("Practice not found")

    practice, first_name, last_name, master_avatar_url, profile_data = row
    master_name = master_full_name(first_name, last_name)

    # Draft/deleted visible only to owner (P-08: 404 not 403).
    if (
        practice.status not in _PUBLIC_STATUSES
        and practice.master_id != user.id
    ):
        raise NotFoundError("Practice not found")

    master_methods: list[str] = (
        profile_data.get("profile", {}).get("methods", [])
        if profile_data
        else []
    )

    return practice, master_name, master_avatar_url, master_methods


async def get_practice_detail(
    practice_id: UUID,
    user: User,
    session: AsyncSession,
) -> PracticeResponse:
    """Get a single practice as a ready PracticeResponse for the detail screen.

    Public service entry point for GET /practices/{id}. Encapsulates the
    visibility rules (get_practice), the per-user is_booked/is_paid flags,
    and response assembly so the router stays thin and does not reach into
    private helpers (C-1: no cross-layer import of user_flags_for_practices).
    """
    practice, master_name, master_avatar_url, master_methods = (
        await get_practice(practice_id, user, session)
    )
    flags = await user_flags_for_practices(user.id, [practice.id], session)
    is_booked, is_paid = flags.get(practice.id, (False, False))
    series_meta = await series_meta_for_practices([practice], session)
    # E12 + aggregate: OWNER-ONLY on this shared detail endpoint. no_show is
    # sensitive, so a non-owner viewer never sees these -- skip the query and
    # leave all three None. (Series-meta above is innocuous and shown to all.)
    is_owner = practice.master_id == user.id
    attendance = (
        await attendance_counts_for_practices([practice], session)
        if is_owner
        else {}
    )
    # zoom_link (M-3): the owner always sees it; a non-owner only with a
    # CONFIRMED / ATTENDED booking on this practice (a PENDING booking is not
    # enough). is_booked (pending/confirmed/attended) being False means no
    # booking at all -> skip the narrowing query. Everyone else -> None.
    zoom_visible = is_owner
    if not zoom_visible and is_booked:
        zoom_visible = (
            await session.execute(
                select(Booking.id)
                .where(
                    Booking.practice_id == practice.id,
                    Booking.user_id == user.id,
                    Booking.status.in_(ZOOM_VISIBLE_BOOKING_STATUSES),
                )
                .limit(1)
            )
        ).first() is not None
    # T21-1: host join_url, owner-only -- same is_owner gate as the
    # attendance counts above (a non-owner must never see the master's
    # personal link either).
    host_join_url = None
    if is_owner:
        from app.modules.zoom.service import get_host_join_url
        host_join_url = await get_host_join_url(practice.id, session)
    # A4 V2 (ПРОМТ №572): NOT owner-gated -- this is the call site behind
    # GET /practices/{id}, which is also what PracticeLiveView reads for a
    # booked (non-owner) participant. Both need to distinguish pending_
    # creation from create_failed, not just the owner.
    from app.modules.zoom.service import get_zoom_meeting_status
    zoom_meeting_status = await get_zoom_meeting_status(practice.id, session)
    # P5 (ПРОМТ №594): needed by CheckinView.vue to compose "Вы не состоите
    # в группе «...»" client-side without a second round-trip -- see this
    # endpoint's own callers for the full message-mapping story.
    audience_group_names = await group_names_for_practice(practice, session)
    return practice_to_response(
        practice,
        master_name,
        master_methods,
        master_avatar_url=master_avatar_url,
        is_booked=is_booked,
        is_paid=is_paid,
        zoom_link_visible=zoom_visible,
        zoom_host_join_url=host_join_url,
        zoom_meeting_status=zoom_meeting_status,
        audience_group_names=audience_group_names,
        **series_meta_kwargs(series_meta.get(practice.id)),
        **attendance_counts_kwargs(attendance.get(practice.id)),
    )


async def update_practice(
    practice_id: UUID,
    user: User,
    body: UpdatePracticeRequest,
    session: AsyncSession,
) -> Practice:
    """Update a practice. Only the owner master can edit.

    Uses FOR UPDATE to prevent lost updates on concurrent
    status transitions (P-12).

    Raises NotFoundError if not found or not owner (P-08).
    Raises BadRequestError if practice is deleted/terminal,
        if NOT NULL field set to null (P-02),
        if status transition is invalid,
        if pricing invariant is violated,
        or if price is changed with active bookings (CQ-05).

    Calendar taxonomy (direction / difficulty / style) is handled in a
    separate JSONB branch (data.taxonomy) -- see _TAXONOMY_FIELDS. These keys
    are pulled out of update_data BEFORE the column setattr loop so that
    setattr() never targets a non-existent column.
    """
    stmt = (
        select(Practice)
        .where(Practice.id == practice_id)
        .with_for_update()
    )
    result = await session.execute(stmt)
    practice = result.scalar_one_or_none()

    if not practice:
        raise NotFoundError("Practice not found")

    # R-01 fix: 404 not 403 for non-owner (P-08).
    # Consistent with cancel_practice(), bookings, waitlist, reports.
    if practice.master_id != user.id:
        raise NotFoundError("Practice not found")

    if practice.status == PracticeStatus.DELETED.value:
        raise BadRequestError("Cannot edit a deleted practice")

    update_data = body.model_dump(exclude_unset=True)

    # Separate Calendar taxonomy (JSONB) from plain column fields.
    # These are NOT columns: applying them via setattr would create dead
    # Python attributes that never persist (same trap as onboarding_completed
    # in users/service.py). They are merged into data.taxonomy below.
    taxonomy_updates = {
        field: update_data.pop(field)
        for field in _TAXONOMY_FIELDS
        if field in update_data
    }

    # P5 (ПРОМТ №594): group_ids is NOT a column either (practice_audience_
    # group is a separate table) -- pull it out before the setattr loop for
    # the same reason as taxonomy above. audience_kind IS a real column and
    # flows through the loop unchanged.
    group_ids_sent = "group_ids" in update_data
    group_ids_value: list[UUID] = update_data.pop("group_ids", None) or []
    final_audience_kind = update_data.get("audience_kind", practice.audience_kind)

    if group_ids_sent:
        if final_audience_kind == AudienceKind.GROUPS.value and not group_ids_value:
            raise BadRequestError(
                "group_ids must be non-empty when audience_kind='groups'"
            )
        if final_audience_kind != AudienceKind.GROUPS.value and group_ids_value:
            raise BadRequestError(
                "group_ids is only allowed when audience_kind='groups'"
            )
        await _owned_group_ids_or_400(user.id, group_ids_value, session)
    elif final_audience_kind == AudienceKind.GROUPS.value:
        # Switching TO (or staying on) 'groups' without sending new
        # group_ids in THIS request -- only valid if the practice already
        # has target groups from before; otherwise it would end up
        # audience_kind='groups' with nobody able to ever see it.
        existing_count = (
            await session.execute(
                select(func.count(PracticeAudienceGroup.id)).where(
                    PracticeAudienceGroup.practice_id == practice.id,
                )
            )
        ).scalar_one()
        if existing_count == 0:
            raise BadRequestError(
                "group_ids must be non-empty when audience_kind='groups'"
            )

    # Guard NOT NULL fields against explicit null (P-02).
    for field in _NOT_NULL_FIELDS:
        if field in update_data and update_data[field] is None:
            raise BadRequestError(f"{field} cannot be null")

    # Validate status transition if status is being changed.
    if "status" in update_data:
        new_status = update_data["status"]
        allowed = _VALID_TRANSITIONS.get(practice.status, set())
        if new_status not in allowed:
            raise BadRequestError(
                f"Cannot transition from "
                f"{practice.status} to {new_status}"
            )

    # CQ-05: prevent price/is_free changes when active bookings exist.
    # Participants paid the original price; changing it mid-flight
    # creates a mismatch between Purchase.paid_cents and Practice.price_cents.
    pricing_changed = (
        "is_free" in update_data
        and update_data["is_free"] != practice.is_free
    ) or (
        "price_cents" in update_data
        and update_data["price_cents"] != practice.price_cents
    )
    if pricing_changed and await _has_active_bookings(
        practice.id, session,
    ):
        raise BadRequestError(
            "Cannot change price with active bookings"
        )

    # Enforce pricing invariant after applying updates.
    # Resolve final is_free and price_cents from mix of
    # existing values and incoming updates.
    final_is_free = update_data.get("is_free", practice.is_free)
    final_price = update_data.get(
        "price_cents", practice.price_cents,
    )
    if "is_free" in update_data or "price_cents" in update_data:
        final_price = _enforce_pricing(final_is_free, final_price)
        update_data["price_cents"] = final_price

    # Capture the pre-update scheduled_at so we can detect a reschedule and
    # record old -> new in the diary feed projection below. Read BEFORE the
    # setattr loop overwrites practice.scheduled_at.
    old_scheduled_at = practice.scheduled_at
    # E3: capture status before the loop applies the new one, so we can detect a
    # draft -> scheduled publication and materialize series occurrences below.
    old_status = practice.status

    # P5 (ПРОМТ №594): capture the PRE-update audience_kind before the
    # setattr loop overwrites it, so the "transitioning away from groups"
    # branch below can tell.
    old_audience_kind = practice.audience_kind

    # Apply only provided column fields.
    for field, value in update_data.items():
        setattr(practice, field, value)

    if group_ids_sent:
        await _set_practice_audience_groups(practice.id, group_ids_value, session)
    elif (
        "audience_kind" in update_data
        and old_audience_kind == AudienceKind.GROUPS.value
        and final_audience_kind != AudienceKind.GROUPS.value
    ):
        # Switched AWAY from 'groups' without sending group_ids -- the old
        # target-group rows are now meaningless; clear them so they don't
        # linger as stale state a later switch BACK to 'groups' would
        # silently resurrect.
        await _set_practice_audience_groups(practice.id, [], session)

    # Apply Calendar taxonomy updates into data.taxonomy (JSONB).
    # deepcopy + set_jsonb so SQLAlchemy detects the change. Only the keys
    # actually sent are overwritten; the rest of data.taxonomy is preserved.
    if taxonomy_updates:
        # T2 (2026-07-15): direction/style membership is no longer checked by
        # Pydantic (it can't reach the async catalog), so both are validated
        # here, against the config+catalog union.
        #
        # T21-8 (ПРОМТ №547): EditPracticeView resends BOTH direction and
        # style on EVERY save (not only when the master actually changes
        # them), and exclude_unset only tells us they were PRESENT, not that
        # they changed -- so gating re-validation on presence alone re-ran
        # _assert_master_confirmed_taxonomy on every title-only save too,
        # blocking a master from editing ANY field of a practice the instant
        # their confirmed methods no longer covered its (unchanged) taxonomy.
        # Compare against the practice's currently-stored taxonomy instead:
        # object only when a value ACTUALLY CHANGES to something unconfirmed.
        stored_taxonomy = (practice.data or {}).get("taxonomy", {})
        stored_direction = stored_taxonomy.get("direction")
        stored_style = stored_taxonomy.get("style")

        if "direction" in taxonomy_updates:
            new_direction = taxonomy_updates["direction"]
            # Style paired with this same request validates against the NEW
            # direction (None if style isn't part of this update -- a no-op,
            # unchanged from before T21-8: a direction-only change does not
            # re-check the existing stored style against the new direction).
            new_style = taxonomy_updates.get("style")
            direction_changed = new_direction != stored_direction
            style_changed = (
                "style" in taxonomy_updates and new_style != stored_style
            )
            if direction_changed or style_changed:
                await _validate_taxonomy(new_direction, new_style, session)
                # T21-6 (ПРОМТ №546): same master-confirmation check as
                # create_practice -- an update can equally smuggle in a
                # direction/style the master was never confirmed for.
                await _assert_master_confirmed_taxonomy(
                    user.id, new_direction, new_style, session,
                )
        elif "style" in taxonomy_updates:
            # W-1: style changed WITHOUT direction in the same request --
            # validate against the direction actually STORED on the practice
            # (a style valid for a DIFFERENT direction, e.g. "silence" -- a
            # meditation style -- on a stored yoga practice, must still be
            # rejected).
            new_style = taxonomy_updates["style"]
            if new_style != stored_style:
                await _validate_style_choice(stored_direction, new_style, session)
                await _assert_master_confirmed_taxonomy(
                    user.id, stored_direction, new_style, session,
                )

        data = copy.deepcopy(practice.data) if practice.data else {}
        taxonomy = data.get("taxonomy", {})
        taxonomy.update(taxonomy_updates)
        data["taxonomy"] = taxonomy
        practice.set_jsonb("data", data)

    logger.info(
        "practice_updated",
        practice_id=str(practice_id),
        master_id=str(user.id),
        fields=list(update_data.keys()),
        taxonomy_fields=list(taxonomy_updates.keys()),
    )

    # Diary feed: if the master moved the time, fan out a reschedule event to
    # every booked user. Only when scheduled_at actually changed (a PATCH that
    # touches other fields must not spam reschedule cards). Lazy import keeps
    # the dependency one-way (practices -> diary).
    new_scheduled_at = practice.scheduled_at
    if (
        "scheduled_at" in update_data
        and new_scheduled_at != old_scheduled_at
    ):
        from app.modules.diary.projections import (
            project_practice_rescheduled,
        )
        # Master name for the diary card: full "First Last" (MVP rule), same
        # as practice cards. Load the User directly -- get_master_display_name
        # is for notifications and would return the profile display_name.
        master_user = await session.get(User, practice.master_id)
        master_name = master_full_name(
            master_user.first_name if master_user else None,
            master_user.last_name if master_user else None,
        )
        await project_practice_rescheduled(
            session,
            practice=practice,
            master_name=master_name,
            old_scheduled_at=old_scheduled_at,
            new_scheduled_at=new_scheduled_at,
            occurred_at=datetime.now(UTC),
        )

        # E21: keep the Zoom meeting's start time in sync, then re-fetch and
        # overwrite stored registrant join links -- self-healing regardless
        # of whether Zoom actually invalidates them on reschedule (unresolved
        # question, see zoom/service.py docstring). Best-effort: never raises.
        from app.modules.zoom.service import sync_meeting_reschedule
        await sync_meeting_reschedule(practice, session)

    # E3: materialize series occurrences when a series ROOT is published
    # (draft -> scheduled). Gated inside the helper on the recurrence spec's
    # presence, so a series practice without a spec (seed demo) is a no-op. Only
    # roots generate (parent_practice_id is None); generated children are
    # created already-scheduled and never re-enter this path.
    if (
        old_status == PracticeStatus.DRAFT.value
        and practice.status == PracticeStatus.SCHEDULED.value
        and practice.practice_type == PracticeType.SERIES.value
        and practice.parent_practice_id is None
    ):
        await generate_series_occurrences(practice, session)

    # E21: create the practice's Zoom meeting on publish (draft -> scheduled),
    # for ANY practice type -- not gated on series, unlike the block above.
    # Best-effort: create_meeting_for_practice never raises, so publish
    # always succeeds regardless of Zoom's outcome (ПРОМТ №519 amendment 2 --
    # confirmed as the intended reading). KNOWN GAP: series CHILDREN are
    # created directly inside generate_series_occurrences() with
    # status=scheduled and never pass through this branch, so they do not
    # get a Zoom meeting from this step -- out of scope for this prompt
    # (would touch series_service.py), flagged rather than silently patched.
    if (
        old_status == PracticeStatus.DRAFT.value
        and practice.status == PracticeStatus.SCHEDULED.value
    ):
        from app.modules.zoom.service import create_meeting_for_practice
        await create_meeting_for_practice(practice, session)

    return practice


async def delete_practice(
    practice_id: UUID,
    user: User,
    session: AsyncSession,
) -> Practice:
    """Soft-delete a draft practice (set status=deleted).

    Only drafts can be deleted. Published practices must be cancelled
    through cancel_practice() (Phase 6.5) which handles refunds.

    Uses FOR UPDATE to prevent concurrent state changes (P-12).

    Raises NotFoundError if not found or not owner (P-08).
    Raises BadRequestError if not a draft.
    """
    stmt = (
        select(Practice)
        .where(Practice.id == practice_id)
        .with_for_update()
    )
    result = await session.execute(stmt)
    practice = result.scalar_one_or_none()

    if not practice:
        raise NotFoundError("Practice not found")

    # R-01 fix: 404 not 403 for non-owner (P-08).
    # Consistent with cancel_practice(), bookings, waitlist, reports.
    if practice.master_id != user.id:
        raise NotFoundError("Practice not found")

    if practice.status != PracticeStatus.DRAFT.value:
        raise BadRequestError(
            "Only draft practices can be deleted. "
            "Use cancel for published practices."
        )

    practice.status = PracticeStatus.DELETED.value

    logger.info(
        "practice_deleted",
        practice_id=str(practice_id),
        master_id=str(user.id),
    )

    return practice
