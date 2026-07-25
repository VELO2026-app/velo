# =============================================================================
# Test: Master methods change-request loop (M3 / E19-FLAT)
# =============================================================================
#
# Covers the FLAT method-change moderation loop:
#   POST /api/v1/masters/me/method-change-request            (master submit)
#   GET  /api/v1/admin/masters/method-change-requests        (admin list)
#   POST /api/v1/admin/masters/{id}/method-change-request/approve
#   POST /api/v1/admin/masters/{id}/method-change-request/reject
# plus the method_change_request projection on GET /api/v1/masters/me.
#
# telegram_id range (56600-56699 -- this module owns this sub-range):
#   56601        -- verified master (default)
#   56602, 56603 -- "other master" isolation checks (A4 V8, ПРОМТ №571)
#   56690        -- admin (ADMIN_TID)
# =============================================================================

from collections.abc import AsyncGenerator

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.practices.taxonomy_models import TaxonomyDirection
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user, switch_self_to_master

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
APPLY_URL = "/api/v1/masters/apply"
VERIFY_URL = "/api/v1/admin/masters/{user_id}/verify"
ME_URL = "/api/v1/masters/me"
SUBMIT_URL = "/api/v1/masters/me/method-change-request"
LIST_URL = "/api/v1/admin/masters/method-change-requests"
APPROVE_URL = "/api/v1/admin/masters/{user_id}/method-change-request/approve"
REJECT_URL = "/api/v1/admin/masters/{user_id}/method-change-request/reject"

ADMIN_TID = 56690


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """Clean all test data before/after each test (ORM, no raw SQL)."""
    await _do_cleanup(db_session)
    yield
    await _do_cleanup(db_session)


async def _do_cleanup(session: AsyncSession) -> None:
    # full_cleanup_range rolls back first (TD-032) -- must run before our own
    # deletes below (same ordering note as test_admin_taxonomy.py).
    await full_cleanup_range(session, 56600, 56699, delete_users=False)
    # R5 stage 4: promote-created directions always get a "custom_" value
    # prefix (service.py _promote_custom_methods) -- clean those up too.
    await session.execute(
        delete(TaxonomyDirection).where(TaxonomyDirection.value.like("custom_%"))
    )
    await session.commit()


def _valid_apply_body() -> dict:
    return {
        "profile": {
            "display_name": "Method Master",
            "email": "mm@test.com",
            "phone": "+1234567890",
        },
        "experience": {
            "methods": ["Медитация", "Йога"],
            "experience_years": 5,
            "bio": "Practicing for years.",
            "certifications": [],
        },
        "documents": [],
    }


