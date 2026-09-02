# =============================================================================
# VELO Backend -- Curator Groups Schemas (P1, tz-curator-groups.md 5.2)
# =============================================================================
#
# EVERY schema in this module carries the CuratorGroup* prefix, including the
# paginated wrappers. Not decoration: these class names become the emitted
# type names in generated.ts at the next regen, and a bare `GroupResponse`
# here would collide with masters/groups_schemas.py's own -- the class of
# failure RenameGroupRequest is named after.
# =============================================================================

from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, StringConstraints

# strip_whitespace=True is a DELIBERATE divergence from GroupNameStr
# (masters/groups_schemas.py), which has min_length=1 without stripping.
# There, a name of a single space passes validation and is stored as " ".
# TZ 5.5 requires 422 for a blank/whitespace-only name, so the whitespace
# has to be gone BEFORE min_length is applied. The stripping also normalizes
# "  Школа  " to "Школа", which matches how description is normalized in the
# service and keeps the UNIQUE (curator_user_id, name) check meaningful --
# "Школа" and "Школа " would otherwise be two different names.
CuratorGroupNameStr = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)
]

# No min_length (unlike the name): the field is optional, and an empty or
# whitespace-only value is normalized to NULL in the service rather than
# rejected -- "" must never reach the column, so that "no description" has
# exactly one representation in the database.
CuratorGroupDescriptionStr = Annotated[str, StringConstraints(max_length=500)]

CuratorMemberKindLiteral = Literal["master", "student"]


class CreateCuratorGroupRequest(BaseModel):
    """POST /masters/me/curator-groups."""

    name: CuratorGroupNameStr
    description: CuratorGroupDescriptionStr | None = None


class UpdateCuratorGroupRequest(BaseModel):
    """PATCH /masters/me/curator-groups/{id}.

    `name` is always required -- a group always has one.

    `description` is a PARTIAL update. The router computes
    `"description" in body.model_dump(exclude_unset=True)` and passes it as
    description_provided, which is the only way to tell "the key was absent"
    (leave the column alone) from "the key was sent as null/empty" (write
    NULL). A bare `str | None = None` cannot distinguish the two and would
    wipe an existing description on every plain rename -- the exact bug
    RenameGroupRequest was rewritten to prevent.
    """

    name: CuratorGroupNameStr
    description: CuratorGroupDescriptionStr | None = None


class OfferCuratorGroupTransferRequest(BaseModel):
    """POST /masters/me/curator-groups/{id}/transfer.

    to_user_id only: the eligible set is the group's visible masters, and
    the service checks membership against exactly the roster it shows, so
    there is nothing else for the caller to state.
    """

    to_user_id: UUID


class CuratorGroupTransferRef(BaseModel):
    """A pending offer to hand the group over.

    ONE schema for all three places that report an offer (the curator's own
    row, that row after a PATCH, and the group page). Three flat triples of
    the same fields would drift the first time one of them gained a fourth.

    to_display_name uses display_name(first_name, last_name) from
    users/helpers.py, NOT the master-profile lookup _curator_display_name
    uses. The tree holds two different naming rules and this is a deliberate
    pick between them: the addressee here is a PERSON being offered
    something, not a public master card, and the profile-based rule may
    return None -- which would leave the confirm dialog reading "offer sent
    to —". display_name always yields something, falling back to the
    neutral «Участник».
    """

    to_user_id: UUID
    to_display_name: str
    requested_at: datetime


class CuratorGroupResponse(BaseModel):
    """One curator group, as its curator sees it.

    masters_count counts only VISIBLE masters -- members with kind='master'
    whose MasterProfile is verified right now (I-4). A suspended master keeps
    their row and disappears from this number until re-verification; the
    number and the roster's is_visible flag are computed from the same
    predicate, so they cannot disagree.

    students_count counts every kind='student' row. Visibility is a rule
    about masters; a student has no MasterProfile to be verified.

    `transfer` describes the group's pending hand-over, or null when there
    is none. Until GT-4 this field did not exist at all -- deliberately, so
    that a hardcoded null could not become a promise the frontend built on.
    It appears now BECAUSE it acquired a writer, which is the only reason a
    field ever should.

    PATCH returns this schema too, so renaming a group now reports the
    pending transfer alongside the new name. That is an intended widening,
    not a leak: one response shape has one field set, and the alternative --
    two flavours of CuratorGroupResponse, with and without -- is exactly the
    duplication CuratorGroupTransferRef exists to avoid. A rename does not
    touch the offer.
    """

    id: UUID
    name: str
    description: str | None
    masters_count: int
    students_count: int
    transfer: CuratorGroupTransferRef | None = None
    created_at: datetime


