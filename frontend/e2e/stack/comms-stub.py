#!/usr/bin/env python3
# =============================================================================
# VELO -- LOCAL DEV / E2E ONLY: mini-stub of the comms service (chats + inbox/prefs)
# =============================================================================
# FE-161: moved into the repo from the owner's ~/work/velo-dev so the e2e
# stack (frontend/e2e/, CI job e2e-stack) starts the same stub. It runs on the
# backend's own interpreter: FastAPI + uvicorn come with the backend install,
# nothing else is needed.
#
# WHY THIS EXISTS: local dev has no comms stack (backend/app/core/config.py:
# "an EMPTY url makes the proxy answer 502 -- local dev has no comms stack").
# This stub implements the exact slice of the comms HTTP contract that velo's
# two proxies call, so the whole chat flow -- "Ask the master" on the booking
# screen, the messages screens, unread badges -- works on a laptop.
#
# RUN (the backend venv already carries FastAPI + uvicorn):
#   backend/.venv/bin/python frontend/e2e/stack/comms-stub.py
#   backend/.venv/bin/python frontend/e2e/stack/comms-stub.py --port 8900
# Token: --token or env COMMS_SERVICE_TOKEN; default "velo-dev-comms-stub".
#
# NORMALLY STARTED BY velo-dev-up.sh, which also wires backend/.env
# (then restarts uvicorn -- it reads .env only at startup):
#   COMMS_API_URL=http://127.0.0.1:8899
#   COMMS_SERVICE_TOKEN=velo-dev-comms-stub
#
# CONTRACT, read from the callers (single source of truth -- if a call site
# changes, change the stub with it):
#   - backend/app/core/comms.py                  auth header + error mapping
#   - backend/app/modules/chats/router.py        every /api/v1/threads* call
#   - backend/app/modules/support/router.py      /api/v1/sections + section
#                                                 threads + claim (support
#                                                 proxy, B34/№712/№713)
#   - backend/app/modules/comms_proxy/router.py  /api/v1/recipients/* calls
#   - frontend/src/api/chats.ts, support.ts, notifications.ts  wire shapes
#
# STATE: in-memory, deliberately. A restart loses threads/messages and that
# is FINE by design: velo keys its local ChatThread pointer on the
# (client, operator) PAIR and re-points it when comms answers a new thread
# id (chats/router.py, _create_or_get_thread "chat_thread_repointed") -- the
# next create-or-get heals itself. Messages are lost, threads are not.
#
# NOT MODELED (honest stub, no fake behavior):
#   - identity sync: real comms 404s an unsynced recipient; the stub accepts
#     any uuid (COMMS_REDIS_URL stays empty, the outbox relay is off).
#   - telegram delivery: nothing is ever sent anywhere.
#   - inbox EVENTS: the relay is off, so no real event ever lands here; the
#     inbox is servable state only -- POST /__seed fills it by hand for FE-11
#     feed work (dev eyes only; the product seed still never fakes unread).
#
# DEBUG: GET /__state (same bearer token) dumps every thread + message.
# =============================================================================

import argparse
import itertools
import os
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from pydantic import BaseModel

DEFAULT_TOKEN = "velo-dev-comms-stub"

# Preference categories the velo profile declares (comms-profile/types.yaml,
# category grid §3) -- the prefs facade emits one boolean per declared key.
_PROFILE_CATEGORIES = (
    "bookings", "reminders", "finance", "msg_participants", "msg_support",
)


def _now() -> str:
    return datetime.now(UTC).isoformat()


# -- in-memory state ----------------------------------------------------------

_threads: dict[str, dict[str, Any]] = {}   # thread id -> row
_pairs: dict[tuple[str, str], str] = {}    # (client, operator_value) -> thread id
_sections: dict[str, dict[str, Any]] = {}  # section key -> row (support proxy)
_msgs: dict[str, list[dict[str, Any]]] = {}  # thread id -> chronological messages
_read_seq: dict[tuple[str, str], int] = {}   # (thread id, participant) -> last read seq
_prefs: dict[str, dict[str, Any]] = {}       # recipient id -> prefs doc

