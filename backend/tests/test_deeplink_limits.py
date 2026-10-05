# =============================================================================
# VELO Backend -- Tests: every startapp VELO emits fits Telegram (Links)
# =============================================================================
#
# Telegram opens a Mini App by `t.me/<bot>?startapp=<value>` only when
# <value> is at most 64 characters of [A-Za-z0-9_-]. comms builds the
# notification button the same way: `<action>` or `<action>__<one param>`
# (comms/app/engine/formatters.py::format_deep_link).
#
# The school invite link was 65 characters (curator_group_invite__ + 43) and
# did not open; nobody noticed because nothing measured it. These tests
# close the CLASS, not the instance:
#
#   1. LINKS: every `?startapp=` the app builds is found in the source and
#      must be known to KINDS below with the length of what follows the
#      kind; a new kind not listed here is a red test, so its length gets
#      measured the day it is added.
#   2. ACTIONS: every notification action the app emits is found in the
#      source (the same written forms the Links gate enumerated) and must be
#      known to ACTIONS below; each `<action>__<uuid>` must fit.
#
# Pure: no database, no client -- source scan plus the real token / code
# generators.
# =============================================================================

import re
import secrets
from pathlib import Path
from uuid import uuid4

import pytest

from app.modules.curator_groups.service import _INVITE_DEEPLINK_KIND
from app.modules.zoom.service import encode_practice_code

APP = Path(__file__).resolve().parents[1] / "app"
LIMIT = 64
CHARSET = re.compile(r"^[A-Za-z0-9_-]+$")
UUID_LEN = len(str(uuid4()))  # 36
TOKEN_LEN = len(secrets.token_urlsafe(32))  # 43

# kind (as written in the source) -> length of the value after it.
KINDS: dict[str, int] = {
    "{_INVITE_DEEPLINK_KIND}": TOKEN_LEN,  # school invite (curator_groups)
    "group_invite__": TOKEN_LEN,  # master's group invite (masters)
    "master_onboarding__": TOKEN_LEN,  # admin master invite (admin/masters)
    "zoom__": len(encode_practice_code(uuid4())),  # public practice page
}

# action -> does it carry ONE uuid param (True) or none (False).
ACTIONS: dict[str, bool] = {
    "open_practice": True,
    "open_feedback": True,
    "open_wallet": True,  # bare from payouts / top-ups, practice_id on refunds
    "confirm_waitlist": True,
    "open_curator_group": True,
    "open_master_offer": True,
    "open_master_application": True,  # bare (BE-104) and group_id (BE-59)
    "open_master_zone": False,
    "open_support": False,
    "open_master_practices": False,
    "open_notifications": False,
    "open_admin_masters": False,
    "open_admin_support": False,
}

_SOURCES = [p for p in APP.rglob("*.py") if "__pycache__" not in p.parts]


def _source() -> str:
    return "\n".join(p.read_text(encoding="utf-8") for p in _SOURCES)


def _startapp_kinds(text: str) -> set[str]:
    """What follows `?startapp=` up to the variable part, as written."""
    kinds: set[str] = set()
    for m in re.finditer(r"\?startapp=([^\"'\s]*)", text):
        value = m.group(1)
        if value in {"x"}:  # the doctest example in core/telegram_links.py
            continue
        if value.startswith("{_INVITE_DEEPLINK_KIND}"):
            kinds.add("{_INVITE_DEEPLINK_KIND}")
            continue
        kinds.add(value.split("{", 1)[0])
    return kinds


def _actions(text: str) -> set[str]:
    """Every action verb the app emits, in each form it is written in."""
    found = set(re.findall(r"\"action\":\s*\"([a-z_]+)\"", text))
    found |= set(re.findall(r"\b_OPEN_[A-Z_]+ = \"([a-z_]+)\"", text))
    found |= set(re.findall(r"\bACTION_[A-Z_]+ = \"([a-z_]+)\"", text))
    return found


def test_every_startapp_kind_is_known_and_fits() -> None:
    kinds = _startapp_kinds(_source())
    assert kinds == set(KINDS), (
        "a ?startapp= kind is built in app/ that this test does not know -- "
        "add it to KINDS with the length of its value"
    )
    for kind, value_len in KINDS.items():
        prefix = _INVITE_DEEPLINK_KIND if kind == "{_INVITE_DEEPLINK_KIND}" else kind
        value = prefix + "a" * value_len
        assert len(value) <= LIMIT, (kind, len(value))
        assert CHARSET.match(value), kind


def test_the_real_generators_have_the_lengths_assumed_above() -> None:
    for _ in range(20):
        token = secrets.token_urlsafe(32)
        assert len(token) == TOKEN_LEN and CHARSET.match(token)
        code = encode_practice_code(uuid4())
        assert len(code) == KINDS["zoom__"] and CHARSET.match(code)


def test_the_school_link_is_the_short_kind() -> None:
    """Pinned: the owner's prefix (3 October), 51 characters with a token."""
    assert _INVITE_DEEPLINK_KIND == "school__"
    assert len(_INVITE_DEEPLINK_KIND) + TOKEN_LEN == 51


def test_every_emitted_action_is_known() -> None:
    assert _actions(_source()) == set(ACTIONS), (
        "an action verb is emitted in app/ that this test does not know -- "
        "add it to ACTIONS and to the front (parseStartParam, the bells)"
    )


@pytest.mark.parametrize("action,has_param", sorted(ACTIONS.items()))
def test_every_action_button_fits(action: str, has_param: bool) -> None:
    value = f"{action}__{uuid4()}" if has_param else action
    assert len(value) <= LIMIT, (action, len(value))
    assert CHARSET.match(value), action
