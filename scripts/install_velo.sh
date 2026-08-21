#!/bin/bash
# -u: abort on unset variables. pipefail: a pipeline fails if any stage fails.
# (No -e: the ERR trap defined below already aborts on any command error.)
set -uo pipefail

# ==============================================================================
# VELO Platform — VPS Installation Script
# ==============================================================================
#
# WHAT THIS SCRIPT DOES:
#   1. Asks which server this is and the values that make it THIS server
#      (branch, domains, Stripe key) -- see ask_config() below
#   2. Installs system dependencies (Docker, Nginx, Certbot, UFW)
#   3. Creates a deploy user (not root)
#   4. Sets up SSH deploy keys for GitHub -- one per repo (velo: write;
#      comms: read-only). ALL repo access goes through private deploy
#      keys, always -- no anonymous-HTTPS path exists in this script
#   5. Clones the repository
#   6. Generates secure .env with random passwords (skips if one already
#      exists -- re-running this installer must never mint new database
#      secrets against a volume that still holds the old ones)
#   7. Configures Nginx reverse proxy + SSL
#   8. Brings up the comms stack NEXT TO velo (orchestration only: clones
#      aivis-one/comms and calls its own deploy/comms-deploy.sh -- the
#      comms deploy mechanics stay in the comms repo, nothing is duplicated
#      here) and wires the token seam: COMMS_* land in backend/.env
#      BEFORE the velo stack ever starts, so no backend restart is needed
#   9. Starts the Docker stack: backend + postgres + redis, then RUNS THE
#      MIGRATIONS (the schema is created here and nowhere else on a fresh
#      box), then generates the API types, then the frontend
#  10. Installs the "velo" command as a thin shim onto the tracked
#      scripts/velo-manage.sh -- see that file for why
#
# ONE installer, not three (2026-07-17, owner ruling: "тестовый и
# продуктовый — одинаковы"). This used to be three ~1500-line near-copies
# (install_velo.sh / install_velo_prod.sh / install_velo_test.sh), one per
# server. The copies had already diverged in ways that were bugs, not
# variants: one was missing `set -uo pipefail` entirely, a safety check
# (PIPESTATUS on the backup dump) had been added to only one copy, one was
# missing the `setrole` command outright. Three texts claiming to describe
# the same thing is what let them quietly stop agreeing. There is one text
# now. A fourth divergence surfaced on 2026-08-21, long after the merge:
# NONE of the three copies ran `alembic upgrade head`, so no fresh install
# ever created the database schema -- see the note at that step in
# start_stack() for how it stayed hidden. The only two things that legitimately differ per server -- which
# branch to track, which domains to serve, and whether a real Stripe key
# exists -- are asked for below, not hardcoded.
#
# USAGE:
#   First time:   sudo bash install_velo.sh
#   After that:   velo status | velo logs | velo update | velo version | ...
#
#   `velo update` updates EVERY service this installer put on the box --
#   services first, the product last -- each through its OWN lifecycle
#   script. No second command to remember, no manual step on a server.
#   comms-deploy.sh stays callable directly for debugging; nothing needs it.
#
# REQUIREMENTS:
#   - Ubuntu 22.04+ (fresh VPS), root access
#   - GitHub deploy key with WRITE access ("velo update" pushes regenerated
#     types back onto the tracked branch)
#   - DNS A-records for both domains already pointing at this server
#     (asked for below; the script prints this server's own IP to compare
#     against before you confirm)
# ==============================================================================

# === Fixed configuration (does not vary by server) ===
INSTALL_BASE="/opt/velo"
# The product moved to its own GitHub organisation on 2026-08-21. Only the
# PRODUCT moved: services (comms today) stay under aivis-one, so their slugs
# in scripts/services.conf are unchanged and must not be "fixed" to match.
GITHUB_REPO="VELO2026-app/velo"
DEPLOY_USER="velo"
DOCKER_COMPOSE_FILE="docker-compose.yml"
REPO_URL=""  # set after SSH key setup
# Host serving Telegram links. t.me was pulled at the .me registry level on
# 2026-07-13 (NXDOMAIN worldwide, not a block), so bot links and avatars must
# ride an alias. telegram.me and telegram.dog are official aliases of t.me --
# see https://core.telegram.org/api/links.
#
# SINGLE POINT OF TRUTH for this script: every Telegram URL below is built from
# it. Escape hatch if telegram.me dies too: telegram.dog sits in a different
# TLD, outside the Montenegrin .me registry.
TELEGRAM_LINK_DOMAIN="telegram.me"

# === Comms stack (orchestrated, NOT merged -- see setup_comms below) ===
# This installer only ORCHESTRATES the comms bring-up: it clones the comms
# repo and calls the deploy CLI that ships inside it. The comms deploy
# mechanics live in comms/deploy/ (comms repo) and are never duplicated here.
COMMS_INSTALL_BASE="/opt/comms"
COMMS_REPO_DIR="$COMMS_INSTALL_BASE/repo"
# NO comms slug here. It was declared at this spot until 2026-08-21 and read
# by nothing: setup_comms takes it from the service registry (field 2), which
# is the single source of truth. A second declaration that looks canonical but
# steers nothing is worse than no declaration -- editing it changes NOTHING
# while reading as if it had. Found during the org move: the dead copy would
# have been the obvious thing to edit, and the edit would have been a no-op.
# SSH via a DEDICATED deploy key, ALWAYS (owner ruling: all keys strictly
# private -- no anonymous-HTTPS assumption, even while the repo happens to
# be public today). One code path regardless of repo visibility, so closing
# the repo later is a non-event. A separate key is not a choice: GitHub
# refuses to attach one deploy key to two repositories. READ-ONLY is enough
# for comms -- comms-deploy.sh only ever pulls (velo's own key needs write
# because `velo update` pushes generated.ts).
# Built from the registry (field 2) once the checkout exists -- see
# setup_comms. The host alias is the one provision_service_keys wrote
# into /root/.ssh/config for this service.
COMMS_REPO_URL=""
# NOTE: the comms branch is NOT a knob here any more (H-D1, 2026-08-04).
# It is declared once, for every server of this product, in the service
# registry (repo/scripts/services.conf) and read from there below --
# "remember to export COMMS_BRANCH" was a manual step, i.e. exactly what
# an installer must never require, and forgetting it produced servers
# whose two stacks silently tracked different branches.
# Shared external docker network joining the velo and comms stacks.
SHARED_NETWORK="aivis-shared"

# === Per-server configuration -- filled in by ask_config(), not hardcoded ===
VELO_ROLE=""
GIT_BRANCH=""
DOMAIN_FRONTEND=""
DOMAIN_API=""
# OPTIONAL short public domain (T-32 item 6). Empty is the norm and the
# default: with it empty this installer must behave exactly as it did
# before the question existed -- same certbot invocation, same nginx
# output, no extra server block.
DOMAIN_PUBLIC=""
# Set by setup_ssl when the optional domain was asked for but did not
# get a certificate; read by the closing summary.
PUBLIC_DOMAIN_NO_CERT=0
SERVER_IP=""

# === Colors ===
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# === Logging ===
log()     { echo -e "${GREEN}[$(date +'%H:%M:%S')]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; }
info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}✓${NC} $1"; }

# NOTE (2026-08-06): a tmux wrapper was tried here to survive dropped ssh
# sessions and REJECTED by the owner after seeing it run. Recording why, so
# nobody re-invents it: inside a tmux pane the terminal's colour scheme is
# replaced by tmux's own, mouse wheel turns into arrow keys the pane echoes
# into the output, and any transcript taken by piping this script (tee) hides
# the tty from docker, which then degrades to a wall of plain text. This file
# is the ONE artefact the customer runs -- how it looks outweighs surviving a
# disconnect, and a dropped install is simply re-run (idempotent by design:
# secrets and profile are guarded). If durability is ever wanted again, it
# belongs OUTSIDE the script: `ssh -t ... tmux new -s install` on the
# operator's side, or systemd-run, neither of which touches this file.

# === Error handler ===
handle_error() {
    error "Error occurred at line: ${1}"
    error "Installation failed. Check output above for details."
    exit 1
}
trap 'handle_error ${LINENO}' ERR

# Scratch file for the OpenAPI snapshot (start_stack step 2). Declared
# here, next to the trap that removes it: the path is created with
# mktemp at the point of use, and this trap is the ONLY guarantee it
# does not survive an abort. Empty until then -- `rm -f ""` is a no-op.
# Replaces the fixed, predictable filename this used to carry inside a
# world-writable directory -- that is a symlink race: any local user
# can pre-create the path pointing at a file root then overwrites.
# The old literal is deliberately not repeated here, so that grepping
# for it over this script stays an unambiguous check (T-32 item 7).
OPENAPI_TMP=""
trap 'rm -f "${OPENAPI_TMP:-}"' EXIT

# === Check root ===
if [ "$EUID" -ne 0 ]; then
    error "Please run as root: sudo bash install_velo.sh"
    exit 1
fi

# ==============================================================================
# ASK CONFIG -- the ONE place per-server values come from
# ==============================================================================

