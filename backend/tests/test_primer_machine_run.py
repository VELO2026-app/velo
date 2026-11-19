"""The deploy machine's run of velo: the storage gate of the tests and the
log lines at the app's start (BE-194 part 10, PRIMER-DM-REVIEW-0004).

The machine judges every line the app writes at `up` (pridem
conformance/stack.py): a JSON object with ts, level, service, release,
request_id, event and msg, nothing else but an optional ctx object, and
service the name of the stack. A line structlog writes before the lifespan
configures it -- at the import of app.main -- would be plain text: the start
is run here as the image's CMD runs it, and every line is judged so.
"""

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest
import yaml

from tests.ci_environment import storage_gate

BACKEND = Path(__file__).resolve().parents[1]
PRIMER = Path(__file__).resolve().parents[2] / "primer.yaml"
LOG_FIELDS = {"ts", "level", "service", "release", "request_id", "event", "msg"}


@pytest.mark.parametrize(
    ("reachable", "required", "gate"),
    [
        (True, False, "run"),
        (True, True, "run"),
        (False, False, "skip"),
        (False, True, "exit"),
    ],
)
def test_the_storage_gate(reachable: bool, required: bool, gate: str) -> None:
    assert storage_gate(reachable, required) == gate


def _stack_of_the_app() -> str:
    stacks = yaml.safe_load(PRIMER.read_text(encoding="utf-8"))["stacks"]
    [name] = [n for n, s in stacks.items() if s.get("app")]
    return name


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_every_line_at_the_apps_start_is_the_machines_json() -> None:
    """Started as the image's CMD starts it (two workers, logging.json),
    every line up to both workers' startup -- at most 50, what the machine
    reads -- is a JSON object of the protocol's fields."""
    command = [
        sys.executable,
        "-m",
        "uvicorn",
        "app.main:app",
        "--host",
        "127.0.0.1",
        "--port",
        str(_free_port()),
        "--workers",
        "2",
        "--no-proxy-headers",
        "--log-config",
        str(BACKEND / "logging.json"),
    ]
    env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    process = subprocess.Popen(
        command,
        cwd=BACKEND,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    lines: list[str] = []
    try:
        deadline = time.monotonic() + 60
        assert process.stdout is not None
        while time.monotonic() < deadline and len(lines) < 50:
            line = process.stdout.readline()
            if not line:
                break
            lines.append(line.rstrip("\n"))
            if sum("startup complete" in seen.lower() for seen in lines) >= 2:
                break
    finally:
        process.terminate()
        process.wait(timeout=20)
    assert lines, "the app wrote nothing at its start"
    stack = _stack_of_the_app()
    for number, line in enumerate(lines, 1):
        record = json.loads(line)  # not JSON: the machine's log-not-json
        assert isinstance(record, dict), (number, line)
        assert set(record) >= LOG_FIELDS, (number, line)
        assert set(record) <= LOG_FIELDS | {"ctx"}, (number, line)
        assert isinstance(record.get("ctx", {}), dict), (number, line)
        assert record["service"] == stack, (number, line)
    assert sum("startup complete" in line.lower() for line in lines) >= 1, lines[-3:]
