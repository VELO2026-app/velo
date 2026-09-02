# =============================================================================
# VELO Backend -- Zoom Integration Models (E21 step A)
# =============================================================================
#
# Four tables. Three of them turn "booked" into "actually present, for how
# long" via Zoom, without trusting Zoom to tell us who the host is. The
# fourth (ZoomGuestName, GT-21) is deliberately OUTSIDE that purpose: it
# exists so a guest is not FACELESS in the participant list, and it is
# wired so that it can never feed the attendance decision -- see its own
# docstring.
#
# ZoomMeeting      -- 1:1 with Practice. Zoom's own meeting identity + our
#                     view of whether creation/sync last succeeded.
# ZoomRegistrant   -- 1 row per booking (role=student) PLUS one row per
#                     practice for the master (role=host, booking_id=NULL).
#                     We register the master through the SAME Zoom flow as
#                     students specifically so host-exclusion is OUR OWN
#                     explicit fact, not something we infer from any
#                     Zoom-provided field (there isn't one -- E21 research).
# ZoomGuestName    -- GT-21. 1 row per display name ISSUED to a guest on a
#                     practice. Not a person, not a booking, not a
#                     registrant we will ever judge -- just the record of
#                     which names are already taken on this practice, so
#                     the generator can avoid them.
# ZoomAttendanceSegment -- append-only, RAW report rows. Zoom returns
#                     MULTIPLE rows per person on rejoin and does not sum
#                     them; we do, in the attendance-decision step that
#                     lands after this one. No updated_at (immutable
#                     journal, same shape as UserLedger/MasterLedger in
#                     payments/models.py).
# =============================================================================

import enum
from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.core.mixins import JSONBMixin, TimestampMixin, UUIDMixin


class ZoomMeetingStatus(enum.StrEnum):
    """Lifecycle of our view of a practice's Zoom meeting.

    active            -- created successfully, zoom_meeting_id is usable.
    pending_creation   -- PROMPT №559: creation deliberately DEFERRED, never
                          attempted yet -- a series child beyond the nearest
                          occurrence (see series_service.py). Distinct from
                          create_failed on purpose: nothing has failed here,
                          so nothing must read as an error to a master
                          looking at a fresh series (requirement A). Picked
                          up by the same retry poller that handles
                          create_failed (retry_poller.py claims both).
    create_failed     -- creation (or a retry) failed; retry_count / last_sync_error
                          record why. The retry poller keeps trying until the cap.
    deleted           -- we deleted the Zoom-side meeting (practice cancelled
                          before it happened).
    """

    ACTIVE = "active"
    PENDING_CREATION = "pending_creation"
    CREATE_FAILED = "create_failed"
    DELETED = "deleted"


class ZoomRegistrantRole(enum.StrEnum):
    """Who this registrant row represents."""

    STUDENT = "student"
    HOST = "host"


class ZoomRegistrantStatus(enum.StrEnum):
    """Our own registrant status -- mirrors Zoom's registrant states, but is
    OURS: correctness of the attendance decision never depends on Zoom
    actually honoring a cancel (E21 plan sec 3 -- Zoom has no DELETE for
    registrants, only a status action, and whether a cancelled registrant's
    link stops working is unconfirmed).
    """

    PENDING = "pending"
    REGISTERED = "registered"
    CREATE_FAILED = "create_failed"
    CANCELLED = "cancelled"


