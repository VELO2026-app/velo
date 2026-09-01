# =============================================================================
# VELO Backend -- Admin Users Schemas (Phase 3.2)
# =============================================================================

from uuid import UUID

from pydantic import BaseModel, Field

from app.modules.users.models import UserRole
from app.modules.users.schemas import UserResponse


class PaginatedUsersResponse(BaseModel):
    """GET /api/v1/admin/users -- paginated user list."""

    items: list[UserResponse]
    total: int
    limit: int
    offset: int


class AdminMasterListItem(BaseModel):
    """Single item in admin masters list -- user data + master status.

    CR-01: role narrowed from str to UserRole for type safety.

    R8: rich-card fields, additive over the F8-fix shape.
      - methods: read straight off the already-joined MasterProfile.data.profile
        (zero extra cost -- see list_masters).
      - practices_count / students_count: real all-time aggregates, computed in
        ONE batched query each over the page's master_ids (no N+1, mirrors
        practices/enrichment_service.py attendance_counts_for_practices). None
        only if a master somehow falls outside the batch (should not happen;
        honest stub -- FE shows "-").
      - available_cents: MasterProfile.available_cents, a plain column already
        loaded by the list_masters join -- zero extra cost.

    P4/GT-9:
      - curator_groups_count: how many curator groups this master OWNS, in
        the same batched shape as the two counts above. Counts ACTIVE AND
        FROZEN alike: revoking a master's verification does not dissolve
        their schools, and an admin looking at the person needs to see what
        is still attached to them. Same None semantics as its neighbours --
        null only if a master somehow falls outside the batch, which should
        not happen; the FE shows "-".

    GT-15:
      - can_create_groups: whether the admin has granted this master the
        right to FOUND schools. Read off the profile row the list already
        joined -- zero extra cost, like methods and available_cents.

        ITS NONE-SEMANTICS DELIBERATELY DIFFER FROM ITS NEIGHBOURS above,
        which is why this says so out loud. Those are `int | None` because
        a count can genuinely be unknown: null means "this master fell
        outside the batch". A right cannot be unknown here -- the profile
        is in hand on every row -- so this is a plain bool defaulting to
        false, and false always means "no right", never "could not tell".
        A `| None` would invent a third state that the data cannot
        produce, and the FE would need a "-" branch that never renders.

        Distinct from curator_groups_count next to it: the count says what
        this master already owns (schools survive both a revoked right and
        a revoked verification), the flag says what they may found next.
        A master with three schools and no flag is a normal state.
    """

    id: UUID
    telegram_id: int | None = None
    first_name: str | None = None
    last_name: str | None = None
    avatar_url: str | None = None
    role: UserRole
    is_active: bool
    master_status: str = Field(description="MasterProfile account status")
    methods: list[str] = Field(default_factory=list)
    practices_count: int | None = None
    students_count: int | None = None
    curator_groups_count: int | None = None
    available_cents: int | None = None
    can_create_groups: bool = False


class AdminMasterDetail(AdminMasterListItem):
    """GET /api/v1/admin/masters/{id} -- single master with profile detail (T3).

    Extends the list item with the profile fields the admin review screen shows:
    ``methods`` (editable via PATCH /admin/masters/{id}/methods), plus
    ``experience_years`` and ``bio`` (display-only). All read from
    MasterProfile.data.profile (additive, no migration).
    """

    methods: list[str] = Field(default_factory=list)
    experience_years: int = 0
    bio: str | None = None
    # Batch H: the remaining master-authored fields the admin edits, read from
    # data.profile. display_name is the profile «визитка» name (distinct from the
    # account first/last on the base item). email/phone/certifications are
    # ADMIN-ONLY -- they MUST NOT be added to the public MasterPublicResponse
    # (test_master_public forbids them on GET /masters/{id}).
    display_name: str | None = None
    email: str | None = None
    phone: str | None = None
    languages: list[str] = Field(default_factory=list)
    certifications: list[str] = Field(default_factory=list)


class PaginatedMastersResponse(BaseModel):
    """GET /api/v1/admin/masters -- paginated master list."""

    items: list[AdminMasterListItem]
    total: int
    limit: int
    offset: int
