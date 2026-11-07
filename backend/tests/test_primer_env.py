"""What the deploy machine passes to the backend == what the backend reads
(BE-192).

pydantic-settings looks up each field of Settings in the environment and
ignores every other variable -- extra='forbid' guards only a .env file,
which no longer exists. So a key compose passes that Settings does not read
(a typo, a key renamed on one side only) would be dropped without a word,
and a field nobody passes would refuse the start only on a server. The
three statements below catch both in CI, from the two files the machine
reads: compose's `app.environment` and primer.yaml's `env`.

BE-190 fix: CI builds Settings too, from backend/ci.env -- invented values
for every required key except the connection addresses. Three more
statements keep that file whole and keep both CI places reading it, so a
required key cannot be added to Settings and forgotten in CI again.

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
CI_ENV = ROOT / "backend" / "ci.env"
CI_YML = ROOT / ".github" / "workflows" / "ci.yml"
BACKEND_TESTS_YML = ROOT / ".github" / "workflows" / "backend-tests.yml"

# Each CI place has its own -- they are not in ci.env.
CONNECTION_ADDRESSES = frozenset({"DATABASE_URL", "REDIS_URL"})


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
    would refuse, is a connector that never connects. BE-182: an entry is
    {host, when: [options]} -- the CIMD hosts are exactly those of `mcp`."""
    entries = yaml.safe_load(PRIMER.read_text(encoding="utf-8"))["egress"]
    when = {e["host"]: tuple(e["when"]) for e in entries}
    assert MCP_OAUTH_CIMD_ALLOWED_HOSTS
    assert {h for h, w in when.items() if w == ("mcp",)} == set(
        MCP_OAUTH_CIMD_ALLOWED_HOSTS
    )
    # The other hosts of egress are the channels in transition, not CIMD.
    assert {h: w for h, w in when.items() if w != ("mcp",)} == {
        "zoom.us": ("zoom",),
        "api.zoom.us": ("zoom",),
        "oauth.telegram.org": ("telegram",),
    }


# -- backend/ci.env: the one settings environment of CI (BE-190 fix) ----------


def _required() -> set[str]:
    return {
        name.upper() for name, f in Settings.model_fields.items() if f.is_required()
    }


def _ci_env() -> dict[str, str]:
    """KEY=value lines; comments and blank lines skipped. A quote or a space
    in a value is refused: docker's --env-file would keep it literally and
    the shell would not -- the two readers would disagree."""
    env: dict[str, str] = {}
    for n, raw in enumerate(CI_ENV.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        assert sep and re.fullmatch(r"[A-Z][A-Z0-9_]*", key), f"ci.env:{n}: {raw!r}"
        assert not re.search(r"""[\s'"]""", value), f"ci.env:{n}: {raw!r}"
        assert key not in env, f"ci.env:{n}: {key} twice"
        env[key] = value
    return env


def test_ci_env_holds_every_required_field_but_the_addresses() -> None:
    env = _ci_env()
    wanted = _required() - CONNECTION_ADDRESSES
    assert wanted, "Settings has required fields"
    missing = sorted(wanted - set(env))
    assert not missing, f"backend/ci.env lacks {missing}"
    empty = sorted(k for k in wanted if not env[k])
    assert not empty, f"backend/ci.env has empty {empty}"
    assert not (set(env) & CONNECTION_ADDRESSES), "addresses are each place's own"
    assert set(env) <= _fields(), f"not fields: {sorted(set(env) - _fields())}"


def _steps(path: Path) -> list[dict]:
    workflow = yaml.safe_load(path.read_text(encoding="utf-8"))
    return [
        step
        for job in workflow["jobs"].values()
        for step in job.get("steps", [])
        if isinstance(step.get("run"), str)
    ]


def test_drift_check_reads_ci_env() -> None:
    """ci.yml: the step that imports app.main sources ci.env before it, and
    names none of its keys itself (one value, one place)."""
    steps = [s for s in _steps(CI_YML) if "from app.main import app" in s["run"]]
    assert len(steps) == 1, "ci.yml: one step imports app.main"
    [step] = steps
    lines = [line.strip() for line in step["run"].splitlines() if line.strip()]
    assert lines[0] == "set -a; . ./ci.env; set +a"
    assert step.get("working-directory") == "backend"
    assert not set(step.get("env") or {}) & set(_ci_env())


def test_the_suite_reads_ci_env() -> None:
    """backend-tests.yml: the docker run of the suite takes ci.env as its
    env file and passes none of its keys again with -e."""
    steps = [s for s in _steps(BACKEND_TESTS_YML) if "python -m pytest" in s["run"]]
    assert len(steps) == 1, "backend-tests.yml: one step runs the suite"
    run = steps[0]["run"]
    assert "--env-file backend/ci.env" in run
    passed = set(re.findall(r"-e ([A-Z][A-Z0-9_]*)", run))
    assert passed, "the suite still passes its own addresses"
    assert not passed & set(_ci_env())