# Bell inbox: user id -> items, NEWEST FIRST. Populated ONLY by POST /__seed
# (the outbox relay is off locally, real events never arrive); read marks are
# kept here so the whole feed UX -- unread dots, "Read all", per-row read
# -- is drivable on a laptop.
_inbox: dict[str, list[dict[str, Any]]] = {}

_msg_id = itertools.count(1)  # readable ids in a dev log
_delivery_id = itertools.count(1)

# -- app + auth ---------------------------------------------------------------


def _auth(request: Request) -> None:
    token = os.environ.get("COMMS_SERVICE_TOKEN", DEFAULT_TOKEN)
    if request.headers.get("authorization") != f"Bearer {token}":
        # velo maps 401 -> 502 with a comms_auth_error log line: a wrong
        # token is loud and diagnosable, never "session expired".
        raise HTTPException(status_code=401, detail="invalid service token")


app = FastAPI(
    title="velo local comms stub",
    version="dev",
    # Every route below is server-to-server; comms' own deps.py checks the
    # shared service token, and so does this (core/comms.py sends it).
    dependencies=[Depends(_auth)],
)

# -- helpers -------------------------------------------------------------------


def _thread_row(tid: str) -> dict[str, Any]:
    return dict(_threads[tid])


def _unread_for(tid: str, participant: str) -> int:
    """Messages from the OTHER side past the participant's read pointer."""
    read = _read_seq.get((tid, participant), -1)
    return sum(
        1 for m in _msgs.get(tid, ()) if m["seq"] > read and m["sender"] != participant
    )


def _is_participant(tid: str, uid: str) -> bool:
    t = _threads.get(tid)
    return t is not None and uid in (t["client"], t["operator_value"])


def _get_thread_or_404(tid: str) -> dict[str, Any]:
    t = _threads.get(tid)
    if t is None:
        # 404 is forwardable by velo's boundary (frozen 3b contract).
        raise HTTPException(status_code=404, detail="thread not found")
    return t


# -- sections (support proxy, support/service.py::get_support_section_id) ------


class SectionIn(BaseModel):
    key: str
    label: str


@app.post("/api/v1/sections")
def create_or_get_section(body: SectionIn) -> dict[str, Any]:
    """create-or-get by key; a repeat POST returns the SAME row, not an error.

    The id is stable for the life of the process; velo caches it in-process
    and re-asks after any restart, so a fresh uuid on a stub restart heals
    itself, same as the thread pointers.
    """
    row = _sections.get(body.key)
    if row is not None:
        return {**row, "created": False}
    row = {
        "id": str(uuid.uuid4()),
        "key": body.key,
        "label": body.label,
        "created_at": _now(),
    }
    _sections[body.key] = row
    return {**row, "created": True}


# -- threads (chat proxy, seam ID-9/ID-10; section form: support proxy) --------


class ThreadCreate(BaseModel):
    client: str
    operator_kind: str
    operator_value: str
    kind: str
    # Support-only (open_support_thread): the topic picker's value, stored
    # once on the INSERT path -- a dedup hit returns the existing row
    # untouched, exactly like comms' create_or_get_thread_detailed.
    title: str | None = None


_ticket_keys: dict[str, str] = {}


