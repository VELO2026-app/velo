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
# Ported 1:1 from the donor (modules/notifications/template_engine.py,
# Phase 7.3) -- same values, same semantics.
# =============================================================================

# Languages the product supports for user identity ("en-US" -> "en").
SUPPORTED_LANGUAGES = frozenset({"en", "de", "es", "ru"})

# Default fallback language.
DEFAULT_LANGUAGE = "en"


def normalize_language(lang: str | None) -> str:
    """Normalize language code to a supported value.

    Handles cases like "en-US" -> "en", "DE" -> "de", None -> "en".
    """
    if not lang:
        return DEFAULT_LANGUAGE

    # Take first 2 chars (handles "en-US", "pt-BR", etc.).
    short = lang[:2].lower()

    if short in SUPPORTED_LANGUAGES:
        return short

    return DEFAULT_LANGUAGE
