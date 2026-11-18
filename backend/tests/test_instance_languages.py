# =============================================================================
# BE-196 -- the instance's languages (PRIMER-PROTOCOL 5.2.2)
# =============================================================================
#
# The passport turns on a subset of the product's languages (core/i18n.py
# SUPPORTED_LANGUAGES) and names its default among them: LANGUAGES and
# DEFAULT_LANGUAGE. Pinned here:
#   - the start: the list as the machine passes it (codes joined by commas)
#     is read from the environment; a repeat, an empty item, a code velo
#     cannot do, a default outside the list, a support language outside
#     the list -- refused;
#   - Settings.language_of: a person's language on the instance, the
#     instance's default (not en) for anything it has off;
#   - every place that shows or uses a person's language reads it through
#     there: the profile, the entries (Mini App, browser), PATCH, the
#     support target, the rating's comment_locale, the "not delivered"
#     text; the stored users.language is never rewritten, and the comms
#     snapshot carries it as stored.
#
# The suite pins every product language on and en the default
# (tests/conftest.py); the cases of a narrower instance monkeypatch it to
# en and ru with ru the default -- so a read that fell back to a constant en
# would show.
#
# telegram_id band: 74240-74279.
# =============================================================================

from collections.abc import AsyncGenerator
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch
from uuid import UUID, uuid4

import httpx
import pytest
from httpx import AsyncClient
from pydantic import ValidationError
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, settings
from app.core.events.models import OutboxEvent
from app.core.events.service import EVENT_USER_UPSERTED
from app.core.redis import get_redis
from app.modules.auth import telegram_oidc
from app.modules.support import translation
from app.modules.support.models import SupportThread
from app.modules.support.service import _rating_out
from app.modules.users.models import User
from tests.helpers import BOT_TOKEN, auth_headers, build_init_data, full_cleanup_range
from tests.settings_instance import INSTANCE, build_settings
from tests.test_mcp_oauth import TG_CLIENT_ID, TG_SECRET, FakeTelegram

_TID_MIN = 74240
_TID_MAX = 74279

ME_URL = "/api/v1/users/me"
START = "/api/v1/auth/telegram/browser/start"
COMPLETE = "/api/v1/auth/telegram/browser/complete"
MARK = "m" * 43


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    async def clean() -> None:
        await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
        await db_session.commit()
        redis = get_redis()
        async for key in redis.scan_iter(match="auth:browser_login:*"):
            await redis.delete(key)
        for tid in range(_TID_MIN, _TID_MAX + 1):
            await redis.delete(f"auth_rate:{tid}")

    await clean()
    yield
    await clean()


@pytest.fixture
def narrow(monkeypatch: pytest.MonkeyPatch) -> None:
    """An instance with en and ru on, ru the default."""
    monkeypatch.setattr(settings, "languages", ("en", "ru"))
    monkeypatch.setattr(settings, "default_language", "ru")


# -- the start ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("ru", ("ru",)),
        ("en,uk", ("en", "uk")),
        ("uk,ru,en", ("uk", "ru", "en")),
    ],
)
def test_a_subset_of_the_product_languages_starts(
    monkeypatch: pytest.MonkeyPatch, value: str, expected: tuple[str, ...]
) -> None:
    s = build_settings(
        monkeypatch,
        languages=value,
        default_language=expected[0],
        support_language=expected[-1],
    )
    assert s.languages == expected
    assert s.default_language == expected[0]


def test_the_list_is_read_from_the_environment_as_the_machine_passes_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """LANGUAGES=ru,uk in the process environment, the way compose passes
    it: read as a list of codes, not decoded as JSON (which would refuse
    the start on the plain form)."""
    monkeypatch.setenv("LANGUAGES", "ru,uk")
    values = {k: v for k, v in INSTANCE.items() if k != "languages"}
    s = Settings(**{**values, "default_language": "uk", "support_language": "ru"})
    assert s.languages == ("ru", "uk")


