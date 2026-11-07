# =============================================================================
# VELO Backend -- Application Configuration (BE-192: values of the deploy machine)
# =============================================================================
#
# HOW IT WORKS:
#   1. pydantic-settings reads the PROCESS ENVIRONMENT -- nothing else: there
#      is no .env file (PRIMER-PROTOCOL 5.1, values come only from the
#      instance's passport and from the machine, through compose).
#   2. Each field here maps to an environment variable (case-insensitive).
#   3. Pydantic validates types: a missing or malformed required value
#      crashes the app at startup with a clear error -- not at runtime when
#      a user triggers it.
#
# TWO KINDS OF FIELD:
#   - Instance values: no default. Each is a key of `app.environment` in
#     docker-compose.yml, which takes it from primer.yaml's `env` -- the
#     passport (server.role, domains.*), the machine (minted), a secret of
#     the passport (asked) or a seam of comms. test_primer_env.py holds the
#     three of them together.
#   - Code knobs: a default, and no key in compose -- on the machine they are
#     the code's values. A knob that has an owner's number and nothing else
#     is not even a field: TRANSCRIPTION_DAILY_LIMIT (modules/ai/quota.py),
#     SUPPORT_SPAM_RETENTION_DAYS (modules/support/purge.py),
#     TELEGRAM_LINK_DOMAIN (core/telegram_links.py),
#     MCP_OAUTH_CIMD_ALLOWED_HOSTS (modules/mcp/oauth.py).
#
# AN EXTRA KEY IS NOT REFUSED HERE. pydantic-settings looks up each field in
# the environment and ignores every other variable (extra='forbid' guards only
# a .env file, which no longer exists). A key that compose passes and this
# class does not read is caught before the process exists: by
# test_primer_env.py (every key of app.environment is a field) and by the
# machine (${VAR:?}, `pridem check`).
#
# ROLE (BE-192): SERVER_ROLE is the passport's server.role -- test, preview or
# prod. It alone decides the Stripe stub (test and preview). There is no
# development mode: a local run, CI and drift-check run as `test`.
# =============================================================================

import re
from typing import Literal

from pydantic import Field, PrivateAttr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.core.editions import EDITIONS
from app.core.i18n import SUPPORTED_LANGUAGES
from app.core.telegram_links import TELEGRAM_LINK_DOMAIN, normalize_telegram_url

# A host of the passport's domains.* (BE-192): a DNS name and nothing else --
# no scheme, port, path, query or userinfo. Labels of letters, digits and
# inner hyphens, 1-63 characters each, 253 at most in all.
_HOST_RE = re.compile(
    r"(?=.{1,253}\Z)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
    r"(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\Z"
)

# Roles of the passport (server.role) on which payments run on the Stripe
# stub: velo-test and previews. Never prod.
_STRIPE_STUB_ROLES = frozenset({"test", "preview"})

# The instance values that must not be empty, by environment name. pydantic
# refuses a missing one by itself; an empty string is a str and would pass.
_REQUIRED_NON_EMPTY = (
    "domain_frontend",
    "domain_api",
    "database_url",
    "telegram_bot_token",
    "zoom_account_id",
    "zoom_client_id",
    "zoom_client_secret",
    "zoom_sdk_client_id",
    "zoom_sdk_client_secret",
    "telegram_login_client_id",
    "telegram_login_client_secret",
)


