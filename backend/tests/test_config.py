"""The startup contract of Settings on the deploy machine (BE-192).

Values come from the instance's passport and the machine only (protocol
5.1): a role, two hosts, the channels in transition. What the process cannot
run with is refused at start -- here, by Settings itself, before any request
and before Alembic, which imports the same settings.

Each case builds its own Settings (tests/settings_instance.py) instead of
touching the suite's singleton: the contract is what a fresh process does.
"""

import pytest
from pydantic import ValidationError

from app.core.config import (
    _OPTION_VARS,
    _REQUIRED_NON_EMPTY,
    OPTIONS,
    Settings,
    settings,
)
from tests.settings_instance import INSTANCE, MISSING, build_settings

# BE-182: the variables of the options (checked while the option is on --
# INSTANCE has every option but payments on) and the option flags.
_OPTION_VAR_NAMES = tuple(n for names in _OPTION_VARS.values() for n in names)
_FLAGS = tuple(f"option_{o}" for o in OPTIONS)


def test_a_valid_instance_starts_and_builds_its_origins(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    s = build_settings(
        monkeypatch, domain_frontend="App.Example.COM", domain_api="api.example.com"
    )
    assert s.frontend_origin == "https://app.example.com"
    assert s.api_origin == "https://api.example.com"
    assert s.server_role == "prod"


@pytest.mark.parametrize("name", [*_REQUIRED_NON_EMPTY, *_OPTION_VAR_NAMES])
@pytest.mark.parametrize("empty", ["", "   "])
def test_an_empty_instance_value_is_refused_by_name(
    monkeypatch: pytest.MonkeyPatch, name: str, empty: str
) -> None:
    with pytest.raises(ValidationError, match=f"empty: {name.upper()}"):
        build_settings(monkeypatch, **{name: empty})


def test_every_empty_instance_value_is_named_at_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The operator fixes the passport in one pass, not one key per start."""
    with pytest.raises(ValidationError) as refused:
        build_settings(
            monkeypatch, zoom_sdk_client_id="", telegram_login_client_secret=""
        )
    assert (
        "empty: ZOOM_SDK_CLIENT_ID, TELEGRAM_LOGIN_CLIENT_SECRET"
        in str(refused.value)
    )


@pytest.mark.parametrize(
    "name", [*_REQUIRED_NON_EMPTY, *_OPTION_VAR_NAMES, "server_role", *_FLAGS]
)
def test_an_absent_instance_value_is_refused_by_name(
    monkeypatch: pytest.MonkeyPatch, name: str
) -> None:
    with pytest.raises(ValidationError) as refused:
        build_settings(monkeypatch, **{name: MISSING})
    errors = refused.value.errors()
    assert [e["type"] for e in errors] == ["missing"]
    assert errors[0]["loc"] == (name,)


def test_the_required_values_are_exactly_the_fields_without_a_default() -> None:
    """The fields with no default are one list with the emptiness checks:
    a required field left out of them would start on ''. BE-182: the
    variables of an option are checked while it is on (_OPTION_VARS), and
    the option flags and the role are checked by their own form."""
    no_default = {
        name for name, f in Settings.model_fields.items() if f.is_required()
    }
    assert no_default == {
        *_REQUIRED_NON_EMPTY,
        *_OPTION_VAR_NAMES,
        "server_role",
        *_FLAGS,
    }


@pytest.mark.parametrize(
    "role", ["development", "production", "staging", "TEST", ""]
)
def test_a_role_outside_the_passport_is_refused(
    monkeypatch: pytest.MonkeyPatch, role: str
) -> None:
    with pytest.raises(ValidationError, match="server_role"):
        build_settings(monkeypatch, server_role=role)


@pytest.mark.parametrize("name", ["domain_frontend", "domain_api"])
@pytest.mark.parametrize(
    "value",
    [
        "https://app.example.com",
        "app.example.com:443",
        "app.example.com/",
        "app.example.com/path",
        "user@app.example.com",
        " app.example.com",
        "app..example.com",
        "-app.example.com",
        "app_example.com",
        "*.example.com",
    ],
)
def test_a_domain_that_is_not_a_host_is_refused(
    monkeypatch: pytest.MonkeyPatch, name: str, value: str
) -> None:
    with pytest.raises(ValidationError, match=f"{name.upper()}=.* is not a host"):
        build_settings(monkeypatch, **{name: value})


@pytest.mark.parametrize(
    ("role", "stub"), [("test", True), ("preview", True), ("prod", False)]
)
def test_the_stripe_stub_follows_the_role(
    monkeypatch: pytest.MonkeyPatch, role: str, stub: bool
) -> None:
    assert build_settings(monkeypatch, server_role=role).is_stripe_stub is stub


@pytest.mark.parametrize("role", ["test", "preview", "prod"])
def test_no_role_runs_the_zoom_stub(
    monkeypatch: pytest.MonkeyPatch, role: str
) -> None:
    """Owner ruling (BE-192): real Zoom on every instance. No environment
    variable reaches the stub -- the suite's own switch is a private
    attribute (conftest.py)."""
    for name in ("ZOOM_STUB", "_ZOOM_STUB", "ALLOW_ZOOM_STUB"):
        monkeypatch.setenv(name, "true")
    s = build_settings(monkeypatch, server_role=role)
    assert s.is_zoom_stub is False
    assert s.is_zoom_sdk_configured is True
    # Pair: the suite's singleton has the stub on, so the attribute is live.
    assert settings.is_zoom_stub is True


@pytest.mark.parametrize("role", ["test", "preview", "prod"])
def test_debug_logging_is_refused_on_every_role(
    monkeypatch: pytest.MonkeyPatch, role: str
) -> None:
    with pytest.raises(ValidationError, match="DEBUG is not allowed"):
        build_settings(monkeypatch, server_role=role, log_level="DEBUG")


@pytest.mark.parametrize(
    "removed",
    [
        "app_env",
        "secret_key",
        "allow_stripe_stub",
        "allow_zoom_stub",
        "cors_origins",
        "public_link_base",
        "mcp_oauth_issuer_url",
        "transcription_daily_limit",
        "support_spam_retention_days",
        "telegram_link_domain",
        "mcp_oauth_cimd_allowed_hosts",
        "postgres_db",
        "postgres_user",
        "postgres_password",
        # BE-184: voice goes through comms, the provider's key left with it.
        "openrouter_api_key",
        "openrouter_transcribe_model",
        "openrouter_http_timeout_seconds",
    ],
)
def test_a_removed_key_is_no_field(removed: str) -> None:
    """Removed whole (BE-192, BE-184), not left as a fallback. Pair: the
    field list is the real one -- it has the fields BE-192 added."""
    assert removed not in Settings.model_fields
    assert {"server_role", "domain_frontend", "domain_api"} <= set(
        Settings.model_fields
    )


def test_instance_fixture_is_complete() -> None:
    """INSTANCE names every required field, so a case that drops one key
    tests that key alone."""
    required = {n for n, f in Settings.model_fields.items() if f.is_required()}
    assert required <= set(INSTANCE)


# ---------------------------------------------------------------------------
# BE-44: the application's Redis client carries socket timeouts
# ---------------------------------------------------------------------------


async def test_app_redis_client_carries_socket_timeouts() -> None:
    """Asserted on the client init_redis() really builds, down to the
    connection object its pool makes -- not on the kwargs passed to a
    factory. Without the timeouts a hung Redis held every authenticated
    request for ever. Pair: the values are set (not None) and are the
    settings, so a default of "no timeout" cannot pass."""
    from app.core import redis as core_redis

    previous = core_redis._redis_client
    try:
        await core_redis.init_redis()
        client = core_redis.get_redis()
        assert client is not previous
        conn = client.connection_pool.make_connection()
        assert conn.socket_connect_timeout is not None
        assert conn.socket_timeout is not None
        assert conn.socket_connect_timeout == (
            settings.redis_socket_connect_timeout_seconds
        )
        assert conn.socket_timeout == settings.redis_socket_timeout_seconds
    finally:
        # Close the probe client and put the suite's own client back. Not
        # monkeypatch: it would restore, at teardown, the value seen at the
        # time of setattr -- None, after close_redis -- and leave the rest
        # of the session without Redis.
        await core_redis.close_redis()
        core_redis._redis_client = previous


# -- BE-193: the storage's URL -------------------------------------------------


@pytest.mark.parametrize(
    "endpoint",
    ["http://velo-storage-velo-storage:9000", "https://store.example.com:443"],
)
def test_the_storage_endpoint_is_a_url_of_host_and_port(
    endpoint: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    s = build_settings(monkeypatch, storage_endpoint=endpoint)
    assert s.storage_endpoint == endpoint


@pytest.mark.parametrize(
    "endpoint",
    [
        "velo-storage-velo-storage:9000",  # compose without its scheme
        "ftp://h:21",
        "http://h",  # no port
        "http://:9000",
        "http://h:9000/",
        "http://h:9000/x",
        "http://h:9000?q",
        "http://h:9000?",
        "http://h:9000#f",
        "http://u:p@h:9000",
        "http://h:99999",
        "http://h:port",
    ],
)
def test_a_storage_endpoint_of_another_form_is_refused(
    endpoint: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    with pytest.raises(ValidationError, match="STORAGE_ENDPOINT"):
        build_settings(monkeypatch, storage_endpoint=endpoint)
