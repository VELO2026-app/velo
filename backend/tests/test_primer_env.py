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

BE-193: one more statement holds the storage stack's root login as a
constant of docker-compose.storage.yml, not a value of primer.yaml's env.
BE-194 part 2: one more holds the frontend's instance values -- the
languages and the flag of every option -- against primer.yaml.
BE-193 part 2a: the point of velo-storage reaches the app, what velo
provides is what /health names, and each CI place passes its own.
BE-193 part 2b: velo-storage-init is the stack's job, and the storage's
secrets are of one minted form, in CI too.
BE-207: the slot `texts` against the frontend that reads it.

The files are read from the repository root -- in the test image they are
at /, where Path(__file__).resolve().parents[2] lands from /app/tests
(backend/Dockerfile, stage `test`).
"""

import re
from pathlib import Path

import pytest
import yaml

from app.core import report
from app.core.config import Settings
from app.core.i18n import SUPPORTED_LANGUAGES
from app.modules.mcp.oauth import MCP_OAUTH_CIMD_ALLOWED_HOSTS

ROOT = Path(__file__).resolve().parents[2]
COMPOSE = ROOT / "docker-compose.yml"
STORAGE_COMPOSE = ROOT / "docker-compose.storage.yml"
PRIMER = ROOT / "primer.yaml"
CI_ENV = ROOT / "backend" / "ci.env"
CI_YML = ROOT / ".github" / "workflows" / "ci.yml"
BACKEND_TESTS_YML = ROOT / ".github" / "workflows" / "backend-tests.yml"

# Each CI place has its own -- they are not in ci.env: the addresses of its
# services, and (BE-193) the storage secret -- the job that runs a live
# storage sets the backend's key to its own secret, and the suite must hold
# that very one.
CONNECTION_ADDRESSES = frozenset({"DATABASE_URL", "REDIS_URL", "STORAGE_ENDPOINT"})
PLACE_SECRETS = frozenset({"STORAGE_SECRET_KEY"})
PLACE_OWN = CONNECTION_ADDRESSES | PLACE_SECRETS


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
    [
        "SECRET_KEY",
        "APP_ENV",
        "ALLOW_STRIPE_STUB",
        "ALLOW_ZOOM_STUB",
        "CORS_ORIGINS",
        "PUBLIC_LINK_BASE",
        "MCP_OAUTH_ISSUER_URL",
    ],
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


# -- languages (BE-196, protocol 5.2.2) ----------------------------------------


def test_primer_yaml_declares_exactly_the_product_languages() -> None:
    """primer.yaml `languages` is the product's set, core/i18n.py
    SUPPORTED_LANGUAGES: the machine checks a passport against the first,
    the backend against the second -- a language in one only would pass the
    machine and refuse the start, or the other way round."""
    declared = yaml.safe_load(PRIMER.read_text(encoding="utf-8"))["languages"]
    assert isinstance(declared, list) and declared, "languages: a non-empty list"
    assert len(declared) == len(set(declared)), "languages: each code once"
    assert set(declared) == SUPPORTED_LANGUAGES


def test_the_instance_languages_come_from_the_passport() -> None:
    """LANGUAGES and DEFAULT_LANGUAGE are the passport's `languages` and
    `default_language` (protocol 5.2.2), and compose passes both."""
    env = yaml.safe_load(PRIMER.read_text(encoding="utf-8"))["env"]
    assert env["LANGUAGES"] == {"source": "passport", "key": "languages"}
    assert env["DEFAULT_LANGUAGE"] == {
        "source": "passport",
        "key": "default_language",
    }
    passed = _app_environment()
    assert passed["LANGUAGES"] == "${LANGUAGES:?}"
    assert passed["DEFAULT_LANGUAGE"] == "${DEFAULT_LANGUAGE:?}"


def test_the_frontend_gets_the_languages_and_every_option() -> None:
    """BE-194 part 2. The frontend takes its instance values at the start of
    the container, not at the build (protocol 5.2.2, 5.2.3): LANGUAGES,
    DEFAULT_LANGUAGE and the flag OPTION_<O> of every option the product
    declares. The flags are derived from primer.yaml's `options`, so a new
    option cannot reach the backend and be forgotten here. Each is passed as
    exactly ${K:?} and is the passport key of primer.yaml's env."""
    primer = yaml.safe_load(PRIMER.read_text(encoding="utf-8"))
    options = primer["options"]
    assert isinstance(options, list) and options, "primer.yaml declares options"
    compose = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))
    passed = compose["services"]["frontend"]["environment"]
    assert isinstance(passed, dict) and passed, "frontend.environment: not empty"
    wanted = {"LANGUAGES": "languages", "DEFAULT_LANGUAGE": "default_language"}
    wanted |= {f"OPTION_{option.upper()}": f"options.{option}" for option in options}
    for key, passport_key in wanted.items():
        value = passed.get(key)
        assert value == f"${{{key}:?}}", f"frontend: {key} is {value!r}"
        source = primer["env"].get(key)
        assert source == {"source": "passport", "key": passport_key}, (key, source)


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


