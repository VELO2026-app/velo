# =============================================================================
# VELO Backend -- Tests: Curator group invites and joining (GT-3, 8.2 #1-4)
# =============================================================================
#
# telegram_id band: 66400-66599 (curator 66401, masters 66402-66405,
# students 66410-66419, strangers 66430-66435, admin 66490). Declared
# module-level below as _TID_MIN/_TID_MAX, ONCE -- tests/telegram_id_bands.py
# parses that declaration out of the AST on every run, and a file that uses
# ids without declaring a band fails test_blind_zone_has_not_grown.
#
# Neighbours in the same module: 66000-66199 (test_curator_groups.py, the
# curator CRUD) and 66200-66399 (test_curator_groups_page.py, the member
# page). Three files, three disjoint bands.
#
# GT-27: ELEVEN TESTS WERE REMOVED FROM THIS FILE, NOT WEAKENED. A school used
# to have TWO reusable links, and the master one promoted an existing student
# to kind='master' on join. That path was cancelled by owner ruling -- school
# masters are appointed by the curator and the appointment takes effect only
# on the appointee's confirmation (tests/test_curator_master_offer.py).
#
# The removed eleven all asserted things about the second link: that the two
# kinds were different links, that revoking one left the other working, that
# an unverified account was refused by the master one, that a student was
# upgraded by it. Their scenarios did not CHANGE, they became impossible to
# build -- there is no master link to open. Reformulating them would have
# meant writing tests for a shape that no longer exists, which is the one
# thing worse than deleting them. What survived was rewritten for one link.
#
# The trace lives here rather than in eleven docstrings that went with their
# tests: without it the next reader sees a gap in coverage and restores it.
#
# ⚠ BACKEND-ONLY, UNPROVEN LOCALLY -- no Postgres in the authoring
# environment. Written to be read and to run on the server.
#
# telegram_bot_url: every test that needs a link patches settings for its
# own duration. The suite's .env may or may not set it, and a test that
# depends on which is a test that passes or fails for reasons of its own.
#
# Coverage:
#   Invite: create-or-return per kind, two kinds are two links, revoke one
#     leaves the other, rotation mints a new token and kills the old one,
#     503 without bot_url, 404 on someone else's group
#   Preview: all nine rows of the TZ 3.4 table, plus inactive/deleted/garbage
#   Join: the same nine as codes, upgrade student -> master with joined_at
#     untouched, no demotion, block, own_group, idempotency
#   Race: UNIQUE (group_id, user_id) is the real guard
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from unittest.mock import patch
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.modules.curator_groups.models import (
    CuratorGroupInvite,
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.masters.groups_models import MasterStudent
from app.modules.masters.models import MasterProfile
from app.modules.users.models import User, UserRole
from tests.helpers import (
    auth_headers,
    fresh_execute,
    full_cleanup_range,
    login_user,
)

CURATOR_GROUPS_URL = "/api/v1/masters/me/curator-groups"
INVITES_URL = "/api/v1/masters/me/curator-groups/{group_id}/invites"
# GT-27: the revoke path lost its /{kind} segment with the second link.
INVITE_REVOKE_URL = "/api/v1/masters/me/curator-groups/{group_id}/invites"
PREVIEW_URL = "/api/v1/curator-groups/invites/{token}"
JOIN_URL = "/api/v1/curator-groups/join"
PAGE_URL = "/api/v1/curator-groups/{group_id}"
REVOKE_URL = "/api/v1/admin/masters/{user_id}/revoke"
MAKE_MASTER_URL = "/api/v1/admin/users/{user_id}/make-master"

_BOT_URL = "https://t.me/velo_test_bot"
_DEEPLINK = "?startapp=curator_group_invite__"

_TID_MIN = 66400
_TID_MAX = 66599

_TID_CURATOR = 66401
_TID_MASTER_A = 66402
_TID_MASTER_B = 66403
_TID_SUSPENDED = 66404
_TID_STUDENT_A = 66410
_TID_STUDENT_B = 66411
_TID_STRANGER = 66430
_TID_ADMIN = 66490


# ===========================================================================
# Local helpers -- copied, not imported, as every test file in this tree does
# ===========================================================================


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
    first_name: str = "Master",
    *,
    role_master: bool = True,
) -> dict:
    """Create a master with a VERIFIED profile.

    role_master=False leaves User.role at `user` while the profile stays
    verified -- that is a master browsing in user mode, and it is a real
    production state (derive_allowed_roles offers the switch, the person
    simply has not taken it). The master invite must admit them: capability
    lives in the profile, not in the role.
    """
    auth = await login_user(
        client, telegram_id=telegram_id, first_name=first_name,
    )
    user_id = UUID(auth["user"]["id"])

    if role_master:
        user = await db_session.get(User, user_id)
        user.role = UserRole.MASTER
        await db_session.flush()

    # GT-15: founding a school is now a separate admin-granted right, not
    # a consequence of verification -- so a fixture that omitted it would
    # build a master who is verified and still cannot create the group
    # every test below starts by creating. Set here rather than asserted
    # on: this file is about what a curator does WITH a school, and the
    # right itself is covered in test_curator_group_permission.py.
    db_session.add(
        MasterProfile(
            user_id=user_id,
            data={
                "account": {
                    "status": "verified",
                    "can_create_groups": True,
                },
                "profile": {"bio": "m"},
            },
        )
    )
    await db_session.flush()
    await db_session.commit()
    return auth


