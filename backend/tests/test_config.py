"""W6 hotfix: settings.is_stripe_stub_blocked, the guard behind lifespan()'s
startup RuntimeError in main.py.

Exercised directly against the property rather than through the `client`
fixture's ASGITransport: ASGITransport never sends a "lifespan" scope (only
"http"), so lifespan() -- and this guard -- never runs during the test
suite regardless of what APP_ENV/ALLOW_STRIPE_STUB are set to. That also
means the guard has no way to break the test suite itself; testing the
property directly is the only practical way to cover its actual logic.

T-14 (placeholder_secret_keys / is_placeholder_secret_blocked) follows the
exact same convention, added below.
"""

from pathlib import Path

import pytest

from app.core.config import (
    _PLACEHOLDER_POSTGRES_PASSWORD,
    _PLACEHOLDER_SECRET_KEY,
    _PLACEHOLDER_URL_FRAGMENT,
    settings,
)


@pytest.mark.parametrize(
    ("app_env", "stripe_secret_key", "allow_stripe_stub", "expected_blocked"),
    [
        # Dev laptop: stub key, no flag needed -- always allowed.
        ("development", "TEST", False, False),
        ("development", "TEST", True, False),
        # TEST server (calls itself "production"): stub key, flag set --
        # the case the original app_env-only guard broke.
        ("production", "TEST", True, False),
        # TEST server without the flag configured yet: must still refuse,
        # the flag is what makes the opt-in explicit.
        ("production", "TEST", False, True),
        # Prod with a real key: never blocked, flag irrelevant either way.
        ("production", "sk_live_real_key", False, False),
        ("production", "sk_live_real_key", True, False),
    ],
)
def test_is_stripe_stub_blocked(
    monkeypatch: pytest.MonkeyPatch,
    app_env: str,
    stripe_secret_key: str,
    allow_stripe_stub: bool,
    expected_blocked: bool,
) -> None:
    monkeypatch.setattr(settings, "app_env", app_env)
    monkeypatch.setattr(settings, "stripe_secret_key", stripe_secret_key)
    monkeypatch.setattr(settings, "allow_stripe_stub", allow_stripe_stub)

    assert settings.is_stripe_stub_blocked is expected_blocked


# =============================================================================
# T-14: placeholder_secret_keys / is_placeholder_secret_blocked
# =============================================================================
#
# Same fixture-avoidance rationale as the Stripe guard above: lifespan()
# never runs under ASGITransport, so the property is the only thing worth
# testing directly.
#
# Each field defaults to a REAL-shaped value below (not the placeholder,
# not empty) so every parametrized case isolates exactly the one thing it
# claims to test -- a case that flags SECRET_KEY should not incidentally
# also flag DATABASE_URL because the fixture left it blank.


_REAL_SECRET_KEY = "real-generated-secret-not-a-placeholder-abc123"
_REAL_POSTGRES_PASSWORD = "real-generated-pg-password"
_REAL_DATABASE_URL = "postgresql+asyncpg://velo:realpass@postgres:5432/velo"
_REAL_REDIS_URL = "redis://:realpass@redis:6379/0"


def _set_all_real(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "secret_key", _REAL_SECRET_KEY)
    monkeypatch.setattr(settings, "postgres_password", _REAL_POSTGRES_PASSWORD)
    monkeypatch.setattr(settings, "database_url", _REAL_DATABASE_URL)
    monkeypatch.setattr(settings, "redis_url", _REAL_REDIS_URL)