async def _make_admin_auth(
    client: AsyncClient,
    db_session: AsyncSession,
) -> dict:
    """Promote ADMIN_TID to admin and return a fresh admin auth."""
    await login_user(client, telegram_id=ADMIN_TID, first_name="Admin")
    await db_session.execute(
        update(User)
        .where(User.telegram_id == ADMIN_TID)
        .values(role=UserRole.ADMIN.value)
    )
    await db_session.commit()
    return await login_user(client, telegram_id=ADMIN_TID, first_name="Admin")


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int = 56601,
    admin_auth: dict | None = None,
) -> dict:
    """Create user, apply, verify via admin. Returns master auth (post-verify).

    admin_auth (ПРОМТ №583): pass an already-obtained admin session to reuse
    it instead of logging in fresh here. Each _make_admin_auth() call burns
    2 of the 5-per-60s auth-rate-limit budget for ADMIN_TID (CRITICAL-4);
    tests that build several masters and/or also call _make_admin_auth
    themselves for an approve/reject action can exceed that budget within a
    single test otherwise. Default (None) preserves the original behavior
    for every other call site in this file.
    """
    auth = await login_user(client, telegram_id=telegram_id, first_name="Master")
    await client.post(
        APPLY_URL,
        json=_valid_apply_body(),
        headers=auth_headers(auth["session_token"]),
    )

    if admin_auth is None:
        admin_auth = await _make_admin_auth(client, db_session)
    user_id = auth["user"]["id"]
    verify_resp = await client.post(
        VERIFY_URL.format(user_id=user_id),
        json={},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert verify_resp.status_code == 200

    # Re-login to pick up master role in the session.
    await switch_self_to_master(client, auth["session_token"])
    return await login_user(client, telegram_id=telegram_id, first_name="Master")


# ---------------------------------------------------------------------------
# GET /me exposure (no request)
# ---------------------------------------------------------------------------
async def test_me_has_null_method_change_request_by_default(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A verified master with no request exposes method_change_request=None."""
    master = await _make_verified_master(client, db_session)
    resp = await client.get(
        ME_URL, headers=auth_headers(master["session_token"])
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "method_change_request" in body
    assert body["method_change_request"] is None


# ---------------------------------------------------------------------------
# Submit
# ---------------------------------------------------------------------------
async def test_master_submit_creates_pending_request(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Submit stores a pending request; live methods stay unchanged."""
    master = await _make_verified_master(client, db_session)
    headers = auth_headers(master["session_token"])

    resp = await client.post(
        SUBMIT_URL,
        json={"proposed_methods": ["Йога", "Звукотерапия"]},
        headers=headers,
    )
    assert resp.status_code == 201
    body = resp.json()
    mcr = body["method_change_request"]
    assert mcr is not None
    assert mcr["status"] == "pending"
    assert mcr["proposed_methods"] == ["Йога", "Звукотерапия"]
    # Live methods NOT touched until approval.
    assert body["methods"] == ["Медитация", "Йога"]


async def test_duplicate_pending_submit_conflicts(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A second submit while one is pending returns 409 method_change_pending."""
    master = await _make_verified_master(client, db_session)
    headers = auth_headers(master["session_token"])

    first = await client.post(
        SUBMIT_URL, json={"proposed_methods": ["Йога"]}, headers=headers
    )
    assert first.status_code == 201

    second = await client.post(
        SUBMIT_URL, json={"proposed_methods": ["Медитация"]}, headers=headers
    )
    assert second.status_code == 409
    assert second.json()["error"] == "method_change_pending"


async def test_submit_validation_rejects_empty_methods(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """proposed_methods must have at least one entry (422)."""
    master = await _make_verified_master(client, db_session)
    resp = await client.post(
        SUBMIT_URL,
        json={"proposed_methods": []},
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Admin list
# ---------------------------------------------------------------------------
async def test_admin_list_shows_pending_request(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The admin list surfaces the pending request with current + proposed."""
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    await client.post(
        SUBMIT_URL,
        json={"proposed_methods": ["Йога", "Звукотерапия"]},
        headers=auth_headers(master["session_token"]),
    )

    admin_auth = await _make_admin_auth(client, db_session)
    resp = await client.get(
        LIST_URL,
        params={"limit": 100},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert resp.status_code == 200
    body = resp.json()
    # Self-scoped: the moderation list is GLOBAL, so an unrelated pending
    # request elsewhere in the (shared) DB must not break this test — find OUR
    # row by user_id rather than asserting an exact global total.
    item = next(it for it in body["items"] if it["user_id"] == master_id)
    assert item["current_methods"] == ["Медитация", "Йога"]
    assert item["proposed_methods"] == ["Йога", "Звукотерапия"]


async def test_admin_list_requires_admin(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A non-admin (the master) cannot read the moderation list (403)."""
    master = await _make_verified_master(client, db_session)
    resp = await client.get(
        LIST_URL, headers=auth_headers(master["session_token"])
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Approve
# ---------------------------------------------------------------------------
async def test_admin_approve_updates_methods_and_clears_request(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Approve copies proposed into live methods and clears the request."""
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    master_headers = auth_headers(master["session_token"])
    await client.post(
        SUBMIT_URL,
        json={"proposed_methods": ["Йога", "Звукотерапия"]},
        headers=master_headers,
    )

    admin_auth = await _make_admin_auth(client, db_session)
    approve = await client.post(
        APPROVE_URL.format(user_id=master_id),
        json={},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert approve.status_code == 200
    assert approve.json()["status"] == "approved"

    # Master profile now carries the new methods, no outstanding request.
    me = await client.get(ME_URL, headers=master_headers)
    body = me.json()
    assert body["methods"] == ["Йога", "Звукотерапия"]
    assert body["method_change_request"] is None

    # Our master no longer appears in the (global) list — request cleared.
    empty = await client.get(
        LIST_URL,
        params={"limit": 100},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert master_id not in {it["user_id"] for it in empty.json()["items"]}


async def test_approve_without_pending_is_404(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Approving when there is no pending request returns 404."""
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    admin_auth = await _make_admin_auth(client, db_session)
    resp = await client.post(
        APPROVE_URL.format(user_id=master_id),
        json={},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Approve + promote (R5 stage 4, operator decision 3=Б)
# ---------------------------------------------------------------------------
async def test_approve_without_promote_leaves_catalog_unchanged(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A bare {} approve body (every pre-stage-4 caller) writes nothing to
    the taxonomy catalog -- identical to before stage 4."""
    before = (
        await db_session.execute(select(TaxonomyDirection.id))
    ).scalars().all()

    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    await client.post(
        SUBMIT_URL,
        json={"proposed_methods": ["Ченнелинг"]},
        headers=auth_headers(master["session_token"]),
    )

    admin_auth = await _make_admin_auth(client, db_session)
    approve = await client.post(
        APPROVE_URL.format(user_id=master_id),
        json={},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert approve.status_code == 200

    after = (
        await db_session.execute(select(TaxonomyDirection.id))
    ).scalars().all()
    assert set(after) == set(before)


async def test_approve_with_promote_creates_custom_direction(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """promote=[label] inserts a new source='custom' direction AND still
    approves the master's methods exactly as submitted."""
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    master_headers = auth_headers(master["session_token"])
    await client.post(
        SUBMIT_URL,
        json={"proposed_methods": ["Ченнелинг"]},
        headers=master_headers,
    )

    admin_auth = await _make_admin_auth(client, db_session)
    approve = await client.post(
        APPROVE_URL.format(user_id=master_id),
        json={"promote": ["Ченнелинг"]},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert approve.status_code == 200
    assert approve.json()["status"] == "approved"

    # Methods approved as submitted, independent of the promote outcome.
    me = await client.get(ME_URL, headers=master_headers)
    assert me.json()["methods"] == ["Ченнелинг"]

    row = (
        await db_session.execute(
            select(TaxonomyDirection).where(TaxonomyDirection.label == "Ченнелинг")
        )
    ).scalar_one()
    assert row.source == "custom"
    assert row.is_active is True
    assert row.value.startswith("custom_")


async def test_approve_with_master_only_creates_scoped_direction(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A4 V8 / ПРОМТ №571: master_only=[label] on the approve_method_change
    flow inserts a new source='custom' direction scoped to THIS master
    (master_id = the requesting master's own user id), not a global
    (master_id=NULL) row -- the same fix T22-6 (ПРОМТ №561) already proved
    for verify_master (test_admin_masters.py's
    test_verify_with_master_only_creates_scoped_direction), but never
    exercised on approve_method_change's OWN wiring
    (router.py:255 -> service.py's approve_method_change -> the same
    _scope_custom_methods_to_master helper). A router-level parameter typo
    or a missed pass-through on this specific endpoint would stay invisible
    without a test hitting THIS path directly."""
    label = "Синтетическое направление ПРОМТ-571 (approve master_only)"
    premise = (
        await db_session.execute(
            select(TaxonomyDirection.id).where(TaxonomyDirection.label == label)
        )
    ).scalars().all()
    assert premise == [], f"premise violated: {label!r} already exists"

    # ПРОМТ №583: one admin session, reused for every admin action below --
    # this test builds TWO masters (via _make_verified_master) plus its own
    # approve call, which at 2 fresh logins each would otherwise burn 6 of
    # the 5-per-60s ADMIN_TID auth-rate-limit budget within a single test.
    admin_auth = await _make_admin_auth(client, db_session)
    master = await _make_verified_master(client, db_session, admin_auth=admin_auth)
    master_id = master["user"]["id"]
    master_headers = auth_headers(master["session_token"])
    await client.post(
        SUBMIT_URL,
        json={"proposed_methods": [label]},
        headers=master_headers,
    )

    approve = await client.post(
        APPROVE_URL.format(user_id=master_id),
        json={"master_only": [label]},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert approve.status_code == 200
    assert approve.json()["status"] == "approved"

    me = await client.get(ME_URL, headers=master_headers)
    assert me.json()["methods"] == [label]

    row = (
        await db_session.execute(
            select(TaxonomyDirection).where(TaxonomyDirection.label == label)
        )
    ).scalar_one()
    assert row.source == "custom"
    assert row.value.startswith("custom_")
    assert str(row.master_id) == master_id

    # Same isolation guarantee T22-6 proved for verify_master: a DIFFERENT
    # master's own catalog fetch must never see this scoped row.
    other = await _make_verified_master(
        client, db_session, telegram_id=56602, admin_auth=admin_auth,
    )
    other_taxonomy = await client.get(
        "/api/v1/taxonomy", headers=auth_headers(other["session_token"]),
    )
    assert other_taxonomy.status_code == 200
    other_labels = {d["label"] for d in other_taxonomy.json()["directions"]}
    assert label not in other_labels


async def test_approve_with_master_only_and_promote_together(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A4 V8 / ПРОМТ №571: a single approve call carrying BOTH promote and
    master_only -- the admin picking "add to catalog" for one proposed
    label and "only this master" for another in the same dialog submit --
    must route each label to its own branch: the promoted label becomes a
    GLOBAL row (master_id IS NULL, visible to every master), the
    master_only label becomes a SCOPED row (master_id = this master),
    and both end up in the master's live methods. Neither existing
    promote-only nor master_only-only test exercises this combination, so
    a wire-crossing bug (e.g. both lists routed to the same helper) would
    stay invisible without it.
    """
    global_label = "Синтетическое направление ПРОМТ-571 (approve promote combo)"
    scoped_label = "Синтетическое направление ПРОМТ-571 (approve scoped combo)"

    # ПРОМТ №583: one admin session, reused for setup and the approve call --
    # keeps this test comfortably under the 5-per-60s ADMIN_TID auth-rate-
    # limit budget (see the sibling master_only test above for the full count).
    admin_auth = await _make_admin_auth(client, db_session)
    master = await _make_verified_master(client, db_session, admin_auth=admin_auth)
    master_id = master["user"]["id"]
    master_headers = auth_headers(master["session_token"])
    await client.post(
        SUBMIT_URL,
        json={"proposed_methods": [global_label, scoped_label]},
        headers=master_headers,
    )

    approve = await client.post(
        APPROVE_URL.format(user_id=master_id),
        json={"promote": [global_label], "master_only": [scoped_label]},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert approve.status_code == 200
    assert approve.json()["status"] == "approved"

    me = await client.get(ME_URL, headers=master_headers)
    assert me.json()["methods"] == [global_label, scoped_label]

    global_row = (
        await db_session.execute(
            select(TaxonomyDirection).where(TaxonomyDirection.label == global_label)
        )
    ).scalar_one()
    assert global_row.master_id is None

    scoped_row = (
        await db_session.execute(
            select(TaxonomyDirection).where(TaxonomyDirection.label == scoped_label)
        )
    ).scalar_one()
    assert str(scoped_row.master_id) == master_id

    # The global label reaches every master's catalog; the scoped one only
    # reaches its owner's.
    other = await _make_verified_master(client, db_session, telegram_id=56603)
    other_taxonomy = await client.get(
        "/api/v1/taxonomy", headers=auth_headers(other["session_token"]),
    )
    other_labels = {d["label"] for d in other_taxonomy.json()["directions"]}
    assert global_label in other_labels
    assert scoped_label not in other_labels


async def test_approve_with_promote_dedups_existing_label(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Promoting a label that already exists in the catalog (seeded or a
    prior promote) does not create a duplicate row."""
    existing_count = (
        await db_session.execute(
            select(TaxonomyDirection.id).where(
                TaxonomyDirection.label == "Медитация"
            )
        )
    ).scalars().all()
    assert len(existing_count) == 1  # the R5-seeded "meditation" direction

    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    await client.post(
        SUBMIT_URL,
        json={"proposed_methods": ["Медитация"]},
        headers=auth_headers(master["session_token"]),
    )

    admin_auth = await _make_admin_auth(client, db_session)
    approve = await client.post(
        APPROVE_URL.format(user_id=master_id),
        json={"promote": ["Медитация"]},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert approve.status_code == 200

    after_count = (
        await db_session.execute(
            select(TaxonomyDirection.id).where(
                TaxonomyDirection.label == "Медитация"
            )
        )
    ).scalars().all()
    assert len(after_count) == 1  # still just the one seeded row -- no dup


# ---------------------------------------------------------------------------
# Reject
# ---------------------------------------------------------------------------
async def test_admin_reject_keeps_methods_and_records_reason(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Reject leaves live methods and surfaces status+reason to the master."""
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    master_headers = auth_headers(master["session_token"])
    await client.post(
        SUBMIT_URL,
        json={"proposed_methods": ["Звукотерапия"]},
        headers=master_headers,
    )

    admin_auth = await _make_admin_auth(client, db_session)
    reject = await client.post(
        REJECT_URL.format(user_id=master_id),
        json={"reason": "Недостаточно опыта в этом направлении"},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert reject.status_code == 200
    assert reject.json()["status"] == "rejected"

    me = await client.get(ME_URL, headers=master_headers)
    body = me.json()
    # Live methods unchanged.
    assert body["methods"] == ["Медитация", "Йога"]
    mcr = body["method_change_request"]
    assert mcr is not None
    assert mcr["status"] == "rejected"
    assert mcr["reject_reason"] == "Недостаточно опыта в этом направлении"

    # No longer pending -> our master not in the (global) list.
    empty = await client.get(
        LIST_URL,
        params={"limit": 100},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert master_id not in {it["user_id"] for it in empty.json()["items"]}


async def test_reject_requires_reason(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Reject with an empty reason is rejected by validation (422)."""
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    await client.post(
        SUBMIT_URL,
        json={"proposed_methods": ["Звукотерапия"]},
        headers=auth_headers(master["session_token"]),
    )
    admin_auth = await _make_admin_auth(client, db_session)
    resp = await client.post(
        REJECT_URL.format(user_id=master_id),
        json={"reason": ""},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert resp.status_code == 422


async def test_master_can_resubmit_after_rejection(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A rejected request does not block a fresh submit."""
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    master_headers = auth_headers(master["session_token"])
    await client.post(
        SUBMIT_URL,
        json={"proposed_methods": ["Звукотерапия"]},
        headers=master_headers,
    )
    admin_auth = await _make_admin_auth(client, db_session)
    await client.post(
        REJECT_URL.format(user_id=master_id),
        json={"reason": "no"},
        headers=auth_headers(admin_auth["session_token"]),
    )

    # A new submit is allowed and becomes pending again.
    resub = await client.post(
        SUBMIT_URL,
        json={"proposed_methods": ["Йога"]},
        headers=master_headers,
    )
    assert resub.status_code == 201
    assert resub.json()["method_change_request"]["status"] == "pending"