def test_ci_env_holds_every_required_field_but_each_places_own() -> None:
    """Every required field but what each CI place has of its own. BE-193:
    the storage secret joined the addresses here when it became required --
    before, it had a default and was never asked of ci.env; it stays out of
    ci.env because the place that runs the storage chooses it."""
    env = _ci_env()
    wanted = _required() - PLACE_OWN
    assert wanted, "Settings has required fields"
    missing = sorted(wanted - set(env))
    assert not missing, f"backend/ci.env lacks {missing}"
    empty = sorted(k for k in wanted if not env[k])
    assert not empty, f"backend/ci.env has empty {empty}"
    assert not (set(env) & PLACE_OWN), "each place's own: not in ci.env"
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


def test_the_storage_root_login_is_a_constant_not_a_value() -> None:
    """BE-193, owner ruling 4.11. The service keys of the storage belong to
    the root user that made them; a root user with another login does not
    see them, and the backend gets AccessDenied with a key that exists. So
    the root LOGIN is one constant of docker-compose.storage.yml, the same in
    both of its services, and never a key of primer.yaml's env (a minted
    login would be new after a reinstall over a kept volume). The init
    writes it into the URL of RC_HOST_local, hence its form. The root SECRET
    stays a value: ${RUSTFS_SECRET_KEY:?} in both services, minted."""
    compose = yaml.safe_load(STORAGE_COMPOSE.read_text(encoding="utf-8"))
    environments = {
        name: compose["services"][name]["environment"]
        for name in ("velo-storage", "velo-storage-init")
    }
    logins = {name: env.get("RUSTFS_ACCESS_KEY") for name, env in environments.items()}
    assert len(set(logins.values())) == 1, f"one root login for both: {logins}"
    [login] = set(logins.values())
    assert isinstance(login, str) and re.fullmatch(r"[a-z][a-z0-9-]{2,}", login), (
        f"the root login: a literal of a-z, 0-9 and hyphens, not {login!r}"
    )
    primer = yaml.safe_load(PRIMER.read_text(encoding="utf-8"))["env"]
    assert "RUSTFS_ACCESS_KEY" not in primer, "the root login is not in primer.yaml"
    for name, env in environments.items():
        secret = env.get("RUSTFS_SECRET_KEY")
        assert secret == "${RUSTFS_SECRET_KEY:?}", f"{name}: {secret!r}"
    assert primer["RUSTFS_SECRET_KEY"]["source"] == "minted"


# -- BE-193 part 2a: the point of velo-storage ---------------------------------


def test_the_point_of_the_storage_reaches_the_app() -> None:
    """The stack velo-storage exposes `files`; the app takes its address
    (<alias>:<port>) and compose puts the URL together. The reference
    ${STORAGE_ADDRESS:?} inside that value is what the machine reads to put
    the app on the point's network: a literal URL here would leave the app
    off it (contract 3 rule 22, DM-62)."""
    primer = yaml.safe_load(PRIMER.read_text(encoding="utf-8"))
    point = primer["stacks"]["velo-storage"]["expose"]["files"]
    assert point == {"service": "velo-storage", "port": 9000, "scheme": "http"}
    assert primer["env"]["STORAGE_ADDRESS"] == {
        "source": "address",
        "stack": "velo-storage",
        "endpoint": "files",
    }
    passed = _app_environment()
    assert passed.get("STORAGE_ENDPOINT") == "http://${STORAGE_ADDRESS:?}"
    assert passed.get("STORAGE_SECRET_KEY") == "${STORAGE_SECRET_KEY:?}"


def test_what_velo_provides_is_what_health_names() -> None:
    """primer.yaml's `provides` and /health's `seams.provides`
    (core/report.py PROVIDES) are one list: the machine holds a seam a
    service requires to the live /health after `up`. The name is the one
    the service's own seam carries -- comms v4 takes the storage's point as
    PRODUCT_STORAGE_ADDRESS (BE-194 part 3); a seam matches by name, so the
    app's own STORAGE_ADDRESS was the wrong name for it."""
    provides = yaml.safe_load(PRIMER.read_text(encoding="utf-8"))["provides"]
    assert isinstance(provides, dict) and provides, "primer.yaml provides"
    assert report.PROVIDES, "report.PROVIDES is not empty"
    assert len(set(report.PROVIDES)) == len(report.PROVIDES), "each name once"
    assert set(provides) == set(report.PROVIDES)
    point = {"stack": "velo-storage", "endpoint": "files"}
    assert provides["PRODUCT_STORAGE_ADDRESS"] == point


def test_each_place_passes_its_own() -> None:
    """What ci.env does not hold, each CI place that builds Settings passes
    itself: the suite with -e, the drift check in its step's env. Without
    one the app does not start there (BE-190 FIX 2, BE-193)."""
    own = _required() & PLACE_OWN
    assert own >= {"DATABASE_URL", "STORAGE_ENDPOINT", "STORAGE_SECRET_KEY"}
    [suite] = [s for s in _steps(BACKEND_TESTS_YML) if "python -m pytest" in s["run"]]
    passed = set(re.findall(r"-e ([A-Z][A-Z0-9_]*)", suite["run"]))
    assert own <= passed, f"the suite lacks {sorted(own - passed)}"
    [drift] = [s for s in _steps(CI_YML) if "from app.main import app" in s["run"]]
    given = {k for k, v in (drift.get("env") or {}).items() if str(v).strip()}
    assert own <= given, f"the drift check lacks {sorted(own - given)}"