ask_config() {
    echo -e "${CYAN}═══════════════════════════════════════════════${NC}"
    echo -e "${CYAN}  Which server is this?                        ${NC}"
    echo -e "${CYAN}═══════════════════════════════════════════════${NC}"
    echo ""
    echo "  1) test        — fake data, test payments, safe to break"
    echo "  2) production  — the real thing, once anything is deployed here"
    echo ""
    while true; do
        read -p "Choose 1 or 2: " ROLE_CHOICE
        case "$ROLE_CHOICE" in
            1) VELO_ROLE="test"; GIT_BRANCH="test"; break ;;
            2) VELO_ROLE="prod"; GIT_BRANCH="main"; break ;;
            *) echo "Please type 1 or 2." ;;
        esac
    done
    echo ""

    if [ "$VELO_ROLE" = "prod" ]; then
        warn "You chose PRODUCTION."
        read -p "Type YES (all caps) to confirm: " CONFIRM_PROD
        if [ "$CONFIRM_PROD" != "YES" ]; then
            error "Not confirmed. Re-run the installer and choose again."
            exit 1
        fi
        echo ""
    fi

    echo -e "${CYAN}Git branch${NC}"
    read -p "Branch to clone and track [$GIT_BRANCH]: " BRANCH_INPUT
    GIT_BRANCH="${BRANCH_INPUT:-$GIT_BRANCH}"
    echo ""

    echo -e "${CYAN}Domains${NC}"
    echo -e "${YELLOW}Both need a DNS A-record pointing at this server already.${NC}"
    read -p "Frontend domain (e.g. app.example.com): " DOMAIN_FRONTEND
    read -p "API domain      (e.g. api.example.com): " DOMAIN_API
    if [ -z "$DOMAIN_FRONTEND" ] || [ -z "$DOMAIN_API" ]; then
        error "Both domains are required."
        exit 1
    fi
    echo ""

    # OPTIONAL third domain -- the base for public links (T-32 items 5/6).
    # Asked HERE, at install time, and not added later on demand, because
    # both things it feeds are one-shot: backend/.env is generated exactly
    # once (the generator is a hard no-op afterwards) and the certificate
    # is issued once. "Add it when we need it" therefore means "wipe the
    # server", and this install is promised stable for weeks.
    #
    # Empty is a first-class answer: everything below branches on it and
    # the empty path is the untouched one.
    echo -e "${CYAN}Public link domain (optional)${NC}"
    echo -e "${YELLOW}The host that PARTICIPANTS will see: practice links are${NC}"
    echo -e "${YELLOW}published into Telegram channels as https://<this>/z/<code>.${NC}"
    echo -e "${YELLOW}A SUBDOMAIN of a domain you already own, e.g. go.example.com${NC}"
    echo -e "${YELLOW}-- nothing to buy, one A-record pointing here.${NC}"
    echo -e "${YELLOW}Press Enter to skip -- links then read https://${DOMAIN_API}/z/...${NC}"
    read -p "Public link domain [none]: " DOMAIN_PUBLIC
    DOMAIN_PUBLIC="${DOMAIN_PUBLIC// /}"
    echo ""

    if [ -n "$DOMAIN_PUBLIC" ]; then
        success "Role: $VELO_ROLE · Branch: $GIT_BRANCH · Domains: $DOMAIN_FRONTEND / $DOMAIN_API / $DOMAIN_PUBLIC"
    else
        success "Role: $VELO_ROLE · Branch: $GIT_BRANCH · Domains: $DOMAIN_FRONTEND / $DOMAIN_API"
    fi
    echo ""
}

# ==============================================================================
# PRE-FLIGHT CHECKS
# ==============================================================================

preflight_checks() {
    log "Running pre-flight checks..."

    # Check OS
    if [ ! -f /etc/os-release ]; then
        error "Cannot detect OS. Ubuntu 22.04+ required."
        exit 1
    fi

    source /etc/os-release
    if [ "$ID" != "ubuntu" ] && [ "$ID" != "debian" ]; then
        warn "Detected $ID, expected Ubuntu/Debian. Proceeding anyway..."
    fi

    # Check memory (warn if < 3GB -- this server now carries TWO stacks:
    # velo + comms; comms adds ~0.5-0.7Gi idle on top of velo)
    local TOTAL_MEM=$(free -m | awk '/Mem:/ {print $2}')
    if [ "$TOTAL_MEM" -lt 3000 ]; then
        warn "Only ${TOTAL_MEM}MB RAM detected. Recommended: 3GB+ (velo + comms)"
    else
        success "Memory: ${TOTAL_MEM}MB ✓"
    fi

    # Check swap (informational only -- ensure_swap below auto-adds a 4G
    # swap file when none exists; swap absorbs the image-build peaks of
    # both stacks, without it a 4G-class VPS risks OOM mid-build)
    local SWAP_TOTAL
    SWAP_TOTAL=$(free -m | awk '/Swap:/ {print $2}')
    if [ "$SWAP_TOTAL" -eq 0 ]; then
        warn "Swap: 0 -- a 4G swap file will be added automatically"
    else
        success "Swap: ${SWAP_TOTAL}MB ✓"
    fi

    # Check disk (warn if < 10GB free)
    local FREE_DISK=$(df -BG /opt | tail -1 | awk '{print $4}' | tr -d 'G')
    if [ "$FREE_DISK" -lt 10 ]; then
        warn "Only ${FREE_DISK}GB free disk. Recommended: 10GB+"
    else
        success "Disk: ${FREE_DISK}GB free ✓"
    fi

    # Check DNS for both domains
    SERVER_IP=$(curl -s ifconfig.me 2>/dev/null)

    # The optional domain joins the SAME warn-only loop. Deliberately not
    # a hard gate: it would be stricter than the two REQUIRED domains get,
    # which is backwards, and certbot failing is already survivable here.
    for CHECK_DOMAIN in "$DOMAIN_FRONTEND" "$DOMAIN_API" ${DOMAIN_PUBLIC:+"$DOMAIN_PUBLIC"}; do
        local RESOLVED_IP=$(dig +short "$CHECK_DOMAIN" 2>/dev/null | tail -1)
        if [ -z "$RESOLVED_IP" ]; then
            warn "$CHECK_DOMAIN does not resolve. SSL setup may fail."
        elif [ "$RESOLVED_IP" != "$SERVER_IP" ]; then
            warn "$CHECK_DOMAIN → $RESOLVED_IP (this server is $SERVER_IP). SSL setup may fail."
        else
            success "DNS: $CHECK_DOMAIN → $RESOLVED_IP ✓"
        fi
    done

    success "Pre-flight checks passed"
}

clear
echo -e "${CYAN}╔═══════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║       VELO Platform — VPS Installation        ║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════════╝${NC}"
echo ""

ask_config
preflight_checks
echo ""

# Print DNS requirements
echo -e "${CYAN}═══════════════════════════════════════════════${NC}"
echo -e "${CYAN}  Required DNS records (add BEFORE continuing) ${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════${NC}"
echo ""
printf "  %-5s %-22s %s\n" "Type" "Name" "Value"
echo -e "  ────  ──────────────────────  ─────────────────"
# printf, not echo: the columns used to be padded by hand-counted spaces, so
# the Value column landed wherever the domain name happened to end.
printf "  A     %-22s %s\n" "$DOMAIN_FRONTEND" "$SERVER_IP"
printf "  A     %-22s %s\n" "$DOMAIN_API" "$SERVER_IP"
# The public link domain belongs in this list whenever it was given: it gets
# its OWN certificate below, so a missing A-record for it fails certbot just
# as surely as a missing one for the two required domains. Listing only two
# while the prompt above asked for three is how an operator adds two records,
# presses ENTER, and discovers the third at certbot time.
[ -n "$DOMAIN_PUBLIC" ] && printf "  A     %-22s %s\n" "$DOMAIN_PUBLIC" "$SERVER_IP"
echo ""
if [ -n "$DOMAIN_PUBLIC" ]; then
    echo -e "${YELLOW}All three records must resolve to this server before SSL setup.${NC}"
else
    echo -e "${YELLOW}Both records must resolve to this server before SSL setup.${NC}"
fi
echo ""
read -p "Press ENTER when DNS records are configured..."
echo ""

# Check for previous installation. "Previous installation" now means EITHER
# stack: velo (this checkout) or comms (orchestrated below) -- an orphaned
# comms stack surviving a "fresh" reinstall would silently carry old secrets
# and old data volumes into the new install.
if [ -d "$INSTALL_BASE/repo" ] || [ -d "$COMMS_REPO_DIR" ]; then
    warn "Found existing installation ($INSTALL_BASE and/or $COMMS_INSTALL_BASE)"
    echo ""
    read -p "Remove existing installation and start fresh? (y/n): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        log "Stopping existing services and removing volumes..."
        cd "$INSTALL_BASE/repo" 2>/dev/null && docker compose down -v 2>/dev/null || true
        # Tear down the comms stack the same way (containers + volumes).
        # Runs from the comms compose dir: the deploy/.env symlink is still
        # alive at this point (removed together with /opt/comms below).
        # `|| true` mirrors the velo line above -- a half-dead stack must
        # not abort the wipe. Accepted residual risk: if this `down` fails,
        # comms VOLUMES survive the reinstall and the fresh stack would
        # silently adopt them; chasing them by name here would mean
        # duplicating comms topology knowledge in velo, which is banned.
        if [ -f "$COMMS_REPO_DIR/deploy/docker-compose.yml" ]; then
            cd "$COMMS_REPO_DIR/deploy" 2>/dev/null && docker compose down -v 2>/dev/null || true
        fi
        # cd out of the directories being removed; `cd /` is the fallback
        # for the comms-orphan case where $INSTALL_BASE does not exist.
        cd "$INSTALL_BASE" 2>/dev/null || cd /
        log "Removing existing installation..."
        rm -rf "$INSTALL_BASE/repo"
        # Reinstall = clean server (owner ruling): the WHOLE comms state
        # goes -- checkout, master .env (secrets re-minted on install),
        # profile (smoke profile re-seeded), backups. Backing up before a
        # reinstall is the operator's responsibility, same as velo data.
        rm -rf "$COMMS_INSTALL_BASE"
        rm -f /usr/local/bin/velo
        success "Previous installation removed (including Docker volumes)"
    else
        error "Cannot proceed with existing installation"
        exit 1
    fi
fi

# ==============================================================================
# FIX LOCALE
# ==============================================================================

fix_locale() {
    log "Fixing locale settings..."

    apt-get update -qq
    apt-get install -y -qq locales > /dev/null

    locale-gen en_US.UTF-8 > /dev/null 2>&1
    update-locale LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

    export LANG=en_US.UTF-8
    export LC_ALL=en_US.UTF-8

    success "Locale configured"
}

fix_locale

# ==============================================================================
# SYSTEM DEPENDENCIES
# ==============================================================================

install_system_deps() {
    log "Installing system dependencies..."

    apt-get update
    apt-get install -y \
        apt-transport-https \
        ca-certificates \
        curl \
        gnupg \
        lsb-release \
        git \
        ufw \
        dnsutils \
        software-properties-common

    success "System dependencies installed"
}

install_system_deps

# ==============================================================================
# DOCKER
# ==============================================================================

install_docker() {
    if command -v docker &> /dev/null; then
        success "Docker already installed: $(docker --version)"
        return
    fi

    log "Installing Docker..."

    # Add Docker GPG key
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc

    # Add Docker repository
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
      $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
      tee /etc/apt/sources.list.d/docker.list > /dev/null

    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

    # Enable and start Docker
    systemctl enable docker
    systemctl start docker

    success "Docker installed: $(docker --version)"
}

install_docker

# ==============================================================================
# SWAP
# ==============================================================================
# The server carries TWO stacks now (velo + comms, ~7 extra containers
# total); swap absorbs the image-build peaks of both. Without it a
# 4G-class VPS risks OOM in the middle of a build. Placed here, right
# after Docker: per-VPS prep of the same class, and it MUST be active
# before the first `docker build` (comms builds images before velo does).

