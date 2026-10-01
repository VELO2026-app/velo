# =============================================================================
# VELO Backend -- Shared rate-limit primitives (BE-66)
# =============================================================================
#
# ONE implementation of the fixed-window counter and of "which sources may be
# limited at all", shared by auth (auth/service.py) and the anonymous guest
# path (practices/router.py). Before BE-66 the counter lived inline in auth
# twice; a second hand-rolled copy for the guest path would have been the
# third, and BE-44 is the fourth caller waiting.
#
# Two lessons are encoded here, both paid for:
#
# 1. TTL ON THE FIRST INCREMENT ONLY. Setting it on every request slides the
#    window forward with each hit, and the limit never triggers -- the
#    "eternal rate limit" BE-44 names.
#
# 2. A SOURCE THAT IS NOT A ROUTABLE PUBLIC ADDRESS IS NOT LIMITED -- it is
#    passed, never keyed. Keyed on every address, the first per-source
#    limiter put the whole backend suite (644 logins from 127.0.0.1) into one
#    bucket and turned it red. Loopback and private addresses are our own
#    infrastructure showing through: the test client, a health check, the
#    nginx peer used when X-Forwarded-For is absent. Limiting on them bounds
#    no attacker; it shares one counter between everybody it cannot tell
#    apart.
#
#    Named honestly, the failure mode this leaves: if nginx stopped setting
#    X-Forwarded-For, every request would resolve to the proxy's private
#    address and every per-source limit would silently stop applying. That
#    is a degradation to OFF, chosen deliberately over a degradation to
#    OUTAGE (one shared bucket for every client at once). Between a control
#    that stops helping and a control that takes the service down, these may
#    only do the former.
#
# WHAT A PER-SOURCE LIMIT IS WORTH TODAY. The source is the first hop of
# X-Forwarded-For as resolved by core/middleware.py, and that first hop is
# written by the client until BE-40 lands. Until then a caller who varies the
# header gets a fresh bucket per request. These primitives are correct; the
# key they are handed is not yet trustworthy.
#
# REDIS FAILURES ARE NOT SWALLOWED HERE. Whether a limiter fails open or
# closed is the caller's decision -- auth and the guest path decide
# differently, for different reasons, each documented at its call site.
# =============================================================================

import ipaddress

import redis.asyncio as aioredis

from app.core.redis import get_redis


def limitable_source(source: str | None) -> bool:
    """True only for a routable public address -- the one kind of source a
    per-source limit may key on (lesson 2 above).

    None (no client in scope), a value that is not an address at all, and
    every non-global address -- loopback, private, link-local, and the
    documentation ranges such as 203.0.113.0/24 -- are passed, not limited.
    """
    if not source:
        return False
    try:
        return ipaddress.ip_address(source).is_global
    except ValueError:
        # Not an address -- the middleware should never produce this, and
        # guessing at a key for it is exactly what lesson 2 forbids.
        return False


async def count_in_window(
    redis: aioredis.Redis, key: str, window_seconds: int,
) -> int:
    """Increment `key`'s fixed-window counter and return the new count.

    The TTL is set on the FIRST increment only (lesson 1): the window is
    anchored at the first hit and expires whole, never slid forward.

    `redis` is passed in rather than looked up so each caller keeps its own
    client lookup (auth's tests patch auth.service.get_redis). Redis errors
    propagate -- fail-open or fail-closed is the caller's call.
    """
    count = await redis.incr(key)
    if count == 1:
        await redis.expire(key, window_seconds)
    return count


async def over_source_limit(
    bucket: str, source: str | None, *, limit: int, window_seconds: int,
) -> tuple[bool, int]:
    """Count one hit for `source` in `bucket`; (over the limit?, count).

    A source that is not limitable_source() is never counted and never
    over: (False, 0), and no key is written. Redis errors propagate.
    """
    if not limitable_source(source):
        return False, 0
    count = await count_in_window(
        get_redis(), f"{bucket}:{source}", window_seconds,
    )
    return count > limit, count
