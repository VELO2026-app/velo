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
# =============================================================================

import re
from datetime import datetime
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from email_validator import EmailNotValidError, validate_email
from pydantic import BaseModel, Field, computed_field, field_validator

from app.modules.users.models import UserRole

# Notification preference keys and their defaults (all ON).
# Stored as a nested object under credentials["notifications"]. Push delivery
# is NOT wired yet -- these flags are a forward-looking preference store; the
# UI lets the user set them and they survive relogin, ready for when push and
# the messages module land. Adding a 5th toggle = one entry here.
_NOTIFICATION_DEFAULTS: dict[str, bool] = {
    "push": True,
    "practice_reminders": True,
    "master_messages": True,
    "support_messages": True,
}


class NotificationSettings(BaseModel):
    """User notification preferences (nested under credentials.notifications).

    All flags default to True. Used both as the typed shape returned inside
    UserResponse.notifications and as the optional update payload in
    UserUpdate (where every field is optional for partial updates).
    """

    push: bool = True
    practice_reminders: bool = True
    master_messages: bool = True
    support_messages: bool = True


class NotificationSettingsUpdate(BaseModel):
    """Partial update for notification preferences.

    Every field optional: only the toggles the user flipped are sent. The
    service merges them onto the stored object so untouched flags are kept.
    """

    push: bool | None = None
    practice_reminders: bool | None = None
    master_messages: bool | None = None
    support_messages: bool | None = None


# =============================================================================
# Master notification preferences (E8 contract)
# =============================================================================
#
# The MASTER notifications screen (separate from the frozen 4-key USER screen
# above) carries nine on/off toggles grouped by area (bookings / participants /
# messages / analytics) plus a delivery `schedule`. It is persisted under
# credentials["master_notifications"] -- the SAME schema-on-read JSONB sandbox
# as credentials["notifications"], with the same defaults-merge-on-read +
# partial-merge-on-write mechanics. No migration.
#
# This is a forward-looking preference store: the flags persist and survive
# relogin, ready for delivery later. NOTHING is delivered off them yet (no
# push, no quiet-hours scheduler) -- that is a separate track.
#
# A master is ALSO a user, so a master reports BOTH `notifications` (4-key) and
# `master_notifications` (9-key + schedule); that is intended. Exposure of
# `master_notifications` in UserResponse is gated to MASTER CAPABILITY (the user
# has a verified MasterProfile) rather than a strict role==master check, so an
# admin who is also a verified master still sees the screen. That flag cannot be
# derived inside this schema (it needs the MasterProfile table), so the
# GET /users/me router computes it and sets the master_capability_in carrier
# below. The write path in UserUpdate is NOT gated -- a non-master may store the
# prefs, they simply stay hidden until the account gains master capability.
#
# Schema names are deliberately unique so they do not collide with the existing
# NotificationSettings(+Update) in OpenAPI / generated.ts.

# Nine toggle defaults: all True except monthly_report.
_MASTER_NOTIFICATION_DEFAULTS: dict[str, bool] = {
    "new_booking": True,
    "booking_cancelled": True,
    "reminder": True,
    "new_checkin": True,
    "new_feedback": True,
    "msg_participants": True,
    "msg_support": True,
    "ai_summary": True,
    "monthly_report": False,
}

# Schedule defaults (single source of truth, shared by the model field defaults
# and the schema-on-read merge in UserResponse.master_notifications). Keys use
# the wire names ("from"/"to"), i.e. the aliases -- see NotificationSchedule.
_NOTIFICATION_SCHEDULE_DEFAULTS: dict = {
    "from": "08:00",
    "to": "22:00",
    "days": ["mon", "tue", "wed", "thu", "fri"],
}

# Allowed weekday codes (string codes, NOT ISO ints).
_WEEKDAY_CODES: frozenset[str] = frozenset(
    {"mon", "tue", "wed", "thu", "fri", "sat", "sun"}
)

# "HH:MM" 24h, e.g. "08:00", "22:30", "00:00", "23:59".
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _validate_weekday_codes(value: list[str] | None) -> list[str] | None:
    """Reject unknown weekday codes (-> 422). Empty list is allowed.

    Shared by NotificationSchedule and NotificationScheduleUpdate so the rule
    lives in one place. None (field not sent on a partial update) passes
    through untouched. Order and duplicates are kept as sent -- only unknown
    codes are rejected.
    """
    if value is None:
        return value
    invalid = [d for d in value if d not in _WEEKDAY_CODES]
    if invalid:
        allowed = ", ".join(sorted(_WEEKDAY_CODES))
        raise ValueError(
            f"Unknown weekday code(s): {invalid}. Allowed: {allowed}"
        )
    return value


