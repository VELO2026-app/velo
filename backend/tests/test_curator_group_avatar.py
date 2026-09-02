# =============================================================================
# VELO Backend -- Tests: the school's avatar (GT-17)
# =============================================================================
#
# telegram_id band: 65400-65599 (curator 65401, master member 65403,
# student 65410, outsider 65430). Declared once, module-level,
# as _TID_MIN/_TID_MAX -- tests/telegram_id_bands.py reads that declaration
# out of the AST on every run, and a file using ids without declaring a band
# fails test_blind_zone_has_not_grown. Checked free against the live registry
# before it was claimed: free_windows(space=(65000, 65999)) returned
# [(65400, 65999)].
#
# WHAT THIS FILE IS ABOUT. curator_group.avatar_url is the first field in
# this backend that takes a URL FROM A USER -- every other avatar_url is
# copied from Telegram and every zoom link is minted by the Zoom API. The
# value lands in an <img src> in front of every member of the school, which
# is why most of what follows is about what the schema refuses.
#
# EVERY EXPECTED CODE IS TIED TO THE LAYER THAT PRODUCES IT, and that
# mapping was written down BEFORE the tests, because GT-16 shipped a test
# that asserted 404 where the dependency answers 403:
#
#   403 -> get_current_master, before ownership is consulted at all
#   404 -> the ownership check in the service (someone else's school)
#   422 -> the schema (bad scheme, malformed, too long, missing `name`)
#   200 -> the service did the work
#
# A test here that expects 422 must be exercising the schema, and a test
# that expects 404 must be about ownership. Mixing them is the exact defect
# this header exists to prevent.
#
# ⚠ BACKEND-ONLY, UNPROVEN LOCALLY -- no Postgres in the authoring
# environment. Never executed via pytest this session; see the delivery
# report for what WAS checked and how.
#
# NO BACKEND FALLBACK IS TESTED because there is none and there must not be
# one: VAvatar.vue already renders initials on @error. Nothing here fetches
# the URL, and nothing should -- that would be an SSRF surface opened for a
# problem the client already solved.
#
# CLEANUP is full_cleanup_range(..., delete_users=True) and nothing else:
# curator_group cascades from users, and the journal cascades from
# curator_group, so deleting the band's users takes schools and entries with
# them.
# =============================================================================

from collections.abc import AsyncGenerator
from unittest.mock import patch
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupEventKind,
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

GROUPS_URL = "/api/v1/masters/me/curator-groups"
GROUP_URL = "/api/v1/masters/me/curator-groups/{group_id}"
JOURNAL_URL = "/api/v1/masters/me/curator-groups/{group_id}/journal"
INVITES_URL = "/api/v1/masters/me/curator-groups/{group_id}/invites"
PREVIEW_URL = "/api/v1/curator-groups/invites/{token}"
MINE_URL = "/api/v1/curator-groups/mine"
PAGE_URL = "/api/v1/curator-groups/{group_id}"

_TID_MIN = 65400
_TID_MAX = 65599

_TID_CURATOR = 65401
_TID_MASTER_MEMBER = 65403
_TID_STUDENT = 65410
_TID_OUTSIDER = 65430

_BOT_URL = "https://t.me/velo_test_bot"
_DEEPLINK = "?startapp=curator_group_invite__"

_URL = "https://cdn.example.com/school.png"
_URL_2 = "https://cdn.example.com/school-new.png"


# ===========================================================================
# Local helpers -- copied, not imported, as in every curator test file.
# No default telegram_id anywhere: a default would also have to sit inside
# 65400-65599 or test_no_default_id_sits_outside_its_own_band would flag it.
# ===========================================================================


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
    first_name: str = "Master",
) -> dict:
    auth = await login_user(
        client, telegram_id=telegram_id, first_name=first_name,
    )
    user_id = UUID(auth["user"]["id"])

    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER
    await db_session.flush()

    # GT-15: founding a school is a separate admin-granted right.
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