class CuratorGroupListResponse(BaseModel):
    """GET /masters/me/curator-groups.

    can_create_groups (GT-15) rides on the LIST, not on an item: it is a
    property of the master, not of any one school, and this is the screen
    where the "create a school" button lives -- so the frontend learns
    whether to offer it from the call it already makes, with no second
    request and no endpoint invented for one boolean.

    A plain bool with a false default, NOT bool | None: its neighbours
    upstream (curator_groups_count and the other admin counters) use null
    for "this row fell outside the batch", and a right has no such state --
    the profile is always in hand when this is answered. False here always
    means "no right", never "could not tell".
    """

    items: list[CuratorGroupResponse]
    can_create_groups: bool = False


class CuratorGroupMemberItem(BaseModel):
    """One row of a curator group's roster.

    is_visible is ALWAYS true for a student and reflects the live
    MasterProfile status for a master (I-4). The curator sees a suspended
    master as a row with is_visible=false -- "in the shadow" -- rather than
    watching them vanish, because the row is real and comes back by itself
    when the admin re-verifies.
    """

    user_id: UUID
    name: str
    avatar_url: str | None
    kind: CuratorMemberKindLiteral
    joined_at: datetime
    is_visible: bool


class PaginatedCuratorGroupMembersResponse(BaseModel):
    """GET /masters/me/curator-groups/{id}/members."""

    items: list[CuratorGroupMemberItem]
    total: int
    limit: int
    offset: int


# ===========================================================================
# The school journal (GT-16)
# ===========================================================================


class CuratorGroupEventActor(BaseModel):
    """Who did the thing, as the journal recorded them at the time.

    NOT NULLABLE, and that is a consequence of how the row is built rather
    than an optimism about the data. All thirteen event kinds are
    somebody's action, actor_id is NOT NULL, and the name is frozen INTO
    the row when the event is written -- so there is no state in which the
    journal knows an event happened but cannot say who did it. A `| None`
    here would be a branch the frontend has to handle and the backend
    cannot produce.

    display_name IS A SNAPSHOT, NOT A LOOKUP. It is whatever the person
    was called when they acted, and it does not follow later renames --
    deliberately: "Мария удалила Петра" is a record of the past and must
    keep saying Мария. See CuratorGroupEvent's docstring for the full
    argument, and do not replace this with a join to users.

    user_id is still the live handle: whoever reads the feed can go look
    the person up if they are still around.
    """

    user_id: UUID
    display_name: str


class CuratorGroupEventItem(BaseModel):
    """One line of a school's journal.

    `event` is a plain str, not a Literal over the thirteen kinds. The set
    is expected to grow -- notifications next, practice publication after
    that -- and a Literal here would turn every new backend event into a
    frontend type error before anyone had decided how to render it. The
    vocabulary lives in CuratorGroupEventKind; this field carries whatever
    the backend wrote.

    `data` is a free-form object whose keys depend on `event`. The contract
    per kind is tabulated in CuratorGroupEvent's docstring and is written
    down there rather than modelled here for the reason JSONB is JSONB:
    thirteen small nested schemas would have to be edited in lockstep with
    a table that is going to gain rows.

    NO seq. The ordering column is not exposed and must not be: it is
    globally monotonic across every school, so handing it to a curator
    would hand them a counter of platform-wide activity -- read the feed
    twice and the gap tells you how busy everyone else was. `id` is the
    UUID, which identifies without measuring.

    created_at answers WHEN this happened. It does NOT establish the order
    within one request: two events from a single PATCH share it to the
    byte. The response is already in order -- newest first -- and that
    order comes from a column the client never sees.
    """

    id: UUID
    event: str
    actor: CuratorGroupEventActor
    data: dict[str, Any]
    created_at: datetime


class PaginatedCuratorGroupEventsResponse(BaseModel):
    """GET /masters/me/curator-groups/{id}/journal."""

    items: list[CuratorGroupEventItem]
    total: int
    limit: int
    offset: int


