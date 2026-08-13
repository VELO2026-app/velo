# =============================================================================
# VELO Backend — User Schemas
# =============================================================================
#
# Pydantic models for user profile endpoints.
#
# UserResponse lives here (not in auth/) because it belongs to the users
# domain. auth/schemas.py imports it from here.
#
# ONBOARDING (welcome flow):
#   onboarding_completed is NOT a DB column. It lives inside the
#   credentials JSONB sandbox (key "onboarding_completed"), following the
#   "schema-on-read until it stabilizes, then extract to a column" pattern.
#   - UserResponse exposes it as a top-level bool (computed from credentials),
#     so the frontend never sees the raw credentials blob.
#   - UserUpdate accepts it so the welcome carousel can mark it done via
#     PATCH /users/me. The service writes it back into credentials.
#
# USER NOTIFICATION PREFERENCES ARE NOT HERE ANY MORE (T-26, owner-ruled
# 2026-08-13). The four-key credentials["notifications"] store (push /
# practice_reminders / master_messages / support_messages) is RETIRED from
# this API: it was write-only -- nothing downstream ever read it, so the user
# muted and was not muted. Delivery is decided by the comms service, by
# CATEGORY, and that is now the single source of truth. The student's screen
# reads and writes it through the proxy (GET/PUT /api/v1/notifications/prefs,
# app/modules/comms_proxy/router.py). Deliberately NOT kept as a cache: a
# second place of truth is exactly what the ruling forbade.
#
# MASTER NOTIFICATION PREFERENCES ARE NOT HERE EITHER (T-26 set 2, 2026-08-14).
# credentials["master_notifications"] -- nine toggles plus a delivery schedule
# -- is retired for a different reason than the user store above: it was ORPHAN.
# The master screen moved to comms on 2026-08-07 (df77e4e4) and stopped writing
# it, but PATCH /users/me kept accepting it and GET /users/me kept serving it --
# a store no client wrote and the API still published. Same board rule either
# way: never a third place of truth.
#
# WHAT SURVIVED THIS AND MUST KEEP SURVIVING: `master_capability_in`. It gated
# the master_notifications block, but it ALSO feeds `role_switch`, and the
# router sets it in the same pass that carries `master_application`. Deleting
# the carrier with the block would silently break self role-switch.
# =============================================================================

from datetime import datetime
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from email_validator import EmailNotValidError, validate_email
from pydantic import BaseModel, Field, computed_field, field_validator

from app.modules.users.models import UserRole


class RoleSwitchInfo(BaseModel):
    """Self role-switch capability (capability-derived, A1=Б).

    Present in GET /users/me when the derived set contains more than just
    USER (i.e. there is actually something to switch to). The list is the
    set of roles this account may switch itself to via POST /users/me/role,
    derived by derive_allowed_roles() -- the single source of truth shared
    with the write path. Null when the user can only be a plain user.
    """

    allowed_roles: list[UserRole]


def has_admin_home(credentials: dict | None) -> bool:
    """Whether this account is a switched-away admin (round-trip marker).

    When an admin switches their own role away via POST /users/me/role, the
    service records credentials.role_switch.home_role = "admin" so the
    derivation keeps ADMIN in their allowed set and they can switch back.
    The marker is server-written only: "role_switch" is not in the PATCH
    whitelist (_JSONB_CREDENTIAL_FIELDS), so clients cannot grant it.
    """
    role_switch = (credentials or {}).get("role_switch")
    if not isinstance(role_switch, dict):
        return False
    return role_switch.get("home_role") == "admin"


def credentials_without_admin_home(credentials: dict | None) -> dict:
    """Return a copy of credentials with the switched-away-admin marker cleared.

    Drops credentials.role_switch.home_role (and the whole role_switch block if
    it becomes empty). Used by the setrole CLI (scripts/set_role.py) whenever it
    writes a role: an authoritative CLI role change makes that role the
    account's new home, so a stale home_role="admin" must not survive. Without
    this, a demoted ex-admin (role -> user) would keep the marker and could
    self-restore admin via POST /users/me/role, since derive_allowed_roles
    honours the marker (R-1).

    Pure: input is not mutated; content is returned unchanged when no marker is
    present, so callers may write it back unconditionally.
    """
    new_credentials = dict(credentials or {})
    role_switch = new_credentials.get("role_switch")
    if isinstance(role_switch, dict) and "home_role" in role_switch:
        role_switch = dict(role_switch)
        role_switch.pop("home_role", None)
        if role_switch:
            new_credentials["role_switch"] = role_switch
        else:
            new_credentials.pop("role_switch", None)
    return new_credentials


