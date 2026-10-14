# =============================================================================
# VELO Backend -- Canonical IANA time zone names (BE-157)
# =============================================================================
#
# The ONE place that decides which time zone names the backend stores. Every
# validator that accepts a zone (users UserUpdate, practices create / update)
# calls canonical_timezone() and stores what it returns.
#
# Why a name has to be rewritten at all: browsers and phones report zones
# under their own spelling. V8 (Chrome, Android WebView, Node) answers
# "Asia/Katmandu", "Asia/Calcutta", "Europe/Kiev" ... -- old names that IANA
# keeps only as links to "Asia/Kathmandu", "Asia/Kolkata", "Europe/Kyiv".
# Debian 13 moved those links out of the base tzdata package into the
# optional tzdata-legacy, and both images we run (python:3.12-slim for the
# backend, postgres:16 built --with-system-tzdata) are Debian 13 without it.
# A stored old name therefore fails in Postgres (func.timezone in the
# practice listing) and in every ZoneInfo() call without a fallback.
#
# Source of truth: tzdata.zi of the PINNED PyPI package `tzdata`
# (backend/pyproject.toml), not the image's /usr/share/zoneinfo -- the answer
# must not depend on which Debian the image happens to be built on.
#   Z <name> ...           -> a zone with its own rules
#   L <target> <alias>     -> <alias> is another name for <target>
#
# What is stored for a known name:
#   - a zone (Z)                                 -> itself
#   - a link that zone.tab lists as a country's
#     zone (Europe/Amsterdam, Atlantic/Reykjavik) -> itself. These are LIVING
#     names that IANA merged into a neighbour's rules; rewriting them would
#     store "Europe/Brussels" for a Dutch user and "Africa/Abidjan" for an
#     Icelandic one, and the picker would show the wrong city.
#   - "UTC"                                      -> itself (server default of
#     users.timezone, onboarding fallback; IANA has it as a link to Etc/UTC)
#   - any other link                             -> its target
# Anything else (unknown name, other case, padded with spaces, a directory
# such as "Asia", posix/... and right/... paths) is unknown: the validators
# turn it into 422.
#
# The set of names this module can return is canonical_timezone_names();
# tests/test_timezones_stand.py checks that every one of them is known to the
# Postgres the suite runs against (pg_timezone_names).
# =============================================================================

from importlib.resources import files

# Links kept as-is although zone.tab does not list them. See the header.
_KEPT_LINKS_OUTSIDE_ZONE_TAB = frozenset({"UTC"})


class UnknownTimezoneError(ValueError):
    """The name is neither a zone nor a link in the pinned tzdata."""


def _load() -> tuple[frozenset[str], dict[str, str]]:
    """Read tzdata.zi and zone.tab of the pinned package once per process.

    Returns (names stored as-is, alias -> target for the names rewritten).
    A missing package or file raises here, at import time, so a broken build
    fails the app's start-up instead of the first request.
    """
    data = files("tzdata").joinpath("zoneinfo")
    zones: set[str] = set()
    links: dict[str, str] = {}
    for line in data.joinpath("tzdata.zi").read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "Z":
            zones.add(parts[1])
        elif parts[0] == "L":
            links[parts[2]] = parts[1]
    country_zones = {
        line.split("\t")[2]
        for line in data.joinpath("zone.tab").read_text(encoding="utf-8").splitlines()
        if line and not line.startswith("#")
    }
    kept = {
        alias for alias in links
        if alias in country_zones or alias in _KEPT_LINKS_OUTSIDE_ZONE_TAB
    }
    if not zones or len(links) == len(kept):
        raise RuntimeError(
            "tzdata.zi of the pinned tzdata package has no zones or no links "
            "to rewrite -- the package is broken or its format changed"
        )
    rewritten = {
        alias: target for alias, target in links.items() if alias not in kept
    }
    return frozenset(zones | kept), rewritten


_STORED_AS_IS, _REWRITTEN = _load()


def canonical_timezone(name: str) -> str:
    """Return the name to store for an IANA time zone name.

    A zone, a country link of zone.tab or "UTC" comes back unchanged; any
    other link comes back as its target ("Asia/Katmandu" -> "Asia/Kathmandu").
    The match is exact: no case folding, no trimming.

    Raises UnknownTimezoneError (a ValueError) for any other string.
    """
    if name in _STORED_AS_IS:
        return name
    target = _REWRITTEN.get(name)
    if target is None:
        raise UnknownTimezoneError(name)
    return target


def canonical_timezone_names() -> frozenset[str]:
    """Every name canonical_timezone() can return."""
    return _STORED_AS_IS
