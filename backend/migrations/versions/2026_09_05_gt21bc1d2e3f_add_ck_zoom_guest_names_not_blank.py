"""add ck_zoom_guest_names_display_name_not_blank (GT-21b)

Blank and whitespace-only guest names rejected by the DATABASE. The upper
bound was already held by varchar(64); the lower one was held by nothing, so
"" and "   " inserted cleanly. GT-21 called 1..64-after-strip a validated
bound while no code did the stripping -- the writer arrives in step B, and by
then an empty name has to be IMPOSSIBLE rather than merely un-issued.

FIRST EXPRESSION CHECK IN THIS TREE -- every existing one is IN (...) or
BETWEEN. Not exotic, just first: btrim() and length() are stock Postgres.

SAFE ON A LIVE TABLE BECAUSE THE TABLE CANNOT HAVE ROWS. ADD CONSTRAINT
validates existing data and would fail on a violating row; zoom_guest_names
has no writer anywhere in the tree (GT-21 shipped schema only, /z/{code}/guest
still hands out the shared registrant), so there is nothing to validate.

CORRECTION TO gt21a1b2c3d4, WHICH THIS REVISION DOES NOT EDIT.
The docstring of gt21a1b2c3d4 (create zoom_guest_names) says the suite checks
the practice cascade on live data. It did not: no test referenced
ZoomGuestName or zoom_guest_names in any form when that revision was written.
gt21a1b2c3d4 was already applied by the time this was found, so its text is
an immutable record and stays as written -- the correction lives here instead.
The tests it promised arrive with this revision, in
tests/test_zoom_guest_names.py: the cascade from practices and the fact that
uniqueness is scoped to one practice. A reader of gt21a1b2c3d4 should treat
that paragraph as a promise kept HERE, not as a statement of fact THERE.

down_revision is gt21a1b2c3d4, the head as of this writing, found by
enumerating BOTH spellings of the revision assignments in
migrations/versions: 59 files write `revision: str = "..."` and two write the
bare `revision = "..."` (2026_02_20_c9d0e1f2a3b4, 2026_02_28_0a1b2c3d4e5f).
A scan that knows only the annotated spelling reports three heads, two false.
The revision id was proven free by collecting all 61 existing literals across
both spellings.

downgrade() mirrors upgrade().

Revision ID: gt21bc1d2e3f
Revises: gt21a1b2c3d4
Create Date: 2026-09-05
"""

from collections.abc import Sequence

from alembic import op

revision: str = "gt21bc1d2e3f"
down_revision: str | None = "gt21a1b2c3d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Apply this migration."""
    op.create_check_constraint(
        "ck_zoom_guest_names_display_name_not_blank",
        "zoom_guest_names",
        "length(btrim(display_name)) > 0",
    )


def downgrade() -> None:
    """Revert this migration."""
    op.drop_constraint(
        "ck_zoom_guest_names_display_name_not_blank",
        "zoom_guest_names",
        type_="check",
    )
