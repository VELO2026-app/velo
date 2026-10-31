# =============================================================================
# VELO Backend -- Tests: the API schema is not served (BE-114 item 2)
# =============================================================================
#
# No telegram_id is used here: nothing logs in, and no row is written.
#
# WHAT IS PINNED, and its pair. The owner's decision is "no Swagger
# outside": /openapi.json, /docs and /redoc answer 404 on every box. Each
# "not served" assertion stands next to a "still there" one, because a 404
# alone is also what a broken test client or an app with no routes returns:
#
#   - the same client gets a 200 from a route the app does serve (/health);
#   - app.openapi() still builds a non-empty schema in-process -- the input
#     of type generation (backend/scripts/dump_openapi.py) and of CI.
#
# The client here is in-process and arrives from loopback, i.e. the most
# "inside" a request can be. The closure is unconditional, so a 404 from
# here is a 404 from outside too; nothing in the app distinguishes them.
# =============================================================================

import pytest
from httpx import AsyncClient

from app.main import app

# The schema, its two viewers, and the viewer's OAuth helper page -- every
# path FastAPI would mount for them by default.
_SCHEMA_PATHS = ("/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc")


@pytest.mark.parametrize("path", _SCHEMA_PATHS)
async def test_the_schema_and_its_viewers_are_not_served(
    client: AsyncClient, path: str,
) -> None:
    """404, and nothing in the body that is a schema or a viewer page."""
    response = await client.get(path)

    assert response.status_code == 404
    body = response.text.lower()
    assert "openapi" not in body
    assert "swagger" not in body
    assert "redoc" not in body


async def test_the_same_client_still_reaches_a_served_route(
    client: AsyncClient,
) -> None:
    """The pair of the 404s: the app serves, it just does not serve the
    schema. Without this, the test above is green on a client that reaches
    nothing at all."""
    response = await client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"]


def test_the_schema_is_served_at_no_other_path_either() -> None:
    """The 404 test pins four fixed paths; a schema moved to a new path would
    pass it. FastAPI mounts the schema route only when openapi_url is set,
    and the viewers only when it is set too (fastapi.applications.setup), so
    this one attribute is the whole switch."""
    assert app.openapi_url is None


def test_the_schema_itself_is_still_built() -> None:
    """Not served is not gone: type generation and CI read app.openapi(),
    which FastAPI builds whether or not it is served."""
    schema = app.openapi()

    assert schema["paths"], "the schema lists no path"
    assert "/api/v1/ai/transcribe" in schema["paths"]
    assert schema["components"]["schemas"]