ensure_swap() {
    # Auto-add ONLY when there is no swap at all. Existing swap of any
    # size is operator territory -- left untouched.
    if [ -n "$(swapon --show --noheadings 2>/dev/null)" ]; then
        success "Swap already active -- left untouched"
        return 0
    fi

    log "No swap detected -- adding a 4G swap file..."

    # Each step explicitly checked: the ERR trap would abort anyway, but
    # these need actionable messages. Proceeding without swap would be a
    # hidden OOM risk that surfaces mid-build, far from its cause.
    # An existing /swapfile (partial previous run: created, never
    # activated) is reused as-is -- mkswap/swapon below re-run on it.
    if [ ! -f /swapfile ]; then
        if ! fallocate -l 4G /swapfile; then
            error "fallocate failed -- could not create /swapfile"
            exit 1
        fi
    fi
    if ! chmod 600 /swapfile; then
        error "chmod 600 /swapfile failed"
        exit 1
    fi
    if ! mkswap /swapfile > /dev/null; then
        error "mkswap /swapfile failed"
        exit 1
    fi
    if ! swapon /swapfile; then
        error "swapon /swapfile failed"
        exit 1
    fi

    # Survive reboot -- idempotent fstab entry.
    if ! grep -q '^/swapfile ' /etc/fstab 2>/dev/null; then
        echo '/swapfile none swap sw 0 0' >> /etc/fstab
    fi

    success "4G swap file added (/swapfile, persisted in fstab)"
}

ensure_swap

# ==============================================================================
# NGINX + CERTBOT
# ==============================================================================

install_nginx() {
    if command -v nginx &> /dev/null; then
        success "Nginx already installed: $(nginx -v 2>&1)"
        return
    fi

    log "Installing Nginx..."
    apt-get install -y nginx

    systemctl enable nginx
    systemctl start nginx

    success "Nginx installed"
}

install_certbot() {
    if command -v certbot &> /dev/null; then
        success "Certbot already installed"
        return
    fi

    log "Installing Certbot..."
    apt-get install -y certbot python3-certbot-nginx

    success "Certbot installed"
}

install_nginx
install_certbot

# ==============================================================================
# FIREWALL
# ==============================================================================

setup_firewall() {
    log "Configuring firewall (UFW)..."

    ufw default deny incoming
    ufw default allow outgoing
    ufw allow 22/tcp    # SSH
    ufw allow 80/tcp    # HTTP (for certbot + redirect)
    ufw allow 443/tcp   # HTTPS

    # Enable without prompt
    echo "y" | ufw enable

    success "Firewall configured (SSH + HTTP + HTTPS only)"
}

setup_firewall

# ==============================================================================
# DEPLOY USER
# ==============================================================================

setup_deploy_user() {
    if id "$DEPLOY_USER" &>/dev/null; then
        success "User '$DEPLOY_USER' already exists"
    else
        log "Creating deploy user '$DEPLOY_USER'..."
        useradd -m -s /bin/bash "$DEPLOY_USER"
        success "User '$DEPLOY_USER' created"
    fi

    # Add to docker group
    usermod -aG docker "$DEPLOY_USER"
    success "User '$DEPLOY_USER' added to docker group"
}

setup_deploy_user

# ==============================================================================
# SSH SETUP FOR GITHUB
# ==============================================================================

# Provision ONE GitHub deploy key: generate if absent, add the host alias
# if absent, then PRINT THE KEY AND WAIT -- always -- and only then test.
#
# THE BLOCK IS UNCONDITIONAL, and there is exactly one of it per registry
# record. Every record prints its key and waits for ENTER, whether or not
# GitHub already holds that key: two records means two prompts, twelve
# means twelve. The operator counts them against the registry, so no
# branch may skip a prompt because the key exists or because the probe
# would have passed.
#
# THIS REVERSES T-33 item 6, which had the probe run FIRST and returned
# early when it passed, so that a reinstall on a box with surviving keys
# was silent. That silence cost a live migration on 2026-08-21: the repo
# moved to a new GitHub organisation, the old key was still a deploy key
# on the OLD repo, and the probe passed anyway -- `ssh -T` only reports
# that GitHub RECOGNISES the key, never that the key opens THIS repo or
# that it may write to it. The clone then succeeded because the new repo
# happened to be public, so the run looked perfect end to end while the
# box held no write access at all. Nothing would have surfaced until the
# first `velo update` failed to push generated.ts.
#
# So the probe cannot be a gate on the prompt: it answers a narrower
# question than the prompt asks. A run that silently skipped keys already
# added is also indistinguishable from a run that broke before reaching
# them -- the operator has no way to tell the two apart.
#
# THE COST IS ONE ENTER PER SERVICE ON A REINSTALL, and it is deliberate.
# The wipe removes /opt/* and the docker state and does NOT touch
# /root/.ssh, so the keys survive and the answer to each prompt is
# usually a bare ENTER -- but it is the OPERATOR who decides that, with
# the repo URL and the key on screen in front of him.
#
#   $1 name    service id (key file and host alias are named after it)
#   $2 repo    owner/repo, for the URL printed to the operator
#   $3 access  "write" or "read" -- from the registry, never guessed:
#              the instruction differs materially and a claim about
#              privilege belongs where it can be reviewed.
provision_deploy_key() {
    local name="$1" repo="$2" access="$3"
    local key="/root/.ssh/id_ed25519_${name}_deploy"
    local alias="github.com-${name}"

    # An undeclared privilege is a stop, not a default. The check lives
    # HERE, where the key is created, so it covers the bootstrap's own
    # product call as well as every service provision_service_keys passes
    # in -- the copy in that loop only ever guarded the loop.
    if [ "$access" != "read" ] && [ "$access" != "write" ]; then
        error "Service '$name' declares access='$access' -- expected 'read'"
        error "or 'write'. Refusing to guess which instruction to give the"
        error "operator."
        return 1
    fi

    mkdir -p /root/.ssh
    chmod 700 /root/.ssh
    if ! grep -q "github.com" /root/.ssh/known_hosts 2>/dev/null; then
        ssh-keyscan -H github.com >> /root/.ssh/known_hosts 2>/dev/null
    fi

    if [ ! -f "$key" ]; then
        ssh-keygen -t ed25519 -C "${name}-deploy@$(hostname)" -f "$key" -N ""
        success "Deploy key generated for $name"
    fi

    if ! grep -q "Host ${alias}\b" /root/.ssh/config 2>/dev/null; then
        cat >> /root/.ssh/config << EOF

# ${name} deploy key (${access})
Host ${alias}
    HostName github.com
    User git
    IdentityFile ${key}
    IdentitiesOnly yes
EOF
        chmod 600 /root/.ssh/config
    fi

    echo ""
    echo -e "${CYAN}═══════════════════════════════════════════════${NC}"
    echo -e "${CYAN}  GitHub Deploy Key -- ${name} repo${NC}"
    echo -e "${CYAN}═══════════════════════════════════════════════${NC}"
    echo ""
    cat "${key}.pub"
    echo ""
    echo -e "${YELLOW}Go to: https://github.com/${repo}/settings/keys${NC}"
    echo -e "${YELLOW}Click 'Add deploy key', paste the key above.${NC}"
    if [ "$access" = "write" ]; then
        echo -e "${RED}IMPORTANT: tick 'Allow write access'.${NC}"
        echo -e "${YELLOW}('velo update' pushes regenerated API types back to this repo.)${NC}"
    else
        echo -e "${GREEN}READ-ONLY is enough: do NOT tick 'Allow write access'.${NC}"
        echo -e "${YELLOW}(nothing on this box ever pushes to ${repo}.)${NC}"
    fi
    echo -e "${YELLOW}Already added from an earlier install? Press ENTER, it is a no-op.${NC}"
    echo ""
    # < /dev/tty so the pause survives `curl ... | bash`, where stdin is
    # the script text itself and a bare `read` consumes a line of it
    # instead of waiting for the operator.
    read -r -p "Press ENTER after adding the deploy key to GitHub..." < /dev/tty

    # The probe runs HERE and nowhere else: it verifies what the operator
    # just did. Running it before the prompt is what let a key GitHub
    # already knew skip the block entirely.
    #
    # NOTE WHAT IT DOES NOT PROVE. `ssh -T` reports that GitHub recognises
    # the key, full stop. It does not say the key is attached to ${repo},
    # and it does not say the key may write there -- a key that is a
    # deploy key on some OTHER repository passes this probe cleanly. The
    # narrower claims are checked after the clone; see verify_repo_access.
    if github_probe "$alias"; then
        success "GitHub connection OK ($name)"
        return 0
    fi

    error "Cannot connect to GitHub with the ${name} deploy key"
    error "Make sure the key is added to: https://github.com/${repo}/settings/keys"
    return 1
}


# `ssh -T` against GitHub exits 1 even on SUCCESS ("does not provide
# shell access"), and under `set -o pipefail` (top of file) the old
# `ssh | grep -q` form propagated that 1 through a MATCHING grep -- the
# test failed on a perfectly good key, every time, on every machine.
# Found live 2026-07-27, first fresh-box run of this path since the
# three installers merged (the pre-merge test-server variant had no
# pipefail, which is why it never fired before). The banner is captured
# instead; `|| true` keeps the assignment from tripping the ERR trap.
github_probe() {
    local alias="$1" banner
    banner=$(ssh -T "git@${alias}" 2>&1 || true)
    echo "$banner" | grep -q "successfully authenticated"
}

# BOOTSTRAP, and the one service that cannot come from the registry:
# services.conf lives INSIDE the velo repo, so it cannot be read before
# velo is cloned, and velo cannot be cloned without this key. Every
# OTHER service is provisioned by the loop after the clone -- see
# provision_service_keys().
setup_ssh() {
    log "Setting up SSH for GitHub..."
    provision_deploy_key "velo" "$GITHUB_REPO" "write" || return 1
    REPO_URL="git@github.com-velo:$GITHUB_REPO.git"
}

setup_ssh

# ==============================================================================
# SSH SETUP FOR THE COMMS REPO
# ==============================================================================
# ==============================================================================
# CLONE REPOSITORY
# ==============================================================================

# Provision a GitHub deploy key for EVERY service the registry declares,
# except the product itself -- its key is the bootstrap that made this
# file readable in the first place (see setup_ssh).
#
# This is what item 5 buys: a fourth service is one record in
# services.conf and zero lines here. The velo record is skipped by its
# "internal" lifecycle rather than by name -- but it is no longer true
# that passing it through would be harmless: the key block is
# unconditional now, so the product would print a second prompt for a key
# the operator has already dealt with in setup_ssh.
provision_service_keys() {
    local conf="$INSTALL_BASE/repo/scripts/services.conf"
    if [ ! -f "$conf" ]; then
        error "Service registry not found at $conf"
        exit 1
    fi
    # shellcheck source=/dev/null
    source "$conf" || exit 1

    local record name repo access
    for record in "${VELO_SERVICES[@]}"; do
        [ "$(svc_field "$record" 5)" = "internal" ] && continue
        name=$(svc_field "$record" 1)
        repo=$(svc_field "$record" 2)
        access=$(svc_field "$record" 7)

        # The access value is validated inside provision_deploy_key, which
        # is where the key is created -- one copy, covering the product's
        # bootstrap call too. It used to be checked here as well, which
        # guarded only this loop.
        provision_deploy_key "$name" "$repo" "$access" || exit 1

        # Read access is provable now, without a checkout. Services are
        # read-only by declaration, so this is the whole claim for them.
        verify_repo_access "$name" "$repo" "$access" "" || exit 1
    done
}

