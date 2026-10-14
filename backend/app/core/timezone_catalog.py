# =============================================================================
# VELO Backend -- Time zone catalog for the picker (BE-157)
# =============================================================================
#
# GET /api/v1/users/timezones serves this. The frontend timezone picker
# builds its rows from it instead of from the browser engine, because engines
# disagree: V8 lists and resolves old spellings ("Asia/Katmandu"), JavaScript-
# Core (Safari, WKWebView) returns a zone name as given and, depending on its
# version, lists old or new spellings. A picker comparing through Intl matched
# the saved zone on V8 and missed it in WKWebView.
#
#   names   -- every name the backend can store (canonical_timezone_names);
#              the picker's rows besides its curated ones, compared with ===.
#   aliases -- every other spelling the backend accepts -> the name it stores
#              (app/core/timezones.py); the picker adds them to the search
#              text of their target row ("katmandu", "kiev").
#   labels  -- Russian city and country names from CLDR (babel, pinned in
#              backend/pyproject.toml): the row caption where the curated
#              list has none, and search text ("катманду", "непал").
#
# All three come from the same data as the validators, so a row the picker
# shows is exactly a value PATCH /users/me stores unchanged.
# =============================================================================

from functools import cache

from babel import Locale
from babel.core import get_global

from app.core.timezones import canonical_timezone_names, timezone_aliases

# CLDR pseudo-territories: "001" (the world), "ZZ" (unknown region).
_NOT_A_COUNTRY = frozenset({"001", "ZZ"})


def _labels_ru() -> dict[str, tuple[str | None, str | None]]:
    """Russian (city, country) per storable name, from CLDR.

    CLDR keys its city names by ITS spelling of a zone, which is often the old
    one ("Asia/Katmandu" -> "Катманду"). Every spelling of a name is therefore
    tried: the name itself, the spellings the backend rewrites to it, and the
    spellings CLDR itself marks as aliases of it. No mapping is written here.
    A name with neither a city nor a country gets no entry.
    """
    ru = Locale("ru")
    territories = get_global("zone_territories")
    spellings: dict[str, set[str]] = {}
    for alias, target in [
        *timezone_aliases().items(),
        *get_global("zone_aliases").items(),
    ]:
        spellings.setdefault(target, set()).add(alias)

    labels: dict[str, tuple[str | None, str | None]] = {}
    for name in canonical_timezone_names():
        keys = [name, *sorted(spellings.get(name, set()) - {name})]
        city = next(
            (
                ru.time_zones[key]["city"]
                for key in keys
                if ru.time_zones.get(key, {}).get("city")
            ),
            None,
        )
        territory = next((territories[key] for key in keys if key in territories), None)
        country = (
            ru.territories.get(territory)
            if territory is not None and territory not in _NOT_A_COUNTRY
            else None
        )
        if city or country:
            labels[name] = (city, country)
    return labels


@cache
def timezone_catalog() -> dict:
    """The catalog body, built once per process (the data is pinned)."""
    return {
        "names": sorted(canonical_timezone_names()),
        "aliases": dict(sorted(timezone_aliases().items())),
        "labels": {
            name: {"city_ru": city, "country_ru": country}
            for name, (city, country) in sorted(_labels_ru().items())
        },
    }