@pytest.mark.parametrize(
    ("value", "message"),
    [
        # REPEAT
        ("en,en,ru", "LANGUAGES names en more than once"),
        ("ru,ru", "LANGUAGES names ru more than once"),
        # EMPTINESS -- an empty item; a wholly empty list: tests/test_config.py
        ("en,,ru", "LANGUAGES='en,,ru' has an empty item"),
        ("en,ru,", "has an empty item"),
        (",", "empty: LANGUAGES"),
        # Not a code of velo, or not the machine's form
        ("en,de", "'de' not among the languages of velo"),
        ("EN,ru", "'EN' not among"),
        ("en, ru", "' ru' not among"),
        ("en;ru", "'en;ru' not among"),
        ('["en","ru"]', "not among the languages of velo"),
    ],
)
def test_a_list_velo_cannot_run_with_is_refused(
    monkeypatch: pytest.MonkeyPatch, value: str, message: str
) -> None:
    with pytest.raises(ValidationError, match=message.replace("[", r"\[")):
        build_settings(monkeypatch, languages=value)


@pytest.mark.parametrize(
    ("languages", "default"),
    [("en,ru", "uk"), ("ru", "en"), ("en,ru", "de"), ("en,ru", "RU")],
)
def test_a_default_outside_the_list_is_refused(
    monkeypatch: pytest.MonkeyPatch, languages: str, default: str
) -> None:
    with pytest.raises(ValidationError, match=f"DEFAULT_LANGUAGE={default!r}"):
        build_settings(monkeypatch, languages=languages, default_language=default)


def test_a_support_language_the_instance_has_off_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """uk is a product language, but this instance has it off: support would
    translate every reply into a language nobody here can choose."""
    with pytest.raises(ValidationError, match="SUPPORT_LANGUAGE='uk'"):
        build_settings(monkeypatch, languages="en,ru", support_language="uk")
    # The pair: the same language with the instance turning it on starts.
    s = build_settings(monkeypatch, languages="en,uk", support_language="uk")
    assert s.support_language == "uk"


def test_the_support_language_has_no_default() -> None:
    """A param of the passport (protocol 5.2): no default, so an instance
    without it is refused by name (tests/test_config.py, the absent case)."""
    assert Settings.model_fields["support_language"].is_required()
    assert Settings.model_fields["languages"].is_required()
    assert Settings.model_fields["default_language"].is_required()


# -- language_of --------------------------------------------------------------


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        ("ru", "ru"),
        ("en", "en"),
        ("RU", "ru"),
        ("en-US", "en"),
        # off on this instance -> its default, ru (not en)
        ("uk", "ru"),
        ("uk-UA", "ru"),
        # not a language of velo, or no code at all -> the default
        ("de", "ru"),
        ("xx", "ru"),
        ("", "ru"),
        (None, "ru"),
    ],
)
def test_language_of_on_an_instance_with_en_and_ru(
    narrow: None, code: str | None, expected: str
) -> None:
    assert settings.language_of(code) == expected


# -- the profile and PATCH ----------------------------------------------------


async def _login(
    client: AsyncClient, tid: int, language_code: str | None = None
) -> dict[str, Any]:
    """POST /auth/telegram with a Mini App initData carrying `language_code`
    (the field Telegram puts in its user object), or none."""
    user: dict[str, Any] = {"id": tid, "first_name": "Lang", "username": "lang"}
    if language_code is not None:
        user["language_code"] = language_code
    with patch.object(settings, "telegram_bot_token", BOT_TOKEN):
        resp = await client.post(
            "/api/v1/auth/telegram", json={"init_data": build_init_data(user)}
        )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _row(db_session: AsyncSession, user_id: str) -> User:
    db_session.expire_all()
    user = await db_session.get(User, UUID(user_id))
    assert user is not None
    return user


async def _snapshots(db_session: AsyncSession, user_id: str) -> list[dict]:
    rows = await db_session.execute(
        select(OutboxEvent)
        .where(
            OutboxEvent.event_type == EVENT_USER_UPSERTED,
            OutboxEvent.payload["recipient_id"].astext == user_id,
        )
        .order_by(OutboxEvent.id)
    )
    return [r.payload for r in rows.scalars().all()]


async def _store_language(db_session: AsyncSession, user_id: str, code: str) -> None:
    await db_session.execute(
        text("UPDATE users SET language = :v WHERE id = :id"),
        {"v": code, "id": user_id},
    )
    await db_session.commit()


