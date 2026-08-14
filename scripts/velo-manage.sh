#!/bin/bash
# -u: abort on unset variables. pipefail: a pipeline fails if any stage fails.
# No -e: deliberately absent, on purpose, not an oversight. `set -e` is
# SUSPENDED for a command's exit status inside an `if`/`while`/`&&`/`||`/`!`
# context -- verified directly: a failing command inside a function invoked as
# `if ! some_function; then ...` does NOT trip -e, and the function keeps
# running past it. run_frontend_tests() below is called exactly that way, so
# `set -e` would not have caught the bug this file exists to fix (a build
# whose exit code went unread, reporting success on stale code). Every command
# whose failure matters is checked EXPLICITLY instead, right where it runs.
set -uo pipefail

# ==============================================================================
# VELO Management Script
# ==============================================================================
#
# This file is TRACKED in the repo, next to the frontend and backend it
# manages -- it is not generated once at provisioning time and then left to
# drift. `velo update` (below) pulls it like any other file: a fix landed here
# reaches every server on the next update, the same way a backend fix does.
#
# It used to be a ~700-line block embedded identically inside THREE separate
# installer scripts, written to /opt/velo/scripts/manage.sh once at install
# time and never touched again. A bug fixed in the repo (fda4b9e, 2026-07-16)
# therefore never reached a server that was already provisioned, and a second
# instance of the exact same bug (backend `build app`, below) shipped
# unnoticed in the very same file. Moving the script here removes that failure
# mode by removing the copy: there is only one text now, and it is the text
# that runs.
#
# Reached through a thin shim at /opt/velo/scripts/manage.sh (installed once
# by scripts/install_velo.sh, never edited again): the shim does nothing but
# `exec` this file. See install_management_shim() in that script.
#
# Reads the two values that legitimately differ per server --
# DOMAIN_FRONTEND, DOMAIN_API -- from /opt/velo/velo.conf, written once at
# install time. Everything else (which branch, which secrets) is read live
# from the git checkout or backend/.env, not baked in here -- baked-in values
# are what made the old manage.sh three divergent copies instead of one.
#
# Usage: velo {command} [options]
# ==============================================================================

INSTALL_BASE="/opt/velo"
COMPOSE_DIR="$INSTALL_BASE/repo"
COMPOSE_CMD="docker compose"

CONF_FILE="$INSTALL_BASE/velo.conf"
if [ ! -f "$CONF_FILE" ]; then
    echo "FATAL: $CONF_FILE not found." >&2
    echo "This looks like an incomplete install -- re-run scripts/install_velo.sh," >&2
    echo "or create the file by hand with:" >&2
    echo "  DOMAIN_FRONTEND=example.com" >&2
    echo "  DOMAIN_API=api.example.com" >&2
    echo "  VELO_ROLE=test        # or prod -- REQUIRED, gates destructive ops" >&2
    exit 1
fi
# shellcheck source=/dev/null
source "$CONF_FILE"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# -- Server role (Phase 6 / T0 finding #2) ------------------------------------
# test | prod, written into velo.conf by install_velo.sh. The role gates the
# test-only phases of `velo update`: the pytest suite runs against the LIVE
# DB and (since T0) every domain write it makes emits a real comms sync
# event -- fine on the test server (followed by a projection resync), never
# acceptable on prod. Prod's deploy gate is a green test server, not a
# local suite run.
#
# Missing role -> FATAL, never a guess. This gate stands in front of two
# destructive, IRREVERSIBLE operations -- the pytest suite against the LIVE
# DB and a `TRUNCATE ... CASCADE` in the comms DB -- so it MUST fail closed:
# an absent role is an ambiguous state, and defaulting it to "test" (the
# permissive side) is exactly how a misconfigured prod box would run pytest
# on production and truncate the live projection. The one existing test
# server already carries VELO_ROLE=test in velo.conf (persisted by the
# installer), and every future install -- test or prod -- writes the role
# explicitly, so refusing here breaks nothing legitimate; it only refuses
# the ambiguous case that has no safe default.
VELO_ROLE="${VELO_ROLE:-}"
case "$VELO_ROLE" in
    test|prod) ;;
    "")
        echo -e "${RED}FATAL: VELO_ROLE missing in $CONF_FILE.${NC}" >&2
        echo -e "${RED}  Refusing to guess: this role gates pytest against the live DB${NC}" >&2
        echo -e "${RED}  and TRUNCATE CASCADE in the comms DB. Set it explicitly:${NC}" >&2
        echo -e "${RED}  echo \"VELO_ROLE=test\" >> $CONF_FILE   # or prod${NC}" >&2
        exit 1
        ;;
    *)
        echo -e "${RED}FATAL: VELO_ROLE='$VELO_ROLE' in $CONF_FILE (expected test|prod)${NC}" >&2
        exit 1
        ;;
esac

# -- Recorded product branch (H-D1, 2026-08-04) -------------------------------
# `velo update` used to take the branch from the live checkout, which made
# DRIFT the source of truth: a checkout nudged sideways stayed sideways
# forever, silently. The installer now records the chosen branch in
# velo.conf and update reconciles the checkout to it. Servers installed
# before the key existed keep working: the role implies the branch by the
# same rule the installer uses (test -> test, prod -> main).
if [ -z "${VELO_BRANCH:-}" ]; then
    case "$VELO_ROLE" in
        test) VELO_BRANCH="test" ;;
        prod) VELO_BRANCH="main" ;;
    esac
    VELO_BRANCH_INFERRED=1
fi

# -- Service registry ---------------------------------------------------------
# ONE declaration of what this product runs; see the file's header. Sourced
# from the checkout, so a registry change ships like any other code change.
SERVICES_CONF="$COMPOSE_DIR/scripts/services.conf"
if [ -f "$SERVICES_CONF" ]; then
    # shellcheck source=/dev/null
    source "$SERVICES_CONF"
else
    # Pre-H-D1 checkout (or a half-finished update): fall back to updating
    # the product alone rather than refusing to run. Loud, not silent.
    echo -e "${YELLOW}⚠ $SERVICES_CONF not found -- service registry unavailable,${NC}" >&2
    echo -e "${YELLOW}  only the product will be updated by 'velo update'.${NC}" >&2
    # Seven fields, matching services.conf -- the fallback must not be
    # the one record on the box that is missing `access`.
    VELO_SERVICES=("velo|aivis-one/velo|$COMPOSE_DIR|conf:VELO_BRANCH|internal|update_product|write")
    svc_field() {
        local record="$1" index="$2"
        local IFS='|'
        # shellcheck disable=SC2206
        local fields=($record)
        # `:-` as in services.conf: a short record must not abort the
        # script under `set -u`; an absent field reads as empty.
        printf '%s' "${fields[$((index - 1))]:-}"
    }
    svc_branch() { printf '%s' "$VELO_BRANCH"; }
fi

# Ensure we're in the right directory for docker compose
cd_compose() {
    cd "$COMPOSE_DIR" || {
        echo -e "${RED}ERROR: $COMPOSE_DIR not found${NC}"
        exit 1
    }
}

# =============================================================================
# Registry service dispatch (T-33)
# =============================================================================
#
# Two facts about a registry service decide what any lifecycle command may
# do with it, and both are asked, never assumed:
#
#   svc_installed  -- is it on this box at all?
#   verb_supported -- does its own CLI implement this verb?
#
# EXIT CODE CONVENTION for every registry-driven command below:
#   0  done, in full
#   1  something actually failed
#   2  done as far as possible, INCOMPLETE -- a service could not take
#      part, and the operator has to know the box is not in the state
#      the command name implies
#
# 2 is not a softer 1. `velo stop` that left a service running is not a
# failure and not a success, and collapsing it into either loses the only
# signal that says so. Aggregates take the WORST of what they saw with
# 1 > 2 > 0: a real failure must never be masked by incompleteness.
#
# NOT INSTALLED IS CODE 0, deliberately. A comms-less box is a legitimate
# configuration (see update_service, which has said so since H-D1), not a
# degraded one -- there is nothing incomplete about a box doing all of
# what it has. Code 2 is for a service that IS here and cannot comply;
# it disappears by itself the day that service learns the verb.

# Is this service present on the box? Mirrors update_service's presence
# test exactly -- one predicate instead of a copy per command.
svc_installed() {
    local record="$1"
    local dir lifecycle
    dir=$(svc_field "$record" 3)
    lifecycle=$(svc_field "$record" 5)
    [ "$lifecycle" = "internal" ] && return 0
    [ -d "$dir/.git" ] && [ -f "$dir/$lifecycle" ]
}

# Print the lifecycle verbs a service's CLI implements, one per line.
#
# HOW: read the CLI's TOP-LEVEL dispatcher and take its case labels.
# Top-level is decided by the `case` and `esac` KEYWORDS sitting at
# column zero -- not by the labels, which are indented in a top-level
# dispatcher exactly as they are in a nested one. Taking the block
# first and the labels second is what keeps a nested `case` (comms has
# one inside its db subcommand, with labels dump/restore/migrate) from
# being read as verbs of the service itself.
#
# ┌─ KNOWN CEILING (convention §4a) ────────────────────────────────────
# │ (1) MECHANICS: a service's capabilities are inferred from the SHAPE
# │     OF ITS SOURCE -- a `case` dispatcher at column zero in another
# │     repository's file. That is a contract we depend on and never
# │     agreed with anyone.
# │ (2) STATUS: acknowledged by design.
# │ (3) REFERENCE: T-33, item 2.
# │ (4) UNCONSERVATION TRIGGER: a service's CLI stops being a
# │     column-zero `case` dispatcher (getopts, a dispatch function, a
# │     rewrite in another language), OR any service gains a
# │     machine-readable way to declare what it implements.
# │ (5) SHAPE OF THE FIX: ask the service instead of reading it -- a
# │     `capabilities` verb printing its verbs, with this parser kept
# │     only as the fallback for CLIs that do not have one yet.
# │ (6) REJECTED, AND WHY:
# │     - RUNNING the verb and inferring support from the result: an
# │       unknown verb prints usage and exits 1, which is exactly what
# │       a verb that ran and failed does. Telling them apart means
# │       pattern-matching another project's usage text.
# │     - DECLARING the verbs in services.conf: that file lives in the
# │       velo repo, so the day a service gains a verb velo would have
# │       to change -- against the one requirement this design exists
# │       to satisfy.
# │
# │ THE FAILURE MODE TO WATCH: if the shape changes, this returns an
# │ empty list and velo reports "does not implement" for a service that
# │ does. That is loud exactly once; by the third time it is background
# │ noise. Hence an unreadable dispatcher is reported as its OWN state
# │ (see verb_supported), not as six separate "not implemented" lines.
# └─────────────────────────────────────────────────────────────────────
svc_verbs() {
    local cli="$1"
    [ -f "$cli" ] || return 1
    awk '
        /^case[[:space:]]/ { inblock = 1; next }
        inblock && /^esac/  { inblock = 0; next }
        inblock             { print }
    ' "$cli" \
        | grep -oE '^[[:space:]]*[a-z][a-z0-9|_-]*\)' \
        | tr -d ' )' \
        | tr '|' '\n' \
        | grep -v '^$' \
        | sort -u
}

# Does this service implement VERB?
#   0  yes
#   1  no -- CLI read fine, the verb is simply not there
#   3  the dispatcher could not be read at all (see the marker above)
verb_supported() {
    local record="$1" verb="$2"
    local dir lifecycle verbs
    dir=$(svc_field "$record" 3)
    lifecycle=$(svc_field "$record" 5)
    [ "$lifecycle" = "internal" ] && return 0

    verbs=$(svc_verbs "$dir/$lifecycle") || return 3
    [ -n "$verbs" ] || return 3
    printf '%s\n' "$verbs" | grep -qx "$verb"
}

# Run VERB on one registry service, reporting rather than guessing.
# Prints nothing of its own on the happy path -- the service's CLI is
# the one talking. Returns the convention codes above.
svc_run_verb() {
    local record="$1" verb="$2"
    shift 2
    local name dir lifecycle rc
    name=$(svc_field "$record" 1)
    dir=$(svc_field "$record" 3)
    lifecycle=$(svc_field "$record" 5)

    [ "$lifecycle" = "internal" ] && return 0

    if ! svc_installed "$record"; then
        echo -e "${YELLOW}⊘ $name: not installed, skipped${NC}"
        return 0
    fi

    verb_supported "$record" "$verb"; rc=$?
    if [ "$rc" -eq 3 ]; then
        echo -e "${YELLOW}⚠ $name: could not read the lifecycle verbs from${NC}"
        echo -e "${YELLOW}  $dir/$lifecycle -- its dispatcher is not in the form velo${NC}"
        echo -e "${YELLOW}  reads (see svc_verbs). Skipping '$verb' rather than guessing.${NC}"
        return 2
    fi
    if [ "$rc" -ne 0 ]; then
        echo -e "${YELLOW}⊘ $name: no such lifecycle verb -- '$verb' skipped${NC}"
        echo "  $name implements: $(svc_verbs "$dir/$lifecycle" | tr '\n' ' ')"
        return 2
    fi

    if ! bash "$dir/$lifecycle" "$verb" "$@"; then
        echo -e "${RED}✗ $name: '$verb' failed${NC}"
        return 1
    fi
    return 0
}

# Does this host alias authenticate to GitHub?
#
# `ssh -T` against GitHub exits 1 even on SUCCESS ("does not provide
# shell access"), so the banner is captured and matched instead of
# relying on the exit code -- the same trap that made the installer's
# key test fail on good keys until 2026-07-27.
github_probe_alias() {
    local alias="$1" banner
    banner=$(ssh -T "git@${alias}" 2>&1 || true)
    echo "$banner" | grep -q "successfully authenticated"
}

