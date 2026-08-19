# =============================================================================
# Test: Users Module — Profile get/update endpoints
# =============================================================================

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from tests.helpers import auth_headers, full_cleanup_range, login_user

# telegram_id range for this test file (T-58).
#
# The file had NO cleanup of its own. Its rows survived every run and
# were collected -- silently -- by test_insights.py, whose declared
# 89441-89519 happens to cover all of these numbers and whose cleanup
# deletes users. That is not hygiene, it is a dependency on a
# neighbouring file that is written down nowhere: narrow test_insights
# or move it, and this file starts accumulating with nothing to connect
# cause to effect.
#
# ⚠ THIS RANGE OVERLAPS test_insights.py (89441-89519), AND NOT ONLY ON
# PAPER: 89442, 89443, 89451 and 89452 are used by both files. Recorded
# in KNOWN_OVERLAPS in tests/telegram_id_bands.py rather than fixed --
# separating them means moving ids, which T-58 was scoped out of. Do not
# widen this range; it is exactly the numbers below.
_TID_MIN = 89442
_TID_MAX = 89484


@pytest.fixture(autouse=True)
async def _clean_users_band(db_session: AsyncSession):
    """Sweep this file's own numbers, before and after every test.

    Before as well as after: a previous run interrupted mid-file leaves
    rows behind, and a stale user with the same telegram_id makes the
    next login return the OLD user instead of creating one.
    """
    await full_cleanup_range(
        db_session, _TID_MIN, _TID_MAX, delete_users=True
    )
    await db_session.commit()
    yield
    await full_cleanup_range(
        db_session, _TID_MIN, _TID_MAX, delete_users=True
    )
    await db_session.commit()


# ---------------------------------------------------------------------------
# GET /api/v1/users/me
# ---------------------------------------------------------------------------


async def test_get_me_success(client: AsyncClient) -> None:
    """Authenticated user can retrieve their profile."""
    data = await login_user(client, telegram_id=89442, first_name="UserTest")
    token = data["session_token"]

    response = await client.get("/api/v1/users/me", headers=auth_headers(token))

    assert response.status_code == 200
    body = response.json()
    assert body["telegram_id"] == 89442
    assert body["first_name"] == "UserTest"
    assert body["role"] == "user"
    assert body["is_active"] is True
    assert "id" in body
    assert "created_at" in body


async def test_get_me_master_application_null_for_plain_user(
    client: AsyncClient,
) -> None:
    """T5: a user who never applied has master_application = null on /me."""
    data = await login_user(client, telegram_id=89443, first_name="NoApp")
    response = await client.get(
        "/api/v1/users/me", headers=auth_headers(data["session_token"])
    )
    assert response.status_code == 200
    assert response.json()["master_application"] is None


async def test_get_me_no_auth(client: AsyncClient) -> None:
    """Request without token → 401."""
    response = await client.get("/api/v1/users/me")
    assert response.status_code == 401


async def test_get_me_invalid_token(client: AsyncClient) -> None:
    """Request with garbage token → 401."""
    response = await client.get(
        "/api/v1/users/me",
        headers=auth_headers("garbage-token"),
    )
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# PATCH /api/v1/users/me
# ---------------------------------------------------------------------------


async def test_update_me_single_field(client: AsyncClient) -> None:
    """Update only first_name — other fields unchanged."""
    data = await login_user(client, telegram_id=89451, first_name="Before")
    token = data["session_token"]

    response = await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"first_name": "After"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["first_name"] == "After"
    assert body["telegram_id"] == 89451

    # Verify persistence — GET should return updated value.
    get_response = await client.get(
        "/api/v1/users/me",
        headers=auth_headers(token),
    )
    assert get_response.json()["first_name"] == "After"


async def test_update_me_multiple_fields(client: AsyncClient) -> None:
    """Update several fields at once."""
    data = await login_user(client, telegram_id=89452)
    token = data["session_token"]

    response = await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={
            "first_name": "Updated",
            "last_name": "Person",
            "timezone": "Europe/Moscow",
            "language": "ru",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["first_name"] == "Updated"
    assert body["last_name"] == "Person"
    assert body["timezone"] == "Europe/Moscow"
    assert body["language"] == "ru"


async def test_update_me_empty_body(client: AsyncClient) -> None:
    """Empty body — no changes, still 200."""
    data = await login_user(client, telegram_id=89453, first_name="Stable")
    token = data["session_token"]

    response = await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={},
    )

    assert response.status_code == 200
    assert response.json()["first_name"] == "Stable"


