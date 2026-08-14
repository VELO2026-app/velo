# Support: who may read, who may answer, who gets told — measured

> **Recon `№708`, 2026-08-14, read-only.** Raised because the owner refuted the premise under an
> earlier recommendation: it assumed support has "effectively one operator", and that was never
> measured. Answers below come from BOTH repos — `D:/02_Projects/comms` is read-only and IS the
> source on any dispute.
> ⚠ Nothing here has been exercised against a running system. Every line is READ, not RUN.
> ⚠ Re-derive any `file:line` before acting: this file ages the moment either side commits.
> The endpoint contract itself is in `support-sections-integration.md`; this file is about the
> operator model only.

## The question that produced it

Admin is a role and there can be several admins. If they all read and answer, why is a support
thread ASSIGNED to anyone at all?

## 1 · The admin role is flat and shared

`role` is one column on `User` (`UserRole.ADMIN`); there is no admin table and no per-admin
identity beyond that flag. `get_current_admin` checks only the flag, so **any admin passes every
admin endpoint identically**. `admin_id` appears in roughly fifteen places across
`admin/*/service.py` and on `Withdrawal.admin_id` — **every one is a post-hoc audit stamp, none
gates access.** Nowhere does the product check that the acting admin is the same admin who
touched a thing before.

Admin is granted by a CLI/DB action (`scripts/set_role.py to_admin`), repeatable, uncapped,
unseeded. **How many admins exist on any live database is UNMEASURABLE from the repository** — it
is operational history, not git history. Do not estimate it.

## 2 · An admin IS a comms recipient, and a live admin-broadcast already exists

`emit_user_upserted` fires on every login regardless of role, so an admin is a comms `Recipient`
like anyone else. Beyond that there is a real group: `GROUP_ADMINS = "admins"`, maintained by
`sync_membership_delta` on every role change, and comms resolves it live —
`master.application_received` broadcasts to it today, categoryless.

**That is proof rather than hypothesis: a pool broadcast to "every admin" already fires in
production, for a different notification type.**

## 3 · But support messages never touch that mechanism

`notify_new_message` targets exactly two hardcoded slots — the thread's CLIENT and the thread's
ASSIGNEE. Never a group, never a list. So **`msg_support` reaches an admin if and only if that
admin is the thread's assignee**, and with no assignee the guard never fires and nobody is
notified at all.

The group mechanism and the support-notification mechanism are two separate, unconnected code
paths.

## 4 · What `claim` does

A single conditional `UPDATE threads SET assignee = me WHERE id = ? AND assignee IS NULL`, read
by rowcount. **Exclusive** — under a race exactly one caller wins and the loser gets `False`, not
an error. **It cannot be re-claimed while assigned.**

**There is no unclaim verb.** The only route back to the pool is `retag_thread`, which resets
`assignee` and `assigned_at` as a side effect of moving the thread to a (possibly identical)
section — and which any operator identity may call on a section thread, because v1 section
membership is trivial: every agent serves every section.

## 5 · THE ANSWER, and it has three layers that must not be collapsed

**Listing** — `list_visible_threads` shows a non-supervisor only their own assigned threads plus
unassigned section threads. **`is_supervisor=true` drops that filter entirely and returns every
thread.** comms does not know who is a supervisor; it accepts the assertion from the product
proxy. **So "every admin sees every support thread" is already built on their side and is a
boolean we would set.**

**Reading one thread** — `get_thread_feed` has **no gate at all**: no assignee check, no
`can_read`. Their trust model states it plainly — comms does not verify the actor, the product
proxy is the sole owner of that check. **Reading a specific thread is not assignee-gated
anywhere; that gate is ours to build or not build.**

**Answering** — `can_post_message` admits only the thread's client or its assignee, **with no
supervisor bypass**, enforced inside comms' own handler. **Today a second admin who is not the
assignee cannot post to a claimed thread: comms itself returns 403.**

> **This is the sharpest finding and it inverts the shape of the question.** Assignment is not a
> convention our design chose in order to route notifications; **write access is enforced on it,
> by the other side.** Removing assignment as a CONCEPT needs a comms-side change to write
> authorization. Removing it merely as a notification detail does not, and leaves
> single-writer-per-thread exactly where it is.

## 6 · Attribution and client notification already generalise

`Message.sender` is an immutable RESTRICT-FK set once at creation, so a message permanently
carries its true author. The client is notified whenever the sender is not the client, with no
check on which operator sent it. **If write access were ever widened, neither attribution nor
client notification would need to change** — only the authorization itself.

## 7 · Pool push does not exist and is not a flag

comms' own comments defer it by design: blocked on having no materialized recipient list, and on
section membership not existing in v1. They name their own promotion trigger — section operators
gaining a real consumer AND section membership arriving together — and the agreed fix shape,
without having built either. **It is genuinely new work on their side, and it is NOT the same
mechanism as the `GROUP_ADMINS` broadcast, which works today.**

## 8 · What we have on our side today: nothing

No admin-facing chat or support screen exists in `frontend/src/views/admin/` — searched, zero
files. The one admin branch in `chats/router.py` queries our LOCAL `ChatThread` pointer table for
rows where the admin personally is client or operator; that table has non-nullable user FKs on
both sides and **structurally cannot represent a section thread**, whose operator is a section id.
It predates sections and is unrelated to support — dead weight for this question, not a partial
surface. No backend endpoint lists section threads for an admin either.

## 9 · The options this admits — none chosen here

- **A · `is_supervisor=true` for admin callers, read-only.** Every admin lists every thread; the
  mechanism already exists. Alone it does NOT let a second admin answer — `can_post_message`
  still restricts writing to the assignee. Reads as "browse everything, claim to act".
- **B · Widen `can_post_message` to admit a supervisor.** The only thing that lets a second admin
  answer without claiming. **Not our code** — it is a comms-side change we would have to ask for.
- **C · Auto-claim on first read or reply.** Uses only mechanism that exists. But it answers
  "exactly one admin, whoever arrives first", which is the premise the owner questioned.
- **D · Assignment stays pure notification routing; we build our own admin visibility with an
  explicit reassign (retag, already built) instead of concurrent multi-writer access.** Needs no
  comms-side change, and stays single-writer per thread at any moment.
