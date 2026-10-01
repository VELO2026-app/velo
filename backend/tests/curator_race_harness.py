# =============================================================================
# VELO -- a race harness that can build a deadlock (BE-95)
# =============================================================================
# The races in curator_groups are asymmetric, so asyncio.gather of two
# requests is green before a fix and after it (BE-42, measured). The first
# answer to that -- run the competitor INSIDE a wrap of the holder and wait
# for it to finish under lock_timeout -- could prove a data invariant but
# could never build a deadlock: the two transactions were never waiting on
# each other at the same time, because the holder was suspended in Python
# while the competitor ran to completion or timed out. Its "< 500"
# assertion was held up by the harness, not by the code.
#
# THIS HARNESS PUTS BOTH IN FLIGHT AT ONCE:
#
#   1. the HOLDER starts and is paused at a named point inside its window,
#      by WRAPPING a real function it calls there -- the real function
#      still runs and still decides, only the timing is added;
#   2. the RIVAL starts and runs until Postgres reports it waiting on a
#      lock, or until it finishes -- whichever comes first, observed in
#      pg_stat_activity rather than guessed with a sleep;
#   3. the holder is released. If the two orders are inverted, the holder
#      now asks for what the rival holds while the rival waits for the
#      holder: a real deadlock, detected by Postgres after deadlock_timeout.
#
# Each call runs in its own session with the same shape as get_db_session
# -- commit on success, roll back on an exception (P-01) -- because several
# of the writers under test depend on exactly that rollback.
#
# COST: a green run waits for nothing -- the rival is released by the
# holder's commit. Only a RED run (a deadlock) waits deadlock_timeout,
# Postgres' default 1 s.
# =============================================================================

import asyncio
import contextvars
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session_factory

Call = Callable[[AsyncSession], Awaitable[object]]

_ROLE: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "curator_race_role", default=None,
)

# Guards against a hang, not part of the measurement: a regression that
# waits forever fails here instead of stalling the suite.
_STATEMENT_TIMEOUT = "10s"
_SEE_TIMEOUT = 10.0
_POLL = 0.01


@dataclass
class Outcome:
    """What one side ended with: committed, or the exception it raised."""

    committed: bool = False
    error: BaseException | None = None
    result: object = None

    @property
    def deadlocked(self) -> bool:
        return self.error is not None and "deadlock detected" in str(
            self.error
        )


@dataclass
class Race:
    holder: Outcome
    rival: Outcome
    # True when the rival was seen waiting on a lock while the holder
    # stood in its window -- i.e. the two really were in conflict, and a
    # green result is not the product of two calls that never met.
    rival_waited: bool
    pids: dict[str, int] = field(default_factory=dict)


async def _run(role: str, call: Call, pids: dict[str, int]) -> Outcome:
    _ROLE.set(role)
    outcome = Outcome()
    factory = get_session_factory()
    async with factory() as session:
        try:
            await session.execute(
                text(f"SET LOCAL statement_timeout = '{_STATEMENT_TIMEOUT}'")
            )
            pids[role] = (
                await session.execute(text("SELECT pg_backend_pid()"))
            ).scalar_one()
            outcome.result = await call(session)
            await session.commit()
            outcome.committed = True
        except Exception as exc:  # the outcome IS the subject
            await session.rollback()
            outcome.error = exc
    return outcome


async def _waiting_on_lock(pid: int) -> bool:
    factory = get_session_factory()
    async with factory() as probe:
        state = (
            await probe.execute(
                text(
                    "SELECT wait_event_type FROM pg_stat_activity "
                    "WHERE pid = :pid"
                ),
                {"pid": pid},
            )
        ).scalar_one_or_none()
        await probe.rollback()
    return state == "Lock"


async def race(
    monkeypatch: pytest.MonkeyPatch,
    *,
    holder: Call,
    pause_in: tuple[object, str],
    rival: Call,
    pause: str = "before",
) -> Race:
    """Run `holder` paused at `pause_in`, `rival` into it, then release.

    pause_in is (module, attribute) of an async function the holder calls
    inside its window. pause="before" stops the holder before that call,
    "after" once it has returned. The pause applies to the holder only;
    the rival calls the same function unhindered.

    A holder that never reaches the pause point FAILS the race rather than
    passing it: a test about a window proves nothing if the window was
    never entered.
    """
    module, name = pause_in
    real = getattr(module, name)
    arrived = asyncio.Event()
    release = asyncio.Event()
    paused_once = {"done": False}

    async def _wrapped(*args, **kwargs):
        if _ROLE.get() != "holder" or paused_once["done"]:
            return await real(*args, **kwargs)
        paused_once["done"] = True
        if pause == "after":
            result = await real(*args, **kwargs)
            arrived.set()
            await release.wait()
            return result
        arrived.set()
        await release.wait()
        return await real(*args, **kwargs)

    monkeypatch.setattr(module, name, _wrapped)
    pids: dict[str, int] = {}

    holder_task = asyncio.create_task(_run("holder", holder, pids))
    arrival = asyncio.create_task(arrived.wait())
    await asyncio.wait(
        {holder_task, arrival},
        timeout=_SEE_TIMEOUT,
        return_when=asyncio.FIRST_COMPLETED,
    )
    if not arrived.is_set():
        arrival.cancel()
        release.set()
        outcome = await holder_task
        pytest.fail(
            f"the holder never reached {name} -- it ended with "
            f"{outcome.error!r}; the window under test was never entered"
        )

    rival_task = asyncio.create_task(_run("rival", rival, pids))
    waited = False
    loop = asyncio.get_running_loop()
    deadline = loop.time() + _SEE_TIMEOUT
    while not rival_task.done():
        if "rival" in pids and await _waiting_on_lock(pids["rival"]):
            waited = True
            break
        if loop.time() > deadline:
            release.set()
            pytest.fail("the rival neither finished nor waited on a lock")
        await asyncio.sleep(_POLL)

    release.set()
    holder_outcome, rival_outcome = await asyncio.gather(
        holder_task, rival_task,
    )
    return Race(
        holder=holder_outcome,
        rival=rival_outcome,
        rival_waited=waited,
        pids=pids,
    )


def assert_no_deadlock(result: Race) -> None:
    """Neither side was the victim of a deadlock, nor failed unexpectedly."""
    for side in ("holder", "rival"):
        outcome = getattr(result, side)
        assert not outcome.deadlocked, f"{side} was a deadlock victim"
