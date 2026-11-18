# =============================================================================
# BE-190 -- log lines of protocol 9.4 (app/core/logging.py)
# =============================================================================
#
# The suite runs with structlog unconfigured (the app's lifespan does not
# run under the ASGI test client), so the line is built here from the same
# pieces the app uses -- PROCESSORS and PrimerJsonFormatter -- on a logger
# of the test's own, never by configuring structlog for the whole session.
#
# What is pinned here:
#   - a line is one JSON object with exactly the seven fields, and `ctx`
#     only when there is something in it; one line even with a traceback;
#   - from a structlog call: event, msg (`msg=` or the event), ctx (the
#     rest, any value made JSON);
#   - from a stdlib record: event from `extra`, else the logger's name;
#   - request_id is the request's, null outside one;
#   - nothing of the request's context reaches a line: not the address, not
#     the User-Agent;
#   - no log call in app/ or scripts/ passes a person's data by name;
#   - the formatter refuses to start without the release;
#   - logging.json names the formatter and keeps the access line and the
#     HTTP clients' URLs out;
#   - the engine hides statement parameters from its errors.
# =============================================================================

import ast
import io
import json
import logging
import re
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

import pytest
import structlog

from app.core.database import get_engine
from app.core.logging import (
    LOG_FIELDS,
    LOGGING_CONFIG,
    PROCESSORS,
    PrimerJsonFormatter,
)
from app.core.middleware import REQUEST_ID, RequestContextMiddleware

BACKEND = Path(__file__).resolve().parents[1]
_TS = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z")


class _Lines:
    """A stdlib logger of the test's own, writing through the formatter."""

    def __init__(self, name: str) -> None:
        self.stream = io.StringIO()
        handler = logging.StreamHandler(self.stream)
        handler.setFormatter(PrimerJsonFormatter())
        self.logger = logging.getLogger(name)
        self.logger.handlers = [handler]
        self.logger.propagate = False
        self.logger.setLevel(logging.INFO)
        self.structlog = structlog.wrap_logger(
            self.logger,
            processors=PROCESSORS,
            wrapper_class=structlog.stdlib.BoundLogger,
            context_class=dict,
        )

    def read(self) -> list[dict]:
        raw = self.stream.getvalue()
        assert raw.endswith("\n")
        return [json.loads(line) for line in raw.splitlines()]


@pytest.fixture
def lines(request: pytest.FixtureRequest) -> _Lines:
    return _Lines(f"test.velo.{request.node.name}")


# -- the form ---------------------------------------------------------------------


def test_a_structlog_call_is_one_line_of_seven_fields_and_ctx(
    lines: _Lines,
) -> None:
    lines.structlog.info("practice_booked", practice_id="p-1", seats=2)

    [line] = lines.read()
    assert tuple(line) == (*LOG_FIELDS, "ctx")
    assert _TS.fullmatch(line["ts"])
    assert line["level"] == "info"
    assert line["service"] == "velo"
    assert line["release"]
    assert line["request_id"] is None
    assert line["event"] == "practice_booked"
    assert line["msg"] == "practice_booked"
    assert line["ctx"] == {"practice_id": "p-1", "seats": 2}


def test_msg_is_the_given_text_and_an_empty_ctx_is_left_out(
    lines: _Lines,
) -> None:
    lines.structlog.warning("relay_paused", msg="relay paused for a minute")

    [line] = lines.read()
    assert tuple(line) == LOG_FIELDS
    assert line["level"] == "warning"
    assert line["event"] == "relay_paused"
    assert line["msg"] == "relay paused for a minute"


def test_any_value_is_written_and_record_field_names_do_not_break_it(
    lines: _Lines,
) -> None:
    """UUIDs and datetimes are written as text; arguments named like
    LogRecord fields (main.py passes `message`) do not make stdlib refuse
    the record."""
    uid = UUID("12345678-1234-5678-1234-567812345678")
    at = datetime(2026, 11, 7, tzinfo=UTC)

    lines.structlog.info("velo_error", message="m", args="a", user_id=uid, at=at)

    [line] = lines.read()
    assert line["ctx"] == {
        "message": "m",
        "args": "a",
        "user_id": str(uid),
        "at": str(at),
    }


def test_a_traceback_is_inside_msg_and_the_line_stays_one(lines: _Lines) -> None:
    try:
        raise ValueError("boom")
    except ValueError:
        lines.structlog.exception("job_failed", job="j-1")
    try:
        raise KeyError("k")
    except KeyError as exc:
        lines.structlog.error("unhandled_exception", exc_info=exc)

    raw = lines.stream.getvalue()
    assert raw.count("\n") == 2
    first, second = lines.read()
    assert first["level"] == "error" and first["event"] == "job_failed"
    assert first["msg"].startswith("job_failed\nTraceback")
    assert "ValueError: boom" in first["msg"]
    assert first["ctx"] == {"job": "j-1"}
    assert "KeyError: 'k'" in second["msg"]


