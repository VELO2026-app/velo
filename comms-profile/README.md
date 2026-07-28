# VELO comms profile -- delivery

Source of the VELO product profile for the comms service: the type
dictionary (`types.yaml`, 15 velo domain types + 3 comms-native
`msg.*` chat-baseline types) and the template sheets
(`templates/ru.yaml`, `templates/en.yaml`).

This directory is the SOURCE, at the location LOCKED by the comms
arch doc (decision 12 / §2.3): `comms-profile/` at the PRODUCT REPO
ROOT, next to `backend/` and `frontend/` -- a contract with comms,
not a part of the backend and not deploy mechanics. The live copy the comms stack reads is
the instance profile location on the VPS (`/opt/comms/profile`,
bind-mounted into the comms containers as `TEMPLATES_DIR`), seeded
with the generic smoke profile by `comms-deploy.sh install` and meant
to be replaced by this real product profile.

## Deploy (operator ritual)

```bash
# on the VPS, after `git pull` in /opt/velo/repo:
cp /opt/velo/repo/comms-profile/types.yaml /opt/comms/profile/types.yaml
mkdir -p /opt/comms/profile/templates
cp /opt/velo/repo/comms-profile/templates/*.yaml /opt/comms/profile/templates/
# restart comms so the loader re-validates and installs the profile:
bash /opt/comms/repo/deploy/comms-deploy.sh restart
```

A broken profile FAILS THE COMMS STARTUP (fail-at-startup validation:
tree shape, template dry-run, chat-baseline `msg.*` categories, the
external-domain fence). Check `comms-deploy.sh logs` after restart --
`profile_installed types=18 locales=['en', 'ru']` is the green line.

Editing notification texts = editing the YAML here, commit to the
velo repo, pull + copy + restart comms. No velo code or comms code is
involved (integration design ID-3).

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
