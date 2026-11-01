# =============================================================================
# VELO Backend -- Admin Curator Groups Schemas (P4, GT-9)
# =============================================================================
#
# Response shapes for the admin's read-only view of every school on the
# platform. tz-curator-groups.md 5.2 gives the admin six fields and no
# transfer: a hand-over is a deal between two people and the admin is not
# one of them (TZ 1), so a pending offer is deliberately absent here rather
# than shown "in the shadow".
# =============================================================================

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class AdminCuratorGroupCuratorRef(BaseModel):
    """The school's owner, as the admin list shows them.

    Two fields, not the member-facing three: the admin list is a table, and
    avatar_url would cost a column nobody reads at this density. The admin
    who needs more opens the master's own page.
    """

    user_id: UUID
    display_name: str


class AdminCuratorGroupListItem(BaseModel):
    """One school in the admin list.

    is_active IS A FIELD, NOT A FILTER, and this is the only place in the
    system where a frozen school is visible at all. For its own members an
    inactive group is indistinguishable from a deleted one (404, I-6) --
    which is right for them and useless for an admin, who is the person
    being asked "why has my school gone quiet". Both kinds live in one
    listing precisely so that question has an answer on screen.

    masters_count counts VISIBLE masters only (kind='master' whose profile
    is verified right now, I-4); students_count counts every kind='student'
    row. Same rule the group page reports, so the two cannot disagree about
    the same school.
    """

    id: UUID
    name: str
    curator: AdminCuratorGroupCuratorRef
    masters_count: int
    students_count: int
    is_active: bool
    created_at: datetime


class PaginatedAdminCuratorGroupsResponse(BaseModel):
    """GET /api/v1/admin/curator-groups."""

    items: list[AdminCuratorGroupListItem]
    total: int
    limit: int
    offset: int
