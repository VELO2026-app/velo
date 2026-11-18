# =============================================================================
# VELO Backend -- Log lines of protocol 9.4 (BE-190)
# =============================================================================
#
# Every line is one JSON object with seven fields and an optional `ctx`:
#
#   {"ts": "2026-11-07T10:00:00.123Z", "level": "info", "service": "velo",
#    "release": "v1.2.3", "request_id": "...", "event": "practice_booked",
#    "msg": "practice_booked", "ctx": {"practice_id": "..."}}
#
# ONE FORMATTER FOR EVERY SOURCE. structlog is routed into stdlib logging
# (setup_logging below), so a structlog call, a stdlib logger
# (core/storage.py, sqlalchemy) and uvicorn's own lines all end in
# PrimerJsonFormatter, named in backend/logging.json:
#   - uvicorn is started with `--log-config logging.json` (backend/Dockerfile),
#     which also covers the supervisor process of `--workers`, which never
#     imports the app;
#   - migrations/env.py applies the same file to `alembic upgrade`;
#   - setup_logging applies it when the process was started without it.
#   JSON has no comments, so the file's choices are explained here:
#   uvicorn.access is at WARNING -- its INFO line is the client's address
#   and the path of every request, and the address is a person's data;
#   httpx and httpcore are at WARNING -- their INFO line is the full URL of
#   every outgoing request, query included; sqlalchemy is at WARNING.
#
# WHAT A LINE TAKES FROM A CALL:
#   structlog  logger.info("practice_booked", practice_id=...):
#              event -- the first argument; msg -- the `msg=` argument when
#              given, else the event; ctx -- every other argument.
#   stdlib     logger.warning("...", extra={"event": ..., "ctx": {...}}):
#              event -- `extra["event"]`, else the logger's name; msg -- the
#              message; ctx -- `extra["ctx"]` when it is an object.
#   request_id -- the request being served (core/middleware.py), null
#              outside a request.
#   A traceback goes INSIDE msg, so a line stays one line.
#
# NOTHING ELSE REACHES A LINE. The request's context (client address,
# User-Agent) lives in core/middleware.py and is never merged into a line:
# a person's data has no place in the journal -- names, e-mail, phones,
# telegram_id, username (protocol 9.4). Internal ids (UUIDs) are fine.
#
# IN THE TEST SUITE structlog stays unconfigured -- the app's lifespan does
# not run under the ASGI test client -- so tests read events with
# structlog.testing.capture_logs, and this formatter is tested directly.
# =============================================================================

import json
import logging
import logging.config
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import structlog

from app.core.middleware import current_request_id

SERVICE = "velo"
"""The stack's name in every line and in /health -- `name` of primer.yaml."""

LOG_FIELDS = ("ts", "level", "service", "release", "request_id", "event", "msg")
LOG_CTX = "ctx"

LOGGING_CONFIG = Path(__file__).resolve().parents[2] / "logging.json"
"""backend/logging.json in the repository, /app/logging.json in the image."""

# The attribute a structlog call hands its event to the formatter in.
_STRUCTURED = "velo_structured"

# Guard flag for idempotency (TD-012): a second call is a no-op.
_configured: bool = False


def _release() -> str:
    """PRIMER_RELEASE, which the image carries (backend/Dockerfile)."""
    release = os.environ.get("PRIMER_RELEASE", "")
    if not release:
        raise RuntimeError(
            "PRIMER_RELEASE is not set: every log line names the release"
        )
    return release


class PrimerJsonFormatter(logging.Formatter):
    """One JSON object per record: LOG_FIELDS, then LOG_CTX if there is one.

    KNOWN CEILING -- the text of an exception is written as it is.
      1. Mechanics: a traceback and an exception's message go into msg
         unchanged. An unhandled error can carry a value from the data it
         failed on -- Postgres' DETAIL of a unique violation names the key
         and its value ("Key (...)=(...)"), and so does any third-party
         message. The SQL parameters themselves are kept out
         (hide_parameters, core/database.py), and log calls that used to
         pass a third party's response body pass its status and class
         (BE-190).
      2. Status: acknowledged by design.
      3. Task: none -- no card; the residue is what a traceback is.
      4. Unfreeze trigger: a person's data is found in a line of the
         journal on a server.
      5. Agreed fix: change the call or the exception that carried it, at
         its source.
      6. Rejected: scrubbing messages here by pattern -- it cannot know
         every form a value takes, and a scrubbed traceback can stop being
         the evidence it is kept for.
    """

    def __init__(self, service: str = SERVICE) -> None:
        super().__init__()
        if not service:
            raise ValueError("PrimerJsonFormatter needs the service name")
        self._service = service
        self._release = _release()

    def format(self, record: logging.LogRecord) -> str:
        structured = record.__dict__.get(_STRUCTURED)
        if isinstance(structured, dict):
            event = structured["event"]
            msg = structured["msg"]
            ctx: Any = structured["ctx"]
        else:
            given = record.__dict__.get("event")
            event = given if isinstance(given, str) and given else record.name
            msg = record.getMessage()
            ctx = record.__dict__.get(LOG_CTX)
        if record.exc_info:
            msg = f"{msg}\n{self.formatException(record.exc_info)}"
        if record.stack_info:
            msg = f"{msg}\n{self.formatStack(record.stack_info)}"
        line: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "level": record.levelname.lower(),
            "service": self._service,
            "release": self._release,
            "request_id": current_request_id(),
            "event": event,
            "msg": msg,
        }
        if isinstance(ctx, dict) and ctx:
            line[LOG_CTX] = ctx
        return json.dumps(line, ensure_ascii=False, default=str)


def _to_stdlib(
    _logger: Any, _method: str, event_dict: dict[str, Any]
) -> tuple[tuple[Any, ...], dict[str, Any]]:
    """The last structlog processor: one stdlib call carrying the event.

    The event travels as one attribute of the record, never spread over it:
    an argument named like a LogRecord field ("message", "args") would
    otherwise make stdlib refuse the record.
    """
    event = str(event_dict.pop("event", ""))
    exc_info = event_dict.pop("exc_info", None)
    event_dict.pop("stack_info", None)
    msg = event_dict.pop("msg", None)
    structured = {
        "event": event,
        "msg": str(msg) if msg is not None else event,
        "ctx": event_dict,
    }
    kwargs: dict[str, Any] = {"extra": {_STRUCTURED: structured}}
    if exc_info:
        kwargs["exc_info"] = exc_info
    return (event,), kwargs


PROCESSORS: list[Any] = [structlog.stdlib.filter_by_level, _to_stdlib]
"""structlog's chain: drop below the level, then hand the event to stdlib."""


def configure_stdlib_logging(level: str | None = None) -> None:
    """Apply backend/logging.json; `level` overrides the root's level."""
    config = json.loads(LOGGING_CONFIG.read_text(encoding="utf-8"))
    if level is not None:
        config["root"]["level"] = level.upper()
    logging.config.dictConfig(config)


def setup_logging(log_level: str = "INFO") -> None:
    """Route structlog into stdlib logging and the formatter above.

    stdlib is configured from backend/logging.json unless uvicorn already
    applied it (`--log-config`, the root has its handler); the root's
    level is the setting either way.
    """
    global _configured
    if _configured:
        return
    _configured = True

    level = log_level.upper()
    root = logging.getLogger()
    if not any(isinstance(h.formatter, PrimerJsonFormatter) for h in root.handlers):
        configure_stdlib_logging(level)
    root.setLevel(level)

    structlog.configure(
        processors=PROCESSORS,
        context_class=dict,
        wrapper_class=structlog.stdlib.BoundLogger,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )
