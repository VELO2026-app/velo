# =============================================================================
# VELO Backend -- Tests: the right to found a school (GT-15)
# =============================================================================
#
# telegram_id band: 65000-65199 (admin 65090, masters 65001-65005, plain
# user 65030). Declared module-level below as _TID_MIN/_TID_MAX, ONCE --
# tests/telegram_id_bands.py reads that declaration out of the AST on every
# run, and a file that uses ids without declaring a band fails
# test_blind_zone_has_not_grown. The band was checked free against the live
# registry before it was claimed: free_windows(space=(65000, 65999))
# returned the whole window.
#
# WHAT THIS FILE IS ABOUT. Until GT-15 curatorship was a consequence of
# being a verified master: anyone verified could found a school. Now the
# right is a flag an admin grants -- data.account.can_create_groups -- and
# it gates EXACTLY ONE operation, creating a new school. Everything else a
# curator does is about a school that already exists and does not ask.
#
# THE FLAG MEANS "MAY FOUND", NOT "MAY OWN". That distinction is the reason
# test_flagless_master_can_inherit_a_school_by_transfer exists: a curator
# who wants to hand their school over must have someone to hand it to, and
# gating the transfer would leave schools locked to owners who want out.
#
# ⚠ BACKEND-ONLY, UNPROVEN LOCALLY -- no Postgres in the authoring
# environment. Written to be read and to run on the server; never executed
# via pytest this session. See the delivery report for what WAS checked.
#
# CLEANUP is full_cleanup_range(..., delete_users=True) and NOTHING ELSE,
# for the reason test_curator_groups.py states: every curator table FKs
# into users / curator_group with ON DELETE CASCADE, so deleting the band's
# users takes their schools with them. Plain cleanup_range would keep the
# users, leave curator_group rows behind, and the second run would hit 409
# on the same school name.
#
# Coverage -- the states, not the endpoints:
#   verification: no field / false / true / repeat
#   toggle:       grant, grant again, revoke, revoke again, non-verified,
#                 unknown user, non-admin
#   gate:         allowed 201, refused 403 with its own code, refused
#                 before the name is even looked at
#   survival:     flag outlives revoke_master + make_master re-verify
#   blast radius: a revoked flag leaves the school fully operable
#   visibility:   admin list, master's own list
#   transfer:     a flagless master may inherit but still may not found
# =============================================================================

from collections.abc import AsyncGenerator
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.masters.models import MasterProfile
from app.modules.users.models import User, UserRole
from tests.helpers import (
    auth_headers,
    fresh_execute,
    full_cleanup_range,
    login_user,
)

APPLY_URL = "/api/v1/masters/apply"
VERIFY_URL = "/api/v1/admin/masters/{user_id}/verify"
RIGHT_URL = "/api/v1/admin/masters/{user_id}/can-create-groups"
REVOKE_URL = "/api/v1/admin/masters/{user_id}/revoke"
MAKE_MASTER_URL = "/api/v1/admin/users/{user_id}/make-master"
MASTERS_LIST_URL = "/api/v1/admin/masters/list"
GROUPS_URL = "/api/v1/masters/me/curator-groups"
GROUP_URL = "/api/v1/masters/me/curator-groups/{group_id}"
MEMBERS_URL = "/api/v1/masters/me/curator-groups/{group_id}/members"
OFFER_URL = "/api/v1/masters/me/curator-groups/{group_id}/transfer"
ACCEPT_URL = "/api/v1/curator-groups/{group_id}/transfer/accept"
PAGE_URL = "/api/v1/curator-groups/{group_id}"

_TID_MIN = 65000
_TID_MAX = 65199

_TID_CURATOR = 65001
_TID_HEIR = 65002
_TID_OTHER = 65003
_TID_APPLICANT = 65004
_TID_APPLICANT_B = 65005
_TID_PLAIN = 65030
_TID_ADMIN = 65090

_CODE = "group_creation_not_allowed"