# DEFINED HERE, NOT IN THE COMMS SECTION BELOW, AND THAT IS THE WHOLE POINT.
# It is CALLED a few lines down, right after clone_repo -- and bash executes
# top to bottom, so a definition that sits 450 lines lower does not exist yet
# at that moment. It did sit lower (T-33), which made every FRESH install die
# with "provision_service_keys: command not found" immediately after the
# clone. Keep the definition above the call; the call itself must stay
# where it is (see its own comment).

clone_repo() {
    log "Cloning repository (branch: $GIT_BRANCH)..."

    mkdir -p "$INSTALL_BASE"
    # Clone the target branch directly so the first build + migrations run on
    # the right code (avoids a full rebuild after a manual `git checkout`).
    git clone -b "$GIT_BRANCH" "$REPO_URL" "$INSTALL_BASE/repo"

    # Set ownership
    chown -R root:root "$INSTALL_BASE"

    success "Repository cloned to $INSTALL_BASE/repo (branch: $GIT_BRANCH)"
}

clone_repo

# Sourced from the checkout that clone_repo just made -- the same place
# services.conf comes from, and for the same reason: one text, shipped as
# code. Nothing before the clone could have used it anyway.
# shellcheck source=/dev/null
source "$INSTALL_BASE/repo/scripts/lib-github.sh" || {
    error "Cannot source $INSTALL_BASE/repo/scripts/lib-github.sh"
    exit 1
}

# The clone proves this key can READ the repo -- but only because the
# clone happened, and on a PUBLIC repo it does not even prove attachment.
# WRITE is the claim `velo update` depends on and the one nothing so far
# has tested, so it is tested here, at install time, against a checkout
# that exists. Failing here costs one re-add on GitHub; failing later
# costs a broken update on a live box.
verify_repo_access "velo" "$GITHUB_REPO" "write" "$INSTALL_BASE/repo" || exit 1

# Only now can the registry be read -- it ships inside the checkout that
# clone_repo just made. Everything after this point is registry-driven.
provision_service_keys

# ==============================================================================
# GENERATE .ENV
# ==============================================================================

generate_env() {
    local ENV_FILE="$INSTALL_BASE/repo/backend/.env"

    # The .env destroyer, fixed 2026-07-17: this function used to mint a NEW
    # random Postgres/Redis/SECRET_KEY on every run and write them with no
    # existence check. Re-running the installer against a server that was
    # already up would put new passwords in the file while the Postgres
    # volume kept the OLD ones -- an outage on next start -- and would erase
    # any hand edits made on the live server (exactly what happened here:
    # the owner's own manual fix to a different generated file). An installer
    # that can destroy a running database by being run twice is not
    # shippable, so this is now a hard no-op when the file exists.
    if [ -f "$ENV_FILE" ]; then
        warn "backend/.env already exists at $ENV_FILE -- NOT regenerating."
        warn "Re-running this installer must never mint new database secrets"
        warn "against a volume that still holds the old ones, and must never"
        warn "overwrite hand edits made on a live server."
        warn "Delete the file yourself first if you really want fresh secrets"
        warn "(and are prepared to reset the database to match)."
        return 0
    fi

    log "Generating .env with secure passwords..."

    # Generate secure random values
    local PG_PASSWORD=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-25)
    local REDIS_PASSWORD=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-25)
    local SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(64))")

    # Ask for Telegram bot credentials
    echo ""
    echo -e "${CYAN}═══════════════════════════════════════════════${NC}"
    echo -e "${CYAN}  Telegram Bot${NC}"
    echo -e "${CYAN}═══════════════════════════════════════════════${NC}"
    echo ""
    echo -e "${YELLOW}Get token from @BotFather in Telegram.${NC}"
    echo -e "${YELLOW}The bot username is fetched from Telegram automatically.${NC}"
    echo ""
    read -p "TELEGRAM_BOT_TOKEN: " TELEGRAM_BOT_TOKEN

    # Fetch the bot username from Telegram (getMe) rather than asking for it:
    # removes a hand-typed value that could be mistyped or mismatch the token.
    # Parse the JSON with grep/sed to avoid a jq dependency.
    echo "Verifying token with Telegram (getMe)..."
    local TELEGRAM_BOT_USERNAME GETME
    GETME=$(curl -s --max-time 15 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" || true)
    if ! echo "$GETME" | grep -q '"ok":true'; then
        error "Telegram getMe failed — invalid token or no network."
        error "Response: ${GETME:-<empty>}"
        exit 1
    fi
    TELEGRAM_BOT_USERNAME=$(echo "$GETME" | grep -o '"username":"[^"]*"' | head -1 | sed 's/"username":"//; s/"//' || true)
    if [ -z "$TELEGRAM_BOT_USERNAME" ]; then
        error "Could not parse bot username from getMe response: $GETME"
        exit 1
    fi
    success "Bot: @${TELEGRAM_BOT_USERNAME}"
    echo ""

    # Ask for Zoom -- added T-35 follow-up. Until now the installer asked for
    # NOTHING about Zoom, so ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID /
    # ZOOM_CLIENT_SECRET were absent from every generated .env and
    # settings.is_zoom_stub was therefore true on EVERY server, prod
    # included -- silently. Meetings, join links and the whole attendance
    # chain ran on fabricated zoom.us URLs that look real in the UI and
    # resolve to nothing. Nothing anywhere said so: unlike Stripe there is
    # no startup gate for the Zoom stub.
    #
    # Same shape as the Stripe question below, and for the same reason: the
    # honest question is not "which server is this", it is "do you have real
    # credentials". Server-to-Server OAuth app in the Zoom marketplace ->
    # Account ID, Client ID, Client Secret.
    echo -e "${CYAN}═══════════════════════════════════════════════${NC}"
    echo -e "${CYAN}  Zoom${NC}"
    echo -e "${CYAN}═══════════════════════════════════════════════${NC}"
    echo ""
    echo -e "${YELLOW}Without real credentials meetings are FAKE: links look${NC}"
    echo -e "${YELLOW}plausible but open nothing, and attendance is never recorded.${NC}"
    echo ""
    read -p "Do you have REAL Zoom credentials for this server? (y/n): " -n 1 -r
    echo
    local ZOOM_ACCOUNT_ID ZOOM_CLIENT_ID ZOOM_CLIENT_SECRET ALLOW_ZOOM_STUB
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        read -p "ZOOM_ACCOUNT_ID: " ZOOM_ACCOUNT_ID
        read -p "ZOOM_CLIENT_ID: " ZOOM_CLIENT_ID
        read -p "ZOOM_CLIENT_SECRET: " ZOOM_CLIENT_SECRET
        ALLOW_ZOOM_STUB=false
        success "Real Zoom credentials recorded — meetings will be REAL."
    else
        ZOOM_ACCOUNT_ID=""
        ZOOM_CLIENT_ID=""
        ZOOM_CLIENT_SECRET=TEST
        # ALLOW_ZOOM_STUB=true is what keeps the backend's startup gate from
        # refusing to boot (main.py). The operator said out loud that this
        # server has no Zoom app; the gate exists to stop a server running
        # on fiction WITHOUT anyone saying so, not to stop this.
        ALLOW_ZOOM_STUB=true
        warn "No real credentials — Zoom runs in STUB mode: meeting links are"
        warn "fabricated and attendance will NOT be recorded on this server."
        warn "ALLOW_ZOOM_STUB=true is written to backend/.env so the backend"
        warn "starts anyway. Add real keys and REINSTALL to get real meetings."
    fi
    echo ""

    # Ask for Stripe -- re-derived 2026-07-17, not inherited. The 07-16 default
    # (prod=false, test=true) was reasoned from "prod has a real key" -- that
    # was never true (Stripe has never been connected on EITHER server,
    # owner-confirmed). The honest question was never "which server is this",
    # it is "do you actually have a real key" -- asked directly, of whoever is
    # installing, regardless of role.
    echo -e "${CYAN}═══════════════════════════════════════════════${NC}"
    echo -e "${CYAN}  Stripe${NC}"
    echo -e "${CYAN}═══════════════════════════════════════════════${NC}"
    echo ""
    read -p "Do you have a REAL Stripe secret key for this server? (y/n): " -n 1 -r
    echo
    local STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PUBLISHABLE_KEY
    local STRIPE_SUCCESS_URL STRIPE_CANCEL_URL ALLOW_STRIPE_STUB
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        read -p "STRIPE_SECRET_KEY: " STRIPE_SECRET_KEY
        read -p "STRIPE_WEBHOOK_SECRET: " STRIPE_WEBHOOK_SECRET
        read -p "STRIPE_PUBLISHABLE_KEY: " STRIPE_PUBLISHABLE_KEY
        STRIPE_SUCCESS_URL="https://${DOMAIN_FRONTEND}/topup/success"
        STRIPE_CANCEL_URL="https://${DOMAIN_FRONTEND}/topup/cancel"
        ALLOW_STRIPE_STUB=false
        success "Real Stripe key recorded — payments will be REAL on this server."
    else
        STRIPE_SECRET_KEY=TEST
        STRIPE_WEBHOOK_SECRET=TEST
        STRIPE_PUBLISHABLE_KEY=TEST
        STRIPE_SUCCESS_URL=TEST
        STRIPE_CANCEL_URL=TEST
        ALLOW_STRIPE_STUB=true
        warn "No real key — payments will run in STUB mode (fake, no money moves)."
    fi
    echo ""

    # The short domain if the operator gave one, the API domain otherwise.
    # Written whether or not its certificate was obtained: the value states
    # the operator's INTENT, and intent self-heals (fix DNS, re-issue, and
    # the base is true). Falling back to the API domain would freeze a
    # temporary certbot failure into permanent config that only a hand edit
    # -- the thing the delivery doctrine forbids -- could undo.
    local PUBLIC_LINK_HOST="${DOMAIN_PUBLIC:-$DOMAIN_API}"

    cat > "$ENV_FILE" << EOF
# ===========================================================================
# VELO Backend — Environment ($VELO_ROLE)
# Generated: $(date -u +"%Y-%m-%d %H:%M:%S UTC")
# Server: $(hostname) ($(curl -s ifconfig.me 2>/dev/null))
# ===========================================================================

# --- Application ---
APP_ENV=production
LOG_LEVEL=INFO

# --- Security ---
# Auto-generated. NEVER commit this file.
SECRET_KEY=${SECRET_KEY}

# --- Database (PostgreSQL) ---
# Credentials match POSTGRES_* vars used by Docker to create the DB.
DATABASE_URL=postgresql+asyncpg://velo:${PG_PASSWORD}@postgres:5432/velo
POSTGRES_DB=velo
POSTGRES_USER=velo
POSTGRES_PASSWORD=${PG_PASSWORD}

# --- Redis ---
REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379/0
REDIS_PASSWORD=${REDIS_PASSWORD}

# --- CORS ---
CORS_ORIGINS=https://${DOMAIN_FRONTEND}

# --- Public links ---
# Base for links that must survive OUTSIDE Telegram (e-mail, browser,
# PWA), where DNS is real and a third-party host is a live dependency.
# The short domain if one was given at install, the API domain otherwise.
#
# CONSUMER (T-35, shipped): the Zoom link wrapper reads this. Every
# practice link a master copies is built here at send time --
# {PUBLIC_LINK_BASE}/z/{code}, where the code is a 22-character
# base64url of the practice id (backend/app/modules/zoom/service.py,
# build_public_practice_link). The same code is the Telegram deep link
# (startapp=zoom__<22>).
#
# The value is NOT decorative: config.py refuses to start in production
# with it empty. A wrong value is worse than a missing one -- it means
# links already posted in Telegram channels point at a host that is not
# us, and nothing in the request path would ever say so.
#
# nginx must proxy "location /" on this host to the backend (it does --
# see scripts/nginx-render.sh), because the route lives at the ROOT,
# outside /api/v1, so the link stays short.
#
# NOTE for anyone editing the lines above: this heredoc is UNQUOTED
# (it has to be -- PUBLIC_LINK_HOST and the date stamp must expand), so a
# backtick here would be executed at install time and vanish from the
# generated file. Keep comments backtick-free.
PUBLIC_LINK_BASE=https://${PUBLIC_LINK_HOST}

# --- Telegram ---
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
# Bot URL for notification deep links. Username resolved via Telegram getMe.
TELEGRAM_BOT_URL=https://${TELEGRAM_LINK_DOMAIN}/${TELEGRAM_BOT_USERNAME}
# Live Telegram link host. The backend rewrites every Telegram URL onto it --
# both this bot URL and the avatar URLs Telegram sends in initData.
TELEGRAM_LINK_DOMAIN=${TELEGRAM_LINK_DOMAIN}

# --- Session ---
SESSION_TTL_DAYS=30

# --- Zoom ---
# Server-to-Server OAuth app. Empty (or CLIENT_SECRET=TEST) puts the whole
# Zoom integration into stub mode: meetings are fabricated, join links open
# nothing, attendance is never recorded. Asked at install; see the Zoom
# block in generate_env().
ZOOM_ACCOUNT_ID=${ZOOM_ACCOUNT_ID}
ZOOM_CLIENT_ID=${ZOOM_CLIENT_ID}
ZOOM_CLIENT_SECRET=${ZOOM_CLIENT_SECRET}
# Set to true ONLY when the operator declared this server has no Zoom app.
# With it false and the credentials blank/TEST, the backend refuses to start
# in production -- deliberately: a server whose meetings are fabricated must
# not look identical to a working one.
ALLOW_ZOOM_STUB=${ALLOW_ZOOM_STUB}

# --- Stripe ---
STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY}
STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET}
STRIPE_PUBLISHABLE_KEY=${STRIPE_PUBLISHABLE_KEY}
STRIPE_SUCCESS_URL=${STRIPE_SUCCESS_URL}
STRIPE_CANCEL_URL=${STRIPE_CANCEL_URL}
# true = allow the stub Stripe path (fake payments, no money moves). Set from
# whether a REAL key was entered above, not from which server this is -- see
# the comment on the prompt.
ALLOW_STRIPE_STUB=${ALLOW_STRIPE_STUB}
EOF

    chmod 600 "$ENV_FILE"
    success ".env generated"

    # Save VITE build args -- used by start_stack() and velo update.
    cat > "$INSTALL_BASE/vite.env" << EOF
