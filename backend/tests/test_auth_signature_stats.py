# =============================================================================
# BE-201 -- the Mini App `signature` measurement, in the database
# =============================================================================
#
# The measurement for BE-183 (moving the Mini App login onto Telegram's
# public-key check, which old clients without `signature` cannot pass).
# BE-187 wrote it as a log event; the deploy machine does not keep logs
# across deploys, so it is a table now (mini_app_signature_seen) and a
# verb (scripts/signature_stats.py).
#
# What is pinned here:
#   - a successful POST /api/v1/auth/telegram marks the person: with or
#     without `signature`, one row per person, the other mark kept;
#   - an empty `signature=` is absent; a repeated key is read by its first
#     value, the one the hash check used;
#   - a later time already in the row is not moved back (GREATEST);
#   - two sign-ins of one person at once: one row, both marks;
#   - no refusal marks anybody: bad hash, appended (unsigned) signature,
#     source and per-account limits, deactivated account, failed session,
#     failed commit;
#   - the verb: three numbers over all time and from a date (inclusive,
#     midnight UTC), one line of JSON, numbers only.
#
# telegram_id band: 74200-74219.
# =============================================================================

import asyncio
import importlib.util
import json
from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import Depends
from httpx import ASGITransport, AsyncClient
from redis.exceptions import RedisError
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from structlog.testing import capture_logs

from app.core.config import settings
from app.core.database import get_db_session, get_session_factory
from app.core.exceptions import TooManyRequestsError
from app.core.redis import get_redis
from app.main import app
from app.modules.auth import router as auth_router
from app.modules.auth.models import MiniAppSignatureSeen
from app.modules.auth.signature_stats import count
from app.modules.users.models import User
from tests.helpers import BOT_TOKEN, build_init_data, fresh_execute, full_cleanup_range

_TID_MIN = 74200
_TID_MAX = 74219

URL = "/api/v1/auth/telegram"
# A shape like Telegram's (base64url Ed25519).
SIGNATURE = "Zm9vYmFyU2lnbmF0dXJlVmFsdWVfQkUxODc-aGVyZV9pc19zb21l"

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "signature_stats.py"


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    async def clean() -> None:
        await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
        await db_session.commit()
        for tid in range(_TID_MIN, _TID_MAX + 1):
            await get_redis().delete(f"auth_rate:{tid}")

    await clean()
    yield
    await clean()


def _init_data(tid: int, extra: dict[str, str] | None = None) -> str:
    return build_init_data(
        {"id": tid, "first_name": "Sig", "username": f"siguser{tid}"},
        extra=extra,
    )


async def _post(client: AsyncClient, init_data: str):
    with patch.object(settings, "telegram_bot_token", BOT_TOKEN):
        return await client.post(URL, json={"init_data": init_data})


async def _marks(tid: int) -> list[tuple[datetime | None, datetime | None]]:
    """(last_with, last_without) of every row for this person, read fresh."""
    result = await fresh_execute(
        select(
            MiniAppSignatureSeen.last_with_signature_at,
            MiniAppSignatureSeen.last_without_signature_at,
        )
        .join(User, User.id == MiniAppSignatureSeen.user_id)
        .where(User.telegram_id == tid)
    )
    return [tuple(r) for r in result.all()]


async def _user_exists(tid: int) -> bool:
    result = await fresh_execute(select(User.id).where(User.telegram_id == tid))
    return result.scalar_one_or_none() is not None


# -- successful sign-ins: the right mark -------------------------------------


@pytest.mark.parametrize(
    ("tid", "extra", "with_sig"),
    [
        pytest.param(74200, {"signature": SIGNATURE}, True, id="present"),
        pytest.param(74201, None, False, id="missing"),
        pytest.param(74202, {"signature": ""}, False, id="empty-is-absent"),
    ],
)
async def test_a_sign_in_marks_the_person(
    client: AsyncClient, tid: int, extra: dict[str, str] | None, with_sig: bool
) -> None:
    resp = await _post(client, _init_data(tid, extra))

    assert resp.status_code == 200
    [(with_at, without_at)] = await _marks(tid)
    if with_sig:
        assert with_at is not None and without_at is None
    else:
        assert with_at is None and without_at is not None