async def test_update_me_set_null(client: AsyncClient) -> None:
    """Explicitly setting a field to null clears it."""
    data = await login_user(client, telegram_id=89454, first_name="HasName")
    token = data["session_token"]

    response = await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"last_name": None},
    )

    assert response.status_code == 200
    assert response.json()["last_name"] is None


async def test_update_me_no_auth(client: AsyncClient) -> None:
    """PATCH without token → 401."""
    response = await client.patch(
        "/api/v1/users/me",
        json={"first_name": "Hacker"},
    )
    assert response.status_code == 401


async def test_update_me_field_too_long(client: AsyncClient) -> None:
    """first_name exceeding max_length → 422."""
    data = await login_user(client, telegram_id=89455)
    token = data["session_token"]

    response = await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"first_name": "A" * 101},
    )

    assert response.status_code == 422


# ---------------------------------------------------------------------------
# PATCH /api/v1/users/me — empty string validation (F-1)
# ---------------------------------------------------------------------------


async def test_update_me_empty_string_first_name(client: AsyncClient) -> None:
    """Empty string for first_name → 422 (use null to clear)."""
    data = await login_user(client, telegram_id=89456)
    token = data["session_token"]

    response = await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"first_name": ""},
    )

    assert response.status_code == 422


async def test_update_me_empty_string_timezone(client: AsyncClient) -> None:
    """Empty string for timezone → 422."""
    data = await login_user(client, telegram_id=89457)
    token = data["session_token"]

    response = await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"timezone": ""},
    )

    assert response.status_code == 422


async def test_update_me_empty_string_language(client: AsyncClient) -> None:
    """Empty string for language → 422."""
    data = await login_user(client, telegram_id=89458)
    token = data["session_token"]

    response = await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"language": ""},
    )

    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Onboarding flag (stored in credentials JSONB, surfaced as a bool)
# ---------------------------------------------------------------------------


async def test_onboarding_completed_defaults_false_for_new_user(
    client: AsyncClient,
) -> None:
    """A freshly created user has onboarding_completed=False (key absent)."""
    data = await login_user(client, telegram_id=89459, first_name="Newbie")
    token = data["session_token"]

    response = await client.get("/api/v1/users/me", headers=auth_headers(token))

    assert response.status_code == 200
    assert response.json()["onboarding_completed"] is False


async def test_onboarding_completed_can_be_set_true(
    client: AsyncClient,
) -> None:
    """PATCH onboarding_completed=true is persisted and returned."""
    data = await login_user(client, telegram_id=89460, first_name="Finisher")
    token = data["session_token"]

    patch_response = await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"onboarding_completed": True},
    )
    assert patch_response.status_code == 200
    assert patch_response.json()["onboarding_completed"] is True

    # Persisted: a fresh GET still reports it true.
    get_response = await client.get(
        "/api/v1/users/me",
        headers=auth_headers(token),
    )
    assert get_response.json()["onboarding_completed"] is True


async def test_onboarding_completed_survives_relogin(
    client: AsyncClient,
) -> None:
    """The key invariant: re-login MUST preserve onboarding_completed.

    upsert_user_on_login merges credentials (coalesce(...) || fresh) instead
    of overwriting, so the flag set via PATCH is not wiped when the same
    Telegram user logs in again. Regression guard for the welcome flow.
    """
    # First login + finish onboarding.
    first = await login_user(client, telegram_id=89461, first_name="Returner")
    token1 = first["session_token"]
    await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token1),
        json={"onboarding_completed": True},
    )

    # Re-login with the SAME telegram_id (build_init_data adds a unique
    # query_id, so anti-replay is not triggered).
    second = await login_user(client, telegram_id=89461, first_name="Returner")
    token2 = second["session_token"]

    # The flag must still be true after the upsert (UPDATE branch / merge).
    me = await client.get("/api/v1/users/me", headers=auth_headers(token2))
    assert me.status_code == 200
    assert me.json()["onboarding_completed"] is True


async def test_onboarding_completed_relogin_refreshes_telegram_fields(
    client: AsyncClient,
) -> None:
    """Merge keeps the flag AND refreshes Telegram-sourced fields on re-login."""
    first = await login_user(
        client, telegram_id=89462, first_name="Before", username="before",
    )
    token1 = first["session_token"]
    await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token1),
        json={"onboarding_completed": True},
    )

    # Re-login with a changed first_name (Telegram profile updated).
    second = await login_user(
        client, telegram_id=89462, first_name="After", username="after",
    )
    token2 = second["session_token"]

    me = await client.get("/api/v1/users/me", headers=auth_headers(token2))
    body = me.json()
    # Flag preserved from credentials...
    assert body["onboarding_completed"] is True
    # ...and the column field synced from the fresh Telegram payload.
    assert body["first_name"] == "After"


