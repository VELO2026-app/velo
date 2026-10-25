# =============================================================================
# VELO -- support ticket rating and statistics (BE-162, delivery 3)
# =============================================================================
# Band 55000-55039.
#
# What is under test, and why each one exists:
#
#   1. RESOLVED ASKS FOR A RATING: at once, one request per move to
#      RESOLVED while the ticket is unrated; no request for the other
#      statuses; the admin who resolved is recorded -- the last one.
#   2. THE RATING: the author, a RESOLVED ticket, once -- 404 for anybody
#      else's, 409 when not resolved or rated; it keeps the admin it rated.
#   3. WAITING FOR A RATING: the person's resolved, unrated tickets.
#   4. ADMINS: the rating and who resolved, in the list row and the card
#      alike; the list filtered by rating.
#   5. STATISTICS: the categories add up to the list without spam for the
#      same period (owner acceptance 4); spam apart; ratings by category and
#      by the admin each rating is about.
#   6. ONLY THE SPAM BIN DELETES A TICKET (BE-162 delivery 2), and it
#      leaves a tombstone the statistics count.
#   7. RACES: the rating against a reopening message; two ratings.
# =============================================================================

import re
import sys
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events.models import OutboxEvent
from app.core.exceptions import ConflictError
from app.modules.support import service, translation
from app.modules.support.models import TOPICS, SupportThread, SupportTicket
from app.modules.users.models import User, UserRole
from tests.curator_race_harness import assert_no_deadlock, race
from tests.helpers import auth_headers, fresh_execute, full_cleanup_range, login_user

BAND_MIN, BAND_MAX = 55000, 55039

_SEAMS = (
    "app.modules.support.service.comms_request",
    "app.modules.chats.router.comms_request",
)
TICKETS_URL = "/api/v1/support/tickets"
PENDING_URL = "/api/v1/support/ratings/pending"
STATS_URL = "/api/v1/support/stats"


# ---------------------------------------------------------------------------
# Fixtures and builders
# ---------------------------------------------------------------------------


async def _clean(session: AsyncSession) -> None:
    await full_cleanup_range(session, BAND_MIN, BAND_MAX, delete_users=True)
    await session.execute(
        delete(OutboxEvent).where(
            OutboxEvent.payload["type"].astext.in_(
                [service.RATING_REQUEST_TYPE, service.MESSAGE_RECEIVED_TYPE]
            ),
            OutboxEvent.payload["idempotency_key"].astext.like("support-%"),
            OutboxEvent.created_at > datetime.now(UTC) - timedelta(hours=1),
        )
    )
    await session.commit()


