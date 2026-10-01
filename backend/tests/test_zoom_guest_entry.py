# =============================================================================
# VELO -- Tests: named guest entry through the public page (GT-21 step B)
# =============================================================================
#
# telegram_id band: 67900-67949.
#
# BAND PROVENANCE. free_windows(space=(67000, 67999)) returned
# [(67900, 67999)] on 2026-09-23 -- 67000-67199 is test_zoom_guest_names.py,
# the rest of 67200-67899 is taken. 67950-67999 stays free.
#
# WHAT IS UNDER TEST. /z/{code}/guest used to be a 307 to the meeting's one
# shared registrant. It is now a page that claims a generated name on view,
# and a POST ("Войти") that mints a registrant under that name -- or under a
# typed one -- and answers 303 into Zoom. Three properties carry the feature:
#
#   1. THE NAME SHOWN IS THE NAME SENT. Asserted at the only layer where it
#      lives: the arguments create_registrant receives, not the page text.
#   2. THE CLAIM SURVIVES THE REQUEST. The route used to sit on get_db_reader,
#      which always rolls back; a test reading through the same kind of
#      session would stay green with the write lost. Every row count below
#      is read by this file's own db_session, a different session from the
#      app's.
#   3. A GUEST IS NEVER A ZoomRegistrant. The attendance ingest selects every
#      registrant of a meeting; a guest there would be judged.
#
# THE RACE IS BUILT, NOT FAKED. Exhausting MAX_ATTEMPTS is reached the way it
# happens in production: another transaction holds the same name, uncommitted,
# while this one reads the names in use and inserts; the unique index blocks
# the insert until the other commits, and the IntegrityError is real. Only
# the source of randomness is fixed, and it is a parameter of claim_guest_name
# by design, not a test hook.
#
# EVERY "NOT WRITTEN" / "NOT CALLED" ASSERTION HAS ITS PAIR: something else WAS
# written or called, and it is non-empty.
# =============================================================================

import asyncio
import random
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_session_factory
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.users.models import User, UserRole
from app.modules.zoom import service as zoom_service
from app.modules.zoom.guest_names import GODS, QUALITIES, generate
from app.modules.zoom.models import ZoomGuestName, ZoomMeeting, ZoomRegistrant
from app.modules.zoom.service import (
    GUEST_LAST_NAME_STUB,
    GUEST_NAME_MAX_LENGTH,
    _guest_name_exclusions,
    claim_guest_name,
    encode_practice_code,
    normalize_typed_guest_name,
    split_guest_name,
)
from app.modules.zoom.zoom_client import ZoomAPIError
from tests.helpers import auth_headers, full_cleanup_range, login_user

PRACTICES_URL = "/api/v1/practices"

_TID_MIN = 67900
_TID_MAX = 67949

_SHARED = "https://zoom.us/w/shared?tk=guest"


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """The shared FK-safe helper, scoped to this file's band. zoom_guest_names
    is swept through delete(Practice) and ON DELETE CASCADE."""
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


class _ZoomRecorder:
    """Stands in for create_registrant: records every call, answers as told.

    `answer` is a dict to return or an exception to raise. The default
    mirrors a Zoom 201 with a tokenized join_url.
    """

    def __init__(self, answer: object = None) -> None:
        self.calls: list[dict] = []
        self.answer = answer

    async def __call__(self, **kwargs: str) -> dict:
        self.calls.append(kwargs)
        if isinstance(self.answer, Exception):
            raise self.answer
        if isinstance(self.answer, dict):
            return self.answer
        n = len(self.calls)
        return {
            "registrant_id": f"guest-reg-{n}",
            "join_url": f"https://us06web.zoom.us/w/guest-{n}?tk=x",
        }


