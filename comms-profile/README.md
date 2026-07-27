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

NOTE: the smoke profile's `types.yaml` is REPLACED (its `msg.*`
categories `msg_chat`/`msg_system` are the generic smoke mapping; the
VELO mapping is `msg_participants`/`msg_support` per dispatch plan
§6b). Do not merge the two files.
