"""add curator_group.avatar_url -- the school's picture (GT-17)

One nullable column, mirroring User.avatar_url: String(500), an external
url, no index. Nothing queries a school by its avatar and nothing will --
it is a value to render, not one to find rows by.

WHY String(500) AND NOT Text WITH A SCHEMA CAP, which is how
curator_group.description is done: the schema has to reject a url whose
NORMALISED form would not fit, and it can only do that against a concrete
number. Pydantic normalises a url on the way in -- punycode host,
percent-encoded path -- and the result can be several times longer than
what was typed (a 222-character Cyrillic url normalises to 1234). With Text
there is no number to check against, and the overflow would surface as a
database error instead of a 422.

down_revision is e9f0a1b2c3d4 (create_curator_group_event), the head as of
this writing, FOUND BY ENUMERATING BOTH SPELLINGS: 57 of the 59 revisions
in this tree write `revision: str = "..."` and two write the bare
`revision = "..."`, so a scan that knows only the annotated form reports
three heads, two of them false.

THE REVISION ID WAS PROVEN FREE, not eyeballed. Every `revision` and
`down_revision` literal in migrations/versions was collected (59 ids) and
this one is not among them -- the check exists because GT-16 first picked
a12-hex id that had been in use since February, and the symptom was that
the revision count did not change while the head moved to somebody else's
migration.

NO BACKFILL. Every existing school gets NULL, which is exactly "no
avatar", and the frontend already renders initials for that (VAvatar.vue).
The database is disposable and there is no legacy.

`downgrade` is a mirror and is not tested; migrations are verified by
running them forward.

Revision ID: f0a1b2c3d4e5
Revises: e9f0a1b2c3d4
Create Date: 2026-09-02
"""

import sqlalchemy as sa
from alembic import op

revision: str = "f0a1b2c3d4e5"
down_revision: str | None = "e9f0a1b2c3d4"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "curator_group",
        sa.Column("avatar_url", sa.String(length=500), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("curator_group", "avatar_url")
