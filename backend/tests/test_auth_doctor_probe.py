# =============================================================================
# velo doctor's probe of browser sign-in (Standalone F3 tails, observation 7)
# =============================================================================
#
# app/modules/auth/doctor_probe.py prints ONE line for `velo doctor`:
# `missing=<KEY,KEY> cors=<reason>` or `error=<ExceptionClass>`. The rule it
# reports is browser_login.state() -- the same facts the sign-in endpoints
# check. The line carries key NAMES and a reason word, never a value: not in
# the output, not in a traceback, not when the probe itself fails.
# =============================================================================

import os
import subprocess
import sys
from pathlib import Path

import pytest

import app.modules.auth as auth_package
from app.core.config import settings
from app.modules.auth import browser_login, doctor_probe

CLIENT_ID = "7777000111"
SECRET = "doctor-secret-must-not-leak-5f1c"
FRONT = "https://front.doctor-host.test"
VALUES = (CLIENT_ID, SECRET, FRONT, "doctor-host")

BACKEND_DIR = Path(__file__).resolve().parents[1]


@pytest.fixture
def keys(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    monkeypatch.setattr(settings, "telegram_login_client_id", CLIENT_ID)
    monkeypatch.setattr(settings, "telegram_login_client_secret", SECRET)
    monkeypatch.setattr(settings, "cors_origins", FRONT)
    return monkeypatch


def _probe(capsys: pytest.CaptureFixture[str]) -> tuple[str, str]:
    assert doctor_probe.main() == 0
    out, err = capsys.readouterr()
    return out, err


def _no_values(*texts: str) -> None:
    for text in texts:
        for value in VALUES:
            assert value not in text, value


# -- state(): every cell of the grid ------------------------------------------


@pytest.mark.parametrize(
    ("client_id", "secret", "missing"),
    [
        (CLIENT_ID, SECRET, []),
        (CLIENT_ID, "", ["TELEGRAM_LOGIN_CLIENT_SECRET"]),
        ("", SECRET, ["TELEGRAM_LOGIN_CLIENT_ID"]),
        ("", "", ["TELEGRAM_LOGIN_CLIENT_ID", "TELEGRAM_LOGIN_CLIENT_SECRET"]),
    ],
    ids=["all", "no-secret", "no-id", "none"],
)
def test_state_names_the_missing_keys(
    keys: pytest.MonkeyPatch, client_id: str, secret: str, missing: list[str]
) -> None:
    keys.setattr(settings, "telegram_login_client_id", client_id)
    keys.setattr(settings, "telegram_login_client_secret", secret)
    assert browser_login.state() == (missing, "ok")


@pytest.mark.parametrize(
    ("cors", "reason"),
    [
        (FRONT, "ok"),
        (f"{FRONT}, ", "ok"),
        ("", "empty"),
        (" , ", "empty"),
        (f"{FRONT},https://other.test", "several"),
        (f"{FRONT},{FRONT}", "several"),  # the same address twice
        ("*", "wildcard"),
        ("http://front.test", "not_https"),
        (f"{FRONT}/", "not_origin"),
        (f"{FRONT}?a=1", "not_origin"),
        ("https://u:p@front.test", "not_origin"),
    ],
)
def test_state_gives_the_cors_reason(
    keys: pytest.MonkeyPatch, cors: str, reason: str
) -> None:
    keys.setattr(settings, "cors_origins", cors)
    assert browser_login.state()[1] == reason


def test_configured_exactly_when_the_endpoints_are(keys: pytest.MonkeyPatch) -> None:
    """state() and the endpoints read the same two facts."""
    for cors in (FRONT, "", "*", f"{FRONT},https://x.test"):
        keys.setattr(settings, "cors_origins", cors)
        missing, reason = browser_login.state()
        assert (not missing and reason == "ok") == (
            browser_login.return_url() is not None
        )


# -- the probe's line ---------------------------------------------------------


def test_probe_line_configured(
    keys: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    out, err = _probe(capsys)
    assert out == "missing= cors=ok\n"
    assert err == ""
    _no_values(out, err)


def test_probe_line_names_missing_keys_and_the_reason(
    keys: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    keys.setattr(settings, "telegram_login_client_secret", "")
    keys.setattr(settings, "cors_origins", "http://front.doctor-host.test")
    out, err = _probe(capsys)
    assert out == "missing=TELEGRAM_LOGIN_CLIENT_SECRET cors=not_https\n"
    _no_values(out, err)


def test_a_failure_inside_prints_the_class_name_only(
    keys: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """The error path: an exception whose MESSAGE quotes every value."""

    def leaking_state():
        raise RuntimeError(f"boom {CLIENT_ID} {SECRET} {FRONT}")

    keys.setattr(browser_login, "state", leaking_state)
    out, err = _probe(capsys)
    assert out == "error=RuntimeError\n"
    assert err == ""  # no traceback
    _no_values(out, err)


def test_a_failed_import_prints_the_class_name_only(
    keys: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    keys.delattr(auth_package, "browser_login")
    keys.setitem(sys.modules, "app.modules.auth.browser_login", None)
    out, err = _probe(capsys)
    assert out == "error=ModuleNotFoundError\n"  # an ImportError subclass
    assert err == ""


def test_the_real_process_with_broken_settings_leaks_nothing() -> None:
    """`python -m app.modules.auth.doctor_probe` as velo doctor runs it, with
    settings that fail validation: pydantic's ValidationError quotes the bad
    input -- the probe must print only the class name, and no traceback."""
    leak = "leakme-7731"
    env = dict(os.environ)
    env.update(
        {
            "SESSION_TTL_DAYS": leak,  # an int field: validation fails
            "TELEGRAM_LOGIN_CLIENT_ID": CLIENT_ID,
            "TELEGRAM_LOGIN_CLIENT_SECRET": SECRET,
            "CORS_ORIGINS": FRONT,
        }
    )
    result = subprocess.run(
        [sys.executable, "-m", "app.modules.auth.doctor_probe"],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert result.returncode == 0
    assert result.stdout == "error=ValidationError\n"
    assert result.stderr == ""
    for value in (*VALUES, leak):
        assert value not in result.stdout + result.stderr


def test_the_real_process_configured() -> None:
    env = dict(os.environ)
    env.update(
        {
            "TELEGRAM_LOGIN_CLIENT_ID": CLIENT_ID,
            "TELEGRAM_LOGIN_CLIENT_SECRET": SECRET,
            "CORS_ORIGINS": FRONT,
        }
    )
    result = subprocess.run(
        [sys.executable, "-m", "app.modules.auth.doctor_probe"],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert result.stdout == "missing= cors=ok\n"
    for value in VALUES:
        assert value not in result.stdout + result.stderr