class ZoomMeeting(UUIDMixin, TimestampMixin, Base):
    """One Zoom meeting per practice (1:1)."""

    __tablename__ = "zoom_meetings"

    practice_id: Mapped[UUID] = mapped_column(
        ForeignKey("practices.id", ondelete="CASCADE"),
        unique=True,
        index=True,
    )

    # Zoom's own identifiers. Nullable until creation succeeds.
    zoom_meeting_id: Mapped[str | None] = mapped_column(
        String(64), default=None,
    )
    # Zoom assigns a fresh UUID per run instance (relevant to report lookups
    # on restart) -- informational, not yet consumed by this step.
    zoom_meeting_uuid: Mapped[str | None] = mapped_column(
        String(64), default=None,
    )
    # Snapshot of host_id from the creation response. NOT currently read
    # anywhere (PK-Z1 audit, 2026-08-08) -- despite the name below, it
    # defends nothing today; ZoomRegistrant.role='host' is the mechanism
    # that actually excludes the host from attendance (see that model's
    # docstring). A CANDIDATE key for a second exclusion path, but wiring
    # one in rests on an unconfirmed premise -- whether Zoom's own report
    # returns the host's entry (made via start_url, not a registrant link)
    # in a form this field could match against. That premise is V1's open
    # question (board), not something to resolve here by guessing.
    host_zoom_user_id: Mapped[str | None] = mapped_column(
        String(64), default=None,
    )

    status: Mapped[str] = mapped_column(
        String(20),
        default=ZoomMeetingStatus.CREATE_FAILED.value,
        server_default=ZoomMeetingStatus.CREATE_FAILED.value,
    )
    # Attempts made by the retry poller. Capped at
    # settings.zoom_meeting_create_max_retries -- past the cap the row STAYS
    # status=create_failed (visibly failed), the poller just stops touching
    # it. Never silently retried forever, never silently given up on.
    retry_count: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0",
    )
    last_sync_error: Mapped[str | None] = mapped_column(Text, default=None)

    # E21 step F: set the moment the report poller successfully pulls this
    # meeting's report, regardless of whether any rows came back -- a
    # genuinely-empty result IS success. NULL means "not tried yet" or
    # "tried and Zoom errored", both retryable; distinguishes those from
    # "tried and got a real (possibly empty) answer", which is not
    # retried again. The undecided-bound fallback in the report poller
    # checks this stays NULL past a deadline before giving up on Zoom for
    # that meeting.
    report_ingested_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None,
    )

    # T24-38 (PROMPT №642): the SHARED, registration-free link -- a Zoom
    # registrant with NO human behind it, minted once per meeting so the
    # master can hand it to people outside the app. Deliberately COLUMNS
    # HERE, not a ZoomRegistrant row: attendance_service.ingest_report_for_
    # meeting queries ALL ZoomRegistrant rows for the meeting unconditionally
    # (select(ZoomRegistrant).where(zoom_meeting_id==...)) and matches report
    # rows against every one of them by zoom_registrant_id -- if this lived
    # in that table, every guest who joined through the shared link would
    # match it (method='registrant_id') instead of landing in the unmatched
    # bucket the owner ruled for them (AT-3). Living on ZoomMeeting instead
    # makes that outcome STRUCTURALLY impossible: this column is never
    # fed into match_report_rows, so a guest can never match anyone, host or
    # student, by construction -- not by a rule someone has to remember.
    # A deliberate temporary crutch (owner ruling) -- kept as its OWN two
    # nullable columns precisely so removal is a plain drop, never a
    # disentanglement from ZoomRegistrant/attendance code that must stay.
    shared_registrant_id: Mapped[str | None] = mapped_column(
        String(64), default=None,
    )
    shared_join_url: Mapped[str | None] = mapped_column(Text, default=None)

    def __repr__(self) -> str:
        return (
            f"<ZoomMeeting id={self.id} practice={self.practice_id} "
            f"status={self.status} zoom_id={self.zoom_meeting_id}>"
        )


class ZoomRegistrant(UUIDMixin, TimestampMixin, Base):
    """One registrant on a Zoom meeting -- a student's booking, or the
    practice's own master (role=host, booking_id NULL).

    registration_email is the email WE SENT to Zoom at registration time,
    frozen -- deliberately NOT re-derived from the user's current profile
    later, so the matching ladder (registrant_id -> email -> unmatched, next
    step) always compares against what Zoom actually has on file, even if
    the VELO user changes their email afterward.
    """

    __tablename__ = "zoom_registrants"

    zoom_meeting_id: Mapped[UUID] = mapped_column(
        ForeignKey("zoom_meetings.id", ondelete="CASCADE"),
        index=True,
    )
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )
    # NULL for the master's own host row -- the master isn't booking anything.
    booking_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("bookings.id", ondelete="SET NULL"),
        default=None,
    )

    role: Mapped[str] = mapped_column(
        String(10),
        default=ZoomRegistrantRole.STUDENT.value,
        server_default=ZoomRegistrantRole.STUDENT.value,
    )

    zoom_registrant_id: Mapped[str | None] = mapped_column(
        String(64), default=None,
    )
    registration_email: Mapped[str] = mapped_column(String(255))
    # Zoom sometimes omits the tokenized join_url from the create response
    # (E21 research); may be filled in later via a GET, or on reschedule
    # re-fetch (step D).
    join_url: Mapped[str | None] = mapped_column(Text, default=None)

    status: Mapped[str] = mapped_column(
        String(20),
        default=ZoomRegistrantStatus.PENDING.value,
        server_default=ZoomRegistrantStatus.PENDING.value,
    )

    # Retry bookkeeping (E21 step E, PROMPT №520) -- same shape and cap
    # convention as ZoomMeeting.retry_count / last_sync_error. Only the
    # retry poller increments retry_count; the initial attempt at booking
    # time does not.
    retry_count: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0",
    )
    last_sync_error: Mapped[str | None] = mapped_column(Text, default=None)

    __table_args__ = (
        # One ACTIVE registrant per (meeting, user) -- same partial-unique
        # shape as uq_booking_practice_user_active in bookings/models.py.
        # Historical/cancelled duplicates are allowed (e.g. re-registering
        # after a cancel-and-rebook).
        Index(
            "uq_zoom_registrant_meeting_user_active",
            "zoom_meeting_id",
            "user_id",
            unique=True,
            postgresql_where=text("status != 'cancelled'"),
        ),
    )

    def __repr__(self) -> str:
        return (
            f"<ZoomRegistrant id={self.id} meeting={self.zoom_meeting_id} "
            f"user={self.user_id} role={self.role} status={self.status}>"
        )


