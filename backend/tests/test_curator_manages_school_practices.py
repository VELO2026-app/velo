# =============================================================================
# VELO Backend -- Tests: the curator manages the practices of their school
#                         (BE-63 / BE-64, delivery A)
# =============================================================================
#
# telegram_id band: 89200-89259. Declared module-level below as
# _TID_MIN/_TID_MAX, once (tests/telegram_id_bands.py parses it).
#
# ONE RULE: a practice may be acted on by its master OR by the curator of
# the school it belongs to (practices.curator_group_id). The grid:
# caller (master / this school's curator / another school's curator / a
# master of the school / an outsider) x practice (draft / published /
# without a school) x action (see / list / publish / edit / delete). Every
# refusal sits next to a success on the same practice, so a refusal cannot
# pass because the practice is broken.
#
# The race block covers the school changing hands in the window between
# the curator's read and their write, and the target master's verification
# being taken away in the window of BE-102's creation.
# =============================================================================

from collections.abc import AsyncGenerator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from unittest.mock import patch
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import AuditLog
from app.core.config import settings
from app.core.database import get_session_factory
from app.core.events.models import OutboxEvent
from app.modules.admin.masters import service as admin_masters_service
from app.modules.curator_groups import service as curator_service
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.masters.models import MasterProfile
from app.modules.practices import service as practice_service
from app.modules.practices.models import (
    AudienceKind,
    Practice,
    PracticeType,
)
from app.modules.practices.schemas import (
    CreatePracticeRequest,
    UpdatePracticeRequest,
)
from app.modules.users.models import User, UserRole
from tests.curator_race_harness import assert_no_deadlock, race
from tests.helpers import (
    auth_headers,
    fresh_execute,
    full_cleanup_range,
    login_user,
)

PRACTICES_URL = "/api/v1/practices"
DETAIL_URL = "/api/v1/practices/{practice_id}"
PREVIEW_URL = "/api/v1/practices/{practice_id}/audience-preview"
CANCEL_URL = "/api/v1/practices/{practice_id}/cancel"
MANAGE_URL = "/api/v1/masters/me/curator-groups/{group_id}/practices/manage"

_TID_MIN = 89200
_TID_MAX = 89259

_TID_CURATOR = 89201
_TID_MASTER = 89202
_TID_OTHER_CURATOR = 89203
_TID_SCHOOL_MASTER = 89204
_TID_OUTSIDER = 89205
_TID_ADMIN = 89206

_PUBLISHED = "curator_group.master_practice_published"
_EDITED = "curator_group.master_practice_edited"
_DELETED = "curator_group.master_practice_deleted"
_SLOT = datetime(2031, 5, 6, 9, 0, tzinfo=UTC)


# ===========================================================================
# Helpers -- copied, not imported, as every test file in this tree does
# ===========================================================================


async def _master(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
    first_name: str, *, methods: list[str] | None = None,
) -> dict:
    auth = await login_user(client, telegram_id=telegram_id, first_name=first_name)
    user_id = UUID(auth["user"]["id"])
    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER
    profile: dict = {"bio": "m"}
    if methods is not None:
        profile["methods"] = methods
    db_session.add(
        MasterProfile(
            user_id=user_id,
            data={"account": {"status": "verified"}, "profile": profile},
        )
    )
    await db_session.flush()
    await db_session.commit()
    return auth


@dataclass
class _S:
    curator: dict
    master: dict
    other_curator: dict
    school_master: dict
    outsider: dict
    admin: dict
    school: UUID
    other_school: UUID
    draft: UUID
    published: UUID
    schoolless: UUID

    def id(self, who: str) -> str:
        return getattr(self, who)["user"]["id"]

    def uid(self, who: str) -> UUID:
        return UUID(self.id(who))

    def token(self, who: str) -> str:
        return getattr(self, who)["session_token"]


