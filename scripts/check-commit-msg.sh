#!/bin/sh
# FE-226: the commit subject gate -- the format the practice actually
# converged on (38 of the last 100 deploy-machine commits; the old
# type(scope)/trailing-(FE-N) rule matched 3 and is retired, the history
# keeps its old subjects as they are).
#
# Allowed subjects -- the Linear ID leads, because it is the one thing
# every reader scans for and GitHub/Linear autolink it anywhere:
#   FE-226: align the commit header rule with the practice
#   BE-194 part 10: velo's tests run under the deploy machine
#   FE-200, FE-201: restore the import the rebase dropped
#   Fix the stand token leak (owner 2026-11-21)   <- owner work, no task
# Merge and revert subjects pass through untouched.
#
# Usage:
#   check-commit-msg.sh <message-file>   git commit-msg hook style ($1)
#   check-commit-msg.sh -               read the message from stdin
# Only the subject (first line) is checked; the body stays free-form
# (the "Task: FE-NNN" trailer is the tooling's, not this gate's concern).

if [ "$#" -ne 1 ]; then
    echo "usage: $0 <message-file> | -" >&2
    exit 2
fi

if [ "$1" = "-" ]; then
    subject=$(head -n 1)
else
    subject=$(head -n 1 "$1")
fi

# Merge and revert commits carry the machinery's own subject.
case $subject in
    "Merge "*|"Revert "*)
        exit 0
        ;;
esac

# A Linear task first: FE-226: / BE-194 part 10: / FE-200, FE-201:
if echo "$subject" | grep -Eq '^(FE|BE)-[0-9]+(, (FE|BE)-[0-9]+)*( part [0-9]+)?: .+'; then
    exit 0
fi

# Owner-requested work without a Linear task: the date in trailing parens.
if echo "$subject" | grep -Eq '.+ \(owner [0-9]{4}-[0-9]{2}-[0-9]{2}\)$'; then
    exit 0
fi

echo "commit subject: $subject" >&2
echo "Subject must be 'FE-NNN: short English description' (BE-NNN for a" >&2
echo "backend task, 'FE-200, FE-201:' when one commit closes several)," >&2
echo "or 'short description (owner YYYY-MM-DD)' for owner-requested work" >&2
echo "with no Linear task. Merge/revert subjects pass." >&2
exit 1
