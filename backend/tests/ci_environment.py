"""The settings' environment of a test run, before app is imported.

The deploy machine runs the suite in a container whose environment holds the
test database's DATABASE_URL and nothing else (pridem steps/tests.py;
PRIMER-DM-REVIEW-0004 item 1, BE-194 part 10). The keys Settings requires
come from backend/ci.env -- the one place of made-up values (par0 section
14) -- and what the environment already holds is never overridden: CI
(--env-file ci.env plus its own -e) runs as before.

Each place's own keys are not in ci.env; where the run did not bring them,
they are the machine test container's:

* REDIS_URL -- the compose service redis-test that test.services of
  primer.yaml names: a Redis with no password and no data, so the suite
  never touches the live one (tests/redis_isolation.py moves it to db 15);
* STORAGE_ENDPOINT, STORAGE_SECRET_KEY -- there is no storage: the stack
  velo-storage is not up for the tests. The tests marked `storage` skip,
  unless the run says it must have one (VELO_TESTS_STORAGE=required, CI).

tests/__init__.py calls apply_ci_env(): the package is imported before
tests/conftest.py and before any test module, so before app.
"""

import os
import socket
from collections.abc import MutableMapping
from pathlib import Path
from urllib.parse import urlsplit

import pytest

# /backend/ci.env in the test image (backend/Dockerfile, stage test), the
# repository's backend/ci.env in a checkout.
CI_ENV = Path(__file__).resolve().parents[2] / "backend" / "ci.env"
MACHINE_REDIS_URL = "redis://redis-test:6379/0"
NO_STORAGE_ENDPOINT = "http://no-storage.invalid:9000"
NO_STORAGE_SECRET = "no-storage-in-this-test-run"
STORAGE_MODE = "VELO_TESTS_STORAGE"


def ci_env_values(path: Path = CI_ENV) -> dict[str, str]:
    """KEY=value lines of ci.env; comments and blank lines skipped."""
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep or not key:
            raise ValueError(f"{path}: not KEY=value: {raw!r}")
        values[key] = value
    return values


def apply_ci_env(
    environ: MutableMapping[str, str] = os.environ, path: Path = CI_ENV
) -> None:
    """Fill what the run did not bring; leave what it did."""
    if not path.is_file():
        pytest.exit(
            f"tests: {path} is not there -- the test image carries backend/ci.env "
            "(BE-194 part 10)",
            returncode=4,
        )
    for key, value in ci_env_values(path).items():
        environ.setdefault(key, value)
    environ.setdefault("REDIS_URL", MACHINE_REDIS_URL)
    environ.setdefault("STORAGE_ENDPOINT", NO_STORAGE_ENDPOINT)
    environ.setdefault("STORAGE_SECRET_KEY", NO_STORAGE_SECRET)


def storage_reachable(endpoint: str, timeout: float = 1.0) -> bool:
    """One TCP connection to the storage's host:port."""
    parts = urlsplit(endpoint)
    if not parts.hostname or parts.port is None:
        return False
    try:
        with socket.create_connection((parts.hostname, parts.port), timeout=timeout):
            return True
    except OSError:
        return False


def storage_gate(reachable: bool, required: bool) -> str:
    """What a test marked `storage` does: "run", "skip" or "exit"."""
    if reachable:
        return "run"
    return "exit" if required else "skip"