# ===========================================================================
# Member-facing schemas (GT-2, tz-curator-groups.md 5.2 "Участник")
# ===========================================================================


CuratorGroupRelationLiteral = Literal["curator", "master", "student"]


class CuratorGroupCuratorRef(BaseModel):
    """The group's owner, as anyone in the group may see them.

    A strict subset of MasterPublicResponse -- the declared isolation
    boundary in masters/schemas.py. Nothing financial, nothing contact-like,
    and no status: a group is only ever visible while its curator is
    verified (I-6), so exposing the status would only ever print one value.
    """

    user_id: UUID
    display_name: str | None
    avatar_url: str | None


class CuratorGroupMineItem(BaseModel):
    """One row of GET /curator-groups/mine.

    `relation` is the viewer's own tie to this group and is what the
    frontend keys the row's chip off.

    `transfer_offered` is true ONLY for the person being offered the group,
    and it is a bool rather than the full ref on purpose: this is a list
    row, and everything the offer contains is already known to whoever it
    was made to. The curator sees false here even for their own pending
    offer -- the list says "somebody is waiting on YOU", and nobody is.
    Until GT-4 the field was absent because a field that is always false is
    a promise with no writer behind it.
    """

    id: UUID
    name: str
    description: str | None
    curator: CuratorGroupCuratorRef
    masters_count: int
    students_count: int
    relation: CuratorGroupRelationLiteral
    transfer_offered: bool = False


class CuratorGroupMineResponse(BaseModel):
    """GET /curator-groups/mine."""

    items: list[CuratorGroupMineItem]


class CuratorGroupViewer(BaseModel):
    """The requesting user's own tie to the group being viewed."""

    relation: CuratorGroupRelationLiteral


class CuratorGroupPageResponse(BaseModel):
    """GET /curator-groups/{id} -- the group as a member sees it.

    Deliberately NOT the same shape as CuratorGroupResponse (the curator's
    own row): that one is a management view keyed by ownership, this one
    carries `curator` and `viewer` because the reader is not necessarily
    the owner. Two shapes rather than one with half the fields null.

    `transfer` is filled for exactly two people -- the curator and the
    person being offered the group -- and is null for every other member
    (TZ 5.2). Null rather than an absent key: the field exists for everyone,
    only its value differs, which keeps one OpenAPI shape instead of two.
    A member who is not part of the deal learns nothing about it, not even
    that one is under way.
    """

    id: UUID
    name: str
    description: str | None
    curator: CuratorGroupCuratorRef
    masters_count: int
    students_count: int
    viewer: CuratorGroupViewer
    transfer: CuratorGroupTransferRef | None = None
    created_at: datetime


class CuratorGroupMasterItem(BaseModel):
    """One master in a group's roster.

    Fields are a STRICT SUBSET of MasterPublicResponse plus is_curator --
    the isolation boundary is reused, not restated. reviews_count is
    deliberately absent: the roster card does not show it, and it would cost
    a second aggregate per page for nothing.

    Only VISIBLE masters appear here (verified right now, I-4), so a
    suspended master-member drops out of the list and out of the total --
    the same predicate that drives masters_count, so the two cannot
    disagree.
    """

    user_id: UUID
    display_name: str | None
    avatar_url: str | None
    methods: list[str] = []
    experience_years: int | None
    practices_count: int
    is_curator: bool


class PaginatedCuratorGroupMastersResponse(BaseModel):
    """GET /curator-groups/{id}/masters.

    `total` counts the curator too: they lead the roster (I-2 keeps them out
    of curator_group_member, but they are the school's first master), so
    total == masters_count + 1 by construction.
    """

    items: list[CuratorGroupMasterItem]
    total: int
    limit: int
    offset: int


# ===========================================================================
# Invite + join schemas (GT-3, tz-curator-groups.md 5.2)
# ===========================================================================


CuratorInviteReasonLiteral = Literal[
    "already_member", "own_group", "master_required", "blocked_by_curator"
]


class CreateCuratorGroupInviteRequest(BaseModel):
    """POST /masters/me/curator-groups/{id}/invites."""

    kind: CuratorMemberKindLiteral


