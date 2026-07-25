# =============================================================================
# VELO Backend -- Master Schemas (updated Phase F7)
# =============================================================================
#
# INPUT: MasterApplyRequest -- 3-step form collected on frontend, sent as
#   one POST. Fields map to data JSONB sections in MasterProfile.
#
# PAYOUT (Phase 6.6): PayoutDetailsUpdate -- flexible JSONB with minimal
#   validation. Stored in MasterProfile.data.payout, snapshotted into
#   each Withdrawal record at creation time.
#
# F7: MasterProfileResponse now includes payout field (PayoutDetails
#   or None). Extracted from data.get("payout") in _make_profile_response().
#
# CR-01: MasterProfileResponse gains min_withdrawal_cents and
#   withdrawal_fee_cents (from settings). Frontend no longer needs to
#   hardcode these values in utils/constants.ts.
#
# DOCUMENTS: list[dict] for now (JSONB sandbox). Each dict is freeform --
#   could be {"type": "certificate", "number": "123"} or
#   {"type": "link", "url": "https://..."}.
#   TODO: Replace with file upload when S3/storage is ready.
#
# PUBLIC PROFILE (Calendar iteration, S-4):
#   MasterPublicResponse -- the user-facing master profile shown when a
#   user taps "Подробнее" on a practice's master card (frame 4) or opens
#   the master profile screen (node 541:2065). It exposes ONLY safe public
#   fields plus two live ORM aggregate counters (practices_count,
#   reviews_count). It deliberately does NOT include any financial data
#   (frozen/available balance, payout, withdrawal limits) or contact data
#   (email, phone) -- those live only in the master-private
#   MasterProfileResponse returned by GET /me.
# =============================================================================

from datetime import datetime
from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field, StringConstraints

# Constrained string for list items (methods, certifications) to prevent
# oversized payloads. Must be 1-200 characters.
ShortStr = Annotated[str, StringConstraints(min_length=1, max_length=200)]


# ---------------------------------------------------------------------------
# Step 1: Profile info
# ---------------------------------------------------------------------------
class MasterApplyProfile(BaseModel):
    """Step 1 of master application -- basic profile."""

    display_name: str = Field(min_length=1, max_length=100)
    email: EmailStr | None = Field(default=None)
    phone: str | None = Field(default=None, max_length=30)


# ---------------------------------------------------------------------------
# Step 2: Experience
# ---------------------------------------------------------------------------
class MasterApplyExperience(BaseModel):
    """Step 2 of master application -- professional background."""

    methods: list[ShortStr] = Field(min_length=1, max_length=20)
    experience_years: int = Field(ge=0, le=50)
    bio: str | None = Field(default=None, max_length=2000)
    certifications: list[ShortStr] = Field(default_factory=list, max_length=20)
    # E16: languages the master runs practices in (Русский / English). Flat
    # string list, optional at apply time (default []). Freely editable on the
    # profile later (no moderation, Q2=А).
    languages: list[ShortStr] = Field(default_factory=list, max_length=10)


# ---------------------------------------------------------------------------
# Step 3: Documents (JSONB sandbox)
# ---------------------------------------------------------------------------
# Freeform dicts for now. Structure will solidify when file upload is added.
# TODO: Replace with typed schema + file upload (S3) in future phase.


# ---------------------------------------------------------------------------
# Full application request
# ---------------------------------------------------------------------------
class MasterApplyRequest(BaseModel):
    """Combined 3-step master application form."""

    profile: MasterApplyProfile
    experience: MasterApplyExperience
    documents: list[dict] = Field(default_factory=list, max_length=50)


# ---------------------------------------------------------------------------
# Response
# ---------------------------------------------------------------------------
class MasterApplyResponse(BaseModel):
    """Response after submitting master application."""

    user_id: UUID
    status: str
    created_at: datetime


# ---------------------------------------------------------------------------
# One-time master invite claim (Batch-INVITE, C1=Б)
# ---------------------------------------------------------------------------
class ClaimMasterInviteRequest(BaseModel):
    """POST /masters/invite/claim -- the token from the deeplink.

    The generic token is looked up in Redis and burned by the first claim;
    an unknown or already-consumed token 404s (invite_invalid).
    """

    token: str = Field(..., min_length=16, max_length=128)


class ClaimMasterInviteResponse(BaseModel):
    """POST /masters/invite/claim -- claim confirmation.

    Claiming only validates + consumes the one-time marker; becoming a
    master still goes through the regular apply wizard + admin approval.
    """

    claimed_at: datetime


# ---------------------------------------------------------------------------
# Payout details (Phase 6.6)
# ---------------------------------------------------------------------------


class PayoutDetailsUpdate(BaseModel):
    """PATCH /api/v1/masters/me/payout -- request body.

    Flexible JSONB with minimal validation. The ``method`` field
    is required; ``details`` is freeform and depends on method:
      bank_transfer: {iban, bank_name, account_holder, swift}
      paypal:        {email}
      revolut:       {tag or phone}
    """

    method: str = Field(min_length=1, max_length=50)
    details: dict = Field(min_length=1)  # At least one key required


