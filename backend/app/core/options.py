# =============================================================================
# VELO Backend -- what an instance option closes when it is off (BE-182)
# =============================================================================
#
# The passport turns velo's options on or off (protocol 5.2.3); the code
# learns of an option ONLY from its flag (Settings.option_<name>). One form
# closes the endpoints of an option that is off: require_option(name), a
# FastAPI dependency answering 404 with no machine code -- on the router for
# a whole module, on the endpoint for a single one. 404, not 503: with the
# option off the endpoint does not exist on this instance, indistinguishable
# from a build that never had it; the reasons are written out at
# the schools gate in schools/router.py. A router-level
# dependency runs before the path dependencies, so an unauthenticated caller
# gets 404 too.
#
# WHAT EACH OPTION CLOSES (tests/test_options.py derives the lists from the
# routers and holds every endpoint to them):
#   payments  the routers of payments, the Stripe webhook, purchases (two),
#             withdrawals, promos and the master's finance; a practice may
#             not BECOME paid (practices/service.py, _enforce_pricing).
#             Money already in the ledger keeps moving inside velo (a refund
#             on cancel, earnings on finalize).
#   schools   both school routers; the 'schools' audience goes dark
#             (practices/audience_service.py, practices/service.py,
#             schools/service.py -- the reads of the flag there).
#   mcp       the token router; /mcp and the OAuth door (door_closed,
#             mcp/server.py).
#   zoom      no meeting is made (zoom/service.py, practices/
#             series_service.py), the Zoom pollers do not start (main.py),
#             the master's retry and the SDK entry answer 404, and
#             zoom_client refuses as a backstop.
#   llm       voice transcription and the support translation retry answer
#             404; no translation is queued and the listener's translation
#             sweep is skipped (support/translation.py).
#   telegram  nothing: it is in options_required, and the machine never
#             starts velo with it off.
# =============================================================================

from collections.abc import Callable

from fastapi import Depends

from app.core.config import OPTIONS, settings
from app.core.exceptions import NotFoundError


def require_option(name: str) -> Callable[[], None]:
    """The dependency that answers 404 while the option `name` is off."""
    if name not in OPTIONS:
        raise KeyError(f"not an option of velo: {name!r}")

    def option_required() -> None:
        if not settings.option_on(name):
            raise NotFoundError("Not found")

    option_required.__name__ = f"require_option_{name}"
    option_required.option = name  # type: ignore[attr-defined]
    return option_required


def option_dependency(name: str) -> object:
    """require_option wrapped for `dependencies=[...]`."""
    return Depends(require_option(name))