def derive_allowed_roles(
    role: UserRole | str,
    has_master_capability: bool,
    *,
    admin_home: bool = False,
) -> list[UserRole]:
    """Single source of truth for the self role-switch policy (A1=Б).

    allowed(user) =
      {USER}
      ∪ {MASTER}                iff the user has master capability
                                     (a VERIFIED MasterProfile)
      ∪ {USER, MASTER, ADMIN}   iff the user is an admin (current role ADMIN,
                                     or a switched-away admin -- admin_home)

    Hard rule ADMIN-NEVER-TARGET: a non-admin can never reach ADMIN here --
    the admin role is granted only via CLI/DB. An admin may switch to MASTER
    even without a master profile (№254 Q4=А): the master zone then shows
    its honest empty/onboarding state.

    Used by BOTH the write path (service.switch_user_role) and the read path
    (UserResponse.role_switch) so the two can never drift.
    """
    if role == UserRole.ADMIN or admin_home:
        return [UserRole.USER, UserRole.MASTER, UserRole.ADMIN]
    if has_master_capability:
        return [UserRole.USER, UserRole.MASTER]
    return [UserRole.USER]


class MasterApplicationInfo(BaseModel):
    """The user's master-application state, read from MasterProfile.data.account.

    Surfaced on UserResponse (T5) so a role='user' applicant can see the verdict
    of their application (pending / verified / rejected + the rejection reason)
    without the master-only GET /masters/me endpoint. Set by the GET /users/me
    router from the same MasterProfile load used for master capability.
    """

    status: str  # "pending" | "verified" | "rejected"
    rejection_reason: str | None = None


