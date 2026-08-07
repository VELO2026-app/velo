# =============================================================================
# VELO -- review SUGGESTION block (H-R4): S-a / S-b / S-c / S-d
# =============================================================================
# Band 89700-89719.
#
# Four fixes that share one shape: each removes a way for the system to be
# quietly wrong. Every one is tested with a NEGATIVE twin (the thing that
# must now fail) AND a POSITIVE twin (the neighbouring legitimate path that
# must still work) -- a gate proven only by its refusals is indistinguishable
# from a gate that refuses everything.
#
#   S-a  per-occurrence audience edit -> 400, whole PATCH refused
#   S-b  a PATCH that does not change the group set does not fan out
#   S-c  PENDING is a display flag, not an entitlement to read
#   S-d  a root edit does not rewrite terminal children's history
# =============================================================================

from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session_factory
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.masters.groups_models import (
    MasterGroup,
    MasterGroupMembership,
)
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import (
    AudienceKind,
    Practice,
    PracticeAudienceGroup,
    PracticeStatus,
    PracticeType,
)
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

_TID_MIN, _TID_MAX = 89700, 89719
PRACTICES_URL = "/api/v1/practices"


@pytest.fixture(autouse=True)
async def _clean_band(db_session: AsyncSession):
    # COMMIT after each sweep, not just at the end of the test: the delete
    # takes row locks on the band's users, and leaving it open means the very
    # next login inside the test blocks on INSERT INTO users -- the whole
    # suite hangs on its own cleanup.
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


async def _master(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int
) -> dict:
    auth = await login_user(
        client, telegram_id=telegram_id, first_name="Master",
    )
    user = await db_session.get(User, auth["user"]["id"])
    user.role = UserRole.MASTER
    await db_session.flush()
    db_session.add(
        MasterProfile(
            user_id=auth["user"]["id"],
            data={"account": {"status": "verified"}, "profile": {"bio": "m"}},
        )
    )
    await db_session.commit()
    return auth


async def _practice(
    db_session: AsyncSession,
    master_id: str,
    *,
    audience_kind: str = AudienceKind.PUBLIC.value,
    status: str = PracticeStatus.SCHEDULED.value,
    parent_id: UUID | None = None,
    hours_from_now: float = 48,
    price_cents: int = 0,
) -> Practice:
    practice = Practice(
        master_id=master_id,
        title="H-R4 practice",
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=status,
        scheduled_at=datetime.now(UTC) + timedelta(hours=hours_from_now),
        duration_minutes=60,
        timezone="UTC",
        max_participants=20,
        current_participants=0,
        is_free=price_cents == 0,
        price_cents=price_cents,
        currency="eur",
        audience_kind=audience_kind,
        parent_practice_id=parent_id,
    )
    db_session.add(practice)
    await db_session.commit()
    return practice


async def _group_with_member(
    db_session: AsyncSession, master_id: str, member_id: str | None = None
) -> MasterGroup:
    group = MasterGroup(master_id=master_id, name=f"G-{datetime.now(UTC)}")
    db_session.add(group)
    await db_session.flush()
    if member_id is not None:
        db_session.add(
            MasterGroupMembership(group_id=group.id, student_user_id=member_id)
        )
    await db_session.commit()
    return group


# Post-request assertions read through a FRESH session, never the fixture's.
# The fixture session has already committed its setup; reusing it after the
# API request made its own writes means a second checkout from the pool and a
# pre-ping in the wrong context (MissingGreenlet). A new session is also the
# honest thing to assert with: it sees exactly what the request committed.
async def _reread(practice_id) -> Practice:
    factory = get_session_factory()
    async with factory() as s:
        return await s.get(Practice, practice_id)


async def _target_groups(_unused, practice_id) -> set:
    factory = get_session_factory()
    async with factory() as s:
        rows = await s.execute(
            select(PracticeAudienceGroup.group_id).where(
                PracticeAudienceGroup.practice_id == practice_id
            )
        )
        return set(rows.scalars().all())


# ---------------------------------------------------------------------------
# S-a -- a child occurrence has no audience of its own
# ---------------------------------------------------------------------------


