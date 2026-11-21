#!/bin/sh
# FE-226: the commit subject gate. The ONE place the format is described.
#
# Allowed subjects:
#   FE-226: short English description
#     Any Linear team key works (BE, PM, DSGN, ...): "KEY-N: description".
#     Several tasks at once: "FE-200, FE-201: ...".
#     A numbered part of a long task: "FE-181 part 6: ...".
#   Fix the stand token leak (owner 2026-11-21)
#     Owner-requested work with no Linear task; the date is validated.
# Merge/revert subjects are git's own and pass through: "Merge branch ...",
# "Merge pull request ...", "Merge remote-tracking branch ...", 'Revert "..."'.
# fixup!/squash!/amend! pass in the default (local hook) mode so the
# fixup + autosquash flow stays usable; --ci rejects them -- a PR must
# carry real subjects.
#
# Usage:
#   check-commit-msg.sh <message-file>   git commit-msg hook style ($1)
#   check-commit-msg.sh -               read the message from stdin
#   check-commit-msg.sh --ci <file|->   CI mode: also reject fixup!/squash!/amend!
#
# Only the subject (first line) is checked; the body is free-form.

ci=0
if [ "$#" -gt 0 ] && [ "$1" = "--ci" ]; then
    ci=1
    shift
fi

if [ "$#" -ne 1 ]; then
    printf 'usage: %s [--ci] <message-file> | -\n' "$0" >&2
    exit 2
fi

if [ "$1" = "-" ]; then
    subject=$(head -n 1)
else
    subject=$(head -n 1 "$1")
fi

# git's own subjects for merges and reverts.
case $subject in
    "Merge branch "*|"Merge pull request "*|"Merge remote-tracking branch "*|'Revert "'*)
        exit 0
        ;;
esac

# Rebase plumbing: fine while the branch is local, never in a PR.
if [ "$ci" -eq 0 ]; then
    case $subject in
        "fixup! "*|"squash! "*|"amend! "*)
            exit 0
            ;;
    esac
fi

# A Linear task first: "FE-226: ...", "BE-194 part 10: ...",
# "FE-200, FE-201: ..." -- the description must not be blank.
if printf '%s\n' "$subject" | grep -Eq '^[A-Z]+-[0-9]+(, [A-Z]+-[0-9]+)*( part [0-9]+)?: [^[:space:]].*'; then
    exit 0
fi

# Owner-requested work without a Linear task: a real date in the parens.
if printf '%s\n' "$subject" | grep -Eq '^[^[:space:]].* \(owner [0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])\)$'; then
    exit 0
fi

printf 'commit subject: %s\n' "$subject" >&2
printf 'Subject must be "KEY-N: short English description" (any Linear team\n' >&2
printf 'key: FE, BE, PM, DSGN; "FE-200, FE-201:" closes several tasks,\n' >&2
printf '"FE-181 part 6:" is a numbered part) or "short description\n' >&2
printf '(owner YYYY-MM-DD)" for owner-requested work without a task.\n' >&2
printf 'Merge/revert subjects pass; fixup!/squash!/amend! pass only outside CI.\n' >&2
exit 1
