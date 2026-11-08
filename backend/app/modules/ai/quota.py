# =============================================================================
# VELO Backend -- Per-person daily transcription quota (BE-67)
# =============================================================================
#
# WHAT IT BOUNDS. POST /api/v1/ai/transcribe is a PAID call: every request
# that reaches the provider is billed to our key. Authentication alone let one
# signed-in account spend the whole budget in a loop. This caps it at
# TRANSCRIPTION_DAILY_LIMIT transcriptions per person per UTC day (owner
# decision: 60; a constant since BE-192 -- the owner's number, the same on
# every instance).
#
# WHY HERE AND NOT IN transcription.py. That module hands the take to comms
# (BE-184), and comms knows the request key, not a person's budget: the
# quota is VELO's and lives at VELO's entry point -- the route -- whatever
# carries the take to the model.
#
# WHAT COUNTS. Every request that gets past authentication and the payload
# checks, counted BEFORE the take is handed on. A failed call is still paid
# for, so it still counts: a timeout, a provider error, and an answer with
# no speech all spend one unit. A take the storage refuses is counted too,
# although no model was asked -- the order of refusals puts the quota before
# the storage (see the route's docstring).
#
# THE DAY. A calendar day in UTC, the same boundary for everyone: the date is
# part of the key, so a new day is a new key and needs no clock arithmetic.
# For a reader in Moscow the count resets at 03:00 local time -- that is the
# owner's choice of boundary, not a gap.
#
# THE COUNTER. core/ratelimit.count_in_window: INCR and EXPIRE NX in one
# MULTI/EXEC. INCR is atomic in Redis, so two requests racing at the limit
# get two different counts and exactly one of them is refused. The TTL only
# disposes of yesterday's key; it is two days so it can never expire inside
# the day it counts.
#
# REDIS UNREACHABLE: the error propagates and the request answers 500
# internal_error -- the posture of the auth and sdk-join limiters. A paid
# path is not opened blind because its counter is down.
#
# KNOWN CEILING -- counters can be lost with Redis's data:
#   1. Mechanics: the counter lives only in Redis. Redis runs with
#      --appendonly yes on the velo_redis_data volume (docker-compose.yml),
#      so a restart keeps it; what loses it is the volume being wiped (a
#      reinstall's `docker compose down -v`) and, on a crash, the last
#      second of increments (Redis's default appendfsync everysec). After
#      such a loss every person has a fresh allowance for the rest of the
#      day -- at most one extra day's quota each.
#   2. Status: acknowledged by design.
#   3. Task: none -- the loss is bounded by one day's quota per person and
#      happens only on a reinstall or a crash.
#   4. Trigger: Redis stops being persisted (--appendonly removed or the
#      volume dropped from docker-compose.yml), or the provider bill shows
#      one person above the daily limit on a day without a reinstall.
#   5. Agreed fix form: a per-person, per-day counter row in Postgres.
#   6. Rejected: Postgres now -- a counter row per person and day is a row
#      every take of that person writes, so it needs a lock (an UPDATE ...
#      RETURNING) where Redis INCR is atomic, and two takes of one person
#      would queue on it; all that to buy back a loss of one day's quota
#      after a wipe. (Before BE-184 the reason was also that the endpoint
#      touched no database at all; since then the service writes one outbox
#      row per take, so that part no longer holds.)
# =============================================================================

from datetime import UTC, date, datetime
from uuid import UUID

import structlog

from app.core.exceptions import TooManyRequestsError
from app.core.ratelimit import count_in_window
from app.core.redis import get_redis

logger = structlog.get_logger()

# BE-67: transcriptions one person may make per UTC day (owner decision: 60).
# Counted before the provider is called, failed calls included.
TRANSCRIPTION_DAILY_LIMIT = 60

# Two days: longer than any day the key can count, so the key never expires
# while its date is still today. It only clears yesterday's key away.
QUOTA_KEY_TTL_SECONDS = 2 * 24 * 60 * 60


class TranscriptionQuotaExceededError(TooManyRequestsError):
    """The person used up today's transcriptions (429).

    Its own code, not the generic too_many_requests: the client turns it
    into one sentence the person can act on -- try again tomorrow.
    """

    def __init__(self) -> None:
        super().__init__(
            message="Daily transcription limit reached",
            code="transcription_quota_exceeded",
        )


def quota_key(user_id: UUID, day: date) -> str:
    """The Redis key counting one person's transcriptions on one UTC day."""
    return f"transcribe_quota:{user_id}:{day.isoformat()}"


async def consume_transcription_quota(
    user_id: UUID, *, now: datetime | None = None,
) -> None:
    """Count one transcription for `user_id` today, or refuse it.

    The unit is spent BEFORE the provider is called, and it stays spent
    whatever the call then does (module header: what counts). Over the
    limit the request is refused and the provider is never reached.

    `now` exists for tests; the route passes nothing and gets the clock.

    Raises:
        TranscriptionQuotaExceededError: today's limit is used up.
        redis.exceptions.RedisError / OSError: Redis is unreachable --
            propagated on purpose (fail closed, module header).
    """
    moment = now if now is not None else datetime.now(UTC)
    day = moment.astimezone(UTC).date()
    count = await count_in_window(
        get_redis(), quota_key(user_id, day), QUOTA_KEY_TTL_SECONDS,
    )
    if count > TRANSCRIPTION_DAILY_LIMIT:
        logger.warning(
            "transcription_quota_exceeded",
            user_id=str(user_id),
            count=count,
            limit=TRANSCRIPTION_DAILY_LIMIT,
        )
        raise TranscriptionQuotaExceededError()