# ===========================================================================
# Local helpers -- copied, not imported, which is the convention in every
# curator test file (_make_verified_master exists locally in five of them).
# No default telegram_id on any of them: a default would also have to live
# inside 65000-65199 or test_no_default_id_sits_outside_its_own_band would
# flag it.
# ===========================================================================


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
    *,
    can_create_groups: bool,
    first_name: str = "Master",
) -> dict:
    """A verified master, with or without the right to found schools.

    can_create_groups is REQUIRED, with no default, on purpose: in this
    file the two masters are not interchangeable, and a helper that
    silently picked one would let a test claim to be about the flagless
    case while building the flagged one.
    """
    auth = await login_user(
        client, telegram_id=telegram_id, first_name=first_name,
    )
    user_id = auth["user"]["id"]

    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER
    await db_session.flush()

    account: dict = {"status": "verified"}
    if can_create_groups:
        account["can_create_groups"] = True
    db_session.add(
        MasterProfile(
            user_id=user_id,
            data={"account": account, "profile": {"bio": "m"}},
        )
    )
    await db_session.flush()
    await db_session.commit()
    return auth


async def _make_admin(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
) -> str:
    """Create a user, upgrade to admin, return the session token."""
    auth = await login_user(client, telegram_id=telegram_id, first_name="Admin")
    await db_session.execute(
        update(User)
        .where(User.id == UUID(auth["user"]["id"]))
        .values(role=UserRole.ADMIN.value)
    )
    await db_session.commit()
    return auth["session_token"]