# Fold a per-service code into the aggregate: 1 beats 2 beats 0.
svc_worst() {
    local current="$1" incoming="$2"
    [ "$current" -eq 1 ] || [ "$incoming" -eq 1 ] && { echo 1; return; }
    [ "$current" -eq 2 ] || [ "$incoming" -eq 2 ] && { echo 2; return; }
    echo 0
}

# Walk the registry's services (the product is handled by its caller).
# direction: "forward" (providers first) or "reverse" (product first).
# Prints nothing itself; returns the aggregate code.
svc_walk() {
    local direction="$1" verb="$2"
    shift 2
    local i record agg=0 rc
    local -a order=()

    for i in "${!VELO_SERVICES[@]}"; do order+=("$i"); done
    if [ "$direction" = "reverse" ]; then
        local -a rev=()
        for ((i = ${#order[@]} - 1; i >= 0; i--)); do rev+=("${order[$i]}"); done
        order=("${rev[@]}")
    fi

    for i in "${order[@]}"; do
        record="${VELO_SERVICES[$i]}"
        [ "$(svc_field "$record" 5)" = "internal" ] && continue
        svc_run_verb "$record" "$verb" "$@"; rc=$?
        agg=$(svc_worst "$agg" "$rc")
    done
    return "$agg"
}

# Closing line for a command that could not cover the whole box.
svc_report_incomplete() {
    local verb="$1"
    echo ""
    echo -e "${YELLOW}⚠ '$verb' did not cover the whole box -- see the lines above.${NC}"
    echo -e "${YELLOW}  Containers belonging to the skipped service(s) are in whatever${NC}"
    echo -e "${YELLOW}  state they were already in; 'docker ps' will still show them.${NC}"
}

# -- Comms projection resync (TEST CONTOUR ONLY -- Phase 6 / T0 finding #2) ---
# The pytest suite runs against the live DB while the server's outbox relay
# keeps shipping: every login/verify a test performs becomes a REAL
# user_upserted / group_changed event in comms, and the raw test cleanups
# emit nothing back -- after each suite run the comms projection holds
# phantom recipients/memberships (measured: 1075 and 1189 recipients vs 426
# real users on 27.07). The cure is the projection's own design: it is
# rebuildable from velo. Drop it, backfill it, done (~10s for 426 users).
#
# DO NOT port this into any prod path. Prod has no phantom source (no suite
# runs against the prod DB -- see the role gate in `update`), so prod never
# truncates: the transactional outbox + snapshot-on-login self-healing +
# the idempotent backfill (as a reconciliation tool, WITHOUT truncate)
# keep the projection converged.
# WARNING -- THIS DESTROYS DATA. The TRUNCATE below cascades far past the
# two tables it names: recipients is referenced by the messaging side, so
# threads, messages and thread_read_states go with it. On a stand with live
# chats that is every conversation, gone. It is a test-contour ritual for
# rebuilding the identity projection, never a routine step -- which is why
# `velo update` stopped calling it (H-D2, 2026-08-06).
resync_comms_projection() {
    if [ "$VELO_ROLE" != "test" ]; then
        echo -e "${RED}✗ resync-comms is a test-contour ritual; refusing on role '$VELO_ROLE'${NC}"
        return 1
    fi
    if ! docker ps --format '{{.Names}}' | grep -q '^comms-postgres$'; then
        echo -e "${YELLOW}⊘ comms-postgres not running -- comms not installed here, resync skipped${NC}"
        return 0
    fi
    echo "Resyncing the comms projection (truncate + backfill)..."
    if ! docker exec comms-postgres psql -U comms -d comms -c \
        "TRUNCATE group_memberships, recipients CASCADE;" > /dev/null; then
        echo -e "${RED}✗ Failed to truncate the comms projection${NC}"
        return 1
    fi
    cd_compose
    if ! $COMPOSE_CMD exec -T app python scripts/backfill_comms_sync.py \
        | tail -n 2; then
        echo -e "${RED}✗ Backfill failed -- projection is EMPTY until it succeeds${NC}"
        echo "Retry by hand: velo resync-comms"
        return 1
    fi
    echo -e "${GREEN}✓ Comms projection resynced (relay ships it within seconds)${NC}"
}

# Make sure the shared external docker network exists before any `up`.
# docker-compose.yml declares `aivis-shared` as EXTERNAL (the comms stack
# joins the same network) -- compose never creates external networks, it
# requires them. On a server installed before comms orchestration existed
# the network is absent and every `up -d` dies on it; that is exactly how
# the 2026-07-26 stale-backend incident started (see the gate in update).
# Idempotent -- same guard as install_velo.sh and comms-deploy.sh; any of
# the three may create it first, the result is identical.
ensure_shared_network() {
    docker network inspect aivis-shared > /dev/null 2>&1 && return 0
    docker network create aivis-shared > /dev/null
}

# Run frontend tests in a throwaway container.
# Uses `docker build --target source` to get node + deps + source with nothing
# executed, then runs `npm run test` inside it -- see the note in the body for
# why it is not `--target builder`.
run_frontend_tests() {
    echo "Running frontend tests..."
    cd "$COMPOSE_DIR"
    # --target source, NOT builder. The builder stage runs `npm run test`
    # itself (it is the production gate), so building it here meant the suite
    # ran TWICE per invocation -- once inside the build, silently, behind
    # `-q`, and once again in the container below. On a cold cache that was
    # ~3.5 minutes of total silence before the output a human is waiting for
    # even started. The `source` stage stops at `npm ci` + COPY, so this build
    # prepares the ground and the run below is the only place the suite
    # executes. The gate is untouched: `docker compose build` still goes
    # through builder.
    #
    # The build's own exit code is checked explicitly (not folded into the
    # `docker run` check below): the original bug here was exactly this build
    # failing silently, `docker run` then executing the PREVIOUS successful
    # image under the same tag, and the caller reading that stale run as
    # today's test result. `-q` keeps docker's own noise down; stderr is left
    # unredirected (the old code sent it to /dev/null too) so a real build
    # failure is visible instead of just "FAILED" with no reason.
    if ! docker build --target source -t velo-frontend-test -f frontend/Dockerfile frontend/ -q > /dev/null; then
        echo -e "${RED}✗ Frontend image build FAILED -- nothing was tested${NC}"
        return 1
    fi
    if docker run --rm velo-frontend-test npm run test; then
        echo -e "${GREEN}✓ Frontend tests passed${NC}"
        return 0
    else
        echo -e "${RED}✗ Frontend tests FAILED${NC}"
        return 1
    fi
}

# Poll the backend /health endpoint until it responds, or fail after timeout.
# Avoids a race where we hit the API (openapi.json / health) before the `app`
# container is actually listening -- previously masked by the test step that
# happened to give the backend time to boot. 30 attempts x 1s = 30s max.
wait_for_backend() {
    local attempts=30
    echo "Waiting for backend to become healthy..."
    for i in $(seq 1 "$attempts"); do
        if curl -sf http://127.0.0.1:8000/health > /dev/null 2>&1; then
            echo -e "${GREEN}✓ Backend is healthy (after ${i}s)${NC}"
            return 0
        fi
        sleep 1
    done
    echo -e "${RED}✗ Backend did not become healthy in ${attempts}s${NC}"
    echo "Check logs: velo logs app"
    return 1
}

# PROMPT №563: a key missing from the real .env is only genuinely DRIFT if
# nothing in the app covers for its absence. app/core/config.py's Settings
# class gives every field a Python-side default (grep confirms: zero fields
# declared without one, e.g. via pydantic's `Field(...)` -- checked, none
# exist in this file today), but those defaults are NOT uniformly "safe":
# some are real, working values (TELEGRAM_LINK_DOMAIN = "telegram.me") and
# some are empty-string placeholders that only LOOK like defaults
# (SECRET_KEY = "", DATABASE_URL = "" -- "no default in production, app
# won't start without it", per that field's own comment). Only the first
# kind gets downgraded to informational; an empty/None default still counts
# as drift, unchanged from before.
#
# Derived from the code by a regex read of config.py, not a hand-maintained
# list -- so it tracks new fields automatically. HONEST LIMITS: this is a
# regex over a Python source file, not a parser. It only resolves a field
# declared as `snake_case_name: type = <literal>` on a single line (true for
# all 93 fields in this file today, verified by grep). A future field using
# `Field(...)`, a computed default, or a multi-line annotation would not
# match and SAFELY falls back to being reported as drift (never silently
# downgraded on a declaration this couldn't confidently read). It also can't
# tell "safe in every environment" apart from "safe for local dev, wrong in
# prod" (e.g. REDIS_URL defaults to localhost) -- that distinction exists
# only in this file's prose comments, not as a machine-readable signal, so
# such keys are informational too. Informational still PRINTS (with the
# default shown) so a human doing a prod audit still sees it -- only the
# pass/fail verdict changes, the key never goes silent.
# NOT the same fix as the `grep -m1` -> `tail -n 1` corrections
# elsewhere in this file, and deliberately left as `head -1`. Those read
# ENV files, where a repeated key resolves to the last assignment and
# last-match is simply correct. This greps PYTHON SOURCE across the whole
# module: a second match can come from a different class or a nested
# model, in which case neither first nor last is right for certain --
# there is no correct one-liner. The consumer is `velo doctor` and the
# consequence is cosmetic (a key reported informational instead of
# drift), so this stays as it is until someone parses the file properly.
_config_default_for_key() {
    local key="$1" config_file="$2"
    local py_attr
    py_attr=$(echo "$key" | tr '[:upper:]' '[:lower:]')
    grep -E "^[[:space:]]*${py_attr}[[:space:]]*:.*=" "$config_file" \
        | head -1 \
        | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]*#.*$//; s/[[:space:]]*$//'
}

# Drift watchman for backend/.env.example vs the real backend/.env: install
# reads the ENV_FILE guard in install_velo.sh's generate_env(), which means
# backend/.env is written exactly once and never touched again by `velo
# update` -- a key added to the app later just silently isn't there on an
# already-provisioned box. Presence only, key names via cut -- values are
# secrets and are never read or printed.
check_backend_env() {
    local example_file="$1" real_env_file="$2"
    local config_file
    config_file="$(dirname "$example_file")/app/core/config.py"
    local drift=0
    echo "--- backend/.env ---"
    if [ ! -f "$real_env_file" ]; then
        echo -e "${RED}✗ $real_env_file not found${NC}"
        return 1
    fi
    local key
    while IFS= read -r key; do
        [ -z "$key" ] && continue
        if grep -q "^${key}=" "$real_env_file"; then
            echo -e "${GREEN}✓${NC} $key present"
            continue
        fi

        local default_val=""
        if [ -f "$config_file" ]; then
            default_val=$(_config_default_for_key "$key" "$config_file")
        fi
        if [ -n "$default_val" ] && [ "$default_val" != '""' ] && [ "$default_val" != "''" ] && [ "$default_val" != "None" ]; then
            echo -e "${YELLOW}⚠ $key -- absent from the real file, but config.py falls back to ${default_val} (informational, not drift)${NC}"
        else
            echo -e "${RED}✗ $key -- declared in $example_file, ABSENT from the real file${NC}"
            drift=1
        fi
    done < <(grep -oE '^[A-Z_]+=' "$example_file" | sed 's/=$//')
    return $drift
}

# Drift watchman for vite.env: written once by install_velo.sh's generate_env
# and sourced at build time (docker-compose.yml's frontend build args), but
# never regenerated by `velo update`. The build args are declared bare with
# no default, so a key missing from vite.env bakes an EMPTY STRING into the
# bundle -- no error, no red exit code, nothing `velo update`'s own test gate
# would ever see. Required-key list is parsed from docker-compose.yml itself
# (the tracked source of truth), not hand-maintained here.
check_vite_env() {
    local compose_file="$1" vite_env_file="$2" frontend_src_dir="$3"
    local drift=0
    echo "--- vite.env ---"
    if [ ! -f "$vite_env_file" ]; then
        echo -e "${RED}✗ $vite_env_file not found${NC}"
        return 1
    fi
    local required_keys
    required_keys=$(grep -oE '^[[:space:]]*-[[:space:]]*VITE_[A-Z_]+[[:space:]]*$' "$compose_file" | grep -oE 'VITE_[A-Z_]+' | sort -u)
    if [ -z "$required_keys" ]; then
        echo -e "${YELLOW}⚠ no VITE_ build args found in $compose_file -- nothing to check${NC}"
        return 0
    fi
    local key
    for key in $required_keys; do
        local value
        value=$(grep -E "^${key}=" "$vite_env_file" | tail -1 | cut -d= -f2-)
        if [ -z "$value" ]; then
            echo -e "${RED}✗ $key -- MISSING or empty in $vite_env_file (ships as an empty string in the build; no error, no red exit code)${NC}"
            drift=1
        else
            echo -e "${GREEN}✓${NC} $key present"
        fi

        # Consumption-site survey: not a pass/fail signal on its own, but a
        # missing key's blast radius depends entirely on how many call sites
        # read it and what each falls back to -- print that, don't hide it.
        local sites
        sites=$(grep -rn "import\.meta\.env\.${key}" "$frontend_src_dir" --include='*.ts' --include='*.vue' 2>/dev/null | grep -v '\.test\.ts:')
        if [ -n "$sites" ]; then
            local n_sites fallback_list
            n_sites=$(echo "$sites" | wc -l)
            echo "      $n_sites consumption site(s):"
            fallback_list=""
            while IFS= read -r line; do
                local loc fb
                loc=$(echo "$line" | cut -d: -f1-2)
                fb=$(echo "$line" | sed -n "s/.*${key}[[:space:]]*||[[:space:]]*\([^,);]*\).*/\1/p")
                if [ -z "$fb" ]; then
                    fb="<no fallback -- undefined if unset>"
                fi
                echo "        $loc -> $fb"
                fallback_list="${fallback_list}${fb}"$'\n'
            done <<< "$sites"
            local distinct
            distinct=$(echo "$fallback_list" | sort -u | grep -c .)
            if [ "$distinct" -gt 1 ]; then
                echo -e "      ${YELLOW}NOTE: fallbacks differ across sites -- a missing $key produces DIFFERENT runtime behavior depending which site renders.${NC}"
            fi
        fi
    done
    return $drift
}

# Strips exactly what does not change nginx's runtime behavior, so the
# nginx drift check compares BEHAVIOR, not text: (1) full-line comments --
# any line whose first non-whitespace character is `#`; (2) blank lines
# (including lines a stripped comment leaves empty); (3) leading/trailing
# whitespace on each remaining line; (4) internal whitespace runs, collapsed
# to a single space.
#
# (4) is NOT quote-aware -- it collapses whitespace everywhere, including
# inside a value, if one had embedded spaces. Checked by hand against every
# active directive in both templates (nginx-render.sh) before relying on
# this: listen/server_name/proxy_pass/proxy_set_header/root/return/
# ssl_certificate*/ssl_protocols/ssl_ciphers/ssl_prefer_server_ciphers --
# none carries a value with a meaningful embedded space (domains, ports,
# paths, colon-separated cipher lists). The one quoted, space-containing
# string in either template (the HSTS header's "max-age=63072000") lives
# inside a commented-out line, so step (1) removes it before this ever
# runs. A directive gaining a real quoted/space-sensitive value later would
# need this revisited -- it is not a general nginx-config normalizer.
#
# A directive commented out on ONE side only still gets caught: step (1)
# deletes that line from whichever side has it commented, the other side
# keeps it as a live directive line, the two normalized texts differ, and
# the diff below still fires. Comments disappearing from BOTH sides equally
# is exactly what makes cosmetic-only skew (wording, box-drawing padding
# that drifted when a domain of a different length got substituted into a
# fixed-width heredoc) go silent without hiding an actual behavior change.
normalize_nginx_conf() {
    sed -E \
        -e 's/^[[:space:]]*#.*$//' \
        -e 's/^[[:space:]]+//' \
        -e 's/[[:space:]]+$//' \
        -e 's/[[:space:]]+/ /g' \
        | grep -v '^$'
}

# Drift watchman for /etc/nginx/sites-available/velo: written by
# install_velo.sh (setup_nginx/setup_ssl, via the shared render_nginx_http/
# render_nginx_ssl functions in nginx-render.sh) and never regenerated by
# `velo update`. A failed hand-edit or a domain change in velo.conf that
# never gets re-rendered leaves the file on disk out of sync with what nginx
# actually serves (nginx keeps running the last config that passed `nginx -t`)
# -- a silent split between "written" and "live". Renders BOTH candidate
# variants are not needed: which one is live is read off the file itself
# (the SSL variant is the only one with an `ssl_certificate` directive), then
# only that variant is re-rendered for today's domains and diffed -- after
# normalize_nginx_conf strips what doesn't affect behavior, so cosmetic
# skew (comment wording, alignment padding) does not read as drift.
check_nginx() {
    local nginx_render_lib="$1" live_conf="$2" domain_frontend="$3" domain_api="$4"
    # Optional public domain (T-32 item 6), recorded in velo.conf by the
    # installer. It MUST be passed through: the expected config is
    # rendered from these arguments, so leaving it out on a server that
    # opted in would make the doctor report drift for ever -- against a
    # difference we ourselves installed. Empty renders exactly what the
    # two-argument form always rendered.
    local domain_public="${5:-}"
    echo "--- nginx ---"
    if [ ! -f "$live_conf" ]; then
        echo -e "${RED}✗ $live_conf not found${NC}"
        return 1
    fi
    if [ ! -f "$nginx_render_lib" ]; then
        echo -e "${YELLOW}⚠ $nginx_render_lib not found -- cannot render a comparison, skipping${NC}"
        return 0
    fi
    # shellcheck source=/dev/null
    source "$nginx_render_lib"

    local expected variant
    if grep -q "ssl_certificate " "$live_conf"; then
        variant="ssl"
        expected=$(render_nginx_ssl "$domain_frontend" "$domain_api" "$domain_public")
    else
        variant="http-only"
        expected=$(render_nginx_http "$domain_frontend" "$domain_api" "$domain_public")
    fi
    echo "      live config detected as: $variant (domains: $domain_frontend / $domain_api${domain_public:+ / $domain_public})"

    # One asymmetry worth naming rather than hiding: the public domain
    # keeps its own certificate, so a box can legitimately serve the two
    # main domains over SSL while that one is still plain HTTP. The
    # variant above is decided by the file as a whole, so in that state
    # the doctor reports drift -- correctly. It IS drift: the live config
    # is not what a successful install produces.
    if [ -n "$domain_public" ] && [ "$variant" = "ssl" ] \
       && ! grep -q "live/${domain_public}/" "$live_conf"; then
        echo -e "${YELLOW}      note: $domain_public has no certificate in the live config --${NC}"
        echo -e "${YELLOW}      its certbot run failed at install. Re-request it, then reload nginx.${NC}"
    fi

    local normalized_expected normalized_live
    normalized_expected=$(echo "$expected" | normalize_nginx_conf)
    normalized_live=$(normalize_nginx_conf < "$live_conf")

    local diffout
    if diffout=$(diff <(echo "$normalized_expected") <(echo "$normalized_live")); then
        echo -e "${GREEN}✓ Live config matches what today's generator would produce for these domains (behavior-equivalent -- comments/whitespace ignored)${NC}"
        return 0
    else
        echo -e "${RED}✗ Live config DIFFERS from what today's generator would produce (behavior change, not just cosmetic):${NC}"
        echo "$diffout" | sed 's/^/      /'
        return 1
    fi
}

# =============================================================================
# UPDATE CYCLE -- every service on this box, one command (H-D1, 2026-08-04)
# =============================================================================
# The installer has always put TWO stacks on the server, but `velo update`
# only ever pulled velo: comms could move only by hand, on the server --
# the one thing that is now forbidden outright. The cycle below walks the
# registry instead, top to bottom, and each service is updated by ITS OWN
# lifecycle script. Mechanics stay in their own repos: no docker or compose
# command in this file ever addresses another service.

# Bring a checkout in line with its recorded branch. Does NOT fast-forward
# to origin -- pulling is the service's own job (comms-deploy.sh pulls with
# --ff-only; update_product has its own gated pull), and doing it here would
# make both of them think there was nothing to update.
#
# Sets SVC_CHANGED=1 when there is something to deploy.
svc_sync_checkout() {
    local dir="$1" want="$2" name="$3" policy="${4:-}"
    SVC_CHANGED=0

    cd "$dir" || { echo -e "${RED}✗ $name: $dir is not reachable${NC}"; return 1; }

    # 1. Dirty tree = drift (nothing here is hand-edited any more), so it
    # is discarded -- but never without a trace: what is being thrown away
    # is printed FIRST. That log line is the forensics if norm 1 was
    # broken by somebody.
    if ! git diff-index --quiet HEAD -- 2>/dev/null; then
        echo -e "${YELLOW}⚠ $name: local modifications in $dir -- discarding:${NC}"
        git status --short | sed 's/^/    /'
        git --no-pager diff --stat HEAD | sed 's/^/    /'
        git reset --hard HEAD > /dev/null || return 1
    fi

    if ! git fetch origin --quiet; then
        echo -e "${RED}✗ $name: git fetch failed -- nothing touched${NC}"
        return 1
    fi

    if ! git rev-parse --verify --quiet "origin/$want" > /dev/null; then
        echo -e "${RED}✗ $name: branch '$want' does not exist on origin${NC}"
        echo "  Registry says this service tracks '$want' (scripts/services.conf)."
        return 1
    fi

    local current ahead
    current=$(git branch --show-current)

    if [ "$current" = "$want" ]; then
        # 2. Local commits that never reached origin. Aligning the branch
        # would erase them silently -- exactly what a failed types-push
        # leaves behind (see the push retry in update_product). Try to
        # push them home; if that fails, STOP. Losing a commit quietly is
        # worse than a red update.
        ahead=$(git rev-list --count "origin/$want..HEAD" 2>/dev/null || echo 0)
        if [ "$ahead" -gt 0 ]; then
            echo -e "${YELLOW}⚠ $name: $ahead local commit(s) not on origin/$want -- pushing${NC}"
            if ! git push origin "$want"; then
                echo -e "${RED}✗ $name: cannot push local commits to origin/$want${NC}"
                echo "  Refusing to realign the checkout: that would destroy them."
                echo "  Inspect: cd $dir && git log origin/$want..HEAD"
                return 1
            fi
        fi
    else
        # 3. The checkout drifted off its recorded branch. Local commits on
        # a FOREIGN branch are a double violation with no safe automatic
        # answer -- neither pushing them somewhere they do not belong nor
        # deleting them is ours to decide.
        if [ -n "$current" ] && git rev-parse --verify --quiet "origin/$current" > /dev/null; then
            ahead=$(git rev-list --count "origin/$current..HEAD" 2>/dev/null || echo 0)
            if [ "$ahead" -gt 0 ]; then
                echo -e "${RED}✗ $name: on branch '$current' (expected '$want') with $ahead unpushed commit(s)${NC}"
                echo "  Refusing to switch branches over them. Inspect: cd $dir && git log origin/$current..HEAD"
                return 1
            fi
        fi
        echo -e "${CYAN}↻ $name: checkout '${current:-detached}' -> '$want' (recorded branch wins)${NC}"
        if ! git checkout -B "$want" "origin/$want"; then
            echo -e "${RED}✗ $name: could not switch to '$want'${NC}"
            return 1
        fi
        # A branch switch replaces the code wholesale: always redeploy,
        # even though HEAD now equals origin (nothing left to pull).
        SVC_CHANGED=1
    fi

    # 4. Product branches of a SERVICE are allowed but never free: warn (do
    # not refuse) when one tracks something main is not an ancestor of --
    # that is the moment a fix on main stops reaching this server.
    #
    # Only for branches pinned by POLICY (`fixed:`). The product's own branch
    # comes from this server's config (`conf:`), and a test server diverging
    # from main is not drift, it IS the workflow -- warning about it every
    # single run would be noise that teaches people to ignore warnings.
    if [ "${policy%%:*}" = "fixed" ] && [ "$want" != "main" ] \
       && git rev-parse --verify --quiet origin/main > /dev/null; then
        if ! git merge-base --is-ancestor origin/main "origin/$want" 2>/dev/null; then
            echo -e "${YELLOW}⚠ $name: origin/$want is NOT a descendant of origin/main${NC}"
            echo "    Fixes landing on main do not reach this server until it is merged."
        fi
    fi

    if [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$want")" ]; then
        SVC_CHANGED=1
    fi
    return 0
}

# Update ONE registry record. Returns non-zero to stop the whole cycle.
update_service() {
    local record="$1"; shift
    local name dir branch_expr lifecycle updater want
    name=$(svc_field "$record" 1)
    dir=$(svc_field "$record" 3)
    branch_expr=$(svc_field "$record" 4)
    lifecycle=$(svc_field "$record" 5)
    updater=$(svc_field "$record" 6)

    # Presence: a service that is not on this box is a legitimate
    # configuration (comms-less servers exist), not an error.
    if [ "$lifecycle" != "internal" ] && { [ ! -d "$dir/.git" ] || [ ! -f "$dir/$lifecycle" ]; }; then
        echo -e "${YELLOW}⊘ $name: not installed, skipped${NC}"
        echo ""
        return 0
    fi

    want=$(svc_branch "$branch_expr" "$name") || return 1
    echo -e "${CYAN}=== $name ($want) ===${NC}"

    svc_sync_checkout "$dir" "$want" "$name" "$branch_expr" || return 1

    if [ "$lifecycle" = "internal" ]; then
        # The product runs its own full cycle (build, tests, types, health)
        # and decides for itself whether there is anything to do.
        "$updater" "$@" || return 1
        return 0
    fi

    if [ "$SVC_CHANGED" -eq 0 ]; then
        echo -e "${GREEN}✓ $name: already up to date${NC}"
        echo ""
        return 0
    fi

    # Its own script, its own mechanics -- we only tell it to go.
    if ! bash "$dir/$lifecycle" "$updater"; then
        echo -e "${RED}✗ $name: update failed${NC}"
        return 1
    fi
    echo ""
    return 0
}

# `velo update` -- the whole box, in registry order.
# Restart ONE registry service if -- and only if -- its profile is
# bind-mounted out of this product's checkout, so that the templates
# the product just pulled are the ones it serves.
#
# Everything is derived from the registry record, nothing hardcoded: a
# second service with the same arrangement is covered by declaring it.
# Silence is the correct answer in every "not applicable" case (no
# service env, profile kept elsewhere, comms-less box) -- this is an
# addition to `velo update`, and an addition may not invent new ways
# for it to fail.
reload_bound_profile() {
    local record="$1"
    local name dir cli env_file profile_dir

    name=$(svc_field "$record" 1)
    dir=$(svc_field "$record" 3)          # e.g. /opt/comms/repo
    cli=$(svc_field "$record" 5)          # e.g. deploy/comms-deploy.sh

    # The service's own env sits next to its checkout, outside it (the
    # layout every service CLI here uses, so that `update` never touches
    # secrets).
    env_file="$(dirname "$dir")/.env"
    [ -f "$env_file" ] || return 0

    # grep, not source: that file is full of secrets and this is a
    # read of exactly one key.
    # `tail -n 1`, not `grep -m1`: this file is read the way a shell
    # reads assignments, so a repeated key resolves to the LAST one.
    # First-match here would act on a stale path while the service used
    # the current one. Same defect class as the one fixed in
    # env-render.sh -- the pattern was corrected there and left alive
    # here, which is how a class survives a fix (repeat audit H-R4).
    profile_dir=$(grep -E '^PROFILE_DIR=' "$env_file" 2>/dev/null | tail -n 1 | cut -d= -f2-)
    [ -n "$profile_dir" ] || return 0

    # Not bound into our checkout -> the pull changed nothing it reads.
    case "$profile_dir" in
        "$COMPOSE_DIR"/*) ;;
        *) return 0 ;;
    esac

    echo ""
    echo -e "${CYAN}Reloading $name -- its profile is bound to $profile_dir${NC}"
    if [ ! -x "$dir/$cli" ] && [ ! -f "$dir/$cli" ]; then
        echo -e "${YELLOW}⊘ $name: $dir/$cli not found -- skipping profile reload${NC}"
        return 0
    fi

    if bash "$dir/$cli" restart; then
        echo -e "${GREEN}✓ $name restarted on the profile from this checkout${NC}"
        return 0
    fi

    # The service validates its profile at startup and refuses to boot on
    # a bad one -- so by far the likeliest cause of a failure HERE is the
    # template commit that just arrived, and the operator is looking at a
    # crash-looping service. Give them the way out, not just the verdict.
    echo -e "${RED}✗ $name did not come back after the profile reload${NC}"
    echo ""
    echo -e "${YELLOW}Most likely cause: the profile that just arrived in this pull.${NC}"
    echo "  $name refuses to start on a profile it cannot validate"
    echo "  (malformed types.yaml, a broken template placeholder, a type"
    echo "  declared without a category)."
    echo ""
    echo "  Inspect:  bash $dir/$cli logs"
    echo "  Recover:  revert the profile commit and roll out again --"
    echo "    cd $COMPOSE_DIR && git revert <commit touching comms-profile/>"
    echo "    git push && velo update"
    echo ""
    return 1
}

update_all() {
    # NOTE (2026-08-06): a tmux wrapper (detached session + transcript) was
    # tried here and REJECTED after seeing it run -- it replaced the
    # terminal's colours, echoed mouse-wheel escape codes into the output,
    # and any tee-based transcript costs docker its tty (plain-text builds).
    # Durability, if wanted, belongs outside the script: run it under
    # `tmux`/`screen` on the operator's side. Anyone who wants a log:
    #   velo update 2>&1 | tee /tmp/update.log     (accepting plain output)

    # -- Self-update guard --------------------------------------------------
    # This file IS the product's checkout (the /usr/local/bin/velo shim execs
    # it straight from repo/scripts), and this very run pulls that checkout.
    # Bash reads a script incrementally, by byte offset, so rewriting the
    # file mid-run can drop the interpreter into the middle of a different
    # line. Run from a snapshot instead: the copy is immune to the pull, and
    # the NEXT invocation is already the new version.
    if [ "${VELO_UPDATE_SNAPSHOT:-0}" != "1" ]; then
        local snapshot
        snapshot=$(mktemp /tmp/velo-manage-snapshot.XXXXXX) || {
            echo -e "${RED}✗ Could not create the update snapshot${NC}"; exit 1; }
        cp "${BASH_SOURCE[0]}" "$snapshot" || {
            echo -e "${RED}✗ Could not snapshot ${BASH_SOURCE[0]}${NC}"; exit 1; }
        export VELO_UPDATE_SNAPSHOT=1 VELO_SNAPSHOT_PATH="$snapshot"
        exec bash "$snapshot" "$@"
    fi
    # In the snapshot run: clean up after ourselves whichever way we exit.
    trap 'rm -f "${VELO_SNAPSHOT_PATH:-}"' EXIT

    if [ "${VELO_BRANCH_INFERRED:-0}" = "1" ]; then
        echo -e "${YELLOW}ℹ VELO_BRANCH not recorded in $CONF_FILE -- inferred '${VELO_BRANCH}' from role '${VELO_ROLE}'${NC}"
    fi

    # Read-only pre-scan: --frontend-only is a deliberate narrow fast path
    # for iterating on the frontend, so it skips the service half entirely.
    # The flags themselves are parsed (and validated) inside update_product.
    local frontend_only=0 arg
    for arg in "$@"; do
        [ "$arg" = "--frontend-only" ] && frontend_only=1
    done

    local registry_before=""
    [ -f "$SERVICES_CONF" ] && registry_before=$(md5sum "$SERVICES_CONF" 2>/dev/null)

    local record lifecycle
    for record in "${VELO_SERVICES[@]}"; do
        lifecycle=$(svc_field "$record" 5)
        if [ "$lifecycle" != "internal" ] && [ "$frontend_only" -eq 1 ]; then
            echo -e "${YELLOW}⊘ $(svc_field "$record" 1): services skipped (--frontend-only)${NC}"
            echo ""
            continue
        fi
        if ! update_service "$record" "$@"; then
            echo -e "${RED}✗ Update stopped at '$(svc_field "$record" 1)' -- nothing after it was touched${NC}"
            exit 1
        fi
    done

    # -- Bound profiles: the SECOND restart (T-32 item 1) --------------------
    # The registry order is "services -> product", and it stays that way:
    # a service's CODE must be current before the product that calls it.
    # But a service whose PROFILE is bind-mounted out of the product's
    # checkout has a second dependency pointing the other way -- the data
    # only arrived a moment ago, in update_product's pull, long after that
    # service restarted. Without this pass a template edit would land on
    # disk now and reach the running service one update LATER.
    #
    # So: same order, one extra restart, and only for services that are
    # actually bound into this checkout. It is about DATA, not about the
    # code contract -- which is why it lives here and not in the registry.
    if [ "$frontend_only" -eq 0 ]; then
        for record in "${VELO_SERVICES[@]}"; do
            [ "$(svc_field "$record" 5)" = "internal" ] && continue
            reload_bound_profile "$record" || exit 1
        done
    fi

    # A registry change arrives WITH the product update, but the list was
    # read before that -- so a newly declared service starts being managed
    # on the next run. Say so instead of letting it look like a no-op.
    if [ -n "$registry_before" ] && [ -f "$SERVICES_CONF" ]; then
        if [ "$registry_before" != "$(md5sum "$SERVICES_CONF" 2>/dev/null)" ]; then
            echo ""
            echo -e "${CYAN}ℹ The service registry changed in this update.${NC}"
            echo "  Run 'velo update' once more to apply it."
        fi
    fi
}

update_product() {
        # Parse optional flags (order-independent).
        #   --skip-tests      Skip the backend test suite (keep everything else).
        #   --notests         Alias of --skip-tests. Neither touches the
        #                     frontend tests: those are a build step.
        #   --frontend-only   Skip the entire backend cycle: backend build,
        #                     full compose restart, migrations, backend tests
        #                     and `app` container restart. Only frontend gets
        #                     rebuilt. Refuses to run if backend/ changed in
        #                     the pulled commits (fool-proof guard).
        SKIP_TESTS=0
        FRONTEND_ONLY=0
        shift  # drop "update" / "deploy"
        while [ $# -gt 0 ]; do
            case "$1" in
                # --notests is the same switch under the name people
                # reach for first. Worth knowing what neither of them
                # does: the FRONTEND tests run inside the frontend
                # Dockerfile as a build step, so a red frontend test still
                # fails the build no matter which flag you pass.
                --skip-tests|--notests) SKIP_TESTS=1 ;;
                --frontend-only) FRONTEND_ONLY=1 ;;
                *)
                    echo -e "${RED}Unknown option: $1${NC}"
                    echo "Usage: velo update [--skip-tests|--notests] [--frontend-only]"
                    exit 1
                    ;;
            esac
            shift
        done

        # --frontend-only implies --skip-tests (no backend cycle = no tests).
        if [ $FRONTEND_ONLY -eq 1 ]; then
            SKIP_TESTS=1
        fi

        echo "=== Updating VELO ==="
        if [ $FRONTEND_ONLY -eq 1 ]; then
            echo -e "${CYAN}Mode: frontend-only (backend cycle skipped)${NC}"
        elif [ $SKIP_TESTS -eq 1 ]; then
            echo -e "${CYAN}Mode: skip-tests (backend tests skipped)${NC}"
        fi
        echo ""

        cd "$INSTALL_BASE/repo"

        # Save current state
        CURRENT_COMMIT=$(git rev-parse --short HEAD)
        BRANCH=$(git branch --show-current)
        echo "Current: $CURRENT_COMMIT ($BRANCH)"

        # Check for uncommitted changes -- two tiers.
        # Tier 1, deploy artifacts, reconciled silently: generated.ts is
        # re-derived from the running backend by every install/update, so a
        # tree copy differing from HEAD is business as usual (e.g. an update
        # that died before its drift-commit step leaves one behind -- the
        # 2026-07-27 night run did exactly that). Discarding is lossless by
        # construction: the file is derived output and this very update
        # re-derives it a few steps below; hand edits to a generated file
        # would be overwritten by that step anyway.
        # Tier 2, everything else, is presumed HUMAN work: show WHAT changed
        # (per-file diffstat, not just names), then ask before discarding.
        DEPLOY_ARTIFACTS="frontend/src/api/generated.ts"
        for f in $DEPLOY_ARTIFACTS; do
            if ! git diff --quiet HEAD -- "$f" 2>/dev/null; then
                echo -e "${CYAN}ℹ $f differs from HEAD — deploy artifact, reconciled automatically${NC}"
                git checkout HEAD -- "$f"
            fi
        done
        if ! git diff-index --quiet HEAD -- 2>/dev/null; then
            echo -e "${YELLOW}⚠ Uncommitted changes detected:${NC}"
            git status --short
            echo ""
            echo "What changed:"
            git --no-pager diff --stat HEAD
            echo ""
            echo "(full diff: cd $INSTALL_BASE/repo && git diff HEAD)"
            # NO QUESTION (H-D1, 2026-08-04). Nothing on this server is
            # edited by hand -- that is the law -- so a dirty tree is
            # drift, and drift gets fixed, not negotiated. Asking would
            # only stall an unattended run waiting for somebody who is
            # not supposed to be at this keyboard. The diffstat above is
            # printed FIRST on purpose: we discard silently-to-the-user
            # but never without a trace in the log.
            echo -e "${YELLOW}Discarding the above (server state is defined by the scripts)${NC}"
            # reset --hard, not `checkout -- .`: checkout restores the worktree
            # from the INDEX, so staged edits would survive and could still
            # break the pull below -- the prompt promises a discard, keep it.
            git reset --hard HEAD
        fi

        # Fetch and check
        git fetch origin
        if git diff --quiet HEAD "origin/$BRANCH" 2>/dev/null; then
            echo -e "${GREEN}✓ velo: already up to date${NC}"
            # return, NOT exit: this is one service in a cycle now, and
            # the product is the LAST of them -- but an exit here would
            # also swallow the cycle's own epilogue.
            return 0
        fi

        # Pull
        echo "Pulling updates..."
        if ! git pull origin "$BRANCH"; then
            echo -e "${RED}Pull failed. Resetting to origin/$BRANCH...${NC}"
            git reset --hard "origin/$BRANCH"
        fi

        NEW_COMMIT=$(git rev-parse --short HEAD)
        echo "Updated: $CURRENT_COMMIT → $NEW_COMMIT"
        echo ""

        # -- Narrow db env (T-32 item 9) ------------------------------------
        # docker-compose.yml points postgres/redis at ./backend/.env.db.
        # That file is NOT in git (it holds passwords) and NOT created by
        # `update` on a box that was never re-installed -- so the compose
        # that just arrived in the pull would fail on a missing env_file.
        # Project it here: AFTER the pull (the library itself may have just
        # arrived) and BEFORE the first compose command below.
        #
        # Sourced lazily for the same reason install_velo.sh sources
        # nginx-render.sh late: the version that matters is the one in the
        # checkout as it is NOW, not as it was when this process started.
        #
        # WHEN THE LIBRARY IS ABSENT there are two states, and they must
        # not share an outcome. The original guard skipped quietly in both,
        # which is right for one of them and hid the other:
        #
        #   - compose does NOT reference backend/.env.db -> a checkout
        #     predating T-32. Nothing to reconcile; skip, exit 0.
        #   - compose DOES reference it -> the delivery is INCOMPLETE. The
        #     compose that just arrived demands an env_file nothing can
        #     generate, so every later compose command in this run dies on
        #     a missing file, several steps from the cause.
        #
        # That second state is not hypothetical: T-32 landed in the repo in
        # pieces on 2026-08-12 and this library was in none of them, while
        # the compose change was. `velo update` failed with "env file
        # .../backend/.env.db not found" and the quiet skip above said
        # nothing on the way past. The compose file is the witness that
        # tells the two apart, so ask it.
        ENV_RENDER_LIB="$COMPOSE_DIR/scripts/env-render.sh"
        if [ ! -f "$ENV_RENDER_LIB" ]; then
            if grep -q 'backend/\.env\.db' "$COMPOSE_DIR/docker-compose.yml" 2>/dev/null; then
                echo -e "${RED}✗ Incomplete deployment: scripts/env-render.sh is missing${NC}"
                echo "  docker-compose.yml points postgres/redis at backend/.env.db,"
                echo "  and that file is generated by scripts/env-render.sh -- which is"
                echo "  not in this checkout. Nothing here can produce it, so every"
                echo "  compose command below would fail on a missing env_file."
                echo ""
                echo "  Expected at: $ENV_RENDER_LIB"
                echo "  Cause: the commit that brought this compose did not bring the"
                echo "  library with it. Commit the missing file, then re-run:"
                echo "    velo update"
                echo ""
                echo "  The stack is untouched -- the containers still running are the"
                echo "  ones from before this update."
                exit 1
            fi
            # Pre-T-32 checkout: no library, and no .env.db in its compose
            # either. Genuinely nothing to do.
            echo -e "${YELLOW}⊘ scripts/env-render.sh absent and not required by this compose -- skipping${NC}"
            echo ""
        else
            # shellcheck source=/dev/null
            source "$ENV_RENDER_LIB"
            if write_db_env "$COMPOSE_DIR/backend/.env" "$COMPOSE_DIR/backend/.env.db"; then
                echo -e "${GREEN}✓ backend/.env.db projected from backend/.env${NC}"
            else
                echo -e "${RED}✗ Could not write backend/.env.db${NC}"
                echo "  postgres/redis read it as their env_file -- the stack"
                echo "  would come up without database credentials."
                exit 1
            fi
            echo ""
        fi

        # Fool-proof guard for --frontend-only:
        # if backend/ changed between CURRENT_COMMIT and NEW_COMMIT, refuse hard.
        if [ $FRONTEND_ONLY -eq 1 ]; then
            if ! git diff --quiet "$CURRENT_COMMIT" "$NEW_COMMIT" -- backend/; then
                echo -e "${RED}✗ Detected changes in backend/ between $CURRENT_COMMIT and $NEW_COMMIT${NC}"
                echo -e "${RED}  Refusing to run with --frontend-only.${NC}"
                echo ""
                echo "Changed backend files:"
                git diff --name-only "$CURRENT_COMMIT" "$NEW_COMMIT" -- backend/ | sed 's/^/  /'
                echo ""
                echo "Run: velo update            (full cycle)"
                echo "  or velo update --skip-tests  (full cycle without tests)"
                exit 1
            fi
            echo -e "${GREEN}✓ No backend/ changes -- proceeding frontend-only${NC}"
            echo ""
        fi

        cd "$COMPOSE_DIR"
        set -a; source "$INSTALL_BASE/vite.env"; set +a

        if [ $FRONTEND_ONLY -eq 0 ]; then
            # -- 1. Build backend --
            echo "Building backend..."
            # Same shape as the frontend build gate below, and it is the
            # SECOND instance of the same bug: unguarded until 2026-07-17,
            # this exit code going unread meant a failing backend build fell
            # through to `up -d`, which restarted the PREVIOUS app image --
            # and everything after it (migrations, backend tests) then ran
            # and passed against code that was never rebuilt.
            if ! $COMPOSE_CMD build app; then
                echo -e "${RED}✗ BACKEND BUILD FAILED${NC}"
                echo "Nothing was deployed -- the previous app image is still running."
                echo "Fix the code and run: velo update"
                exit 1
            fi

            # -- 2. Recreate backend + infra -- frontend is DELIBERATELY not
            # named here, and there is deliberately no `down` first.
            #
            # `down` used to run here, stopping and removing EVERY container
            # in the project -- including frontend, which nothing in this
            # branch touches until step 4 builds a new frontend image. That
            # took the site down for the whole backend cycle on EVERY
            # successful update (minutes: build + migrate + tests), and
            # indefinitely if the frontend build then failed -- the message
            # at the bottom of this function ("the previous frontend image is
            # still running") was false: the IMAGE survived, the CONTAINER
            # did not (found live, 2026-07-17, via `velo status` showing no
            # velo-frontend right after a red run).
            #
            # `docker compose up -d <service>...` reconciles: it recreates a
            # NAMED service only if ITS OWN image/config actually changed
            # (app's image just did, at the build above), and leaves
            # postgres/redis alone if theirs did not. Nothing here makes
            # frontend a dependent of that recreation -- `frontend` depends
            # ON `app` in docker-compose.yml, not the other way around -- so
            # it is simply never touched by this line, in either direction:
            # it keeps serving its CURRENT image through the whole backend
            # cycle, and is only ever recreated at step 4, once a NEW image
            # exists and has passed its own build. A failed frontend build
            # now leaves the site exactly as it was a moment before.
            echo ""
            echo "Restarting backend services..."
            # THIRD instance of the same bug class (the two build gates in
            # this file are the first two): unguarded until 2026-07-26, a
            # failing `up -d` here fell through with the PREVIOUS app
            # container still running -- and everything downstream
            # (migrations, backend tests, the OpenAPI snapshot that
            # regenerates generated.ts) silently ran against the OLD code.
            # Found live: `up -d` died on the then-missing external network
            # `aivis-shared`, the update "passed" all the way to the
            # type-regen, and velo-bot pushed generated.ts stripped back to
            # the old API surface -- breaking the frontend build fleet-wide.
            ensure_shared_network || {
                echo -e "${RED}✗ Cannot create docker network aivis-shared${NC}"
                exit 1
            }
            if ! $COMPOSE_CMD up -d app postgres redis; then
                echo -e "${RED}✗ BACKEND RESTART FAILED${NC}"
                echo "The previous app container is still running. Stopping here,"
                echo "before migrations/tests/type-regen can run against old code."
                exit 1
            fi
            # Belt to the gate's braces: assert the container that will
            # serve migrations, tests and the OpenAPI snapshot actually
            # runs the image the build above just produced. The exit code
            # above catches a dead recreate; this catches a silent
            # non-recreate, whatever its future cause.
            APP_CID=$($COMPOSE_CMD ps -q app)
            RUNNING_IMG=$(docker inspect --format '{{.Image}}' "$APP_CID" 2>/dev/null)
            EXPECTED_IMG=$(docker image inspect --format '{{.Id}}' \
                "$(docker inspect --format '{{.Config.Image}}' "$APP_CID" 2>/dev/null)" 2>/dev/null)
            if [ -z "$APP_CID" ] || [ -z "$RUNNING_IMG" ] || [ "$RUNNING_IMG" != "$EXPECTED_IMG" ]; then
                echo -e "${RED}✗ Running app container does not match the freshly built image${NC}"
                echo "Refusing to run migrations/tests/type-regen against a stale backend."
                echo "Check: velo status && docker compose up -d app"
                exit 1
            fi

            # Run migrations
            echo ""
            echo "Running database migrations..."
            sleep 5
            $COMPOSE_CMD exec -T app python -m alembic upgrade head || {
                echo -e "${RED}✗ Migration failed!${NC}"
                echo "Check logs: velo logs app"
                exit 1
            }
            echo -e "${GREEN}✓ Migrations applied${NC}"

            # Run backend tests (unless --skip-tests) -- TEST ROLE ONLY.
            # The suite runs against the LIVE DB and (Phase 6 / T0) its
            # domain writes emit real comms sync events; on prod that is
            # forbidden by definition -- prod's deploy gate is a green
            # TEST server, not a local suite run against prod data.
            if [ "$VELO_ROLE" != "test" ]; then
                echo ""
                echo -e "${YELLOW}⊘ Backend tests skipped on role '$VELO_ROLE' (deploy gate is the test server)${NC}"
            elif [ $SKIP_TESTS -eq 0 ]; then
                echo ""
                echo "Running backend tests..."
                if ! $COMPOSE_CMD exec -T app python -m pytest tests/ -v --tb=short; then
                    echo -e "${RED}✗ BACKEND TESTS FAILED${NC}"
                    echo "Fix the code and run: velo update"
                    exit 1
                fi
                echo -e "${GREEN}✓ All backend tests passed${NC}"

                # The suite pollutes the comms projection with phantom
                # events (T0 finding #2), and this used to resync it right
                # here. It no longer does: the resync TRUNCATEs recipients
                # CASCADE, and once chats existed that cascade started
                # taking threads / messages / read-states with it -- every
                # update wiped the stand's conversations. A cleanup that
                # destroys real data is not something to run automatically
                # behind somebody's back; the phantom recipients it fixes
                # are harmless by comparison (they resolve to nobody).
                # Manual now, on purpose. Backlog: a reconcile-style resync
                # that converges without touching messaging.
                echo ""
                echo -e "${YELLOW}ℹ The suite left phantom rows in the comms projection.${NC}"
                echo "  Projection resync is MANUAL now: velo resync-comms"
                echo "  (it truncates -- it would wipe this stand's chats)"
            else
                echo ""
                echo -e "${YELLOW}⊘ Backend tests skipped (--skip-tests)${NC}"
            fi
        else
            echo -e "${YELLOW}⊘ Backend build / restart / migrate / tests skipped (--frontend-only)${NC}"
        fi

        # -- 3. Generate frontend types from live backend --
        # Make sure the backend is actually up before hitting its OpenAPI
        # endpoint (otherwise curl returns empty and the generator crashes).
        echo ""
        wait_for_backend || exit 1

        echo ""
        echo "Generating frontend API types from backend OpenAPI..."
        if ! curl -sf http://127.0.0.1:8000/openapi.json > /tmp/openapi.json; then
            echo -e "${RED}✗ Failed to fetch openapi.json from backend${NC}"
            echo "Check logs: velo logs app"
            rm -f /tmp/openapi.json
            exit 1
        fi
        if ! python3 "$COMPOSE_DIR/backend/scripts/generate_ts_types.py" \
            /tmp/openapi.json \
            "$COMPOSE_DIR/frontend/src/api/generated.ts"; then
            echo -e "${RED}✗ Type generation failed${NC}"
            rm -f /tmp/openapi.json
            exit 1
        fi
        rm -f /tmp/openapi.json
        echo -e "${GREEN}✓ Frontend types generated${NC}"

        # -- 3a. Commit & push regenerated generated.ts if it drifted --
        #
        # generated.ts is a committed build artifact: the backend OpenAPI is
        # the single source of truth, and this file is regenerated on every
        # update. If regeneration changed it, velo-bot commits and pushes so
        # the next `velo update` on any environment pulls up-to-date types via
        # plain git -- otherwise the file shows up as an uncommitted change on
        # the next run and gets discarded by the "Discard local changes?" step.
        #
        # Push uses the SSH config alias (origin -> git@github.com-velo:...),
        # which already binds the velo deploy key, so no GIT_SSH_COMMAND needed.
        #
        # Frontend developers MUST NOT edit generated.ts by hand -- it is
        # overwritten here. Frontend-only types live in frontend/src/api/types.ts.
        cd "$COMPOSE_DIR"
        if [ -n "$(git status --porcelain frontend/src/api/generated.ts)" ]; then
            echo ""
            echo "Schema drift detected -- committing regenerated generated.ts"

            git add frontend/src/api/generated.ts
            git -c user.name="velo-bot" -c user.email="bot@velo.local" commit -m \
"chore(types): regenerate generated.ts

Triggered by velo update on commit $NEW_COMMIT" || {
                echo -e "${RED}✗ Bot commit failed${NC}"
                exit 1
            }

            # Push with one retry: if a parallel push grabbed the branch first,
            # rebase on it once and retry. Beyond that warrants manual review.
            PUSH_OK=0
            for attempt in 1 2; do
                if git push origin "$BRANCH"; then
                    PUSH_OK=1
                    break
                fi
                if [ "$attempt" = "1" ]; then
                    echo "Push failed (likely a parallel push). Rebasing and retrying..."
                    git pull --rebase origin "$BRANCH" || break
                fi
            done

            if [ "$PUSH_OK" = "0" ]; then
                echo -e "${RED}✗ Failed to push regenerated types to GitHub${NC}"
                echo "  velo-bot commit exists locally in $COMPOSE_DIR but is not on origin."
                echo "  Resolve manually:"
                echo "    cd $COMPOSE_DIR && git push origin $BRANCH"
                exit 1
            fi
            echo -e "${GREEN}✓ velo-bot pushed regenerated types${NC}"
        else
            echo -e "${GREEN}✓ Types are in sync, no commit needed${NC}"
        fi

        # -- 4. Build and start frontend (with fresh types) --
        echo ""
        echo "Building frontend (tests run during build)..."
        # The frontend Dockerfile runs `npm run test` before bundling, so a red
        # test aborts THIS build. Without checking the exit code the script
        # would fall through to `up -d` and silently restart the PREVIOUS
        # image while printing success -- the gate would exist but never fire.
        # This script has no `set -e`, so the check must be explicit (same
        # shape as the backend build gate above).
        if ! $COMPOSE_CMD build frontend; then
            echo -e "${RED}✗ FRONTEND BUILD FAILED (unit tests run inside the build)${NC}"
            echo "Nothing was deployed -- the previous frontend image is still running."
            echo "Fix the code and run: velo update"
            exit 1
        fi
        $COMPOSE_CMD up -d frontend

        # Health check
        echo ""
        echo "Waiting for health check..."
        sleep 5
        HEALTH=$(curl -s http://127.0.0.1:8000/health 2>/dev/null)
        if echo "$HEALTH" | grep -q '"status"'; then
            echo ""
            echo -e "${GREEN}✓ Update complete. API is healthy.${NC}"
            echo "$HEALTH" | python3 -m json.tool 2>/dev/null || echo "$HEALTH"
        else
            echo -e "${RED}⚠ API health check failed after update${NC}"
            echo "Check logs: velo logs app"
        fi

        # -- 5. Lightweight cleanup --
        # Frequent updates pile up Docker layers and dangling images. Reap
        # only what's safe: dangling (<none>) images and build cache older
        # than 24h. Recent cache is kept so same-day rebuilds stay fast.
        # Volumes are never touched here.
        echo ""
        echo "Cleaning up Docker leftovers..."
        docker image prune -f > /dev/null 2>&1 || true
        docker builder prune -f --filter until=24h > /dev/null 2>&1 || true
        echo -e "${GREEN}✓ Cleanup done${NC}"
}

# -----------------------------------------------------------------------------
# Attendance dead-ends -- DATA drift, not config drift (H-R4 audit, class 4)
# -----------------------------------------------------------------------------
# Every other doctor check compares an install-time ARTIFACT against the repo.
# This one reads DATA, because the failure it looks for leaves no artifact and
# no error line: zoom_meetings.report_ingested_at is set unconditionally after
# an ingest, while the poller only ever selects meetings where it is NULL.
# Anything that becomes relevant AFTER the marker lands is never looked at
# again -- there is no second pass. The damage stays invisible until counted.
#
# Two populations, both silent:
#   A. the report was EMPTY when polled (Zoom had not finished preparing it):
#      everyone scored zero seconds and was written off as no_show. Afterwards
#      an unearned no_show cannot be told from a real one -- there are no
#      segments left to argue with.
#   B. a booking with no registrant row at ingest time: never considered, still
#      CONFIRMED, now unreachable -- even the deadline fallback, which exists
#      precisely to stop a booking sitting undecided forever, is reached only
#      through the same NULL filter.
#
# WARNS, NEVER FAILS. This reports history that is already written; a doctor
# that goes permanently red over yesterday's data stops being read, and then
# it stops catching config drift either. The exit code stays with the checks
# above.
check_attendance_deadends() {
    if ! $COMPOSE_CMD ps 2>/dev/null | grep -q postgres; then
        echo -e "${YELLOW}⊘ Attendance dead-ends: database not running, skipped${NC}"
        return 0
    fi

    local stuck blind
    stuck=$($COMPOSE_CMD exec -T postgres psql -U velo -d velo -tAc \
"SELECT count(DISTINCT p.id) FROM zoom_meetings zm \
 JOIN practices p ON p.id = zm.practice_id \
 JOIN bookings b ON b.practice_id = p.id \
 WHERE zm.report_ingested_at IS NOT NULL AND zm.status = 'active' \
   AND b.status = 'confirmed';" 2>/dev/null | tr -d '[:space:]')

    blind=$($COMPOSE_CMD exec -T postgres psql -U velo -d velo -tAc \
"SELECT count(*) FROM ( \
   SELECT p.id FROM zoom_meetings zm \
   JOIN practices p ON p.id = zm.practice_id \
   JOIN bookings b ON b.practice_id = p.id \
   WHERE zm.report_ingested_at IS NOT NULL \
     AND NOT EXISTS (SELECT 1 FROM zoom_attendance_segments s \
                     WHERE s.zoom_meeting_id = zm.id) \
   GROUP BY p.id \
   HAVING count(b.id) FILTER (WHERE b.status = 'attended') = 0 \
      AND count(b.id) FILTER (WHERE b.status = 'no_show') > 0) x;" \
        2>/dev/null | tr -d '[:space:]')

    # Non-numeric or empty output means the query did not run at all (schema
    # older than the zoom tables, credentials, container mid-restart). Say so
    # rather than print a reassuring zero nobody measured.
    case "$stuck$blind" in
        ""|*[!0-9]*)
            echo -e "${YELLOW}⊘ Attendance dead-ends: query did not run, skipped${NC}"
            return 0
            ;;
    esac

    if [ "$stuck" -eq 0 ] && [ "$blind" -eq 0 ]; then
        echo -e "${GREEN}✓ Attendance: no dead-ends (0 undecidable bookings, 0 blind no_shows)${NC}"
        return 0
    fi

    if [ "$stuck" -gt 0 ]; then
        echo -e "${YELLOW}⚠ Attendance: $stuck practice(s) hold CONFIRMED bookings that can never be decided${NC}"
        echo "    Their report marker is set, so the poller will not revisit them."
    fi
    if [ "$blind" -gt 0 ]; then
        echo -e "${YELLOW}⚠ Attendance: $blind practice(s) marked EVERYONE no_show with no segments at all${NC}"
        echo "    Consistent with an empty report at poll time -- those no_shows may be unearned."
    fi
    echo "    Inspect: velo db connect (queries in the H-R4 audit)."
    return 0
}

# -----------------------------------------------------------------------------
# Registry-driven reporting (H-D2)
# -----------------------------------------------------------------------------
# `status` and `version` used to describe the product only, which stopped being
# the whole truth the moment the box ran two stacks. Both now walk the same
# registry the update cycle does, so a service can never be managed by one and
# invisible to the other.
#
# Division of labour, same as in the update cycle: git state is read here (a
# checkout is a checkout), CONTAINER state is delegated to the service's own
# CLI. velo does not run docker commands against another service's stack --
# that mechanic lives in its repo, and duplicating it is how the two drift.

# Git one-liner for a checkout: "branch @ short-sha (date)" plus a tag when
# HEAD carries one. Prints nothing but a reason if the directory is not a
# checkout.
svc_git_line() {
    local dir="$1"
    if [ ! -d "$dir/.git" ]; then
        echo "no checkout at $dir"
        return 0
    fi
    local branch sha date tag
    branch=$(git -C "$dir" branch --show-current 2>/dev/null)
    sha=$(git -C "$dir" rev-parse --short HEAD 2>/dev/null)
    date=$(git -C "$dir" --no-pager log -1 --format='%ci' 2>/dev/null)
    tag=$(git -C "$dir" describe --tags --exact-match HEAD 2>/dev/null)
    printf '%s @ %s (%s)%s' \
        "${branch:-detached}" "${sha:-unknown}" "${date:-unknown}" \
        "${tag:+  tag: $tag}"
}

# Per-service section shared by `status` (with containers) and `version`
# (git only). Never fails the command: a missing service is a legitimate
# configuration, and a report that exits non-zero over it is useless.
svc_report() {
    local record="$1" with_containers="$2"
    local name dir lifecycle branch_expr want
    name=$(svc_field "$record" 1)
    dir=$(svc_field "$record" 3)
    branch_expr=$(svc_field "$record" 4)
    lifecycle=$(svc_field "$record" 5)

    if ! svc_installed "$record"; then
        echo -e "${YELLOW}⊘ $name: not installed${NC}"
        echo ""
        return 0
    fi

    want=$(svc_branch "$branch_expr" "$name" 2>/dev/null) || want="?"
    echo -e "${CYAN}--- $name ---${NC}"
    echo "  tracks:  $want"
    echo "  running: $(svc_git_line "$dir")"

    if [ "$with_containers" = "1" ] && [ "$lifecycle" != "internal" ]; then
        # Its own CLI, its own output format. Parsing it into a uniform
        # table would mean re-implementing its status here and breaking
        # silently the day it changes a column.
        #
        # Asked, not assumed (T-33 item 2): this used to call `status`
        # unconditionally, which is the same guessing every other command
        # here stopped doing. On a service that HAS `status` -- every
        # service today -- the branch below is the same call it always
        # was and the output is byte-identical. The alternative branch
        # exists for the third service that does not, so that its raw
        # usage text never lands inside our report.
        if verb_supported "$record" status; then
            bash "$dir/$lifecycle" status 2>&1 | sed 's/^/  /'
        else
            echo -e "  ${YELLOW}⊘ no such lifecycle verb -- 'status' not reported${NC}"
        fi
    fi
    echo ""
}

case "${1:-}" in

    # === Service Management ===

    # ORDER, and why it is not the same in both directions:
    #   start   -- FORWARD (providers, then the product). A provider has
    #              to be answering before the thing that calls it comes
    #              up; this is the order `depends_on` expresses inside a
    #              stack, applied between stacks.
    #   stop    -- REVERSE (product first, then providers). The other way
    #              round leaves a window in which the product is alive and
    #              talking to a service that is already gone -- errors in
    #              the log that describe our shutdown order, not a fault.
    #   restart -- reverse stop, then forward start. A full cycle, not
    #              "restart each in registry order".
    start)
        echo "Starting the box..."
        rc_total=0
        svc_walk forward start; rc_total=$(svc_worst "$rc_total" "$?")

        cd_compose
        ensure_shared_network
        if ! $COMPOSE_CMD up -d; then
            echo -e "${RED}✗ VELO failed to start${NC}"
            exit 1
        fi
        echo -e "${GREEN}✓ VELO started${NC}"

        # A provider that could not be started does NOT stop the product
        # from coming up: a box serving users without notifications beats
        # a box serving nobody. It does change the exit code.
        [ "$rc_total" -ne 0 ] && svc_report_incomplete start
        exit "$rc_total"
        ;;

    stop)
        echo "Stopping the box..."
        cd_compose
        $COMPOSE_CMD down
        echo -e "${GREEN}✓ VELO stopped${NC}"

        rc_total=0
        svc_walk reverse stop; rc_total=$(svc_worst "$rc_total" "$?")
        [ "$rc_total" -ne 0 ] && svc_report_incomplete stop
        exit "$rc_total"
        ;;

    restart)
        case "${2:-all}" in
            app)
                # Deliberately narrow and product-only: this is the
                # "bounce the API" shortcut, not a box-level verb.
                echo "Restarting app only..."
                cd_compose
                $COMPOSE_CMD restart app
                echo -e "${GREEN}✓ Restarted${NC}"
                ;;
            *)
                echo "Restarting the box..."
                rc_total=0

                cd_compose
                $COMPOSE_CMD down
                svc_walk reverse stop; rc_total=$(svc_worst "$rc_total" "$?")

                svc_walk forward start; rc_total=$(svc_worst "$rc_total" "$?")
                ensure_shared_network
                if ! $COMPOSE_CMD up -d; then
                    echo -e "${RED}✗ VELO failed to start${NC}"
                    exit 1
                fi
                echo -e "${GREEN}✓ Restarted${NC}"

                [ "$rc_total" -ne 0 ] && svc_report_incomplete restart
                exit "$rc_total"
                ;;
        esac
        ;;

    status)
        echo "=== Services on this box ==="
        echo ""
        for record in "${VELO_SERVICES[@]}"; do
            [ "$(svc_field "$record" 5)" = "internal" ] && continue
            svc_report "$record" 1
        done

        echo "=== VELO Service Status ==="
        echo ""
        cd_compose
        $COMPOSE_CMD ps
        echo ""

        # Health check
        echo "=== Health Check ==="
        HEALTH=$(curl -s http://127.0.0.1:8000/health 2>/dev/null)
        if [ -n "$HEALTH" ]; then
            echo "$HEALTH" | python3 -m json.tool 2>/dev/null || echo "$HEALTH"
        else
            echo -e "${RED}API not responding${NC}"
        fi
        echo ""

        # External check
        echo "=== External Access ==="
        EXT_HEALTH=$(curl -s "https://$DOMAIN_API/health" 2>/dev/null)
        if [ -n "$EXT_HEALTH" ]; then
            echo -e "${GREEN}✓ https://$DOMAIN_API/health is accessible${NC}"
        else
            echo -e "${YELLOW}⚠ https://$DOMAIN_API/health not accessible${NC}"
        fi
        echo ""

        # Disk & memory
        echo "=== Resources ==="
        echo "Disk: $(df -h /opt | tail -1 | awk '{print $3 "/" $2 " (" $5 ")"}')"
        echo "Memory: $(free -h | awk '/Mem:/ {print $3 "/" $2}')"
        # `docker images --format '{{.Size}}'` emits human-readable sizes
        # ("1.2GB", "450MB") with the unit baked into the string -- summing
        # those with `bc` (a plain number calculator) never parsed anything
        # real; it printed a stray number with no unit, from nowhere. `docker
        # system df` already computes a real total and formats it itself, so
        # there is nothing left to add or convert.
        DOCKER_IMAGES_SIZE=$(docker system df --format '{{.Type}} {{.Size}}' 2>/dev/null | awk '$1 == "Images" {print $2}')
        echo "Docker images: ${DOCKER_IMAGES_SIZE:-unknown} on disk"
        ;;

    # === Logs ===

    logs)
        cd_compose
        case "${2:-app}" in
            app)
                $COMPOSE_CMD logs -f --tail=100 app
                ;;
            db|postgres)
                $COMPOSE_CMD logs -f --tail=100 postgres
                ;;
            redis)
                $COMPOSE_CMD logs -f --tail=100 redis
                ;;
            frontend)
                $COMPOSE_CMD logs -f --tail=100 frontend
                ;;
            all|"")
                $COMPOSE_CMD logs -f --tail=100
                ;;
            *)
                # Registry services are tried AFTER the product's own
                # names, never before: `velo logs db` has meant the
                # product's postgres since day one, and a service that
                # happened to be named `db` must not quietly take that
                # over. Product vocabulary wins; the registry extends it.
                target="${2:-}"
                svc_match=""
                for record in "${VELO_SERVICES[@]}"; do
                    [ "$(svc_field "$record" 5)" = "internal" ] && continue
                    if [ "$(svc_field "$record" 1)" = "$target" ]; then
                        svc_match="$record"
                        break
                    fi
                done

                if [ -z "$svc_match" ]; then
                    echo "Usage: velo logs [app|db|redis|frontend|all$(
                        for record in "${VELO_SERVICES[@]}"; do
                            [ "$(svc_field "$record" 5)" = "internal" ] && continue
                            printf '|%s' "$(svc_field "$record" 1)"
                        done
                    )]"
                    exit 1
                fi

                # Its own CLI decides what "logs" means for it -- which
                # stream, how much tail, whether it follows. Imposing our
                # flags here would be velo deciding for a service it does
                # not own; extra arguments are passed straight through.
                shift 2 2>/dev/null || shift $#
                svc_run_verb "$svc_match" logs "$@"
                exit $?
                ;;
        esac
        ;;

    # === Testing & Linting ===

    test)
        # Backend pytest runs against the LIVE DB (and since T0 emits real
        # comms sync events) -- an explicit `velo test` on prod is as
        # forbidden as the update-time run. Frontend tests are container-
        # local, but the command keeps one rule for simplicity.
        if [ "$VELO_ROLE" != "test" ]; then
            echo -e "${RED}✗ 'velo test' is refused on role '$VELO_ROLE': the suite runs against the live DB.${NC}"
            echo "The deploy gate for prod is a green TEST server."
            exit 1
        fi
        FAILED=0
        case "${2:-all}" in
            backend)
                echo "=== Backend Tests ==="
                cd_compose
                if ! $COMPOSE_CMD exec -T app python -m pytest tests/ -v --tb=short; then
                    FAILED=1
                fi
                ;;
            frontend)
                echo "=== Frontend Tests ==="
                if ! run_frontend_tests; then
                    FAILED=1
                fi
                ;;
            all|"")
                echo "=== Backend Tests ==="
                cd_compose
                if ! $COMPOSE_CMD exec -T app python -m pytest tests/ -v --tb=short; then
                    FAILED=1
                fi
                echo ""
                echo "=== Frontend Tests ==="
                if ! run_frontend_tests; then
                    FAILED=1
                fi
                ;;
            *)
                echo "Usage: velo test [backend|frontend|all]"
                exit 1
                ;;
        esac

        echo ""
        if [ $FAILED -ne 0 ]; then
            echo -e "${RED}✗ Some tests failed${NC}"
            exit 1
        else
            echo -e "${GREEN}✓ All tests passed${NC}"
        fi
        ;;

    lint)
        cd_compose
        $COMPOSE_CMD exec -T app python -m ruff check app/ tests/
        ;;

    # === Update & Deploy ===

    update|deploy)
        update_all "$@"
        ;;

    # === Backup ===

    # === Comms projection resync (test contour only, T0 finding #2) ===

    resync-comms)
        resync_comms_projection || exit 1
        ;;

    # === Comms outbox dead-letter queue (H-R3 relay hardening) ===
    # Thin pass-through: all logic lives in scripts/comms_outbox.py
    # (backed by app/core/events/outbox_admin.py, service-tested).
    #   velo comms-outbox list-dead
    #   velo comms-outbox requeue <event-id> [...] | --all
    comms-outbox)
        shift
        cd_compose
        $COMPOSE_CMD exec -T app python scripts/comms_outbox.py "$@" || exit 1
        ;;

    backup)
        TIMESTAMP=$(date +%Y%m%d_%H%M%S)
        BACKUP_DIR="$INSTALL_BASE/backups"
        mkdir -p "$BACKUP_DIR"
        # T-14/T-32 item 8: a full pg_dump is the entire user table --
        # names, telegram ids, bookings. It used to land with whatever the
        # process umask gave it (typically 644), readable by every user on
        # the machine. 700 on the directory, 600 on the files, applied to
        # BOTH dump paths (`backup` here and `db dump` below).
        chmod 700 "$BACKUP_DIR"

        echo "Creating backup..."

        # Back up the DATABASE ONLY, straight to a gzipped SQL dump.
        # backend/.env is deliberately NOT backed up: its secrets are
        # recreated from their own sources (a fresh install regenerates the DB
        # password, the bot token lives in BotFather, Stripe keys in Stripe).
        cd_compose
        BACKUP_FILE="$BACKUP_DIR/velo_db_$TIMESTAMP.sql.gz"
        # umask BEFORE the redirect, not chmod after it: `> "$BACKUP_FILE"`
        # creates the file with the process umask and the dump starts
        # streaming into it immediately, so a later chmod would leave a
        # window in which the PII dump is world-readable. Not a subshell --
        # PIPESTATUS below must stay readable.
        OLD_UMASK=$(umask)
        umask 077
        $COMPOSE_CMD exec -T postgres pg_dump -U velo velo | gzip > "$BACKUP_FILE"
        # Captured on the VERY next line: any command in between (umask
        # included) would overwrite PIPESTATUS.
        DUMP_STATUS=${PIPESTATUS[0]}
        umask "$OLD_UMASK"

        # Abort if pg_dump (first stage of the pipe) failed -- otherwise we
        # would keep a truncated/empty archive and believe it succeeded.
        if [ "$DUMP_STATUS" -ne 0 ]; then
            rm -f "$BACKUP_FILE"
            echo -e "${RED}✗ Backup failed (pg_dump error)${NC}"
            exit 1
        fi

        echo -e "${GREEN}✓ Backup created: $BACKUP_FILE${NC}"

        # Rotate old backups (keep last 7 days, local only)
        find "$BACKUP_DIR" -name "velo_db_*.sql.gz" -mtime +7 -delete
        BACKUP_COUNT=$(find "$BACKUP_DIR" -name "velo_db_*.sql.gz" | wc -l)
        echo "Total backups: $BACKUP_COUNT (auto-rotating after 7 days)"
        ;;

    # === Database ===

    db)
        cd_compose
        case "${2:-}" in
            connect|psql)
                echo "Connecting to PostgreSQL..."
                $COMPOSE_CMD exec postgres psql -U velo velo
                ;;
            dump)
                TIMESTAMP=$(date +%Y%m%d_%H%M%S)
                OUTPUT="$INSTALL_BASE/backups/db_dump_$TIMESTAMP.sql"
                mkdir -p "$INSTALL_BASE/backups"
                # Same file, same directory, same PII as `velo backup` --
                # and this one is PLAIN sql. Same discipline: 700 on the
                # directory, umask around the redirect, 600 on the file.
                chmod 700 "$INSTALL_BASE/backups"
                echo "Dumping database..."
                OLD_UMASK=$(umask)
                umask 077
                if ! $COMPOSE_CMD exec -T postgres pg_dump -U velo velo > "$OUTPUT"; then
                    umask "$OLD_UMASK"
                    rm -f "$OUTPUT"
                    echo -e "${RED}✗ Dump failed (pg_dump error)${NC}"
                    exit 1
                fi
                umask "$OLD_UMASK"
                echo -e "${GREEN}✓ Dump saved: $OUTPUT${NC}"
                ;;
            restore)
                if [ -z "${3:-}" ]; then
                    echo "Usage: velo db restore <dump_file>"
                    exit 1
                fi
                if [ ! -f "$3" ]; then
                    echo -e "${RED}✗ File not found: $3${NC}"
                    exit 1
                fi
                echo -e "${RED}⚠ This will OVERWRITE the current database!${NC}"
                read -p "Are you sure? (y/n): " -n 1 -r
                echo
                if [[ $REPLY =~ ^[Yy]$ ]]; then
                    echo "Restoring database..."
                    # Redirected in (not piped through `cat`) so the psql exit
                    # code is the ONLY exit code -- no PIPESTATUS needed, and
                    # nothing to silently swallow.
                    if $COMPOSE_CMD exec -T postgres psql -U velo velo < "$3"; then
                        echo -e "${GREEN}✓ Database restored${NC}"
                    else
                        echo -e "${RED}✗ Restore FAILED -- database may be in a partial state.${NC}"
                        echo "Check logs: velo logs db"
                        exit 1
                    fi
                fi
                ;;
            migrate)
                echo "Running Alembic migrations..."
                if $COMPOSE_CMD exec -T app python -m alembic upgrade head; then
                    echo -e "${GREEN}✓ Migrations complete${NC}"
                else
                    echo -e "${RED}✗ Migration FAILED${NC}"
                    exit 1
                fi
                ;;
            *)
                echo "Database commands:"
                echo "  velo db connect        — Connect to PostgreSQL (psql)"
                echo "  velo db dump           — Create database dump"
                echo "  velo db restore <file> — Restore from dump"
                echo "  velo db migrate        — Run Alembic migrations"
                ;;
        esac
        ;;

    # === SSL ===

    ssl)
        case "${2:-}" in
            renew)
                echo "Renewing SSL certificate..."
                if certbot renew --quiet --post-hook 'systemctl reload nginx'; then
                    echo -e "${GREEN}✓ Done${NC}"
                else
                    echo -e "${RED}✗ Certificate renewal FAILED${NC}"
                    exit 1
                fi
                ;;
            status)
                echo "SSL certificate status:"
                certbot certificates 2>/dev/null || echo "No certificates found"
                ;;
            *)
                echo "SSL commands:"
                echo "  velo ssl renew  — Renew SSL certificate"
                echo "  velo ssl status — Show certificate info"
                ;;
        esac
        ;;

    # === Version ===

    version)
        echo -e "${CYAN}VELO Management Script${NC}"
        echo ""
        for record in "${VELO_SERVICES[@]}"; do
            [ "$(svc_field "$record" 5)" = "internal" ] && continue
            svc_report "$record" 0
        done

        cd "$INSTALL_BASE/repo" 2>/dev/null && {
            echo -n "Repo HEAD:   "
            git rev-parse --short HEAD 2>/dev/null || echo "unknown"
            echo -n "Branch:      "
            git branch --show-current 2>/dev/null || echo "unknown"

            # `git log` is one of git's paging commands -- unlike rev-parse
            # and branch above, it can hand its output to a pager (less)
            # instead of the terminal when stdout is a real tty (which it is
            # here: `velo version` is run interactively), regardless of how
            # short the output is. Captured into a variable first: a command
            # substitution's stdout is a pipe, never a tty, so git never
            # invokes a pager for it, and the label is echoed together with
            # the value in one statement -- there is no longer a separate
            # `echo -n` for a pager to run ahead of or hide.
            COMMIT_DATE=$(git --no-pager log -1 --format="%ci" 2>/dev/null)
            echo "Commit date: ${COMMIT_DATE:-unknown}"

            SCRIPT_LAST_CHANGED=$(git --no-pager log -1 --format="%h (%ci)" -- scripts/velo-manage.sh 2>/dev/null)
            echo "This script last changed: ${SCRIPT_LAST_CHANGED:-unknown}"

            # The honest check, in place of a hand-bumped label: this file
            # only ever runs the code that is actually checked out, so the one
            # way it could differ from what git HEAD says is a local
            # hand-edit -- check for that directly instead of trusting a
            # version string someone has to remember to update.
            echo ""
            if ! git diff --quiet HEAD -- scripts/velo-manage.sh 2>/dev/null; then
                echo -e "${YELLOW}⚠ scripts/velo-manage.sh has UNCOMMITTED local changes --${NC}"
                echo -e "${YELLOW}  the script actually running differs from git HEAD:${NC}"
                git diff --stat HEAD -- scripts/velo-manage.sh 2>/dev/null | sed 's/^/  /'
            else
                echo -e "${GREEN}✓ Running script matches git HEAD exactly -- no local drift${NC}"
            fi
        }
        echo ""
        # Sanity-check the shim itself: is /opt/velo/scripts/manage.sh still
        # the thin exec wrapper, or has something replaced it with a copy of
        # its own again (the old disease, reappearing at the one remaining
        # generated file)?
        SHIM="$INSTALL_BASE/scripts/manage.sh"
        if [ -f "$SHIM" ] && grep -q "exec .*velo-manage\.sh" "$SHIM" 2>/dev/null; then
            echo -e "${GREEN}✓ Shim ($SHIM) delegates to the tracked script${NC}"
        else
            echo -e "${YELLOW}⚠ $SHIM does not look like the expected shim -- check it by hand${NC}"
        fi
        echo ""
        cd_compose
        echo "Docker containers:"
        $COMPOSE_CMD ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || $COMPOSE_CMD ps
        ;;

    # === Doctor (drift watchman) ===

    # `version` above answers "does the running script match git HEAD" --
    # this answers a different question: do the artifacts written ONCE at
    # provisioning time (vite.env, backend/.env) still match what the
    # tracked repo says they should contain. Kept as a separate command
    # rather than folded into `version` on purpose: each prints exactly what
    # it checked, and merging two different questions into one report is
    # the same class of bug that made "v1.4" and "still running" lie.
    rotate-key)
        # Replace a compromised GitHub deploy key for one registry
        # service, on a box whose owner has NO command-line access to
        # GitHub -- only the web UI. That constraint shapes everything
        # here: this cannot be atomic, so it is made SAFE instead.
        #
        # The order is the whole design. The new key is generated
        # ALONGSIDE the old one, verified with the new key ALONE, and
        # only then does anything change. Until the probe passes, the
        # working key is still the working key and ~/.ssh/config has not
        # been touched -- abandoning the ritual half-way costs nothing.
        svc_name="${2:-}"
        if [ -z "$svc_name" ]; then
            echo "Usage: velo rotate-key <service>"
            echo "Services in the registry:"
            for record in "${VELO_SERVICES[@]}"; do
                echo "  $(svc_field "$record" 1)  ($(svc_field "$record" 2), access: $(svc_field "$record" 7))"
            done
            exit 1
        fi

        # Validated against the registry, never taken as a path
        # fragment: this name becomes a filename and an ssh host alias.
        svc_record=""
        for record in "${VELO_SERVICES[@]}"; do
            if [ "$(svc_field "$record" 1)" = "$svc_name" ]; then
                svc_record="$record"
                break
            fi
        done
        if [ -z "$svc_record" ]; then
            echo -e "${RED}✗ '$svc_name' is not declared in $SERVICES_CONF${NC}"
            echo "Known services:"
            for record in "${VELO_SERVICES[@]}"; do
                echo "  $(svc_field "$record" 1)"
            done
            exit 1
        fi

        svc_repo=$(svc_field "$svc_record" 2)
        svc_access=$(svc_field "$svc_record" 7)
        key_old="/root/.ssh/id_ed25519_${svc_name}_deploy"
        key_new="${key_old}.new"
        ssh_alias="github.com-${svc_name}"

        if [ ! -f "$key_old" ]; then
            echo -e "${RED}✗ No existing key at $key_old${NC}"
            echo "  Nothing to rotate. A missing key is an install problem,"
            echo "  not a rotation one -- see install_velo.sh."
            exit 1
        fi

        echo "=== Rotating the deploy key for '$svc_name' ==="
        echo ""

        rm -f "$key_new" "${key_new}.pub"
        if ! ssh-keygen -t ed25519 -C "${svc_name}-deploy@$(hostname)" -f "$key_new" -N "" >/dev/null; then
            echo -e "${RED}✗ Could not generate a new key${NC}"
            exit 1
        fi
        echo -e "${GREEN}✓ New key generated at $key_new (the old one is untouched)${NC}"
        echo ""

        echo -e "${CYAN}═══════════════════════════════════════════════${NC}"
        echo -e "${CYAN}  New deploy key for ${svc_repo}${NC}"
        echo -e "${CYAN}═══════════════════════════════════════════════${NC}"
        echo ""
        cat "${key_new}.pub"
        echo ""
        echo "In a browser:"
        echo "  1. Open https://github.com/${svc_repo}/settings/keys"
        echo "  2. 'Add deploy key', paste the key above, give it a title"
        echo "     that says it is the new one (e.g. '${svc_name} $(date +%Y-%m-%d)')"
        if [ "$svc_access" = "write" ]; then
            echo -e "  3. ${RED}Tick 'Allow write access'${NC} -- this repo is declared"
            echo "     access=write in the registry, and 'velo update' pushes to it."
        else
            echo -e "  3. ${GREEN}Leave 'Allow write access' unticked${NC} -- this repo is"
            echo "     declared access=read in the registry."
        fi
        echo "  4. ADD the new key first. Do NOT delete the old one yet --"
        echo "     if you delete it now and the new key turns out wrong,"
        echo "     this box loses access to the repo entirely."
        echo ""
        read -r -p "Press ENTER once the NEW key is added on GitHub..."
        echo ""

        # Probed with -i and IdentitiesOnly so ONLY the new key is
        # offered, and without touching ~/.ssh/config: a failure here
        # must leave the box exactly as it was found.
        echo "Testing the new key..."
        rotate_banner=$(ssh -T -i "$key_new" -o IdentitiesOnly=yes \
                            -o StrictHostKeyChecking=accept-new \
                            git@github.com 2>&1 || true)
        if ! echo "$rotate_banner" | grep -q "successfully authenticated"; then
            echo -e "${RED}✗ The new key does NOT authenticate to GitHub.${NC}"
            echo ""
            echo "GitHub said:"
            echo "$rotate_banner" | sed 's/^/  /'
            echo ""
            echo -e "${GREEN}Nothing was changed.${NC} The old key is still in place and"
            echo "still working -- ~/.ssh/config has not been touched."
            echo "Remove the half-added key from GitHub if you like, fix the"
            echo "cause, and run 'velo rotate-key $svc_name' again."
            rm -f "$key_new" "${key_new}.pub"
            exit 1
        fi
        echo -e "${GREEN}✓ The new key authenticates${NC}"
        echo ""

        # Point of no return -- deliberately AFTER the probe.
        mv -f "$key_new" "$key_old"
        mv -f "${key_new}.pub" "${key_old}.pub"
        chmod 600 "$key_old"
        echo -e "${GREEN}✓ New key installed at $key_old${NC}"

        # The host alias already points at this path, so nothing in
        # ~/.ssh/config has to change and no git remote moves. That is
        # why install writes the alias instead of a bare IdentityFile.
        if github_probe_alias "$ssh_alias"; then
            echo -e "${GREEN}✓ $ssh_alias authenticates with the new key${NC}"
        else
            echo -e "${RED}✗ The alias '$ssh_alias' does not authenticate.${NC}"
            echo "  The new key works directly, so the alias itself is wrong."
            echo "  Check /root/.ssh/config -- IdentityFile should be $key_old"
            exit 1
        fi

        echo ""
        echo -e "${YELLOW}ONE STEP LEFT, and it is not optional:${NC}"
        echo "  Open https://github.com/${svc_repo}/settings/keys and DELETE"
        echo "  the OLD deploy key. Until you do, the key you are rotating"
        echo "  away from still opens this repo -- which is the whole point"
        echo "  of rotating it."
        echo ""
        echo "  This box cannot do it: removing a deploy key needs the"
        echo "  GitHub API, and nothing here holds an API token. The private"
        echo "  half is already gone from this machine."
        ;;

    doctor)
        echo -e "${CYAN}VELO Doctor -- drift watchman${NC}"
        echo "Checks artifacts written once at install time and never"
        echo "regenerated by 'velo update', against the tracked repo."
        echo ""

        VITE_DRIFT=0
        BACKEND_DRIFT=0
        NGINX_DRIFT=0

        check_vite_env "$COMPOSE_DIR/docker-compose.yml" "$INSTALL_BASE/vite.env" "$COMPOSE_DIR/frontend/src" || VITE_DRIFT=1
        echo ""
        check_backend_env "$COMPOSE_DIR/backend/.env.example" "$COMPOSE_DIR/backend/.env" || BACKEND_DRIFT=1
        echo ""
        check_nginx "$COMPOSE_DIR/scripts/nginx-render.sh" "/etc/nginx/sites-available/velo" "${DOMAIN_FRONTEND:-}" "${DOMAIN_API:-}" "${DOMAIN_PUBLIC:-}" || NGINX_DRIFT=1
        echo ""

        check_attendance_deadends
        echo ""

        echo "Checked: vite.env keys, backend/.env keys, nginx config (rendered vs"
        echo "live), attendance dead-ends (data -- warns only, never fails)."
        if [ "$VITE_DRIFT" -eq 0 ] && [ "$BACKEND_DRIFT" -eq 0 ] && [ "$NGINX_DRIFT" -eq 0 ]; then
            echo -e "${GREEN}✓ 0 drift found${NC}"
            exit 0
        else
            echo -e "${RED}✗ DRIFT FOUND -- see the FAIL lines above${NC}"
            exit 1
        fi
        ;;

    # === Seed ===

    seed)
        # Profile-driven seed, test contour only. Same role gate the old
        # seed-demo carried: seeding invents users and practices, which has
        # no business happening on a production database.
        if [ "$VELO_ROLE" != "test" ]; then
            echo -e "${RED}✗ seed is a test-contour ritual; refusing on role '$VELO_ROLE'${NC}"
            exit 1
        fi
        cd_compose
        # Args pass straight through to the script, which parses them:
        #   velo seed                      -- default profile
        #   velo seed --profile 15082026   -- a named profile
        #   velo seed --reset              -- wipe seeded data first
        #   velo seed --list               -- show available profiles
        shift  # drop "seed"
        $COMPOSE_CMD exec -T app python scripts/seed.py "$@"
        ;;

    # === Roles ===

    setrole)
        cd_compose
        # Pass args straight through to the ORM script (it parses/validates):
        #   velo setrole <telegram_id> <A|M|U> [--yes]
        #   velo setrole                    -> list current admins & masters
        # No -T on exec: keep a TTY so the field prompts + y/n confirm work.
        shift  # drop "setrole"
        $COMPOSE_CMD exec app python scripts/set_role.py "$@"
        ;;

    # === Nginx ===

    nginx)
        case "${2:-}" in
            reload)
                echo "Reloading Nginx..."
                if nginx -t && systemctl reload nginx; then
                    echo -e "${GREEN}✓ Nginx reloaded${NC}"
                else
                    echo -e "${RED}✗ Nginx reload FAILED (nginx -t reported a config error)${NC}"
                    exit 1
                fi
                ;;
            status)
                systemctl status nginx --no-pager -l
                ;;
            *)
                echo "Nginx commands:"
                echo "  velo nginx reload — Reload Nginx config"
                echo "  velo nginx status — Show Nginx status"
                ;;
        esac
        ;;

    # === Generate Types ===

    gen-types)
        echo "Generating frontend types from backend OpenAPI..."
        cd_compose
        # -f (fail on HTTP error) is required, not cosmetic: without it curl
        # exits 0 on a 500 and writes the error body to the file, so the `||`
        # guard below would never fire and the generator would run against a
        # backend error page instead of an OpenAPI schema.
        if ! curl -sf http://127.0.0.1:8000/openapi.json > /tmp/openapi.json; then
            echo -e "${RED}✗ Cannot reach backend API. Is it running?${NC}"
            rm -f /tmp/openapi.json
            exit 1
        fi
        if ! python3 "$COMPOSE_DIR/backend/scripts/generate_ts_types.py" \
            /tmp/openapi.json \
            "$COMPOSE_DIR/frontend/src/api/generated.ts"; then
            echo -e "${RED}✗ Type generation FAILED${NC}"
            rm -f /tmp/openapi.json
            exit 1
        fi
        rm -f /tmp/openapi.json
        echo -e "${GREEN}✓ generated.ts updated${NC}"

        # Manual regeneration does NOT commit or push -- that is `velo update`'s
        # job (it commits as velo-bot and pushes). Here we only write the file
        # and flag drift, so a developer iterating on a Pydantic schema on the
        # VPS can refresh types without a full deploy.
        if [ -n "$(git status --porcelain frontend/src/api/generated.ts)" ]; then
            echo -e "${YELLOW}⚠ generated.ts changed -- not committed${NC}"
            echo "  Run 'velo update' to commit & push, or commit by hand."
        else
            echo -e "${GREEN}✓ generated.ts is already in sync${NC}"
        fi
        ;;

    # === Help ===

    *)
        echo -e "${CYAN}VELO Management Script${NC}"
        echo "Usage: velo {command} [options]"
        echo ""
        echo "Service Management (the whole box: this product AND every"
        echo "service in scripts/services.conf):"
        echo "  start               — Start everything (services first, then the product)"
        echo "  stop                — Stop everything (product first, then services)"
        echo "  restart [app]       — Full stop+start cycle (or just the app container)"
        echo "  status              — Show status + health check (every service)"
        echo "  Exit codes: 0 = done · 2 = done but INCOMPLETE (a service could"
        echo "  not take part; it is named in the output) · 1 = failed"
        echo ""
        echo "Logs:"
        echo "  logs [app|db|redis|frontend|<service>] — View logs (default: app)"
        echo "                        Product names first; then any registry service."
        echo ""
        echo "Keys:"
        echo "  rotate-key <service> — Replace a compromised GitHub deploy key."
        echo "                        Generates the new key alongside the old one and"
        echo "                        swaps only after verifying it. Web instructions"
        echo "                        for GitHub -- no command-line access needed."
        echo ""
        echo "Testing:"
        echo "  test                — Run all tests (backend + frontend)"
        echo "  test backend        — Run backend tests only"
        echo "  test frontend       — Run frontend tests only"
        echo "  lint                — Run linter (ruff)"
        echo ""
        echo "Deployment:"
        echo "  update              — Pull, rebuild, migrate, test, restart"
        echo "    --skip-tests        Skip backend tests (everything else runs)"
        echo "    --notests           Alias of --skip-tests (frontend tests are"
        echo "                        a build step -- no flag skips them)"
        echo "    --frontend-only     Skip whole backend cycle; refuses if backend/ changed"
        echo "  gen-types           — Regenerate frontend types from backend"
        echo "  resync-comms        — Rebuild the comms projection (test server only)."
        echo "                        DESTRUCTIVE: truncates recipients CASCADE, which"
        echo "                        takes threads/messages/read-states with it. MANUAL"
        echo "                        since H-D2 -- update no longer runs it. Use after"
        echo "                        'velo seed' (seeds bypass the emits) or after the"
        echo "                        suite leaves phantom rows."
        echo "  comms-outbox        — Outbox dead-letter queue: list-dead |"
        echo "                        requeue <id> [...] | requeue --all"
        echo ""
        echo "Database:"
        echo "  db connect          — Open psql session"
        echo "  db dump             — Create SQL dump"
        echo "  db restore <file>   — Restore from dump"
        echo "  db migrate          — Run Alembic migrations"
        echo "  seed                — Seed the stand from a profile (test only)"
        echo "  seed --profile <name> — Use a named profile (default: default)"
        echo "  seed --list         — List available profiles"
        echo "  seed --reset        — Wipe seeded data, then re-seed"
        echo ""
        echo "Roles:"
        echo "  setrole <tg> <A|M|U>  — Set a user's role (admin/master/user)"
        echo "  setrole               — List current admins & masters"
        echo ""
        echo "Maintenance:"
        echo "  backup              — Backup DB (gzipped dump)"
        echo "  ssl renew           — Renew SSL certificate"
        echo "  ssl status          — Show certificate info"
        echo "  nginx reload        — Reload Nginx config"
        echo "  version             — Show what is actually running + drift check"
        echo "  doctor              — Check vite.env / backend/.env / nginx for drift,"
        echo "                        plus attendance dead-ends in the data (warns)"
        ;;
esac