@pytest.fixture(autouse=True)
async def _band(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await _clean(db_session)
    yield
    await _clean(db_session)


class _Comms:
    """comms for these routes: the status move, a person's message."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, Any]] = []

    async def __call__(self, method: str, path: str, **kw: Any) -> Any:
        self.calls.append((method, path, kw.get("json")))
        if path.endswith("/status"):
            return {"status": kw["json"]["status"]}
        if path.endswith("/messages") and method == "POST":
            return {
                "id": str(uuid4()),
                "thread_id": path.split("/")[4],
                "sender": kw["json"]["sender"],
                "body": kw["json"]["body"],
                "created_at": datetime.now(UTC).isoformat(),
            }
        raise AssertionError(f"unexpected comms call {method} {path}")


@pytest.fixture
def comms(monkeypatch: pytest.MonkeyPatch) -> _Comms:
    fake = _Comms()
    for seam in _SEAMS:
        monkeypatch.setattr(seam, fake)
    return fake


async def _person(
    client: AsyncClient,
    db_session: AsyncSession,
    offset: int,
    *,
    role: str | None = None,
    language: str = "ru",
) -> dict:
    tid = BAND_MIN + offset
    auth = await login_user(client, telegram_id=tid, first_name=f"BE162r-{offset}")
    user = await db_session.get(User, UUID(auth["user"]["id"]))
    user.language = language
    if role is not None:
        user.role = role
    await db_session.commit()
    if role is not None:
        auth = await login_user(client, telegram_id=tid, first_name=f"BE162r-{offset}")
    return auth


async def _ticket(
    db_session: AsyncSession,
    user_id: str,
    *,
    topic: str = "technical",
    status: str = "open",
    age_minutes: int = 0,
    rating: int | None = None,
    resolved_by: str | None = None,
    rated_resolver: str | None = None,
) -> UUID:
    thread_id = uuid4()
    pointer = SupportThread(comms_thread_id=thread_id, client_user_id=UUID(user_id))
    db_session.add(pointer)
    await db_session.flush()
    when = datetime.now(UTC) - timedelta(minutes=age_minutes)
    db_session.add(
        SupportTicket(
            support_thread_id=pointer.id,
            topic=topic,
            category=TOPICS[topic].category,
            status=status,
            status_changed_at=when,
            created_at=when,
            version=1,
            rating=rating,
            rated_at=when if rating is not None else None,
            resolved_by_user_id=UUID(resolved_by) if resolved_by else None,
            rated_resolver_user_id=UUID(rated_resolver) if rated_resolver else None,
        )
    )
    await db_session.commit()
    return thread_id


async def _row(thread_id: UUID) -> SupportTicket:
    return (
        await fresh_execute(
            select(SupportTicket)
            .join(SupportThread, SupportThread.id == SupportTicket.support_thread_id)
            .where(SupportThread.comms_thread_id == thread_id)
        )
    ).scalar_one()


async def _requests(thread_id: UUID) -> list[dict]:
    p = OutboxEvent.payload
    return [
        e.payload
        for e in (
            await fresh_execute(
                select(OutboxEvent)
                .where(
                    p["type"].astext == service.RATING_REQUEST_TYPE,
                    p["action_data"]["params"]["thread_id"].astext == str(thread_id),
                )
                .order_by(OutboxEvent.id)
            )
        )
        .scalars()
        .all()
    ]


async def _set_status(
    client: AsyncClient,
    admin: dict,
    thread: UUID,
    status: str,
) -> Any:
    return await client.post(
        f"{TICKETS_URL}/{thread}/status",
        json={"status": status},
        headers=auth_headers(admin["session_token"]),
    )


async def _rate(client: AsyncClient, person: dict, thread: UUID, body: dict) -> Any:
    return await client.post(
        f"{TICKETS_URL}/{thread}/rating",
        json=body,
        headers=auth_headers(person["session_token"]),
    )


# ---------------------------------------------------------------------------
# 1. RESOLVED asks for a rating
# ---------------------------------------------------------------------------


class TestRequest:
    async def test_resolved_asks_the_person_at_once_and_records_the_resolver(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
    ) -> None:
        admin = await _person(client, db_session, 0, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 1)
        thread = await _ticket(db_session, user["user"]["id"])
        resp = await _set_status(client, admin, thread, "resolved")
        assert resp.status_code == 200, resp.text
        (request,) = await _requests(thread)
        assert (request["target_type"], request["target_value"]) == (
            "user",
            user["user"]["id"],
        )
        assert request["idempotency_key"] == f"support-rating:{thread}:2"
        assert request["action_data"] == {
            "action": "open_support_rating",
            "params": {"thread_id": str(thread)},
        }
        assert str((await _row(thread)).resolved_by_user_id) == admin["user"]["id"]

    @pytest.mark.parametrize("status", ["rejected", "duplicate", "spam"])
    async def test_no_other_status_asks(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
        status: str,
    ) -> None:
        admin = await _person(client, db_session, 2, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 3)
        thread = await _ticket(db_session, user["user"]["id"])
        resp = await _set_status(client, admin, thread, status)
        assert resp.status_code == 200, resp.text
        assert await _requests(thread) == []
        assert (await _row(thread)).resolved_by_user_id is None

    async def test_resolved_again_asks_again_unless_rated(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
    ) -> None:
        """Resolved by A, reopened by the person's message, resolved by B:
        unrated -- a second request (a new key), and B is the resolver.
        Rated in between -- no request (one rating per ticket)."""
        a = await _person(client, db_session, 4, role=UserRole.ADMIN.value)
        b = await _person(client, db_session, 5, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 6)
        headers = auth_headers(user["session_token"])
        for rated_between in (False, True):
            thread = await _ticket(db_session, user["user"]["id"])
            await _set_status(client, a, thread, "resolved")
            if rated_between:
                assert (
                    await _rate(client, user, thread, {"stars": 4})
                ).status_code == 200
            resp = await client.post(
                f"/api/v1/chats/{thread}/messages",
                json={"body": "again"},
                headers=headers,
            )
            assert resp.status_code == 200, resp.text
            assert (await _row(thread)).status == "open"
            await _set_status(client, b, thread, "resolved")
            row = await _row(thread)
            assert str(row.resolved_by_user_id) == b["user"]["id"]
            keys = [r["idempotency_key"] for r in await _requests(thread)]
            if rated_between:
                assert keys == [f"support-rating:{thread}:2"]
                assert str(row.rated_resolver_user_id) == a["user"]["id"]
            else:
                assert keys == [
                    f"support-rating:{thread}:2",
                    f"support-rating:{thread}:4",
                ]


# ---------------------------------------------------------------------------
# 2. The rating
# ---------------------------------------------------------------------------


class TestRating:
    async def test_the_author_rates_a_resolved_ticket_once(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
    ) -> None:
        admin = await _person(client, db_session, 7, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 8)
        thread = await _ticket(
            db_session,
            user["user"]["id"],
            status="resolved",
            resolved_by=admin["user"]["id"],
        )
        resp = await _rate(client, user, thread, {"stars": 5, "comment": "  спасибо  "})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert (body["id"], body["stars"], body["comment"]) == (
            str(thread),
            5,
            "спасибо",
        )
        row = await _row(thread)
        assert (row.rating, row.rating_comment) == (5, "спасибо")
        assert str(row.rated_resolver_user_id) == admin["user"]["id"]
        assert row.status == "resolved"

        again = await _rate(client, user, thread, {"stars": 1})
        assert again.status_code == 409
        assert (await _row(thread)).rating == 5

    @pytest.mark.parametrize("comment", [None, "", "   "])
    async def test_no_comment_is_null(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
        comment,
    ) -> None:
        user = await _person(client, db_session, 9)
        thread = await _ticket(db_session, user["user"]["id"], status="resolved")
        body: dict[str, Any] = {"stars": 3}
        if comment is not None:
            body["comment"] = comment
        assert (await _rate(client, user, thread, body)).json()["comment"] is None
        assert (await _row(thread)).rating_comment is None

    @pytest.mark.parametrize("status", ["open", "rejected", "duplicate", "spam"])
    async def test_only_a_resolved_ticket_is_rated(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
        status: str,
    ) -> None:
        user = await _person(client, db_session, 10)
        thread = await _ticket(db_session, user["user"]["id"], status=status)
        assert (await _rate(client, user, thread, {"stars": 5})).status_code == 409
        assert (await _row(thread)).rating is None

    async def test_nobody_elses_ticket_and_nothing_but_a_ticket(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
    ) -> None:
        owner = await _person(client, db_session, 11)
        other = await _person(client, db_session, 12)
        admin = await _person(client, db_session, 13, role=UserRole.ADMIN.value)
        thread = await _ticket(db_session, owner["user"]["id"], status="resolved")
        history = uuid4()
        db_session.add(
            SupportThread(
                comms_thread_id=history, client_user_id=UUID(other["user"]["id"])
            )
        )
        await db_session.commit()
        for person, target in (
            (other, thread),
            (admin, thread),
            (other, history),
            (other, uuid4()),
        ):
            assert (
                await _rate(client, person, target, {"stars": 5})
            ).status_code == 404
        assert (await _row(thread)).rating is None

    @pytest.mark.parametrize(
        "body",
        [
            {"stars": 0},
            {"stars": 6},
            {"stars": "5"},
            {"stars": True},
            {"stars": 4.5},
            {},
            {"stars": 5, "comment": "x" * 1001},
            {"stars": 5, "rated_resolver": str(uuid4())},
        ],
    )
    async def test_a_malformed_rating_is_a_422(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
        body,
    ) -> None:
        user = await _person(client, db_session, 14)
        thread = await _ticket(db_session, user["user"]["id"], status="resolved")
        assert (await _rate(client, user, thread, body)).status_code == 422
        assert (await _row(thread)).rating is None


# ---------------------------------------------------------------------------
# 3. Waiting for a rating
# ---------------------------------------------------------------------------


async def test_pending_is_the_persons_resolved_unrated_tickets(
    client: AsyncClient,
    db_session: AsyncSession,
    comms: _Comms,
) -> None:
    user = await _person(client, db_session, 15)
    other = await _person(client, db_session, 16)
    uid = user["user"]["id"]
    older = await _ticket(
        db_session, uid, status="resolved", age_minutes=20, topic="payment"
    )
    newer = await _ticket(db_session, uid, status="resolved", age_minutes=10)
    await _ticket(db_session, uid, status="resolved", rating=4)
    await _ticket(db_session, uid, status="open")
    await _ticket(db_session, uid, status="rejected")
    await _ticket(db_session, other["user"]["id"], status="resolved")
    resp = await client.get(PENDING_URL, headers=auth_headers(user["session_token"]))
    assert resp.status_code == 200
    tickets = resp.json()["tickets"]
    assert [t["id"] for t in tickets] == [str(newer), str(older)]
    assert (tickets[1]["topic"], tickets[1]["category"]) == ("payment", "payments")
    nobody = await _person(client, db_session, 17)
    empty = await client.get(PENDING_URL, headers=auth_headers(nobody["session_token"]))
    assert empty.json() == {"tickets": []}


# ---------------------------------------------------------------------------
# 4. Admins: the row and the filter
# ---------------------------------------------------------------------------


class TestAdminRow:
    async def test_the_rating_is_in_the_list_row_and_the_card_alike(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
    ) -> None:
        a = await _person(client, db_session, 18, role=UserRole.ADMIN.value)
        b = await _person(client, db_session, 19, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 20, language="de")
        thread = await _ticket(
            db_session,
            user["user"]["id"],
            status="resolved",
            resolved_by=b["user"]["id"],
        )
        row = await _row(thread)
        await _rate(client, user, thread, {"stars": 2, "comment": "langsam"})
        await db_session.execute(
            SupportTicket.__table__.update()
            .where(SupportTicket.support_thread_id == row.support_thread_id)
            .values(rated_resolver_user_id=UUID(a["user"]["id"]))
        )
        await db_session.commit()
        headers = auth_headers(a["session_token"])
        listed = (await client.get(TICKETS_URL, headers=headers)).json()["tickets"]
        (in_list,) = [t for t in listed if t["id"] == str(thread)]
        card = (await client.get(f"{TICKETS_URL}/{thread}", headers=headers)).json()
        assert card == in_list
        assert card["resolved_by"]["user_id"] == b["user"]["id"]
        rating = card["rating"]
        assert (rating["stars"], rating["comment"], rating["comment_locale"]) == (
            2,
            "langsam",
            "de",
        )
        assert rating["rated_resolver"]["user_id"] == a["user"]["id"]
        assert rating["rated_at"]

    async def test_an_unrated_ticket_has_no_rating(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
    ) -> None:
        admin = await _person(client, db_session, 21, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 22)
        thread = await _ticket(db_session, user["user"]["id"])
        card = (
            await client.get(
                f"{TICKETS_URL}/{thread}",
                headers=auth_headers(admin["session_token"]),
            )
        ).json()
        assert (card["rating"], card["resolved_by"]) == (None, None)

    async def test_the_list_filters_by_rating(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
    ) -> None:
        admin = await _person(client, db_session, 23, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 24)
        uid = user["user"]["id"]
        five = await _ticket(
            db_session, uid, status="resolved", rating=5, age_minutes=40
        )
        four = await _ticket(
            db_session, uid, status="resolved", rating=4, age_minutes=30
        )
        one = await _ticket(
            db_session, uid, status="resolved", rating=1, age_minutes=20
        )
        none = await _ticket(db_session, uid, age_minutes=10)
        headers = auth_headers(admin["session_token"])

        async def ids(params) -> list[str]:
            resp = await client.get(TICKETS_URL, params=params, headers=headers)
            assert resp.status_code == 200, resp.text
            return [t["id"] for t in resp.json()["tickets"]]

        assert await ids([("rating", "5")]) == [str(five)]
        assert await ids([("rating", "4"), ("rating", "5")]) == [str(four), str(five)]
        assert await ids([("rating", "none")]) == [str(none)]
        assert await ids([("rating", "none"), ("rating", "1")]) == [str(none), str(one)]
        assert await ids([("rating", "5"), ("rating", "5")]) == [str(five)]
        for junk in ("0", "6", "five", ""):
            resp = await client.get(
                TICKETS_URL, params={"rating": junk}, headers=headers
            )
            assert resp.status_code == 422, junk


# ---------------------------------------------------------------------------
# 5. Statistics
# ---------------------------------------------------------------------------


def _period(minutes_back: int, minutes_to: int = 0) -> dict[str, str]:
    now = datetime.now(UTC)
    return {
        "created_from": (now - timedelta(minutes=minutes_back)).isoformat(),
        "created_to": (now - timedelta(minutes=minutes_to)).isoformat(),
    }


class TestStats:
    async def test_the_categories_add_up_to_the_list_without_spam(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
    ) -> None:
        """Owner acceptance 4: for the same period, the sum over the
        categories is the number of tickets the list shows without spam --
        counted by walking the list itself."""
        admin = await _person(client, db_session, 25, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 26)
        uid = user["user"]["id"]
        for minutes, topic, status in (
            (55, "payment", "open"),  # outside the period
            (40, "payment", "resolved"),
            (35, "withdrawal", "open"),
            (30, "complaint_master", "rejected"),
            (25, "complaint_user", "duplicate"),
            (20, "technical", "spam"),
            (15, "other", "spam"),
            (10, "practice", "open"),
            (2, "technical", "open"),  # outside the period
        ):
            await _ticket(
                db_session, uid, topic=topic, status=status, age_minutes=minutes
            )
        headers = auth_headers(admin["session_token"])
        period = _period(50, 5)
        stats = (await client.get(STATS_URL, params=period, headers=headers)).json()
        listed, cursor = 0, None
        while True:
            params = {**period, "limit": 2, **({"cursor": cursor} if cursor else {})}
            body = (
                await client.get(TICKETS_URL, params=params, headers=headers)
            ).json()
            listed += len(body["tickets"])
            cursor = body["next_cursor"]
            if cursor is None:
                break
        assert (
            stats["total"]
            == sum(c["tickets"] for c in stats["categories"])
            == listed
            == 5
        )
        assert stats["spam"] == 2
        counts = {c["category"]: c["tickets"] for c in stats["categories"]}
        assert counts == {
            "payments": 2,
            "complaint_master": 1,
            "complaint_user": 1,
            "practices": 1,
            "tech": 0,
            "other": 0,
        }

    async def test_ratings_by_category_and_by_whom_they_rated(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
    ) -> None:
        """Average and share of 4-5 per category and per admin a rating is
        about (rated_resolver) -- not the last resolver; spam's rating out."""
        a = await _person(client, db_session, 27, role=UserRole.ADMIN.value)
        b = await _person(client, db_session, 28, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 29)
        uid, aid, bid = user["user"]["id"], a["user"]["id"], b["user"]["id"]
        for rating, rated_by, last, topic, status in (
            (5, aid, aid, "payment", "resolved"),
            (4, aid, bid, "withdrawal", "resolved"),  # rated A, resolved again by B
            (2, bid, bid, "payment", "resolved"),
            (1, bid, bid, "technical", "open"),  # rated, then reopened
            (5, bid, bid, "other", "spam"),  # rated, reopened, spam: out
            (None, None, aid, "technical", "resolved"),  # unrated
        ):
            await _ticket(
                db_session,
                uid,
                topic=topic,
                status=status,
                age_minutes=10,
                rating=rating,
                resolved_by=last,
                rated_resolver=rated_by,
            )
        stats = (
            await client.get(
                STATS_URL,
                params=_period(30),
                headers=auth_headers(a["session_token"]),
            )
        ).json()
        by_category = {c["category"]: c for c in stats["categories"]}
        assert by_category["payments"] == {
            "category": "payments",
            "tickets": 3,
            "rated": 3,
            "average": round(11 / 3, 2),
            "share_4_5": round(2 / 3, 3),
        }
        assert by_category["tech"]["rated"] == 1
        assert by_category["tech"]["tickets"] == 2
        assert by_category["other"] == {
            "category": "other",
            "tickets": 0,
            "rated": 0,
            "average": None,
            "share_4_5": None,
        }
        by_admin = {r["admin"]["user_id"]: r for r in stats["resolvers"]}
        assert set(by_admin) == {aid, bid}
        assert (by_admin[aid]["rated"], by_admin[aid]["average"]) == (2, 4.5)
        assert by_admin[aid]["share_4_5"] == 1.0
        assert (by_admin[bid]["rated"], by_admin[bid]["average"]) == (2, 1.5)
        assert by_admin[bid]["share_4_5"] == 0.0

    async def test_an_empty_period_lists_every_category_at_zero(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
    ) -> None:
        admin = await _person(client, db_session, 30, role=UserRole.ADMIN.value)
        stats = (
            await client.get(
                STATS_URL,
                params={
                    "created_from": "2001-01-01T00:00:00+00:00",
                    "created_to": "2001-01-02T00:00:00+00:00",
                },
                headers=auth_headers(admin["session_token"]),
            )
        ).json()
        assert [c["tickets"] for c in stats["categories"]] == [0] * 6
        assert (stats["total"], stats["spam"], stats["resolvers"]) == (0, 0, [])

    async def test_the_period_ends_before_created_to(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
    ) -> None:
        admin = await _person(client, db_session, 31, role=UserRole.ADMIN.value)
        user = await _person(client, db_session, 32)
        thread = await _ticket(db_session, user["user"]["id"], age_minutes=10)
        edge = (await _row(thread)).created_at
        headers = auth_headers(admin["session_token"])

        async def total(created_from: datetime, created_to: datetime) -> int:
            params = {
                "created_from": created_from.isoformat(),
                "created_to": created_to.isoformat(),
            }
            return (await client.get(STATS_URL, params=params, headers=headers)).json()[
                "total"
            ]

        assert await total(edge, edge + timedelta(seconds=1)) == 1
        assert await total(edge - timedelta(seconds=1), edge) == 0

    @pytest.mark.parametrize(
        "params,status",
        [
            ({"created_from": "2026-10-01T00:00:00+00:00"}, 422),
            ({"created_to": "2026-10-01T00:00:00+00:00"}, 422),
            (
                {
                    "created_from": "2026-10-01T00:00:00",
                    "created_to": "2026-10-02T00:00:00+00:00",
                },
                400,
            ),
            (
                {
                    "created_from": "2026-10-01T00:00:00+00:00",
                    "created_to": "2026-10-02T00:00:00+00:00",
                    "is_supervisor": "true",
                },
                400,
            ),
        ],
    )
    async def test_the_period_is_two_zoned_edges(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
        params,
        status,
    ) -> None:
        admin = await _person(client, db_session, 33, role=UserRole.ADMIN.value)
        resp = await client.get(
            STATS_URL,
            params=params,
            headers=auth_headers(admin["session_token"]),
        )
        assert resp.status_code == status

    async def test_statistics_are_for_admins(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        comms: _Comms,
    ) -> None:
        user = await _person(client, db_session, 34)
        resp = await client.get(
            STATS_URL,
            params=_period(10),
            headers=auth_headers(user["session_token"]),
        )
        assert resp.status_code == 403


# ---------------------------------------------------------------------------
# 6. No path deletes a ticket -- the statistics' KNOWN CEILING trigger
# ---------------------------------------------------------------------------

# Every form a ticket row can go by: itself, its thread (CASCADE), its
# person (CASCADE through the thread), by the ORM or by SQL text.
_DELETION_FORMS = [
    re.compile(r"delete\(\s*(SupportTicket|SupportThread|User)\b"),
    re.compile(r"DELETE\s+FROM\s+(support_tickets|support_threads|users)\b", re.I),
    re.compile(r"\.__table__\.delete\(", re.I),
    re.compile(r"session\.delete\(\s*(ticket|pointer|thread|user)\b"),
]


def test_only_the_spam_bin_deletes_tickets() -> None:
    """REPLACES test_no_code_path_deletes_a_ticket. It held "no path in
    app/ deletes a ticket" -- true while support_stats counted live rows
    only, and its KNOWN CEILING named this test as the trigger. BE-162
    delivery 2 brought the deletion: the spam bin (support/purge.py)
    deletes spam tickets past the retention and, in the same transaction,
    leaves a tombstone the statistics count (the marker is gone).

    What holds now, exactly: the one path that deletes tickets is the bin
    -- every deletion form found in app/ is in support/purge.py -- and that
    module writes the tombstone. That the tombstone is written in the
    deleting transaction, and counted, is held by behaviour in
    tests/test_support_spam_bin_be162.py."""
    app_dir = Path(sys.modules["app"].__file__).parent
    found = [
        f"{path.relative_to(app_dir.parent)}:{n}"
        for path in sorted(app_dir.rglob("*.py"))
        for n, line in enumerate(path.read_text().splitlines(), 1)
        if not line.lstrip().startswith("#")
        and any(form.search(line) for form in _DELETION_FORMS)
    ]
    assert found, "the bin's deletion must be found by the forms"
    assert {f.split(":")[0] for f in found} == {"app/modules/support/purge.py"}
    bin_source = (app_dir / "modules/support/purge.py").read_text()
    assert "SupportSpamTombstone(" in bin_source


def test_the_deletion_forms_do_catch_a_deletion() -> None:
    """The scan above is only worth what its forms catch: each finds the
    deletion it names."""
    samples = [
        "await session.execute(delete(SupportTicket).where(x))",
        "await session.execute(delete(SupportThread))",
        "await session.execute(delete(User).where(User.id == uid))",
        'await session.execute(text("DELETE FROM support_tickets WHERE"))',
        "SupportTicket.__table__.delete()",
        "await session.delete(ticket)",
    ]
    for sample in samples:
        assert any(form.search(sample) for form in _DELETION_FORMS), sample


async def test_a_person_and_their_admins_go_in_one_statement(
    client: AsyncClient,
    db_session: AsyncSession,
    comms: _Comms,
) -> None:
    """A ticket names three people with ON DELETE SET NULL. Deleting the
    person and two admins of a ticket in ONE statement -- as a seed reset
    does -- cascades the thread away and SET NULLs the ticket twice; the
    ticket's key to its thread is checked at commit (DEFERRED), so the
    statement goes through and the ticket goes with its thread. Checked
    at once, the second SET NULL failed on the vanished thread (23503)."""
    a = await _person(client, db_session, 37, role=UserRole.ADMIN.value)
    b = await _person(client, db_session, 38, role=UserRole.ADMIN.value)
    user = await _person(client, db_session, 39)
    thread = await _ticket(
        db_session,
        user["user"]["id"],
        status="resolved",
        rating=5,
        resolved_by=b["user"]["id"],
        rated_resolver=a["user"]["id"],
    )
    ids = [UUID(p["user"]["id"]) for p in (a, b, user)]
    await db_session.execute(delete(User).where(User.id.in_(ids)))
    await db_session.commit()
    left = (
        (
            await fresh_execute(
                select(SupportThread).where(SupportThread.comms_thread_id == thread)
            )
        )
        .scalars()
        .all()
    )
    assert left == []


# ---------------------------------------------------------------------------
# 7. Races
# ---------------------------------------------------------------------------


async def _stand() -> None:
    """Where a holder stands with its write done and not committed."""


async def test_a_reopening_message_beats_a_rating_in_flight(
    client: AsyncClient,
    db_session: AsyncSession,
    comms: _Comms,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The person writes into their resolved ticket and stands with it
    reopened, uncommitted; their rating runs into the row and must be seen
    WAITING. On commit the ticket is no longer resolved: the rating is a
    409 and nothing is written."""
    user = await _person(client, db_session, 35)
    thread = await _ticket(db_session, user["user"]["id"], status="resolved")

    async def _writes(session: AsyncSession) -> object:
        person = await session.get(User, UUID(user["user"]["id"]))
        return await service.send_dialog_message(session, user=person, body="wait")

    async def _rates(session: AsyncSession) -> object:
        person = await session.get(User, UUID(user["user"]["id"]))
        return await service.rate_ticket(
            session,
            user=person,
            thread_id=thread,
            stars=5,
            comment=None,
        )

    result = await race(
        monkeypatch,
        holder=_writes,
        pause_in=(translation, "enqueue"),
        rival=_rates,
    )
    assert result.rival_waited
    assert_no_deadlock(result)
    assert result.holder.committed
    assert isinstance(result.rival.error, ConflictError)
    row = await _row(thread)
    assert (row.status, row.rating) == ("open", None)


async def test_two_ratings_at_once_the_second_is_refused(
    client: AsyncClient,
    db_session: AsyncSession,
    comms: _Comms,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = await _person(client, db_session, 36)
    thread = await _ticket(db_session, user["user"]["id"], status="resolved")
    module = sys.modules[__name__]

    async def _rates(stars: int, session: AsyncSession, *, stand: bool) -> object:
        person = await session.get(User, UUID(user["user"]["id"]))
        out = await service.rate_ticket(
            session,
            user=person,
            thread_id=thread,
            stars=stars,
            comment=None,
        )
        if stand:
            await module._stand()
        return out

    result = await race(
        monkeypatch,
        holder=lambda s: _rates(5, s, stand=True),
        pause_in=(module, "_stand"),
        rival=lambda s: _rates(1, s, stand=False),
    )
    assert result.rival_waited
    assert_no_deadlock(result)
    assert result.holder.committed
    assert isinstance(result.rival.error, ConflictError)
    assert (await _row(thread)).rating == 5
