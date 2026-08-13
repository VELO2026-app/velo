#!/bin/bash
# Pure function library -- projects the DATABASE half of backend/.env
# into backend/.env.db. Sourced by install_velo.sh (fresh install) and
# by velo-manage.sh (update, after the pull), so the two never carry
# separate copies of this projection. Same reason nginx-render.sh
# exists: one tracked copy of the logic two scripts must agree on.
#
# WHY THIS FILE EXISTS (T-32 item 9):
# docker-compose.yml used to hand ./backend/.env -- the WHOLE product
# env -- to postgres and redis via env_file. Those two containers then
# saw every application secret on the box, so compromising either
# datastore meant handing over all of them. Their real need is narrow:
# redis consumes exactly REDIS_PASSWORD (in its `command` and in its
# healthcheck), postgres consumes its own POSTGRES_* at init.
#
# WHY A PROJECTION AND NOT A SECOND MINT:
# backend/.env stays the ONE source of these passwords. Minting fresh
# values into a separate file would break a re-run over a live postgres
# volume -- the file would carry a new password while the volume kept
# the old one, and the stack would not come up. Deriving the file from
# backend/.env on every run is deterministic, hence idempotent, hence
# safe to repeat.
#
# WHY NOT compose-level interpolation (${VAR} + a .env next to the
# compose file): that is a SECOND secrets file at the checkout root
# which compose hands to every service implicitly, and the same
# password would then live in two independently edited places. A narrow
# env_file is narrow structurally, not by discipline.
#
# ---------------------------------------------------------------------
# MERGED 2026-08-12 from two versions that had diverged, each carrying a
# defect the other did not (T-33 item 10). Recorded because both are the
# kind that reads as correct:
#
#   - `grep -m1` (FIRST match) for a key. Wrong: this file is read the
#     way a shell reads assignments, so a repeated key means the LAST
#     one wins. First-match would project a stale password while the
#     postgres volume kept the current one -- a stack that will not
#     start, blamed on anything but this.
#   - `[ -z "$line" ]` to detect a missing key. Wrong: the line
#     `POSTGRES_PASSWORD=` is not empty, so an EMPTY value passed the
#     check. Empty REDIS_PASSWORD is the sharp one -- the compose
#     `command` branches on it and starts redis with no `--requirepass`
#     at all.
#
# Both are now covered by fixtures in scripts/test_env_render.sh.
# Neither was caught by review; both were caught by a negative twin.
# ---------------------------------------------------------------------

# The complete allowlist, and the ONLY thing that decides what leaves
# backend/.env. postgres:16 reads the three POSTGRES_* keys at init;
# redis reads REDIS_PASSWORD, both for `--requirepass` and for the
# healthcheck's REDISCLI_AUTH. Anything not named here is, by design,
# invisible to both containers -- which is the entire point of this
# file, so extend the list only with a reason.
#
# ONE list, used by both the check and the render below: two copies
# would be two places to forget.
_DB_ENV_KEYS=(
    POSTGRES_DB
    POSTGRES_USER
    POSTGRES_PASSWORD
    REDIS_PASSWORD
)

# Print the assignment line for KEY out of FILE, or nothing if there is
# none.
#
# `tail -n 1` -- LAST occurrence, not first: a repeated key in a file
# read as shell assignments resolves to the last one, and compose reads
# an env_file the same way. Matching is on an exact `KEY=` prefix, so
# POSTGRES_PASSWORD_FILE and a commented-out `#POSTGRES_DB=` are not
# mistaken for the real key.
_db_env_line() {
    local file="$1" key="$2"
    grep -E "^${key}=" "$file" 2>/dev/null | tail -n 1
}

