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
#   9. Starts the Docker stack (app + postgres + redis + frontend)
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
# now. The only two things that legitimately differ per server -- which
# branch to track, which domains to serve, and whether a real Stripe key
# exists -- are asked for below, not hardcoded.
#
# USAGE:
#   First time:   sudo bash install_velo.sh
#                 (comms branch override: sudo COMMS_BRANCH=test bash install_velo.sh)
#   After that:   velo status | velo logs | velo update | velo version | ...
#                 comms lifecycle: bash /opt/comms/repo/deploy/comms-deploy.sh {status|update|logs|db}
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
GITHUB_REPO="aivis-one/velo"
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
COMMS_GITHUB_REPO="aivis-one/comms"
# SSH via a DEDICATED deploy key, ALWAYS (owner ruling: all keys strictly
# private -- no anonymous-HTTPS assumption, even while the repo happens to
# be public today). One code path regardless of repo visibility, so closing
# the repo later is a non-event. A separate key is not a choice: GitHub
# refuses to attach one deploy key to two repositories. READ-ONLY is enough
# for comms -- comms-deploy.sh only ever pulls (velo's own key needs write
# because `velo update` pushes generated.ts).
COMMS_REPO_URL=""  # set after comms SSH key setup (setup_comms_ssh)
# Branch to clone. main carries v1.1.0-rc and deploy/ is currently identical
# on main and test, so the default is right for BOTH server roles; pinning a
# tag on prod is a later refinement. Override per run:
#   sudo COMMS_BRANCH=test bash install_velo.sh
COMMS_BRANCH="${COMMS_BRANCH:-main}"
# Shared external docker network joining the velo and comms stacks.
SHARED_NETWORK="aivis-shared"

# === Per-server configuration -- filled in by ask_config(), not hardcoded ===
VELO_ROLE=""
GIT_BRANCH=""
DOMAIN_FRONTEND=""
DOMAIN_API=""
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

# === Error handler ===
handle_error() {
    error "Error occurred at line: ${1}"
    error "Installation failed. Check output above for details."
    exit 1
}
trap 'handle_error ${LINENO}' ERR

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

    success "Role: $VELO_ROLE · Branch: $GIT_BRANCH · Domains: $DOMAIN_FRONTEND / $DOMAIN_API"
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

    for CHECK_DOMAIN in "$DOMAIN_FRONTEND" "$DOMAIN_API"; do
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
echo -e "  Type  Name                Value"
echo -e "  ────  ──────────────────  ─────────────────"
echo -e "  A     $DOMAIN_FRONTEND    $SERVER_IP"
echo -e "  A     $DOMAIN_API         $SERVER_IP"
echo ""
echo -e "${YELLOW}Both records must resolve to this server before SSL setup.${NC}"
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

setup_ssh() {
    log "Setting up SSH for GitHub..."

    DEPLOY_KEY="/root/.ssh/id_ed25519_velo_deploy"

    # Add GitHub to known hosts
    mkdir -p /root/.ssh
    chmod 700 /root/.ssh
    if ! grep -q "github.com" /root/.ssh/known_hosts 2>/dev/null; then
        ssh-keyscan -H github.com >> /root/.ssh/known_hosts 2>/dev/null
    fi

    # Generate deploy key if not exists
    if [ ! -f "$DEPLOY_KEY" ]; then
        ssh-keygen -t ed25519 -C "velo-deploy@$(hostname)" -f "$DEPLOY_KEY" -N ""
        success "Deploy key generated"
    else
        success "Deploy key already exists"
    fi

    echo ""
    echo -e "${CYAN}═══════════════════════════════════════════════${NC}"
    echo -e "${CYAN}  GitHub Deploy Key (add to repo settings)${NC}"
    echo -e "${CYAN}═══════════════════════════════════════════════${NC}"
    echo ""
    cat "${DEPLOY_KEY}.pub"
    echo ""
    echo -e "${YELLOW}Go to: https://github.com/$GITHUB_REPO/settings/keys${NC}"
    echo -e "${YELLOW}Click 'Add deploy key', paste the key above.${NC}"
    echo -e "${RED}IMPORTANT: tick 'Allow write access'.${NC}"
    echo -e "${YELLOW}'velo update' commits & pushes regenerated generated.ts to branch '$GIT_BRANCH'.${NC}"
    echo ""
    read -p "Press ENTER after adding the deploy key to GitHub..."

    # Configure SSH to use this key for GitHub
    if ! grep -q "Host github.com-velo" /root/.ssh/config 2>/dev/null; then
        cat >> /root/.ssh/config << EOF

# VELO Deploy Key
Host github.com-velo
    HostName github.com
    User git
    IdentityFile $DEPLOY_KEY
    IdentitiesOnly yes
EOF
        chmod 600 /root/.ssh/config
    fi

    REPO_URL="git@github.com-velo:$GITHUB_REPO.git"

    # Test connection
    log "Testing GitHub connection..."
    if ssh -T git@github.com-velo 2>&1 | grep -q "successfully authenticated"; then
        success "GitHub connection OK"
    else
        error "Cannot connect to GitHub"
        error "Make sure the deploy key is added to: https://github.com/$GITHUB_REPO/settings/keys"
        return 1
    fi
}

