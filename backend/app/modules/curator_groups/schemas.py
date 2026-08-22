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