class NotificationSchedule(BaseModel):
    """Master delivery-window schedule (nested in master_notifications).

    RESPONSE shape: defaults are the operator-approved window (08:00-22:00,
    Mon-Fri). `from` is a Python keyword, so the field is `from_` aliased to
    "from" -- input accepts "from", output emits "from". Output-only: the read
    path in UserResponse sanitizes stored values before constructing this, so
    it never has to reject malformed data here.
    """

    from_: str = Field(default=_NOTIFICATION_SCHEDULE_DEFAULTS["from"], alias="from")
    to: str = Field(default=_NOTIFICATION_SCHEDULE_DEFAULTS["to"])
    days: list[str] = Field(
        default_factory=lambda: list(_NOTIFICATION_SCHEDULE_DEFAULTS["days"])
    )

    model_config = {"populate_by_name": True}


class NotificationScheduleUpdate(BaseModel):
    """Partial update for the master delivery-window schedule.

    Every field optional: only the sub-fields the client changed are sent and
    the service merges them onto the stored schedule (from/to overwrite; days
    replaces the list wholesale). "from"/"to" must be a 24h "HH:MM" string
    (else 422); each day code must be a known lowercase weekday (else 422), and
    an empty days list is allowed. `from` is aliased the same way as in
    NotificationSchedule.
    """

    from_: str | None = Field(default=None, alias="from")
    to: str | None = Field(default=None)
    days: list[str] | None = Field(default=None)

    model_config = {"populate_by_name": True}

    @field_validator("from_", "to")
    @classmethod
    def _validate_time(cls, v: str | None) -> str | None:
        """Reject anything that is not a 24h "HH:MM" string (-> 422)."""
        if v is None:
            return v
        if not _TIME_RE.match(v):
            raise ValueError(
                'Time must be a 24h "HH:MM" string, e.g. "08:00" or "22:30"'
            )
        return v

    @field_validator("days")
    @classmethod
    def _validate_days(cls, v: list[str] | None) -> list[str] | None:
        """Reject unknown weekday codes (-> 422). Empty list is allowed."""
        return _validate_weekday_codes(v)


class MasterNotificationSettings(BaseModel):
    """Master notification preferences (under credentials.master_notifications).

    Nine on/off toggles grouped by the master notifications screen (bookings /
    participants / messages / analytics) plus a delivery `schedule`. All
    toggles default True except monthly_report. RESPONSE shape returned inside
    UserResponse.master_notifications (only when role=master).
    """

    new_booking: bool = True
    booking_cancelled: bool = True
    reminder: bool = True
    new_checkin: bool = True
    new_feedback: bool = True
    msg_participants: bool = True
    msg_support: bool = True
    ai_summary: bool = True
    monthly_report: bool = False
    schedule: NotificationSchedule = Field(default_factory=NotificationSchedule)


