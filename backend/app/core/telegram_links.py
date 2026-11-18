# =============================================================================
# VELO Backend -- Telegram link host normalization (2026-07-14)
# =============================================================================
#
# WHY THIS EXISTS:
#   On 2026-07-13 the t.me domain stopped resolving worldwide: the .me registry
#   (Montenegro) pulled its delegation, so it is NXDOMAIN -- not a regional
#   block, not a firewall. Everything pointing at t.me died at once:
#     - notification deep links + master invite links (built from TELEGRAM_BOT_URL)
#     - every user avatar (Telegram hands us photo_url as
#       "https://t.me/i/userpic/320/<hash>.svg" inside initData)
#
#   Telegram serves the SAME content under several equivalent hosts -- see
#   https://core.telegram.org/api/links, which states that t.me may also be
#   telegram.me or telegram.dog. So the fix is a HOST SWAP: path and query are
#   already correct and stay untouched.
#
# THE POINT OF THIS MODULE:
#   It is the ONE place in the backend that knows which host is currently
#   alive: TELEGRAM_LINK_DOMAIN below. Both config (TELEGRAM_BOT_URL,
#   normalized once at startup in config.py) and data (photo_url, normalized
#   on every login in auth/service.py) flow through normalize_telegram_url().
#
#   When the next host dies: change TELEGRAM_LINK_DOMAIN -- and nothing else
#   in the codebase. A constant, not a setting (BE-192): which Telegram host
#   is alive is a fact about Telegram, the same for every instance, and it
#   ships with the code.
# =============================================================================

from urllib.parse import urlsplit, urlunsplit

# Hosts Telegram treats as aliases of one another. Any of them can reach us
# either from a seam value (TELEGRAM_BOT_URL) or from Telegram itself
# (initData photo_url), so all of them are candidates for rewriting.
#
# t.me         -- dead since 2026-07-13 (registry-level, worldwide)
# telegram.me  -- alive, current default (verified: serves /i/userpic/, 200)
# telegram.dog -- alive, in a different TLD than .me -- the escape hatch if the
#                 Montenegrin registry ever takes telegram.me down as well
TELEGRAM_LINK_HOSTS: frozenset[str] = frozenset(
    {
        "t.me",
        "telegram.me",
        "telegram.dog",
    }
)

# The host every Telegram link and avatar URL is rewritten onto. If telegram.me
# dies too, telegram.dog (another TLD, not subject to the .me registry).
TELEGRAM_LINK_DOMAIN = "telegram.me"


def normalize_telegram_url(url: str | None, live_host: str) -> str | None:
    """Rewrite a Telegram link/avatar URL onto the host that is currently alive.

    Only known Telegram alias hosts are rewritten. Anything else -- a custom
    avatar URL, an empty string, None -- passes through untouched, so this is
    safe to apply blindly to any URL that may or may not come from Telegram.

    Args:
        url: URL to normalize, e.g. "https://t.me/i/userpic/320/abc.svg".
        live_host: Host currently serving Telegram links
            (TELEGRAM_LINK_DOMAIN), e.g. "telegram.me".

    Returns:
        The same URL with its host swapped for live_host, or the input
        unchanged if there is nothing to rewrite.

    Examples:
        >>> normalize_telegram_url("https://t.me/velobot?startapp=x", "telegram.me")
        'https://telegram.me/velobot?startapp=x'
        >>> normalize_telegram_url("https://cdn.example.com/a.jpg", "telegram.me")
        'https://cdn.example.com/a.jpg'
    """
    if not url or not live_host:
        return url

    parts = urlsplit(url)
    host = parts.netloc.lower()

    # Not a Telegram alias, or already on the live host -- leave it alone.
    if host not in TELEGRAM_LINK_HOSTS or host == live_host.lower():
        return url

    return urlunsplit(parts._replace(netloc=live_host))
