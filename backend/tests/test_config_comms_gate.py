# =============================================================================
# VELO Backend -- config: COMMS paired-secret production gate (Phase 6 / W)
# =============================================================================
#
# Standalone (no DB/Redis): drives Settings(**kwargs) directly to assert the
# _apply_env_defaults_and_validate() comms rules. kwargs override .env, so
# these build a synthetic production config in-process.
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
# only thing under test is the comms pairing.
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


def _settings(**comms) -> Settings:
    return Settings(**_PROD_BASE, **comms)


def test_full_comms_config_passes() -> None:
    s = _settings(
        comms_api_url="http://comms-app:8000",
        comms_service_token="tok",
        comms_redis_url="redis://comms-redis:6379/0",
        comms_relay_enabled=True,
    )
    assert s.comms_api_url == "http://comms-app:8000"


def test_comms_fully_off_passes() -> None:
    """Empty everything + relay disabled = comms not installed here."""
    s = _settings(comms_relay_enabled=False)
    assert s.comms_api_url == ""


def test_api_url_without_token_rejected() -> None:
    with pytest.raises(ValidationError, match="COMMS_SERVICE_TOKEN"):
        _settings(
            comms_api_url="http://comms-app:8000",
            comms_service_token="",
            comms_relay_enabled=False,
        )


def test_token_without_api_url_rejected() -> None:
    with pytest.raises(ValidationError, match="COMMS_API_URL"):
        _settings(
            comms_service_token="tok",
            comms_relay_enabled=False,
        )


def test_relay_enabled_without_redis_rejected() -> None:
    with pytest.raises(ValidationError, match="COMMS_REDIS_URL"):
        _settings(
            comms_redis_url="",
            comms_relay_enabled=True,
        )


def test_dev_allows_partial_comms_config() -> None:
    """Dev stays permissive: a half-config must not block local startup."""
    dev = dict(_PROD_BASE)
    dev["app_env"] = "development"
    s = Settings(
        **dev,
        comms_api_url="http://comms-app:8000",
        comms_service_token="",
    )
    assert s.comms_api_url == "http://comms-app:8000"