class TestChildAudienceIsRefused:
    async def test_audience_patch_on_a_child_is_400(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        master = await _master(client, db_session, _TID_MIN)
        root = await _practice(db_session, master["user"]["id"])
        child = await _practice(
            db_session, master["user"]["id"], parent_id=root.id,
        )

        resp = await client.patch(
            f"{PRACTICES_URL}/{child.id}",
            json={"audience_kind": AudienceKind.STUDENTS.value},
            headers=auth_headers(master["session_token"]),
        )

        assert resp.status_code == 400
        # The message has to say WHERE to go, or the master just retries.
        assert "root" in resp.json()["message"].lower()
        refreshed = await _reread(child.id)
        assert refreshed.audience_kind == AudienceKind.PUBLIC.value

    async def test_mixed_patch_applies_nothing(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """Atomicity: an audience field alongside an innocent one refuses the
        WHOLE request. Landing the innocent half and staying silent about the
        rest is exactly the quiet partial state this gate exists to kill."""
        master = await _master(client, db_session, _TID_MIN + 1)
        root = await _practice(db_session, master["user"]["id"])
        child = await _practice(
            db_session,
            master["user"]["id"],
            parent_id=root.id,
            price_cents=1000,
        )

        resp = await client.patch(
            f"{PRACTICES_URL}/{child.id}",
            json={
                "audience_kind": AudienceKind.STUDENTS.value,
                "title": "renamed",
                "price_cents": 5000,
            },
            headers=auth_headers(master["session_token"]),
        )

        assert resp.status_code == 400
        refreshed = await _reread(child.id)
        assert refreshed.audience_kind == AudienceKind.PUBLIC.value
        assert refreshed.title == "H-R4 practice"
        assert refreshed.price_cents == 1000

    async def test_non_audience_patch_on_a_child_still_works(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The twin: a child is still editable in every other respect."""
        master = await _master(client, db_session, _TID_MIN + 2)
        root = await _practice(db_session, master["user"]["id"])
        child = await _practice(
            db_session, master["user"]["id"], parent_id=root.id,
        )

        resp = await client.patch(
            f"{PRACTICES_URL}/{child.id}",
            json={"title": "renamed"},
            headers=auth_headers(master["session_token"]),
        )

        assert resp.status_code == 200
        refreshed = await _reread(child.id)
        assert refreshed.title == "renamed"

    async def test_audience_patch_on_a_root_still_works(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The other twin: the root is where audience IS edited, and its
        change still reaches the children."""
        master = await _master(client, db_session, _TID_MIN + 3)
        root = await _practice(db_session, master["user"]["id"])
        child = await _practice(
            db_session, master["user"]["id"], parent_id=root.id,
        )

        resp = await client.patch(
            f"{PRACTICES_URL}/{root.id}",
            json={"audience_kind": AudienceKind.STUDENTS.value},
            headers=auth_headers(master["session_token"]),
        )

        assert resp.status_code == 200
        assert (await _reread(child.id)).audience_kind == AudienceKind.STUDENTS.value

    async def test_standalone_practice_unaffected(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        master = await _master(client, db_session, _TID_MIN + 4)
        solo = await _practice(db_session, master["user"]["id"])

        resp = await client.patch(
            f"{PRACTICES_URL}/{solo.id}",
            json={"audience_kind": AudienceKind.STUDENTS.value},
            headers=auth_headers(master["session_token"]),
        )
        assert resp.status_code == 200


# ---------------------------------------------------------------------------
# S-b -- an unchanged set is not a change
# ---------------------------------------------------------------------------


class TestGroupSetFanOut:
    async def test_resending_the_same_set_touches_nothing(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The edit form resends group_ids on every save. Identical set ->
        the rows must not be rewritten, and the children must not be
        touched: proven by their updated_at staying put."""
        master = await _master(client, db_session, _TID_MIN + 5)
        student = await login_user(
            client, telegram_id=_TID_MIN + 6, first_name="Student",
        )
        group = await _group_with_member(
            db_session, master["user"]["id"], student["user"]["id"],
        )
        root = await _practice(
            db_session,
            master["user"]["id"],
            audience_kind=AudienceKind.GROUPS.value,
        )
        child = await _practice(
            db_session,
            master["user"]["id"],
            audience_kind=AudienceKind.GROUPS.value,
            parent_id=root.id,
        )
        db_session.add(
            PracticeAudienceGroup(practice_id=root.id, group_id=group.id)
        )
        db_session.add(
            PracticeAudienceGroup(practice_id=child.id, group_id=group.id)
        )
        await db_session.commit()

        rows_before = await _target_groups(db_session, root.id)
        child_touched_before = (await _reread(child.id)).updated_at

        resp = await client.patch(
            f"{PRACTICES_URL}/{root.id}",
            json={"title": "saved again", "group_ids": [str(group.id)]},
            headers=auth_headers(master["session_token"]),
        )

        assert resp.status_code == 200
        assert await _target_groups(db_session, root.id) == rows_before
        assert (await _reread(child.id)).updated_at == child_touched_before

    async def test_empty_set_on_a_public_practice_is_a_no_op(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The concrete case from the report: the form sends [] on a public
        practice at every save."""
        master = await _master(client, db_session, _TID_MIN + 7)
        root = await _practice(db_session, master["user"]["id"])
        child = await _practice(
            db_session, master["user"]["id"], parent_id=root.id,
        )
        child_touched_before = (await _reread(child.id)).updated_at

        resp = await client.patch(
            f"{PRACTICES_URL}/{root.id}",
            json={"title": "saved again", "group_ids": []},
            headers=auth_headers(master["session_token"]),
        )

        assert resp.status_code == 200
        assert (await _reread(child.id)).updated_at == child_touched_before

    async def test_changing_the_set_still_works(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The twin: a real change still rewrites the rows and propagates."""
        master = await _master(client, db_session, _TID_MIN + 8)
        old_group = await _group_with_member(db_session, master["user"]["id"])
        new_group = await _group_with_member(db_session, master["user"]["id"])
        root = await _practice(
            db_session,
            master["user"]["id"],
            audience_kind=AudienceKind.GROUPS.value,
        )
        child = await _practice(
            db_session,
            master["user"]["id"],
            audience_kind=AudienceKind.GROUPS.value,
            parent_id=root.id,
        )
        db_session.add(
            PracticeAudienceGroup(practice_id=root.id, group_id=old_group.id)
        )
        db_session.add(
            PracticeAudienceGroup(practice_id=child.id, group_id=old_group.id)
        )
        await db_session.commit()

        resp = await client.patch(
            f"{PRACTICES_URL}/{root.id}",
            json={"group_ids": [str(new_group.id)]},
            headers=auth_headers(master["session_token"]),
        )

        assert resp.status_code == 200
        assert await _target_groups(db_session, root.id) == {new_group.id}
        assert await _target_groups(db_session, child.id) == {new_group.id}

    async def test_kind_change_with_the_same_set_still_propagates(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The subtle twin: the SET is identical but the KIND changed --
        that is a real audience change and must reach the children."""
        master = await _master(client, db_session, _TID_MIN + 9)
        group = await _group_with_member(db_session, master["user"]["id"])
        root = await _practice(
            db_session,
            master["user"]["id"],
            audience_kind=AudienceKind.GROUPS.value,
        )
        child = await _practice(
            db_session,
            master["user"]["id"],
            audience_kind=AudienceKind.GROUPS.value,
            parent_id=root.id,
        )
        db_session.add(
            PracticeAudienceGroup(practice_id=root.id, group_id=group.id)
        )
        await db_session.commit()

        resp = await client.patch(
            f"{PRACTICES_URL}/{root.id}",
            json={
                "audience_kind": AudienceKind.PUBLIC.value,
                "group_ids": [],
            },
            headers=auth_headers(master["session_token"]),
        )

        assert resp.status_code == 200
        assert (await _reread(child.id)).audience_kind == AudienceKind.PUBLIC.value


# ---------------------------------------------------------------------------
# S-c -- PENDING is a badge, not a key
# ---------------------------------------------------------------------------


class TestPendingDoesNotUnlockDetail:
    async def _restricted_practice(
        self, client: AsyncClient, db_session: AsyncSession, base: int
    ) -> tuple[Practice, dict]:
        master = await _master(client, db_session, base)
        outsider = await login_user(
            client, telegram_id=base + 1, first_name="Outsider",
        )
        group = await _group_with_member(db_session, master["user"]["id"])
        practice = await _practice(
            db_session,
            master["user"]["id"],
            audience_kind=AudienceKind.GROUPS.value,
        )
        db_session.add(
            PracticeAudienceGroup(practice_id=practice.id, group_id=group.id)
        )
        await db_session.commit()
        return practice, outsider

    async def test_pending_booking_does_not_open_the_gate(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        practice, outsider = await self._restricted_practice(
            client, db_session, _TID_MIN + 10,
        )
        db_session.add(
            Booking(
                practice_id=practice.id,
                user_id=outsider["user"]["id"],
                status=BookingStatus.PENDING.value,
            )
        )
        await db_session.commit()

        resp = await client.get(
            f"{PRACTICES_URL}/{practice.id}",
            headers=auth_headers(outsider["session_token"]),
        )
        assert resp.status_code == 404

    async def test_confirmed_booking_still_opens_it(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The twin: the exemption exists for a reason -- a booked
        non-member reads the detail their live view needs."""
        practice, outsider = await self._restricted_practice(
            client, db_session, _TID_MIN + 12,
        )
        db_session.add(
            Booking(
                practice_id=practice.id,
                user_id=outsider["user"]["id"],
                status=BookingStatus.CONFIRMED.value,
            )
        )
        await db_session.commit()

        resp = await client.get(
            f"{PRACTICES_URL}/{practice.id}",
            headers=auth_headers(outsider["session_token"]),
        )
        assert resp.status_code == 200

    async def test_pending_still_shows_as_booked_where_allowed(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The badge is untouched: on a PUBLIC practice, a pending booking
        still reads as 'yours'. Narrowing the gate must not have narrowed
        this."""
        master = await _master(client, db_session, _TID_MIN + 14)
        student = await login_user(
            client, telegram_id=_TID_MIN + 15, first_name="Student",
        )
        practice = await _practice(db_session, master["user"]["id"])
        db_session.add(
            Booking(
                practice_id=practice.id,
                user_id=student["user"]["id"],
                status=BookingStatus.PENDING.value,
            )
        )
        await db_session.commit()

        resp = await client.get(
            f"{PRACTICES_URL}/{practice.id}",
            headers=auth_headers(student["session_token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["is_booked"] is True


# ---------------------------------------------------------------------------
# S-d -- history is not rewritten
# ---------------------------------------------------------------------------


class TestPropagationSkipsTerminalChildren:
    """Tested at the SERVICE level, not through PATCH: the filter lives in
    propagate_audience_to_children, and driving it through the HTTP layer
    would add the whole update pipeline (and its FOR UPDATE locks) to a test
    about which rows a single UPDATE touches."""

    @pytest.mark.parametrize(
        "terminal_status",
        [
            PracticeStatus.COMPLETED.value,
            PracticeStatus.CANCELLED.value,
            PracticeStatus.DELETED.value,
        ],
    )
    async def test_terminal_child_keeps_both_kind_and_groups(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        terminal_status: str,
    ) -> None:
        """Both halves asserted on purpose: a filter applied to only one of
        the two writes leaves a child with the old kind and the new rows --
        a state no read path expects."""
        from app.modules.practices.series_service import (
            propagate_audience_to_children,
        )

        master = await _master(client, db_session, _TID_MIN + 16)
        old_group = await _group_with_member(db_session, master["user"]["id"])
        new_group = await _group_with_member(db_session, master["user"]["id"])
        root = await _practice(
            db_session,
            master["user"]["id"],
            audience_kind=AudienceKind.GROUPS.value,
        )
        done_child = await _practice(
            db_session,
            master["user"]["id"],
            audience_kind=AudienceKind.GROUPS.value,
            parent_id=root.id,
            status=terminal_status,
            hours_from_now=-48,
        )
        live_child = await _practice(
            db_session,
            master["user"]["id"],
            audience_kind=AudienceKind.GROUPS.value,
            parent_id=root.id,
        )
        for pid in (done_child.id, live_child.id):
            db_session.add(
                PracticeAudienceGroup(practice_id=pid, group_id=old_group.id)
            )
        db_session.add(
            PracticeAudienceGroup(practice_id=root.id, group_id=new_group.id)
        )
        root_id, done_id, live_id = root.id, done_child.id, live_child.id
        await db_session.commit()

        factory = get_session_factory()
        async with factory() as s:
            fresh_root = await s.get(Practice, root_id)
            await propagate_audience_to_children(fresh_root, s)
            await s.commit()

        # The finished session keeps the audience it actually ran with.
        assert (await _reread(done_id)).audience_kind == (
            AudienceKind.GROUPS.value
        )
        assert await _target_groups(None, done_id) == {old_group.id}

        # The twin: a session that can still happen tracks the root.
        assert await _target_groups(None, live_id) == {new_group.id}

    async def test_terminal_child_keeps_its_kind_on_a_kind_switch(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        from app.modules.practices.series_service import (
            propagate_audience_to_children,
        )

        master = await _master(client, db_session, _TID_MIN + 18)
        root = await _practice(
            db_session,
            master["user"]["id"],
            audience_kind=AudienceKind.STUDENTS.value,
        )
        done_child = await _practice(
            db_session,
            master["user"]["id"],
            parent_id=root.id,
            status=PracticeStatus.COMPLETED.value,
            hours_from_now=-48,
        )
        live_child = await _practice(
            db_session, master["user"]["id"], parent_id=root.id,
        )
        root_id, done_id, live_id = root.id, done_child.id, live_child.id
        await db_session.commit()

        factory = get_session_factory()
        async with factory() as s:
            await propagate_audience_to_children(
                await s.get(Practice, root_id), s,
            )
            await s.commit()

        assert (await _reread(done_id)).audience_kind == (
            AudienceKind.PUBLIC.value
        )
        assert (await _reread(live_id)).audience_kind == (
            AudienceKind.STUDENTS.value
        )