async def test_onboarding_completed_null_does_not_reset_flag(
    client: AsyncClient,
) -> None:
    """PATCH onboarding_completed=null is ignored, not written as null.

    Service drops None for JSONB-backed fields, so a once-true flag stays
    true rather than being overwritten with null (bool(None) -> False).
    """
    data = await login_user(client, telegram_id=89463, first_name="NullTest")
    token = data["session_token"]

    # Set it true first.
    await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"onboarding_completed": True},
    )

    # Now send null -- should be a no-op for the flag.
    resp = await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"onboarding_completed": None},
    )
    assert resp.status_code == 200
    assert resp.json()["onboarding_completed"] is True


# ---------------------------------------------------------------------------
# Master onboarding flag (E15) — same JSONB pattern as onboarding_completed
# ---------------------------------------------------------------------------


async def test_master_onboarding_completed_defaults_false_for_new_user(
    client: AsyncClient,
) -> None:
    """A freshly created user has master_onboarding_completed=False."""
    data = await login_user(client, telegram_id=89471, first_name="FreshM")
    token = data["session_token"]

    response = await client.get("/api/v1/users/me", headers=auth_headers(token))

    assert response.status_code == 200
    assert response.json()["master_onboarding_completed"] is False


async def test_master_onboarding_completed_persists_and_survives_relogin(
    client: AsyncClient,
) -> None:
    """PATCH master_onboarding_completed=true persists across re-login.

    Mirrors test_onboarding_completed_survives_relogin: the credentials merge
    in upsert_user_on_login must keep the master flag too. The user-side
    onboarding_completed stays independent (untouched -> False).
    """
    first = await login_user(client, telegram_id=89472, first_name="MDone")
    token1 = first["session_token"]

    patch_response = await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token1),
        json={"master_onboarding_completed": True},
    )
    assert patch_response.status_code == 200
    assert patch_response.json()["master_onboarding_completed"] is True

    # Re-login with the SAME telegram_id; the flag must survive the upsert.
    second = await login_user(client, telegram_id=89472, first_name="MDone")
    token2 = second["session_token"]

    me = await client.get("/api/v1/users/me", headers=auth_headers(token2))
    assert me.status_code == 200
    body = me.json()
    assert body["master_onboarding_completed"] is True
    # Independence: the user-side flag was never set and stays False.
    assert body["onboarding_completed"] is False


async def test_master_onboarding_completed_null_does_not_reset_flag(
    client: AsyncClient,
) -> None:
    """PATCH master_onboarding_completed=null is ignored, not written.

    Service drops None for JSONB-backed fields (same rule as
    onboarding_completed), so a once-true flag stays true.
    """
    data = await login_user(client, telegram_id=89473, first_name="MNull")
    token = data["session_token"]

    await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"master_onboarding_completed": True},
    )

    resp = await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"master_onboarding_completed": None},
    )
    assert resp.status_code == 200
    assert resp.json()["master_onboarding_completed"] is True


# ---------------------------------------------------------------------------
# Profile phone / bio (stored in credentials JSONB, surfaced as str | None)
# ---------------------------------------------------------------------------


async def test_phone_bio_default_none_for_new_user(client: AsyncClient) -> None:
    """A fresh user has phone=None and bio=None (keys absent)."""
    data = await login_user(client, telegram_id=89464, first_name="NoExtra")
    token = data["session_token"]

    response = await client.get("/api/v1/users/me", headers=auth_headers(token))

    assert response.status_code == 200
    body = response.json()
    assert body["phone"] is None
    assert body["bio"] is None


async def test_update_phone_and_bio(client: AsyncClient) -> None:
    """PATCH phone + bio is persisted and returned (schema-on-read)."""
    data = await login_user(client, telegram_id=89465, first_name="Filler")
    token = data["session_token"]

    response = await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"phone": "+7 (916) 123-45-67", "bio": "Yoga every morning"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["phone"] == "+7 (916) 123-45-67"
    assert body["bio"] == "Yoga every morning"

    # Persisted across a fresh GET.
    get_response = await client.get(
        "/api/v1/users/me",
        headers=auth_headers(token),
    )
    get_body = get_response.json()
    assert get_body["phone"] == "+7 (916) 123-45-67"
    assert get_body["bio"] == "Yoga every morning"


async def test_clear_phone_and_bio_with_empty_string(client: AsyncClient) -> None:
    """Empty string clears phone/bio (stored as ""), unlike name fields.

    Variant (b): "" is an allowed value meaning "cleared". null is NOT used
    to clear here (the service drops null for JSONB fields).
    """
    data = await login_user(client, telegram_id=89466, first_name="Clearer")
    token = data["session_token"]

    # Set first.
    await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"phone": "+1 555 0100", "bio": "Something"},
    )

    # Clear via empty string.
    response = await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"phone": "", "bio": ""},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["phone"] == ""
    assert body["bio"] == ""