@pytest.mark.parametrize(
    ("tid", "signed", "appended", "with_sig"),
    [
        pytest.param(74203, "", SIGNATURE, False, id="empty-first"),
        pytest.param(74204, SIGNATURE, "", True, id="value-first"),
    ],
)
async def test_a_repeated_key_is_read_by_its_first_value(
    client: AsyncClient, tid: int, signed: str, appended: str, with_sig: bool
) -> None:
    """REPEAT: the mark follows the same first value the hash check signed.

    The hash covers only the first value of a repeated key, so the init
    data is signed with that first value and the second one is appended
    unsigned -- validation still passes, and the mark must follow the first.
    """
    init_data = _init_data(tid, {"signature": signed}) + f"&signature={appended}"

    resp = await _post(client, init_data)

    assert resp.status_code == 200
    [(with_at, without_at)] = await _marks(tid)
    assert (with_at is not None) is with_sig
    assert (without_at is not None) is (not with_sig)


@pytest.mark.parametrize(
    ("tid", "first", "second"),
    [
        pytest.param(74205, {"signature": SIGNATURE}, None, id="with-then-without"),
        pytest.param(74206, None, {"signature": SIGNATURE}, id="without-then-with"),
    ],
)
async def test_two_sign_ins_are_one_row_with_both_marks(
    client: AsyncClient,
    tid: int,
    first: dict[str, str] | None,
    second: dict[str, str] | None,
) -> None:
    """REPEAT: one row per person; the second sign-in sets its own mark and
    keeps the first one -- the row counts people, not sign-ins."""
    assert (await _post(client, _init_data(tid, first))).status_code == 200
    [before] = await _marks(tid)

    assert (await _post(client, _init_data(tid, second))).status_code == 200

    [(with_at, without_at)] = await _marks(tid)
    assert with_at is not None and without_at is not None
    kept = before[0] if first else before[1]
    assert (with_at if first else without_at) == kept