async def _make_group(
    client: AsyncClient, curator: dict, name: str = "Школа дыхания",
) -> str:
    resp = await client.post(
        GROUPS_URL,
        json={"name": name},
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _patch(
    client: AsyncClient, curator: dict, group_id: str, **body,
):
    """PATCH the school.

    `name` is NOT defaulted here on purpose. UpdateCuratorGroupRequest
    requires it -- a school always has one -- so every caller has to decide
    what name it is sending, and the test that omits it is asserting a 422
    rather than tripping over a helper's convenience.
    """
    return await client.patch(
        GROUP_URL.format(group_id=group_id),
        json=body,
        headers=auth_headers(curator["session_token"]),
    )


async def _set_avatar(
    client: AsyncClient,
    curator: dict,
    group_id: str,
    url: str | None,
    name: str = "Школа дыхания",
):
    """The ordinary way to set or clear the picture: name + avatar_url."""
    return await _patch(
        client, curator, group_id, name=name, avatar_url=url,
    )


async def _stored_avatar(group_id: str) -> str | None:
    """Read the column, not the response.

    Used where the claim is about what is IN the database -- a response
    could agree with the test while the column held something else, which
    is exactly what normalisation makes possible.
    """
    group = (
        await fresh_execute(
            select(CuratorGroup).where(CuratorGroup.id == UUID(group_id))
        )
    ).scalar_one()
    return group.avatar_url


async def _events(
    client: AsyncClient, curator: dict, group_id: str,
) -> list[dict]:
    resp = await client.get(
        JOURNAL_URL.format(group_id=group_id),
        params={"limit": 100},
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


async def _kinds(
    client: AsyncClient, curator: dict, group_id: str,
) -> list[str]:
    return [e["event"] for e in await _events(client, curator, group_id)]


async def _invite(
    client: AsyncClient, curator: dict, group_id: str, kind: str,
) -> str:
    with patch.object(settings, "telegram_bot_url", _BOT_URL):
        resp = await client.post(
            INVITES_URL.format(group_id=group_id),
            json={"kind": kind},
            headers=auth_headers(curator["session_token"]),
        )
    assert resp.status_code == 200, resp.text
    return resp.json()["invite_url"].split(_DEEPLINK, 1)[1]


async def _seed_member(
    db_session: AsyncSession, group_id: str, auth: dict, kind: str,
) -> None:
    db_session.add(
        CuratorGroupMember(
            group_id=UUID(group_id),
            user_id=UUID(auth["user"]["id"]),
            kind=kind,
        )
    )
    await db_session.commit()


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
# Setting and clearing -- 200, from the service
# ===========================================================================


@pytest.mark.asyncio
async def test_setting_an_avatar_stores_it_and_records_one_event(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The happy path, asserted in three places that can disagree.

    The response, the column and the journal are checked separately
    because they fail separately: a payload dict can carry the value while
    the column holds nothing (the service forgot to assign), the column
    can hold it while the response omits it (a payload dict was missed --
    there are four), and both can be right while no event was written.

    had_avatar_before is false here and that is the whole point of the
    flag: this school had no picture, so this entry means "attached", not
    "changed".
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group_id = await _make_group(client, curator)

    resp = await _set_avatar(client, curator, group_id, _URL)
    assert resp.status_code == 200, resp.text
    assert resp.json()["avatar_url"] == _URL

    assert await _stored_avatar(group_id) == _URL

    events = await _events(client, curator, group_id)
    avatar = [
        e
        for e in events
        if e["event"] == CuratorGroupEventKind.GROUP_AVATAR_CHANGED.value
    ]
    assert len(avatar) == 1
    assert avatar[0]["data"]["had_avatar_before"] is False


@pytest.mark.asyncio
async def test_clearing_an_avatar_with_null_records_a_change(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Taking the picture down is a change, with had_avatar_before true.

    Removal has to be an event: the curator did it deliberately and may
    want to see that they did. The flag is what separates this entry from
    the one above -- same event kind, opposite direction.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group_id = await _make_group(client, curator)
    assert (
        await _set_avatar(client, curator, group_id, _URL)
    ).status_code == 200

    cleared = await _set_avatar(client, curator, group_id, None)
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["avatar_url"] is None
    assert await _stored_avatar(group_id) is None

    flags = [
        e["data"]["had_avatar_before"]
        for e in await _events(client, curator, group_id)
        if e["event"] == CuratorGroupEventKind.GROUP_AVATAR_CHANGED.value
    ]
    # Newest first: the removal, then the attachment.
    assert flags == [True, False]


@pytest.mark.asyncio
async def test_a_blank_avatar_becomes_null_and_never_an_empty_string(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """"" and whitespace clear the field, exactly as they do for description.

    Not a 422: the curator emptying an input is asking for "no picture",
    not submitting a malformed url. Handled BEFORE the url rules, in the
    schema, since an empty string is not a url and would otherwise be
    rejected before any service saw it.

    Asserted against the COLUMN rather than the response, because the
    thing that must never exist is an empty string in the database -- "no
    avatar" has to have exactly one representation.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)

    for blank in ("", "   ", "\t"):
        group_id = await _make_group(client, curator, name=f"Ш{blank!r}")
        assert (
            await _set_avatar(
                client, curator, group_id, _URL, name=f"Ш{blank!r}",
            )
        ).status_code == 200

        resp = await _set_avatar(
            client, curator, group_id, blank, name=f"Ш{blank!r}",
        )
        assert resp.status_code == 200, resp.text
        assert await _stored_avatar(group_id) is None
        assert resp.json()["avatar_url"] is None


@pytest.mark.asyncio
async def test_sending_the_same_avatar_again_records_nothing(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Idempotent in the journal, like renaming to the current name.

    THIS TEST ONLY PASSES BECAUSE THE STORED FORM IS NORMALISED. The
    second PATCH sends "https://cdn.example.com" without a trailing slash
    and the stored value has one -- if raw text were stored, the two would
    compare unequal and the feed would report a change that did not
    happen. So both spellings are sent, and neither adds an entry.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group_id = await _make_group(client, curator)

    assert (
        await _set_avatar(client, curator, group_id, "https://cdn.example.com")
    ).status_code == 200
    after_first = len(await _events(client, curator, group_id))

    for same in ("https://cdn.example.com", "https://cdn.example.com/"):
        resp = await _set_avatar(client, curator, group_id, same)
        assert resp.status_code == 200, resp.text

    assert len(await _events(client, curator, group_id)) == after_first


@pytest.mark.asyncio
async def test_clearing_an_avatar_that_was_never_set_records_nothing(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """null on an empty field changes nothing, so it is not news.

    The mirror of the test above, on the other side of the value: "no
    change" is decided by comparing old and new, not by which direction
    the request was going.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group_id = await _make_group(client, curator)
    before = await _kinds(client, curator, group_id)

    resp = await _set_avatar(client, curator, group_id, None)
    assert resp.status_code == 200, resp.text

    assert await _kinds(client, curator, group_id) == before
    assert CuratorGroupEventKind.GROUP_AVATAR_CHANGED.value not in before


@pytest.mark.asyncio
async def test_a_patch_without_the_key_leaves_the_avatar_alone(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """An absent key is not a null one -- the column is untouched.

    This is the bug the partial-update mechanism exists to prevent: a
    plain rename must not wipe a picture the curator set yesterday.
    Asserted with a rename that DOES happen, so "the avatar survived"
    cannot be satisfied by the PATCH having done nothing at all.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group_id = await _make_group(client, curator)
    assert (
        await _set_avatar(client, curator, group_id, _URL)
    ).status_code == 200

    renamed = await _patch(client, curator, group_id, name="Тихое утро")
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "Тихое утро"
    assert renamed.json()["avatar_url"] == _URL
    assert await _stored_avatar(group_id) == _URL

    kinds = await _kinds(client, curator, group_id)
    assert kinds.count(CuratorGroupEventKind.GROUP_RENAMED.value) == 1
    assert kinds.count(CuratorGroupEventKind.GROUP_AVATAR_CHANGED.value) == 1


@pytest.mark.asyncio
async def test_renaming_and_re_picturing_at_once_writes_two_events(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """One PATCH, two independent changes, two entries.

    Not one "group updated": a rename may be worth telling members about
    and a new picture may not, and a combined event would force that
    decision to be re-derived from `data`. Both share created_at to the
    byte -- they are one transaction -- and their order in the feed comes
    from seq, which carries no meaning between them.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group_id = await _make_group(client, curator)
    assert (
        await _set_avatar(client, curator, group_id, _URL)
    ).status_code == 200
    before = len(await _events(client, curator, group_id))

    resp = await _patch(
        client, curator, group_id, name="Тихое утро", avatar_url=_URL_2,
    )
    assert resp.status_code == 200, resp.text

    items = await _events(client, curator, group_id)
    assert len(items) == before + 2
    fresh = items[:2]
    assert {e["event"] for e in fresh} == {
        CuratorGroupEventKind.GROUP_RENAMED.value,
        CuratorGroupEventKind.GROUP_AVATAR_CHANGED.value,
    }
    assert len({e["created_at"] for e in fresh}) == 1
    assert len({e["id"] for e in fresh}) == 2


@pytest.mark.asyncio
async def test_the_stored_url_is_the_normalised_one_not_what_was_typed(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A deliberate consequence, pinned so nobody "fixes" it by accident.

    Pydantic lower-cases the host and gives a bare authority a trailing
    slash, so what comes back is not byte-identical to what the curator
    typed. That is the price of storing something comparable -- the
    "same url means no event" rule above depends on it -- and it is worth a
    test because the alternative (store raw) looks friendlier and would
    silently break the journal.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group_id = await _make_group(client, curator)

    resp = await _set_avatar(client, curator, group_id, "https://CDN.Example.COM")
    assert resp.status_code == 200, resp.text

    stored = await _stored_avatar(group_id)
    assert stored == "https://cdn.example.com/"
    assert stored != "https://CDN.Example.COM"
    assert resp.json()["avatar_url"] == stored


# ===========================================================================
# What the schema refuses -- 422, before the service is reached
# ===========================================================================


@pytest.mark.asyncio
async def test_only_https_is_accepted_and_the_dangerous_schemes_are_not(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """http, javascript, data and file are all 422, and the school is intact.

    Closed by an ALLOW-LIST of one scheme, not by forbidding three known
    bad ones -- a deny-list admits the fourth scheme nobody thought of.
    http is excluded too, and not as theatre: it is mixed content on an
    https page, so the browser blocks it and the picture would not appear.

    The second half matters as much as the first: a rejected body must not
    have applied the NAME it also carried. Each request sends a different
    name, and the school still has its original one afterwards.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group_id = await _make_group(client, curator)

    bad = [
        "http://cdn.example.com/a.png",
        "javascript:alert(1)",
        "data:image/png;base64,iVBORw0KGgo=",
        "file:///etc/passwd",
        "ftp://cdn.example.com/a.png",
        "not a url at all",
        "cdn.example.com/a.png",
    ]
    for i, url in enumerate(bad):
        resp = await _patch(
            client, curator, group_id, name=f"Переименовано {i}",
            avatar_url=url,
        )
        assert resp.status_code == 422, f"{url}: {resp.text}"

    page = await client.get(
        PAGE_URL.format(group_id=group_id),
        headers=auth_headers(curator["session_token"]),
    )
    assert page.status_code == 200
    assert page.json()["name"] == "Школа дыхания"
    assert page.json()["avatar_url"] is None
    assert await _kinds(client, curator, group_id) == [
        CuratorGroupEventKind.GROUP_CREATED.value
    ]


@pytest.mark.asyncio
async def test_a_url_too_long_on_the_wire_is_422(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Over 500 characters as sent -- rejected by UrlConstraints.

    Paired with a url of exactly the boundary that IS accepted, so the
    rejection is shown to be about the limit and not about long urls in
    general.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group_id = await _make_group(client, curator)

    prefix = "https://cdn.example.com/"
    fits = prefix + "a" * (500 - len(prefix))
    too_long = prefix + "a" * (501 - len(prefix))
    assert len(fits) == 500
    assert len(too_long) == 501

    ok = await _set_avatar(client, curator, group_id, fits)
    assert ok.status_code == 200, ok.text
    assert await _stored_avatar(group_id) == fits

    rejected = await _set_avatar(client, curator, group_id, too_long)
    assert rejected.status_code == 422, rejected.text
    assert await _stored_avatar(group_id) == fits


@pytest.mark.asyncio
async def test_a_url_that_only_exceeds_500_after_normalisation_is_422(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """THE ONE THAT WOULD OTHERWISE BE A 500, and the reason for the second
    validator.

    UrlConstraints measures the url AS SENT. Pydantic then normalises --
    punycode for the host, percent-encoding for the path -- and the result
    can be several times longer: this url is 222 characters on the wire and
    1234 once stored. Under the length check alone it would pass validation
    and hit VARCHAR(500), coming back as a database error rather than a
    422. For a Russian-language product a Cyrillic path is ordinary, not
    exotic.

    Asserted as 422 and NOT 500 explicitly, because that distinction is the
    entire finding. The column is checked afterwards: a rejected request
    must not have written a truncated value either.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group_id = await _make_group(client, curator)

    sneaky = "https://пример.рф/" + "я" * 200 + ".png"
    assert len(sneaky) < 500

    resp = await _set_avatar(client, curator, group_id, sneaky)
    assert resp.status_code == 422, resp.text
    assert resp.status_code != 500
    assert await _stored_avatar(group_id) is None


@pytest.mark.asyncio
async def test_a_shorter_cyrillic_url_is_accepted_and_stored_punycoded(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The positive half of the test above: Cyrillic is not banned.

    Without this, "Cyrillic url rejected" would be indistinguishable from
    "Cyrillic url rejected because it was Cyrillic" -- which would be a
    real defect for this product. What is rejected is length after
    encoding, nothing else.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group_id = await _make_group(client, curator)

    resp = await _set_avatar(client, curator, group_id, "https://пример.рф/лого.png")
    assert resp.status_code == 200, resp.text

    stored = await _stored_avatar(group_id)
    assert stored is not None
    assert stored.startswith("https://xn--")
    assert len(stored) <= 500


@pytest.mark.asyncio
async def test_a_patch_carrying_only_an_avatar_is_422_for_the_missing_name(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """`name` is required, so "just set the picture" is not a valid body.

    Inherited from GT-1 and not changed here -- a school always has a
    name -- but worth pinning: it means the client must echo the current
    name on every avatar change, which is where the stale-name hazard in
    the delivery report's observations comes from.

    Paired with the same request PLUS a name, which succeeds, so the 422
    is shown to be about the missing field rather than about the avatar.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group_id = await _make_group(client, curator)

    without = await _patch(client, curator, group_id, avatar_url=_URL)
    assert without.status_code == 422, without.text
    assert await _stored_avatar(group_id) is None

    with_name = await _set_avatar(client, curator, group_id, _URL)
    assert with_name.status_code == 200, with_name.text


# ===========================================================================
# Who may set it -- 403 from the dependency, 404 from ownership
# ===========================================================================


@pytest.mark.asyncio
async def test_a_non_master_is_refused_by_the_dependency(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """403, from get_current_master, before ownership is consulted.

    Not 404: this endpoint lives on the /masters/me/ router, so the
    dependency answers first and its refusal is a statement about the
    caller's account, not about any school. Ownership is never reached, so
    there is nothing for it to leak.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    plain = await login_user(client, telegram_id=_TID_OUTSIDER)
    group_id = await _make_group(client, curator)

    resp = await _set_avatar(client, plain, group_id, _URL)
    assert resp.status_code == 403, resp.text
    assert resp.json()["error"] == "forbidden"
    assert await _stored_avatar(group_id) is None


@pytest.mark.asyncio
async def test_another_master_cannot_set_the_avatar_of_a_school_they_do_not_own(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """404, from the ownership check -- a different layer and a different code.

    A master member of the school is used, not a stranger: membership must
    not help, and a test using someone outside the school would not show
    that. A nonexistent id is included too, since it reaches 404 by
    another route.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    member = await _make_verified_master(
        client, db_session, _TID_MASTER_MEMBER,
    )
    group_id = await _make_group(client, curator)
    await _seed_member(
        db_session, group_id, member, CuratorMemberKind.MASTER.value,
    )

    for target in (group_id, str(uuid4())):
        resp = await _set_avatar(client, member, target, _URL)
        assert resp.status_code == 404, resp.text

    assert await _stored_avatar(group_id) is None


# ===========================================================================
# Where the avatar is handed out -- four responses, one of them nested
# ===========================================================================


@pytest.mark.asyncio
async def test_the_curators_own_list_carries_the_avatar(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """GET /masters/me/curator-groups, built from _group_payload.

    Two schools, one with a picture and one without, so the field is shown
    to follow the row rather than the request: a response that hard-coded
    either value would pass a single-school test.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    with_pic = await _make_group(client, curator, name="С картинкой")
    without = await _make_group(client, curator, name="Без картинки")
    assert (
        await _set_avatar(client, curator, with_pic, _URL, name="С картинкой")
    ).status_code == 200

    resp = await client.get(
        GROUPS_URL, headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 200, resp.text
    by_id = {g["id"]: g for g in resp.json()["items"]}
    assert by_id[with_pic]["avatar_url"] == _URL
    assert by_id[without]["avatar_url"] is None


@pytest.mark.asyncio
async def test_a_member_sees_the_avatar_on_the_school_page_and_in_mine(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Both member-facing reads, in one test, from two different payloads.

    The page and /mine are built by separate functions with separate
    dicts, so losing the key in one of them would leave the other passing.
    A student is used rather than a master member: the humblest viewer who
    is entitled to see the school should see its picture.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(client, telegram_id=_TID_STUDENT)
    group_id = await _make_group(client, curator)
    await _seed_member(
        db_session, group_id, student, CuratorMemberKind.STUDENT.value,
    )
    assert (
        await _set_avatar(client, curator, group_id, _URL)
    ).status_code == 200

    headers = auth_headers(student["session_token"])

    page = await client.get(PAGE_URL.format(group_id=group_id), headers=headers)
    assert page.status_code == 200, page.text
    assert page.json()["avatar_url"] == _URL

    mine = await client.get(MINE_URL, headers=headers)
    assert mine.status_code == 200, mine.text
    rows = {g["id"]: g for g in mine.json()["items"]}
    assert rows[group_id]["avatar_url"] == _URL


@pytest.mark.asyncio
async def test_the_invite_preview_carries_the_avatar(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """THE MOST LOAD-BEARING PLACE THE PICTURE GOES, and its own test.

    This is the card someone reads before deciding whether to join, where
    a picture says more than the name does. It is also the only payload
    where the field sits in a NESTED dict passed to a nested model by **,
    which the AST check over Schema(...) kwargs cannot see into -- so
    losing the key here would fail nowhere else.

    The negative half is in the same test and is not the same assertion:
    a school with no picture must return the key with a null value, NOT
    omit it. Absent and null are different things to a client, and only a
    test that inspects the key's presence can tell them apart.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    stranger = await login_user(client, telegram_id=_TID_OUTSIDER)
    with_pic = await _make_group(client, curator, name="С картинкой")
    without = await _make_group(client, curator, name="Без картинки")
    assert (
        await _set_avatar(client, curator, with_pic, _URL, name="С картинкой")
    ).status_code == 200

    token_a = await _invite(
        client, curator, with_pic, CuratorMemberKind.STUDENT.value,
    )
    token_b = await _invite(
        client, curator, without, CuratorMemberKind.STUDENT.value,
    )
    headers = auth_headers(stranger["session_token"])

    a = await client.get(PREVIEW_URL.format(token=token_a), headers=headers)
    assert a.status_code == 200, a.text
    assert a.json()["group"]["avatar_url"] == _URL

    b = await client.get(PREVIEW_URL.format(token=token_b), headers=headers)
    assert b.status_code == 200, b.text
    assert "avatar_url" in b.json()["group"]
    assert b.json()["group"]["avatar_url"] is None


@pytest.mark.asyncio
async def test_an_outsider_gets_no_school_and_therefore_no_avatar(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """404 on the page for someone with no relation to the school.

    The avatar adds no new audience: it rides on responses that already
    have their own gates. Paired with the invite preview, which the SAME
    outsider can read -- so this is shown to be about the page's gate, not
    about the person being unable to see the school at all.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    outsider = await login_user(client, telegram_id=_TID_OUTSIDER)
    group_id = await _make_group(client, curator)
    assert (
        await _set_avatar(client, curator, group_id, _URL)
    ).status_code == 200
    headers = auth_headers(outsider["session_token"])

    page = await client.get(PAGE_URL.format(group_id=group_id), headers=headers)
    assert page.status_code == 404, page.text

    token = await _invite(
        client, curator, group_id, CuratorMemberKind.STUDENT.value,
    )
    preview = await client.get(
        PREVIEW_URL.format(token=token), headers=headers,
    )
    assert preview.status_code == 200, preview.text
    assert preview.json()["group"]["avatar_url"] == _URL


@pytest.mark.asyncio
async def test_creating_a_school_never_sets_an_avatar(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Creation takes a name and a description, and ignores an avatar key.

    A deliberate boundary, pinned so that a later "just add it to create
    too" is a decision rather than a drift. Pydantic ignores unknown keys
    by default, so a client sending one gets 201 and no picture -- which
    is worth asserting, because the alternative reading ("it was accepted
    and stored") is what someone would assume.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)

    resp = await client.post(
        GROUPS_URL,
        json={"name": "Школа дыхания", "avatar_url": _URL},
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["avatar_url"] is None
    assert await _stored_avatar(resp.json()["id"]) is None


@pytest.mark.asyncio
async def test_a_school_with_no_avatar_reports_null_in_every_response(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """null, never an empty string, and the key is always present.

    Four responses in one test because the claim is about all of them at
    once: "no avatar" must look identical everywhere, or a client will
    special-case whichever screen differs. The key's PRESENCE is asserted
    separately from its value -- an omitted key and a null one are not the
    same thing to the frontend.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(client, telegram_id=_TID_STUDENT)
    group_id = await _make_group(client, curator)
    await _seed_member(
        db_session, group_id, student, CuratorMemberKind.STUDENT.value,
    )
    token = await _invite(
        client, curator, group_id, CuratorMemberKind.MASTER.value,
    )
    curator_headers = auth_headers(curator["session_token"])
    student_headers = auth_headers(student["session_token"])

    own_list = await client.get(GROUPS_URL, headers=curator_headers)
    page = await client.get(
        PAGE_URL.format(group_id=group_id), headers=student_headers,
    )
    mine = await client.get(MINE_URL, headers=student_headers)
    preview = await client.get(
        PREVIEW_URL.format(token=token), headers=student_headers,
    )

    for resp in (own_list, page, mine, preview):
        assert resp.status_code == 200, resp.text

    bodies = [
        own_list.json()["items"][0],
        page.json(),
        {g["id"]: g for g in mine.json()["items"]}[group_id],
        preview.json()["group"],
    ]
    for body in bodies:
        assert "avatar_url" in body
        assert body["avatar_url"] is None
