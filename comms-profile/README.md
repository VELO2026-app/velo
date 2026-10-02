# VELO comms profile -- delivery

Source of the VELO product profile for the comms service: the type
dictionary (`types.yaml`, schema `version: 2` -- the velo domain types
+ 3 comms-native `msg.*` chat-baseline types, each routed to its
channels by the profile) and the template sheets (`templates/ru.yaml`,
`templates/en.yaml`).

This directory is the SOURCE, at the location LOCKED by the comms
arch doc (decision 12 / §2.3): `comms-profile/` at the PRODUCT REPO
ROOT, next to `backend/` and `frontend/` -- a contract with comms,
not a part of the backend and not deploy mechanics.

## Delivery: a bind, not a copy

comms reads THIS directory, from the velo checkout on the box (comms
`deploy/INTEGRATION.md` §3). The velo installer writes
`PROFILE_DIR=/opt/velo/repo/comms-profile` into `/opt/comms/.env`
(`scripts/install_velo.sh`), and the comms compose file bind-mounts
`${PROFILE_DIR}` read-only into the comms processes as `TEMPLATES_DIR`.
There is no second copy to keep in step, and none may be made: a copy
does not follow the repo, and after a protocol change comms refuses to
start on the stale one.

`velo update` pulls the repo and, because the profile is bound into
this checkout, restarts the comms stack (`comms-deploy.sh restart`),
so the profile it just pulled is the one being served. Nothing else
is run by hand.

A broken profile FAILS THE COMMS STARTUP (fail-at-startup validation:
schema version, the closed type record -- an unknown key other than
`x-...` refuses startup --, template dry-run, chat-baseline `msg.*`
categories, routes into channels the deploy did not configure, the
external-domain fence). `velo update` names the profile as the likely
cause when the restart fails; recovery is to revert the commit and
roll out again. The green line in the comms log is `profile_installed`
with `types=` the number of types in `types.yaml`.

Channels are routed HERE, never by the request: every velo-emitted
type declares `channels: [in_app, telegram]`, so the comms deploy must
have `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_URL` set, or it refuses to
start.

Editing notification texts = editing the YAML here, commit to the
velo repo, `velo update`. No velo code or comms code is involved
(integration design ID-3).

## HTML escaping -- who owns it (read before editing templates)

The trust boundary is fixed by the comms arch doc (§2.3) and enforced
in the comms telegram formatter (`_escape_html_variables`, applied
before `ParseMode.HTML`):

- **The TEMPLATE is trusted.** You MAY put markup in the sheet text --
  `<b>{practice_title}</b>`, `<i>...</i>`, etc. That markup is yours
  and is sent as-is.
- **The VARIABLES are NOT trusted, and comms escapes them for you.**
  Every `{...}` value (practice titles, master names, admin notes --
  all originally user input) is HTML-escaped by comms at delivery, on
  the channel path, once. A master who names a practice
  `</b><a href=evil>tap</a>` cannot inject markup: the value arrives
  escaped.

So, when writing templates here:

- DO wrap variables in markup freely (`<b>{amount}</b>`).
- DO NOT hand-escape a variable yourself (`&lt;`, `html.escape`, a
  pre-escaped value baked into the YAML). comms escapes it again ->
  the reader sees a literal `&lt;`. Escaping is comms' job, exactly
  once, and it already does it.
- velo does NOT escape notification variables anywhere (it emits raw
  values into the outbox on purpose) -- do not "fix" that on the velo
  side either; that would be the same double-escape from the other end.

(External review flagged this as a possible injection gap. It is not:
ownership is assigned -- comms, on the channel path -- and the escape
is implemented and tested there. This note exists so the boundary
stays visible to whoever edits these sheets next.)

NOTE: the smoke profile's `types.yaml` is REPLACED (its `msg.*`
categories `msg_chat`/`msg_system` are the generic smoke mapping; the
VELO mapping is `msg_participants`/`msg_support` per dispatch plan
§6b). Do not merge the two files.