async def test_a_language_the_instance_has_off_reads_as_its_default(
    client: AsyncClient, db_session: AsyncSession, narrow: None
) -> None:
    """The person chose uk; this instance has it off: the profile shows the
    instance's default, and the row keeps uk for the day uk comes back."""
    auth = await _login(client, 74240)
    user_id = auth["user"]["id"]
    await _store_language(db_session, user_id, "uk")

    resp = await client.get(ME_URL, headers=auth_headers(auth["session_token"]))

    assert resp.status_code == 200, resp.text
    assert resp.json()["language"] == "ru"
    assert (await _row(db_session, user_id)).language == "uk"


async def test_a_language_the_instance_has_on_reads_as_itself(
    client: AsyncClient, db_session: AsyncSession, narrow: None
) -> None:
    auth = await _login(client, 74241)
    user_id = auth["user"]["id"]
    await _store_language(db_session, user_id, "en")

    resp = await client.get(ME_URL, headers=auth_headers(auth["session_token"]))

    assert resp.status_code == 200, resp.text
    assert resp.json()["language"] == "en"


async def test_patch_refuses_a_language_the_instance_has_off(
    client: AsyncClient, db_session: AsyncSession, narrow: None
) -> None:
    """uk is a product language (BE-188 took it) but not this instance's:
    422, the row and the comms snapshot untouched."""
    auth = await _login(client, 74242)
    user_id = auth["user"]["id"]
    headers = auth_headers(auth["session_token"])
    before = await _snapshots(db_session, user_id)
    assert before, "the login wrote a snapshot"

    resp = await client.patch(ME_URL, json={"language": "uk"}, headers=headers)

    assert resp.status_code == 422, resp.text
    assert (await _row(db_session, user_id)).language == "ru"
    assert await _snapshots(db_session, user_id) == before
    # The pair: a language the instance has on is stored.
    resp = await client.patch(ME_URL, json={"language": "en"}, headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["language"] == "en"
    assert (await _row(db_session, user_id)).language == "en"


async def test_the_comms_snapshot_carries_the_language_as_stored(
    client: AsyncClient, db_session: AsyncSession, narrow: None
) -> None:
    """The snapshot's content is a function of the row and its version
    (comms refuses an equal version with other content), so it carries
    users.language as stored -- uk here -- while the profile reads ru."""
    auth = await _login(client, 74243)
    user_id = auth["user"]["id"]
    headers = auth_headers(auth["session_token"])
    await _store_language(db_session, user_id, "uk")

    resp = await client.patch(
        ME_URL, json={"timezone": "Europe/Kyiv"}, headers=headers
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["language"] == "ru"
    last = (await _snapshots(db_session, user_id))[-1]
    assert (last["timezone"], last["locale"]) == ("Europe/Kyiv", "uk")


# -- the entries ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("tid", "language_code", "expected"),
    [
        (74250, "en-US", "en"),
        (74251, "ru", "ru"),
        (74252, "uk", "ru"),
        (74253, "de", "ru"),
        (74254, None, "ru"),
    ],
)
async def test_the_mini_app_entry_writes_the_instance_language(
    client: AsyncClient,
    db_session: AsyncSession,
    narrow: None,
    tid: int,
    language_code: str | None,
    expected: str,
) -> None:
    """A new person gets their Telegram language if the instance has it on,
    else the instance's default -- never a constant en. Telegram's own code
    stays in credentials as it came."""
    auth = await _login(client, tid, language_code)

    assert auth["user"]["language"] == expected
    user = await _row(db_session, auth["user"]["id"])
    assert user.language == expected
    assert (user.credentials or {}).get("language_code") == language_code


@pytest.fixture
def telegram(monkeypatch: pytest.MonkeyPatch) -> FakeTelegram:
    """Telegram's OpenID provider, in memory (as tests/test_auth_browser_login.py)."""
    fake = FakeTelegram()
    monkeypatch.setattr(
        telegram_oidc,
        "_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(fake.handler)),
    )
    monkeypatch.setattr(settings, "domain_frontend", "app.velo.test")
    monkeypatch.setattr(settings, "telegram_login_client_id", TG_CLIENT_ID)
    monkeypatch.setattr(settings, "telegram_login_client_secret", TG_SECRET)
    return fake


@pytest.mark.parametrize(
    ("tid", "language", "expected"),
    [(74260, "en-GB", "en"), (74261, "uk-UA", "ru"), (74262, None, "ru")],
)
async def test_the_browser_entry_writes_the_instance_language(
    client: AsyncClient,
    db_session: AsyncSession,
    narrow: None,
    telegram: FakeTelegram,
    tid: int,
    language: str | None,
    expected: str,
) -> None:
    started = await client.post(START, json={"mark": MARK})
    assert started.status_code == 200, started.text
    body = {"code": f"tg-{tid}", "state": started.json()["state"], "mark": MARK}
    if language is not None:
        body["language"] = language

    resp = await client.post(COMPLETE, json=body)

    assert resp.status_code == 200, resp.text
    assert resp.json()["user"]["language"] == expected
    user = (
        await db_session.execute(select(User).where(User.telegram_id == tid))
    ).scalar_one()
    assert user.language == expected
    # The browser's tag is untrusted: only its instance language is kept.
    assert (user.credentials or {}).get("language_code") == (
        expected if language is not None else None
    )


# -- support -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("support", "stored", "expected"),
    [
        ("ru", "uk", None),  # uk is off: the person reads ru, support's own
        ("en", "uk", "ru"),  # ... and a reply in en is translated into ru
        ("en", "ru", "ru"),
        ("en", "en", None),
    ],
)
def test_the_reply_target_is_the_language_on_the_instance(
    narrow: None,
    monkeypatch: pytest.MonkeyPatch,
    support: str,
    stored: str,
    expected: str | None,
) -> None:
    monkeypatch.setattr(settings, "support_language", support)
    assert translation.reply_language(User(language=stored)) == expected


