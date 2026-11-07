"""What the deploy machine passes to the backend == what the backend reads
(BE-192).

pydantic-settings looks up each field of Settings in the environment and
ignores every other variable -- extra='forbid' guards only a .env file,
which no longer exists. So a key compose passes that Settings does not read
(a typo, a key renamed on one side only) would be dropped without a word,
and a field nobody passes would refuse the start only on a server. The
three statements below catch both in CI, from the two files the machine
reads: compose's `app.environment` and primer.yaml's `env`.

The files are read from the repository root -- in the test image they are
at /, where Path(__file__).resolve().parents[2] lands from /app/tests
(backend/Dockerfile, stage `test`).
"""

import re
from pathlib import Path

import pytest
import yaml

from app.core.config import Settings
from app.modules.mcp.oauth import MCP_OAUTH_CIMD_ALLOWED_HOSTS

ROOT = Path(__file__).resolve().parents[2]
COMPOSE = ROOT / "docker-compose.yml"
PRIMER = ROOT / "primer.yaml"


def _app_environment() -> dict[str, str]:
    compose = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))
    env = compose["services"]["app"]["environment"]
    assert isinstance(env, dict) and env, "app.environment: a non-empty mapping"
    return {str(k): str(v) for k, v in env.items()}


def _primer_env() -> set[str]:
    primer = yaml.safe_load(PRIMER.read_text(encoding="utf-8"))
    env = primer["env"]
    assert isinstance(env, dict) and env, "primer.yaml env: a non-empty mapping"
    return set(env)


def _fields() -> set[str]:
    return {name.upper() for name in Settings.model_fields}


def test_every_key_of_app_environment_is_a_field() -> None:
    """Statement 1: nothing compose passes is dropped unread."""
    keys = set(_app_environment())
    unread = keys - _fields()
    assert not unread, f"app.environment keys Settings does not read: {unread}"
    # Pair: the compared sets are the real ones.
    assert {"SERVER_ROLE", "EDITION", "DOMAIN_FRONTEND", "DOMAIN_API"} <= (
        keys & _fields()
    )


def test_every_field_without_a_default_is_passed() -> None:
    """Statement 2: a required field nobody passes would refuse the start on
    a server only."""
    required = {
        name.upper() for name, f in Settings.model_fields.items() if f.is_required()
    }
    assert required, "Settings has required fields"
    missing = required - set(_app_environment())
    assert not missing, f"required fields not in app.environment: {missing}"


def test_every_variable_of_app_environment_is_declared() -> None:
    """Statement 3: compose takes nothing primer.yaml does not declare."""
    referenced = {
        name
        for value in _app_environment().values()
        for name in re.findall(r"\$\{([A-Z0-9_]+)", value)
    }
    assert referenced, "app.environment references the machine's values"
    undeclared = referenced - _primer_env()
    assert not undeclared, f"not declared in primer.yaml env: {undeclared}"


@pytest.mark.parametrize(
    "removed",
    ["SECRET_KEY", "APP_ENV", "ALLOW_STRIPE_STUB", "ALLOW_ZOOM_STUB",
     "CORS_ORIGINS", "PUBLIC_LINK_BASE", "MCP_OAUTH_ISSUER_URL"],
)
def test_a_removed_key_is_neither_passed_nor_declared(removed: str) -> None:
    assert removed not in _app_environment()
    assert removed not in _primer_env()


def test_the_cimd_hosts_are_the_cimd_hosts_of_egress() -> None:
    """MCP_OAUTH_CIMD_ALLOWED_HOSTS equals the CIMD hosts of egress (plan,
    decision 5): a host velo would fetch but cannot reach, or may reach but
    would refuse, is a connector that never connects."""
    egress = set(yaml.safe_load(PRIMER.read_text(encoding="utf-8"))["egress"])
    assert MCP_OAUTH_CIMD_ALLOWED_HOSTS
    assert egress >= MCP_OAUTH_CIMD_ALLOWED_HOSTS
    # The other hosts of egress are the channels in transition, not CIMD.
    assert egress - MCP_OAUTH_CIMD_ALLOWED_HOSTS == {
        "zoom.us", "api.zoom.us", "oauth.telegram.org",
    }