setup_ssh

# ==============================================================================
# SSH SETUP FOR THE COMMS REPO
# ==============================================================================
# Mirror of setup_ssh above, for the SECOND repo this installer clones.
# Sits right behind it in the linear flow so the operator handles both
# GitHub-key steps in one sitting; github.com is already in known_hosts
# by the time this runs.

setup_comms_ssh() {
    log "Setting up SSH for the comms repo..."

    COMMS_DEPLOY_KEY="/root/.ssh/id_ed25519_comms_deploy"

    # Generate the comms deploy key if not exists (guard mirrors setup_ssh:
    # a reinstall reuses the key already known to GitHub).
    if [ ! -f "$COMMS_DEPLOY_KEY" ]; then
        ssh-keygen -t ed25519 -C "comms-deploy@$(hostname)" -f "$COMMS_DEPLOY_KEY" -N ""
        success "comms deploy key generated"
    else
        success "comms deploy key already exists"
    fi

    echo ""
    echo -e "${CYAN}═══════════════════════════════════════════════${NC}"
    echo -e "${CYAN}  GitHub Deploy Key -- COMMS repo${NC}"
    echo -e "${CYAN}═══════════════════════════════════════════════${NC}"
    echo ""
    cat "${COMMS_DEPLOY_KEY}.pub"
    echo ""
    echo -e "${YELLOW}Go to: https://github.com/$COMMS_GITHUB_REPO/settings/keys${NC}"
    echo -e "${YELLOW}Click 'Add deploy key', paste the key above.${NC}"
    echo -e "${GREEN}READ-ONLY is enough: do NOT tick 'Allow write access'.${NC}"
    echo -e "${YELLOW}(comms-deploy.sh only pulls -- unlike velo, nothing ever pushes to comms.)${NC}"
    echo ""
    read -r -p "Press ENTER after adding the deploy key to GitHub..."

    # Configure SSH to use this key for the comms remote (host alias --
    # same mechanism as github.com-velo above; one key per repo, GitHub
    # does not allow sharing a deploy key across repositories).
    if ! grep -q "Host github.com-comms" /root/.ssh/config 2>/dev/null; then
        cat >> /root/.ssh/config << EOF

# COMMS Deploy Key (read-only)
Host github.com-comms
    HostName github.com
    User git
    IdentityFile $COMMS_DEPLOY_KEY
    IdentitiesOnly yes
EOF
        chmod 600 /root/.ssh/config
    fi

    COMMS_REPO_URL="git@github.com-comms:$COMMS_GITHUB_REPO.git"

    # Test connection
    log "Testing GitHub connection (comms key)..."
    if ssh -T git@github.com-comms 2>&1 | grep -q "successfully authenticated"; then
        success "GitHub connection OK (comms)"
    else
        error "Cannot connect to GitHub with the comms deploy key"
        error "Make sure the key is added to: https://github.com/$COMMS_GITHUB_REPO/settings/keys"
        return 1
    fi
}

setup_comms_ssh

# ==============================================================================
# CLONE REPOSITORY
# ==============================================================================

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

# --- Telegram ---
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
# Bot URL for notification deep links. Username resolved via Telegram getMe.
TELEGRAM_BOT_URL=https://${TELEGRAM_LINK_DOMAIN}/${TELEGRAM_BOT_USERNAME}
# Live Telegram link host. The backend rewrites every Telegram URL onto it --
# both this bot URL and the avatar URLs Telegram sends in initData.
TELEGRAM_LINK_DOMAIN=${TELEGRAM_LINK_DOMAIN}