async def _create_applicant(
    client: AsyncClient, telegram_id: int,
) -> dict:
    """A user with a PENDING master application, through the real endpoint.

    Not a hand-written MasterProfile row: verification is the thing under
    test here, and _load_pending_profile only admits a profile the apply
    flow actually produced.
    """
    auth = await login_user(
        client, telegram_id=telegram_id, first_name="Applicant",
    )
    resp = await client.post(
        APPLY_URL,
        json={
            "profile": {
                "display_name": "GT-15 Applicant",
                "email": "gt15@test.com",
                "phone": "+1234567890",
            },
            "experience": {
                "methods": ["meditation"],
                "experience_years": 5,
                "bio": "applicant for the school-right tests",
                "certifications": ["Cert A"],
            },
            "documents": [{"type": "certificate", "number": "CERT-001"}],
        },
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 201, resp.text
    return auth


async def _account_block(user_id: str) -> dict:
    """data.account as the DATABASE has it, not as the session remembers it."""
    profile = (
        await fresh_execute(
            select(MasterProfile).where(
                MasterProfile.user_id == UUID(user_id)
            )
        )
    ).scalar_one()
    return (profile.data or {}).get("account", {})


async def _create_group(
    client: AsyncClient, auth: dict, name: str = "Школа дыхания",
):
    return await client.post(
        GROUPS_URL,
        json={"name": name},
        headers=auth_headers(auth["session_token"]),
    )


async def _set_right(
    client: AsyncClient, admin_token: str, user_id: str, value: bool,
):
    return await client.patch(
        RIGHT_URL.format(user_id=user_id),
        json={"can_create_groups": value},
        headers=auth_headers(admin_token),
    )


# ===========================================================================
# Cleanup
# ===========================================================================


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(
        db_session, _TID_MIN, _TID_MAX, delete_users=True,
    )
    await db_session.commit()
    yield
    await full_cleanup_range(
        db_session, _TID_MIN, _TID_MAX, delete_users=True,
    )
    await db_session.commit()


# ===========================================================================
# Verification -- where the right is first decided
# ===========================================================================


@pytest.mark.asyncio
async def test_verify_without_the_field_grants_no_right(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A bare verify body behaves exactly as it did before GT-15.

    THE "NO X" HALF IS PAIRED WITH A "Y IS THERE AND NOT EMPTY" HALF, and
    the pairing is the point: asserting only that can_create_groups is
    absent would pass just as happily if verification had written nothing
    at all -- or if the profile had failed to load and this were reading an
    empty dict. The verification block proves the write happened and that
    what is missing is missing on purpose.
    """
    applicant = await _create_applicant(client, _TID_APPLICANT)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    user_id = applicant["user"]["id"]

    resp = await client.post(
        VERIFY_URL.format(user_id=user_id),
        json={"notes": "ok"},
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200, resp.text

    account = await _account_block(user_id)
    assert "can_create_groups" not in account
    assert account["status"] == "verified"
    assert account["verification"]["verified_by"]


@pytest.mark.asyncio
async def test_verify_with_false_writes_nothing_and_verify_with_true_writes_it(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """false and true in the SAME test, because the pair is the claim.

    An explicit false is not stored: absent and false are one state
    (master_can_create_groups), and stamping an always-false key onto every
    verified profile would mean the key's presence stopped telling anyone
    anything. Read as one test rather than two so that "false wrote
    nothing" can never pass because the write path was broken for
    everybody.
    """
    denied = await _create_applicant(client, _TID_APPLICANT)
    granted = await _create_applicant(client, _TID_APPLICANT_B)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)

    for auth, value in ((denied, False), (granted, True)):
        resp = await client.post(
            VERIFY_URL.format(user_id=auth["user"]["id"]),
            json={"can_create_groups": value},
            headers=auth_headers(admin_token),
        )
        assert resp.status_code == 200, resp.text

    assert "can_create_groups" not in await _account_block(
        denied["user"]["id"]
    )
    assert (await _account_block(granted["user"]["id"]))[
        "can_create_groups"
    ] is True


@pytest.mark.asyncio
async def test_verify_rejects_a_value_that_is_not_a_boolean(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """422, and the application is still pending afterwards.

    The second half matters more than the first: a body rejected at the
    schema must not have half-verified anybody. "maybe" and null are the
    values chosen deliberately -- Pydantic's non-strict bool ACCEPTS "yes",
    "true", 1 and 0 and coerces them, so a test built on "yes" would assert
    a 422 that never happens.
    """
    applicant = await _create_applicant(client, _TID_APPLICANT)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    user_id = applicant["user"]["id"]

    for bad in ("maybe", None, []):
        resp = await client.post(
            VERIFY_URL.format(user_id=user_id),
            json={"can_create_groups": bad},
            headers=auth_headers(admin_token),
        )
        assert resp.status_code == 422, f"{bad!r}: {resp.text}"

    assert (await _account_block(user_id))["status"] == "pending"


@pytest.mark.asyncio
async def test_second_verify_is_409_and_leaves_the_account_block_intact(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Re-verifying a verified master neither loses nor rewrites anything.

    _load_pending_profile admits only status == "pending", so the second
    call never reaches the JSONB write. Asserted against the whole account
    block rather than the flag alone: the risk being covered is a write
    that clobbers a SIBLING key, which a flag-only assertion cannot see.
    """
    applicant = await _create_applicant(client, _TID_APPLICANT)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    user_id = applicant["user"]["id"]

    first = await client.post(
        VERIFY_URL.format(user_id=user_id),
        json={"can_create_groups": True, "notes": "first"},
        headers=auth_headers(admin_token),
    )
    assert first.status_code == 200, first.text
    before = await _account_block(user_id)

    second = await client.post(
        VERIFY_URL.format(user_id=user_id),
        json={"can_create_groups": False, "notes": "second"},
        headers=auth_headers(admin_token),
    )
    assert second.status_code == 409, second.text

    assert await _account_block(user_id) == before
    assert before["can_create_groups"] is True


# ===========================================================================
# The toggle -- granting and taking back after verification
# ===========================================================================


@pytest.mark.asyncio
async def test_granting_the_right_later_needs_no_re_verification(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """403 before, 201 after, with nothing re-issued in between.

    This is the whole reason the toggle exists: a master verified yesterday
    cannot be reached through /verify at all (409, covered above), so
    without this endpoint the right would be grantable only at the moment
    of verification and never again.
    """
    master = await _make_verified_master(
        client, db_session, _TID_CURATOR, can_create_groups=False,
    )
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)

    refused = await _create_group(client, master)
    assert refused.status_code == 403
    assert refused.json()["error"] == _CODE

    granted = await _set_right(
        client, admin_token, master["user"]["id"], True,
    )
    assert granted.status_code == 200, granted.text
    assert granted.json()["can_create_groups"] is True

    allowed = await _create_group(client, master)
    assert allowed.status_code == 201, allowed.text


@pytest.mark.asyncio
async def test_granting_twice_and_revoking_twice_are_both_idempotent(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Four calls, each answering with the state asked for.

    Both directions in one test because idempotence is a property of the
    WRITE, not of a direction: the bug this guards against is a toggle that
    flips rather than assigns, and such a toggle passes any test that calls
    it once.
    """
    master = await _make_verified_master(
        client, db_session, _TID_CURATOR, can_create_groups=False,
    )
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    user_id = master["user"]["id"]

    for value, expected in ((True, True), (True, True), (False, False), (False, False)):
        resp = await _set_right(client, admin_token, user_id, value)
        assert resp.status_code == 200, resp.text
        assert resp.json()["can_create_groups"] is expected
        assert (await _account_block(user_id))[
            "can_create_groups"
        ] is expected


@pytest.mark.asyncio
async def test_the_toggle_refuses_a_master_who_is_not_verified(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """409 on a pending application, and no key written.

    A right that is consumed inside get_current_master's shadow cannot be
    exercised by an unverified profile, so recording it there would store a
    permission nothing would ever read and nothing would ever clear.
    """
    applicant = await _create_applicant(client, _TID_APPLICANT)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    user_id = applicant["user"]["id"]

    resp = await _set_right(client, admin_token, user_id, True)
    assert resp.status_code == 409, resp.text

    account = await _account_block(user_id)
    assert "can_create_groups" not in account
    assert account["status"] == "pending"


@pytest.mark.asyncio
async def test_the_toggle_404s_on_a_user_with_no_master_profile(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A plain user and an id that belongs to nobody, same answer.

    Both are included because they reach the 404 by different routes -- one
    has a User row and no profile, the other has neither -- and a loader
    that only handled one of them would still pass a single-case test.
    """
    plain = await login_user(client, telegram_id=_TID_PLAIN)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)

    for user_id in (plain["user"]["id"], str(uuid4())):
        resp = await _set_right(client, admin_token, user_id, True)
        assert resp.status_code == 404, resp.text


@pytest.mark.asyncio
async def test_a_master_cannot_grant_the_right_to_themselves(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The toggle is behind get_current_admin, so a master gets 403.

    Paired with a positive half -- the same call from an admin succeeds --
    so that "403" cannot be produced by the route not existing, by a typo
    in the path, or by a 405 on the wrong verb.
    """
    master = await _make_verified_master(
        client, db_session, _TID_CURATOR, can_create_groups=False,
    )
    user_id = master["user"]["id"]

    refused = await client.patch(
        RIGHT_URL.format(user_id=user_id),
        json={"can_create_groups": True},
        headers=auth_headers(master["session_token"]),
    )
    assert refused.status_code == 403

    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    allowed = await _set_right(client, admin_token, user_id, True)
    assert allowed.status_code == 200, allowed.text


# ===========================================================================
# The gate itself
# ===========================================================================


@pytest.mark.asyncio
async def test_a_flagless_master_is_refused_with_its_own_code(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """403 group_creation_not_allowed, and NOT master_profile_not_verified.

    The code is asserted rather than just the status because the two
    refusals send the frontend to different screens: "your profile is not
    confirmed" would push a fully verified master toward a pending-verdict
    page to fix something that is not broken.

    The "no row was written" half is paired with the flagged master's 201
    on the same name, which also proves the name itself was never the
    obstacle.
    """
    denied = await _make_verified_master(
        client, db_session, _TID_OTHER, can_create_groups=False,
    )
    allowed = await _make_verified_master(
        client, db_session, _TID_CURATOR, can_create_groups=True,
    )

    refused = await _create_group(client, denied, name="Тихое утро")
    assert refused.status_code == 403
    assert refused.json()["error"] == _CODE

    rows = (
        await fresh_execute(
            select(CuratorGroup).where(
                CuratorGroup.curator_user_id == UUID(denied["user"]["id"])
            )
        )
    ).scalars().all()
    assert rows == []

    created = await _create_group(client, allowed, name="Тихое утро")
    assert created.status_code == 201, created.text


@pytest.mark.asyncio
async def test_the_right_is_checked_before_the_name_is_looked_up(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A flagless master re-using their OWN school's name still gets 403.

    Not a stylistic preference about ordering: 409 here would let someone
    with no right enumerate which names they already hold, and the only way
    to reach this state -- own a school, then lose the right -- is exactly
    the state a revoked master is in.
    """
    master = await _make_verified_master(
        client, db_session, _TID_CURATOR, can_create_groups=True,
    )
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)

    first = await _create_group(client, master, name="Тихое утро")
    assert first.status_code == 201, first.text

    dup_while_allowed = await _create_group(client, master, name="Тихое утро")
    assert dup_while_allowed.status_code == 409

    revoked = await _set_right(
        client, admin_token, master["user"]["id"], False,
    )
    assert revoked.status_code == 200, revoked.text

    dup_while_denied = await _create_group(client, master, name="Тихое утро")
    assert dup_while_denied.status_code == 403
    assert dup_while_denied.json()["error"] == _CODE


@pytest.mark.asyncio
async def test_absent_and_explicit_false_are_refused_identically(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The two shapes of "no right" are one state, proven on the gate.

    They arrive by different routes -- a verification that never mentioned
    the flag leaves the key absent, while the toggle writes an explicit
    false -- and both are shapes the database really holds. A gate that
    read only one of them would be a gate with a hole, and reading a JSONB
    key that no model validates is exactly where such a hole hides.

    Deliberately NOT extended to a profile with an empty data block: that
    state cannot reach the gate at all (get_current_master refuses a
    profile with no verified status first), and a test that built it by
    hand would be asserting against a world that does not exist.
    """
    absent = await _make_verified_master(
        client, db_session, _TID_OTHER, can_create_groups=False,
    )
    explicit = await _make_verified_master(
        client, db_session, _TID_CURATOR, can_create_groups=True,
    )
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)

    revoked = await _set_right(
        client, admin_token, explicit["user"]["id"], False,
    )
    assert revoked.status_code == 200, revoked.text

    assert "can_create_groups" not in await _account_block(
        absent["user"]["id"]
    )
    assert (await _account_block(explicit["user"]["id"]))[
        "can_create_groups"
    ] is False

    for auth in (absent, explicit):
        resp = await _create_group(client, auth)
        assert resp.status_code == 403, resp.text
        assert resp.json()["error"] == _CODE


# ===========================================================================
# Blast radius -- what a revoked right does NOT do
# ===========================================================================


@pytest.mark.asyncio
async def test_revoking_the_right_leaves_the_existing_school_fully_operable(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Creation 403, and the school itself answers on every other endpoint.

    This is the load-bearing test of the whole delivery. The owner's ruling
    is that the flag gates founding and nothing else -- the lever that
    freezes what a master already built is revoke_master, and a second way
    to do the same thing would be two mechanisms obliged to agree. So the
    school is exercised through the endpoints a curator actually uses --
    the list, the page, the roster, the rename -- rather than by reading
    the row, because a surviving row that no endpoint will serve is not a
    surviving school.
    """
    master = await _make_verified_master(
        client, db_session, _TID_CURATOR, can_create_groups=True,
    )
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    headers = auth_headers(master["session_token"])

    created = await _create_group(client, master)
    assert created.status_code == 201, created.text
    group_id = created.json()["id"]

    revoked = await _set_right(
        client, admin_token, master["user"]["id"], False,
    )
    assert revoked.status_code == 200, revoked.text

    refused = await _create_group(client, master, name="Вторая")
    assert refused.status_code == 403
    assert refused.json()["error"] == _CODE

    listed = await client.get(GROUPS_URL, headers=headers)
    assert listed.status_code == 200
    assert [g["id"] for g in listed.json()["items"]] == [group_id]

    page = await client.get(
        PAGE_URL.format(group_id=group_id), headers=headers,
    )
    assert page.status_code == 200

    roster = await client.get(
        MEMBERS_URL.format(group_id=group_id), headers=headers,
    )
    assert roster.status_code == 200

    renamed = await client.patch(
        GROUP_URL.format(group_id=group_id),
        json={"name": "Тихое утро"},
        headers=headers,
    )
    assert renamed.status_code == 200, renamed.text


@pytest.mark.asyncio
async def test_the_flag_survives_revoke_master_and_the_re_verify_that_undoes_it(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Suspending a master must not quietly consume the school right.

    revoke_master rewrites data.account through a deepcopy, touching only
    status and is_accepting, and make_master's re-verify branch does the
    same -- so the right comes back with the master rather than needing to
    be re-granted by hand. The middle of the round trip is asserted too:
    while suspended the refusal is master_profile_not_verified, from
    get_current_master, which never reaches the gate at all.
    """
    master = await _make_verified_master(
        client, db_session, _TID_CURATOR, can_create_groups=True,
    )
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    user_id = master["user"]["id"]

    revoke = await client.post(
        REVOKE_URL.format(user_id=user_id),
        headers=auth_headers(admin_token),
    )
    assert revoke.status_code == 200, revoke.text
    assert (await _account_block(user_id))["can_create_groups"] is True

    while_suspended = await _create_group(client, master)
    assert while_suspended.status_code == 403
    assert while_suspended.json()["error"] != _CODE

    back = await client.post(
        MAKE_MASTER_URL.format(user_id=user_id),
        headers=auth_headers(admin_token),
    )
    assert back.status_code == 200, back.text
    assert (await _account_block(user_id))["can_create_groups"] is True

    allowed = await _create_group(client, master)
    assert allowed.status_code == 201, allowed.text


@pytest.mark.asyncio
async def test_admin_make_master_alone_does_not_grant_the_right(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The direct admin grant makes a master, not a founder.

    make_master builds its own account block and does not write the flag,
    so the two admin decisions stay separate -- which is the point of GT-15
    and would be undone if the make-master button quietly implied it.
    """
    plain = await login_user(client, telegram_id=_TID_PLAIN)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    user_id = plain["user"]["id"]

    made = await client.post(
        MAKE_MASTER_URL.format(user_id=user_id),
        headers=auth_headers(admin_token),
    )
    assert made.status_code == 200, made.text

    account = await _account_block(user_id)
    assert account["status"] == "verified"
    assert "can_create_groups" not in account

    refused = await _create_group(client, plain)
    assert refused.status_code == 403
    assert refused.json()["error"] == _CODE


# ===========================================================================
# "May found" is not "may own"
# ===========================================================================


@pytest.mark.asyncio
async def test_flagless_master_can_inherit_a_school_by_transfer(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Accepting a transfer is deliberately NOT gated, founding still is.

    Gating the transfer would make the flag destroy schools instead of
    controlling their appearance: a curator who wants out would have nobody
    to hand the school to (members rarely hold the right) and deletion
    would become the only exit. So the heir here has no flag, becomes the
    curator, manages the school in full -- and still cannot found one of
    their own, which is the half that proves the flag was never granted
    along the way.
    """
    curator = await _make_verified_master(
        client, db_session, _TID_CURATOR, can_create_groups=True,
    )
    heir = await _make_verified_master(
        client, db_session, _TID_HEIR, can_create_groups=False,
        first_name="Анна",
    )

    created = await _create_group(client, curator)
    assert created.status_code == 201, created.text
    group_id = created.json()["id"]

    db_session.add(
        CuratorGroupMember(
            group_id=UUID(group_id),
            user_id=UUID(heir["user"]["id"]),
            kind=CuratorMemberKind.MASTER.value,
        )
    )
    await db_session.commit()

    offered = await client.post(
        OFFER_URL.format(group_id=group_id),
        json={"to_user_id": heir["user"]["id"]},
        headers=auth_headers(curator["session_token"]),
    )
    assert offered.status_code == 200, offered.text

    accepted = await client.post(
        ACCEPT_URL.format(group_id=group_id),
        headers=auth_headers(heir["session_token"]),
    )
    assert accepted.status_code == 200, accepted.text

    heir_headers = auth_headers(heir["session_token"])
    mine = await client.get(GROUPS_URL, headers=heir_headers)
    assert mine.status_code == 200
    assert [g["id"] for g in mine.json()["items"]] == [group_id]

    renamed = await client.patch(
        GROUP_URL.format(group_id=group_id),
        json={"name": "Школа наследника"},
        headers=heir_headers,
    )
    assert renamed.status_code == 200, renamed.text

    own = await _create_group(client, heir, name="Своя школа")
    assert own.status_code == 403
    assert own.json()["error"] == _CODE


# ===========================================================================
# Visibility -- who can see the right
# ===========================================================================


@pytest.mark.asyncio
async def test_the_master_sees_their_own_right_on_the_schools_list(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """false before the grant, true after -- on the list, not per school.

    The frontend decides whether to offer the "create a school" button from
    this call, which it already makes. Read with an empty items list first
    so the flag is proven to be a property of the master and not something
    derived from a school they happen to own.
    """
    master = await _make_verified_master(
        client, db_session, _TID_CURATOR, can_create_groups=False,
    )
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    headers = auth_headers(master["session_token"])

    before = await client.get(GROUPS_URL, headers=headers)
    assert before.status_code == 200
    assert before.json()["items"] == []
    assert before.json()["can_create_groups"] is False

    granted = await _set_right(
        client, admin_token, master["user"]["id"], True,
    )
    assert granted.status_code == 200, granted.text

    after = await client.get(GROUPS_URL, headers=headers)
    assert after.status_code == 200
    assert after.json()["can_create_groups"] is True


@pytest.mark.asyncio
async def test_the_admin_list_shows_who_holds_the_right(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Two masters, one flag, one row each -- and the count is not the flag.

    curator_groups_count and can_create_groups sit next to each other and
    answer different questions: what this master already owns versus what
    they may found next. The flagged master here owns nothing and the
    flagless one is left owning nothing too, so a screen that confused the
    two would show the same value for both and be caught.
    """
    granted = await _make_verified_master(
        client, db_session, _TID_CURATOR, can_create_groups=True,
    )
    denied = await _make_verified_master(
        client, db_session, _TID_OTHER, can_create_groups=False,
    )
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)

    resp = await client.get(
        MASTERS_LIST_URL,
        params={"limit": 100},
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200, resp.text
    by_id = {item["id"]: item for item in resp.json()["items"]}

    assert by_id[granted["user"]["id"]]["can_create_groups"] is True
    assert by_id[denied["user"]["id"]]["can_create_groups"] is False
    assert by_id[granted["user"]["id"]]["curator_groups_count"] == 0


@pytest.mark.asyncio
async def test_a_flagged_master_with_schools_reads_correctly_on_both_fields(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Three schools and no right: the count stays 3, the flag reads false.

    The state an admin will actually meet after taking the right back from
    an active curator, and the one that would expose a screen deriving
    either field from the other.
    """
    master = await _make_verified_master(
        client, db_session, _TID_CURATOR, can_create_groups=True,
    )
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)

    for name in ("Первая", "Вторая", "Третья"):
        resp = await _create_group(client, master, name=name)
        assert resp.status_code == 201, resp.text

    revoked = await _set_right(
        client, admin_token, master["user"]["id"], False,
    )
    assert revoked.status_code == 200, revoked.text

    resp = await client.get(
        MASTERS_LIST_URL,
        params={"limit": 100},
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200, resp.text
    item = {i["id"]: i for i in resp.json()["items"]}[master["user"]["id"]]

    assert item["curator_groups_count"] == 3
    assert item["can_create_groups"] is False

    mine = await client.get(
        GROUPS_URL, headers=auth_headers(master["session_token"]),
    )
    assert len(mine.json()["items"]) == 3