@pytest.fixture
def zoom(monkeypatch: pytest.MonkeyPatch) -> _ZoomRecorder:
    recorder = _ZoomRecorder()
    monkeypatch.setattr(zoom_service, "create_registrant", recorder)
    return recorder


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _published_practice(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
    zoom: _ZoomRecorder | None = None,
) -> tuple[str, str]:
    """A practice published through the API, so its ACTIVE ZoomMeeting, host
    registrant and shared registrant come from the real publish path.
    Returns (practice_id, public code).

    When the test holds the `zoom` recorder, publishing's own two mints (host
    and shared) go through it too; they are cleared here so every count the
    test asserts is the guest path's alone."""
    auth = await login_user(client, telegram_id=telegram_id, first_name="GuestHost")
    user_id = auth["user"]["id"]
    user = await db_session.get(User, UUID(user_id))
    user.role = UserRole.MASTER.value
    await db_session.flush()
    db_session.add(
        MasterProfile(
            user_id=UUID(user_id), data={"account": {"status": "verified"}},
        )
    )
    await db_session.commit()
    body = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Практика с гостями",
        "scheduled_at": (datetime.now(UTC) + timedelta(hours=48)).isoformat(),
        "duration_minutes": 60,
        "timezone": "Europe/Moscow",
        "is_free": True,
        "price_cents": 0,
        "currency": "eur",
    }
    headers = auth_headers(auth["session_token"])
    resp = await client.post(PRACTICES_URL, json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    practice_id = resp.json()["id"]
    publish = await client.patch(
        f"{PRACTICES_URL}/{practice_id}", json={"status": "scheduled"},
        headers=headers,
    )
    assert publish.status_code == 200, publish.text
    meeting = await _meeting(db_session, practice_id)
    meeting.shared_join_url = _SHARED
    await db_session.commit()
    if zoom is not None:
        zoom.calls.clear()
    return practice_id, encode_practice_code(UUID(practice_id))


async def _meeting(db_session: AsyncSession, practice_id: str) -> ZoomMeeting:
    return (
        await db_session.execute(
            select(ZoomMeeting).where(ZoomMeeting.practice_id == UUID(practice_id))
        )
    ).scalar_one()


async def _rows(db_session: AsyncSession, practice_id: str) -> list[ZoomGuestName]:
    db_session.expire_all()
    return list(
        (
            await db_session.execute(
                select(ZoomGuestName)
                .where(ZoomGuestName.practice_id == UUID(practice_id))
                .order_by(ZoomGuestName.created_at)
            )
        ).scalars().all()
    )


async def _registrant_count(db_session: AsyncSession, practice_id: str) -> int:
    meeting = await _meeting(db_session, practice_id)
    return (
        await db_session.execute(
            select(func.count()).select_from(ZoomRegistrant).where(
                ZoomRegistrant.zoom_meeting_id == meeting.id,
            )
        )
    ).scalar_one()


async def _set_status(db_session: AsyncSession, practice_id: str, value: str) -> None:
    practice = await db_session.get(Practice, UUID(practice_id))
    practice.status = value
    await db_session.commit()


# ===========================================================================
# 1. The generator -- pure.
# ===========================================================================


def test_dictionaries_give_768_distinct_single_token_bases() -> None:
    """48 x 16 = 768 (owner ruling). Every word is one token: the stored
    display name is split back into Zoom's two parts at its first space, so
    a two-word quality would silently move half of it into last_name."""
    assert len(GODS) == 48
    assert len(QUALITIES) == 16
    words = [g for g, _ in GODS] + [w for pair in QUALITIES for w in pair]
    assert all(w and len(w.split()) == 1 for w in words)
    everything = {n.display.casefold() for n in _all_bases()}
    assert len(everything) == 768
    assert generate([], random.Random(0)).display.casefold() in everything


def _all_bases():
    from app.modules.zoom.guest_names import _BASES

    return _BASES


def test_quality_agrees_with_the_gods_gender() -> None:
    """"Пылающий Фрейя" is a defect a reader notices instantly."""
    feminine = {g for g, gender in GODS if gender.value == "f"}
    assert feminine  # the check below is not vacuous
    for name in _all_bases():
        if name.last in feminine:
            assert name.first.endswith("ая"), name.display
        else:
            assert name.first.endswith(("ий", "ый", "ой")), name.display


def test_generate_avoids_exclusions_case_insensitively() -> None:
    """With one base left free, that base is the answer -- whatever the case
    of the exclusions. Pair: the answer is non-empty and has two parts."""
    bases = _all_bases()
    keep = bases[100]
    exclude = [b.display.upper() for b in bases if b != keep]
    for seed in range(20):
        name = generate(exclude, random.Random(seed))
        assert name == keep
        assert name.first and name.last


def test_generate_suffix_starts_at_2_and_steps_past_taken_numbers() -> None:
    """Saturation: every base taken -> "<base> 2"; every "<base> 2" taken
    too -> "<base> 3". No branch returns nothing."""
    bases = [b.display for b in _all_bases()]
    name = generate(bases, random.Random(1))
    assert name.last.endswith(" 2")
    name = generate(bases + [f"{b} 2" for b in bases], random.Random(1))
    assert name.last.endswith(" 3")
    assert name.display not in bases


def test_generate_never_fails_at_eighteen_thousand_taken() -> None:
    """The owner's ceiling-free case: about 18 000 names taken on one
    practice. Every call returns a name outside the set.

    WHAT CHANGED, AND WHY THIS IS NOT A WEAKER TEST. The first version grew
    the set by 18 000 sequential generate() calls. Each call casefolds the
    whole set, so the test was quadratic -- 33 s locally, the slowest test in
    the suite. Its one assertion was "the answer is outside the set". That
    assertion is kept at the same size, on the set built directly:
      - DENSE: every base holds every number up to 24 (18 432 names) -- the
        answer must be outside it, i.e. number 25;
      - WITH HOLES: 18 000 of those, sampled -- a shape the sequential build
        never produced, where a free base or a lower free number must be
        found instead.
    """
    bases = [b.display for b in _all_bases()]
    dense = bases + [f"{b} {n}" for b in bases for n in range(2, 25)]
    assert len(dense) == 768 * 24
    rng = random.Random(7)

    dense_cf = {name.casefold() for name in dense}
    for _ in range(100):
        name = generate(dense, rng).display
        assert name.casefold() not in dense_cf
        assert name.endswith(" 25")

    holed = rng.sample(dense, 18000)
    holed_cf = {name.casefold() for name in holed}
    for _ in range(100):
        name = generate(holed, rng).display
        assert name.casefold() not in holed_cf


# ===========================================================================
# 2. Typed names -- pure.
# ===========================================================================


@pytest.mark.parametrize(
    "raw", [None, "", "   ", "\t\n", "\u200b", "\u00a0\u00a0", " \u200b \t"],
)
def test_empty_typed_names_count_as_not_given(raw: str | None) -> None:
    """THE EMPTINESS AXIS. A lone zero-width space survives str.split(); it
    is still not a name."""
    assert normalize_typed_guest_name(raw) is None


def test_typed_name_is_collapsed_cut_and_retrimmed() -> None:
    """Pair to the test above: a real name comes back, non-empty, whitespace
    runs collapsed, never longer than the bound, never ending in a space."""
    assert normalize_typed_guest_name("  Анна \t\n Мария ") == "Анна Мария"
    raw = "а" * (GUEST_NAME_MAX_LENGTH - 1) + " бвг"
    cut = normalize_typed_guest_name(raw)
    assert cut == "а" * (GUEST_NAME_MAX_LENGTH - 1)
    assert len(cut) <= GUEST_NAME_MAX_LENGTH


def test_split_gives_zoom_two_parts_always() -> None:
    """Zoom rejects an empty last_name (probe: HTTP 400, code 300)."""
    assert split_guest_name("Марина") == ("Марина", GUEST_LAST_NAME_STUB)
    assert split_guest_name("Пылающий Шива 12") == ("Пылающий", "Шива 12")
    assert split_guest_name("Анна Мария Петрова") == ("Анна", "Мария Петрова")


# ===========================================================================
# 3. The page claims a name, and the claim survives.
# ===========================================================================


@pytest.mark.asyncio
async def test_page_claims_a_name_that_outlives_the_request(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Read by a DIFFERENT session than the app's -- the reader dependency
    this route used to sit on would have passed a same-session test."""
    practice_id, code = await _published_practice(client, db_session, 67900)

    resp = await client.get(f"/z/{code}/guest", follow_redirects=False)

    rows = await _rows(db_session, practice_id)
    assert resp.status_code == 200
    assert len(rows) == 1
    assert rows[0].display_name.strip()
    assert rows[0].display_name in resp.text
    assert f"value='{rows[0].id}'" in resp.text
    assert rows[0].zoom_registrant_id is None
    csp = resp.headers["content-security-policy"]
    assert "form-action 'self' https://zoom.us https://*.zoom.us" in csp
    assert "script-src" not in csp
    assert "<script" not in resp.text
    assert resp.headers["cache-control"] == "no-store"
    assert "так посещение будет засчитано" in resp.text
    assert f"startapp=zoom__{code}" in resp.text


@pytest.mark.asyncio
async def test_other_pages_keep_form_action_none(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Opening form-action is the guest page's alone. Pair: the guest page
    of the same practice does open it (asserted above)."""
    _, code = await _published_practice(client, db_session, 67901)

    landing = await client.get(f"/z/{code}", follow_redirects=False)
    missing = await client.get("/z/" + "A" * 22, follow_redirects=False)

    for resp in (landing, missing):
        assert "form-action 'none'" in resp.headers["content-security-policy"]
        assert "cache-control" not in {k.lower() for k in resp.headers}


@pytest.mark.asyncio
async def test_each_view_claims_a_new_name_up_to_the_ceiling(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """THE REPEAT AXIS, owner ruling: opening the page again ("Другое" is
    exactly that) gives a new name, and the earlier one stays taken --
    UNTIL zoom_guest_names_max_per_practice.

    WHAT CHANGED (BE-66), AND WHY THIS IS NOT A WEAKER TEST. This was
    test_each_view_claims_a_new_name, asserting that every view claims a new
    row. That was true and is still true below the ceiling; without a
    ceiling it also blessed unbounded growth -- a loop of GETs grew the
    table, and the cost of each next claim, forever. BE-66 added the
    ceiling, so the unconditional claim became false. Now: every view below
    the ceiling claims a distinct name, and the view past it writes nothing
    and shows the page without a proposed name, still with the field.
    """
    monkeypatch.setattr(settings, "zoom_guest_names_max_per_practice", 3)
    practice_id, code = await _published_practice(client, db_session, 67902)

    for _ in range(3):
        assert (await client.get(f"/z/{code}/guest")).status_code == 200
    past = await client.get(f"/z/{code}/guest")

    rows = await _rows(db_session, practice_id)
    assert len(rows) == 3
    assert len({r.display_name for r in rows}) == 3
    assert past.status_code == 200
    assert "guest_name_id" not in past.text
    assert "name='name'" in past.text


# ===========================================================================
# 4. "Войти": the shown name is the sent name.
# ===========================================================================


@pytest.mark.parametrize("typed", [None, "", "   ", "\t\n", "\u200b"])
@pytest.mark.asyncio
async def test_empty_field_enters_under_the_shown_name(
    client: AsyncClient, db_session: AsyncSession, zoom: _ZoomRecorder,
    typed: str | None,
) -> None:
    """THE EMPTINESS AXIS on the form field, paired with where the name
    actually lands: the two parts create_registrant was given."""
    practice_id, code = await _published_practice(client, db_session, 67903, zoom)
    await client.get(f"/z/{code}/guest")
    (shown,) = await _rows(db_session, practice_id)
    data = {"guest_name_id": str(shown.id)}
    if typed is not None:
        data["name"] = typed

    resp = await client.post(f"/z/{code}/guest", data=data, follow_redirects=False)

    assert resp.status_code == 303
    assert resp.headers["location"] == "https://us06web.zoom.us/w/guest-1?tk=x"
    assert resp.headers["referrer-policy"] == "no-referrer"
    assert len(zoom.calls) == 1
    first, last = zoom.calls[0]["first_name"], zoom.calls[0]["last_name"]
    assert f"{first} {last}" == shown.display_name
    assert first and last
    (row,) = await _rows(db_session, practice_id)
    assert row.zoom_registrant_id == "guest-reg-1"
    assert row.join_url == resp.headers["location"]


@pytest.mark.asyncio
async def test_typed_name_wins_and_is_written_nowhere(
    client: AsyncClient, db_session: AsyncSession, zoom: _ZoomRecorder,
) -> None:
    """A typed one-word name goes out with the stub surname; the shown row
    is left as "issued, not entered"; no row is added for the typed name.
    Namesakes are allowed, so the second "Марина" enters just as well."""
    practice_id, code = await _published_practice(client, db_session, 67904, zoom)
    await client.get(f"/z/{code}/guest")
    (shown,) = await _rows(db_session, practice_id)

    responses = [
        await client.post(
            f"/z/{code}/guest",
            data={"guest_name_id": str(shown.id), "name": "  Марина "},
            follow_redirects=False,
        )
        for _ in range(2)
    ]

    assert [r.status_code for r in responses] == [303, 303]
    assert [(c["first_name"], c["last_name"]) for c in zoom.calls] == [
        ("Марина", GUEST_LAST_NAME_STUB), ("Марина", GUEST_LAST_NAME_STUB),
    ]
    rows = await _rows(db_session, practice_id)
    assert [r.id for r in rows] == [shown.id]
    assert rows[0].zoom_registrant_id is None


@pytest.mark.asyncio
async def test_double_submit_mints_twice_and_the_row_keeps_the_first(
    client: AsyncClient, db_session: AsyncSession, zoom: _ZoomRecorder,
) -> None:
    """REPEAT on "Войти": two registrants, two distinct addresses (Zoom
    folds a repeated email into one registrant), no 500."""
    practice_id, code = await _published_practice(client, db_session, 67905, zoom)
    await client.get(f"/z/{code}/guest")
    (shown,) = await _rows(db_session, practice_id)

    first = await client.post(
        f"/z/{code}/guest", data={"guest_name_id": str(shown.id)},
        follow_redirects=False,
    )
    second = await client.post(
        f"/z/{code}/guest", data={"guest_name_id": str(shown.id)},
        follow_redirects=False,
    )

    assert (first.status_code, second.status_code) == (303, 303)
    assert first.headers["location"] != second.headers["location"]
    emails = [c["email"] for c in zoom.calls]
    assert len(emails) == 2 and len(set(emails)) == 2
    assert all(e.endswith("@meetings.velo.invalid") for e in emails)
    (row,) = await _rows(db_session, practice_id)
    assert row.zoom_registrant_id == "guest-reg-1"


@pytest.mark.parametrize("forged", ["not-a-uuid", "random", "foreign"])
@pytest.mark.asyncio
async def test_forged_shown_id_gets_a_fresh_name_and_touches_nothing(
    client: AsyncClient, db_session: AsyncSession, zoom: _ZoomRecorder,
    forged: str,
) -> None:
    """The hidden field is not a secret. An id that names no row of THIS
    practice -- garbage, an unknown uuid, or another practice's row -- gets a
    freshly claimed name, and the foreign row keeps its NULL registrant."""
    practice_id, code = await _published_practice(client, db_session, 67906, zoom)
    other_id, other_code = await _published_practice(client, db_session, 67907, zoom)
    await client.get(f"/z/{other_code}/guest")
    (foreign,) = await _rows(db_session, other_id)
    value = {
        "not-a-uuid": "zzz", "random": str(uuid4()), "foreign": str(foreign.id),
    }[forged]

    resp = await client.post(
        f"/z/{code}/guest", data={"guest_name_id": value}, follow_redirects=False,
    )

    assert resp.status_code == 303
    (fresh,) = await _rows(db_session, practice_id)
    sent = f"{zoom.calls[0]['first_name']} {zoom.calls[0]['last_name']}"
    assert sent == fresh.display_name
    assert fresh.zoom_registrant_id == "guest-reg-1"
    (foreign_after,) = await _rows(db_session, other_id)
    assert foreign_after.zoom_registrant_id is None


@pytest.mark.asyncio
async def test_a_guest_is_never_a_zoom_registrant_row(
    client: AsyncClient, db_session: AsyncSession, zoom: _ZoomRecorder,
) -> None:
    """The attendance ingest reads every ZoomRegistrant of a meeting. Pair:
    the mint did happen, and it did land in zoom_guest_names."""
    practice_id, code = await _published_practice(client, db_session, 67908, zoom)
    before = await _registrant_count(db_session, practice_id)
    await client.get(f"/z/{code}/guest")
    await client.post(f"/z/{code}/guest", data={"name": "Гость Незваный"})
    await client.post(f"/z/{code}/guest")

    assert len(zoom.calls) == 2
    assert await _registrant_count(db_session, practice_id) == before
    rows = await _rows(db_session, practice_id)
    assert any(r.zoom_registrant_id for r in rows)


# ===========================================================================
# 5. THE SHORTAGE AXIS -- every refusal is an entry, not a 500.
# ===========================================================================


@pytest.mark.parametrize(
    "answer",
    [
        ZoomAPIError("rate limited", status_code=429, body={"code": 429}),
        ZoomAPIError("Zoom API request failed: timed out"),  # no answer at all
        RuntimeError("unexpected"),
        {"registrant_id": "reg-no-url"},  # 201 without join_url
    ],
    ids=["refused", "no-answer", "unexpected", "no-join-url"],
)
@pytest.mark.asyncio
async def test_zoom_failure_hands_out_the_shared_registrant(
    client: AsyncClient, db_session: AsyncSession, zoom: _ZoomRecorder,
    answer: object,
) -> None:
    practice_id, code = await _published_practice(client, db_session, 67909, zoom)
    await client.get(f"/z/{code}/guest")
    (shown,) = await _rows(db_session, practice_id)
    zoom.answer = answer

    resp = await client.post(
        f"/z/{code}/guest", data={"guest_name_id": str(shown.id)},
        follow_redirects=False,
    )

    assert resp.status_code == 303
    assert resp.headers["location"] == _SHARED
    assert len(zoom.calls) == 1
    (row,) = await _rows(db_session, practice_id)
    assert row.join_url is None
    expected_id = "reg-no-url" if isinstance(answer, dict) else None
    assert row.zoom_registrant_id == expected_id


@pytest.mark.asyncio
async def test_zoom_failure_with_no_shared_link_is_an_honest_page(
    client: AsyncClient, db_session: AsyncSession, zoom: _ZoomRecorder,
) -> None:
    """The one cell of the grid where a guest cannot enter: 200 and a
    sentence, not a 500 and not a redirect to nothing."""
    practice_id, code = await _published_practice(client, db_session, 67910, zoom)
    meeting = await _meeting(db_session, practice_id)
    meeting.shared_join_url = None
    await db_session.commit()
    zoom.answer = ZoomAPIError("refused", status_code=429)

    resp = await client.post(
        f"/z/{code}/guest", data={"name": "Марина"}, follow_redirects=False,
    )

    assert resp.status_code == 200
    assert "Гостевой вход сейчас недоступен" in resp.text
    assert len(zoom.calls) == 1


@pytest.mark.asyncio
async def test_personal_link_works_even_without_a_shared_one(
    client: AsyncClient, db_session: AsyncSession, zoom: _ZoomRecorder,
) -> None:
    """Pair to the test above: the missing shared link only matters when
    the personal mint fails."""
    practice_id, code = await _published_practice(client, db_session, 67911, zoom)
    meeting = await _meeting(db_session, practice_id)
    meeting.shared_join_url = None
    await db_session.commit()

    resp = await client.post(
        f"/z/{code}/guest", data={"name": "Марина"}, follow_redirects=False,
    )

    assert resp.status_code == 303
    assert resp.headers["location"] == "https://us06web.zoom.us/w/guest-1?tk=x"


@pytest.mark.asyncio
async def test_finished_practice_keeps_the_old_shared_hop_and_writes_nothing(
    client: AsyncClient, db_session: AsyncSession, zoom: _ZoomRecorder,
) -> None:
    """Zoom accepts registrants on a meeting that ended hours ago, so the
    boundary is ours. Pair: the same practice, while scheduled, does claim
    (asserted in section 3)."""
    practice_id, code = await _published_practice(client, db_session, 67912, zoom)
    await _set_status(db_session, practice_id, PracticeStatus.COMPLETED.value)

    page = await client.get(f"/z/{code}/guest", follow_redirects=False)
    enter = await client.post(
        f"/z/{code}/guest", data={"name": "Марина"}, follow_redirects=False,
    )

    assert (page.status_code, page.headers["location"]) == (307, _SHARED)
    assert (enter.status_code, enter.headers["location"]) == (303, _SHARED)
    assert await _rows(db_session, practice_id) == []
    assert zoom.calls == []


@pytest.mark.asyncio
async def test_meeting_not_active_is_an_honest_page_on_both_verbs(
    client: AsyncClient, db_session: AsyncSession, zoom: _ZoomRecorder,
) -> None:
    practice_id, code = await _published_practice(client, db_session, 67913, zoom)
    meeting = await _meeting(db_session, practice_id)
    meeting.status = "pending_creation"
    await db_session.commit()

    page = await client.get(f"/z/{code}/guest", follow_redirects=False)
    enter = await client.post(f"/z/{code}/guest", follow_redirects=False)

    for resp in (page, enter):
        assert resp.status_code == 200
        assert "Гостевой вход сейчас недоступен" in resp.text
    assert await _rows(db_session, practice_id) == []
    assert zoom.calls == []


# ===========================================================================
# 6. Exclusions and the race.
# ===========================================================================


@pytest.mark.asyncio
async def test_generated_name_never_repeats_the_masters(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """ZoomRegistrant has no name column; the master's name is rebuilt the
    way minting builds it. With every base but one issued, and the master
    carrying that one (in another case), the generator must go to a suffix
    instead of handing the master a twin."""
    practice_id, _ = await _published_practice(client, db_session, 67914)
    practice = await db_session.get(Practice, UUID(practice_id))
    master = await db_session.get(User, practice.master_id)
    bases = _all_bases()
    master.first_name, master.last_name = bases[0].first.lower(), bases[0].last
    for base in bases[1:]:
        db_session.add(
            ZoomGuestName(practice_id=practice.id, display_name=base.display)
        )
    await db_session.commit()
    meeting = await _meeting(db_session, practice_id)

    exclusions = await _guest_name_exclusions(practice, meeting, db_session)
    row = await claim_guest_name(
        practice, meeting, db_session, rng=random.Random(3),
    )
    await db_session.commit()

    assert f"{bases[0].first.lower()} {bases[0].last}" in exclusions
    assert row is not None
    assert row.display_name.casefold() != bases[0].display.casefold()
    assert row.display_name.split()[-1] == "2"


async def _wait_for_lock_waiter(limit_s: float = 5.0) -> None:
    """Block until some backend is waiting on a lock -- the moment the claim
    under test sits on the unique index behind the uncommitted twin."""
    factory = get_session_factory()
    deadline = asyncio.get_running_loop().time() + limit_s
    async with factory() as probe:
        while asyncio.get_running_loop().time() < deadline:
            waiting = (
                await probe.execute(
                    text(
                        "SELECT count(*) FROM pg_stat_activity "
                        "WHERE wait_event_type = 'Lock'"
                    )
                )
            ).scalar_one()
            if waiting:
                return
            await asyncio.sleep(0.02)
    raise AssertionError("the claim never blocked on the unique index")


async def _race(practice_id: str, seed: int, max_attempts: int):
    """Run one claim against a twin that holds the claim's first candidate,
    uncommitted, and commits only once the claim is blocked behind it."""
    factory = get_session_factory()
    async with factory() as rival, factory() as claimant:
        practice = await claimant.get(Practice, UUID(practice_id))
        meeting = (
            await claimant.execute(
                select(ZoomMeeting).where(ZoomMeeting.practice_id == practice.id)
            )
        ).scalar_one()
        # Read BEFORE the rival writes: exactly what the claim's first
        # attempt will read, since the rival's row stays uncommitted.
        exclusions = await _guest_name_exclusions(practice, meeting, claimant)
        doomed = generate(exclusions, random.Random(seed)).display

        rival.add(ZoomGuestName(practice_id=practice.id, display_name=doomed))
        await rival.flush()  # holds the index entry, not committed

        task = asyncio.create_task(
            claim_guest_name(
                practice, meeting, claimant,
                rng=random.Random(seed), max_attempts=max_attempts,
            )
        )
        await _wait_for_lock_waiter()
        await rival.commit()
        row = await task
        await claimant.commit()
        return doomed, row


@pytest.mark.asyncio
async def test_lost_race_is_retried_not_raised(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """THE REPEAT AXIS on the claim: the first insert loses on the real
    index, the savepoint keeps the transaction alive, the second attempt
    re-reads and wins another name."""
    practice_id, _ = await _published_practice(client, db_session, 67915)

    doomed, row = await _race(practice_id, seed=11, max_attempts=2)

    assert row is not None
    assert row.display_name != doomed
    names = [r.display_name for r in await _rows(db_session, practice_id)]
    assert sorted(names) == sorted([doomed, row.display_name])


@pytest.mark.asyncio
async def test_exhausted_attempts_return_none_and_the_page_still_works(
    client: AsyncClient, db_session: AsyncSession, zoom: _ZoomRecorder,
) -> None:
    """MAX_ATTEMPTS exhausted, reached by a real race with a budget of one.
    The page for that state asks for a typed name; an empty "Войти" from it
    claims afresh and enters."""
    practice_id, code = await _published_practice(client, db_session, 67916, zoom)

    doomed, row = await _race(practice_id, seed=5, max_attempts=1)

    assert row is None
    names = [r.display_name for r in await _rows(db_session, practice_id)]
    assert names == [doomed]

    from app.modules.practices.router import _guest_name_form

    markup = _guest_name_form(code, None)
    assert "введите своё" in markup
    assert "guest_name_id" not in markup
    assert "name='name'" in markup

    resp = await client.post(f"/z/{code}/guest", follow_redirects=False)
    assert resp.status_code == 303
    assert len(zoom.calls) == 1
