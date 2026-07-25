# =============================================================================
# VELO Backend -- Admin Master Schemas (Phase 2.3, moved Phase 3.1, NO-LITERALS)
# =============================================================================
#
# NO-LITERALS: note/reason field limits sourced from
#   settings.admin_action_note_max_length -- change once, applies everywhere.
# =============================================================================

from datetime import datetime
from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field, StringConstraints

from app.core.config import settings
from app.modules.masters.schemas import ShortStr

# Constrained method string, mirroring masters/schemas.ShortStr (defined here
# to avoid a cross-module import). Non-empty, capped at 200 chars.
_MethodStr = Annotated[str, StringConstraints(min_length=1, max_length=200)]


# ---------------------------------------------------------------------------
# Requests
# ---------------------------------------------------------------------------
class VerifyMasterRequest(BaseModel):
    """POST /admin/masters/{user_id}/verify -- request body.

    promote (ПРОМТ №503 commit 3, mirrors ApproveMethodChangeRequest.promote
    below): optional list of custom method labels from the applicant's own
    `methods` that the admin chose to add to the taxonomy catalog. Before this,
    only an ALREADY-VERIFIED master's later method-change request had any
    promotion path -- a brand-new applicant's «Свой вариант» text could never
    become a real catalog chip, no matter what the admin did. Absent/empty ->
    no catalog write, identical to before this field existed. Deduped against
    existing rows (_promote_custom_methods) -- admin-picked, not automatic, same
    editorial-control rationale as the method-change-request flow (operator
    decision 3=Б): a custom label becomes SHARED vocabulary for every future
    master/admin the moment it's promoted, so it stays a deliberate admin
    choice rather than something typo'd free text can trigger unreviewed.
    """

    notes: str | None = Field(
        default=None,
        max_length=settings.admin_action_note_max_length,
        description="Optional admin notes about verification decision",
    )
    promote: list[str] = Field(default_factory=list)
    master_only: list[str] = Field(
        default_factory=list,
        description=(
            "T22-6 (ПРОМТ №561): custom method labels approved for THIS "
            "master only -- each gets a master-scoped taxonomy row, never "
            "visible to another master's picker."
        ),
    )


class RejectMasterRequest(BaseModel):
    """POST /admin/masters/{user_id}/reject -- request body."""

    reason: str = Field(
        ...,
        min_length=1,
        max_length=settings.admin_action_note_max_length,
        description="Reason for rejection (shown to applicant)",
    )


class EditMasterMethodsRequest(BaseModel):
    """PATCH /admin/masters/{user_id}/methods -- new flat method set (T3).

    Admin-authored direct edit of a master's methods during review. Mirrors the
    apply-side rule (min 1, max 20). Distinct from the master's own
    method-change request (M3).
    """

    methods: list[_MethodStr] = Field(min_length=1, max_length=20)


class AdminMasterProfileUpdate(BaseModel):
    """PATCH /admin/masters/{user_id}/profile -- partial admin edit of EVERY
    master-authored field (batch H).

    ALL fields optional; only the keys the client actually SENDS are applied
    (the service reads model_dump(exclude_unset=True)), so a partial PATCH never
    clobbers an unsent sibling. Constraints are reused from the apply form
    (MasterApplyProfile / MasterApplyExperience, masters/schemas.py:49-70) and
    users/me (UserUpdate first/last, users/schemas.py:577-578) so admin-edit
    validation can never drift from what the master could originally submit.

    Field homes:
      display_name / email / phone / bio / methods / experience_years /
      certifications / languages  -> MasterProfile.data.profile.*
      first_name / last_name      -> User.* (the account name shown in admin lists)
    """

    # -- data.profile.* (JSONB) --
    display_name: str | None = Field(default=None, min_length=1, max_length=100)
    email: EmailStr | None = Field(default=None)
    phone: str | None = Field(default=None, max_length=30)
    bio: str | None = Field(default=None, max_length=2000)
    # Non-nullable: experience is always an int (0-50); a null is rejected (422)
    # rather than written, which would break the non-optional detail read
    # (AdminMasterDetail.experience_years: int). Unsent -> omitted via exclude_unset.
    experience_years: int = Field(default=0, ge=0, le=50)
    # List fields use default_factory (not | None) so the generated TS type is
    # `string[]` (matching the apply schemas + MasterLanguagesUpdate). A partial
    # PATCH still omits an unsent list via exclude_unset; sending [] for methods
    # is rejected (min 1, the apply rule); [] clears languages/certifications.
    methods: list[ShortStr] = Field(
        default_factory=list, min_length=1, max_length=20
    )
    certifications: list[ShortStr] = Field(default_factory=list, max_length=20)
    languages: list[ShortStr] = Field(default_factory=list, max_length=10)

    # -- User.* (account name, В1=В: both names editable) --
    first_name: str | None = Field(default=None, min_length=1, max_length=100)
    last_name: str | None = Field(default=None, min_length=1, max_length=100)