async def test_phone_invalid_characters_rejected(client: AsyncClient) -> None:
    """Phone with letters → 422 (soft validation: only digits/space/+()-)."""
    data = await login_user(client, telegram_id=89467)
    token = data["session_token"]

    response = await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"phone": "call-me-maybe"},
    )

    assert response.status_code == 422


async def test_phone_too_few_digits_rejected(client: AsyncClient) -> None:
    """Phone with fewer than 5 digits → 422."""
    data = await login_user(client, telegram_id=89468)
    token = data["session_token"]

    response = await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"phone": "+1 23"},
    )

    assert response.status_code == 422


async def test_bio_too_long_rejected(client: AsyncClient) -> None:
    """bio exceeding max_length (2000) → 422."""
    data = await login_user(client, telegram_id=89469)
    token = data["session_token"]

    response = await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"bio": "x" * 2001},
    )

    assert response.status_code == 422


async def test_phone_survives_relogin(client: AsyncClient) -> None:
    """phone in credentials survives re-login (merge, like onboarding flag)."""
    first = await login_user(client, telegram_id=89470, first_name="Keeper")
    token1 = first["session_token"]
    await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token1),
        json={"phone": "+44 20 7946 0958"},
    )

    second = await login_user(client, telegram_id=89470, first_name="Keeper")
    token2 = second["session_token"]

    me = await client.get("/api/v1/users/me", headers=auth_headers(token2))
    assert me.status_code == 200
    assert me.json()["phone"] == "+44 20 7946 0958"


# ---------------------------------------------------------------------------
# DELETE /api/v1/users/me — MVP: resets onboarding (no data wipe, no deactivate)
# ---------------------------------------------------------------------------


async def test_delete_me_resets_onboarding(client: AsyncClient) -> None:
    """DELETE /me clears onboarding_completed so the user re-onboards.

    MVP semantics: account is NOT erased and NOT deactivated. After delete,
    onboarding_completed reads false again; is_active stays true; previously
    saved profile data (phone) is still present.
    """
    data = await login_user(client, telegram_id=89474, first_name="Deleter")
    token = data["session_token"]

    # Finish onboarding + set some data.
    await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"onboarding_completed": True, "phone": "+7 916 000 11 22"},
    )

    # Delete account (MVP reset).
    delete_response = await client.delete(
        "/api/v1/users/me",
        headers=auth_headers(token),
    )
    assert delete_response.status_code == 204

    # Onboarding reset, account still active, data still present.
    me = await client.get("/api/v1/users/me", headers=auth_headers(token))
    assert me.status_code == 200
    body = me.json()
    assert body["onboarding_completed"] is False
    assert body["is_active"] is True
    assert body["phone"] == "+7 916 000 11 22"


async def test_delete_me_no_auth(client: AsyncClient) -> None:
    """DELETE without token → 401."""
    response = await client.delete("/api/v1/users/me")
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# Notification preferences: RETIRED from this API (T-26)
# ---------------------------------------------------------------------------
#
# The four-key credentials["notifications"] store used to live here with five
# tests covering defaults / partial merge / accumulation / relogin. All five
# are gone with the store: it was write-only (nothing downstream ever read it,
# so a muted user was not muted) and the truth moved to the comms service,
# reached through GET/PUT /api/v1/notifications/prefs.
#
# credentials["master_notifications"] (nine master toggles + a schedule) went
# the same way in set 2, for a different reason: it was ORPHANED. The master
# screen moved to comms on 2026-08-07 and stopped writing it, while this API
# kept accepting and serving it. Its own suite (tests/test_master_notifications
# .py, 14 tests) went with it; the capability carrier those tests incidentally
# exercised is covered directly by tests/test_role_switch.py.
#
# What replaces both guards the RETIREMENT rather than the feature -- that the
# fields are really gone and that a stale cached client cannot resurrect them.


async def test_both_notification_blocks_are_gone_from_the_response(
    client: AsyncClient,
) -> None:
    """GET /users/me carries neither notification store any more."""
    data = await login_user(client, telegram_id=89475, first_name="Notif")
    token = data["session_token"]

    response = await client.get("/api/v1/users/me", headers=auth_headers(token))

    assert response.status_code == 200
    body = response.json()
    assert "notifications" not in body
    assert "master_notifications" not in body
    # But the capability carrier they were gated on is still doing its OTHER
    # job: role_switch is derived from it. A plain user derives {USER} alone,
    # so the block is None rather than missing -- proving the field still
    # computes rather than having been deleted along with the gate.
    assert "role_switch" in body
    assert body["role_switch"] is None


