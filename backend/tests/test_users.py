# =============================================================================
# Test: Users Module — Profile get/update endpoints
# =============================================================================

import pytest
from httpx import AsyncClient

from tests.helpers import auth_headers, login_user


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
# Notification preferences (credentials.notifications nested object)
# ---------------------------------------------------------------------------


async def test_notifications_default_all_true(client: AsyncClient) -> None:
    """A fresh user has all notification toggles on (defaults)."""
    data = await login_user(client, telegram_id=89475, first_name="Notif")
    token = data["session_token"]

    response = await client.get("/api/v1/users/me", headers=auth_headers(token))

    assert response.status_code == 200
    notifications = response.json()["notifications"]
    assert notifications == {
        "push": True,
        "practice_reminders": True,
        "master_messages": True,
        "support_messages": True,
    }


async def test_notifications_partial_update_keeps_others(
    client: AsyncClient,
) -> None:
    """Flipping one toggle off leaves the other three untouched.

    Regression guard for the nested-merge logic: a partial notifications
    payload must not wipe the flags the client did not send.
    """
    data = await login_user(client, telegram_id=89476, first_name="Partial")
    token = data["session_token"]

    response = await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"notifications": {"push": False}},
    )

    assert response.status_code == 200
    notifications = response.json()["notifications"]
    assert notifications["push"] is False
    # Others stay at their default (true).
    assert notifications["practice_reminders"] is True
    assert notifications["master_messages"] is True
    assert notifications["support_messages"] is True


async def test_notifications_sequential_updates_accumulate(
    client: AsyncClient,
) -> None:
    """Two partial updates accumulate instead of overwriting each other."""
    data = await login_user(client, telegram_id=89477, first_name="Accum")
    token = data["session_token"]

    await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"notifications": {"push": False}},
    )
    response = await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"notifications": {"master_messages": False}},
    )

    assert response.status_code == 200
    notifications = response.json()["notifications"]
    # Both flips persisted; the untouched two remain true.
    assert notifications["push"] is False
    assert notifications["master_messages"] is False
    assert notifications["practice_reminders"] is True
    assert notifications["support_messages"] is True


async def test_notifications_persist_and_survive_relogin(
    client: AsyncClient,
) -> None:
    """Notification prefs persist across GET and survive re-login (merge)."""
    first = await login_user(client, telegram_id=89478, first_name="Keeper")
    token1 = first["session_token"]
    await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token1),
        json={"notifications": {"support_messages": False, "push": False}},
    )

    # Re-login with the same telegram_id.
    second = await login_user(client, telegram_id=89478, first_name="Keeper")
    token2 = second["session_token"]

    me = await client.get("/api/v1/users/me", headers=auth_headers(token2))
    assert me.status_code == 200
    notifications = me.json()["notifications"]
    assert notifications["support_messages"] is False
    assert notifications["push"] is False
    assert notifications["practice_reminders"] is True
    assert notifications["master_messages"] is True


async def test_notifications_coexist_with_onboarding_and_phone(
    client: AsyncClient,
) -> None:
    """Setting notifications must not disturb other credentials keys."""
    data = await login_user(client, telegram_id=89479, first_name="Coexist")
    token = data["session_token"]

    # Set onboarding + phone first.
    await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"onboarding_completed": True, "phone": "+7 916 000 11 22"},
    )
    # Now flip a notification toggle.
    await client.patch(
        "/api/v1/users/me",
        headers=auth_headers(token),
        json={"notifications": {"push": False}},
    )

    me = await client.get("/api/v1/users/me", headers=auth_headers(token))
    body = me.json()
    # All three coexist.
    assert body["onboarding_completed"] is True
    assert body["phone"] == "+7 916 000 11 22"
    assert body["notifications"]["push"] is False
    assert body["notifications"]["practice_reminders"] is True


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