def test_placeholder_secret_keys_clean_when_all_real(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Baseline: a properly generated box flags nothing."""
    _set_all_real(monkeypatch)
    assert settings.placeholder_secret_keys == []
    # ПОВТОР: re-reading the property gives the same result (it recomputes
    # from current field state each time -- no cached/stale answer).
    assert settings.placeholder_secret_keys == []


@pytest.mark.parametrize(
    ("field", "placeholder_value", "expected_key"),
    [
        ("secret_key", _PLACEHOLDER_SECRET_KEY, "SECRET_KEY"),
        ("postgres_password", _PLACEHOLDER_POSTGRES_PASSWORD, "POSTGRES_PASSWORD"),
        (
            "database_url",
            f"postgresql+asyncpg://velo{_PLACEHOLDER_URL_FRAGMENT}postgres:5432/velo",
            "DATABASE_URL",
        ),
        (
            "redis_url",
            f"redis://{_PLACEHOLDER_URL_FRAGMENT}redis:6379/0",
            "REDIS_URL",
        ),
    ],
)
def test_placeholder_secret_keys_flags_each_field_individually(
    monkeypatch: pytest.MonkeyPatch,
    field: str,
    placeholder_value: str,
    expected_key: str,
) -> None:
    _set_all_real(monkeypatch)
    monkeypatch.setattr(settings, field, placeholder_value)
    assert settings.placeholder_secret_keys == [expected_key]


@pytest.mark.parametrize(
    ("field", "near_miss_value"),
    [
        # Must NOT be flagged: a real secret starting with the same
        # characters as the literal, but not equal to it.
        ("secret_key", _PLACEHOLDER_SECRET_KEY + "-EXTRA-not-the-literal"),
        ("postgres_password", _PLACEHOLDER_POSTGRES_PASSWORD + "-but-longer"),
        # Password STARTS with "change-me" but the URL fragment boundary
        # (":change-me@") is not present -- one more character before "@".
        (
            "database_url",
            "postgresql+asyncpg://velo:change-me1AbcXyz@postgres:5432/velo",
        ),
        # "change-me" appears in the URL, but not as the password (a db
        # name that happens to contain the substring) -- no boundary match.
        (
            "database_url",
            "postgresql+asyncpg://velo:realpass@postgres:5432/change-merchant-db",
        ),
    ],
)
def test_placeholder_secret_keys_does_not_false_positive_on_near_miss(
    monkeypatch: pytest.MonkeyPatch,
    field: str,
    near_miss_value: str,
) -> None:
    _set_all_real(monkeypatch)
    monkeypatch.setattr(settings, field, near_miss_value)
    assert settings.placeholder_secret_keys == []


def test_placeholder_secret_keys_reports_all_offenders_at_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """done-when (item 2): the refusal names every offending key, not just
    the first one found -- an operator should not need multiple restart
    cycles to discover them one at a time."""
    monkeypatch.setattr(settings, "secret_key", _PLACEHOLDER_SECRET_KEY)
    monkeypatch.setattr(
        settings, "postgres_password", _PLACEHOLDER_POSTGRES_PASSWORD,
    )
    monkeypatch.setattr(
        settings,
        "database_url",
        f"postgresql+asyncpg://velo{_PLACEHOLDER_URL_FRAGMENT}postgres:5432/velo",
    )
    monkeypatch.setattr(
        settings, "redis_url", f"redis://{_PLACEHOLDER_URL_FRAGMENT}redis:6379/0",
    )
    assert sorted(settings.placeholder_secret_keys) == [
        "DATABASE_URL", "POSTGRES_PASSWORD", "REDIS_URL", "SECRET_KEY",
    ]


@pytest.mark.parametrize(
    ("app_env", "expected_blocked"),
    [
        # ПУСТОТА axis note: an EMPTY secret_key is a pre-existing, separate
        # case (config.py's own validator raises for it in production
        # outside this predicate entirely) -- not exercised here, since
        # this predicate must not change that behavior, and empty != the
        # literal placeholder so it never appears in placeholder_secret_keys
        # regardless.
        ("development", False),  # dev: never blocked, even with placeholders
        ("production", True),
    ],
)
def test_is_placeholder_secret_blocked_respects_dev(
    monkeypatch: pytest.MonkeyPatch,
    app_env: str,
    expected_blocked: bool,
) -> None:
    monkeypatch.setattr(settings, "app_env", app_env)
    monkeypatch.setattr(settings, "secret_key", _PLACEHOLDER_SECRET_KEY)
    assert settings.is_placeholder_secret_blocked is expected_blocked
    # Dev still SEES the placeholder (doctor/operators can inspect it) --
    # only the startup refusal is gated by app_env, not detection itself.
    assert settings.placeholder_secret_keys == ["SECRET_KEY"]


def test_placeholder_secret_empty_value_is_not_flagged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ПУСТОТА axis: an empty string is a pre-existing, unrelated case
    (config.py's validator already handles missing secrets in production)
    and must not be reported as a placeholder by this new predicate."""
    _set_all_real(monkeypatch)
    monkeypatch.setattr(settings, "secret_key", "")
    assert settings.placeholder_secret_keys == []


def test_env_example_placeholders_match_config() -> None:
    """Sync guard the owner required for T-14's .env.example duplication:
    the literals hardcoded in config.py and the values actually shipped in
    backend/.env.example are two copies of the same fact with nothing else
    holding them together. If someone "cleans up" .env.example without
    updating config.py (or vice versa), this test fails the run instead of
    the gate going quietly blind for years -- same defect class as T-35's
    two-language codec and T-13's three-place predicate.

    Runs for real everywhere, including inside the built backend image:
    .env.example is COPYed into it and no longer .dockerignore'd (see
    backend/Dockerfile, backend/.dockerignore) -- it is documentation, not
    a secret; only .env itself stays excluded from the build context.
    """
    env_example = (
        Path(__file__).resolve().parent.parent / ".env.example"
    )
    assert env_example.is_file(), f"{env_example} not found"

    values: dict[str, str] = {}
    for line in env_example.read_text(encoding="utf-8").splitlines():
        if "=" not in line or line.lstrip().startswith("#"):
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip()

    assert values.get("SECRET_KEY") == _PLACEHOLDER_SECRET_KEY, (
        "backend/.env.example's SECRET_KEY no longer matches "
        "config.py's _PLACEHOLDER_SECRET_KEY -- update whichever one "
        "drifted."
    )
    assert values.get("POSTGRES_PASSWORD") == _PLACEHOLDER_POSTGRES_PASSWORD, (
        "backend/.env.example's POSTGRES_PASSWORD no longer matches "
        "config.py's _PLACEHOLDER_POSTGRES_PASSWORD -- update whichever "
        "one drifted."
    )
    assert _PLACEHOLDER_URL_FRAGMENT in values.get("DATABASE_URL", ""), (
        "backend/.env.example's DATABASE_URL no longer contains "
        "config.py's _PLACEHOLDER_URL_FRAGMENT -- update whichever one "
        "drifted."
    )
    assert _PLACEHOLDER_URL_FRAGMENT in values.get("REDIS_URL", ""), (
        "backend/.env.example's REDIS_URL no longer contains config.py's "
        "_PLACEHOLDER_URL_FRAGMENT -- update whichever one drifted."
    )

