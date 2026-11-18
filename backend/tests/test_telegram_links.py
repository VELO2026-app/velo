# =============================================================================
# Test: Telegram link host normalization (2026-07-14, t.me registry takedown)
# =============================================================================
#
# Guards the single point in the backend that knows which Telegram host is
# alive (app/core/telegram_links.py):
#   - every known alias host (t.me / telegram.me / telegram.dog) is rewritten
#     onto the live host, whatever it happens to be;
#   - path + query survive untouched -- an avatar URL and a ?startapp= deep
#     link must both come out working, not just well-formed;
#   - anything that is NOT a Telegram host is left completely alone, so the
#     helper stays safe to apply blindly to any URL.
#
# The last two tests are the ones that matter operationally: they prove that
# swapping TELEGRAM_LINK_DOMAIN (core/telegram_links.py) is genuinely enough,
# so the next domain death costs one line of code rather than a hunt through
# the codebase.
# =============================================================================

import pytest

from app.core.telegram_links import (
    TELEGRAM_LINK_DOMAIN,
    TELEGRAM_LINK_HOSTS,
    normalize_telegram_url,
)

LIVE = "telegram.me"


def test_the_live_host_is_telegram_me() -> None:
    """BE-192: a constant of the code, one of the known aliases."""
    assert TELEGRAM_LINK_DOMAIN == LIVE
    assert TELEGRAM_LINK_DOMAIN in TELEGRAM_LINK_HOSTS


# ---------------------------------------------------------------------------
# Rewriting
# ---------------------------------------------------------------------------


def test_dead_host_is_rewritten() -> None:
    """The dead t.me host is swapped for the live one."""
    assert (
        normalize_telegram_url("https://t.me/veloappbot", LIVE)
        == "https://telegram.me/veloappbot"
    )


def test_avatar_path_and_extension_survive() -> None:
    """An initData photo_url keeps its full path -- only the host changes."""
    url = "https://t.me/i/userpic/320/DROKJgxW7KXlDqyhy.svg"
    assert (
        normalize_telegram_url(url, LIVE)
        == "https://telegram.me/i/userpic/320/DROKJgxW7KXlDqyhy.svg"
    )


def test_deep_link_query_survives() -> None:
    """A ?startapp= deep link keeps its query string -- only the host changes."""
    url = "https://t.me/veloappbot?startapp=open_practice__abc-123"
    assert (
        normalize_telegram_url(url, LIVE)
        == "https://telegram.me/veloappbot?startapp=open_practice__abc-123"
    )


@pytest.mark.parametrize("host", sorted(TELEGRAM_LINK_HOSTS))
def test_every_known_alias_is_rewritten(host: str) -> None:
    """Any known Telegram alias lands on the live host, including telegram.dog.

    This is what makes the escape hatch real: if telegram.me dies too,
    TELEGRAM_LINK_DOMAIN = "telegram.dog" rewrites everything, in either
    direction.
    """
    assert (
        normalize_telegram_url(f"https://{host}/veloappbot", LIVE)
        == "https://telegram.me/veloappbot"
    )


def test_live_host_is_configurable_not_hardcoded() -> None:
    """The target host is the caller's -- the helper hardcodes nothing.

    Proves a future domain swap is a one-line change: point
    TELEGRAM_LINK_DOMAIN elsewhere and every URL follows.
    """
    assert (
        normalize_telegram_url("https://t.me/veloappbot", "telegram.dog")
        == "https://telegram.dog/veloappbot"
    )


# ---------------------------------------------------------------------------
# Leaving things alone
# ---------------------------------------------------------------------------


def test_already_live_host_is_untouched() -> None:
    """A URL already on the live host passes through unchanged."""
    url = "https://telegram.me/veloappbot"
    assert normalize_telegram_url(url, LIVE) == url


def test_foreign_host_is_untouched() -> None:
    """A non-Telegram URL is never rewritten -- safe to apply blindly."""
    url = "https://cdn.example.com/i/userpic/320/avatar.svg"
    assert normalize_telegram_url(url, LIVE) == url


def test_lookalike_host_is_untouched() -> None:
    """A host that merely CONTAINS a known alias is not a known alias.

    Guards against a substring-matching implementation: "not-t.me.evil.com"
    must not be treated as Telegram.
    """
    url = "https://not-t.me.evil.com/steal"
    assert normalize_telegram_url(url, LIVE) == url


@pytest.mark.parametrize("empty", [None, ""])
def test_empty_input_passes_through(empty: str | None) -> None:
    """No photo_url (Telegram omits it when privacy settings forbid it)."""
    assert normalize_telegram_url(empty, LIVE) == empty


def test_empty_live_host_is_a_no_op() -> None:
    """A misconfigured (empty) live host must not corrupt the URL."""
    url = "https://t.me/veloappbot"
    assert normalize_telegram_url(url, "") == url
