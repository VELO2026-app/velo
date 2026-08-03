# =============================================================================
# VELO Backend -- config: COMMS paired-secret production gate (Phase 6 / W)
# =============================================================================
#
# Standalone (no DB/Redis): drives Settings(**kwargs) directly to assert the
# _apply_env_defaults_and_validate() comms rules. kwargs override .env, so
# these build a synthetic production config in-process.
#
# ENV ISOLATION (post-VPS finding): Settings normally reads .env AND the
# process environment, both of which carry a real COMMS_API_URL on the test
# server -- an earlier version of this test asserted defaults and went red on
# the VPS while green in a bare sandbox. So every case here passes ALL comms
# fields EXPLICITLY (kwargs beat both .env and os.environ) and _env_file=None
# skips the .env read entirely. The test states the whole comms config; the
# environment cannot leak into it.
#
# The gate: comms may be OFF on a box (all empty -> feature disabled, clean
# degrade), but a PARTIAL comms config is a silent failure in production --
# a set api_url with an empty token ships "Bearer " and 401s the bell for
# everyone; a relay enabled by flag with an empty redis_url never starts.
# Enforce the pairing in prod; keep dev fully permissive.
# =============================================================================

import pytest
from pydantic import ValidationError

from app.core.config import Settings

# A minimal VALID production base (every OTHER prod gate satisfied) so the
# only thing under test is the comms pairing. Comms fields are NOT here --
# each case supplies the full comms quartet explicitly via _mk().
_PROD_BASE = dict(
    app_env="production",
    database_url="postgresql+asyncpg://u:p@h/db",
    secret_key="k" * 40,
    telegram_bot_token="bot-token",
    stripe_secret_key="sk_live_x",
    stripe_webhook_secret="whsec_x",
    stripe_success_url="https://app.example.com/ok",
    stripe_cancel_url="https://app.example.com/no",
    cors_origins="https://app.example.com",
)


def _mk(
    *,
    app_env: str = "production",
    api_url: str = "",
    token: str = "",
    redis_url: str = "",
    relay_enabled: bool = True,
) -> Settings:
    """Build Settings with the ENTIRE comms quartet pinned explicitly and
    the .env read disabled, so neither .env nor os.environ can leak a
    real comms value into the assertion.

    relay_enabled defaults to True -- the PRODUCTION default -- so the
    "comms not installed" case (all urls empty) is tested against the
    real default, not a convenient False (R3: an earlier version used
    False here and missed that a comms-less prod box fails to start)."""
    base = dict(_PROD_BASE)
    base["app_env"] = app_env
    return Settings(
        **base,
        comms_api_url=api_url,
        comms_service_token=token,
        comms_redis_url=redis_url,
        comms_relay_enabled=relay_enabled,
        _env_file=None,
    )


def test_full_comms_config_passes() -> None:
    s = _mk(
        api_url="http://comms-app:8000",
        token="tok",
        redis_url="redis://comms-redis:6379/0",
        relay_enabled=True,
    )
    assert s.comms_api_url == "http://comms-app:8000"


def test_comms_not_installed_starts_on_prod_default() -> None:
    """R3: a comms-less prod box -- NO comms config at all, relay_enabled
    at its production default (True) -- must start. This is the in-place
    upgrade path for existing boxes whose .env has no COMMS_* keys yet.
    The gate only fires when comms is INTENDED (some field set)."""
    s = _mk()  # relay_enabled defaults to True now
    assert s.comms_api_url == ""
    assert s.comms_relay_enabled is True


def test_api_url_without_token_rejected() -> None:
    with pytest.raises(ValidationError, match="COMMS_SERVICE_TOKEN"):
        _mk(api_url="http://comms-app:8000", token="", redis_url="redis://x")


def test_token_without_api_url_rejected() -> None:
    with pytest.raises(ValidationError, match="COMMS_API_URL"):
        _mk(token="tok", api_url="", redis_url="redis://x")


def test_relay_enabled_without_redis_rejected() -> None:
    # comms is INTENDED (api_url + token set) but redis is missing -> reject.
    with pytest.raises(ValidationError, match="COMMS_REDIS_URL"):
        _mk(api_url="http://comms-app:8000", token="tok", redis_url="")


def test_redis_without_api_and_token_rejected() -> None:
    """The inverse half-integration: relay ships events, bell proxy dead."""
    with pytest.raises(ValidationError, match="COMMS_API_URL"):
        _mk(redis_url="redis://x", api_url="", token="")


def test_dev_allows_redis_only_config() -> None:
    """Dev twin of the branch above: redis-only must not block local dev."""
    s = _mk(app_env="development", redis_url="redis://x", api_url="", token="")
    assert s.comms_redis_url == "redis://x"


def test_dev_allows_partial_comms_config() -> None:
    """Dev stays permissive: a half-config must not block local startup."""
    s = _mk(app_env="development", api_url="http://comms-app:8000", token="")
    assert s.comms_api_url == "http://comms-app:8000"