class UserResponse(BaseModel):
    """User representation in API responses.

    onboarding_completed is derived from the credentials JSONB sandbox
    rather than a dedicated column (schema-on-read pattern). The raw
    credentials blob is pulled in only to compute that single boolean and
    is never serialized -- see _credentials below.

    Mechanism (kept deliberately simple -- one carrier field + one
    computed_field): _credentials is filled from the ORM object's
    `credentials` attribute via validation_alias under from_attributes,
    but excluded from output; onboarding_completed reads from it.
    """

    id: UUID
    telegram_id: int | None
    role: UserRole
    first_name: str | None
    last_name: str | None
    avatar_url: str | None
    timezone: str
    language: str
    is_active: bool
    balance_cents: int
    created_at: datetime
    last_login_at: datetime | None

    # Input-only carrier for the raw credentials dict. Filled from the ORM
    # object's `credentials` column (validation_alias) and excluded from the
    # serialized output (exclude=True), so the blob never reaches API clients.
    # onboarding_completed is computed from it below. Underscore-prefixed name
    # signals "internal, do not read directly".
    credentials_in: dict = Field(
        default_factory=dict,
        validation_alias="credentials",
        exclude=True,
    )

    # Input-only carrier for "this account has a VERIFIED MasterProfile". NOT
    # read from the ORM (no validation_alias) -- the GET /users/me router sets
    # it explicitly after model_validate, because deciding it requires a
    # MasterProfile lookup this schema cannot do. Excluded from output.
    #
    # ⚠ DO NOT DELETE THIS WITH THE BLOCK IT WAS BORN FOR. It was introduced to
    # gate `master_notifications`, and that block is gone (T-26 set 2). It is
    # STILL LOAD-BEARING: `role_switch` below derives the allowed-role set from
    # it, so removing it would silently stop offering MASTER as a switch target
    # to every verified master -- a capability regression with no error and no
    # failing type. Defaults to False, so a UserResponse built OUTSIDE the
    # /users/me routers (e.g. an admin user list) under-derives role_switch
    # rather than over-deriving it.
    master_capability_in: bool = Field(default=False, exclude=True)

    # T5: the user's master-application state (status + rejection reason), so a
    # rejected/pending role='user' applicant sees the verdict without the
    # master-only /masters/me endpoint. Set by the GET /users/me router after
    # model_validate (needs a MasterProfile lookup); None when never applied.
    master_application: MasterApplicationInfo | None = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def onboarding_completed(self) -> bool:
        """Whether the user has finished the welcome onboarding flow.

        Stored inside credentials JSONB under "onboarding_completed".
        Missing key (new users) -> False.
        """
        return bool(self.credentials_in.get("onboarding_completed", False))

    @computed_field  # type: ignore[prop-decorator]
    @property
    def master_onboarding_completed(self) -> bool:
        """Whether the user has finished the master-zone onboarding flow (E15).

        Same schema-on-read pattern as onboarding_completed, stored inside
        credentials JSONB under "master_onboarding_completed". Missing key
        (never onboarded as master) -> False.
        """
        return bool(
            self.credentials_in.get("master_onboarding_completed", False)
        )

    @computed_field  # type: ignore[prop-decorator]
    @property
    def phone(self) -> str | None:
        """User's contact phone, stored in the credentials JSONB sandbox.

        Same schema-on-read pattern as onboarding_completed (key "phone").
        Missing key -> None. An empty string means the user cleared it
        (see UserUpdate: empty string is an allowed "clear" value, unlike
        first_name which uses null to clear).
        """
        value = self.credentials_in.get("phone")
        return value if isinstance(value, str) else None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def bio(self) -> str | None:
        """User's short "about me" text, stored in the credentials JSONB.

        Schema-on-read (key "bio"). Missing key -> None. Empty string is an
        allowed cleared value.
        """
        value = self.credentials_in.get("bio")
        return value if isinstance(value, str) else None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def email(self) -> str | None:
        """User's contact email, stored in the credentials JSONB (E11).

        Telegram provides no email, so it is captured via the profile edit
        form. Schema-on-read (key "email"), same pattern as phone/bio. Missing
        key -> None. Empty string is an allowed cleared value.
        """
        value = self.credentials_in.get("email")
        return value if isinstance(value, str) else None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def role_switch(self) -> RoleSwitchInfo | None:
        """Self role-switch capability, or None when there is nothing to
        switch to.

        Derived by derive_allowed_roles() from the current role, the master
        capability (master_capability_in -- set by the router) and the
        switched-away-admin marker. The old seeded
        credentials.role_switch.allowed_roles lists are IGNORED: capability,
        not seeding, decides (A1=Б).

        This is now the ONLY consumer of master_capability_in -- T-26 retired
        the master_notifications block the carrier was originally built for.
        The carrier's caveat is therefore this block's caveat: a UserResponse
        built outside the /users/me routers reports master_capability_in=False
        and may under-derive.
        """
        allowed = derive_allowed_roles(
            self.role,
            self.master_capability_in,
            admin_home=has_admin_home(self.credentials_in),
        )
        if len(allowed) == 1:
            return None
        return RoleSwitchInfo(allowed_roles=allowed)

    model_config = {"from_attributes": True, "populate_by_name": True}


