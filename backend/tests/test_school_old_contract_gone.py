# =============================================================================
# VELO -- Tests: the old school contract is not answered (BE-90 step 2)
# =============================================================================
# Owner ruling 2026-11-01: addresses move to /schools with NO period of two
# prefixes, and the audience value 'curator_groups' becomes 'schools' with no
# alias. A client still holding the old forms is a REACHABLE state (a cached
# frontend, a bookmark, a script), so the refusal is asserted, each time next
# to the new form being accepted -- an absence alone would also pass on a
# router that had lost the new path too.
#
# No telegram ids: no user is created. The paths are refused before any
# dependency runs (no route matches), and the audience is refused by the
# request schema the endpoint validates with.
# =============================================================================

from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from pydantic import ValidationError

from app.modules.practices.schemas import CreatePracticeRequest

_OLD_AND_NEW = [
    ("/api/v1/curator-groups/mine", "/api/v1/schools/mine"),
    ("/api/v1/masters/me/curator-groups", "/api/v1/masters/me/schools"),
    ("/api/v1/admin/curator-groups", "/api/v1/admin/schools"),
]


@pytest.mark.asyncio
@pytest.mark.parametrize(("old", "new"), _OLD_AND_NEW)
async def test_the_old_prefix_is_not_a_route_and_the_new_one_is(
    client: AsyncClient, old: str, new: str,
):
    """No route matches the old prefix: 404 without authentication. The new
    one is a route: without authentication it refuses as a route does (401),
    not as a missing path."""
    gone = await client.get(old)
    assert gone.status_code == 404
    there = await client.get(new)
    assert there.status_code == 401


def _body(**overrides) -> dict:
    body: dict = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "be90",
        "description": "x",
        "scheduled_at": (datetime.now(UTC) + timedelta(hours=48)).isoformat(),
        "duration_minutes": 60,
        "timezone": "UTC",
        "max_participants": 20,
        "is_free": True,
        "price_cents": 0,
    }
    body.update(overrides)
    return body


def test_the_old_audience_value_is_refused_and_the_new_one_accepted():
    school = "00000000-0000-0000-0000-0000000be901"
    with pytest.raises(ValidationError):
        CreatePracticeRequest.model_validate(
            _body(audience_kind="curator_groups", school_id=school)
        )
    accepted = CreatePracticeRequest.model_validate(
        _body(audience_kind="schools", school_id=school)
    )
    assert accepted.audience_kind == "schools"
    assert str(accepted.school_id) == school