class MasterNotificationSettingsUpdate(BaseModel):
    """Partial update for master notification preferences.

    Every toggle optional; `schedule` optional and itself partial. The service
    merges the sent toggles and schedule sub-fields onto the stored object so
    untouched preferences are kept. Used as the optional update payload in
    UserUpdate.
    """

    new_booking: bool | None = None
    booking_cancelled: bool | None = None
    reminder: bool | None = None
    new_checkin: bool | None = None
    new_feedback: bool | None = None
    msg_participants: bool | None = None
    msg_support: bool | None = None
    ai_summary: bool | None = None
    monthly_report: bool | None = None
    schedule: NotificationScheduleUpdate | None = None


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

    # Input-only carrier for the master_notifications capability gate. NOT read
    # from the ORM (no validation_alias) -- the GET /users/me router sets it
    # explicitly after model_validate, because deciding it requires a
    # MasterProfile lookup this schema cannot do. Excluded from output. Defaults
    # to False, so any UserResponse built without the router (e.g. an admin
    # user list) simply reports master_notifications=None.
    master_capability_in: bool = Field(default=False, exclude=True)

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
    def notifications(self) -> NotificationSettings:
        """Notification preferences, stored under credentials["notifications"].

        Schema-on-read: any stored keys are layered over the all-true defaults,
        so a user who has never touched the screen reports every toggle on, and
        a partial stored object (only some keys) still returns a full set.
        Unknown/legacy keys in the stored blob are ignored by the model.
        """
        stored = self.credentials_in.get("notifications")
        merged = dict(_NOTIFICATION_DEFAULTS)
        if isinstance(stored, dict):
            for key in _NOTIFICATION_DEFAULTS:
                if isinstance(stored.get(key), bool):
                    merged[key] = stored[key]
        return NotificationSettings(**merged)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def master_notifications(self) -> MasterNotificationSettings | None:
        """Master notification preferences, or None without master capability.

        Gated on master_capability_in (set by the GET /users/me router when the
        user has a verified MasterProfile) rather than a strict role check, so
        an admin who is also a verified master still gets the block. A master is
        also a user, so a capable user reports BOTH the 4-key `notifications`
        and this 9-key `master_notifications` (+ schedule). Without capability
        this is None and the block never ships.

        Schema-on-read, stored under credentials["master_notifications"]: stored
        toggles are layered over _MASTER_NOTIFICATION_DEFAULTS, and the nested
        schedule is layered over _NOTIFICATION_SCHEDULE_DEFAULTS field-by-field.
        Unknown / malformed stored values are ignored (defensive isinstance /
        format checks) so a hand-edited blob can never 500 a GET.
        """
        if not self.master_capability_in:
            return None

        stored = self.credentials_in.get("master_notifications")
        if not isinstance(stored, dict):
            stored = {}

        # Toggles: defaults, overlaid with stored bools only.
        merged = dict(_MASTER_NOTIFICATION_DEFAULTS)
        for key in _MASTER_NOTIFICATION_DEFAULTS:
            if isinstance(stored.get(key), bool):
                merged[key] = stored[key]

        # Schedule: defaults, overlaid field-by-field with VALID stored values.
        stored_schedule = stored.get("schedule")
        if not isinstance(stored_schedule, dict):
            stored_schedule = {}
        schedule = dict(_NOTIFICATION_SCHEDULE_DEFAULTS)
        raw_from = stored_schedule.get("from")
        if isinstance(raw_from, str) and _TIME_RE.match(raw_from):
            schedule["from"] = raw_from
        raw_to = stored_schedule.get("to")
        if isinstance(raw_to, str) and _TIME_RE.match(raw_to):
            schedule["to"] = raw_to
        raw_days = stored_schedule.get("days")
        if isinstance(raw_days, list) and all(
            isinstance(d, str) and d in _WEEKDAY_CODES for d in raw_days
        ):
            schedule["days"] = list(raw_days)

        return MasterNotificationSettings(
            **merged,
            schedule=NotificationSchedule(**schedule),
        )

    @computed_field  # type: ignore[prop-decorator]
    @property
    def role_switch(self) -> RoleSwitchInfo | None:
        """Self role-switch capability, or None when there is nothing to
        switch to.

        Derived by derive_allowed_roles() from the current role, the master
        capability (master_capability_in -- set by the router, same carrier
        the master_notifications gate uses) and the switched-away-admin
        marker. The old seeded credentials.role_switch.allowed_roles lists
        are IGNORED: capability, not seeding, decides (A1=Б).

        None when the derivation yields only USER, so plain users get no
        switch UI. Same carrier caveat as master_notifications: a
        UserResponse built outside the /users/me routers reports
        master_capability_in=False and may under-derive.
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
    # Notification preferences (nested object in credentials). Partial: only
    # the flipped toggles are sent; the service merges onto the stored object.
    # "Not sent" leaves all preferences untouched.
    notifications: NotificationSettingsUpdate | None = Field(default=None)
    # Master notification preferences (9 toggles + schedule, nested object in
    # credentials["master_notifications"]). Partial: only the flipped toggles
    # and changed schedule sub-fields are sent; the service deep-merges onto
    # the stored object (nested merge for schedule). NOT gated on write (stored
    # regardless of role/capability); exposure in UserResponse is gated to
    # master capability (a verified MasterProfile). "Not sent" leaves it
    # untouched.
    master_notifications: MasterNotificationSettingsUpdate | None = Field(
        default=None
    )

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