VITE_API_BASE_URL=https://${DOMAIN_API}
VITE_TELEGRAM_BOT_URL=https://${TELEGRAM_LINK_DOMAIN}/${TELEGRAM_BOT_USERNAME}
EOF
    success "vite.env saved"
}

generate_env

# ==============================================================================
# NGINX CONFIG
# ==============================================================================

setup_nginx() {
    log "Configuring Nginx reverse proxy..."

    # render_nginx_http (scripts/nginx-render.sh) carries the template + the
    # placeholder substitution that used to be inline here as a heredoc +
    # separate `sed -i` pass -- moved to a shared, tracked function so
    # `velo doctor` can call the exact same renderer read-only, instead of
    # a detector carrying its own second copy of this text that could drift
    # from this one. Proven byte-identical to the old two-step pipeline for
    # fixed domain inputs before this line ever ran.
    render_nginx_http "$DOMAIN_FRONTEND" "$DOMAIN_API" "$DOMAIN_PUBLIC" > /etc/nginx/sites-available/velo

    # Enable site
    ln -sf /etc/nginx/sites-available/velo /etc/nginx/sites-enabled/
    rm -f /etc/nginx/sites-enabled/default

    # Create certbot webroot
    mkdir -p /var/www/certbot

    # Test and reload -- explicitly checked (this was silently unguarded
    # before 2026-07-17: `nginx -t` and `systemctl reload nginx` ran
    # unconditionally, so a generated config that failed validation was
    # reported the same as one that passed).
    if ! nginx -t; then
        error "Generated Nginx config failed validation — aborting."
        exit 1
    fi
    systemctl reload nginx

    success "Nginx configured"
}

# ==============================================================================
# SSL CERTIFICATE
# ==============================================================================

