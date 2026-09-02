"""create zoom_guest_names -- the names already issued to guests (GT-21)

One table, so a guest stops being FACELESS in the Zoom participant list. A
guest arriving through the public /z/{code} link joins as ONE shared
registrant per meeting today (zoom/service.py ensure_shared_registrant,
"VELO / Guest Link"), so ten guests read as ten identical rows. A row here
records that a name is TAKEN on a practice, which is the only fact the name
generator needs.

WHY A TABLE AND NOT A COUNTER COLUMN ON zoom_meetings (owner ruling, and the
form was asked for): the generator has to know WHICH names are already out,
not how many. A counter answers "12" and cannot answer "is Пылающий Шива
free", so every collision would either be missed or need a second read of
something that does not exist. The table also makes "how many Пылающих Шив
does this practice already have" a query instead of a guess.

SCOPED TO THE PRACTICE, NOT GLOBALLY (owner ruling). The unique index is
(practice_id, display_name): the same name on two DIFFERENT practices is
allowed and is asserted as allowed. A global registry would need
cross-practice counters and race handling to buy nothing -- the only list a
name has to be distinguishable in is one meeting's.

NO SEPARATE INDEX ON practice_id. The unique index leads with it and every
lookup filters on it first, so a second index would be a pure duplicate --
the same rule practice_audience_curator_group (2026-08-26) was built with,
quoted here because the omission otherwise reads as an oversight.

CASCADE FROM practices IS LOAD-BEARING AND IS NOT VERIFIED BY READING THIS
DDL. tests/helpers.py full_cleanup_range deletes NO zoom table by name --
zoom_meetings, zoom_registrants and zoom_attendance_segments are all swept
by its `delete(Practice)` through ON DELETE CASCADE, and this table joins
that same sweep. The suite checks it on live data (delete the practice,
assert the rows are gone AND that they existed and were non-empty
beforehand) rather than trusting this paragraph.

zoom_registrant_id AND join_url LIVE HERE, NOT IN zoom_registrants, and the
reason is structural, not tidiness: attendance_service.
ingest_report_for_meeting selects EVERY zoom_registrants row of a meeting
unconditionally and matches report rows against all of them. A guest in
that table would match by registrant_id and the matcher would decide
bookings that do not exist. This is the same argument that put
zoom_meetings.shared_registrant_id / shared_join_url on the meeting instead
of in zoom_registrants (T24-38); the guest stays unjudgeable by
CONSTRUCTION, not by a rule anyone has to remember.

BOTH ARE NULLABLE, and NULL is an expected state, not an unfinished one:
the name is claimed by the row itself, and Zoom can still refuse afterwards,
or return a registrant_id with no join_url (the shape
ZoomRegistrant.join_url's docstring documents as real). Such a row keeps its
name reserved deliberately -- handing a possibly-registered name to the
next guest is the one way to put two identical guests back in the list.

NO user_id, AND THERE WILL BE NONE. The guest is anonymous by construction
(resolve_zoom_entry is called with user=None on both public routes), so
there is nobody to point at, and a column that could point at somebody
would be the first step back toward judging them.

NO BACKFILL. Existing practices get no rows, which is exactly "no guest has
been named yet". The database is disposable and there is no legacy.

down_revision is f0a1b2c3d4e5 (add_curator_group_avatar_url), the head as of
this writing, FOUND BY ENUMERATING BOTH SPELLINGS of the revision /
down_revision assignments in migrations/versions: 58 of the 60 revisions
write `revision: str = "..."` and two write the bare `revision = "..."`
(2026_02_20_c9d0e1f2a3b4, 2026_02_28_0a1b2c3d4e5f). A scan that knows only
the annotated spelling reports THREE heads, two of them false -- b8c9d0e1f2a3
and f2a3b4c5d6e7, whose children are precisely those two bare-form files.

THE REVISION ID WAS PROVEN FREE, not eyeballed: every `revision` and
`down_revision` literal in migrations/versions was collected across both
spellings (60 ids) and gt21a1b2c3d4 is not among them.

downgrade() mirrors upgrade() -- index first, then the table. It is not
tested; migrations are verified by applying them forward (owner's ruling).

Revision ID: gt21a1b2c3d4
Revises: f0a1b2c3d4e5
Create Date: 2026-09-03
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "gt21a1b2c3d4"
down_revision: str | None = "f0a1b2c3d4e5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Apply this migration."""
    op.create_table(
        "zoom_guest_names",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "practice_id",
            sa.UUID(),
            sa.ForeignKey("practices.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("display_name", sa.String(length=64), nullable=False),
        sa.Column("zoom_registrant_id", sa.String(length=64), nullable=True),
        sa.Column("join_url", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "uq_zoom_guest_names_practice_name",
        "zoom_guest_names",
        ["practice_id", "display_name"],
        unique=True,
    )


def downgrade() -> None:
    """Revert this migration."""
    op.drop_index(
        "uq_zoom_guest_names_practice_name",
        table_name="zoom_guest_names",
    )
    op.drop_table("zoom_guest_names")
