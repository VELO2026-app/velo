# =============================================================================
# VELO Backend -- Master Groups Schemas (P1, ПРОМТ №590)
# =============================================================================
#
# Request/response shapes for the group CRUD, membership, tag, and block
# endpoints (groups_router.py + the tag/block additions on students_router.py).
# =============================================================================

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, Field, StringConstraints

# Matches practices/taxonomy_models.py's LabelStr precedent (admin/taxonomy/
# schemas.py:19): non-empty, capped -- 422 on empty/too-long, NOT a custom
# exception. The DB column is String(100), same bound.
GroupNameStr = Annotated[str, StringConstraints(min_length=1, max_length=100)]
TagStr = Annotated[str, StringConstraints(min_length=1, max_length=100)]
# Owner Q4 (ПРОМТ №610): optional, so min_length is NOT set (unlike
# GroupNameStr) -- an empty/whitespace-only value is normalized to NULL in
# the service (create_group), never stored as "". 500 chars: a short
# under-the-name blurb, not a long-form Practice.description (5000).
GroupDescriptionStr = Annotated[str, StringConstraints(max_length=500)]


class GroupListItem(BaseModel):
    """One row in GET /masters/me/groups.

    id: uuid string for a custom group, or the literal "students" / "deleted"
        for the two virtual groups.
    kind: "students" | "deleted" | "custom".
    members_count: the derived/blocked/membership count respectively.
    """

    id: str
    kind: Literal["students", "deleted", "custom"]
    name: str
    members_count: int
    # Owner Q4 (ПРОМТ №610): always null for the two virtual groups
    # ("students"/"deleted" are not MasterGroup rows) and for any custom
    # group created before this field existed.
    description: str | None = None


class GroupListResponse(BaseModel):
    """GET /masters/me/groups."""

    items: list[GroupListItem]


class CreateGroupRequest(BaseModel):
    """POST /masters/me/groups."""

    name: GroupNameStr
    # Owner Q4 (ПРОМТ №610): optional. Blank/whitespace-only is normalized
    # to None server-side (create_group), never persisted as "".
    description: GroupDescriptionStr | None = None


class RenameGroupRequest(BaseModel):
    """PATCH /masters/me/groups/{id} -- rename AND/OR edit description
    (owner Q10, ПРОМТ №611; class name kept as-is despite now covering more
    than a rename -- renaming this Pydantic class would rename the emitted
    type in generated.ts at the next deploy regen, drifting the hand-written
    frontend types in api/groups.ts, the exact class of failure that red the
    gate on a prior feature).

    `name` is always required (a group always has one). `description` is a
    PARTIAL UPDATE, same contract as users/service.py's update_user() and
    admin/masters/admin_taxonomy's PATCH endpoints:
    body.model_dump(exclude_unset=True) at the router distinguishes "the
    key was absent" (leave the column untouched) from "the key was sent"
    (even as "" or whitespace -- normalized to NULL in rename_group(), same
    rule create_group() already applies). This is the fix for the exact gap
    ПРОМТ №610 itself flagged: a bare Optional[str]=None default could not
    tell those two cases apart and would have silently wiped an existing
    description on every plain rename.
    """

    name: GroupNameStr
    description: GroupDescriptionStr | None = None


class GroupResponse(BaseModel):
    """A single custom group (create/rename response)."""

    id: UUID
    name: str
    members_count: int
    description: str | None = None


class GroupMemberItem(BaseModel):
    """One row in GET /masters/me/groups/{id}/members.

    tag: this student's tag against the CURRENT master (master_student.tag),
         null if never tagged. Present regardless of which group (virtual or
         custom) is being listed -- the tag is a master<->student annotation,
         not a group property.
    """

    id: UUID
    name: str
    avatar_url: str | None
    tag: str | None


class PaginatedGroupMembersResponse(BaseModel):
    """GET /masters/me/groups/{id}/members -- paginated, searchable."""

    items: list[GroupMemberItem]
    total: int
    limit: int
    offset: int


class GroupSearchMemberItem(BaseModel):
    """One row in GET /masters/me/groups/search.

    ONE ROW PER (student, group) MEMBERSHIP, not one row per student
    (owner-ruled, ПРОМТ №606): a student who belongs to N of this master's
    CUSTOM groups appears N times here, each row naming a DIFFERENT group
    -- this is a membership-management surface, so the multiplicity IS the
    meaning, not noise to dedupe away. Never the two virtuals («Ученики»/
    «Удалённые») -- neither is a MasterGroupMembership row (mirrors
    list_student_custom_groups's identical exclusion).
    """

    student_user_id: UUID
    name: str
    avatar_url: str | None
    tag: str | None
    group_id: UUID
    group_name: str


class PaginatedGroupSearchResponse(BaseModel):
    """GET /masters/me/groups/search -- paginated, searchable."""

    items: list[GroupSearchMemberItem]
    total: int
    limit: int
    offset: int


class AddGroupMemberRequest(BaseModel):
    """POST /masters/me/groups/{id}/members."""

    student_user_id: UUID


class SetStudentTagRequest(BaseModel):
    """PUT /masters/me/students/{student_user_id}/tag.

    tag: null clears the tag (deletes the master_student row if it would
    otherwise be empty -- i.e. not blocked either).
    """

    tag: TagStr | None


class StudentTagResponse(BaseModel):
    """Response for the tag upsert/clear."""

    student_user_id: UUID
    tag: str | None


class BlockStudentResponse(BaseModel):
    """POST /masters/me/students/{student_user_id}/block.

    cancelled_bookings_count: how many FUTURE confirmed bookings on this
        master's practices were cancelled (and refunded via the reused
        refund_booking() path) as a side effect of the block.
    """

    student_user_id: UUID
    blocked_at: datetime
    cancelled_bookings_count: int


class DistinctTagsResponse(BaseModel):
    """GET /masters/me/tags -- P3 addendum (ПРОМТ №592), closes the P2
    tag-palette gap (P2 derived it client-side from the loaded page only)."""

    tags: list[str]


class StudentGroupItem(BaseModel):
    """One custom group in GET /masters/me/students/{id}/groups."""

    id: UUID
    name: str


class StudentGroupsResponse(BaseModel):
    """GET /masters/me/students/{student_user_id}/groups -- P3 addendum
    (ПРОМТ №592). The CUSTOM groups this student is in for this master
    (powers the profile's group chips). Virtual groups ("Ученики"/
    "Удалённые") are never listed here -- they aren't membership rows."""

    groups: list[StudentGroupItem]


# ===========================================================================
# P4 addenda (ПРОМТ №593): group invite links
# ===========================================================================


class GroupInviteResponse(BaseModel):
    """POST /masters/me/groups/{id}/invite -- create-or-return the group's
    reusable join link. Idempotent: repeat calls return the SAME url."""

    invite_url: str


class JoinGroupRequest(BaseModel):
    """POST /masters/groups/join -- the token from the group_invite__{token}
    deeplink. Same bound as ClaimMasterInviteRequest.token (masters/schemas.py)
    -- both are secrets.token_urlsafe(32) outputs."""

    token: str = Field(..., min_length=16, max_length=128)


class JoinGroupResponse(BaseModel):
    """POST /masters/groups/join -- the resolved group + its master, for the
    join confirmation screen."""

    group_id: UUID
    group_name: str
    master_name: str