async def _make_admin(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
) -> str:
    auth = await login_user(client, telegram_id=telegram_id, first_name="Admin")
    await db_session.execute(
        update(User)
        .where(User.id == UUID(auth["user"]["id"]))
        .values(role=UserRole.ADMIN.value)
    )
    await db_session.commit()
    return auth["session_token"]


async def _create_group(
    client: AsyncClient, curator: dict, name: str = "Школа дыхания",
) -> dict:
    resp = await client.post(
        CURATOR_GROUPS_URL,
        json={"name": name},
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _invite(client: AsyncClient, curator: dict, group_id: str) -> str:
    """POST the invite under a patched bot url and return the raw token.

    IT USED TO TAKE A `kind`. A school had two links and this helper minted
    either; GT-27 left one, so the parameter went with the second link.
    """
    with patch.object(settings, "telegram_bot_url", _BOT_URL):
        resp = await client.post(
            INVITES_URL.format(group_id=group_id),
            json={},
            headers=auth_headers(curator["session_token"]),
        )
    assert resp.status_code == 200, resp.text
    url = resp.json()["invite_url"]
    assert url.startswith(f"{_BOT_URL}{_DEEPLINK}")
    return url.split(_DEEPLINK, 1)[1]


async def _join(client: AsyncClient, auth: dict, token: str):
    return await client.post(
        JOIN_URL,
        json={"token": token},
        headers=auth_headers(auth["session_token"]),
    )


async def _preview(client: AsyncClient, auth: dict, token: str):
    return await client.get(
        PREVIEW_URL.format(token=token),
        headers=auth_headers(auth["session_token"]),
    )


async def _seed_member(
    db_session: AsyncSession, group_id: str, user_id: str,
    kind: CuratorMemberKind, joined_at: datetime | None = None,
) -> None:
    row = CuratorGroupMember(
        group_id=UUID(group_id), user_id=UUID(user_id), kind=kind.value,
    )
    if joined_at is not None:
        row.joined_at = joined_at
    db_session.add(row)
    await db_session.flush()
    await db_session.commit()


async def _block(
    db_session: AsyncSession, curator_id: str, user_id: str,
) -> None:
    db_session.add(
        MasterStudent(
            master_id=UUID(curator_id),
            student_user_id=UUID(user_id),
            blocked_at=datetime.now(UTC),
        )
    )
    await db_session.flush()
    await db_session.commit()


async def _revoke(client: AsyncClient, admin_token: str, user_id: str) -> None:
    resp = await client.post(
        REVOKE_URL.format(user_id=user_id), headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200, resp.text


async def _re_verify(
    client: AsyncClient, admin_token: str, user_id: str,
) -> None:
    """make-master, NOT /verify: verify_master goes through
    _load_pending_profile, which 409s on anything but `pending`, and a
    revoked profile is `suspended`."""
    resp = await client.post(
        MAKE_MASTER_URL.format(user_id=user_id),
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200, resp.text


async def _member_row(db_session: AsyncSession, group_id: str, user_id: str):
    return (
        await fresh_execute(
            select(
                CuratorGroupMember.id,
                CuratorGroupMember.kind,
                CuratorGroupMember.joined_at,
            ).where(
                CuratorGroupMember.group_id == UUID(group_id),
                CuratorGroupMember.user_id == UUID(user_id),
            )
        )
    ).one_or_none()


# ===========================================================================
# Cleanup
# ===========================================================================


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ===========================================================================
# Invite: create-or-return
# ===========================================================================


@pytest.mark.asyncio
async def test_repeat_create_returns_the_same_link(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The curator taps «Пригласить» twice and gets the link they already
    pasted into a channel -- not a fresh one that kills it."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group = await _create_group(client, curator)

    first = await _invite(client, curator, group["id"])
    second = await _invite(client, curator, group["id"])
    assert first == second

    rows = (
        await fresh_execute(
            select(CuratorGroupInvite.id).where(
                CuratorGroupInvite.group_id == UUID(group["id"])
            )
        )
    ).scalars().all()
    assert len(rows) == 1




@pytest.mark.asyncio
async def test_invite_url_carries_the_deeplink(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The url is prefix + token and carries nothing else.

    It used to also prove that the two kinds produced two different urls
    differing only by token. One link now, so what is left to pin is that
    the deep link still says nothing but the token -- a second copy of any
    fact in a url is a copy the sender can edit by hand.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group = await _create_group(client, curator)

    with patch.object(settings, "telegram_bot_url", _BOT_URL):
        resp = await client.post(
            INVITES_URL.format(group_id=group["id"]),
            json={},
            headers=auth_headers(curator["session_token"]),
        )
    assert resp.status_code == 200, resp.text
    assert "kind" not in resp.json()
    for url in (resp.json()["invite_url"],):
        assert url.startswith(f"{_BOT_URL}{_DEEPLINK}")
        prefix, token = url.split(_DEEPLINK, 1)
        assert prefix == _BOT_URL
        assert "master" not in token and "student" not in token


@pytest.mark.asyncio
async def test_missing_bot_url_is_503_and_writes_nothing(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The guard runs BEFORE the group is resolved, so a misconfigured bot
    never leaves a half-made invite behind.

    Paired with the same call succeeding once the url is set."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group = await _create_group(client, curator)

    with patch.object(settings, "telegram_bot_url", ""):
        resp = await client.post(
            INVITES_URL.format(group_id=group["id"]),
            json={},
            headers=auth_headers(curator["session_token"]),
        )
    assert resp.status_code == 503
    assert resp.json()["error"] == "bot_url_not_configured"

    rows = (
        await fresh_execute(
            select(CuratorGroupInvite.id).where(
                CuratorGroupInvite.group_id == UUID(group["id"])
            )
        )
    ).scalars().all()
    assert rows == []

    assert await _invite(client, curator, group["id"])


@pytest.mark.asyncio
async def test_invites_on_someone_elses_group_are_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Ownership is checked the same way as everywhere else in the module."""
    owner = await _make_verified_master(client, db_session, _TID_CURATOR)
    stranger = await _make_verified_master(
        client, db_session, _TID_MASTER_A, first_name="Stranger",
    )
    group = await _create_group(client, owner)

    with patch.object(settings, "telegram_bot_url", _BOT_URL):
        created = await client.post(
            INVITES_URL.format(group_id=group["id"]),
            json={},
            headers=auth_headers(stranger["session_token"]),
        )
    assert created.status_code == 404

    revoked = await client.delete(
        INVITE_REVOKE_URL.format(group_id=group["id"]),
        headers=auth_headers(stranger["session_token"]),
    )
    assert revoked.status_code == 404




# ===========================================================================
# Invite: revoke and rotation
# ===========================================================================




@pytest.mark.asyncio
async def test_rotation_mints_a_new_token_and_kills_the_old_one(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Revoke + create is the ONLY way to change a link, and the old one
    stops resolving in both places -- preview and join read one row."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    joiner = await login_user(client, telegram_id=_TID_STUDENT_A)
    group = await _create_group(client, curator)
    old = await _invite(client, curator, group["id"])

    await client.delete(
        INVITE_REVOKE_URL.format(group_id=group["id"]),
        headers=auth_headers(curator["session_token"]),
    )
    new = await _invite(client, curator, group["id"])
    assert new != old

    assert (await _preview(client, joiner, old)).status_code == 404
    assert (await _join(client, joiner, old)).status_code == 404
    assert (await _preview(client, joiner, new)).status_code == 200


@pytest.mark.asyncio
async def test_revoking_a_link_that_does_not_exist_is_204(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Idempotent, like every other delete in this module."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group = await _create_group(client, curator)
    headers = auth_headers(curator["session_token"])
    url = INVITE_REVOKE_URL.format(group_id=group["id"])

    assert (await client.delete(url, headers=headers)).status_code == 204
    await _invite(client, curator, group["id"])
    assert (await client.delete(url, headers=headers)).status_code == 204
    assert (await client.delete(url, headers=headers)).status_code == 204


# ===========================================================================
# Preview / join -- 404 cases (TZ 3.4 row 2)
# ===========================================================================


@pytest.mark.asyncio
async def test_garbage_token_is_404_everywhere(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    joiner = await login_user(client, telegram_id=_TID_STUDENT_A)
    previewed = await _preview(client, joiner, "not-a-token")
    joined = await _join(client, joiner, "not-a-token")
    assert previewed.status_code == 404
    assert joined.status_code == 404
    # One code for all four causes (unknown token, revoked token, inactive
    # group, deleted group): the frontend must not be able to tell them
    # apart, and neither can this test.
    assert previewed.json()["error"] == "invite_not_found"
    assert joined.json()["error"] == "invite_not_found"


@pytest.mark.asyncio
async def test_token_of_an_inactive_group_is_404_and_comes_back(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """I-6 reaches the invite too, and re-verification restores the SAME
    token -- suspending a curator must not silently rotate their links."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    joiner = await login_user(client, telegram_id=_TID_STUDENT_A)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    group = await _create_group(client, curator)
    token = await _invite(client, curator, group["id"])

    assert (await _preview(client, joiner, token)).status_code == 200

    await _revoke(client, admin_token, curator["user"]["id"])
    assert (await _preview(client, joiner, token)).status_code == 404
    assert (await _join(client, joiner, token)).status_code == 404

    await _re_verify(client, admin_token, curator["user"]["id"])
    assert (await _preview(client, joiner, token)).status_code == 200

    still = (
        await fresh_execute(
            select(CuratorGroupInvite.token).where(
                CuratorGroupInvite.group_id == UUID(group["id"])
            )
        )
    ).scalars().all()
    assert still == [token]


@pytest.mark.asyncio
async def test_token_of_a_deleted_group_is_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The invite row is gone by cascade, so this needs no branch of its own
    -- it is indistinguishable from garbage at the storage level."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    joiner = await login_user(client, telegram_id=_TID_STUDENT_A)
    group = await _create_group(client, curator)
    token = await _invite(client, curator, group["id"])

    await client.delete(
        f"{CURATOR_GROUPS_URL}/{group['id']}",
        headers=auth_headers(curator["session_token"]),
    )

    assert (await _preview(client, joiner, token)).status_code == 404
    rows = (
        await fresh_execute(
            select(CuratorGroupInvite.id).where(
                CuratorGroupInvite.token == token
            )
        )
    ).scalars().all()
    assert rows == []


@pytest.mark.asyncio
async def test_preview_says_yes_then_the_world_moves_and_join_says_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """PREVIEW IS A HINT, JOIN IS THE GATE.

    Both directions of that: the curator gets revoked between the two calls,
    and separately the link gets revoked between the two calls. In each case
    the preview was honest when it was made and the join still refuses.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    joiner = await login_user(client, telegram_id=_TID_STUDENT_A)
    other = await login_user(client, telegram_id=_TID_STUDENT_B)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    group = await _create_group(client, curator)
    token = await _invite(client, curator, group["id"])

    seen = await _preview(client, joiner, token)
    assert seen.json()["can_join"] is True
    await _revoke(client, admin_token, curator["user"]["id"])
    assert (await _join(client, joiner, token)).status_code == 404
    await _re_verify(client, admin_token, curator["user"]["id"])

    seen_again = await _preview(client, other, token)
    assert seen_again.json()["can_join"] is True
    await client.delete(
        INVITE_REVOKE_URL.format(group_id=group["id"]),
        headers=auth_headers(curator["session_token"]),
    )
    assert (await _join(client, other, token)).status_code == 404


# ===========================================================================
# The nine rows of TZ 3.4 -- who opened what
# ===========================================================================










@pytest.mark.asyncio
async def test_a_plain_user_joins_as_a_student(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    plain = await login_user(client, telegram_id=_TID_STUDENT_A)
    group = await _create_group(client, curator)
    token = await _invite(client, curator, group["id"])

    joined = await _join(client, plain, token)
    assert joined.status_code == 200
    assert joined.json()["relation"] == "student"

    page = await client.get(
        PAGE_URL.format(group_id=group["id"]),
        headers=auth_headers(plain["session_token"]),
    )
    assert page.status_code == 200
    assert page.json()["viewer"]["relation"] == "student"


@pytest.mark.asyncio
async def test_a_verified_master_joins_as_a_student(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """TZ 3.4 row 7, right column: the LINK decides the kind, not the person.

    The pair for the upgrade test below -- a master who walked in through
    the student door is a student until a master link says otherwise.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER_A, first_name="Teacher",
    )
    group = await _create_group(client, curator)
    token = await _invite(client, curator, group["id"])

    joined = await _join(client, teacher, token)
    assert joined.status_code == 200
    assert joined.json()["relation"] == "student"


@pytest.mark.asyncio
async def test_the_curator_gets_own_group_on_the_link(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group = await _create_group(client, curator)

    # The loop over ("master", "student") went with the second link: one
    # link, one answer.
    token = await _invite(client, curator, group["id"])
    preview = (await _preview(client, curator, token)).json()
    assert preview["can_join"] is False
    assert preview["reason"] == "own_group"

    joined = await _join(client, curator, token)
    assert joined.status_code == 409
    assert joined.json()["error"] == "own_group"


@pytest.mark.asyncio
async def test_a_blocked_person_is_refused_by_the_link(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """I-9: a block must not be walked around with an old link.

    Paired with an unblocked person joining the same link, so "403" cannot
    be coming from the link being broken.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    blocked = await _make_verified_master(
        client, db_session, _TID_MASTER_A, first_name="Blocked",
    )
    welcome = await login_user(client, telegram_id=_TID_STUDENT_B)
    group = await _create_group(client, curator)
    await _block(db_session, curator["user"]["id"], blocked["user"]["id"])

    # One link, so the loop over the two kinds is gone with it.
    token = await _invite(client, curator, group["id"])
    preview = (await _preview(client, blocked, token)).json()
    assert preview["can_join"] is False
    assert preview["reason"] == "blocked_by_curator"

    refused = await _join(client, blocked, token)
    assert refused.status_code == 403
    assert refused.json()["error"] == "blocked_by_curator"

    student_token = await _invite(client, curator, group["id"])
    assert (await _join(client, welcome, student_token)).status_code == 200




# ===========================================================================
# Upgrade, non-demotion, idempotency
# ===========================================================================






@pytest.mark.asyncio
async def test_a_master_member_reopening_the_link_keeps_the_role(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """TZ 3.4 row 4, right column. There is no demotion in either direction
    of this feature, so holding a master relation is not something a link
    can take away."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER_A, first_name="Teacher",
    )
    group = await _create_group(client, curator)
    await _seed_member(
        db_session, group["id"], teacher["user"]["id"],
        CuratorMemberKind.MASTER,
    )
    student_token = await _invite(client, curator, group["id"])

    preview = (await _preview(client, teacher, student_token)).json()
    assert preview["can_join"] is False
    assert preview["reason"] == "already_member"
    assert preview["relation"] == "master"

    joined = await _join(client, teacher, student_token)
    assert joined.status_code == 200
    assert joined.json()["relation"] == "master"

    row = await _member_row(db_session, group["id"], teacher["user"]["id"])
    assert row.kind == "master"


@pytest.mark.asyncio
async def test_a_student_member_reopening_the_link_is_already_member(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    group = await _create_group(client, curator)
    token = await _invite(client, curator, group["id"])

    await _join(client, student, token)
    preview = (await _preview(client, student, token)).json()
    assert preview["can_join"] is False
    assert preview["reason"] == "already_member"
    assert preview["relation"] == "student"

    again = await _join(client, student, token)
    assert again.json()["already_member"] is True
    assert again.json()["relation"] == "student"




# ===========================================================================
# Preview details and the storage guard
# ===========================================================================


@pytest.mark.asyncio
async def test_preview_carries_the_group_card_with_live_counters(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """What the person actually sees before deciding."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER_A, first_name="Teacher",
    )
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    stranger = await login_user(client, telegram_id=_TID_STRANGER)
    group = await _create_group(client, curator, name="Школа дыхания")
    await _seed_member(
        db_session, group["id"], teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    await _seed_member(
        db_session, group["id"], student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    token = await _invite(client, curator, group["id"])

    card = (await _preview(client, stranger, token)).json()["group"]
    assert card["name"] == "Школа дыхания"
    assert card["masters_count"] == 1
    assert card["students_count"] == 1
    assert card["curator_name"] == "Master"
    assert "curator" not in card


@pytest.mark.asyncio
async def test_an_empty_group_still_previews_as_joinable(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A school with nobody in it yet is a normal thing to be invited to."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    joiner = await login_user(client, telegram_id=_TID_STUDENT_A)
    group = await _create_group(client, curator)
    token = await _invite(client, curator, group["id"])

    body = (await _preview(client, joiner, token)).json()
    assert body["can_join"] is True
    assert body["group"]["masters_count"] == 0
    assert body["group"]["students_count"] == 0


@pytest.mark.asyncio
async def test_one_relation_per_pair_is_enforced_by_the_database(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """UNIQUE (group_id, user_id) is what a concurrent double join collides
    with.

    A real race is not reproducible in this suite, so what is asserted is
    the constraint the code leans on: the second insert for the same pair
    cannot succeed, which is why the IntegrityError path in join is a
    recovery and not a guess.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    group = await _create_group(client, curator)
    token = await _invite(client, curator, group["id"])
    assert (await _join(client, student, token)).status_code == 200

    db_session.add(
        CuratorGroupMember(
            group_id=UUID(group["id"]),
            user_id=UUID(student["user"]["id"]),
            kind=CuratorMemberKind.MASTER.value,
        )
    )
    with pytest.raises(IntegrityError):
        await db_session.flush()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_join_needs_no_bot_url(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The 503 belongs to link CREATION only. A link already in someone's
    chat keeps working if the bot url is later cleared -- nothing on the
    join path composes a url."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    joiner = await login_user(client, telegram_id=_TID_STUDENT_A)
    group = await _create_group(client, curator)
    token = await _invite(client, curator, group["id"])

    with patch.object(settings, "telegram_bot_url", ""):
        preview = await _preview(client, joiner, token)
        joined = await _join(client, joiner, token)
    assert preview.status_code == 200
    assert joined.status_code == 200


@pytest.mark.asyncio
async def test_the_invites_route_is_not_swallowed_by_the_group_id_route(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Declaration order, asserted on a REAL token rather than read off the
    file: `invites` is not a UUID, so if /{group_id} were declared first
    this would be a 422 instead of a preview."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    joiner = await login_user(client, telegram_id=_TID_STUDENT_A)
    group = await _create_group(client, curator)
    token = await _invite(client, curator, group["id"])

    resp = await _preview(client, joiner, token)
    assert resp.status_code == 200, resp.text

    missing = await client.get(
        PREVIEW_URL.format(token=uuid4()),
        headers=auth_headers(joiner["session_token"]),
    )
    assert missing.status_code == 404
