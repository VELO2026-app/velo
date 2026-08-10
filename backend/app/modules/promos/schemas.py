# =============================================================================
# VELO Backend -- Promo Schemas (Phase 6.7)
# =============================================================================
#
# CreateMasterPromoRequest: master creates a promo code.
# PromoResponse:            full promo record.
# PaginatedPromosResponse:  paginated list for master/admin views.
#
# CR-01: valid_from changed from required to optional. When omitted,
#   validator defaults to utcnow() so downstream code always sees
#   a concrete datetime (service layer unchanged).
# =============================================================================

from datetime import datetime, timezone
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class CreateMasterPromoRequest(BaseModel):
    """POST /api/v1/masters/me/promos -- create a master promo code.

    Master promos: master absorbs the discount from their revenue.
    type and master_id are set automatically by the service layer.
    """

    code: str = Field(
        min_length=3, max_length=50,
        description="Unique promo code (will be uppercased).",
    )
    discount_percent: int = Field(
        gt=0, le=100,
        description="Discount percentage (must be in allowed list).",
    )
    practice_id: UUID | None = Field(
        default=None,
        description="Limit promo to a specific practice (null = all).",
    )
    max_uses: int | None = Field(
        default=None, ge=1,
        description="Max number of uses (null = unlimited).",
    )
    valid_from: datetime | None = Field(
        default=None,
        validate_default=True,
        description=(
            "Start of validity window (UTC). "
            "Defaults to current time when omitted."
        ),
    )
    valid_until: datetime | None = Field(
        default=None,
        description="End of validity window (null = no expiry).",
    )
    first_purchase_only: bool = Field(
        default=False,
        description="If true, only works for user's first purchase.",
    )

    @field_validator("valid_from", mode="before")
    @classmethod
    def default_valid_from_to_now(cls, v: datetime | None) -> datetime:
        """Default valid_from to current UTC time when not provided.

        Guarantees downstream code always receives a concrete datetime,
        so service-layer comparisons (valid_until <= valid_from) work
        without None checks.

        R6 fix (PROMPT №390): pydantic v2 does NOT run a mode="before"
        validator against a field's own default unless validate_default=True
        is also set on the Field -- without it, omitting valid_from (which
        MasterNewPromocodeView.vue always does) left it None all the way
        through to promos/service.py:74 (`valid_until <= body.valid_from`),
        a guaranteed TypeError since valid_until is always sent. Same bug
        class as C2 (admin/promos/schemas.py's CreateCompanyPromoRequest),
        mirrored here for this sibling schema.
        """
        if v is None:
            return datetime.now(timezone.utc)
        return v


class PromoResponse(BaseModel):
    """Full promo record returned to master and admin."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    code: str
    type: str
    master_id: UUID | None
    practice_id: UUID | None
    discount_percent: int
    max_uses: int | None
    used_count: int
    valid_from: datetime
    valid_until: datetime | None
    first_purchase_only: bool
    is_active: bool
    created_at: datetime
    updated_at: datetime | None


class PaginatedPromosResponse(BaseModel):
    """Paginated list of promos."""

    items: list[PromoResponse]
    total: int
    limit: int
    offset: int