class ZoomGuestName(UUIDMixin, TimestampMixin, Base):
    """One display name ISSUED to one guest on one practice (GT-21).

    A guest entering through the public /z/{code} link used to join Zoom as
    ONE shared registrant per meeting ("VELO / Guest Link",
    ensure_shared_registrant) -- so a master with ten guests saw ten
    identical rows in his participant list and could not tell them apart.
    A row here is the record that a given name is TAKEN on a given
    practice, which is the one fact the name generator needs and the one
    thing a counter column could not have given it ("there are already 11
    Пылающих Шив" is a question about names, not about a count).

    SCOPED TO THE PRACTICE, NOT GLOBALLY (owner ruling): the only place a
    name has to be distinguishable is the participant list of one meeting.
    The same name on two different practices is fine and is asserted as
    such -- a global registry would need cross-practice counters and race
    handling to buy nothing.

    DELIBERATELY NOT A ZoomRegistrant ROW, for the same structural reason
    ZoomMeeting.shared_registrant_id is not one (see that column's
    docstring): attendance_service.ingest_report_for_meeting selects EVERY
    ZoomRegistrant of the meeting unconditionally and matches report rows
    against all of them. A guest living in that table would start matching
    by registrant_id, and the matcher would then decide bookings that do
    not exist. Living in a table the matcher never reads makes "a guest is
    never judged" structurally true rather than a rule someone must
    remember. zoom_registrant_id and join_url therefore live HERE, next to
    the name they were minted for, and nowhere else.

    NOT ATTENDANCE, AND NOT A PERSON: there is no user_id and there will be
    none. The guest is anonymous by construction (resolve_zoom_entry is
    called with user=None on both public routes), so there is nobody to
    point at; and a column that could point at somebody would be the first
    step back toward judging them.
    """

    __tablename__ = "zoom_guest_names"

    practice_id: Mapped[UUID] = mapped_column(
        ForeignKey("practices.id", ondelete="CASCADE"),
    )

    # Exactly the string that went to Zoom, after strip and truncation --
    # not a normalised or lowercased form. It is a display value; the point
    # of the whole feature is that the master sees what the guest chose.
    # String(64), not Text, because the length is a VALIDATED bound (1..64
    # after strip, owner ruling) and the truncation happens before the
    # insert, so an overflow here would mean a bug upstream rather than a
    # long name.
    display_name: Mapped[str] = mapped_column(String(64))

    # Zoom's own ids for the personal registrant minted under this name.
    # Nullable, and both stay NULL in a real, expected state: the name was
    # claimed (the row is what claims it) and Zoom then refused, or
    # returned a registrant_id with no join_url -- the shape
    # ZoomRegistrant.join_url's docstring already documents as real. Such a
    # row keeps the name reserved on purpose: reusing a name Zoom may or
    # may not have registered would be the one way to put two identical
    # guests back in the list.
    zoom_registrant_id: Mapped[str | None] = mapped_column(
        String(64), default=None,
    )
    join_url: Mapped[str | None] = mapped_column(Text, default=None)

    __table_args__ = (
        # No separate index on practice_id: this unique index LEADS with it
        # and every lookup here filters on practice_id first, so a second
        # one would be a duplicate -- same rule practice_audience_curator_
        # group was built with.
        #
        # KNOWN CEILING -- byte-exact uniqueness admits case-variant twins.
        # 1. MECHANICS: this index compares display_name byte for byte, so
        #    "Аня" and "аня" are two accepted rows on one practice, and the
        #    participant list then shows two names a human reads as one --
        #    the exact confusion this table exists to remove.
        # 2. STATUS: acknowledged by design.
        # 3. TASK: none, and deliberately none. The only input that can
        #    produce a case-variant twin is a human-typed name, and in
        #    GT-21 no surface can supply one: the /z/{code} page is
        #    server-rendered HTML with CSP `form-action 'none'` and no
        #    scripts, the frontend has no /z/ route at all, and drawing the
        #    field was ruled out of scope. Generated names are canonically
        #    cased by construction, so the generator itself can never
        #    collide case-only. Writing a task for a state no caller can
        #    reach would be documenting the impossible.
        # 4. THAW TRIGGER (observable): the first commit that lets a human
        #    supply a name -- a name field added to _public_page (which
        #    also has to relax form-action), or any client that calls
        #    /z/{code}/guest with user-typed text.
        # 5. AGREED FIX: replace this with a functional unique index on
        #    (practice_id, lower(display_name)) and lowercase the
        #    comparison in the claim path. One migration, no data to
        #    convert -- the database is disposable.
        # 6. ALREADY REJECTED, and why it must not be "fixed" these ways:
        #    (a) a case-insensitive collation on the column -- that changes
        #        comparison semantics for every future query against this
        #        table, not just for uniqueness; (b) lowercasing on write
        #        -- it destroys the guest's own capitalisation, which is
        #        the single value this feature exists to display; (c) the
        #        check in application code only -- two concurrent claims
        #        would both pass, and the guarantee would stop being
        #        structural, which is the whole reason this is a table and
        #        not a counter.
        Index(
            "uq_zoom_guest_names_practice_name",
            "practice_id",
            "display_name",
            unique=True,
        ),
    )

    def __repr__(self) -> str:
        return (
            f"<ZoomGuestName id={self.id} practice={self.practice_id} "
            f"name={self.display_name!r}>"
        )