@pytest.mark.parametrize(("stored", "expected"), [("uk", "ru"), ("en", "en")])
def test_the_rating_comment_locale_is_the_language_on_the_instance(
    narrow: None, stored: str, expected: str
) -> None:
    ticket = SimpleNamespace(
        rating=4,
        rating_comment="ok",
        rated_at=None,
        rated_resolver_user_id=None,
    )
    rating = _rating_out(ticket, User(language=stored), {})  # type: ignore[arg-type]
    assert rating is not None
    assert rating["comment_locale"] == expected


class _Session:
    """What _emit_unavailable reads, and nothing else: no earlier notice,
    the support thread, its person."""

    def __init__(self, user: User | None) -> None:
        self.thread = SupportThread(client_user_id=uuid4())
        self.user = user

    async def execute(self, _statement: Any) -> Any:
        return SimpleNamespace(first=lambda: None)

    async def get(self, model: type, _key: Any) -> Any:
        return self.thread if model is SupportThread else self.user


@pytest.mark.parametrize(
    ("default", "stored", "expected"),
    [
        ("ru", "uk", "ru"),  # uk is off: the default's text, ru
        ("ru", "en", "en"),
        # The person deleted between the thread read and the user read (the
        # thread goes with them, ON DELETE CASCADE): the default, not en.
        ("ru", None, "ru"),
        ("en", "ru", "ru"),
        ("en", "uk", "en"),
    ],
)
async def test_the_not_delivered_text_follows_the_language_on_the_instance(
    monkeypatch: pytest.MonkeyPatch,
    default: str,
    stored: str | None,
    expected: str,
) -> None:
    """ru or en only (KNOWN CEILING at translation._UNAVAILABLE_TEXT)."""
    monkeypatch.setattr(settings, "languages", ("en", "ru"))
    monkeypatch.setattr(settings, "default_language", default)
    sent = AsyncMock()
    monkeypatch.setattr(translation, "emit_notification", sent)
    user = User(language=stored) if stored is not None else None
    row = SimpleNamespace(
        comms_message_id=uuid4(), locale="ru", support_thread_id=uuid4()
    )

    await translation._emit_unavailable(_Session(user), row)  # type: ignore[arg-type]

    sent.assert_awaited_once()
    title, body = translation._UNAVAILABLE_TEXT[expected]
    assert (sent.await_args.kwargs["title"], sent.await_args.kwargs["body"]) == (
        title,
        body,
    )