@app.post("/api/v1/threads")
def create_or_get_thread(
    body: ThreadCreate,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict[str, Any]:
    """create-or-get the eternal DM -- user form (chats/router.py
    _create_or_get_thread) or section form (support/service.py
    open_support_thread). kind is always "dm"; anything else is a caller
    bug and gets the modeled 400 the boundary would forward.

    Dedup key is (client, operator_value) for both forms: a section id is
    as stable as a master's user id, and the two never collide (one is a
    users.id, the other a section uuid).
    """
    # FE-161: support/service.py open_support_thread now opens one thread
    # per TICKET (kind "ticket", section form), deduplicated by the
    # Idempotency-Key header, not by the (client, section) pair.
    is_ticket = body.kind == "ticket" and body.operator_kind == "section"
    if body.operator_kind not in ("user", "section") or (body.kind != "dm" and not is_ticket):
        raise HTTPException(status_code=400, detail="stub: only user/section dm threads and section tickets")

    pair = (body.client, body.operator_value)
    if is_ticket:
        if idempotency_key and idempotency_key in _ticket_keys:
            return {**_thread_row(_ticket_keys[idempotency_key]), "created": False}
    else:
        existing = _pairs.get(pair)
        if existing is not None:
            return {**_thread_row(existing), "created": False}

    tid = str(uuid.uuid4())
    now = _now()
    _threads[tid] = {
        "id": tid,
        "kind": body.kind,
        "status": "open",
        "client": body.client,
        "operator_kind": body.operator_kind,
        "operator_value": body.operator_value,
        # comms' DM row (SupportThread, api/support.ts): the user form
        # prefills the master as assignee; a section thread starts
        # UNCLAIMED -- claiming is what grants the right to reply.
        "assignee": body.operator_value if body.operator_kind == "user" else None,
        "title": body.title,
        "subject_type": None,
        "subject_id": None,
        "priority": None,
        "created_at": now,
        "last_message_at": now,
    }
    if is_ticket:
        if idempotency_key:
            _ticket_keys[idempotency_key] = tid
    else:
        _pairs[pair] = tid
    _msgs[tid] = []
    return {**_thread_row(tid), "created": True}


def _last_message_row(tid: str) -> dict[str, Any] | None:
    """The newest message of a thread, as the list preview shows it
    (BE-163 `with_last_message`): four fields plus a null `translation` --
    translation between people never happens in comms; velo's support
    proxy overlays its own states."""
    msgs = _msgs.get(tid) or []
    if not msgs:
        return None
    m = msgs[-1]
    return {
        "id": m["id"],
        "sender": m["sender"],
        "created_at": m["created_at"],
        "body": m["body"],
        "translation": None,
    }


@app.get("/api/v1/threads")
def list_threads(
    operator: str | None = None,
    client: str | None = None,
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str | None = None,
    with_unread: bool = False,
    with_last_message: bool = False,
    locale: str | None = None,
    is_supervisor: bool = False,
) -> dict[str, Any]:
    """Operator-scoped list (chats/router.py list_chats, MASTER branch), the
    CLIENT list (BE-163: `?client=` -- the caller's own DMs and support
    thread, last-active first), or the supervisor branch (support/service.py
    list_admin_support_threads).

    is_supervisor=True drops the scope entirely -- comms skips its own
    filter there and velo narrows the page client-side (section-vs-DM split
    happens on the fetched page, never widening the cursor).
    Activity order (last_message_at desc), opaque offset cursor -- the real
    comms cursor is keyset, but velo treats it as opaque.
    Response shape: comms 3.0.0 paging `{"items": [...], "next_cursor"}`
    (read_comms_page refuses anything else).
    """
    if is_supervisor:
        scope = _threads.values()
    elif client is not None:
        scope = (t for t in _threads.values() if t["client"] == client)
    elif operator is not None:
        scope = (t for t in _threads.values() if t["operator_value"] == operator)
    else:
        raise HTTPException(status_code=422, detail="stub: operator or client required")
    rows = sorted(scope, key=lambda t: t["last_message_at"], reverse=True)
    offset = int(cursor) if cursor else 0
    page = rows[offset : offset + limit]
    next_cursor = str(offset + limit) if offset + limit < len(rows) else None

    out = []
    for t in page:
        row = _thread_row(t["id"])
        if with_unread:
            # Present for the operator (always a participant of their own
            # threads) -- velo attaches it verbatim to the row (T-51).
            row["unread"] = _unread_for(t["id"], operator or client or "")
        if with_last_message:
            row["last_message"] = _last_message_row(t["id"])
        out.append(row)
    return {"items": out, "next_cursor": next_cursor}

class UnreadCountsIn(BaseModel):
    participant: str
    thread_ids: list[str]


@app.post("/api/v1/threads/unread-counts")
def unread_counts(body: UnreadCountsIn) -> dict[str, Any]:
    """Batch badge (chats/router.py _unread_by_thread, T-51).

    ABSENCE IS AN ANSWER: a thread the participant takes no part in is
    OMITTED, never zeroed -- velo attaches the key only where comms did.
    """
    counts: dict[str, int] = {}
    for tid in body.thread_ids:
        if _is_participant(tid, body.participant):
            counts[tid] = _unread_for(tid, body.participant)
    return {"counts": counts}


@app.get("/api/v1/threads/{thread_id}/messages")
def list_messages(
    thread_id: str,
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str | None = None,
) -> dict[str, Any]:
    """Newest-first page (comms feed contract). Envelope: comms 3.0.0
    paging `{"items": [...], "next_cursor"}` -- BE-163's feed reader
    (read_comms_page) refuses the legacy `messages` key with a 502.
    Each row carries `translation: null`: nothing is translated between
    people in comms; the support proxy overlays its own states."""
    _get_thread_or_404(thread_id)
    msgs = _msgs[thread_id]
    # cursor = "give me messages OLDER than this seq" (keyset-style).
    eligible = [m for m in msgs if cursor is None or m["seq"] < int(cursor)]
    page = eligible[-limit:]
    out = [
        {**{k: v for k, v in m.items() if k != "seq"}, "translation": None}
        for m in reversed(page)
    ]
    next_cursor = str(page[0]["seq"]) if len(eligible) > len(page) else None
    return {"items": out, "next_cursor": next_cursor}


class MessageIn(BaseModel):
    sender: str
    body: str


def _notify_new_message(thread: dict[str, Any], msg: dict[str, Any]) -> None:
    """Mirror comms' notify_new_message (app/api/messaging.py:295): a message
    ALWAYS pings the other side in the same call -- never a message without a
    ping. Receiver-side types per the engine: the client gets
    msg.participant_message, the operator (the DM's prefilled assignee) gets
    msg.support_message. action_data carries the FE-12 deep link
    (open_thread + thread_id) UserInboxView routes on, so the notification
    and the message it names are always a pair. insert(0) keeps the inbox
    newest-first: the GET serves the list as-is (no re-sort)."""
    for uid, ntype in (
        (thread["client"], "msg.participant_message"),
        (thread["assignee"], "msg.support_message"),
    ):
        # assignee is None for an unclaimed section thread: nobody but the
        # client gets pinged until someone claims it. For the user form the
        # assignee IS the operator (prefilled), so DM behavior is unchanged.
        if uid is None or uid == msg["sender"]:
            continue
        row = {
            "id": str(uuid.uuid4()),
            "type": ntype,
            "title": "New message",
            "body": msg["body"][:100],
            "action_data": {
                "action": "open_thread",
                "params": {"thread_id": thread["id"]},
            },
            "priority": 5,
            "sent_at": msg["created_at"],
            "read_at": None,
            "created_at": msg["created_at"],
        }
        _inbox.setdefault(uid, []).insert(0, row)


@app.post("/api/v1/threads/{thread_id}/messages")
def post_message(thread_id: str, body: MessageIn) -> dict[str, Any]:
    """Send (chats post_message / support send_support_message and
    send_admin_support_message).

    can_post_message parity (comms messaging/operators.py): the thread's
    CLIENT or its ASSIGNEE, no supervisor bypass -- an admin's reply into
    an unclaimed section thread 403s here, and velo forwards that verbatim
    (forward_403=True) as the claim-first cue.
    """
    thread = _get_thread_or_404(thread_id)
    if body.sender not in (thread["client"], thread["assignee"]):
        raise HTTPException(
            status_code=403,
            detail="only the thread's client or assignee may post",
        )
    now = _now()
    msg = {
        # BE-163: velo parses a comms message id AS A UUID (support proxy)
        # -- the readable m<N>-hex ids predate that and 500 the send.
        "id": str(uuid.uuid4()),
        "seq": len(_msgs[thread_id]),
        "thread_id": thread_id,
        "sender": body.sender,
        "body": body.body,
        "created_at": now,
    }
    _msgs[thread_id].append(msg)
    _threads[thread_id]["last_message_at"] = now
    _notify_new_message(_threads[thread_id], msg)
    return {k: v for k, v in msg.items() if k != "seq"}


class ReadIn(BaseModel):
    participant: str


@app.post("/api/v1/threads/{thread_id}/read")
def mark_read(thread_id: str, body: ReadIn) -> dict[str, int]:
    """Advance the caller's read pointer (idempotent)."""
    _get_thread_or_404(thread_id)
    _read_seq[(thread_id, body.participant)] = len(_msgs[thread_id]) - 1
    return {"unread": _unread_for(thread_id, body.participant)}


class ClaimIn(BaseModel):
    operator: str


@app.post("/api/v1/threads/{thread_id}/claim")
def claim_thread(thread_id: str, body: ClaimIn) -> dict[str, Any]:
    """Claim (support/service.py claim_admin_support_thread). The first
    claimer wins; {claimed: False} is a NORMAL answer (someone else won the
    race, or it was already claimed), never an error.
    """
    thread = _get_thread_or_404(thread_id)
    if thread["assignee"] is None:
        thread["assignee"] = body.operator
        claimed = True
    else:
        claimed = False
    return {"claimed": claimed, "thread": _thread_row(thread_id)}


@app.get("/api/v1/threads/{thread_id}/unread-count")
def thread_unread_count(thread_id: str, participant: str) -> dict[str, int]:
    _get_thread_or_404(thread_id)
    return {"unread": _unread_for(thread_id, participant)}


@app.get("/api/v1/participants/{user_id}/unread-summary")
def unread_summary(user_id: str) -> dict[str, Any]:
    """'My unread, in whatever role I hold' (chats/router.py, T-51/B52)."""
    mine = [
        _unread_for(tid, user_id)
        for tid, t in _threads.items()
        if user_id in (t["client"], t["operator_value"])
    ]
    total = sum(mine)
    return {
        "has_unread": total > 0,
        "threads_with_unread": sum(1 for n in mine if n > 0),
        "unread_messages": total,
    }

# -- recipients: inbox + prefs (notifications proxy) ---------------------------


def _inbox_unread(user_id: str) -> int:
    return sum(1 for i in _inbox.get(user_id, ()) if i["read_at"] is None)


def _inbox_shape(user_id: str, items: list[dict[str, Any]]) -> dict[str, Any]:
    return {"items": [dict(i) for i in items], "next_cursor": None, "unread": _inbox_unread(user_id)}


@app.get("/api/v1/recipients/{user_id}/inbox")
def inbox(
    user_id: str,
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str | None = None,
) -> dict[str, Any]:
    """Seeded bell feed (frozen 3b shape: {items, next_cursor, unread}).

    Newest first; cursor accepted-and-ignored (one dev page is enough).
    """
    return _inbox_shape(user_id, _inbox.get(user_id, [])[:limit])


@app.get("/api/v1/recipients/{user_id}/inbox/unread-count")
def inbox_unread(user_id: str) -> dict[str, int]:
    return {"unread": _inbox_unread(user_id)}


@app.post("/api/v1/recipients/{user_id}/inbox/read-all")
def inbox_read_all(user_id: str) -> dict[str, int]:
    now = _now()
    for i in _inbox.get(user_id, ()):
        if i["read_at"] is None:
            i["read_at"] = now
    return {"unread": _inbox_unread(user_id)}


@app.post("/api/v1/recipients/{user_id}/inbox/{delivery_id}/read")
def inbox_read_one(user_id: str, delivery_id: str) -> dict[str, int]:
    # Unknown id -> the modeled 404 velo's proxy docstring promises ("no such
    # delivery / not this recipient's delivery").
    for i in _inbox.get(user_id, ()):
        if i["id"] == delivery_id:
            if i["read_at"] is None:
                i["read_at"] = _now()
            return {"unread": _inbox_unread(user_id)}
    raise HTTPException(status_code=404, detail="delivery not found")


class SeedItem(BaseModel):
    type: str
    title: str
    body: str
    action_data: dict[str, Any] | None = None
    read: bool = False
    minutes_ago: int = 0


class SeedRequest(BaseModel):
    recipient: str
    items: list[SeedItem]
    replace: bool = True


@app.post("/__seed")
def seed_inbox(body: SeedRequest) -> dict[str, Any]:
    """DEV ONLY: hand-fill the bell feed (FE-11 eyes; see _inbox above)."""
    if body.replace:
        _inbox.pop(body.recipient, None)
    now = datetime.now(UTC)
    rows = []
    for it in body.items:
        sent = (now - timedelta(minutes=it.minutes_ago)).isoformat()
        rows.append(
            {
                # MUST be a UUID: velo's proxy types delivery_id as UUID and
                # 422s anything else before comms ever sees it.
                "id": str(uuid.uuid4()),
                "type": it.type,
                "title": it.title,
                "body": it.body,
                "action_data": it.action_data,
                "priority": 5,
                "sent_at": sent,
                "read_at": sent if it.read else None,
                "created_at": sent,
            }
        )
    stored = _inbox.setdefault(body.recipient, []) if not body.replace else []
    stored[:0] = rows
    _inbox[body.recipient] = sorted(stored, key=lambda i: i["sent_at"], reverse=True)
    return _inbox_shape(body.recipient, _inbox[body.recipient][:20])


def _default_prefs() -> dict[str, Any]:
    return {
        "categories": {c: True for c in _PROFILE_CATEGORIES},
        "schedule": None,
        "timezone": "UTC",
    }


@app.get("/api/v1/recipients/{user_id}/preferences")
def get_prefs(user_id: str) -> dict[str, Any]:
    """comms-side QUIET-window semantics; velo's proxy owns the inversion."""
    return _prefs.get(user_id) or _default_prefs()


@app.patch("/api/v1/recipients/{user_id}/preferences")
def patch_prefs(user_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    doc = _prefs.setdefault(user_id, _default_prefs())
    if isinstance(patch.get("categories"), dict):
        doc["categories"] = patch["categories"]
    if "schedule" in patch:
        doc["schedule"] = patch["schedule"]
    return doc


# -- debug ---------------------------------------------------------------------


@app.get("/__state")
def state() -> dict[str, Any]:
    return {
        "sections": {k: dict(v) for k, v in _sections.items()},
        "threads": [_thread_row(t["id"]) for t in _threads.values()],
        "messages": {
            tid: [{k: v for k, v in m.items() if k != "seq"} for m in msgs]
            for tid, msgs in _msgs.items()
        },
        "read_pointers": {f"{tid}|{uid}": seq for (tid, uid), seq in _read_seq.items()},
        "prefs": _prefs,
        "inbox": {uid: [dict(i) for i in items] for uid, items in _inbox.items()},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="local comms stub (dev only)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8899)
    parser.add_argument(
        "--token",
        default=None,
        help="service token (default: env COMMS_SERVICE_TOKEN or velo-dev-comms-stub)",
    )
    args = parser.parse_args()
    if args.token:
        os.environ["COMMS_SERVICE_TOKEN"] = args.token
    token = os.environ.get("COMMS_SERVICE_TOKEN", DEFAULT_TOKEN)
    print(f"[comms-stub] http://{args.host}:{args.port}  token={token}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()



