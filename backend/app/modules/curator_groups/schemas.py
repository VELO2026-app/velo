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
from typing import Annotated, Literal
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


class CuratorGroupResponse(BaseModel):
    """One curator group, as its curator sees it.

    masters_count counts only VISIBLE masters -- members with kind='master'
    whose MasterProfile is verified right now (I-4). A suspended master keeps
    their row and disappears from this number until re-verification; the
    number and the roster's is_visible flag are computed from the same
    predicate, so they cannot disagree.

    students_count counts every kind='student' row. Visibility is a rule
    about masters; a student has no MasterProfile to be verified.

    No `transfer` field here. TZ 5.2 lists one, and it is deliberately absent
    until GT-4 writes curator_group_transfer: a hardcoded `null` would be a
    field with no writer, which is a lie the frontend would build on.
    """

    id: UUID
    name: str
    description: str | None
    masters_count: int
    students_count: int
    created_at: datetime


class CuratorGroupListResponse(BaseModel):
    """GET /masters/me/curator-groups."""

    items: list[CuratorGroupResponse]


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
    frontend keys the row's chip off. No `transfer_offered` here: the
    transfer table has no writer until GT-4, and a field that is always
    false is a promise the UI would build on.
    """

    id: UUID
    name: str
    description: str | None
    curator: CuratorGroupCuratorRef
    masters_count: int
    students_count: int
    relation: CuratorGroupRelationLiteral


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
    """

    id: UUID
    name: str
    description: str | None
    curator: CuratorGroupCuratorRef
    masters_count: int
    students_count: int
    viewer: CuratorGroupViewer
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