async def _seed(
    master_id: str, school: UUID | None, *, status: str, title: str,
    hours: int = 0,
) -> UUID:
    async with get_session_factory()() as session:
        practice = Practice(
            master_id=UUID(master_id),
            title=title,
            description="x",
            practice_type=PracticeType.LIVE.value,
            status=status,
            scheduled_at=_SLOT + timedelta(hours=hours),
            duration_minutes=60,
            timezone="UTC",
            max_participants=20,
            current_participants=0,
            is_free=True,
            price_cents=0,
            currency="eur",
            audience_kind=AudienceKind.PUBLIC.value,
            curator_group_id=school,
        )
        practice.set_jsonb(
            "data",
            {"taxonomy": {"direction": "yoga", "difficulty": "beginner"}},
        )
        session.add(practice)
        await session.commit()
        return practice.id


@pytest.fixture
async def s(client: AsyncClient, db_session: AsyncSession) -> _S:
    """School A of the curator with the master (confirmed for yoga only)
    and a second master in it; school B of ANOTHER curator; three
    practices of the master: a draft and a published one in A, a draft in
    the general section."""
    curator = await _master(client, db_session, _TID_CURATOR, "Кира")
    master = await _master(
        client, db_session, _TID_MASTER, "Тимур", methods=["yoga"],
    )
    other_curator = await _master(client, db_session, _TID_OTHER_CURATOR, "Олег")
    school_master = await _master(client, db_session, _TID_SCHOOL_MASTER, "Марк")
    outsider = await _master(client, db_session, _TID_OUTSIDER, "Павел")
    admin = await login_user(client, telegram_id=_TID_ADMIN, first_name="Admin")
    admin_user = await db_session.get(User, UUID(admin["user"]["id"]))
    admin_user.role = UserRole.ADMIN
    school = CuratorGroup(curator_user_id=UUID(curator["user"]["id"]), name="Школа А")
    other_school = CuratorGroup(
        curator_user_id=UUID(other_curator["user"]["id"]), name="Школа Б",
    )
    db_session.add_all([school, other_school])
    await db_session.flush()
    for who in (master, school_master):
        db_session.add(
            CuratorGroupMember(
                group_id=school.id, user_id=UUID(who["user"]["id"]),
                kind=CuratorMemberKind.MASTER.value,
            )
        )
    await db_session.commit()
    mid = master["user"]["id"]
    return _S(
        curator=curator, master=master, other_curator=other_curator,
        school_master=school_master, outsider=outsider, admin=admin,
        school=school.id, other_school=other_school.id,
        draft=await _seed(mid, school.id, status="draft", title="Черновик"),
        published=await _seed(
            mid, school.id, status="scheduled", title="Опубликованная", hours=1,
        ),
        schoolless=await _seed(mid, None, status="draft", title="Общая", hours=2),
    )


async def _patch(client, token: str, practice_id: UUID, **body):
    return await client.patch(
        DETAIL_URL.format(practice_id=practice_id), json=body,
        headers=auth_headers(token),
    )


async def _status(practice_id: UUID) -> str:
    return (
        await fresh_execute(select(Practice.status).where(Practice.id == practice_id))
    ).scalar_one()


async def _audits(event: str, practice_id: UUID) -> list[AuditLog]:
    return list(
        (
            await fresh_execute(
                select(AuditLog).where(
                    AuditLog.event == event, AuditLog.target_id == practice_id,
                )
            )
        ).scalars().all()
    )


async def _notes(type_: str, user_id: str) -> list[OutboxEvent]:
    return list(
        (
            await fresh_execute(
                select(OutboxEvent).where(
                    OutboxEvent.payload["type"].astext == type_,
                    OutboxEvent.payload["target_value"].astext == user_id,
                )
            )
        ).scalars().all()
    )


async def _all_master_notes(s: _S) -> list[OutboxEvent]:
    out: list[OutboxEvent] = []
    for t in (_PUBLISHED, _EDITED, _DELETED):
        out += await _notes(t, s.id("master"))
    return out


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ===========================================================================
# 1. See and find
# ===========================================================================


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("who", "code"),
    [("master", 200), ("curator", 200), ("other_curator", 404),
     ("school_master", 404), ("outsider", 404)],
)
async def test_a_schools_draft_is_seen_by_its_master_and_curator_only(
    client, s: _S, who: str, code: int,
) -> None:
    resp = await client.get(
        DETAIL_URL.format(practice_id=s.draft), headers=auth_headers(s.token(who)),
    )
    assert resp.status_code == code, resp.text
    if code == 200:
        assert resp.json()["status"] == "draft"
        assert resp.json()["zoom_host_join_url"] is None