async def test_a_later_time_in_the_row_is_not_moved_back(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """now() is when the transaction STARTED, so two sign-ins of one person
    can commit in the opposite order to their starts; the row keeps the
    later time. Reached here by putting a later time in the row first."""
    tid = 74207
    later = datetime(3000, 1, 1, tzinfo=UTC)
    assert (await _post(client, _init_data(tid))).status_code == 200
    user_id = (
        await fresh_execute(select(User.id).where(User.telegram_id == tid))
    ).scalar_one()
    await db_session.execute(
        update(MiniAppSignatureSeen)
        .where(MiniAppSignatureSeen.user_id == user_id)
        .values(last_without_signature_at=later)
    )
    await db_session.commit()

    assert (await _post(client, _init_data(tid))).status_code == 200
    assert (
        await _post(client, _init_data(tid, {"signature": SIGNATURE}))
    ).status_code == 200

    [(with_at, without_at)] = await _marks(tid)
    assert without_at == later
    assert with_at is not None and with_at < later


async def test_two_sign_ins_at_once_are_one_row_with_both_marks(
    client: AsyncClient,
) -> None:
    """A symmetric race of one NEW person: both requests insert the user
    and the mark at once. One row, neither mark lost."""
    tid = 74208
    first, second = await asyncio.gather(
        _post(client, _init_data(tid, {"signature": SIGNATURE})),
        _post(client, _init_data(tid)),
    )

    assert first.status_code == 200
    assert second.status_code == 200
    [(with_at, without_at)] = await _marks(tid)
    assert with_at is not None and without_at is not None


# -- refusals: no mark ---------------------------------------------------------


async def test_a_bad_hash_marks_nobody(client: AsyncClient) -> None:
    tid = 74209
    init_data = _init_data(tid, {"signature": SIGNATURE})
    tampered = init_data.replace("first_name%22%3A+%22Sig", "first_name%22%3A+%22Xig")
    assert tampered != init_data

    with capture_logs() as logs:
        resp = await _post(client, tampered)

    assert resp.status_code == 400
    assert [e for e in logs if e["event"] == "telegram_auth_failed"]
    assert not await _user_exists(tid)
    assert await _marks(tid) == []


async def test_a_signature_appended_to_signed_init_data_is_refused(
    client: AsyncClient,
) -> None:
    """The `signature` field is inside the hash: adding one to init data
    that was signed without it breaks the hash, so a client cannot fake
    being a new one, and nobody is marked."""
    tid = 74210
    resp = await _post(client, _init_data(tid) + f"&signature={SIGNATURE}")

    assert resp.status_code == 400
    assert await _marks(tid) == []


async def test_the_per_account_limit_marks_nobody(client: AsyncClient) -> None:
    tid = 74211
    await get_redis().set(
        f"auth_rate:{tid}", settings.auth_rate_limit_max_requests, ex=60
    )

    with capture_logs() as logs:
        resp = await _post(client, _init_data(tid, {"signature": SIGNATURE}))

    assert resp.status_code == 429
    assert [e for e in logs if e["event"] == "telegram_auth_rate_limited"]
    assert await _marks(tid) == []


async def test_the_source_limit_marks_nobody(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    tid = 74212
    limiter = AsyncMock(side_effect=TooManyRequestsError("Too many auth attempts."))
    monkeypatch.setattr(auth_router, "check_source_rate_limit", limiter)

    resp = await _post(client, _init_data(tid, {"signature": SIGNATURE}))

    assert resp.status_code == 429
    assert limiter.await_count == 1
    assert await _marks(tid) == []


async def test_a_deactivated_account_keeps_its_marks_as_they_were(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """The refused sign-in came WITH `signature`; the row the person already
    had (one earlier sign-in without it) stays exactly as it was."""
    tid = 74213
    assert (await _post(client, _init_data(tid))).status_code == 200
    [before] = await _marks(tid)
    assert before[0] is None and before[1] is not None
    await db_session.execute(
        update(User).where(User.telegram_id == tid).values(is_active=False)
    )
    await db_session.commit()

    with capture_logs() as logs:
        resp = await _post(client, _init_data(tid, {"signature": SIGNATURE}))

    assert resp.status_code == 403
    assert [e for e in logs if e["event"] == "telegram_auth_deactivated"]
    assert await _marks(tid) == [before]


async def test_a_failed_session_marks_nobody(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """create_session failing (Redis down) answers 500 and the sign-in did
    not happen: the mark, written before it, is rolled back with the user
    by get_db_session."""
    tid = 74214
    failing = AsyncMock(side_effect=RedisError("down"))
    monkeypatch.setattr(auth_router, "create_session", failing)
    transport = ASGITransport(app=app, raise_app_exceptions=False)

    async with AsyncClient(transport=transport, base_url="http://test") as raw:
        resp = await _post(raw, _init_data(tid, {"signature": SIGNATURE}))

    assert resp.status_code == 500
    assert failing.await_count == 1
    assert not await _user_exists(tid)
    assert await _marks(tid) == []


async def test_a_failed_mark_creates_no_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The mark is written BEFORE create_session: when the mark itself
    fails, no session token is put into Redis for a sign-in that is then
    rolled back."""
    tid = 74219
    failing = AsyncMock(side_effect=RuntimeError("mark failed"))
    sessions = AsyncMock(return_value="token")
    monkeypatch.setattr(auth_router.signature_stats, "record", failing)
    monkeypatch.setattr(auth_router, "create_session", sessions)
    transport = ASGITransport(app=app, raise_app_exceptions=False)

    async with AsyncClient(transport=transport, base_url="http://test") as raw:
        resp = await _post(raw, _init_data(tid, {"signature": SIGNATURE}))

    assert resp.status_code == 500
    assert failing.await_count == 1
    assert sessions.await_count == 0
    assert not await _user_exists(tid)


async def _failing_commit_transaction() -> AsyncGenerator[AsyncSession, None]:
    """get_db_session's transaction, except that the commit fails."""
    session = get_session_factory()()
    try:
        yield session
        await session.rollback()
        raise RuntimeError("commit failed")
    finally:
        await session.close()


async def _failing_commit_session(
    session: AsyncSession = Depends(_failing_commit_transaction, scope="function"),
) -> AsyncSession:
    return session


async def test_a_failed_commit_marks_nobody(client: AsyncClient) -> None:
    """The mark is in the sign-in's transaction: the commit fails, the
    client gets 500, and the row the person already had (one sign-in
    without `signature`) stays exactly as it was. An existing person, so a
    mark written outside the transaction would have its user row to point
    at and would show here. Then the same person signs in normally and IS
    marked -- the refusal above was the commit, not a request that never
    reached the mark."""
    tid = 74215
    assert (await _post(client, _init_data(tid))).status_code == 200
    [before] = await _marks(tid)
    assert before[0] is None and before[1] is not None

    app.dependency_overrides[get_db_session] = _failing_commit_session
    try:
        transport = ASGITransport(app=app, raise_app_exceptions=False)
        async with AsyncClient(transport=transport, base_url="http://test") as raw:
            resp = await _post(raw, _init_data(tid, {"signature": SIGNATURE}))
    finally:
        del app.dependency_overrides[get_db_session]

    assert resp.status_code == 500
    assert await _marks(tid) == [before]

    signed = _init_data(tid, {"signature": SIGNATURE})
    assert (await _post(client, signed)).status_code == 200
    [(with_at, without_at)] = await _marks(tid)
    assert with_at is not None and without_at == before[1]


# -- the numbers ---------------------------------------------------------------


def _load_script():
    spec = importlib.util.spec_from_file_location("signature_stats_cli", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def test_all_time_counts_people_by_how_they_came(client: AsyncClient) -> None:
    """Over all time the table is shared with every other test of the
    session, so the numbers are compared as a difference: three people of
    this band, one of each kind."""
    async with get_session_factory()() as session:
        before = await count(session)

    assert (
        await _post(client, _init_data(74216, {"signature": SIGNATURE}))
    ).status_code == 200
    assert (await _post(client, _init_data(74217))).status_code == 200
    assert (
        await _post(client, _init_data(74218, {"signature": SIGNATURE}))
    ).status_code == 200
    assert (await _post(client, _init_data(74218))).status_code == 200

    async with get_session_factory()() as session:
        after = await count(session)

    assert after.only_with - before.only_with == 1
    assert after.ever_without - before.ever_without == 2
    assert after.total - before.total == 3


async def _seed_future_marks(client: AsyncClient, db_session: AsyncSession) -> None:
    """Five people of this band with marks in the year 3000 -- the only
    rows there, whatever else the session wrote (real marks are now())."""
    d = datetime(3000, 1, 1, tzinfo=UTC)
    shapes = {
        # only with, after D
        74200: (datetime(3000, 1, 2, tzinfo=UTC), None),
        # with after D, without BEFORE D -- still "only with" since D
        74201: (datetime(3000, 1, 2, tzinfo=UTC), datetime(2999, 12, 31, tzinfo=UTC)),
        # without exactly at D -- inclusive
        74202: (datetime(3000, 1, 2, tzinfo=UTC), d),
        # only without, after D
        74203: (None, datetime(3000, 1, 3, tzinfo=UTC)),
        # with, a minute before D -- not counted from D
        74204: (datetime(2999, 12, 31, 23, 59, tzinfo=UTC), None),
    }
    for tid, (with_at, without_at) in shapes.items():
        assert (await _post(client, _init_data(tid))).status_code == 200
        await db_session.execute(
            update(MiniAppSignatureSeen)
            .where(
                MiniAppSignatureSeen.user_id
                == select(User.id).where(User.telegram_id == tid).scalar_subquery()
            )
            .values(
                last_with_signature_at=with_at,
                last_without_signature_at=without_at,
            )
        )
    await db_session.commit()


async def test_from_a_date_reads_the_last_times(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    await _seed_future_marks(client, db_session)

    async with get_session_factory()() as session:
        stats = await count(session, datetime(3000, 1, 1, tzinfo=UTC))

    assert (stats.only_with, stats.ever_without, stats.total) == (2, 2, 4)


async def test_the_verb_prints_one_line_of_numbers(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """--since is midnight UTC of the date; the line holds the three numbers
    and the date, and nothing else. dispose_engine is stubbed: the script
    owns the process when run as the verb, here it shares the suite's
    engine."""
    await _seed_future_marks(client, db_session)
    script = _load_script()
    monkeypatch.setattr(script, "dispose_engine", AsyncMock())
    capsys.readouterr()  # the seeding sign-ins log to stdout too

    code = await script.main(["--since", "3000-01-01"])

    assert code == 0
    out = capsys.readouterr().out
    assert out.count("\n") == 1
    assert json.loads(out) == {
        "only_with": 2,
        "ever_without": 2,
        "total": 4,
        "since": "3000-01-01",
    }
    assert script.dispose_engine.await_count == 1


async def test_the_verb_without_a_date_says_so() -> None:
    script = _load_script()
    stats = type("S", (), {"only_with": 1, "ever_without": 2, "total": 3})()

    assert json.loads(script.render(stats, None)) == {
        "only_with": 1,
        "ever_without": 2,
        "total": 3,
        "since": None,
    }
    assert script.parse_args([]).since is None


@pytest.mark.parametrize("bad", ["2026-13-01", "tomorrow", ""])
def test_a_malformed_date_is_argparse_exit_2(bad: str) -> None:
    script = _load_script()

    with pytest.raises(SystemExit) as exc:
        script.parse_args(["--since", bad])

    assert exc.value.code == 2
