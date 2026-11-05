"""A valid instance configuration for tests that build Settings themselves
(BE-192).

Every instance value is passed EXPLICITLY (init kwargs beat the process
environment), so the environment the suite runs in -- CI's invented values,
or velo-test's real ones on the deploy machine -- cannot leak into a case.
A case that needs a key ABSENT passes MISSING for it: build_settings then
leaves it out of the kwargs and removes it from the environment too.
"""

import pytest

from app.core.config import Settings

MISSING = object()

INSTANCE: dict[str, object] = {
    "server_role": "prod",
    "domain_frontend": "app.example.com",
    "domain_api": "api.example.com",
    "database_url": "postgresql+asyncpg://u:p@h/db",
    "telegram_bot_token": "123456:bot-token",
    "zoom_account_id": "zoom-account",
    "zoom_client_id": "zoom-client",
    "zoom_client_secret": "zoom-secret",
    "zoom_sdk_client_id": "zoom-sdk-client",
    "zoom_sdk_client_secret": "zoom-sdk-secret",
    "telegram_login_client_id": "123456",
    "telegram_login_client_secret": "login-secret",
    "comms_api_url": "",
    "comms_service_token": "",
    "comms_redis_url": "",
}


def build_settings(monkeypatch: pytest.MonkeyPatch, **overrides: object) -> Settings:
    """Settings from INSTANCE with `overrides` on top."""
    values = {**INSTANCE, **overrides}
    for name, value in values.items():
        if value is MISSING:
            monkeypatch.delenv(name.upper(), raising=False)
    return Settings(**{k: v for k, v in values.items() if v is not MISSING})