# Print the narrow db env to stdout. Reads nothing but the file it is
# given, writes nothing, calls nothing external -- so it can be asserted
# on directly, without a filesystem.
#
# Returns non-zero WITHOUT printing a partial document when any key is
# missing or empty: a caller redirecting our stdout must never be handed
# half an env file.
#
# Lines are copied VERBATIM. A password may legitimately contain '#',
# '=', spaces or quotes, and compose's env_file reader takes the raw
# KEY=value line -- re-quoting the value would change what the container
# actually receives.
render_db_env() {
    # `${1:-}`, not `$1`: both callers run under `set -u`, where a bare
    # $1 aborts the whole script before the argument check below can
    # report anything. Found by fixture 8 -- the declared "rc 2 on
    # missing arguments" contract was unreachable in exactly the shell
    # this library is used from.
    local src="${1:-}" key line missing=""

    if [ ! -r "$src" ]; then
        echo "env-render: cannot read $src" >&2
        return 1
    fi

    # Validate FIRST, render second. The check is on the VALUE, not on
    # the line: `POSTGRES_PASSWORD=` is a present line with an absent
    # password, and letting it through starts redis with no password at
    # all and leaves postgres unable to initialise a fresh volume.
    for key in "${_DB_ENV_KEYS[@]}"; do
        line=$(_db_env_line "$src" "$key")
        if [ -z "${line#"${key}="}" ]; then
            missing="${missing:+$missing, }$key"
        fi
    done
    if [ -n "$missing" ]; then
        echo "env-render: missing (or empty) in $src: $missing" >&2
        echo "env-render: refusing to project a partial db env -- postgres or" >&2
        echo "env-render: redis would start without credentials." >&2
        return 1
    fi

    echo "# ==========================================================================="
    echo "# GENERATED by scripts/env-render.sh -- DO NOT EDIT."
    echo "# ==========================================================================="
    echo "# PROJECTION of backend/.env, regenerated on every install and every"
    echo "# update. backend/.env is the single source of these passwords -- edit"
    echo "# there and re-run \`velo update\` (or the installer), never here."
    echo "#"
    echo "# Handed to the postgres and redis containers INSTEAD of the full"
    echo "# backend/.env, so a compromised database or cache no longer exposes"
    echo "# the application's payment, telegram, session and service-token"
    echo "# secrets (T-32 item 9)."
    echo "#"
    echo "# The names of those secrets are deliberately NOT spelled out here:"
    echo "# the acceptance check for this change is a grep for them over the"
    echo "# container environment, and a comment naming them would make that"
    echo "# check ambiguous."
    echo "# ==========================================================================="
    echo ""
    for key in "${_DB_ENV_KEYS[@]}"; do
        _db_env_line "$src" "$key"
    done
}

# write_db_env <src backend/.env> <dst backend/.env.db>
#
# Returns 0 on success. Non-zero, with no partial file left behind, on
# any failure -- both callers treat that as fatal, and rightly.
write_db_env() {
    # See render_db_env: `${N:-}` so the usage check below is reachable
    # under `set -u`.
    local src="${1:-}" dst="${2:-}" old_umask tmp

    if [ -z "$src" ] || [ -z "$dst" ]; then
        echo "env-render: usage: write_db_env <src .env> <dst .env.db>" >&2
        return 2
    fi

    tmp="${dst}.tmp.$$"

    # umask BEFORE the first write, not chmod after it: the file holds
    # the database passwords and content lands the moment it exists, so
    # a create-then-chmod leaves a window in which it is world-readable.
    old_umask=$(umask)
    umask 077

    if ! render_db_env "$src" > "$tmp"; then
        umask "$old_umask"
        rm -f "$tmp"
        return 1
    fi

    # Belt AND braces, because the umask alone was measured NOT to be
    # enough: where `mv` below degrades from a rename into a copy, the
    # destination is created under the CALLER's umask and the 077 set
    # here is lost -- observed producing a world-readable 0644 .env.db.
    # An explicit mode on both files is the only form that does not
    # depend on which mv you got.
    chmod 600 "$tmp" 2>/dev/null || true
    umask "$old_umask"

    # Atomic swap: a concurrent reader (a compose command) sees either
    # the old file or the new one, never a half-written one.
    if ! mv -f "$tmp" "$dst"; then
        rm -f "$tmp"
        echo "env-render: cannot move $tmp -> $dst" >&2
        return 1
    fi

    # See the chmod above: this is the one that holds when mv copied
    # rather than renamed.
    chmod 600 "$dst" 2>/dev/null || true
    return 0
}
