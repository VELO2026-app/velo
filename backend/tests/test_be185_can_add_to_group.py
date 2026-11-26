# =============================================================================
# VELO Backend -- Tests: can_add_to_group on the student dossier (BE-185)
# =============================================================================
#
# telegram_id band: 71450-71499.
#
# BAND PROVENANCE. 71400-72769 is one free window of free_windows() over the
# allowed space (tests/telegram_id_bands.py); 71400-71449 belongs to
# test_be228_reviews_period.py, this file takes the next fifty.
#
# WHAT IS UNDER TEST. GET /masters/me/students/{id} answers whether the master
# may put this person into one of his groups. The dossier opens on the wider
# INTERNAL link (BE-46 FIX: a booking, a waitlist entry, a group, a
# conversation, a lawful block of his own), while POST
# /masters/me/groups/{id}/members demands the strict GRANT_ACCESS link
# (booking, waitlist entry, group). A contact reached only through a chat or
# a block therefore gets a 404 from the POST that the screen could not
# predict. `can_add_to_group` is that prediction.
#
# THE INVARIANT, tested for every kind of link the dossier opens on:
#
#     can_add_to_group is false  <=>  the POST answers 404 for this pair
#
# Both halves are asserted on the SAME data in one test, so the field cannot
# agree with the gate on the rows of one kind and drift on another. The
# dossier's own refusals (a stranger, an id nobody owns) are unchanged and pinned
# once, side by side.
#
# What is NOT here: the link rule itself (test_be46_master_link.py owns it,
# per source and per action) and a blocked person who still holds a booking.
# For that person the strict link stands, so the field is true and the POST
# would succeed -- whether a block should close the group door is a product
# question of its own, not something this field decides.
# =============================================================================

from collections.abc import AsyncGenerator, Awaitable, Callable
from uuid import uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from tests.helpers import auth_headers, full_cleanup_range
from tests.test_be46_master_link import (
    GROUPS_URL,
    STUDENTS_URL,
    _booking,
    _id,
    _master,
    _membership,
    _new_group,
    _person,
    _thread,
    _waitlist,
)

_TID_MIN = 71450
_TID_MAX = 71499

_MASTER_TID = 71450
_PERSON_TID = 71451

Setup = Callable[[AsyncClient, AsyncSession, dict, dict], Awaitable[None]]


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """Clean all test data for this band before/after each test (ORM only)."""
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ===================================================================
# One setup per kind of link the dossier opens on
# ===================================================================


async def _with_booking(client, db_session, master, person) -> None:
    # CANCELLED on purpose: the weakest status that still links.
    await _booking(db_session, _id(master), _id(person))


async def _with_waitlist_entry(client, db_session, master, person) -> None:
    await _waitlist(db_session, _id(master), _id(person))


async def _with_group_membership(client, db_session, master, person) -> None:
    await _membership(db_session, _id(master), _id(person))


async def _with_conversation_only(client, db_session, master, person) -> None:
    await _thread(db_session, client_id=_id(person), operator_id=_id(master))


async def _with_lawful_block_only(client, db_session, master, person) -> None:
    """Group membership is the only link, and the block deletes it.

    What stays is the block marked blocked_with_link: the dossier still opens
    (INTERNAL), the strict link is gone (GRANT_ACCESS).
    """
    await _membership(db_session, _id(master), _id(person))
    blocked = await client.post(
        f"{STUDENTS_URL}/{_id(person)}/block",
        headers=auth_headers(master["session_token"]),
    )
    assert blocked.status_code == 200, blocked.text


_LINKS: list[tuple[str, Setup, bool]] = [
    ("booking", _with_booking, True),
    ("waitlist entry", _with_waitlist_entry, True),
    ("group membership", _with_group_membership, True),
    ("conversation only", _with_conversation_only, False),
    ("lawful block only", _with_lawful_block_only, False),
]


@pytest.mark.parametrize(
    ("setup", "expected"),
    [pytest.param(setup, expected, id=name) for name, setup, expected in _LINKS],
)
async def test_the_field_is_false_exactly_when_the_post_answers_404(
    client: AsyncClient,
    db_session: AsyncSession,
    setup: Setup,
    expected: bool,
) -> None:
    master = await _master(client, db_session, _MASTER_TID)
    person = await _person(client, _PERSON_TID)
    await setup(client, db_session, master, person)
    headers = auth_headers(master["session_token"])
    group_id = await _new_group(client, headers, "BE-185 group")

    dossier = await client.get(f"{STUDENTS_URL}/{_id(person)}", headers=headers)
    added = await client.post(
        f"{GROUPS_URL}/{group_id}/members",
        json={"student_user_id": person["user"]["id"]},
        headers=headers,
    )

    assert dossier.status_code == 200, dossier.text
    assert dossier.json()["can_add_to_group"] is expected
    assert added.status_code == (204 if expected else 404), added.text


# ===================================================================
# The dossier's own refusals are unchanged
# ===================================================================


async def test_a_stranger_and_a_missing_id_still_get_the_same_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """No link at all: no dossier, so no field to learn anything from.

    Paired with a linked person on the same door, who is let through.
    """
    master = await _master(client, db_session, _MASTER_TID)
    stranger = await _person(client, _PERSON_TID)
    linked = await _person(client, _PERSON_TID + 1)
    await _booking(db_session, _id(master), _id(linked))
    headers = auth_headers(master["session_token"])

    unlinked = await client.get(f"{STUDENTS_URL}/{_id(stranger)}", headers=headers)
    missing = await client.get(f"{STUDENTS_URL}/{uuid4()}", headers=headers)
    allowed = await client.get(f"{STUDENTS_URL}/{_id(linked)}", headers=headers)

    assert unlinked.status_code == missing.status_code == 404
    assert unlinked.content == missing.content
    assert allowed.status_code == 200
