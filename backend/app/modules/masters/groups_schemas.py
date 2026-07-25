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


class GroupListResponse(BaseModel):
    """GET /masters/me/groups."""

    items: list[GroupListItem]


class CreateGroupRequest(BaseModel):
    """POST /masters/me/groups."""

    name: GroupNameStr


class RenameGroupRequest(BaseModel):
    """PATCH /masters/me/groups/{id}."""

    name: GroupNameStr


class GroupResponse(BaseModel):
    """A single custom group (create/rename response)."""

    id: UUID
    name: str
    members_count: int


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