# --- Session ---
SESSION_TTL_DAYS=30

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
    render_nginx_http "$DOMAIN_FRONTEND" "$DOMAIN_API" > /etc/nginx/sites-available/velo

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
        render_nginx_ssl "$DOMAIN_FRONTEND" "$DOMAIN_API" > /etc/nginx/sites-available/velo

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

        # Auto-renewal cron
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
# already in its env_file -- no backend restart needed. The smoke profile
# is the deliberate default; the real product profile is a parallel track
# and is dropped into /opt/comms/profile later.

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

setup_comms() {
    log "Setting up the comms stack (orchestrated)..."

    local COMMS_DEPLOY="$COMMS_REPO_DIR/deploy/comms-deploy.sh"
    local VELO_ENV="$INSTALL_BASE/repo/backend/.env"
    local COMMS_ENV="$COMMS_INSTALL_BASE/.env"

    # -- 1. Clone the comms repo (SSH, dedicated READ-ONLY deploy key --
    # set up in setup_comms_ssh; all keys strictly private, always) --
    if [ -d "$COMMS_REPO_DIR" ]; then
        # Practically unreachable after the cleanup block wiped /opt/comms,
        # but a partial re-run must reuse state, not re-clone over it.
        warn "comms checkout already present at $COMMS_REPO_DIR -- reusing it"
    else
        mkdir -p "$COMMS_INSTALL_BASE"
        if ! git clone -b "$COMMS_BRANCH" "$COMMS_REPO_URL" "$COMMS_REPO_DIR"; then
            error "Failed to clone $COMMS_REPO_URL (branch: $COMMS_BRANCH)"
            exit 1
        fi
        success "comms cloned to $COMMS_REPO_DIR (branch: $COMMS_BRANCH)"
    fi

    if [ ! -f "$COMMS_DEPLOY" ]; then
        error "comms deploy CLI not found at $COMMS_DEPLOY"
        error "Does branch '$COMMS_BRANCH' carry comms/deploy/ (Phase 5)?"
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
    success "comms stack is up and linked (smoke profile; drop the real product profile into $COMMS_INSTALL_BASE/profile later)"
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

    # -- 2. Generate frontend types from live backend OpenAPI --
    log "Generating frontend API types from backend OpenAPI..."
    # -f (fail on HTTP error) is required, not cosmetic: without it curl exits
    # 0 on a 500 and writes the error body to the file instead of failing here.
    if ! curl -sf http://127.0.0.1:8000/openapi.json > /tmp/openapi.json; then
        error "Could not fetch openapi.json from the backend — is it healthy?"
        rm -f /tmp/openapi.json
        exit 1
    fi
    if ! python3 "$INSTALL_BASE/repo/backend/scripts/generate_ts_types.py" \
        /tmp/openapi.json \
        "$INSTALL_BASE/repo/frontend/src/api/generated.ts"; then
        error "Type generation FAILED."
        rm -f /tmp/openapi.json
        exit 1
    fi
    rm -f /tmp/openapi.json
    success "Frontend types generated"

    # -- 3. Build and start frontend (picks up fresh generated.ts) --
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

    # The two values velo-manage.sh cannot get from the repo, because they
    # are not code -- they are what makes this server THIS server.
    cat > "$INSTALL_BASE/velo.conf" << EOF
DOMAIN_FRONTEND=${DOMAIN_FRONTEND}
DOMAIN_API=${DOMAIN_API}
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
info "Comms:    up on '$SHARED_NETWORK' (internal API, no public port; smoke profile, branch $COMMS_BRANCH)"
echo ""

info "Directory structure:"
echo "  $INSTALL_BASE/"
echo "  ├── repo/              # Git repository (scripts/velo-manage.sh lives here)"
echo "  ├── scripts/manage.sh  # thin shim -- do not hand-edit, see the file"
echo "  ├── velo.conf          # this server's domains"
echo "  └── backups/           # daily backups"
echo "  $COMMS_INSTALL_BASE/"
echo "  ├── repo/              # comms checkout (CLI: repo/deploy/comms-deploy.sh)"
echo "  ├── .env               # comms master env (secrets, minted once)"
echo "  ├── profile/           # per-product profile (smoke seeded -- drop the real one on top)"
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
echo -e "  ${CYAN}velo seed${NC}            — Populate DB with test data"
echo -e "  ${CYAN}bash $COMMS_REPO_DIR/deploy/comms-deploy.sh status${NC} — comms stack (lifecycle is decoupled from velo)"
echo ""

warn "Next steps:"
echo "  1. Verify: velo status"
echo "  2. Verify: velo version   (confirms the script matches git, no drift)"
echo "  3. Check:  curl https://$DOMAIN_API/health"
echo "  4. Open:   https://$DOMAIN_FRONTEND"
echo ""