def test_a_stdlib_record_takes_event_and_ctx_from_extra(lines: _Lines) -> None:
    lines.logger.warning(
        "object %s kept", "o-1", extra={"event": "storage.kept", "ctx": {"n": 1}}
    )
    lines.logger.info("plain line")

    tagged, plain = lines.read()
    assert tagged["event"] == "storage.kept"
    assert tagged["msg"] == "object o-1 kept"
    assert tagged["ctx"] == {"n": 1}
    assert plain["event"] == lines.logger.name
    assert plain["msg"] == "plain line"
    assert "ctx" not in plain


# -- request id, and nothing else of the request -----------------------------------


def test_the_line_names_the_request_being_served(lines: _Lines) -> None:
    token = REQUEST_ID.set("req-line-1")
    try:
        lines.structlog.info("in_request")
    finally:
        REQUEST_ID.reset(token)
    lines.structlog.info("after_request")

    inside, outside = lines.read()
    assert inside["request_id"] == "req-line-1"
    assert outside["request_id"] is None


async def test_the_address_and_agent_never_reach_a_line(lines: _Lines) -> None:
    """A line written during a request through the middleware: the request
    id is there, the client address and the User-Agent are nowhere."""

    async def inner(scope, receive, send) -> None:
        lines.structlog.info("handled", practice_id="p-2")

    async def send(message) -> None:
        pass

    scope = {
        "type": "http",
        "client": ("172.18.0.1", 5000),
        "headers": [
            (b"x-real-ip", b"9.9.9.9"),
            (b"user-agent", b"AgentOfPerson/1.0"),
            (b"x-request-id", b"req-mw-1"),
        ],
    }
    await RequestContextMiddleware(inner)(scope, None, send)

    [line] = lines.read()
    assert line["request_id"] == "req-mw-1"
    assert line["ctx"] == {"practice_id": "p-2"}
    raw = lines.stream.getvalue()
    assert "9.9.9.9" not in raw and "AgentOfPerson" not in raw


# -- a person's data by name ---------------------------------------------------------

_PERSON = {
    "telegram_id",
    "username",
    "first_name",
    "last_name",
    "full_name",
    "display_name",
    "name",
    "email",
    "phone",
    "ip",
    "ip_address",
    "source",
    "user_agent",
}


def test_no_log_call_passes_a_persons_data_by_name() -> None:
    """Every `logger.<level>(...)` in app/ and scripts/: no argument named
    after a person's data (protocol 9.4). Internal ids (`user_id`) are fine.
    The census is of names -- values under neutral names are the KNOWN
    CEILING at PrimerJsonFormatter."""
    levels = {"debug", "info", "warning", "error", "exception", "critical"}
    calls = 0
    found: list[str] = []
    for path in sorted([*BACKEND.glob("app/**/*.py"), *BACKEND.glob("scripts/*.py")]):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if not (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr in levels
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "logger"
            ):
                continue
            calls += 1
            for kw in node.keywords:
                if kw.arg in _PERSON:
                    found.append(f"{path.relative_to(BACKEND)}:{node.lineno} {kw.arg}")
    assert calls > 300  # the census saw the tree
    assert found == []


# -- start and configuration ---------------------------------------------------------


def test_the_formatter_refuses_to_start_without_the_release(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PRIMER_RELEASE", "")
    with pytest.raises(RuntimeError, match="PRIMER_RELEASE"):
        PrimerJsonFormatter()


def test_logging_json_names_the_formatter_and_quiets_what_leaks() -> None:
    config = json.loads(LOGGING_CONFIG.read_text(encoding="utf-8"))
    assert config["formatters"]["primer"]["()"] == (
        f"{PrimerJsonFormatter.__module__}.{PrimerJsonFormatter.__name__}"
    )
    assert config["root"]["handlers"] == ["stdout"]
    assert config["handlers"]["stdout"]["formatter"] == "primer"
    loggers = config["loggers"]
    for name in ("uvicorn.access", "httpx", "httpcore"):
        assert loggers[name]["level"] == "WARNING", name
    for name in ("uvicorn", "uvicorn.error"):
        assert loggers[name]["propagate"] is True and not loggers[name]["handlers"]
    assert config["disable_existing_loggers"] is False


def test_the_engine_hides_statement_parameters() -> None:
    assert get_engine().sync_engine.hide_parameters is True
