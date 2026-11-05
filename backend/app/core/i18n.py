# =============================================================================
# VELO Backend -- Language normalization (Phase 6 / T1)
# =============================================================================
#
# The SOLE heritage of modules/notifications (integration design ID-1:
# the module is cut out whole; normalize_language moves here because
# auth needs it for identity, not for delivery). Notification
# templates, locales, and rendering now live in comms (the VELO
# profile, comms-profile/); THIS list is velo's identity-locale
# whitelist -- what User.language may hold and what the T0 sync ships
# to comms as `locale`.
#
# Ported from the donor (modules/notifications/template_engine.py,
# Phase 7.3) with the same semantics; the set itself is the product's
# languages since BE-188 (below).
# =============================================================================

# The product's languages (BE-188, owner ruling 2026-11-03; PRIMER-PROTOCOL
# v1.7 5.2.2: the product declares every language it can do). Exactly the
# frontend's catalogs (frontend/src/locales/: en, ru, uk). Any other code --
# de and es included, which this list used to hold without a catalog behind
# them -- normalizes to DEFAULT_LANGUAGE. PATCH /users/me accepts exactly
# these (users/schemas.py). The instance's subset of them is BE-196.
SUPPORTED_LANGUAGES = frozenset({"en", "ru", "uk"})

# Default fallback language.
DEFAULT_LANGUAGE = "en"


def normalize_language(lang: str | None) -> str:
    """Normalize language code to a supported value.

    Handles cases like "en-US" -> "en", "RU" -> "ru", "de" -> "en",
    None -> "en".
    """
    if not lang:
        return DEFAULT_LANGUAGE

    # Take first 2 chars (handles "en-US", "pt-BR", etc.).
    short = lang[:2].lower()

    if short in SUPPORTED_LANGUAGES:
        return short

    return DEFAULT_LANGUAGE
