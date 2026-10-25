# =============================================================================
# VELO -- the notification guard (BE-174)
# =============================================================================
# Every notification_request the backend writes into the outbox during the
# suite is checked against the comms profile at the moment it is INSERTED:
#
#   - its type is declared in comms-profile/types.yaml (comms refuses an
#     undeclared type at intake);
#   - every variable a sheet of that type reads, in every locale and every
#     channel, is in the job and is not None.
#
# WHY. comms fills a sheet from the job (comms 3.10.0, app/engine/
# formatters.py build_variables): every action_data key is a variable, and
# `title` / `body` are set by comms itself from the job's own text. A field
# that names a variable the job does not carry is not printed -- the whole
# field falls back to the stored text (deploy/INTEGRATION.md section 3) --
# and a None value prints as "None". Both reach a person; neither fails
# anything on velo's side. Three such sites were found by hand (BE-174);
# the guard holds the class, including every site whose type or payload is
# built at run time, through whichever test happens to pass it.
#
# HOW. An ORM `before_insert` listener on OutboxEvent: every outbox row in
# app/ is born in core/events/service.py emit_event as OutboxEvent(...) +
# session.add, so the listener sees each one, whatever the call site and
# whatever a test does afterwards. It does not RAISE -- an emit inside a
# try/except would swallow it -- it records; conftest.py turns the record
# into a failure when the test is torn down, so a test that cleans the
# outbox before it ends, or never looks at the outbox, still fails.
#
# BLIND SPOTS, said out loud: a test that replaces emit_notification /
# emit_event with a stand-in writes no row, and a type no test emits is
# never seen. The second list is printed at the end of every run
# (conftest.py, pytest_terminal_summary); a mocked site shows up there.
#
# OPT-OUT: @pytest.mark.notification_by_hand, ONLY for a test of the
# emitting MECHANISM that hands emit_notification a payload of its own
# making (a synthetic action_data for a real type). A product site never
# qualifies -- that is what the guard is for.
# =============================================================================

from __future__ import annotations

import string
from dataclasses import dataclass, field
from functools import cache
from typing import Any

import yaml
from sqlalchemy import event

from app.core.events.models import OutboxEvent
from app.core.events.service import EVENT_NOTIFICATION_REQUEST
from tests.test_master_notifications import _profile_dir

LOCALES = ("ru", "en")

# Set by comms from the job's own text, never read from action_data
# (build_variables: "core fields always win over action_data").
_COMMS_VARIABLES = frozenset({"title", "body"})


@cache
def declared_types() -> frozenset[str]:
    """Every type comms-profile/types.yaml declares."""
    doc = yaml.safe_load((_profile_dir() / "types.yaml").read_text())
    return frozenset(doc["types"])


@cache
def sheet_reads(type_key: str) -> tuple[tuple[str, str, str, str], ...]:
    """(locale, channel, field, variable) for every variable a sheet of the
    type reads -- every string field of every channel in every locale.

    Presentation flags (disable_preview, silent) are not strings and are
    not rendered; button_text is, with the same variables as the text.
    """
    reads: list[tuple[str, str, str, str]] = []
    for locale in LOCALES:
        sheets = _sheets(locale)
        for channel, fields in (sheets.get(type_key) or {}).items():
            for name, text in fields.items():
                if not isinstance(text, str):
                    continue
                for _, variable, _, _ in string.Formatter().parse(text):
                    if variable:
                        reads.append((locale, channel, name, variable))
    return tuple(reads)


@cache
def _sheets(locale: str) -> dict:
    return yaml.safe_load(
        (_profile_dir() / "templates" / f"{locale}.yaml").read_text()
    )


_MISSING = object()


def _resolve(variables: dict[str, Any], path: str) -> Any:
    """`name` or `name[key][key]` -- the paths str.format resolves.

    `{a.b}` is refused by comms when it loads the profile, so attribute
    paths cannot reach a sheet and are not resolved here.
    """
    root, _, rest = path.partition("[")
    value: Any = variables.get(root, _MISSING)
    while rest and value is not _MISSING:
        key, _, rest = rest.partition("]")
        rest = rest.removeprefix("[")
        value = value.get(key, _MISSING) if isinstance(value, dict) else _MISSING
    return value


def check(payload: dict[str, Any]) -> list[str]:
    """The guard's verdict on one notification_request payload -- [] is
    clean. Each entry names the type, the variable and where it is read."""
    type_key = payload.get("type")
    if type_key not in declared_types():
        return [f"{type_key!r}: not declared in comms-profile/types.yaml"]
    variables = dict(payload.get("action_data") or {})
    problems: list[str] = []
    for locale, channel, name, variable in sheet_reads(type_key):
        root = variable.partition("[")[0]
        if root in _COMMS_VARIABLES:
            continue
        value = _resolve(variables, variable)
        where = f"{locale}/{channel}/{name}"
        if value is _MISSING:
            problems.append(f"{type_key}: {{{variable}}} is not sent ({where})")
        elif value is None:
            problems.append(f"{type_key}: {{{variable}}} is None ({where})")
    return sorted(set(problems))


@dataclass
class Guard:
    """What the listener saw: violations since the current test began, and
    every type emitted in the whole run."""

    violations: list[str] = field(default_factory=list)
    emitted: set[str] = field(default_factory=set)
    by_hand: bool = False

    def on_insert(self, _mapper, _connection, target: OutboxEvent) -> None:
        if target.event_type != EVENT_NOTIFICATION_REQUEST:
            return
        payload = target.payload or {}
        self.emitted.add(str(payload.get("type")))
        if self.by_hand:
            return
        self.violations.extend(check(payload))

    def install(self) -> None:
        event.listen(OutboxEvent, "before_insert", self.on_insert)

    def installed(self) -> bool:
        return event.contains(OutboxEvent, "before_insert", self.on_insert)

    def never_emitted(self) -> list[str]:
        """Declared types the run never wrote whose sheets read at least
        one variable -- the guard's blind spots. A type that reads none
        (the llm types, a fixed text) has nothing for the guard to check,
        so its absence hides nothing and it is not listed."""
        return sorted(
            type_key
            for type_key in declared_types() - self.emitted
            if sheet_reads(type_key)
        )


GUARD = Guard()
