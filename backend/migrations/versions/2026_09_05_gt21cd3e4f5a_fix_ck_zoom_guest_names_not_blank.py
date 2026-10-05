"""fix ck_zoom_guest_names_display_name_not_blank -- btrim() only trims spaces

gt21bc1d2e3f wrote the constraint as length(btrim(display_name)) > 0 and that
does NOT reject a name made of tabs or newlines. btrim(string) with no second
argument trims one character set and one only: the SPACE character. So
btrim(E'\\t\\n ') returns E'\\t\\n', length 2, and the row inserted cleanly --
exactly the state the constraint exists to forbid.

FOUND BY THE SUITE, NOT BY READING. tests/test_zoom_guest_names.py ::
test_a_blank_display_name_is_refused_by_the_database walks three spellings of
blank -- "", "   " and E'\\t\\n ' -- and the third one did not raise. The first
two passed, which is why reading the expression looked fine: it was right for
the inputs someone thinks of first.

THE NEW EXPRESSION IS A REGEX, NOT A TRIM. display_name ~ '[^[:space:]]' reads
as "must contain at least one non-whitespace character", which is the actual
rule; anything built on trimming has to enumerate the whitespace it knows
about and is wrong the moment it misses one. [[:space:]] is the POSIX class --
space, tab, newline, carriage return, form feed, vertical tab.

KNOWN LIMIT, stated rather than papered over: [[:space:]] covers ASCII
whitespace. A name consisting solely of U+00A0 (non-breaking space) or another
Unicode space separator would still pass. Not chased here -- there is no writer
yet and no caller that can produce one, and a constraint aimed at a state
nothing can reach would be documenting the impossible. If step B ever accepts
human-typed names, that is the moment to revisit, together with the case-folding
ceiling recorded on the unique index in ZoomGuestName.__table_args__.

gt21bc1d2e3f IS NOT EDITED. It is applied -- tests/conftest.py runs
`alembic upgrade head` before the suite and raises if it fails, and the suite
ran -- so it is a record of an applied change, and records are not rewritten.
The wrong expression stays in its file and is replaced here, in the open.

SAFE ON A LIVE TABLE: zoom_guest_names still has no writer anywhere in the
tree (GT-21 shipped schema only, /z/{code}/guest still hands out the shared
registrant), so ADD CONSTRAINT has nothing to validate.

downgrade() mirrors upgrade() and deliberately restores the WRONG expression:
a downgrade returns the schema to its previous state, and the previous state
is gt21bc1d2e3f's, bug and all.

down_revision is gt21bc1d2e3f, the head as of this writing, found by
enumerating both spellings of the revision assignments in migrations/versions
(60 annotated, 2 bare). Revision id proven free against all 62 existing
literals.

Revision ID: gt21cd3e4f5a
Revises: gt21bc1d2e3f
Create Date: 2026-09-05
"""

from collections.abc import Sequence

from alembic import op

revision: str = "gt21cd3e4f5a"
down_revision: str | None = "gt21bc1d2e3f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_CONSTRAINT = "ck_zoom_guest_names_display_name_not_blank"
_TABLE = "zoom_guest_names"


def upgrade() -> None:
    """Apply this migration."""
    op.drop_constraint(_CONSTRAINT, _TABLE, type_="check")
    op.create_check_constraint(
        _CONSTRAINT,
        _TABLE,
        "display_name ~ '[^[:space:]]'",
    )


def downgrade() -> None:
    """Revert this migration."""
    op.drop_constraint(_CONSTRAINT, _TABLE, type_="check")
    op.create_check_constraint(
        _CONSTRAINT,
        _TABLE,
        "length(btrim(display_name)) > 0",
    )