class MasterLanguagesUpdate(BaseModel):
    """PATCH /api/v1/masters/me/languages -- freely-editable language set (E16).

    Q2=А: no moderation (unlike methods). Replaces data.profile.languages
    wholesale with the sent flat list. Empty list clears it.
    """

    languages: list[ShortStr] = Field(default_factory=list, max_length=10)


class PayoutDetails(BaseModel):
    """Payout details stored in MasterProfile.data.payout.

    CR-01: renamed from PayoutDetailsResponse -- this is an embedded
    object, not a top-level response. Name now matches frontend usage.
    """

    method: str
    details: dict = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Method change-request (M3 / E19-FLAT). Additive JSONB, no migration.
# ---------------------------------------------------------------------------
class MethodChangeRequestSubmit(BaseModel):
    """POST /masters/me/method-change-request -- proposed flat method set.

    M3 ships FLAT: the request carries a plain list of method strings (same
    shape/limits as MasterApplyExperience.methods). The two-level
    direction->kind taxonomy (E19) is deferred / out of scope.
    """

    proposed_methods: list[ShortStr] = Field(min_length=1, max_length=20)


class MethodChangeRequest(BaseModel):
    """Embedded method change-request, projected onto MasterProfileResponse.

    Stored at data.profile.method_change_request. status is one of
    "pending" | "rejected" (approved requests are cleared once the master's
    methods are updated, so the field returns to None). None on the response
    means the master has no outstanding or recently-rejected request.
    """

    status: str
    proposed_methods: list[str] = Field(default_factory=list)
    submitted_at: datetime
    decided_at: datetime | None = None
    decided_by: UUID | None = None
    reject_reason: str | None = None


# ---------------------------------------------------------------------------
# Master profile response (updated Phase F7 + CR-01, M3)
# ---------------------------------------------------------------------------
class MasterProfileResponse(BaseModel):
    """Self-only master profile representation (GET/PATCH /masters/me/*).

    NOT public -- carries financial fields (frozen_cents, available_cents,
    payout) and is only ever returned from get_current_master-gated
    endpoints. MasterPublicResponse below is the actual public schema and
    MUST stay financial-field-free (see its own docstring).

    F7: payout field added -- extracted from data.get("payout").
    None when master has not configured payout details yet.

    CR-01: min_withdrawal_cents and withdrawal_fee_cents added from
    settings so frontend does not hardcode financial constants.
    """

    user_id: UUID
    status: str
    display_name: str | None = None
    bio: str | None = None
    methods: list[str] = Field(default_factory=list)
    # E16: languages the master runs practices in (freely editable, Q2=А).
    languages: list[str] = Field(default_factory=list)
    experience_years: int | None = None
    frozen_cents: int
    available_cents: int
    # CR-01: withdrawal limits from settings -- single source of truth.
    min_withdrawal_cents: int
    withdrawal_fee_cents: int
    # F7: payout details (None until master sets them via PATCH /me/payout)
    payout: PayoutDetails | None = None
    created_at: datetime
    updated_at: datetime | None = None
    # E14: rejection reason surfaced to the applicant. Persisted by admin-reject
    # in the master JSONB under data.account.rejection_reason (service.py); the
    # router projects it here. None unless the current status is rejected.
    rejection_reason: str | None
    # M3 (F-M3-3): the master's pending / recently-rejected method-change
    # request, projected from data.profile.method_change_request. Optional
    # (default None) -- no frozen key-set breaks. None when there is none.
    method_change_request: MethodChangeRequest | None = None


# ---------------------------------------------------------------------------
# Public master profile (Calendar iteration, S-4)
# ---------------------------------------------------------------------------
class MasterPublicResponse(BaseModel):
    """User-facing master profile -- safe public subset + live counters.

    Returned by GET /api/v1/masters/{user_id} for any authenticated user.
    Used by the practice detail "Подробнее" link (frame 4) and the master
    profile screen (node 541:2065).

    SECURITY: this schema is the isolation boundary between public and
    private master data. It MUST NOT carry any financial fields
    (frozen_cents, available_cents, payout, withdrawal limits) or contact
    fields (email, phone). Only a verified master is exposed; pending /
    rejected / non-master ids resolve to 404 in the service (we do not
    reveal the existence of an unverified application).

    practices_count and reviews_count are LIVE ORM aggregates computed in
    the service, NOT read from the stale data.stats JSONB cache:
      practices_count -- Practice rows for this master, excluding
                         draft and deleted statuses.
      reviews_count   -- Feedback rows across all of this master's
                         practices (every feedback, regardless of text).
    """

    user_id: UUID
    status: str
    display_name: str | None = None
    bio: str | None = None
    methods: list[str] = Field(default_factory=list)
    experience_years: int | None = None
    # Master avatar (User.avatar_url, synced from Telegram photo_url).
    avatar_url: str | None = None
    # Live ORM aggregate counters (see class docstring).
    practices_count: int
    reviews_count: int
