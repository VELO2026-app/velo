# =============================================================================
# VELO Backend -- Application Configuration (updated Phase 8.1, WARNING-5, NO-LITERALS)
# =============================================================================
#
# HOW IT WORKS:
#   1. pydantic-settings reads your .env file
#   2. Each field here maps to an environment variable (case-insensitive)
#   3. Pydantic validates types: if DATABASE_URL is missing or malformed,
#      the app crashes at startup with a clear error -- not at runtime
#      when a user triggers a database query.
#
# EXAMPLE:
#   .env contains:       DATABASE_URL=postgresql+asyncpg://...
#   Python code uses:    settings.database_url  (typed as str, validated)
#
# WHY NOT just os.getenv()?
#   os.getenv("DATABSE_URL")  <- typo, returns None, crashes later
#   settings.databse_url      <- typo, IDE catches it immediately
#
# SECURITY (TD-001, TD-006):
#   In production (APP_ENV != development), SECRET_KEY and DATABASE_URL
#   have no defaults -- the app refuses to start without a proper .env.
#   In development, safe defaults are provided for convenience.
#
# WARNING-5 / W6: STRIPE_STUB is disallowed unless explicitly opted in.
#   If STRIPE_SECRET_KEY="TEST", webhook signature verification is skipped.
#   lifespan() in main.py raises at startup if is_stripe_stub_blocked is
#   True (not here -- this module is imported by Alembic before app
#   startup). The gate is NOT app_env: the TEST server's own .env sets
#   APP_ENV=production, so an env-name check can't tell TEST from prod.
#   See allow_stripe_stub / is_stripe_stub_blocked below for the real gate.
# =============================================================================

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.core.telegram_links import normalize_telegram_url

# T-14. Literal placeholders shipped in backend/.env.example -- copying
# that file verbatim instead of running the installer (which generates
# real secrets via openssl) leaves a box running on these forever,
# silently: every one of them is non-empty, so no "key present" check
# (velo doctor included) ever catches it.
#
# THESE VALUES ARE DUPLICATED, NOT DERIVED: config.py cannot read
# .env.example at runtime (it is imported by Alembic before the app's
# working directory is guaranteed, and coupling a security gate to a
# documentation file's parse-ability is its own hazard). The values here
# and the values in .env.example are two copies of the same fact -- change
# one, change the other, or this gate goes quietly blind. Kept honest by
# test_config.py's sync test, which reads .env.example and asserts every
# literal below is still present in it -- the mismatch fails a test run
# instead of aging silently for years (same defect class as T-35's
# two-language codec and T-13's three-place predicate).
_PLACEHOLDER_SECRET_KEY = "change-me-in-production"
_PLACEHOLDER_POSTGRES_PASSWORD = "change-me"
# DATABASE_URL / REDIS_URL embed the same placeholder INSIDE a templated
# connection string (postgresql+asyncpg://velo:change-me@postgres:5432/velo),
# so this is a substring check, not equality -- but the boundary is exact
# (colon before, at-sign after), not a bare "change-me" search: a real
# generated password merely starting with those letters renders as
# ":change-me1AbcXyz...@", which does not contain ":change-me@", and a
# host/db name that happens to contain "change-me" elsewhere in the URL is
# not a boundary match either.
_PLACEHOLDER_URL_FRAGMENT = ":change-me@"