setup_ssl() {
    log "Setting up SSL certificate..."

    # Get certificate for both domains in one cert
    if certbot certonly \
        --webroot \
        --webroot-path=/var/www/certbot \
        -d "$DOMAIN_FRONTEND" \
        -d "$DOMAIN_API" \
        --non-interactive \
        --agree-tos \
        --email "admin@$DOMAIN_FRONTEND" \
        --no-eff-email; then

        success "SSL certificate obtained"

        # render_nginx_ssl (scripts/nginx-render.sh) -- same shared renderer
        # as setup_nginx() above, same reason: one tracked copy of this text,
        # readable read-only by `velo doctor` instead of a second copy that
        # can drift from this one. Proven byte-identical to the old inline
        # heredoc + `sed -i` pipeline for fixed domain inputs before this
        # line ever ran.
        #
        # The optional domain is issued SEPARATELY, below, and only joins
        # this render once its own certificate exists -- an ssl_certificate
        # pointing at a missing .pem fails `nginx -t`, and this config's
        # reload is all-or-nothing for all three domains.
        local SSL_PUBLIC=""
        if [ -n "$DOMAIN_PUBLIC" ]; then
            # SEPARATE certbot run, not a third -d on the line above.
            # Sharing one certificate would mean a mistyped or
            # not-yet-propagated OPTIONAL domain fails the issuance and
            # leaves the two REQUIRED domains with no SSL at all -- a
            # failure mode that does not exist today, and an optional
            # extra may not introduce it.
            log "Requesting a separate certificate for $DOMAIN_PUBLIC..."
            if certbot certonly \
                --webroot \
                --webroot-path=/var/www/certbot \
                -d "$DOMAIN_PUBLIC" \
                --non-interactive \
                --agree-tos \
                --email "admin@$DOMAIN_FRONTEND" \
                --no-eff-email; then
                SSL_PUBLIC="$DOMAIN_PUBLIC"
                success "SSL certificate obtained for $DOMAIN_PUBLIC"
            else
                PUBLIC_DOMAIN_NO_CERT=1
                error "SSL certificate for $DOMAIN_PUBLIC FAILED. Retry later with:"
                error "  certbot certonly --webroot --webroot-path=/var/www/certbot -d $DOMAIN_PUBLIC"
                warn "$DOMAIN_PUBLIC stays on plain HTTP; the two main domains are unaffected."
            fi
        fi

        render_nginx_ssl "$DOMAIN_FRONTEND" "$DOMAIN_API" "$SSL_PUBLIC" > /etc/nginx/sites-available/velo

        # Explicitly checked -- this used to run unconditionally, printing
        # "Nginx updated with SSL" even when `nginx -t` failed and the reload
        # never happened.
        if nginx -t && systemctl reload nginx; then
            success "Nginx updated with SSL"
        else
            error "New Nginx config failed validation — SSL was NOT enabled."
            error "The file on disk is now the broken SSL config, but nginx"
            error "did not reload, so it is still SERVING the previous config."
            error "Fix /etc/nginx/sites-available/velo by hand, then: velo nginx reload"
            exit 1
        fi

        # Auto-renewal cron -- `certbot renew` walks EVERY certificate on
        # the machine, so the optional domain's separate one is covered by
        # this same entry with no second hook.
        if ! crontab -l 2>/dev/null | grep -q "certbot renew"; then
            (crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet --post-hook 'systemctl reload nginx'") | crontab -
            success "SSL auto-renewal cron added (daily at 3 AM)"
        fi
    else
        error "SSL certificate failed. You can retry later with:"
        error "  certbot certonly --webroot --webroot-path=/var/www/certbot -d $DOMAIN_FRONTEND -d $DOMAIN_API"
        warn "Keeping HTTP-only config for now"
    fi
}

# Sourced here, not at the top of the file: nginx-render.sh lives in the
# repo clone_repo() just created ($INSTALL_BASE/repo), so it does not exist
# yet earlier in this script.
# shellcheck source=/dev/null
source "$INSTALL_BASE/repo/scripts/nginx-render.sh"

# Same reason, same place: the narrow db env projection (T-32 item 9).
# shellcheck source=/dev/null
source "$INSTALL_BASE/repo/scripts/env-render.sh"

# postgres and redis are fed this file instead of the whole backend/.env,
# so neither container sees the application's secrets. Runs BEFORE any
# `docker compose` invocation -- compose fails outright on a missing
# env_file, and every command in this script from here on uses compose.
if ! write_db_env "$INSTALL_BASE/repo/backend/.env" "$INSTALL_BASE/repo/backend/.env.db"; then
    error "Could not write backend/.env.db -- postgres/redis would start"
    error "without their credentials. Aborting."
    exit 1
fi
success "backend/.env.db written (narrow db env for postgres/redis)"

setup_nginx
setup_ssl

# ==============================================================================
# SHARED DOCKER NETWORK
# ==============================================================================
# velo and comms are separate stacks joined by ONE external network;
# compose requires it to EXIST before either `up`. Idempotent, and
# comms-deploy.sh carries the same guard on its side -- either side may
# win the race, the result is identical. Runs before setup_comms AND
# before start_stack: both stacks join it.

ensure_shared_network() {
    if docker network inspect "$SHARED_NETWORK" > /dev/null 2>&1; then
        success "Docker network '$SHARED_NETWORK' already exists"
        return 0
    fi
    if ! docker network create "$SHARED_NETWORK" > /dev/null; then
        error "Failed to create docker network '$SHARED_NETWORK'"
        exit 1
    fi
    success "Docker network '$SHARED_NETWORK' created"
}

ensure_shared_network

# ==============================================================================
# COMMS STACK (orchestration only)
# ==============================================================================
# This installer does NOT deploy comms itself: it clones the comms repo and
# calls the deploy CLI that ships INSIDE it (comms/deploy/ is the single
# source of the comms deploy mechanics -- nothing of it is duplicated here).
#
# Token seam -- the documented two-pass flow from comms/deploy/INTEGRATION.md:
#   pass 1:  mints comms secrets, seeds the generic smoke profile, brings
#            the comms stack up (PRODUCT_ENV_PATH is empty on a fresh
#            install -- the COMMS_* block is only printed);
#   knob:    PRODUCT_ENV_PATH=<velo backend .env> is written into
#            /opt/comms/.env. Per-product CONFIG, not deploy logic --
#            INTEGRATION.md puts exactly this line on the product side;
#   pass 2:  install re-runs (idempotent: secrets and profile are guarded,
#            `up -d --build` is a cached no-op) -- the hand-over upserts
#            COMMS_SERVICE_TOKEN / COMMS_API_URL / COMMS_REDIS_URL into
#            the velo backend .env.
# NOTE: PRODUCT_ENV_PATH can NOT be passed as a process env var: the CLI
# sources /opt/comms/.env (where the knob is empty on a fresh install),
# which overrides the process environment. Hence the two passes.
#
# Placed BEFORE start_stack on purpose: velo then starts with COMMS_*
# already in its env_file -- no backend restart needed.
#
# The SAME seam carries the two product-specific values comms cannot know
# by itself (T-32): PROFILE_DIR, bound to comms-profile/ inside the velo
# checkout, and the telegram credentials this installer already asked for.
# Both are written between the passes; pass 2 sources them. Nothing about
# either is left for a human to do afterwards -- an installer that needs
# to be finished by hand is not an installer.

# Idempotent KEY=VALUE write into an env file: update in place when the
# key exists, append when it does not. Values here are absolute paths
# without '|', which is the sed delimiter.
upsert_env_var() {
    local file="$1" key="$2" value="$3"
    if grep -q "^${key}=" "$file"; then
        if ! sed -i "s|^${key}=.*|${key}=${value}|" "$file"; then
            error "Failed to update ${key} in ${file}"
            exit 1
        fi
    else
        if ! printf '%s=%s\n' "$key" "$value" >> "$file"; then
            error "Failed to append ${key} to ${file}"
            exit 1
        fi
    fi
}

# Read one field of one service out of the registry that ships in the
# velo checkout (repo/scripts/services.conf).
registry_field_for() {
    local wanted="$1" index="$2" conf="$INSTALL_BASE/repo/scripts/services.conf"
    [ -f "$conf" ] || return 1
    # shellcheck source=/dev/null
    source "$conf" || return 1
    local record
    for record in "${VELO_SERVICES[@]}"; do
        if [ "$(svc_field "$record" 1)" = "$wanted" ]; then
            svc_field "$record" "$index"
            return 0
        fi
    done
    return 1
}

# Read one service's branch out of the registry.
registry_branch_for() {
    local wanted="$1" conf="$INSTALL_BASE/repo/scripts/services.conf"
    if [ ! -f "$conf" ]; then
        error "Service registry not found at $conf"
        return 1
    fi
    # VELO_ROLE is in scope for `role:` expressions; VELO_BRANCH for `conf:`
    # -- both are read by svc_branch through indirect expansion, which is
    # why shellcheck cannot see the use.
    # shellcheck disable=SC2034
    local VELO_BRANCH="$GIT_BRANCH"
    # shellcheck source=/dev/null
    source "$conf" || return 1
    local record
    for record in "${VELO_SERVICES[@]}"; do
        if [ "$(svc_field "$record" 1)" = "$wanted" ]; then
            svc_branch "$(svc_field "$record" 4)" "$wanted" || return 1
            return 0
        fi
    done
    error "Service '$wanted' is not declared in $conf"
    return 1
}

# Read one KEY's value out of an env file. `grep`, deliberately not
# `source`: these files carry secrets and operator input, and sourcing
# executes whatever a value happens to look like.
read_env_value() {
    local file="$1" key="$2"
    [ -f "$file" ] || return 1
    # `tail -n 1`, not `grep -m1`: an env file resolves a repeated key
    # to the LAST assignment, exactly as a shell would. First-match
    # would hand the caller a stale value that nothing else on the box
    # agrees with. Same class as the env-render.sh fix (audit H-R4).
    grep -E "^${key}=" "$file" 2>/dev/null | tail -n 1 | cut -d= -f2-
}

# Gate on every value we push into another stack's env file.
#
# WHITELIST, not blacklist: we deliver exactly three shapes -- a bot
# token, a hostname-bearing URL and an absolute path -- and this set
# covers them with room to spare, so the guarantee is structural
# instead of a list of characters someone remembered to ban.
#
# Two things depend on it. (1) The comms CLI SOURCES its env file; its
# own comment justifies that by the file holding "openssl-hex and
# paths", which stops being the whole truth the moment operator input
# travels through it. (2) upsert_env_var uses '|' as the sed
# delimiter. Both were true by the composition of the values, not by
# construction. Now they are true by construction.
validate_deliverable() {
    local key="$1" value="$2"
    if [ -z "$value" ]; then
        error "Refusing to deliver an empty value for $key."
        return 1
    fi
    # `[[ =~ ]]`, deliberately NOT `grep -Eq '^...$'`: grep anchors PER
    # LINE, so a value carrying a newline passes it as long as each of
    # its lines is clean -- and a newline is the one character that
    # actually matters here, because it injects a whole extra KEY=VALUE
    # line into a file that gets sourced. Bash anchors the whole string.
    # (Caught by the negative twin, which is why the twin exists.)
    if ! [[ "$value" =~ ^[A-Za-z0-9:._/-]+$ ]]; then
        error "Refusing to deliver $key: value contains characters outside"
        error "the allowed set [A-Za-z0-9:._/-] (spaces, quotes, \$, backticks,"
        error "'|' and newlines are rejected -- they would break the env file"
        error "that the comms CLI sources)."
        return 1
    fi
    return 0
}

# item 1 -- the product profile reaches comms by BIND, not by a copy.
#
# PROFILE_DIR is pointed straight at the profile inside the velo
# checkout that this installer just cloned. Consequences, all wanted:
# `velo update` pulls the repo and the new templates are already on the
# path comms reads (no second copy to keep in sync), and the arch-doc
# promise "editing a template = a commit in the product repo -> roll
# out" becomes literally true.
#
# comms-deploy.sh needs no changes for this: its own seed step only
# fills an EMPTY directory, and this one is never empty -- it carries
# the profile from git. The seeding on pass 1 has already happened into
# /opt/comms/profile by the time we get here, so nothing is ever
# written into the git working tree.
#
# ┌─ KNOWN CEILING (convention §4a) ────────────────────────────────────
# │ (1) MECHANICS: binding the live profile to a git checkout means a
# │     broken types.yaml or template pulled by `velo update` takes the
# │     RUNNING comms stack down -- it validates the profile at startup
# │     and refuses to boot on a bad one. With the old copy-based
# │     scheme a bad commit could not do that.
# │ (2) STATUS: acknowledged by design -- this is the price of arch
# │     decision 12 (profile lives in the product repo, delivered by
# │     bind-mount), knowingly paid for single-source templates.
# │ (3) REFERENCE: T-32, item 1.
# │ (4) UNCONSERVATION TRIGGER: a profile edit ever reaching the server
# │     from something other than a reviewed commit (a web editor, a
# │     second author, a generated profile) -- at that point the
# │     checkout stops being a review gate and validation has to move
# │     in front of the restart.
# │ (5) SHAPE OF THE FIX: validate the profile in a throwaway container
# │     BEFORE restarting the live one (`compose run --rm` against the
# │     loader), and refuse the restart instead of performing it.
# │ (6) REJECTED, AND WHY:
# │     - doing that pre-validation NOW: it is extra machinery on every
# │       single update, able to fail on its own, for a failure mode
# │       whose recovery is already one command (revert the template
# │       commit, re-run `velo update`) and which `velo update` reports
# │       loudly by name;
# │     - going back to COPYING the profile into /opt/comms/profile: it
# │       removes this failure mode and kills decision 12 with it --
# │       two divergent copies of the templates and a manual step to
# │       keep them equal, which is exactly the defect this task exists
# │       to remove.
# └─────────────────────────────────────────────────────────────────────
deliver_comms_profile() {
    local comms_env="$1"
    local profile_dir="$INSTALL_BASE/repo/comms-profile"

    # Fail FAST and by name. Without this the failure still happens --
    # comms-app refuses to start on a profile that is missing or invalid
    # -- but it arrives as an opaque container health timeout minutes
    # later, with the real cause buried in another stack's logs.
    if [ ! -d "$profile_dir" ]; then
        error "Product profile not found at $profile_dir"
        error "The velo checkout must carry comms-profile/ (types.yaml +"
        error "templates/). comms will not start without a valid profile."
        exit 1
    fi
    if [ ! -f "$profile_dir/types.yaml" ] || [ ! -d "$profile_dir/templates" ]; then
        error "Profile at $profile_dir is incomplete."
        error "Expected types.yaml and templates/ -- found:"
        ls -A "$profile_dir" 2>/dev/null | sed 's/^/  /'
        exit 1
    fi

    validate_deliverable "PROFILE_DIR" "$profile_dir" || exit 1
    upsert_env_var "$comms_env" "PROFILE_DIR" "$profile_dir"
    success "PROFILE_DIR=$profile_dir (bind: comms reads the profile from the velo checkout)"
}

# item 2 -- the bot token and the channel mode reach comms from the ONE
# place they were ever entered: the installer's own prompt.
#
# Both values are read back OUT of the velo .env rather than rebuilt
# from shell variables. Two reasons, both load-bearing:
#   - byte-equality with what velo itself uses is then a property of
#     the code, not a coincidence of two formulas staying in step;
#   - generate_env() is a hard no-op when backend/.env already exists,
#     so on a re-run over a live box the prompt never happens and those
#     shell variables do not exist at all.
#
# THE GUARD: nothing delivered unless BOTH values are present. A re-run
# without the prompt would otherwise push emptiness over a working
# real-mode config and silently mute a live installation. Empty is
# never an instruction here -- it only ever means "this run had nothing
# to say".
deliver_comms_telegram() {
    local comms_env="$1" velo_env="$2"
    local token url

    token=$(read_env_value "$velo_env" "TELEGRAM_BOT_TOKEN" || true)
    url=$(read_env_value "$velo_env" "TELEGRAM_BOT_URL" || true)

    if [ -z "${token:-}" ] || [ -z "${url:-}" ]; then
        warn "Telegram credentials NOT delivered to comms on this run."
        warn "backend/.env already existed, so the installer never asked for a"
        warn "token -- and pushing empty values would break a working comms."
        warn "Existing TELEGRAM_BOT_TOKEN / TELEGRAM_BOT_URL / CHANNELS_MODE in"
        warn "$comms_env are left exactly as they are."
        warn "A clean delivery is a WIPE + fresh install -- never a hand edit"
        warn "of either .env (the installer is the deliverable; a server edited"
        warn "by hand is a server nobody can reproduce)."
        COMMS_TELEGRAM_DELIVERED=0
        return 0
    fi

    # Both or neither: TELEGRAM_BOT_URL is derived from the token (it
    # carries the username Telegram answered with for THAT token), so
    # moving one without the other is meaningless. And real mode
    # validates BOTH at startup -- comms refuses to boot on an empty
    # bot URL, because every deep-link button would be built from it.
    validate_deliverable "TELEGRAM_BOT_TOKEN" "$token" || exit 1
    validate_deliverable "TELEGRAM_BOT_URL" "$url" || exit 1

    upsert_env_var "$comms_env" "TELEGRAM_BOT_TOKEN" "$token"
    upsert_env_var "$comms_env" "TELEGRAM_BOT_URL" "$url"
    upsert_env_var "$comms_env" "CHANNELS_MODE" "real"
    COMMS_TELEGRAM_DELIVERED=1
    success "Telegram credentials delivered to comms; CHANNELS_MODE=real"
}

# Set by deliver_comms_telegram, read by the install summary.
COMMS_TELEGRAM_DELIVERED=0

setup_comms() {
    log "Setting up the comms stack (orchestrated)..."

    local COMMS_DEPLOY="$COMMS_REPO_DIR/deploy/comms-deploy.sh"
    local VELO_ENV="$INSTALL_BASE/repo/backend/.env"
    local COMMS_ENV="$COMMS_INSTALL_BASE/.env"

    # The branch comes from the SERVICE REGISTRY in the checkout we just
    # cloned -- the same file `velo update` reads, so the install and every
    # later update can never disagree about what this server tracks.
    local comms_branch
    if ! comms_branch=$(registry_branch_for comms); then
        error "Could not resolve the comms branch from the service registry"
        exit 1
    fi

    # The remote comes from the registry, not from a constant here: the
    # slug is declared once, in field 2, and the host alias matches the
    # key provision_service_keys wrote for this service. Assembled at the
    # point of use so a failure to resolve it stops HERE, by name, rather
    # than surfacing as `git clone ""` a moment later.
    local comms_slug
    if ! comms_slug=$(registry_field_for comms 2) || [ -z "$comms_slug" ]; then
        error "Could not resolve the comms repo slug from the service registry"
        exit 1
    fi
    COMMS_REPO_URL="git@github.com-comms:${comms_slug}.git"

    # -- 1. Clone the comms repo (SSH, dedicated READ-ONLY deploy key --
    # provisioned by the registry loop after clone_repo; all keys
    # strictly private, always) --
    if [ -d "$COMMS_REPO_DIR" ]; then
        # Practically unreachable after the cleanup block wiped /opt/comms,
        # but a partial re-run must reuse state, not re-clone over it.
        warn "comms checkout already present at $COMMS_REPO_DIR -- reusing it"
    else
        mkdir -p "$COMMS_INSTALL_BASE"
        if ! git clone -b "$comms_branch" "$COMMS_REPO_URL" "$COMMS_REPO_DIR"; then
            error "Failed to clone $COMMS_REPO_URL (branch: $comms_branch)"
            exit 1
        fi
        success "comms cloned to $COMMS_REPO_DIR (branch: $comms_branch)"
    fi

    if [ ! -f "$COMMS_DEPLOY" ]; then
        error "comms deploy CLI not found at $COMMS_DEPLOY"
        error "Does branch '$comms_branch' carry comms/deploy/ (Phase 5)?"
        exit 1
    fi

    # -- 2. Pass 1: mint secrets + seed smoke profile + bring the stack up --
    # Every failure below is a HARD abort: a "successful" install that
    # brought up velo without a linked comms would be hidden breakage.
    log "comms-deploy install, pass 1 (secrets + smoke profile + bring-up)..."
    if ! bash "$COMMS_DEPLOY" install; then
        error "comms-deploy.sh install (pass 1) FAILED -- aborting."
        error "Logs: bash $COMMS_DEPLOY logs"
        exit 1
    fi

    # -- 3. Point the token hand-over at the velo backend .env --
    if [ ! -f "$COMMS_ENV" ]; then
        error "$COMMS_ENV not found after pass 1 -- comms install did not mint its env"
        exit 1
    fi
    upsert_env_var "$COMMS_ENV" "PRODUCT_ENV_PATH" "$VELO_ENV"
    success "PRODUCT_ENV_PATH=$VELO_ENV written into $COMMS_ENV"

    # -- 3b. Deliver the product PROFILE and the telegram credentials -----
    # T-32 items 1 and 2. Everything below rides the SAME two-pass seam as
    # PRODUCT_ENV_PATH above, for the same documented reason: the comms CLI
    # sources /opt/comms/.env, which overrides the process environment, so
    # a value only arrives if it is IN THE FILE before pass 2 runs.
    #
    # Deliberately done from THIS side and not by teaching comms-deploy.sh
    # about products: comms is one deploy body for several products
    # (cbshome next), and everything product-specific -- which profile,
    # which bot -- is ours to supply. comms stays agnostic; the installer
    # is the only artifact that knows about VELO.
    deliver_comms_profile "$COMMS_ENV"
    deliver_comms_telegram "$COMMS_ENV" "$VELO_ENV"

    # -- 4. Pass 2: idempotent re-run -- executes the token hand-over --
    log "comms-deploy install, pass 2 (COMMS_* hand-over into velo .env)..."
    if ! bash "$COMMS_DEPLOY" install; then
        error "comms-deploy.sh install (pass 2) FAILED -- aborting."
        exit 1
    fi

    # -- 5. Verify the seam actually closed --
    # The hand-over deliberately degrades to PRINTING the block when its
    # target is unusable, without failing. Fine for the manual flow; for
    # orchestration that would be a silent failure -- velo would start
    # unlinked while the installer reports success. So: every key must be
    # present with a non-empty value, or the install dies here.
    local key
    for key in COMMS_SERVICE_TOKEN COMMS_API_URL COMMS_REDIS_URL; do
        if ! grep -Eq "^${key}=.+" "$VELO_ENV"; then
            error "$key missing (or empty) in $VELO_ENV after the hand-over."
            error "The token seam did not close -- velo would start unlinked."
            exit 1
        fi
    done
    success "COMMS_* variables verified in $VELO_ENV"
    success "comms stack is up and linked (profile: $INSTALL_BASE/repo/comms-profile)"
    if [ "$COMMS_TELEGRAM_DELIVERED" -eq 1 ]; then
        success "comms channels: real (bot token delivered by this installer)"
    else
        warn "comms channels: UNCHANGED on this run -- see the note above."
    fi
}

setup_comms

# ==============================================================================
# START DOCKER STACK
# ==============================================================================

start_stack() {
    log "Starting VELO Docker stack..."

    cd "$INSTALL_BASE/repo"

    set -a; source "$INSTALL_BASE/vite.env"; set +a

    # -- 1. Build and start backend + infrastructure --
    log "Building backend..."
    # Explicitly checked: a failed image build must not fall through to
    # `up -d`, which would start whatever image (if any) already existed
    # under that tag while reporting the stack as started.
    if ! docker compose build --no-cache app; then
        error "Backend image build FAILED — stack was not started."
        error "Fix the code / .env, then re-run this installer, or:"
        error "  cd $INSTALL_BASE/repo && docker compose build app"
        exit 1
    fi
    docker compose up -d app postgres redis

    # Wait for backend health before generating types.
    log "Waiting for backend to become healthy..."
    sleep 10

    local HEALTH_URL="http://127.0.0.1:8000/health"
    local RETRIES=12  # 12 x 5s = 60s max

    for i in $(seq 1 $RETRIES); do
        if curl -s "$HEALTH_URL" | grep -q '"status"'; then
            success "Backend is running"
            break
        fi
        echo -n "."
        sleep 5
        if [ "$i" -eq "$RETRIES" ]; then
            error "Backend did not respond within 60s"
            warn "Check logs: docker compose logs app"
            return 1
        fi
    done

    # -- 2. Create the database schema --
    #
    # THIS STEP WAS MISSING UNTIL 2026-08-21 and the gap is instructive.
    # `alembic upgrade head` appeared NOWHERE in this installer: the schema
    # was only ever created by `velo update`, which does run it. So a fresh
    # install produced a stack that started, passed its health check,
    # generated types and reported success -- against a database with no
    # tables at all. It stayed invisible for as long as reinstalls ran on
    # top of a surviving postgres volume, where the tables were left over
    # from some earlier `velo update`. The first reinstall that dropped the
    # volume (`docker compose down -v`) exposed it: every request to
    # /auth/telegram returned 500 on `relation "users" does not exist`, and
    # the frontend showed its "open me in Telegram" stub, because that stub
    # covers "not authenticated" as well as "not in Telegram".
    #
    # It sits AFTER the health check (the app must be up to exec into) and
    # BEFORE type generation, so a schema failure stops the install rather
    # than letting it walk on to the cosmetic steps.
    #
    # /health passing is NOT evidence the schema exists -- it does not touch
    # these tables. Do not read a green health check as a working database.
    log "Running database migrations..."
    if ! docker compose exec -T app python -m alembic upgrade head; then
        error "Database migrations FAILED — the schema was NOT created."
        error "The stack is up but the app cannot work: every write will"
        error "fail on a missing table. Check logs: docker compose logs app"
        error "Then re-run:  velo db migrate"
        exit 1
    fi
    success "Database schema is up to date"

    # -- 3. Generate frontend types from live backend OpenAPI --
    log "Generating frontend API types from backend OpenAPI..."
    # Unpredictable path, created 600 by mktemp, removed by the EXIT trap
    # at the top of this script whichever way we leave. NOT `local`: the
    # trap must be able to see it.
    if ! OPENAPI_TMP=$(mktemp -t velo-openapi.XXXXXX); then
        error "Could not create a temporary file for the OpenAPI snapshot."
        exit 1
    fi
    # -f (fail on HTTP error) is required, not cosmetic: without it curl exits
    # 0 on a 500 and writes the error body to the file instead of failing here.
    if ! curl -sf http://127.0.0.1:8000/openapi.json > "$OPENAPI_TMP"; then
        error "Could not fetch openapi.json from the backend — is it healthy?"
        rm -f "$OPENAPI_TMP"
        exit 1
    fi
    if ! python3 "$INSTALL_BASE/repo/backend/scripts/generate_ts_types.py" \
        "$OPENAPI_TMP" \
        "$INSTALL_BASE/repo/frontend/src/api/generated.ts"; then
        error "Type generation FAILED."
        rm -f "$OPENAPI_TMP"
        exit 1
    fi
    rm -f "$OPENAPI_TMP"
    OPENAPI_TMP=""
    success "Frontend types generated"

    # -- 4. Build and start frontend (picks up fresh generated.ts) --
    log "Building frontend..."
    if ! docker compose build --no-cache frontend; then
        error "Frontend image build FAILED (unit tests run inside the build)."
        error "Fix the code, then re-run this installer, or:"
        error "  cd $INSTALL_BASE/repo && docker compose build frontend"
        exit 1
    fi
    docker compose up -d frontend

    log "Waiting for frontend..."
    sleep 5

    info "Health check response:"
    curl -s "$HEALTH_URL" | python3 -m json.tool 2>/dev/null || curl -s "$HEALTH_URL"
    echo ""
}

start_stack

# ==============================================================================
# MANAGEMENT COMMAND
# ==============================================================================

install_management_shim() {
    log "Installing the velo management command..."

    mkdir -p "$INSTALL_BASE/scripts"
    chmod +x "$INSTALL_BASE/repo/scripts/velo-manage.sh"

    # A THIN SHIM, not a copy. Real management logic lives entirely in the
    # tracked scripts/velo-manage.sh inside the repo checkout, which `velo
    # update` pulls like any other file (git replaces the file's inode on
    # checkout, so this shim's own already-running process is never affected
    # by that pull -- verified locally before this was built). This shim
    # itself never needs to change again: it has nothing to fix or drift,
    # because it does nothing but point at the repo.
    cat > "$INSTALL_BASE/scripts/manage.sh" << EOF
#!/bin/bash
# VELO management shim -- do not hand-edit the logic here.
# The real script is scripts/velo-manage.sh, tracked in the repo; it updates
# with \`velo update\` like any other file. This file only execs it.
exec "$INSTALL_BASE/repo/scripts/velo-manage.sh" "\$@"
EOF
    chmod +x "$INSTALL_BASE/scripts/manage.sh"

    # The values velo-manage.sh cannot get from the repo, because they are
    # not code -- they are what makes this server THIS server.
    # VELO_BRANCH joined them (H-D1, 2026-08-04): `velo update` used to read
    # the branch off the live checkout, so DRIFT was the source of truth and
    # a checkout nudged sideways stayed sideways. Recorded here, it is what
    # every later update reconciles the checkout to -- no question asked, no
    # hand fix on the server. Service branches are NOT here: they are policy,
    # identical on every server of this product, and live in the registry.
    # Phase 6 / T0 finding #2: VELO_ROLE joined them -- the role fork used
    # to die at install time (it only picked the branch), while `velo
    # update` stayed role-blind and ran the pytest suite against the live
    # DB on ANY server. Now the role persists and velo-manage.sh gates the
    # test-only phases (pytest + comms projection resync) on it.
    # DOMAIN_PUBLIC is recorded even when empty, and that is the point:
    # `velo doctor` renders the expected nginx config from these values
    # and diffs it against the live file. Without the third domain here,
    # every server that opted in would report permanent nginx drift --
    # the doctor would be lying because we did not tell it what we built.
    cat > "$INSTALL_BASE/velo.conf" << EOF
DOMAIN_FRONTEND=${DOMAIN_FRONTEND}
DOMAIN_API=${DOMAIN_API}
DOMAIN_PUBLIC=${DOMAIN_PUBLIC}
VELO_ROLE=${VELO_ROLE}
VELO_BRANCH=${GIT_BRANCH}
EOF

    ln -sf "$INSTALL_BASE/scripts/manage.sh" /usr/local/bin/velo

    success "Management command installed (use 'velo' command)"
}

install_management_shim

# ==============================================================================
# BACKUP CRON
# ==============================================================================

setup_backup_cron() {
    if ! crontab -l 2>/dev/null | grep -q "velo backup"; then
        log "Setting up daily backup cron..."
        (crontab -l 2>/dev/null; echo "0 4 * * * /usr/local/bin/velo backup >> /var/log/velo-backup.log 2>&1") | crontab -
        success "Daily backup cron added (4 AM)"
    fi
}

setup_backup_cron

# ==============================================================================
# HOUSEKEEPING -- leave the box tidy, not just working
# ==============================================================================

# The install builds both stacks with --no-cache, which is correct (a fresh
# box must not inherit a stale layer) and expensive: it leaves gigabytes of
# buildkit cache behind. `velo update` reaps leftovers older than a day; that
# filter deliberately does not fit HERE, where everything was made minutes ago
# and none of it is needed again. Volumes are never touched.
cleanup_build_leftovers() {
    log "Reclaiming build leftovers..."
    docker image prune -f > /dev/null 2>&1 || true
    docker builder prune -f > /dev/null 2>&1 || true
    success "Build cache and dangling images reclaimed"
}

cleanup_build_leftovers

# Cap the systemd journal. Unbounded, it grows to 10% of the filesystem by
# default -- on a 30G VPS shared with two docker stacks that is gigabytes of
# logs nobody reads, discovered only when a build dies out of disk space. A
# server's own limits are the installer's job, not something to fix by hand
# later (which is banned anyway).
cap_journal_size() {
    local conf=/etc/systemd/journald.conf
    [ -f "$conf" ] || return 0
    if grep -qE '^\s*SystemMaxUse=' "$conf"; then
        success "journald size cap already configured -- left untouched"
        return 0
    fi
    if printf '\n# Capped by install_velo.sh: a VPS journal has no business\n# growing past a few hundred megabytes.\nSystemMaxUse=200M\n' >> "$conf"; then
        systemctl restart systemd-journald > /dev/null 2>&1 || true
        journalctl --vacuum-size=200M > /dev/null 2>&1 || true
        success "journald capped at 200M"
    else
        warn "Could not cap journald size -- check $conf by hand"
    fi
}

cap_journal_size

# ==============================================================================
# POST-INSTALLATION
# ==============================================================================

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║    VELO Installation Completed Successfully!  ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════╝${NC}"
echo ""

info "Server: $SERVER_IP ($VELO_ROLE, branch $GIT_BRANCH)"
info "Frontend: https://$DOMAIN_FRONTEND"
info "API:      https://$DOMAIN_API"
info "Health:   https://$DOMAIN_API/health"
info "Comms:    up on '$SHARED_NETWORK' (internal API, no public port; profile bound from repo/comms-profile; branch per scripts/services.conf)"
if [ -n "$DOMAIN_PUBLIC" ]; then
    if [ "$PUBLIC_DOMAIN_NO_CERT" -eq 1 ]; then
        warn "Public link base: https://$DOMAIN_PUBLIC — NO CERTIFICATE."
        warn "  PUBLIC_LINK_BASE in backend/.env points at that domain, but its"
        warn "  certificate was not issued, so https:// links built from it will"
        warn "  not work until DNS is fixed and the certificate is re-requested."
        warn "  NOT harmless (T-35): every /z/{code} practice link a master"
        warn "  copies is built from this value, so those links are dead until"
        warn "  the certificate exists."
        warn "  Re-request: certbot certonly --webroot --webroot-path=/var/www/certbot -d $DOMAIN_PUBLIC"
        warn "  Then re-render nginx: velo doctor  (shows the drift), then reload."
    else
        info "Public:   https://$DOMAIN_PUBLIC  (link base for /z/{code} practice links — T-35)"
    fi
else
    # No public domain was given, so every practice link a master copies will
    # read https://api.<...>/z/... -- correct, and it is what a PARTICIPANT
    # sees in a Telegram channel. Said out loud here rather than left to be
    # discovered in a channel: skipping the prompt is silent, and silence is
    # how an "api." host ends up in front of end users.
    warn "Practice links will be published as https://${DOMAIN_API}/z/<code>"
    warn "  -- no public link domain was given at install. Participants see"
    warn "  this host in Telegram channels. Changing it later means a"
    warn "  reinstall (backend/.env is written once)."
fi
echo ""

info "Directory structure:"
echo "  $INSTALL_BASE/"
echo "  ├── repo/              # Git repository (scripts/velo-manage.sh lives here)"
echo "  ├── scripts/manage.sh  # thin shim -- do not hand-edit, see the file"
echo "  ├── velo.conf          # this server's domains (incl. the optional public one)"
echo "  └── backups/           # daily backups"
echo "  $COMMS_INSTALL_BASE/"
echo "  ├── repo/              # comms checkout (CLI: repo/deploy/comms-deploy.sh)"
echo "  ├── .env               # comms master env (secrets, minted once)"
echo "  ├── profile/           # unused here: the live profile is bound from"
echo "  │                      #   $INSTALL_BASE/repo/comms-profile/"
echo "  └── backups/           # comms db dumps"

log "Management commands:"
echo -e "  ${CYAN}velo status${NC}          — Check everything"
echo -e "  ${CYAN}velo version${NC}         — What is ACTUALLY running + drift check"
echo -e "  ${CYAN}velo logs${NC}            — View app logs"
echo -e "  ${CYAN}velo test${NC}            — Run all tests (backend + frontend)"
echo -e "  ${CYAN}velo update${NC}          — Pull + rebuild + migrate + test"
echo -e "  ${CYAN}velo restart${NC}         — Restart all services"
echo -e "  ${CYAN}velo db connect${NC}      — Open psql"
echo -e "  ${CYAN}velo backup${NC}          — Manual backup"
echo -e "  ${CYAN}bash $COMMS_REPO_DIR/deploy/comms-deploy.sh status${NC} — comms stack (lifecycle is decoupled from velo)"
echo ""

warn "Next steps:"
echo "  1. Verify: velo status"
echo "  2. Verify: velo version   (confirms the script matches git, no drift)"
echo "  3. Check:  curl https://$DOMAIN_API/health"
echo "  4. Open:   https://$DOMAIN_FRONTEND"
echo ""