class ZoomAttendanceSegment(JSONBMixin, UUIDMixin, Base):
    """One raw report row for one person's session, as Zoom returned it.

    Append-only / immutable -- no updated_at, same shape as UserLedger /
    MasterLedger (payments/models.py). A person who rejoins produces
    MULTIPLE rows here; Zoom does not sum them and neither does this table
    -- summing happens in the attendance-decision step that lands after
    this one, by reading every segment matched to a given registrant.

    matched_registrant_row_id is NULL for an unmatched participant -- that
    IS the unmatched bucket (E21 plan sec 6), not a separate table.
    """

    __tablename__ = "zoom_attendance_segments"

    zoom_meeting_id: Mapped[UUID] = mapped_column(
        ForeignKey("zoom_meetings.id", ondelete="CASCADE"),
        index=True,
    )
    matched_registrant_row_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("zoom_registrants.id", ondelete="SET NULL"),
        index=True,
        default=None,
    )
    match_method: Mapped[str | None] = mapped_column(
        String(20), default=None,
    )

    # Zoom's own registrant_id AS RETURNED on this row -- kept even blank,
    # for audit (the whole reason this project needed a live probe: whether
    # this field is populated for an unauthenticated joiner was contested).
    zoom_registrant_id_raw: Mapped[str | None] = mapped_column(
        String(64), default=None,
    )

    join_time: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None,
    )
    leave_time: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None,
    )
    duration_seconds: Mapped[int | None] = mapped_column(
        Integer, default=None,
    )

    # Full raw report row, for audit/debugging beyond the extracted columns
    # above. Mutate ONLY via set_jsonb (JSONBMixin) -- not touched after
    # insert in practice, since these rows are append-only.
    raw_row: Mapped[dict] = mapped_column(
        JSONB, default=dict, server_default="{}",
    )

    # Forward-compat slot: only "report" is written by this step's poller.
    source: Mapped[str] = mapped_column(
        String(20), default="report", server_default="report",
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        index=True,
    )

    def __repr__(self) -> str:
        return (
            f"<ZoomAttendanceSegment id={self.id} "
            f"meeting={self.zoom_meeting_id} "
            f"matched={self.matched_registrant_row_id}>"
        )