async def test_stale_client_patching_notifications_is_ignored(
    client: AsyncClient,
) -> None:
    """A cached old frontend can still PATCH either retired key -- harmlessly.

    UserUpdate does not set extra="forbid", so the fields are DROPPED rather
    than 422'd. That is deliberate for a Mini App whose bundle is cached on
    the device: the old screen degrades to a no-op. This test pins the
    behaviour so it cannot change by accident -- 200, nothing echoed back,
    and nothing written into the credentials sandbox.

    Both stores are sent in ONE request on purpose: a stale bundle predating
    T-26 entirely could carry either, and the master one is the likelier of
    the two to linger, since that screen's own writes stopped a week before
    the field did.
    """
    data = await login_user(client, telegram_id=89476, first_name="Stale")
    token = data["session_token"]

    response = await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={
            "notifications": {"push": False, "master_messages": False},
            "master_notifications": {
                "new_booking": False,
                "schedule": {"from": "09:00", "to": "21:00", "days": ["mon"]},
            },
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert "notifications" not in body
    assert "master_notifications" not in body

    # And neither landed in the store behind the API: a later read is
    # identical, with no resurrected block.
    me = await client.get("/api/v1/users/me", headers=auth_headers(token))
    assert me.status_code == 200
    assert "notifications" not in me.json()
    assert "master_notifications" not in me.json()


async def test_retired_key_does_not_disturb_the_rest_of_credentials(
    client: AsyncClient,
) -> None:
    """The dropped key must not cost the other credentials fields.

    Same PATCH carries a retired field and two live ones; the live ones are
    written normally. Guards the `updates` split in the service after the
    notifications branch was removed from it.
    """
    data = await login_user(client, telegram_id=89479, first_name="Coexist")
    token = data["session_token"]

    response = await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={
            "onboarding_completed": True,
            "phone": "+7 916 000 11 22",
            "notifications": {"push": False},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["onboarding_completed"] is True
    assert body["phone"] == "+7 916 000 11 22"
    assert "notifications" not in body


# ---------------------------------------------------------------------------
# PATCH /api/v1/users/me — email (E11, credentials JSONB, no column)
# ---------------------------------------------------------------------------
async def test_update_me_set_email(client: AsyncClient) -> None:
    """A valid email is stored and exposed on the response (E11)."""
    data = await login_user(client, telegram_id=89480, first_name="Mailer")
    token = data["session_token"]

    response = await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"email": "person@example.com"},
    )
    assert response.status_code == 200
    assert response.json()["email"] == "person@example.com"

    # Persists across a fresh GET.
    me = await client.get("/api/v1/users/me", headers=auth_headers(token))
    assert me.json()["email"] == "person@example.com"


async def test_update_me_email_default_none(client: AsyncClient) -> None:
    """A user who never set an email reports email=None."""
    data = await login_user(client, telegram_id=89481, first_name="NoMail")
    token = data["session_token"]
    me = await client.get("/api/v1/users/me", headers=auth_headers(token))
    body = me.json()
    assert "email" in body
    assert body["email"] is None


async def test_update_me_clear_email_with_empty_string(client: AsyncClient) -> None:
    """Sending "" clears the email (phone/bio semantics), null leaves untouched."""
    data = await login_user(client, telegram_id=89482, first_name="Clearer")
    token = data["session_token"]

    await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"email": "temp@example.com"},
    )
    cleared = await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"email": ""},
    )
    assert cleared.status_code == 200
    assert cleared.json()["email"] == ""


async def test_update_me_invalid_email_rejected(client: AsyncClient) -> None:
    """A malformed email is rejected with 422."""
    data = await login_user(client, telegram_id=89483, first_name="BadMail")
    token = data["session_token"]

    response = await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"email": "not-an-email"},
    )
    assert response.status_code == 422


async def test_update_me_email_coexists_with_phone_bio(client: AsyncClient) -> None:
    """email joins phone/bio in credentials without clobbering them."""
    data = await login_user(client, telegram_id=89484, first_name="Combo")
    token = data["session_token"]

    await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"phone": "+7 916 000 11 22", "bio": "hi", "email": "combo@example.com"},
    )
    me = await client.get("/api/v1/users/me", headers=auth_headers(token))
    body = me.json()
    assert body["phone"] == "+7 916 000 11 22"
    assert body["bio"] == "hi"
    assert body["email"] == "combo@example.com"