class UserUpdate(BaseModel):
    """PATCH /api/v1/users/me — updatable profile fields.

    All fields are optional. Only provided fields are updated.
    avatar_url is excluded — managed by Telegram (future: Bot API).

    Empty strings are rejected (min_length=1). To clear a field,
    send null explicitly: {"last_name": null}.

    timezone and language are NOT NULL in DB — sending null for them
    is rejected by _reject_null_for_required_fields (mode="before").

    onboarding_completed is written into the credentials JSONB by the
    service layer (not a column). null is meaningless here, so only
    true/false are accepted; "not sent" leaves it untouched.

    phone and bio also live in the credentials JSONB (schema-on-read, same
    pattern). Unlike the name fields, they allow an EMPTY STRING as a valid
    value: sending "" clears the field (stored as "" in credentials). They
    have no min_length for that reason -- only a max_length cap. "Not sent"
    leaves them untouched; null is treated the same as "not sent" by the
    service (dropped), so use "" (not null) to clear.
    """

    first_name: str | None = Field(default=None, min_length=1, max_length=100)
    last_name: str | None = Field(default=None, min_length=1, max_length=100)
    timezone: str | None = Field(default=None, min_length=1, max_length=50)
    language: str | None = Field(default=None, min_length=1, max_length=5)
    onboarding_completed: bool | None = Field(default=None)
    # Master-zone onboarding flag (E15). Same JSONB write path and null
    # semantics as onboarding_completed: only true/false accepted, "not
    # sent" / null leave it untouched.
    master_onboarding_completed: bool | None = Field(default=None)
    # Empty string allowed (clear). Cap only; soft format check below.
    phone: str | None = Field(default=None, max_length=20)
    bio: str | None = Field(default=None, max_length=2000)
    # Email (E11). Same "" clears / null untouched semantics as phone/bio;
    # soft-validated below. Stored in credentials JSONB (no column).
    email: str | None = Field(default=None, max_length=254)
    # NOTE: BOTH notification stores are deliberately ABSENT from this model.
    # `notifications` (the four-key user store) went with T-26 set 1;
    # `master_notifications` (nine toggles + schedule) with set 2 -- the master
    # screen stopped writing it on 2026-08-07 and this endpoint kept accepting
    # writes nothing read. Both live in comms now, written through
    # PUT /api/v1/notifications/prefs, never here.
    # This model does NOT set extra="forbid" (nothing in this file does), so a
    # stale cached frontend that still PATCHes either key is SILENTLY IGNORED
    # rather than 422'd. Stated because it is load-bearing for a Mini App whose
    # bundle is cached on the device: the old screen degrades to a no-op instead
    # of erroring, and nothing is written anywhere.

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, v: str | None) -> str | None:
        """Soft, international-friendly phone validation.

        Intentionally permissive: we serve users across many timezones, not
        only one country, so we do not enforce a single national format. We
        only guard against obviously bad input.

        Rules (applied to a non-empty value):
          - allowed characters: digits, spaces, and + ( ) -
          - must contain at least 5 digits (a plausible phone)
          - length is already capped at 20 by the Field max_length

        An empty string is allowed and means "clear the phone".
        None means "not provided" and is left untouched by the service.
        """
        if v is None or v == "":
            return v
        allowed = set("0123456789 +()-")
        if not set(v).issubset(allowed):
            raise ValueError(
                "Phone may contain only digits, spaces and + ( ) - characters"
            )
        digit_count = sum(ch.isdigit() for ch in v)
        if digit_count < 5:
            raise ValueError("Phone must contain at least 5 digits")
        return v

    @field_validator("email")
    @classmethod
    def validate_email_field(cls, v: str | None) -> str | None:
        """Soft email validation (E11).

        An empty string clears the field; None leaves it untouched. A
        non-empty value must parse as an email (deliverability not checked --
        we do not do network MX lookups on a profile save).
        """
        if v is None or v == "":
            return v
        try:
            validate_email(v, check_deliverability=False)
        except EmailNotValidError as e:
            raise ValueError("Invalid email address") from e
        return v

    @field_validator("timezone", "language", mode="before")
    @classmethod
    def _reject_null_for_required_fields(cls, v: str | None) -> str | None:
        """Reject explicit null for NOT NULL DB columns.

        timezone and language have server defaults ("UTC", "en") but
        cannot be set to NULL. Sending null would cause IntegrityError.
        """
        if v is None:
            raise ValueError("This field cannot be set to null")
        return v

    @field_validator("timezone")
    @classmethod
    def validate_timezone(cls, v: str | None) -> str | None:
        """Validate timezone is a valid IANA timezone identifier.

        Runs after _reject_null_for_required_fields (mode="before"),
        so v is guaranteed to be a non-None string here.
        """
        if v is None:
            return v
        try:
            ZoneInfo(v)
        except (ZoneInfoNotFoundError, KeyError):
            raise ValueError(
                f"Invalid IANA timezone: '{v}'. "
                "Examples: 'UTC', 'Europe/Moscow', 'America/New_York'"
            ) from None
        return v


class RoleSwitchRequest(BaseModel):
    """POST /api/v1/users/me/role — target role to switch into.

    A production endpoint (always on; A1=Б). Pydantic validates `role` against
    UserRole (user/master/admin); anything else is a 422. Whether the caller
    may actually switch to it is enforced in the service via
    derive_allowed_roles() -- the capability-derived policy (own role + a
    VERIFIED MasterProfile + the switched-away-admin marker), the single source
    of truth shared with the GET /users/me read path. Legacy seeded
    credentials.role_switch.allowed_roles lists grant nothing.
    """

    role: UserRole