# ---------------------------------------------------------------------------
# Response
# ---------------------------------------------------------------------------
class AdminMasterActionResponse(BaseModel):
    """Response for verify/reject actions."""

    user_id: UUID
    status: str


class RevokeMasterAdvisory(BaseModel):
    """Advisory signals for revoke-preview + revoke (A1, WARN-not-block).

    Mirrors the CLI `set_role.py to_user` downgrade guard, but the admin endpoint
    does NOT block on them (operator decision Б): a revoke soft-freezes the
    profile and preserves every row regardless. Surfaced so the admin sees what
    stays behind before confirming.
    """

    scheduled_or_live_practices: int
    available_cents: int
    frozen_cents: int
    pending_withdrawals: int
    has_warnings: bool


class InviteMasterResponse(BaseModel):
    """POST /admin/masters/invite -- the composed generic invite link.

    Account-agnostic: the link is not bound to a target user. No expiry
    field by design -- the link lives in Redis until the first claim burns
    it (or a Redis flush drops it, after which the admin regenerates).
    """

    invite_link: str
    issued_at: datetime


# ---------------------------------------------------------------------------
# M3 (E19-FLAT): method change-request moderation
# ---------------------------------------------------------------------------
class AdminMethodChangeItem(BaseModel):
    """One pending method change-request in the admin moderation list.

    Carries the master's identity + the current vs proposed flat method sets
    so the admin can decide without a second fetch.
    """

    user_id: UUID
    display_name: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    avatar_url: str | None = None
    current_methods: list[str] = Field(default_factory=list)
    proposed_methods: list[str] = Field(default_factory=list)
    submitted_at: datetime


class PaginatedMethodChangeRequestsResponse(BaseModel):
    """GET /admin/masters/method-change-requests -- paginated pending list."""

    items: list[AdminMethodChangeItem]
    total: int
    limit: int
    offset: int


class RejectMethodChangeRequest(BaseModel):
    """POST /admin/masters/{user_id}/method-change-request/reject -- body."""

    reason: str = Field(
        ...,
        min_length=1,
        max_length=settings.admin_action_note_max_length,
        description="Reason for rejecting the method change (shown to master)",
    )


class ApproveMethodChangeRequest(BaseModel):
    """POST /admin/masters/{user_id}/method-change-request/approve -- body.

    R5 stage 4 (operator decision 3=Б): promote is OPTIONAL and defaults to
    empty, so a bare `{}` body (every caller before this stage, and every
    approval where the admin didn't pick "add to catalog") behaves exactly
    as before -- no catalog write. Each entry becomes a new custom
    direction in the taxonomy catalog (deduped against existing rows).
    """

    promote: list[str] = Field(default_factory=list)
    master_only: list[str] = Field(
        default_factory=list,
        description=(
            "T22-6 (ПРОМТ №561): custom method labels approved for THIS "
            "master only -- each gets a master-scoped taxonomy row, never "
            "visible to another master's picker."
        ),
    )


class MethodChangeActionResponse(BaseModel):
    """Response for approve/reject method-change actions.

    status is the resulting request state: "approved" (methods updated,
    request cleared) or "rejected".
    """

    user_id: UUID
    status: str
