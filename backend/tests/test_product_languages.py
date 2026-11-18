# =============================================================================
# BE-188 -- the product's languages are en, ru, uk
# =============================================================================
#
# Owner ruling 2026-11-03; PRIMER-PROTOCOL v1.7 5.2.2 (the product declares
# every language it can do). Pinned here:
#   - Settings.language_of with every product language on and en the
#     default (the suite's pin, tests/conftest.py): the three codes (any
#     case, any region) land on themselves, everything else -- de and es
#     included -- on the default (BE-196 replaced normalize_language; an
#     instance with fewer languages: tests/test_instance_languages.py);
#   - PATCH /users/me: language is exactly one of the three, or 422 with the
#     row and the comms snapshot untouched;
#   - support/translation.py LANGUAGE_NAMES names exactly the product's
#     languages: a translation target is always one of them.
# SUPPORT_LANGUAGE against the same set: tests/test_support_translation.py.
#
# telegram_id band: 74220-74239.
# =============================================================================

from collections.abc import AsyncGenerator
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import i18n
from app.core.config import settings
from app.core.events.models import OutboxEvent
from app.core.events.service import EVENT_USER_UPSERTED
from app.core.i18n import SUPPORTED_LANGUAGES
from app.modules.support.translation import LANGUAGE_NAMES
from app.modules.users.models import User
from tests.helpers import auth_headers, full_cleanup_range, login_user

_TID_MIN = 74220
_TID_MAX = 74239

ME_URL = "/api/v1/users/me"


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    async def clean() -> None:
        await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
        await db_session.commit()

    await clean()
    yield
    await clean()


# -- the set ------------------------------------------------------------------


def test_the_product_languages_are_en_ru_uk() -> None:
    """BE-188 also pinned DEFAULT_LANGUAGE == "en" here: the product had one
    default, and every code outside its set landed on it. BE-196 removed it
    -- the default is the instance's (Settings.default_language, from the
    passport), and a product-wide one would be a second answer to the same
    question. So: the set is the three, and core/i18n.py names no default."""
    assert sorted(SUPPORTED_LANGUAGES) == ["en", "ru", "uk"]
    assert not hasattr(i18n, "DEFAULT_LANGUAGE")
    assert not hasattr(i18n, "normalize_language")


def test_every_translation_target_has_a_name_and_nothing_else_does() -> None:
    """A target is settings.support_language or reply_language() -- both in
    SUPPORTED_LANGUAGES -- so a name outside it is unreachable text and a
    missing one would put a bare code into the model's letter."""
    assert set(LANGUAGE_NAMES) == SUPPORTED_LANGUAGES
    assert all(LANGUAGE_NAMES.values())


# -- language_of, every product language on -----------------------------------


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("en", "en"),
        ("ru", "ru"),
        ("uk", "uk"),
        ("EN", "en"),
        ("en-US", "en"),
        ("ru-RU", "ru"),
        ("uk-UA", "uk"),
        ("de", "en"),
        ("de-AT", "en"),
        ("es", "en"),
        ("ES", "en"),
        ("pt-BR", "en"),
        ("xx", "en"),
        ("<b>ru</b>", "en"),
        (" ru", "en"),
        ("", "en"),
        (None, "en"),
    ],
)
def test_language_of_with_every_language_on(
    value: str | None, expected: str
) -> None:
    """The table normalize_language held for the product (BE-188), now
    read through Settings.language_of on the suite's pin -- every product
    language on, en the default (tests/conftest.py) -- where it gives the
    same answers. The pair: the pin is what this table assumes."""
    assert settings.languages == ("en", "ru", "uk")
    assert settings.default_language == "en"
    assert settings.language_of(value) == expected


# -- PATCH /users/me ----------------------------------------------------------


async def _row_language(db_session: AsyncSession, user_id: str) -> str:
    return (
        await db_session.execute(
            text("SELECT language FROM users WHERE id = :id"), {"id": user_id}
        )
    ).scalar_one()


async def _snapshot_count(db_session: AsyncSession, user_id: str) -> int:
    rows = await db_session.execute(
        select(OutboxEvent).where(
            OutboxEvent.event_type == EVENT_USER_UPSERTED,
            OutboxEvent.payload["recipient_id"].astext == user_id,
        )
    )
    return len(rows.scalars().all())


@pytest.mark.parametrize(
    ("tid", "language"),
    [(74220, "en"), (74221, "ru"), (74222, "uk")],
)
async def test_a_product_language_is_stored(
    client: AsyncClient, db_session: AsyncSession, tid: int, language: str
) -> None:
    auth = await login_user(client, telegram_id=tid)
    user_id = auth["user"]["id"]
    before = await _snapshot_count(db_session, user_id)

    resp = await client.patch(
        ME_URL,
        json={"language": language},
        headers=auth_headers(auth["session_token"]),
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["language"] == language
    assert await _row_language(db_session, user_id) == language
    assert await _snapshot_count(db_session, user_id) == before + 1


@pytest.mark.parametrize(
    ("tid", "language"),
    [
        (74223, "de"),
        (74224, "es"),
        (74225, "EN"),
        (74226, "en-US"),
        (74227, "xx"),
        (74228, " "),
        (74229, "ru "),
    ],
)
async def test_any_other_language_is_422_and_nothing_changes(
    client: AsyncClient, db_session: AsyncSession, tid: int, language: str
) -> None:
    """Strict: no quiet normalization of what the client sent. The pair:
    the row holds a language (the login's en) and keeps it; the login's
    snapshot exists and no second one is written."""
    auth = await login_user(client, telegram_id=tid)
    user_id = auth["user"]["id"]
    before = await _snapshot_count(db_session, user_id)
    assert before >= 1

    resp = await client.patch(
        ME_URL,
        json={"language": language},
        headers=auth_headers(auth["session_token"]),
    )

    assert resp.status_code == 422, resp.text
    assert await _row_language(db_session, user_id) == "en"
    assert await _snapshot_count(db_session, user_id) == before


async def test_the_same_language_again_is_accepted(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """REPEAT: sending the current value again is a 200, not a refusal."""
    auth = await login_user(client, telegram_id=74230)
    headers = auth_headers(auth["session_token"])
    for _ in range(2):
        resp = await client.patch(ME_URL, json={"language": "uk"}, headers=headers)
        assert resp.status_code == 200, resp.text
    user = await db_session.get(User, UUID(auth["user"]["id"]))
    assert user is not None
    await db_session.refresh(user)
    assert user.language == "uk"


async def test_a_patch_without_language_leaves_it(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """NEHVATKA: the validator does not invent a value for an absent key."""
    auth = await login_user(client, telegram_id=74231)
    headers = auth_headers(auth["session_token"])
    assert (
        await client.patch(ME_URL, json={"language": "ru"}, headers=headers)
    ).status_code == 200

    resp = await client.patch(ME_URL, json={"first_name": "Other"}, headers=headers)

    assert resp.status_code == 200, resp.text
    assert await _row_language(db_session, auth["user"]["id"]) == "ru"
