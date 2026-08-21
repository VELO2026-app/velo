# shellcheck shell=bash
# =============================================================================
# GITHUB ACCESS VERIFICATION -- shared by install_velo.sh and velo-manage.sh
# =============================================================================
#
# WHY THIS FILE EXISTS AT ALL, given the repo's standing rule that a second
# copy of a text is how two texts quietly stop agreeing: the installer and
# the manager both have to answer the same question ("can this key actually
# reach this repo, and may it write?"), and both answered it with a DIFFERENT
# and equally wrong test until 2026-08-21 -- each looking at an `ssh -T`
# banner. Two wrong copies is exactly the failure the services.conf header
# describes. There is one text now.
#
# It is sourced from the CHECKOUT, so it ships like any other code change.
# The installer can only source it AFTER the clone -- which is fine, because
# nothing before the clone can verify a repo that has not been fetched yet.
# The bootstrap key test (github_probe, in the installer) stays where it is
# for exactly that reason: it runs before any checkout exists.
#
# Callers must have defined the colour variables (RED/GREEN/YELLOW/NC).
# =============================================================================

# What an `ssh -T` banner CANNOT tell you, asked directly of the repository.
#
# `ssh -T git@github.com` reports one thing: GitHub recognises this key.
# It does NOT report that the key is attached to a given repository, and it
# does NOT report write permission. A deploy key belonging to some OTHER
# repository passes it cleanly -- which is how a box came up on 2026-08-21
# holding a key for the repo's PREVIOUS GitHub organisation, cloned fine
# (the new repo was public), and would have failed days later on the first
# `velo update` push of generated.ts.
#
# Two claims, checked separately, because they fail separately and the fix
# differs:
#   READ   -- ls-remote against the repo. On a PUBLIC repo any recognised
#             key passes this, so read passing is not proof of attachment
#             while the repo is public. It is still worth asking: on a
#             private repo it is the whole question.
#   WRITE  -- push --dry-run. Exact in both cases, and the claim that
#             actually bites: `velo update` pushes regenerated API types.
#
#   $1 name    service id -- the /root/.ssh/config host alias is named
#              after it (github.com-<name>)
#   $2 repo    owner/repo
#   $3 access  "read" or "write", from the registry
#   $4 dir     an existing checkout of that repo; required only when
#              access is "write" (the push probe needs a branch)
verify_repo_access() {
    local name="$1" repo="$2" access="$3" dir="${4:-}"
    local alias="github.com-${name}"
    local url="git@${alias}:${repo}.git"

    echo "Verifying the $name deploy key against $repo..."

    # GIT_TERMINAL_PROMPT=0: a key GitHub does not accept must fail here,
    # not sit forever waiting for a username nobody is there to type.
    if ! GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code "$url" HEAD > /dev/null 2>&1; then
        echo -e "${RED}✗ The $name deploy key cannot READ $repo.${NC}" >&2
        echo "  Add it at https://github.com/${repo}/settings/keys" >&2
        return 1
    fi
    echo -e "${GREEN}✓ Read access OK ($name -> $repo)${NC}"

    [ "$access" = "write" ] || return 0

    if [ -z "$dir" ] || [ ! -d "$dir/.git" ]; then
        echo -e "${RED}✗ No checkout at '${dir:-<empty>}' -- cannot probe write access${NC}" >&2
        echo "  A service declared access=write must pass its checkout path." >&2
        return 1
    fi

    local branch push_err
    branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null)
    if [ -z "$branch" ] || [ "$branch" = "HEAD" ]; then
        echo -e "${RED}✗ $dir is not on a branch -- cannot probe write access${NC}" >&2
        return 1
    fi

    # --dry-run negotiates with the server and reports refusal without
    # creating or moving a ref. Pushing HEAD to the branch this checkout
    # already tracks means a PERMITTED push would be a no-op anyway, so
    # there is nothing to undo when it succeeds.
    push_err=$(git -C "$dir" push --dry-run "$url" "HEAD:refs/heads/${branch}" 2>&1) || {
        echo -e "${RED}✗ The $name deploy key has NO WRITE access to $repo.${NC}" >&2
        echo "$push_err" | sed 's/^/  /' >&2
        echo "" >&2
        echo -e "${YELLOW}  Fix: open https://github.com/${repo}/settings/keys, DELETE${NC}" >&2
        echo -e "${YELLOW}  the key, re-add it and TICK 'Allow write access'. GitHub${NC}" >&2
        echo -e "${YELLOW}  cannot upgrade an existing deploy key in place.${NC}" >&2
        return 1
    }
    echo -e "${GREEN}✓ Write access OK ($name -> $repo, branch $branch)${NC}"
}