# -- BE-193 part 2b: the job of velo-storage, the secrets of the storage -------

STORAGE_SECRETS = ("STORAGE_SECRET_KEY", "RUSTFS_SECRET_KEY")
MINTED_ALPHABET = re.compile(r"[A-Za-z0-9_-]+")


def _services(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))["services"]


def test_velo_storage_init_is_the_job_of_its_stack() -> None:
    """Contract 3 rule 24 (DM-22). The machine runs the job after what it
    depends on is healthy and before the rest -- it learns that order from
    the job's own depends_on (needed_by), so velo-storage stays there; it
    checks neither that nor the job's healthcheck, this does."""
    stack = yaml.safe_load(PRIMER.read_text(encoding="utf-8"))["stacks"]["velo-storage"]
    assert stack.get("jobs") == {"storage-init": {"service": "velo-storage-init"}}
    job = _services(STORAGE_COMPOSE)["velo-storage-init"]
    assert job.get("restart", "no") == "no", job.get("restart")
    assert "healthcheck" not in job
    assert set(job.get("depends_on") or {}) == {"velo-storage"}


def test_nothing_depends_on_the_job_and_every_other_service_is_checked() -> None:
    """No service of either compose depends on the job -- compose would run
    it again as a dependency -- and every service but the job declares a
    healthcheck (protocol 3.4)."""
    every = {**_services(COMPOSE), **_services(STORAGE_COMPOSE)}
    assert len(every) == len(_services(COMPOSE)) + len(_services(STORAGE_COMPOSE))
    for name, body in every.items():
        assert "velo-storage-init" not in (body.get("depends_on") or {}), name
        if name != "velo-storage-init":
            assert body.get("healthcheck"), f"{name}: no healthcheck"


def test_the_storage_secrets_are_minted_at_40_in_ci_too() -> None:
    """RustFS takes the secret of a service key of 8..40; the machine mints
    a value once, of exactly `length`. CI makes the storage with values of
    that very form, so its live run is the edge the machine gives."""
    env = yaml.safe_load(PRIMER.read_text(encoding="utf-8"))["env"]
    job = yaml.safe_load(BACKEND_TESTS_YML.read_text(encoding="utf-8"))["jobs"]
    ci = {k: v for j in job.values() for k, v in (j.get("env") or {}).items()}
    for name in STORAGE_SECRETS:
        assert env[name] == {"source": "minted", "length": 40}, name
        value = ci.get(name)
        assert isinstance(value, str) and len(value) == 40, (name, value)
        assert MINTED_ALPHABET.fullmatch(value), name


# -- BE-207: the slot `texts` --------------------------------------------------

FRONTEND = ROOT / "frontend"


def _texts_slot() -> dict:
    slot = yaml.safe_load(PRIMER.read_text(encoding="utf-8"))["packages"]["texts"]
    assert isinstance(slot, dict) and slot, "primer.yaml declares packages.texts"
    return slot


def test_the_texts_package_is_mounted_whole_where_nginx_serves_its_ui() -> None:
    """The machine runs `validate` with <dir> = the path of the mount
    (steps/packages.py, 24b4ea8), and validate-texts reads a package's ROOT
    (primer-package.yaml, ui/<lang>.json). So the package is mounted whole,
    with no `from`, and nginx's alias is its ui/ below that path."""
    slot = _texts_slot()
    assert slot["apply"] == "runtime"
    mounts = slot["mount"]
    assert mounts, "the slot mounts"
    front = [m for m in mounts if m.get("service") == "frontend"]
    assert len(front) == 1, mounts
    assert set(front[0]) == {"service", "path"}, front[0]
    conf = (FRONTEND / "nginx.conf").read_text(encoding="utf-8")
    aliases = re.findall(r"location /texts/ui/ \{\s*alias ([^;]+);", conf)
    assert aliases == [front[0]["path"] + "/ui/"], aliases


def test_the_texts_validate_is_a_command_of_the_frontend_image() -> None:
    """`validate` is validate-texts with the machine's <dir>, and the
    frontend's image makes that command; the slot's contract is the major
    the check reads."""
    slot = _texts_slot()
    assert slot["validate"] == "validate-texts <dir>"
    dockerfile = (FRONTEND / "Dockerfile").read_text(encoding="utf-8")
    made = r"^RUN ln -s \S+ /usr/local/bin/validate-texts$"
    assert re.search(made, dockerfile, re.M), "the image makes validate-texts"
    lib = FRONTEND / "scripts" / "lib" / "texts-package.mjs"
    majors = re.findall(r"^const CONTRACT_MAJOR = (\d+)$", lib.read_text(), re.M)
    assert len(majors) == 1, majors
    major = int(majors[0])
    assert slot["contract"] == f">={major},<{major + 1}"