class Settings(BaseSettings):
    """Application settings, loaded from environment variables.

    Each field corresponds to an env var. Pydantic handles:
    - Type conversion (str -> int, str -> bool)
    - Validation (missing required vars -> clear error at startup)
    - Defaults (optional vars get fallback values)
    """

    # -- Application --
    # The passport's server.role (BE-192). Anything else: refused at start.
    server_role: Literal["test", "preview", "prod"]
    # The passport's edition (BE-190): a key of app/core/editions.py's table,
    # reported in /health with its modules. Anything else: refused at start.
    edition: str

    # -- Database --
    # Full async connection string for SQLAlchemy, put together by compose
    # from the minted POSTGRES_PASSWORD.
    database_url: str

    # -- Redis --
    redis_url: str = "redis://localhost:6379/0"
    # Socket timeouts of the application's Redis client (BE-44). Redis sits
    # on the path of every authenticated request (the session lookup), and
    # without these a hung connection held each of those coroutines for
    # ever. A timeout surfaces as redis.exceptions.TimeoutError, a RedisError:
    # each caller then does what it already does on a Redis failure (see
    # core/redis.py). No command on this client blocks by design, so 2 s cuts
    # nothing legitimate; it matches the 2 s the health probe already allows.
    # The comms relay has its own client and its own pair
    # (comms_relay_socket_*_timeout_seconds).
    redis_socket_connect_timeout_seconds: float = 2.0
    redis_socket_timeout_seconds: float = 2.0

    # -- Domains (BE-192) --
    # The passport's domains.frontend and domains.api: HOSTS, not URLs. The
    # backend builds every origin from them itself (frontend_origin,
    # api_origin below): CORS, the return address of the browser sign-in,
    # the /z/{code} public links and the OAuth issuer. A value with a scheme,
    # port, path or anything but a DNS name is refused at start.
    domain_frontend: str
    domain_api: str

    # -- Telegram --
    # Bot token from BotFather -- verifies the Mini App's initData. A channel
    # in transition (protocol 11.2): required on every instance.
    telegram_bot_token: str
    # Bot URL for deep link buttons in notifications (Phase 7.3).
    # Example: "https://telegram.me/veloappbot"
    #
    # The host of this URL is normalized at startup (see the validator below):
    # a value still carrying the dead t.me host is repaired in memory, so a
    # domain swap does NOT require a new value from comms.
    telegram_bot_url: str = ""

    # -- Sessions --
    # How long a session token lives in Redis (days).
    session_ttl_days: int = 30

    # -- Master invites --
    # How long a generic one-time master invite link stays claimable
    # (seconds). Owner's decision, BE-44: 7 days. Before it the token had no
    # expiry, so a leaked link stayed valid until somebody claimed it. An
    # expired link answers exactly like a consumed one (404 invite_invalid).
    master_invite_ttl_seconds: int = 604800

    # -- Auth security (Phase 1 auth/service.py) --
    # Telegram initData validity window (seconds). Telegram signs initData
    # with auth_date; we reject tokens older than this threshold.
    # Also used as the Redis TTL for anti-replay protection (WARNING-4):
    # once initData is accepted, its hash is stored for this duration so
    # the same token cannot be reused within its validity window.
    auth_init_data_ttl_seconds: int = 300  # 5 minutes

    # Maximum allowed clock skew between client and server (seconds).
    # Rejects initData with auth_date set in the future beyond this tolerance.
    # Prevents tokens with a far-future auth_date from being valid indefinitely.
    auth_clock_skew_seconds: int = 60

    # Rate limiting for POST /auth/telegram (CRITICAL-4).
    # Prevents Redis OOM from session flooding via replayed valid initData.
    auth_rate_limit_max_requests: int = 5   # max attempts per window
    auth_rate_limit_window_seconds: int = 60  # rolling window duration

    # -- Logging --
    # CQ-06: INFO. DEBUG is refused at start on every instance (below).
    log_level: str = "INFO"

    # -- Practices (Phase 4.1/4.2/4.3) --
    practice_min_duration_minutes: int = 5
    practice_max_duration_minutes: int = 480

    # Allowed values for Practice.practice_type.
    # Validated in practices/schemas.py via @field_validator -- no Literal.
    # To add a new type: add it here, run migration, update frontend.
    practice_allowed_types: list[str] = [
        "live", "series", "one_on_one", "replay",
    ]

    # Accepted currency codes (lowercase ISO 4217).
    # MVP: EUR only. To add a currency: extend this list + update Stripe config.
    practice_allowed_currencies: list[str] = ["eur"]

    # -- Practice taxonomy (Calendar iteration, JSONB data.taxonomy) --
    # Catalog facets stored in Practice.data.taxonomy and used by the
    # Calendar filter. Schema-on-read: values live in JSONB for now,
    # validated against these lists -- no Literal.
    #
    # direction  -- content direction (Направление). Required on create.
    # difficulty -- difficulty level (Сложность). Required on create.
    # style      -- practice style (Вид практики). Optional, DIRECTION-CONDITIONAL
    #               since 2026-05-28: validated against
    #               practice_allowed_styles_by_direction[direction] and capped
    #               at practice_style_max_length.
    #
    # FRONT-FIRST 2026-05-28 (handoff §10 F-1): taxonomy went from 8 to 10
    # directions. New ones: circles / sound_healing / art / narrative / movement.
    # Migrated away (now styles): womens_circle/mens_circle → circles+style,
    # kundalini → yoga+style=kundalini. Frontend mirror lives in
    # frontend/src/api/types.ts (PracticeDirection union) and
    # frontend/src/utils/practiceOptions.ts (STYLE_OPTIONS_BY_DIRECTION).
    practice_allowed_directions: list[str] = [
        "meditation", "yoga", "breathwork",
        "somatic", "tantra", "circles",
        "sound_healing", "art", "narrative", "movement",
    ]
    practice_allowed_difficulties: list[str] = [
        "beginner", "medium", "high",
    ]
    # Direction-conditional styles. Only direction keys with styles are listed;
    # the seven other directions (breathwork / somatic / tantra / sound_healing /
    # art / narrative / movement) admit only style=None.
    # Frontend mirror: STYLE_OPTIONS_BY_DIRECTION in practiceOptions.ts.
    practice_allowed_styles_by_direction: dict[str, list[str]] = {
        "meditation": ["silence", "presence", "sound", "taoist"],
        "yoga": ["nidra", "yin", "hatha", "vinyasa", "kundalini", "ashtanga"],
        "circles": ["womens", "mens", "sharing"],
    }
    practice_style_max_length: int = 100

    # -- Calendar feed filters (Calendar iteration) --
    # Thresholds for the duration_bucket and time_of_day feed filters.
    # Kept here (NO-LITERALS) so the boundaries are tunable in one place;
    # the allowed bucket *names* stay as Literal in the router signature.
    #
    # duration_bucket: "short" = duration_minutes < N, "long" = >= N.
    practice_duration_long_min_minutes: int = 60
    #
    # time_of_day buckets by the practice's LOCAL hour (0-23), computed in
    # the practice timezone. Half-open ranges [start, next_start):
    #   night   [0, 5)    morning [5, 12)
    #   day     [12, 17)  evening [17, 24)
    # Boundaries are the inclusive start hour of each bucket.
    practice_time_night_start_hour: int = 0
    practice_time_morning_start_hour: int = 5
    practice_time_day_start_hour: int = 12
    practice_time_evening_start_hour: int = 17

    # Statuses allowed in PATCH /practices/{id} (I-04).
    # "cancelled" is excluded: the only path to cancelled is
    # POST /practices/{id}/cancel which handles refunds.
    # "live" and "completed" are excluded too (Batch 1): scheduled -> live and
    # scheduled/live -> completed are driven by the clock by the lifecycle
    # worker (bookings/autofinalize.py), never by PATCH. So PATCH only ever
    # drives draft -> scheduled (publish) and draft -> deleted.
    # Pydantic @field_validator raises ValueError -> FastAPI returns 422,
    # which is the correct signal: schema-level rejection, not business logic.
    practice_patch_allowed_statuses: list[str] = [
        "draft", "scheduled", "deleted",
    ]

    # String field limits for Practice -- sourced here so that DB column sizes,
    # schema validators, and future admin UI all stay in sync.
    practice_title_max_length: int = 200
    practice_description_max_length: int = 5000
    practice_timezone_max_length: int = 50

    # Upper cap for max_participants (ge=1 enforced in schema).
    practice_max_participants_limit: int = 10000

    # -- Practice series / recurrence (E3) --
    # A "series" practice (practice_type=series WITH a recurrence spec) is
    # materialized into child Practice rows when it is published (draft ->
    # scheduled). This is the hard ceiling on the TOTAL number of occurrences in
    # one series (the root + its generated children). It backs both the
    # schema-level guard (an explicit recurrence after_count > this -> 422) and
    # the generation cap (until_date / never are silently truncated to this many
    # occurrences). The frontend create form defaults the repeat count to 40, so
    # the ceiling matches that default. NO-LITERALS: tunable here, not inline.
    practice_series_max_occurrences: int = 40

    # PROMPT №559: a duplicate practice submission (master retries after the
    # frontend's own request timeout, believing the first attempt failed --
    # MEASURED on prod: 09:56:48, 09:57:07, 10:00:30, three complete series)
    # is treated as the SAME submission, not a new one, when another
    # non-deleted practice already exists for the same master with the same
    # title/scheduled_at/recurrence created within this many minutes.
    # NO-LITERALS: tunable here, not inline. See create_practice's docstring
    # for exactly what this window does and does not cover.
    practice_duplicate_submit_window_minutes: int = 10

    # -- Stripe (Phase 6.3) --
    # Not instance values on the deploy machine: neither primer.yaml nor
    # compose carries them. On test and preview payments run on the stub
    # (is_stripe_stub, from SERVER_ROLE); on prod the payments module is
    # outside the edition until the new payments service (protocol 11.2).
    stripe_secret_key: str = ""
    stripe_webhook_secret: str = ""
    stripe_success_url: str = ""
    stripe_cancel_url: str = ""

    # -- Topup limits (Phase 6.3) --
    # All amounts in EUR cents.
    min_topup_cents: int = 100      # EUR 1.00
    max_topup_cents: int = 50000    # EUR 500.00
    default_currency: str = "eur"

    # -- Commission (Phase 6.4) --
    # Platform commission deducted from master earnings on practice completion.
    # Integer percent: 15 = 15%.
    commission_percent: int = 15

    # -- Cancellation (Phase 6.5) --
    # Hours before practice.scheduled_at when free cancellation is allowed.
    # Cancel > N hours before -> 100% refund.
    # Cancel <= N hours before -> 0% refund (early finalize, master keeps money).
    cancellation_deadline_hours: int = 24

    # -- Withdrawals (Phase 6.6) --
    # Minimum withdrawal amount in EUR cents. 5000 = EUR 50.00.
    min_withdrawal_cents: int = 5000
    # Fixed platform fee deducted from withdrawal amount. 200 = EUR 2.00.
    withdrawal_fee_cents: int = 200

    # -- Promos (Phase 6.7) --
    # Allowed discount percentages for both company and master promos.
    # Validated in service layer when creating a promo.
    promo_allowed_discounts: list[int] = [5, 25, 50, 75, 100]

    # -- Comms integration: outbox relay (Phase 6 / T0) --
    # The transactional-outbox relay ships domain events to the comms
    # Redis Stream (core/events/relay.py). COMMS_REDIS_URL and friends
    # are written into .env by the Phase 5 installer hand-over
    # (comms-deploy.sh install, pass 2); an EMPTY url disables the
    # relay with a log line -- local dev has no comms stack.
    comms_redis_url: str = ""
    # Stream name the relay XADDs into. The default MIRRORS the comms
    # consumer default (comms app/core/config.py:66
    # `comms_events_stream: str = "comms:events"`) -- mandatory review
    # fix #2: a name mismatch means events silently land in a stream
    # nobody reads. Override ONLY in lockstep with the comms .env.
    comms_events_stream: str = "comms:events"
    # Relay tick interval (seconds between passes over the outbox).
    comms_relay_interval_seconds: float = 2.0
    # Rows claimed per pass (FOR UPDATE SKIP LOCKED batch).
    comms_relay_batch_size: int = 100
    # A poison row logs WARNING every N failed publish attempts (info
    # otherwise) -- loud enough for the operator, quiet enough not to
    # drown the logs. Rows are never dropped.
    comms_relay_warn_every_attempts: int = 10
    # -- H-R3 relay hardening --
    # Exponential backoff for poison rows: delay = min(base * 2**attempts,
    # cap), computed from the POST-increment attempts (first failure ->
    # base * 2). Infra failures never assign a backoff.
    comms_relay_backoff_base_seconds: float = 2.0
    comms_relay_backoff_cap_seconds: float = 300.0
    # Dead-letter ceiling: at this many failed attempts the row gets
    # dead_lettered_at, ONE error log, and leaves the relay's select.
    # With base 2.0 / cap 300 the pure-backoff path to death is
    # 4+8+16+32+64+128+256 + 4x300 ~= 28-35 min plus pass ticks.
    comms_relay_max_attempts: int = 12
    # Socket timeouts for the relay's Redis connection -- a hung TCP
    # connection must not stall the loop forever. A timeout surfaces as
    # redis TimeoutError, already classified as INFRA (pass aborted,
    # attempts untouched).
    comms_relay_socket_connect_timeout_seconds: float = 5.0
    comms_relay_socket_timeout_seconds: float = 5.0
    # Background relay toggle. True in prod (lifespan task). Disabled
    # in tests so relay tests drive relay_pending_batch manually --
    # same rationale as the worker toggles below (tests drive manually).
    comms_relay_enabled: bool = True

    # -- Comms integration: HTTP proxy (Phase 6 / T1) --
    # The read path of ID-9: velo proxies inbox/badge/prefs to the
    # comms HTTP API over aivis-shared. COMMS_API_URL and
    # COMMS_SERVICE_TOKEN are written into .env by the Phase 5
    # installer hand-over (comms-deploy.sh install, pass 2); an EMPTY
    # url makes the proxy answer 502 -- local dev has no comms stack.
    comms_api_url: str = ""
    comms_service_token: str = ""
    # Per-request timeout to comms. The proxy maps a timeout to 504
    # and a connection failure to 502 -- comms being down must degrade
    # the bell, never crash velo (T1 handoff constraint).
    comms_http_timeout_seconds: float = 5.0

    # -- Object storage (BE-133) --
    # The secret of the backend's own key to velo-storage. The key's NAME is
    # fixed in app/core/storage_registry.yaml; only the secret lives in the
    # environment. Nobody types it: `velo update` (and the installer) write
    # it into backend/.env when it is absent, and the storage init sets the
    # storage to it on every run -- so `velo env set STORAGE_SECRET_KEY`
    # followed by `velo update` is a rotation. Empty by default, with no
    # validator, on purpose: the first deploy of BE-133 runs the OLD update
    # script, which writes no key, and the app must still start. The
    # storage module refuses on an empty secret when it is called.
    storage_secret_key: str = ""

    # -- Voice transcription (GT-41) --
    # The key lives HERE, on the server, and nowhere else. Voice input used
    # to call OpenRouter straight from the browser with a VITE_ key compiled
    # into the bundle: anyone who opened the page could read it and spend our
    # budget on any model, and per-person limits, audit and revocation were
    # all impossible by construction. Empty key = the feature is off and says
    # so with a machine code; it is never a 500 and never a silent nothing.
    openrouter_api_key: str = ""
    # OpenRouter RENAMED the OpenAI audio models in 2026 -- the old
    # openai/gpt-4o-audio-preview slug 400s. Overridable without a redeploy
    # precisely because that can happen again.
    openrouter_transcribe_model: str = "openai/gpt-audio-mini"
    # Shorter than the browser's own 30s abort on purpose: if the browser
    # gave up first, the completion would keep running and we would pay for
    # an answer nobody receives.
    openrouter_http_timeout_seconds: float = 25.0
    # -- Support translation (BE-166, owner ruling 2026-10-22) --
    # The ONE language every support admin writes in. A user's message is
    # translated INTO it, an admin's reply is translated FROM it into the
    # user's language (users.language) -- unless the two are the same, when
    # the reply goes as it is. An admin's own interface language plays no
    # part. One of the backend's languages (core/i18n.py
    # SUPPORTED_LANGUAGES), or the start is refused below.
    support_language: str = "en"

    # -- Comms integration: reminder orchestration (Phase 6 / T1) --
    # Booking reminders (ID-6): velo schedules the series product-side
    # (comms engine/reminders.py left the domain orchestration to the
    # product) as notification_request events with a future
    # scheduled_at anchored at practice.scheduled_at, and cancels via
    # the reminder_cancel event. Leads mirror the dead donor series
    # (reminders.py: 24h / 1h / 10min, min lead 5 min).
    booking_reminder_min_lead_seconds: int = 300
    # Post-practice prompt (ID-6): practice_outcome schedules
    # prompt.leave_feedback at outcome + delay, expiring after the
    # window below (Master-chat 2026-07-28: feedback only in v1;
    # prompt.leave_review is registered in the profile but not
    # scheduled -- enabling it is a one-liner at the outcome site).
    prompt_feedback_delay_seconds: int = 3600
    prompt_feedback_expiry_seconds: int = 259200

    # -- Practice lifecycle automation (Batch 1, extended) --
    # Practices are driven entirely by the clock -- the master no longer starts
    # or finishes a practice by hand. A single background worker
    # (app/modules/bookings/autofinalize.py) runs two time-based transitions as
    # the system actor:
    #   * start:  scheduled -> live       once scheduled_at has passed
    #                                     (and the end has not yet passed).
    #   * finish: scheduled/live -> completed once the scheduled END has passed
    #             (scheduled_at + duration_minutes + buffer), running the full
    #             settlement core (attendance + ledger unfreeze/commission +
    #             diary projection + feedback push) from the system actor.
    #
    # Auto-finalize a practice this many minutes after its scheduled END
    # (scheduled_at + duration_minutes + buffer). Customer requirement: a
    # practice finishes STRICTLY when its master-set duration elapses, so the
    # buffer is 0 (end == scheduled_at + duration_minutes). Raise only if a
    # technical grace period is ever needed. FINANCIAL TIMING: purchase unfreeze
    # + commission settle ~at the practice end.
    practice_autofinalize_buffer_minutes: int = 0
    # Worker polling interval in seconds (resets on work found, backs off when
    # idle). Kept short so start/finish (and the feedback prompt that fires on
    # finish) happen close to the actual moment, not up to a poll late.
    practice_autofinalize_poll_interval_seconds: int = 30
    # Max backoff when no practice is due (exponential up to this).
    practice_autofinalize_max_backoff_seconds: int = 600
    # Background worker toggle. True in prod (the lifespan task polls and
    # starts/finalizes). Disabled in tests so the manual auto_start_practice /
    # auto_finalize_practice calls are the only code touching practices --
    # otherwise the background loop races them via FOR UPDATE SKIP LOCKED and a
    # test practice can be transitioned out from under an assertion. Same
    # rationale as the worker toggles here (tests drive manually).
    practice_autofinalize_enabled: bool = True
    # How many due practices to claim per poll cycle, per phase. Throttles each
    # tick so a large backlog is drained in batches rather than one giant locked
    # SELECT. Internal tuning knob -- rarely changed by the operator.
    practice_autofinalize_batch_size: int = 50

    # -- Diary (Phase 8) --
    # Hours before practice.scheduled_at when check-in window opens.
    # Changed 3 -> 24 (customer request 2026-06-03): the window now opens a
    # full day ahead so users can check in well before the practice.
    checkin_window_hours: int = 24
    # Hours after practice completion when feedback window closes.
    feedback_window_hours: int = 72
    # Max length of comment in check-ins and feedbacks.
    # SUGGESTION-12.1: sourced here and referenced in diary/schemas.py
    # via settings.diary_comment_max_length -- change once, applies everywhere.
    diary_comment_max_length: int = 1000

    # mood / rating are 1..10 integer scores now (slider). They are
    # validated by range in the schemas, not against a config list, so the
    # old diary_allowed_moods / diary_allowed_ratings lists were removed.

    # Diary entry field limits.
    diary_entry_content_max_length: int = 10000
    # BE-27: the free-text name a person gives a 'custom' external
    # activity. Its own limit rather than a reuse of the title limit --
    # this is a label on a chip-sized card, not a heading over a body.
    external_activity_name_max_length: int = 120
    # BE-37: how many of the person's own custom activity names the
    # composer offers back. Owner decision, 16 September. NO-LITERALS:
    # tunable here, not inline -- eight is a screenful of chips, and the
    # number is the kind that gets argued about later.
    external_activity_name_suggestions: int = 8
    diary_entry_title_max_length: int = 200

    # Allowed diary entry types (Дневник / Сонник). dream is wired on the
    # backend now; the UI composer creates note only this iteration.
    # Validated via @field_validator -- no Literal in schemas.
    diary_allowed_entry_types: list[str] = ["note", "dream"]

    # Allowed practice_phase values for a practice-linked diary entry
    # (the "Перед практикой:" / "После практики:" caption).
    diary_allowed_practice_phases: list[str] = ["before", "after"]

    # -- Diary feed (Diary redesign iteration) --
    # The unified timeline feed (GET /diary/feed) reads from the DiaryEvent
    # journal. These bound the feed's behavior; kept here (NO-LITERALS) so
    # page size, preview length, and the kind/category vocab live in one place.
    #
    # Default and max page size for cursor pagination.
    diary_feed_page_size: int = 20
    diary_feed_max_page_size: int = 100
    # Max length of the denormalized text preview stored in event snapshots
    # (check-in/feedback comment preview, entry content preview).
    diary_feed_preview_length: int = 140
    # Event kinds that exist in the journal (mirrors DiaryEventKind). Used to
    # validate the feed `kind` filter -- no Literal in the router.
    # NOTE FOR WHOEVER READS THIS NEXT (BE-27): THIS LIST GATES NOTHING.
    # Two occurrences in the whole tree -- this definition and a comment in
    # diary/projections.py naming it as something to keep updated. The feed
    # filters on is_hidden, the unconditional thread_started exclusion and
    # diary_feed_categories, never on this. It is kept in step with
    # DiaryEventKind anyway, because a list that has drifted from the enum
    # lies to the next reader; it is not a visibility switch.
    diary_feed_allowed_kinds: list[str] = [
        "booking_confirmed",
        "booking_cancelled_by_user",
        "practice_rescheduled",
        "practice_cancelled_by_master",
        "practice_outcome",
        "checkin",
        "feedback",
        "note",
        "dream",
        "external_activity",
    ]
    # Filter chips on the feed map onto groups of kinds (Дневник / Сонник /
    # Feedbacks / Check-ins / Практики). "all" is represented by passing no
    # category. Each category resolves to the kinds it includes.
    #
    # The chip list above used to omit "практики" while the mapping below
    # carried it -- corrected here rather than left, because BE-27 adds a
    # kind to exactly that chip and a stale enumeration next to the thing
    # it enumerates is the comment most likely to be believed.
    diary_feed_categories: dict[str, list[str]] = {
        "entries": ["note"],
        "dreams": ["dream"],
        "feedbacks": ["feedback"],
        "checkins": ["checkin"],
        # BE-27: external_activity joins this chip by contract. Worth
        # knowing when reading the feed: "Практики" now also answers with
        # things that happened OUTSIDE velo (a massage, a dance). Raised
        # with the owner separately; the mapping here follows the contract.
        "practices": [
            "external_activity",
            "booking_confirmed",
            "booking_cancelled_by_user",
            "practice_rescheduled",
            "practice_cancelled_by_master",
            "practice_outcome",
        ],
    }

    # -- Zoom (E21) --
    # The Server-to-Server app. A channel in transition (protocol 11.2, until
    # velo-meet): required on every instance, velo-test included -- there is
    # no Zoom stub on any role (owner ruling, BE-192).
    zoom_account_id: str
    zoom_client_id: str
    zoom_client_secret: str
    # Meeting-creation retry poller (mirrors practice_autofinalize_* above).
    # Background worker toggle -- same rationale as
    # practice_autofinalize_enabled and the other worker toggles: tests
    # disable it so the loop can't race manual test calls.
    zoom_retry_enabled: bool = True
    zoom_retry_poll_interval_seconds: int = 30
    # BE-162 delivery 2: the spam bin. A spam ticket older than
    # SUPPORT_SPAM_RETENTION_DAYS (owner ruling: 30, a constant in
    # support/purge.py) is deleted with its conversation by the purge loop,
    # which runs every support_spam_purge_interval_seconds. The worker toggle
    # has the same rationale as the others: tests disable it so the loop
    # cannot race manual calls.
    support_spam_purge_enabled: bool = True
    support_spam_purge_interval_seconds: int = Field(default=3600, ge=60)
    zoom_retry_max_backoff_seconds: int = 600
    # Cap on ZoomMeeting.retry_count for a create_failed row. Past this many
    # attempts the poller stops retrying that row -- it stays VISIBLY
    # status=create_failed with last_sync_error stating the cap was hit,
    # rather than being retried forever (its own silent-failure mode) or
    # silently given up on with no trace of why.
    zoom_meeting_create_max_retries: int = 5
    # Same cap convention, for ZoomRegistrant.retry_count (E21 step E).
    zoom_registrant_create_max_retries: int = 5
    # Same cap convention, for ZoomRegistrant.zoom_cancel_attempts (BE-96):
    # failed Zoom-side cancel calls the retry poller makes before it stops
    # and leaves the row visibly pending. Its own number -- a cancel is a
    # different action from a create.
    zoom_registrant_cancel_max_retries: int = 5
    # Same cap convention, for ZoomMeeting.zoom_delete_attempts: failed
    # Zoom-side meeting DELETE calls the retry poller makes before it stops
    # and leaves the row visibly pending.
    zoom_meeting_delete_max_retries: int = 5

    # -- Zoom Meeting SDK, Zoom inside the app (Standalone F4) --
    # Client ID / Client Secret of the account's General App with the Meeting
    # SDK feature on (Development credentials). NOT the Server-to-Server app
    # above: an S2S app has no Meeting SDK, so these are a second key pair.
    # They sign the SDK JWT and nothing else; the secret never leaves the
    # server and is never logged. A channel in transition like the S2S keys
    # above: required on every instance (BE-192).
    zoom_sdk_client_id: str
    zoom_sdk_client_secret: str
    # Per-user fixed window on sdk-join: every call reaches Zoom (meeting
    # details, plus a ZAK for the host), so a stuck button or a script must
    # cost a counter, not Zoom API quota. Six a minute leaves a person
    # retrying after a failure well inside it.
    zoom_sdk_join_rate_limit_max_requests: int = 6
    zoom_sdk_join_rate_limit_window_seconds: int = 60

    # -- Zoom report ingestion (E21 step F, PROMPT №521) --
    # Background worker toggle, same rationale as the other three loops:
    # tests disable it so the loop can't race manual test calls.
    zoom_report_enabled: bool = True
    zoom_report_poll_interval_seconds: int = 60
    zoom_report_max_backoff_seconds: int = 600
    # Zoom's participants report ripens roughly 15 minutes after a meeting
    # ends (E21 research). A practice isn't even attempted before its
    # scheduled end + this margin has passed -- polling earlier would just
    # find nothing and waste a call.
    zoom_report_ripen_margin_minutes: int = 15
    # THE BOUND (PROMPT №521's trap-closer): once a practice's scheduled end
    # + this many minutes has passed with ZoomMeeting.report_ingested_at
    # still NULL, remaining CONFIRMED bookings on it fall back to the
    # legacy proxy and are decided (tagged legacy_proxy) rather than sitting
    # undecided forever. 120 minutes = the 15-minute ripen margin plus a
    # full 105 minutes of retry headroom for a transient Zoom outage to
    # clear -- generous enough that a normal delay never trips it, bounded
    # enough that feedback eligibility and hours can never hang indefinitely.
    zoom_attendance_decision_deadline_minutes: int = 120
    # Page cap for the participants report (BE-41). Zoom returns at most 300
    # rows per page and a next_page_token for the rest; the client follows
    # it up to this many pages. Reaching the cap with a token still pending
    # is a FAILURE (no ingest, the poller retries, the deadline fallback
    # bounds it) -- never a truncated report, which would record everyone
    # past the cap as a no-show. 200 pages = 60 000 rows, about twice the
    # ~27 000 estimated for 18 000 participants with rejoins; the estimate
    # may be off, hence a setting rather than a constant.
    zoom_report_max_pages: int = 200

    # -- Anonymous guest path, /z/{code}/guest (BE-66) --
    # Ceiling on generated guest names per practice. Regenerating keeps the
    # earlier names taken (owner ruling, no release path), so without a
    # ceiling a loop of GETs grows zoom_guest_names -- and the cost of every
    # next claim -- without bound. A few hundred people with regenerations
    # stay under 1000; a curl loop stops there as it would at 300. Reaching
    # it shows the page without a proposed name. Soft: count and insert are
    # not atomic, so concurrent guests may overshoot by their number. An
    # estimate, hence a setting.
    zoom_guest_names_max_per_practice: int = 1000
    # Per-source limits on the two guest endpoints, fixed window. Over the
    # limit the path DEGRADES instead of refusing -- a public address may be
    # a whole NAT (office, cafe, mobile carrier): GET shows the page without
    # a proposed name and writes nothing, POST sends the guest to the shared
    # registrant without calling Zoom. GET is generous: row growth is
    # bounded by the ceiling above, so this limit is about load, not
    # correctness. POST guards the Zoom registrant quota -- against ONE
    # abusive source only; a legitimate crowd from many addresses can still
    # exhaust the account-wide quota, and only the shared-registrant
    # fallback covers that.
    guest_view_rate_limit: int = 300
    guest_enter_rate_limit: int = 20
    guest_rate_limit_window_seconds: int = 600

    # -- Schools killswitch (GT-19) --
    # AN EMERGENCY BRAKE, NOT A ROLLOUT TOGGLE. Default True: the feature
    # ships on, and this exists so it can be taken off the air without a
    # revert. The opposite default ("off until switched on") would make it a
    # rollout flag, which nobody asked for.
    #
    # WHY SCHOOLS NEED A BRAKE AT ALL, unlike the four worker toggles above:
    # they change what OTHER PEOPLE see. A practice with
    # audience_kind='schools' is hidden from anyone outside the
    # school it belongs to, so a fault in school membership or in a curator's
    # verification state removes practices from the calendars of people who
    # have never heard of schools. That is the blast radius this flag is
    # sized for.
    #
    # WHAT False MEANS -- schools cease to exist, not "freeze":
    #   - all 23 school endpoints answer 404 (router-level dependencies on
    #     both routers in schools/router.py);
    #   - the 'schools' audience becomes unreachable, so such a
    #     practice is visible to its OWN MASTER only and disappears from
    #     everyone else's feed (practices/audience_service.py).
    # Freezing mutations while keeping reads (the other candidate) was
    # rejected precisely because it does not stop the audience from cutting
    # other people's feeds -- a brake that misses the main thing is worse
    # than none, because it gets pulled and believed.
    #
    # 404 AND NO MACHINE CODE. A 503 would announce "this feature exists and
    # is broken", inviting retries during the very incident the flag was
    # pulled for; a dedicated error code would become the one reliable way
    # to detect that the killswitch is down.
    #
    # THE ADMIN LIST OF SCHOOLS STAYS AVAILABLE ON PURPOSE -- the operator
    # needs to see what they switched off, and whether it is time to switch
    # it back. The cockpit does not go dark with the engine. It is read-only,
    # admin-gated, and cannot affect anyone outside schools, so it is not
    # what this flag is for.
    #
    # KNOWN AND ACCEPTED, not overlooked: with the flag off a master can
    # still CREATE a practice targeting a school (that validation lives in
    # practices/schemas.py). Such a practice is dark to everyone, its owner
    # included in the sense that audience_unavailable=true is returned to
    # them immediately, and it affects nobody -- so it is outside what the
    # brake exists to stop. Forbidding creation would be the third candidate
    # meaning ("new schools only"), which was considered and not chosen.
    #
    # Flipping this back to True restores everything with no rows touched:
    # the flag writes nothing and no journal event records it (the fact that
    # it was pulled lives in the deployment, not in a school's history).
    schools_enabled: bool = True

    # -- MCP (BE-138, phase 0: personal access tokens) --
    # Killswitch. False -> every endpoint of the token router answers 404,
    # unauthenticated callers included (a router-level dependency in
    # app/modules/mcp/router.py, the same shape as schools_enabled and
    # for the same reasons: no 503, no machine code). Token verification
    # does not read it; the /mcp gate and the OAuth door (BE-141) do, in one
    # place: door_closed in app/modules/mcp/server.py.
    mcp_enabled: bool = True
    # Live (not revoked) tokens one student may hold. Revoked tokens do not
    # count. The 11th create answers 409 mcp_token_limit_reached.
    mcp_tokens_max_active_per_user: int = 10
    # Verification refreshes mcp_tokens.last_used_at at most once per this
    # many seconds per token, so /mcp traffic is not a write per request.
    mcp_token_last_used_interval_seconds: int = 60
    # -- MCP phase 1 (BE-139): /mcp and the read tools --
    # Read-tool calls per token per fixed 60-second window (owner ruling).
    # Counted per tools/call, not per HTTP request; the 61st call answers
    # the tool error rate_limited with the seconds left in the window.
    mcp_read_calls_per_minute: int = 60
    # A master's free text (description, what to prepare, contraindications)
    # is cut to this many characters in get_practice, with truncated: true.
    mcp_master_text_max_chars: int = 2000
    # -- MCP phase 2 (BE-140): write tools, per token per fixed hour --
    # book_practice + cancel_my_booking share one budget; save_to_diary has
    # its own; reads keep theirs. Every call counts, refusals included.
    mcp_action_calls_per_hour: int = 10
    mcp_diary_writes_per_hour: int = 30
    # -- MCP phase 3 (BE-141): OAuth for claude.ai, sign-in through Telegram --
    # The OAuth issuer is api_origin (BE-192): the public origin of THIS API,
    # and with /mcp appended the protected resource.
    #
    # "Log In With Telegram" (OpenID Connect) credentials from BotFather's
    # Login Widget section. The client id is the bot's id; the secret is
    # read by the server only, for the code exchange with oauth.telegram.org.
    # A channel in transition (protocol 11.2, until sign-in moves to comms
    # v4.x): required on every instance -- the OAuth door and the browser
    # sign-in are always configured.
    telegram_login_client_id: str
    telegram_login_client_secret: str
    # Lifetimes: the access token (the refresh token lives until the student
    # revokes the connection), the one-time authorization code, and an
    # authorization in progress (from /authorize to the consent decision).
    mcp_oauth_access_ttl_seconds: int = 3600
    mcp_oauth_code_ttl_seconds: int = 60
    mcp_oauth_request_ttl_seconds: int = 600
    # Anonymous client registrations per source address per window; the
    # next one answers 429.
    mcp_oauth_register_per_source: int = 20
    mcp_oauth_register_window_seconds: int = 3600
    # Code exchange and key fetch at oauth.telegram.org.
    telegram_login_http_timeout_seconds: float = 10.0
    # Client ID Metadata Documents (CIMD): the hosts are the constant
    # MCP_OAUTH_CIMD_ALLOWED_HOSTS in modules/mcp/oauth.py. The document is
    # kept this long, then fetched again; it may be at most this many bytes
    # and must arrive within this many seconds -- claude.ai gives the whole
    # token request 10.
    mcp_oauth_cimd_cache_seconds: int = 86400
    mcp_oauth_cimd_max_bytes: int = 16384
    mcp_oauth_cimd_timeout_seconds: float = 5.0

    # -- Admin (Phase 2.3 / 6.6 / 3.3) --
    # Max length of admin notes on master verify/reject actions
    # and withdrawal approve/reject notes.
    admin_action_note_max_length: int = 1000
    # Max length of report resolution notes.
    admin_report_note_max_length: int = 2000

    @model_validator(mode="after")
    def _validate(self) -> "Settings":
        """Refuse to start on a value no instance can run with."""
        # BE-192: an empty instance value is refused, every empty key named
        # at once -- the operator fixes the passport in one pass. A missing
        # one pydantic has already refused, by field name.
        empty = [
            name.upper()
            for name in _REQUIRED_NON_EMPTY
            if not getattr(self, name).strip()
        ]
        if empty:
            raise ValueError(f"empty: {', '.join(empty)}")

        # BE-190: the edition is one the table knows (core/editions.py).
        if self.edition not in EDITIONS:
            raise ValueError(
                f"EDITION {self.edition!r} is not an edition of velo "
                f"(known: {', '.join(sorted(EDITIONS))})"
            )

        # BE-192: domains.* of the passport are hosts. A URL, a port or a
        # path here would become a second, wrong origin in every link.
        for name in ("domain_frontend", "domain_api"):
            value = getattr(self, name)
            if not _HOST_RE.match(value.lower()):
                raise ValueError(
                    f"{name.upper()}={value!r} is not a host name: no "
                    "scheme, port, path or userinfo, e.g. 'app.example.com'"
                )
            setattr(self, name, value.lower())

        # BE-166: a language the backend does not know cannot be anybody's
        # users.language, so every reply would be translated into it and
        # every message out of it -- refused at start.
        if self.support_language not in SUPPORTED_LANGUAGES:
            raise ValueError(
                f"SUPPORT_LANGUAGE={self.support_language!r} is not one of "
                f"the backend's languages: "
                f"{', '.join(sorted(SUPPORTED_LANGUAGES))}"
            )

        # TELEGRAM_BOT_URL: repair a stale host (2026-07-14). A value still
        # carrying the dead t.me host is rewritten here, so deep links and
        # master invites keep working -- and it is the reason formatters.py
        # and admin/masters/service.py need no changes at all: they read an
        # already normalized settings.telegram_bot_url.
        self.telegram_bot_url = normalize_telegram_url(
            self.telegram_bot_url, TELEGRAM_LINK_DOMAIN
        ) or ""

        # CQ-02: commission_percent must be within valid range.
        # Prevents misconfiguration: negative commission or > 100%
        # would break integer math in purchase finalization
        # (paid_cents * commission_percent // 100).
        if not 0 <= self.commission_percent <= 100:
            raise ValueError(
                "commission_percent must be between 0 and 100, "
                f"got {self.commission_percent}"
            )

        # CQ-06: log_level must be a valid Python logging level, and not
        # DEBUG on any instance -- too noisy, and it may leak sensitive data
        # (request bodies, SQL queries, etc.).
        _valid_levels = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
        if self.log_level.upper() not in _valid_levels:
            raise ValueError(
                f"log_level must be one of {_valid_levels}, "
                f"got '{self.log_level}'"
            )
        if self.log_level.upper() == "DEBUG":
            raise ValueError(
                "log_level DEBUG is not allowed. Use INFO or higher."
            )

        # COMMS integration (Phase 6): paired-secret gate. A PARTIAL config
        # is a silent failure the operator cannot see: a set api_url with an
        # empty token ships "Authorization: Bearer " as a valid header
        # (comms 401 -> the bell breaks for everyone), and a relay enabled by
        # flag with an empty redis_url just never starts (INFO log, no
        # error). Enforced only when comms is INTENDED -- some COMMS_* value
        # is set; with every one empty the relay never starts and the proxy
        # answers 502.
        comms_intended = bool(
            self.comms_api_url
            or self.comms_service_token
            or self.comms_redis_url
        )
        if comms_intended:
            if self.comms_api_url and not self.comms_service_token:
                raise ValueError(
                    "COMMS_API_URL is set but COMMS_SERVICE_TOKEN is "
                    "empty: the proxy would send an empty Bearer token "
                    "and comms would 401, logging out every user who "
                    "opens the bell. Set the token or clear the URL."
                )
            if self.comms_service_token and not self.comms_api_url:
                raise ValueError(
                    "COMMS_SERVICE_TOKEN is set but COMMS_API_URL is "
                    "empty: half-configured comms proxy. Set the URL or "
                    "clear the token."
                )
            if self.comms_relay_enabled and not self.comms_redis_url:
                raise ValueError(
                    "comms is configured (api_url/token present) but "
                    "COMMS_REDIS_URL is empty while the relay is enabled: "
                    "domain events would pile up undelivered. Set "
                    "COMMS_REDIS_URL or set COMMS_RELAY_ENABLED=false."
                )
            if (
                self.comms_redis_url
                and not self.comms_api_url
                and not self.comms_service_token
            ):
                # The inverse half-integration of the branch above: the
                # relay happily ships events into Redis, but with no
                # api_url the bell proxy is off -- users never see a
                # single notification and nothing errors anywhere.
                raise ValueError(
                    "COMMS_REDIS_URL is set but COMMS_API_URL and "
                    "COMMS_SERVICE_TOKEN are both empty: the relay would "
                    "ship events to comms while the bell proxy stays "
                    "dead -- notifications pile up that no user can ever "
                    "see. Set COMMS_API_URL + COMMS_SERVICE_TOKEN or "
                    "clear COMMS_REDIS_URL."
                )

        return self

    # -- Pydantic Settings Config --
    # No env_file (BE-192): values come only from the process environment.
    model_config = SettingsConfigDict(case_sensitive=False)

    # The Zoom stub (BE-192, owner ruling): on NO role. Every instance,
    # velo-test included, runs on real Zoom keys. Only the test suite turns
    # it on (tests/conftest.py), so that no test reaches Zoom and the E21
    # control flow runs on deterministic fake data (zoom_client.py). A
    # private attribute, not a field: no environment variable reaches it.
    _zoom_stub: bool = PrivateAttr(default=False)

    @property
    def frontend_origin(self) -> str:
        """https://<domains.frontend>: the one origin CORS admits and the
        browser sign-in returns to."""
        return f"https://{self.domain_frontend}"

    @property
    def api_origin(self) -> str:
        """https://<domains.api>: the public origin of this API -- the base
        of every /z/{code} link and the OAuth issuer."""
        return f"https://{self.domain_api}"

    @property
    def is_stripe_stub(self) -> bool:
        """True on the roles where payments run on the stub: test and
        preview (BE-192). The stub skips Stripe and credits at once."""
        return self.server_role in _STRIPE_STUB_ROLES

    @property
    def is_zoom_stub(self) -> bool:
        """True only when the test suite turned the stub on (_zoom_stub)."""
        return self._zoom_stub

    @property
    def is_zoom_sdk_configured(self) -> bool:
        """True when the app can hand out Meeting SDK entry: Zoom is real.

        The SDK key pair is always set (required at start). Under the stub
        every meeting number is fabricated, so a correctly signed JWT would
        still open nothing -- and sdk-join answers 409
        zoom_sdk_not_configured instead of handing the screen a meeting that
        does not exist.
        """
        return not self.is_zoom_stub


# Singleton: one Settings instance for the entire application.
settings = Settings()