class Settings(BaseSettings):
    """Application settings, loaded from environment variables.

    Each field corresponds to an env var. Pydantic handles:
    - Type conversion (str -> int, str -> bool)
    - Validation (missing required vars -> clear error at startup)
    - Defaults (optional vars get fallback values)
    """

    # -- Application --
    app_env: str = "development"

    # -- Database --
    # Full async connection string for SQLAlchemy.
    # Port 5433: Docker dev setup (5432 reserved for native postgres).
    # Default provided for development only. (TD-006)
    database_url: str = ""

    # Docker Compose uses these to create the database on first run.
    # Must match the user/pass/db in DATABASE_URL above.
    postgres_db: str = "velo"
    postgres_user: str = "velo"
    postgres_password: str = "velo"

    # -- Redis --
    redis_url: str = "redis://localhost:6379/0"

    # -- CORS --
    # Comma-separated list of allowed origins.
    # "*" for development, specific domains for production.
    cors_origins: str = "*"

    # -- Public links (T-35) --
    # Origin for links that must survive OUTSIDE Telegram -- today exactly
    # one consumer: the /z/{code} Zoom entry point (practices/router.py).
    # install_velo.sh writes it as the optional short domain if one was given
    # at install, the API domain otherwise; either way nginx proxies "/" on
    # that host straight to this backend, so a root-level route publishes
    # itself.
    #
    # Empty default + a production gate below, NOT a localhost fallback: a
    # silently-wrong base is not a broken page, it is links already sitting
    # in other people's Telegram channels pointing at nothing. Fail at
    # startup, where somebody is watching.
    public_link_base: str = ""

    # -- Security --
    # No default in production -- app won't start without it. (TD-001)
    secret_key: str = ""

    # -- Telegram --
    # Bot token from BotFather. Required for initData validation.
    # Dev default is a fake token -- HMAC won't match real Telegram data,
    # but tests mock validation anyway. (P-4)
    telegram_bot_token: str = ""
    # Bot URL for deep link buttons in notifications (Phase 7.3).
    # Example: "https://telegram.me/veloappbot"
    #
    # The host of this URL is normalized at startup (see the validator below):
    # a stale .env still carrying the dead t.me host is repaired in memory, so
    # a domain swap does NOT require touching every server's .env by hand.
    telegram_bot_url: str = ""
    # Host currently serving Telegram links (t.me died at the registry level on
    # 2026-07-13 -- see app/core/telegram_links.py for the full story).
    #
    # THIS IS THE ONLY PLACE IN THE BACKEND THAT NAMES A TELEGRAM DOMAIN.
    # Every Telegram URL -- the bot URL from .env and every avatar URL arriving
    # from initData -- is rewritten onto this host. If telegram.me ever dies
    # too, set TELEGRAM_LINK_DOMAIN=telegram.dog in .env (different TLD, not
    # subject to the Montenegrin .me registry) and restart. Nothing else changes.
    telegram_link_domain: str = "telegram.me"

    # -- Sessions --
    # How long a session token lives in Redis (days).
    session_ttl_days: int = 30

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
    # CQ-06: default INFO (not DEBUG) -- DEBUG is too noisy for production
    # and even dev. Override with LOG_LEVEL=DEBUG in .env if needed.
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
    stripe_secret_key: str = ""
    stripe_webhook_secret: str = ""
    stripe_success_url: str = ""
    stripe_cancel_url: str = ""
    # W6 hotfix: explicit opt-in for running with the Stripe stub outside a
    # dev laptop. Defaults to False on purpose -- forget to set it and the
    # app refuses to start, never the other way around. app_env cannot be
    # used for this decision: the TEST server's own .env sets
    # APP_ENV=production (it calls itself "production"), so a check keyed
    # off the env name blocks TEST as if it were prod. Set
    # ALLOW_STRIPE_STUB=true only on servers where the stub is genuinely
    # intentional (TEST).
    #
    # is_stripe_stub_blocked (below) refuses startup when ALL THREE hold:
    # not dev, is_stripe_stub (STRIPE_SECRET_KEY upper() == "TEST"), and
    # allow_stripe_stub is NOT set. The guard is correct and deliberate --
    # do not weaken it.
    #
    # PROMPT №509 (owner read both servers' env, 2026-07-17): PROD currently
    # has STRIPE_SECRET_KEY=TEST and NO ALLOW_STRIPE_STUB at all -- i.e. prod
    # is, right now, in exactly the state this guard exists to refuse. It
    # has not crashed only because the currently-running prod build predates
    # this guard. The moment a build containing this guard is released to
    # prod, startup raises RuntimeError (main.py's lifespan()) and prod does
    # not come up. Before that release: set a real Stripe secret key on
    # prod, OR set ALLOW_STRIPE_STUB=true there if the stub is genuinely
    # intended for longer -- do not let this guard reach prod silently.
    allow_stripe_stub: bool = False

    # Zoom's twin of the flag above, added by T-35. Same shape on purpose:
    # a server that genuinely has no Zoom app says so ONCE, explicitly, and
    # then boots. What it buys is that nobody boots on a fake Zoom by
    # accident -- see is_zoom_stub_blocked below for why that stopped being
    # acceptable.
    allow_zoom_stub: bool = False

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
    ]
    # Filter chips on the feed map onto groups of kinds (Все / Дневник /
    # Сонник / Feedbacks / Check-ins). "all" is represented by passing no
    # category. Each category resolves to the kinds it includes.
    diary_feed_categories: dict[str, list[str]] = {
        "entries": ["note"],
        "dreams": ["dream"],
        "feedbacks": ["feedback"],
        "checkins": ["checkin"],
        "practices": [
            "booking_confirmed",
            "booking_cancelled_by_user",
            "practice_rescheduled",
            "practice_cancelled_by_master",
            "practice_outcome",
        ],
    }

    # -- Zoom (E21) --
    zoom_account_id: str = ""
    zoom_client_id: str = ""
    zoom_client_secret: str = ""
    # VESTIGIAL (PROMPT №585) -- no longer decides anything. The attendance
    # decision is now 50% of EACH PRACTICE'S OWN duration_minutes (owner
    # decision), computed in zoom/attendance_service.py's
    # attendance_threshold_seconds(), not read from here. This field is kept
    # -- not deleted -- because pydantic-settings' default extra='forbid'
    # (measured against the pinned pydantic-settings==2.14.2) means a live
    # .env that still defines ZOOM_ATTENDANCE_THRESHOLD_MINUTES would refuse
    # to start if the field vanished, and the deployed server's .env content
    # is not something this change can verify (no VPS access). Safe to
    # delete later once a measurement of the live .env confirms the key is
    # gone from it too.
    zoom_attendance_threshold_minutes: int = 10
    # Meeting-creation retry poller (mirrors practice_autofinalize_* above).
    # Background worker toggle -- same rationale as
    # practice_autofinalize_enabled and the other worker toggles: tests
    # disable it so the loop can't race manual test calls.
    zoom_retry_enabled: bool = True
    zoom_retry_poll_interval_seconds: int = 30
    zoom_retry_max_backoff_seconds: int = 600
    # Cap on ZoomMeeting.retry_count for a create_failed row. Past this many
    # attempts the poller stops retrying that row -- it stays VISIBLY
    # status=create_failed with last_sync_error stating the cap was hit,
    # rather than being retried forever (its own silent-failure mode) or
    # silently given up on with no trace of why.
    zoom_meeting_create_max_retries: int = 5
    # Same cap convention, for ZoomRegistrant.retry_count (E21 step E).
    zoom_registrant_create_max_retries: int = 5

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

    # -- Curator groups / schools killswitch (GT-19) --
    # AN EMERGENCY BRAKE, NOT A ROLLOUT TOGGLE. Default True: the feature
    # ships on, and this exists so it can be taken off the air without a
    # revert. The opposite default ("off until switched on") would make it a
    # rollout flag, which nobody asked for.
    #
    # WHY SCHOOLS NEED A BRAKE AT ALL, unlike the four worker toggles above:
    # they change what OTHER PEOPLE see. A practice with
    # audience_kind='curator_groups' is hidden from anyone outside the
    # target school, so a fault in school membership or in a curator's
    # verification state removes practices from the calendars of people who
    # have never heard of schools. That is the blast radius this flag is
    # sized for.
    #
    # WHAT False MEANS -- schools cease to exist, not "freeze":
    #   - all 23 school endpoints answer 404 (router-level dependencies on
    #     both routers in curator_groups/router.py);
    #   - the 'curator_groups' audience becomes unreachable, so such a
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
    curator_groups_enabled: bool = True

    # -- Admin (Phase 2.3 / 6.6 / 3.3) --
    # Max length of admin notes on master verify/reject actions
    # and withdrawal approve/reject notes.
    admin_action_note_max_length: int = 1000
    # Max length of report resolution notes.
    admin_report_note_max_length: int = 2000

    @model_validator(mode="after")
    def _apply_env_defaults_and_validate(self) -> "Settings":
        """Apply safe defaults for development, enforce secrets in production.

        Development: provides working defaults so `make run` works without .env.
        Production: crashes at startup if critical secrets are missing.
        """
        is_dev = self.app_env == "development"

        # DATABASE_URL: default only in dev (TD-006)
        if not self.database_url:
            if is_dev:
                self.database_url = (
                    "postgresql+asyncpg://velo:velo@localhost:5433/velo"
                )
            else:
                raise ValueError(
                    "DATABASE_URL is required in production. "
                    "Set it in .env file."
                )

        # SECRET_KEY: default only in dev (TD-001)
        if not self.secret_key:
            if is_dev:
                self.secret_key = (
                    "dev-only-insecure-key-do-not-use-in-production"
                )
            else:
                raise ValueError(
                    "SECRET_KEY is required in production. "
                    'Generate with: python -c "import secrets; '
                    'print(secrets.token_urlsafe(64))"'
                )

        # TELEGRAM_BOT_TOKEN: required in production.
        if not self.telegram_bot_token:
            if is_dev:
                self.telegram_bot_token = "dev-fake-bot-token"
            else:
                raise ValueError(
                    "TELEGRAM_BOT_TOKEN is required in production. "
                    "Get it from BotFather."
                )

        # TELEGRAM_BOT_URL: repair a stale host (2026-07-14).
        # Servers provisioned before t.me died still carry
        # TELEGRAM_BOT_URL=https://t.me/<bot> in their .env. Rewriting the host
        # here means deep links and master invites keep working WITHOUT anyone
        # editing .env on every box -- and it is the reason formatters.py and
        # admin/masters/service.py need no changes at all: they read an already
        # normalized settings.telegram_bot_url.
        self.telegram_bot_url = normalize_telegram_url(
            self.telegram_bot_url, self.telegram_link_domain
        ) or ""

        # STRIPE_SUCCESS_URL: required in production. (Phase 6.3)
        if not self.stripe_success_url:
            if is_dev:
                self.stripe_success_url = (
                    "http://localhost:3000/topup/success"
                )
            else:
                raise ValueError(
                    "STRIPE_SUCCESS_URL is required in production. "
                    "Set to 'TEST' to start without Stripe, or "
                    "provide your Telegram WebApp success page URL."
                )

        # STRIPE_CANCEL_URL: required in production. (Phase 6.3)
        if not self.stripe_cancel_url:
            if is_dev:
                self.stripe_cancel_url = (
                    "http://localhost:3000/topup/cancel"
                )
            else:
                raise ValueError(
                    "STRIPE_CANCEL_URL is required in production. "
                    "Set to 'TEST' to start without Stripe, or "
                    "provide your Telegram WebApp cancel page URL."
                )

        # WARNING-5 / W6: STRIPE_STUB check is intentionally NOT here.
        # config.py is imported by Alembic migrations before app startup,
        # so a startup-only guard must live in main.py lifespan, not here.
        # See: is_stripe_stub_blocked above, enforced in lifespan() in
        # main.py. Two prior comments here claimed this guard existed
        # when it never did (the W6 incident) -- it now actually does.

        # CORS_ORIGINS: must not be wildcard in production (S-04).
        if not is_dev and self.cors_origins == "*":
            raise ValueError(
                "CORS_ORIGINS must not be '*' in production. "
                "Set to specific domain(s), e.g. "
                "'https://app.example.com'."
            )

        # PUBLIC_LINK_BASE: required in production (T-35). Same shape as the
        # CORS_ORIGINS gate above -- a misconfiguration that is invisible at
        # runtime must be loud at startup instead. The value is the origin
        # every /z/{code} link is built from; empty means every link a master
        # copies into a channel is malformed, and nothing in the request path
        # would ever say so.
        if not is_dev and not self.public_link_base:
            raise ValueError(
                "PUBLIC_LINK_BASE is required in production. "
                "Set to the public origin serving this API, e.g. "
                "'https://api.example.com'."
            )

        # CQ-02: commission_percent must be within valid range.
        # Prevents misconfiguration: negative commission or > 100%
        # would break integer math in purchase finalization
        # (paid_cents * commission_percent // 100).
        if not 0 <= self.commission_percent <= 100:
            raise ValueError(
                "commission_percent must be between 0 and 100, "
                f"got {self.commission_percent}"
            )

        # CQ-06: log_level must be a valid Python logging level.
        # In production, DEBUG is not allowed -- too noisy and may
        # leak sensitive data (request bodies, SQL queries, etc.).
        _valid_levels = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
        if self.log_level.upper() not in _valid_levels:
            raise ValueError(
                f"log_level must be one of {_valid_levels}, "
                f"got '{self.log_level}'"
            )
        if not is_dev and self.log_level.upper() == "DEBUG":
            raise ValueError(
                "log_level DEBUG is not allowed in production. "
                "Use INFO or higher."
            )

        # COMMS integration (Phase 6): paired-secret gate. comms may not
        # be installed on a given box (empty url = feature off, degrades
        # cleanly), so we do NOT force comms config everywhere. But a
        # PARTIAL config is a silent failure the operator cannot see,
        # which is exactly what happened to notifications before: a set
        # api_url with an empty token ships "Authorization: Bearer " as
        # a valid header (comms 401 -> the bell breaks for everyone), and
        # a relay enabled by flag with an empty redis_url just never
        # starts (INFO log, no error). Enforce the pairing in production,
        # but ONLY when comms is actually INTENDED on this box: a box with
        # no comms config at all (every field empty) is the "comms not
        # installed" case, which must degrade cleanly -- the relay simply
        # never starts on an empty redis_url. Gating on the default
        # comms_relay_enabled=True alone would stop every comms-less prod
        # box from starting, including in-place upgrades of existing boxes
        # whose .env has no COMMS_* keys yet. (Dev stays fully optional.)
        comms_intended = bool(
            self.comms_api_url
            or self.comms_service_token
            or self.comms_redis_url
        )
        if not is_dev and comms_intended:
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
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    @property
    def is_stripe_stub(self) -> bool:
        """True when Stripe is not configured (keys set to 'TEST')."""
        return self.stripe_secret_key.upper() == "TEST"

    @property
    def is_stripe_stub_blocked(self) -> bool:
        """True when startup must refuse: stubbed Stripe, not a dev laptop,
        and not explicitly allowed via ALLOW_STRIPE_STUB. See
        allow_stripe_stub above for why app_env alone can't make this call.
        """
        is_dev = self.app_env == "development"
        return not is_dev and self.is_stripe_stub and not self.allow_stripe_stub

    @property
    def is_zoom_stub(self) -> bool:
        """True when Zoom credentials are not configured (any of the three
        blank), or ZOOM_CLIENT_SECRET="TEST" (explicit sentinel, mirroring
        the Stripe stub convention above).

        NO SERVER'S ACTUAL ZOOM CREDENTIAL STATE HAS BEEN OBSERVED as of
        this writing -- this differs from is_stripe_stub, whose comment can
        reference a specific, owner-verified reading of prod's .env
        (PROMPT №509). Do not add a claim here about what TEST or prod
        currently has configured unless you have personally read that
        server's env; the Stripe guard's comment once asserted "prod has a
        real key" and that assertion was false (the W6 incident, see
        allow_stripe_stub above) -- it stayed wrong in the comment for two
        prior revisions before someone actually checked.
        """
        return (
            not self.zoom_account_id
            or not self.zoom_client_id
            or not self.zoom_client_secret
            or self.zoom_client_secret.upper() == "TEST"
        )

    @property
    def is_zoom_stub_blocked(self) -> bool:
        """True when startup must refuse: stubbed Zoom, not a dev laptop,
        and not explicitly allowed via ALLOW_ZOOM_STUB.

        THIS OVERRIDES AN EXPLICIT EARLIER DECISION, and the override is
        the point of writing it down rather than quietly adding a guard.

        What used to stand here said there must be NO gate, for two
        reasons: (1) Zoom stub mode only means no real meeting is created,
        and E21 treats every Zoom call as best-effort, so a hard guard
        would contradict that design; (2) no server had real Zoom
        credentials yet, so a guard would crash TEST and prod on the next
        restart for a reason unrelated to that deploy. It closed with:
        "if Zoom ever becomes launch-critical, add a real gate then -- do
        not backfill one here without re-deciding this trade-off
        explicitly."

        T-35 is that moment, and this is that explicit re-decision.
        The whole feature exists so attendance stops lying: a student who
        attended must not be recorded NO_SHOW. Under the stub, meetings are
        fabricated zoom.us URLs that open nothing, no registrant is ever
        matched, and attendance is not merely degraded -- it can never be
        written at all. Reason (1) no longer holds: best-effort meeting
        CREATION is one thing, an entire attendance chain silently running
        on fiction is another. Reason (2) is spent: it was a statement
        about a moment in time, and that moment passed the day this
        shipped.

        The failure this closes was found in production, not in review: a
        server ran for weeks with no ZOOM_* keys at all, every link looked
        plausible in the UI, and NOTHING anywhere said so -- not the app,
        not `velo doctor` (the keys were absent from .env.example too), not
        the install. Silence was the defect.

        Startup does not become fragile: the installer asks about Zoom and
        writes ALLOW_ZOOM_STUB=true when the operator answers "no". A
        server without a Zoom app still boots -- it just has to say out
        loud that it is running on fiction.
        """
        is_dev = self.app_env == "development"
        return not is_dev and self.is_zoom_stub and not self.allow_zoom_stub

    @property
    def placeholder_secret_keys(self) -> list[str]:
        """Names of settings still holding their literal .env.example
        placeholder value -- SECRET_KEY, POSTGRES_PASSWORD, DATABASE_URL,
        REDIS_URL. Empty list means none of the four are placeholders.

        CRITERION: exact match against the known literal for the atomic
        secrets (SECRET_KEY, POSTGRES_PASSWORD) -- a real secret that
        merely starts with the same characters does not equal the
        literal, so it passes. For the URL-shaped fields the placeholder
        is embedded inside a templated connection string, so this checks
        for the exact ":change-me@" fragment (colon/at-sign boundaries)
        instead of a bare substring -- a real password beginning
        "change-me..." does not produce that exact fragment, and a
        host/db name that happens to contain "change-me" elsewhere in the
        URL is not a boundary match.

        KNOWN GAP: REDIS_PASSWORD is NOT covered here -- it has no
        Settings field at all. It exists only for docker-compose to start
        the redis container with --requirepass; production never has
        backend/.env as a physical file for THIS process (docker-compose's
        env_file injects it as a bare OS env var into the container), and
        pydantic-settings silently ignores an OS env var that matches no
        field -- there is nothing on this class to check. The risk is
        covered INDIRECTLY: by .env.example's own convention
        REDIS_PASSWORD and the password embedded in REDIS_URL are the
        same value, so a left-over "change-me" is still caught here via
        REDIS_URL. If an operator ever sets the two to DIFFERENT values,
        the app simply fails to connect to Redis -- a loud failure at
        startup, not a silent one. A redis_password field is deliberately
        NOT added to close this gap: it would be Settings surface with no
        runtime consumer, the exact kind of dead field this file already
        warns against elsewhere (see zoom_attendance_threshold_minutes
        above).
        """
        offenders: list[str] = []
        if self.secret_key == _PLACEHOLDER_SECRET_KEY:
            offenders.append("SECRET_KEY")
        if self.postgres_password == _PLACEHOLDER_POSTGRES_PASSWORD:
            offenders.append("POSTGRES_PASSWORD")
        if _PLACEHOLDER_URL_FRAGMENT in self.database_url:
            offenders.append("DATABASE_URL")
        if _PLACEHOLDER_URL_FRAGMENT in self.redis_url:
            offenders.append("REDIS_URL")
        return offenders

    @property
    def is_placeholder_secret_blocked(self) -> bool:
        """True when startup must refuse: a literal .env.example
        placeholder is still live in a non-dev environment.

        No ALLOW_* opt-out exists for this one, unlike Stripe/Zoom stub
        mode -- there is no server, including TEST, on which running
        production secrets equal to "change-me" is a legitimate,
        intended configuration. TEST is expected to generate its own
        secrets via install_velo.sh, the same as prod.
        """
        is_dev = self.app_env == "development"
        return not is_dev and bool(self.placeholder_secret_keys)


# Singleton: one Settings instance for the entire application.
settings = Settings()
