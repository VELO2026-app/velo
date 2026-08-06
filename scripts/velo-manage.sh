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
    VELO_SERVICES=("velo|aivis-one/velo|$COMPOSE_DIR|conf:VELO_BRANCH|internal|update_product")
    svc_field() {
        local record="$1" index="$2"
        local IFS='|'
        # shellcheck disable=SC2206
        local fields=($record)
        printf '%s' "${fields[$((index - 1))]}"
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

# Run frontend tests in a throwaway builder container.
# Uses `docker build --target builder` to get a container with node + source,
# then runs `npm run test` inside it.
run_frontend_tests() {
    echo "Running frontend tests..."
    cd "$COMPOSE_DIR"
    # The build's own exit code is checked explicitly (not folded into the
    # `docker run` check below): the original bug here was exactly this build
    # failing silently, `docker run` then executing the PREVIOUS successful
    # image under the same tag, and the caller reading that stale run as
    # today's test result. `-q` keeps docker's own noise down; stderr is left
    # unredirected (the old code sent it to /dev/null too) so a real build
    # failure is visible instead of just "FAILED" with no reason.
    if ! docker build --target builder -t velo-frontend-test -f frontend/Dockerfile frontend/ -q > /dev/null; then
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

# ПРОМТ №563: a key missing from the real .env is only genuinely DRIFT if
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
        expected=$(render_nginx_ssl "$domain_frontend" "$domain_api")
    else
        variant="http-only"
        expected=$(render_nginx_http "$domain_frontend" "$domain_api")
    fi
    echo "      live config detected as: $variant (domains: $domain_frontend / $domain_api)"

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
                --skip-tests)    SKIP_TESTS=1 ;;
                --frontend-only) FRONTEND_ONLY=1 ;;
                *)
                    echo -e "${RED}Unknown option: $1${NC}"
                    echo "Usage: velo update [--skip-tests] [--frontend-only]"
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

                # The suite just polluted the comms projection with
                # phantom events (T0 finding #2) -- resync it. Test
                # contour only; see resync_comms_projection.
                echo ""
                resync_comms_projection || exit 1
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

case "${1:-}" in

    # === Service Management ===

    start)
        echo "Starting VELO..."
        cd_compose
        ensure_shared_network
        $COMPOSE_CMD up -d
        echo -e "${GREEN}✓ Started${NC}"
        ;;

    stop)
        echo "Stopping VELO..."
        cd_compose
        $COMPOSE_CMD down
        echo -e "${GREEN}✓ Stopped${NC}"
        ;;

    restart)
        case "${2:-all}" in
            app)
                echo "Restarting app only..."
                cd_compose
                $COMPOSE_CMD restart app
                ;;
            *)
                echo "Restarting all services..."
                cd_compose
                $COMPOSE_CMD down
                ensure_shared_network
                $COMPOSE_CMD up -d
                ;;
        esac
        echo -e "${GREEN}✓ Restarted${NC}"
        ;;

    status)
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
                echo "Usage: velo logs [app|db|redis|frontend|all]"
                exit 1
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

        echo "Creating backup..."

        # Back up the DATABASE ONLY, straight to a gzipped SQL dump.
        # backend/.env is deliberately NOT backed up: its secrets are
        # recreated from their own sources (a fresh install regenerates the DB
        # password, the bot token lives in BotFather, Stripe keys in Stripe).
        cd_compose
        BACKUP_FILE="$BACKUP_DIR/velo_db_$TIMESTAMP.sql.gz"
        $COMPOSE_CMD exec -T postgres pg_dump -U velo velo | gzip > "$BACKUP_FILE"

        # Abort if pg_dump (first stage of the pipe) failed -- otherwise we
        # would keep a truncated/empty archive and believe it succeeded.
        if [ "${PIPESTATUS[0]}" -ne 0 ]; then
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
                echo "Dumping database..."
                if ! $COMPOSE_CMD exec -T postgres pg_dump -U velo velo > "$OUTPUT"; then
                    rm -f "$OUTPUT"
                    echo -e "${RED}✗ Dump failed (pg_dump error)${NC}"
                    exit 1
                fi
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
        check_nginx "$COMPOSE_DIR/scripts/nginx-render.sh" "/etc/nginx/sites-available/velo" "${DOMAIN_FRONTEND:-}" "${DOMAIN_API:-}" || NGINX_DRIFT=1
        echo ""

        echo "Checked: vite.env keys, backend/.env keys, nginx config (rendered vs live)."
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
        echo "Running database seed..."
        cd_compose
        SEED_ARGS=""
        if [ "${2:-}" = "--reset" ]; then
            SEED_ARGS="--reset"
        fi
        $COMPOSE_CMD exec app python scripts/seed.py $SEED_ARGS
        ;;

    seed-practices)
        echo "Running seed_practices..."
        cd_compose
        # Прокидываем все аргументы (--reset / --clean / --dry-run / --yes
        # и их комбинации) напрямую в скрипт — он сам их парсит через argparse.
        shift  # отбрасываем "seed-practices"
        $COMPOSE_CMD exec app python scripts/seed_practices.py "$@"
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
        echo "Service Management:"
        echo "  start               — Start all services"
        echo "  stop                — Stop all services"
        echo "  restart [app]       — Restart all (or just app)"
        echo "  status              — Show status + health check"
        echo ""
        echo "Logs:"
        echo "  logs [app|db|redis|frontend] — View logs (default: app)"
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
        echo "    --frontend-only     Skip whole backend cycle; refuses if backend/ changed"
        echo "  gen-types           — Regenerate frontend types from backend"
        echo "  resync-comms        — Rebuild the comms projection (truncate + backfill;"
        echo "                        test server only; update runs it after tests; also"
        echo "                        run it after 'velo seed' -- seeds bypass the emits)"
        echo "  comms-outbox        — Outbox dead-letter queue: list-dead |"
        echo "                        requeue <id> [...] | requeue --all"
        echo ""
        echo "Database:"
        echo "  db connect          — Open psql session"
        echo "  db dump             — Create SQL dump"
        echo "  db restore <file>   — Restore from dump"
        echo "  db migrate          — Run Alembic migrations"
        echo "  seed                — Populate DB with test data"
        echo "  seed --reset        — Clean seed data & re-seed"
        echo "  seed-practices      — Sync practice schedule from seed_practices.json"
        echo "  seed-practices --reset    — Clean own data & re-seed from JSON"
        echo "  seed-practices --clean    — Clean own data only (no re-seed)"
        echo "  seed-practices --dry-run  — Show plan without writing to DB"
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
        echo "  doctor              — Check vite.env / backend/.env for missing keys"
        ;;
esac