@pytest.mark.asyncio
async def test_a_draft_without_a_school_is_not_the_curators(client, s: _S) -> None:
    curator = await client.get(
        DETAIL_URL.format(practice_id=s.schoolless),
        headers=auth_headers(s.token("curator")),
    )
    master = await client.get(
        DETAIL_URL.format(practice_id=s.schoolless),
        headers=auth_headers(s.token("master")),
    )
    assert curator.status_code == 404, curator.text
    assert master.status_code == 200, master.text


@pytest.mark.asyncio
async def test_the_manage_list_holds_every_practice_of_the_school(
    client, s: _S,
) -> None:
    """Drafts included, the general section's and another school's not,
    a master who is not (or no longer) in the school included, deleted not,
    ascending by time; status filters."""
    gone = await _seed(
        s.id("outsider"), s.school, status="draft", title="Ушедший", hours=3,
    )
    deleted = await _seed(
        s.id("master"), s.school, status="deleted", title="Удалённый", hours=4,
    )
    await _seed(
        s.id("other_curator"), s.other_school, status="draft", title="Чужая",
    )
    resp = await client.get(
        MANAGE_URL.format(group_id=s.school),
        headers=auth_headers(s.token("curator")),
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert [p["id"] for p in data["items"]] == [
        str(s.draft), str(s.published), str(gone),
    ]
    assert data["total"] == 3
    assert str(deleted) not in resp.text
    assert all(p["zoom_host_join_url"] is None for p in data["items"])

    drafts = await client.get(
        MANAGE_URL.format(group_id=s.school) + "?status=draft",
        headers=auth_headers(s.token("curator")),
    )
    assert [p["id"] for p in drafts.json()["items"]] == [str(s.draft), str(gone)]


@pytest.mark.asyncio
@pytest.mark.parametrize("who", ["other_curator", "school_master", "master"])
async def test_the_manage_list_is_the_curators_only(client, s: _S, who: str) -> None:
    resp = await client.get(
        MANAGE_URL.format(group_id=s.school), headers=auth_headers(s.token(who)),
    )
    assert resp.status_code == 404, resp.text


# ===========================================================================
# 2. Publish
# ===========================================================================


@pytest.mark.asyncio
async def test_the_curator_publishes_the_masters_draft(client, s: _S) -> None:
    """ONE "published" to the master even with a field edited in the same
    PATCH; the school's fan-out is authored by the master, so it skips the
    master and reaches the curator; the act is audited."""
    resp = await _patch(
        client, s.token("curator"), s.draft, status="scheduled", title="Новая",
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["status"] == "scheduled"
    assert data["master_name"] == "Тимур"
    assert data["zoom_host_join_url"] is None

    published = await _notes(_PUBLISHED, s.id("master"))
    assert len(published) == 1
    assert published[0].payload["idempotency_key"] == (
        f"practice-published-by-curator:{s.draft}"
    )
    assert published[0].payload["action_data"]["actor_name"] == "Кира"
    assert await _notes(_EDITED, s.id("master")) == []
    audit = await _audits("practice_published_by_curator", s.draft)
    assert len(audit) == 1
    assert audit[0].actor_id == s.uid("curator")
    assert audit[0].data == {"group_id": str(s.school), "master_id": s.id("master")}

    fan_out = list(
        (
            await fresh_execute(
                select(OutboxEvent.payload["target_value"].astext).where(
                    OutboxEvent.payload["type"].astext
                    == "curator_group.practice_published",
                )
            )
        ).scalars().all()
    )
    assert s.id("curator") in fan_out
    assert s.id("master") not in fan_out


@pytest.mark.asyncio
async def test_publication_needs_the_master_to_be_a_master_of_the_school_now(
    client, s: _S,
) -> None:
    """Owner Q5. Demoted: the publication is refused -- and an EDIT of the
    same draft still goes through (no such check on edits)."""
    async with get_session_factory()() as session:
        await session.execute(
            update(CuratorGroupMember)
            .where(CuratorGroupMember.user_id == s.uid("master"))
            .values(kind=CuratorMemberKind.STUDENT.value)
        )
        await session.commit()
    refused = await _patch(client, s.token("curator"), s.draft, status="scheduled")
    assert refused.status_code == 400, refused.text
    assert refused.json()["error"] == "master_not_in_school"
    assert await _status(s.draft) == "draft"

    edited = await _patch(client, s.token("curator"), s.draft, title="Поправлено")
    assert edited.status_code == 200, edited.text


# ===========================================================================
# 3. Edit
# ===========================================================================


@pytest.mark.asyncio
async def test_every_written_edit_is_a_new_message_and_a_repeat_is_none(
    client, s: _S,
) -> None:
    first = await _patch(client, s.token("curator"), s.published, title="Раз")
    second = await _patch(client, s.token("curator"), s.published, title="Два")
    repeat = await _patch(client, s.token("curator"), s.published, title="Два")
    for resp in (first, second, repeat):
        assert resp.status_code == 200, resp.text
    notes = await _notes(_EDITED, s.id("master"))
    assert len(notes) == 2
    keys = {n.payload["idempotency_key"] for n in notes}
    assert len(keys) == 2
    assert all(k.startswith(f"practice-edited-by-curator:{s.published}:") for k in keys)
    assert len(await _audits("practice_updated_by_curator", s.published)) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("who", ["other_curator", "school_master", "outsider"])
async def test_nobody_else_edits_a_school_practice(client, s: _S, who: str) -> None:
    resp = await _patch(client, s.token(who), s.published, title="Чужая правка")
    assert resp.status_code == 404, resp.text
    ok = await _patch(client, s.token("curator"), s.published, title="Своя")
    assert ok.status_code == 200, ok.text


@pytest.mark.asyncio
async def test_the_curator_cannot_edit_a_practice_without_a_school(
    client, s: _S,
) -> None:
    refused = await _patch(client, s.token("curator"), s.schoolless, title="x")
    assert refused.status_code == 404, refused.text
    own = await _patch(client, s.token("master"), s.schoolless, title="x")
    assert own.status_code == 200, own.text


@pytest.mark.asyncio
async def test_the_masters_methods_decide_and_the_error_says_whose(
    client, s: _S,
) -> None:
    """The curator has no methods (the gate fails open for them); the master
    is confirmed for yoga only. Read with the curator's id the change would
    pass; the text names the master's methods, not "your"."""
    curator = await _patch(
        client, s.token("curator"), s.published, direction="meditation",
    )
    assert curator.status_code == 400, curator.text
    assert curator.json()["error"] == "direction_not_confirmed"
    assert "this master's" in curator.text
    master = await _patch(
        client, s.token("master"), s.published, direction="meditation",
    )
    assert master.status_code == 400, master.text
    assert "your" in master.text


@pytest.mark.asyncio
async def test_the_master_editing_their_own_practice_tells_nobody(
    client, s: _S,
) -> None:
    resp = await _patch(client, s.token("master"), s.published, title="Сам")
    assert resp.status_code == 200, resp.text
    assert await _all_master_notes(s) == []
    assert await _audits("practice_updated_by_curator", s.published) == []


@pytest.mark.asyncio
async def test_the_killswitch_takes_the_curators_right_away(client, s: _S) -> None:
    with patch.object(settings, "curator_groups_enabled", False):
        read = await client.get(
            DETAIL_URL.format(practice_id=s.draft),
            headers=auth_headers(s.token("curator")),
        )
        edit = await _patch(client, s.token("curator"), s.draft, title="x")
    assert read.status_code == 404, read.text
    assert edit.status_code == 404, edit.text


@pytest.mark.asyncio
async def test_the_audience_preview_follows_the_same_rule(client, s: _S) -> None:
    url = PREVIEW_URL.format(practice_id=s.published)
    body = {"audience_kind": "public"}
    ok = await client.post(url, json=body, headers=auth_headers(s.token("curator")))
    refused = await client.post(
        url, json=body, headers=auth_headers(s.token("other_curator")),
    )
    assert ok.status_code == 200, ok.text
    assert refused.status_code == 404, refused.text


# ===========================================================================
# 4. Delete -- and cancel unchanged in delivery A
# ===========================================================================


@pytest.mark.asyncio
async def test_the_curator_deletes_the_masters_draft(client, s: _S) -> None:
    resp = await client.delete(
        DETAIL_URL.format(practice_id=s.draft),
        headers=auth_headers(s.token("curator")),
    )
    assert resp.status_code == 200, resp.text
    assert await _status(s.draft) == "deleted"
    notes = await _notes(_DELETED, s.id("master"))
    assert len(notes) == 1
    assert notes[0].payload["action_data"]["action"] == "open_master_practices"
    assert notes[0].payload["idempotency_key"] == (
        f"practice-deleted-by-curator:{s.draft}"
    )
    assert len(await _audits("practice_deleted_by_curator", s.draft)) == 1


@pytest.mark.asyncio
async def test_delete_refusals(client, s: _S) -> None:
    other = await client.delete(
        DETAIL_URL.format(practice_id=s.draft),
        headers=auth_headers(s.token("other_curator")),
    )
    assert other.status_code == 404, other.text
    published = await client.delete(
        DETAIL_URL.format(practice_id=s.published),
        headers=auth_headers(s.token("curator")),
    )
    assert published.status_code == 400, published.text
    assert await _status(s.draft) == "draft"
    assert await _status(s.published) == "scheduled"


@pytest.mark.asyncio
async def test_a_public_school_practice_is_the_curators_to_cancel(
    client, s: _S,
) -> None:
    """Delivery B (BE-64) lifts the audience restriction delivery A kept.

    The old form of this test (..._is_still_not_the_curators_to_cancel)
    asserted a 404 and was right while cancel_practice refused a curator
    any practice of the school that was not for the school's students
    (BE-74 Q4). The owner's ruling of 2026-10-01 gives the curator every
    practice of the school, public included, and BE-64 removed that
    refusal -- so the precise statement now is the opposite one, with its
    traces: the public practice is cancelled, the audit names the curator,
    the school and the master, and the master is told once.
    """
    resp = await client.post(
        CANCEL_URL.format(practice_id=s.published),
        headers=auth_headers(s.token("curator")),
    )
    assert resp.status_code == 200, resp.text
    assert await _status(s.published) == "cancelled"

    audits = await _audits("practice_cancelled_by_curator", s.published)
    assert len(audits) == 1
    assert audits[0].actor_id == s.uid("curator")
    assert audits[0].data["group_id"] == str(s.school)
    assert audits[0].data["master_id"] == s.id("master")
    assert len(
        await _notes("practice.cancelled_by_curator", s.id("master")),
    ) == 1


# ===========================================================================
# 5. Races
# ===========================================================================


async def _offer_school_to(s: _S, who: str) -> None:
    async with get_session_factory()() as session:
        await curator_service.offer_curator_group_transfer(
            s.uid("curator"), s.school, s.uid(who), session,
            actor=await session.get(User, s.uid("curator")),
        )
        await session.commit()


def _accept_call(s: _S, who: str):
    async def call(session: AsyncSession):
        await curator_service.accept_curator_group_transfer(
            s.school, s.uid(who), session,
            actor=await session.get(User, s.uid(who)),
        )
    return call


def _edit_call(s: _S, title: str):
    body = UpdatePracticeRequest(title=title)

    async def call(session: AsyncSession):
        user = await session.get(User, s.uid("curator"))
        return await practice_service.update_practice(
            s.published, user, body, session,
        )
    return call


def _create_for_master_call(s: _S):
    body = CreatePracticeRequest(
        practice_type="live", direction="yoga", difficulty="beginner",
        title="От имени", scheduled_at=_SLOT + timedelta(days=3),
        duration_minutes=60, timezone="UTC", is_free=True,
        master_id=s.uid("master"), curator_group_id=s.school,
    )

    async def call(session: AsyncSession):
        user = await session.get(User, s.uid("curator"))
        return await practice_service.create_practice(user, body, session)
    return call


async def _titles_of_master(s: _S) -> list[str]:
    return sorted(
        (
            await fresh_execute(
                select(Practice.title).where(Practice.master_id == s.uid("master"))
            )
        ).scalars().all()
    )


@pytest.mark.asyncio
async def test_a_former_curator_cannot_edit_after_the_school_changed_hands(
    s: _S, monkeypatch,
) -> None:
    """The edit has passed the read of the rule and holds the practice; the
    handover commits in between (it takes no practice row, so it does not
    wait). Under the group lock the edit finds the school is somebody
    else's: 404, nothing written."""
    await _offer_school_to(s, "school_master")
    result = await race(
        monkeypatch,
        holder=_edit_call(s, "Бывший куратор"),
        pause_in=(practice_service, "_relock_school_or_404"),
        rival=_accept_call(s, "school_master"),
    )
    assert_no_deadlock(result)
    assert result.rival.committed, result.rival.error
    assert not result.holder.committed
    assert "Practice not found" in str(result.holder.error)
    assert "Бывший куратор" not in await _titles_of_master(s)


@pytest.mark.asyncio
async def test_a_former_curator_cannot_create_after_the_school_changed_hands(
    s: _S, monkeypatch,
) -> None:
    """BE-102's creation for a master, between its read of "is the caller
    the curator" and its group lock: the handover lands, the creation is
    refused with the same 403 as without the race, and nothing is born."""
    await _offer_school_to(s, "school_master")
    result = await race(
        monkeypatch,
        holder=_create_for_master_call(s),
        pause_in=(practice_service, "_lock_school_master_or_400"),
        rival=_accept_call(s, "school_master"),
    )
    assert_no_deadlock(result)
    assert result.rival.committed, result.rival.error
    assert not result.holder.committed
    assert "curator" in str(result.holder.error).lower()
    assert "От имени" not in await _titles_of_master(s)


@pytest.mark.asyncio
async def test_a_handover_waits_for_a_creation_holding_the_school(
    s: _S, monkeypatch,
) -> None:
    """The other order: the creation already holds the group as its owner;
    the handover waits for it, both commit, no deadlock -- the practice was
    created while the caller still owned the school."""
    await _offer_school_to(s, "school_master")
    result = await race(
        monkeypatch,
        holder=_create_for_master_call(s),
        pause_in=(practice_service, "_lock_group_as_owner"),
        pause="after",
        rival=_accept_call(s, "school_master"),
    )
    assert_no_deadlock(result)
    assert result.rival_waited is True
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    assert "От имени" in await _titles_of_master(s)


@pytest.mark.asyncio
async def test_a_verification_revoked_mid_creation_waits_for_it(
    s: _S, monkeypatch,
) -> None:
    """BE-102's creation holds the target's master profile FOR SHARE; the
    admin's revocation (an UPDATE of that row) must wait, so the practice is
    born while the master is still verified and the revocation lands on top.
    Without the profile lock it would commit inside the pause."""
    def revoke(session: AsyncSession):
        async def call():
            admin = await session.get(User, UUID(s.admin["user"]["id"]))
            await admin_masters_service.revoke_master(
                s.uid("master"), admin, session,
            )
        return call()

    result = await race(
        monkeypatch,
        holder=_create_for_master_call(s),
        pause_in=(practice_service, "_lock_school_master_or_400"),
        pause="after",
        rival=revoke,
    )
    assert_no_deadlock(result)
    assert result.rival_waited is True
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    status = (
        await fresh_execute(
            select(MasterProfile.data["account"]["status"].astext).where(
                MasterProfile.user_id == s.uid("master"),
            )
        )
    ).scalar_one()
    assert status != "verified"
    assert "От имени" in await _titles_of_master(s)