class CuratorGroupInviteResponse(BaseModel):
    """The group's reusable link for ONE kind.

    The kind is NOT encoded in the url: the deep link carries a single kind
    (`curator_group_invite__<token>`) for both flavours and the server
    resolves which one it is from the token (TZ 6.1). Putting it in the url
    too would be a second copy of the same fact, and the copy a sender could
    edit by hand.
    """

    kind: CuratorMemberKindLiteral
    invite_url: str


class CuratorGroupInvitePreviewGroup(BaseModel):
    """The card shown to someone who opened an invite link.

    curator_name is a STRING here, not the {user_id, display_name,
    avatar_url} object the group page returns: whoever is looking has no
    relation to the group yet, so they get the school's name and its
    curator's name, not a handle to go look the curator up with.
    """

    id: UUID
    name: str
    description: str | None
    curator_name: str | None
    masters_count: int
    students_count: int


class CuratorGroupInvitePreviewResponse(BaseModel):
    """GET /curator-groups/invites/{token}.

    This endpoint DESCRIBES a refusal instead of raising it: can_join=False
    plus a reason, so the screen can say why. The one exception is 404 --
    an unknown token, a revoked one, an inactive group and a deleted group
    are one answer (P-08), here as everywhere else.

    can_join answers "would joining CHANGE anything", not "are you allowed
    in the door". A student member opening a master link gets can_join=true
    with relation="student": they are already inside, and the link still has
    an effect (the upgrade). A master member opening either link gets
    can_join=false, reason=already_member -- nothing would happen.

    relation is the viewer's tie RIGHT NOW, before anything is done: null
    for someone who is not in the group yet.
    """

    group: CuratorGroupInvitePreviewGroup
    kind: CuratorMemberKindLiteral
    can_join: bool
    reason: CuratorInviteReasonLiteral | None
    relation: CuratorMemberKindLiteral | None


class JoinCuratorGroupRequest(BaseModel):
    """POST /curator-groups/join."""

    token: str


class JoinCuratorGroupResponse(BaseModel):
    """The outcome of joining.

    already_member answers exactly one question -- WAS THERE A ROW when this
    request looked -- and nothing else. It is not "nothing happened": a
    student who gets upgraded to master reports already_member=true with
    relation="master", because they were in the school before and still are,
    with a new kind. Reading it as "no-op" would make the field lie about
    someone who has been a member for months, which is why the definition
    lives here rather than in a caller's head. The nuance between "you were
    already a master" and "you were a student and just became a master"
    belongs to the preview, which distinguishes them; join reports facts.

    relation is the tie AFTER the call.
    """

    group_id: UUID
    relation: CuratorMemberKindLiteral
    already_member: bool


# ===========================================================================
# Advisory previews (P5/GT-12, tz-curator-groups.md 8.5)
# ===========================================================================
#
# ADVISORY, NOT A GATE. None of the three endpoints these back blocks
# anything: leaving (I-5), removing a member and deleting a school all work
# exactly as they did. They exist so the confirm dialog can say "N upcoming
# practices aimed at this school will go dark" instead of letting the person
# find out afterwards.


class CuratorGroupLeavePreviewResponse(BaseModel):
    """GET /curator-groups/{id}/leave-preview.

    How many of MY OWN upcoming practices target this school -- i.e. what I
    am about to switch off by walking out. A student always sees 0: they
    teach nothing, and that is a real answer rather than a reason to refuse
    the question.
    """

    upcoming_practices_targeting_group: int


class CuratorGroupRemovePreviewResponse(BaseModel):
    """GET /masters/me/curator-groups/{id}/members/{user_id}/remove-preview.

    The same number for the member the curator is about to remove. Zero for
    a student, and zero -- not 404 -- for somebody who is not in the group
    at all: the removal itself is idempotent and answers 204 on that same
    target, so the advisory must not be stricter than the action it
    describes.
    """

    upcoming_practices_targeting_group: int


class CuratorGroupDeletePreviewResponse(BaseModel):
    """GET /masters/me/curator-groups/{id}/delete-preview.

    What deleting the school costs: who is in it, and how many upcoming
    practices -- across EVERY master of the school, the curator included --
    are aimed at it. The counters are the same two the group page reports,
    from the same helper, so the dialog and the page cannot disagree.
    """

    masters_count: int
    students_count: int
    upcoming_practices_targeting_group: int
