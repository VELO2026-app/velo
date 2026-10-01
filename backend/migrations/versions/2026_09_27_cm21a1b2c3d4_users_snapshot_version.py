"""users.snapshot_version + the trigger that raises it (comms 3.0.0, items 21-22)

comms 3.0.0 versions the recipient snapshot: it applies a `user_upserted`
only when its `version` is higher than the stored one; an EQUAL version with
the same content is a replay (no-op), an equal version with OTHER content is
a conflict and the change is NOT applied. So the version must rise exactly
when the snapshot's content changes. Missing a rise is the dangerous
direction (a silent divergence in the address book); an extra rise is safe
(comms re-applies the same content once).

1. `users.snapshot_version BIGINT NOT NULL DEFAULT 1`. BIGINT because the
   comms column is BigInteger. Existing rows get 1: comms migration 0014
   set every recipient written before versions existed to version 0 with a
   never-compared sentinel fingerprint, so a first velo snapshot at 1 is
   applied as new. 0 would be refused by the wire (`version >= 1`).

2. A BEFORE UPDATE row trigger raises it by one when any field the snapshot
   is built from differs between OLD and NEW: telegram_id, language,
   timezone, is_active, credentials->'email'. The email is compared RAW, not
   normalised -- a flip between "" and an absent key raises the version for
   an identical snapshot (null both times), which is the safe direction;
   normalising here and missing a case would be the other one.

WHY A TRIGGER AND NOT CODE -- this is the first trigger in this schema, so a
reader does not expect the database to write anything by itself:

  - It is the only place that sees EVERY write path. Login upserts the user
    with `pg_insert ... ON CONFLICT DO UPDATE`, past the ORM, so no ORM hook
    would see it; an increment by hand at each write site is eight sites
    today and a forgotten ninth tomorrow.
  - It answers "what is a change" by CONTENT, not by the fact of a write:
    a PATCH with the same language, an admin rewriting credentials without
    touching email, a login -- each rewrites the row and leaves the version.
  - Row locking orders two UPDATEs of one row, so the second sees the first
    one's version in OLD: concurrent edits cannot produce one version twice.

The snapshot reads the version back from the row in the same SELECT as the
content (core/events/sync.py emit_user_upserted), so the pair is always
taken from one state of the row.

Downgrade drops the trigger, the function and the column.

Revision ID: cm21a1b2c3d4
Revises: be27a1b2c3d4
Create Date: 2026-09-27
"""

import sqlalchemy as sa
from alembic import op

revision: str = "cm21a1b2c3d4"
down_revision: str | None = "be27a1b2c3d4"
branch_labels: str | None = None
depends_on: str | None = None

_FUNCTION = "users_bump_snapshot_version"
_TRIGGER = "trg_users_bump_snapshot_version"


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "snapshot_version",
            sa.BigInteger(),
            nullable=False,
            server_default="1",
        ),
    )
    op.execute(
        f"""
        CREATE FUNCTION {_FUNCTION}() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF (NEW.telegram_id, NEW.language, NEW.timezone, NEW.is_active,
                NEW.credentials -> 'email')
               IS DISTINCT FROM
               (OLD.telegram_id, OLD.language, OLD.timezone, OLD.is_active,
                OLD.credentials -> 'email')
            THEN
                NEW.snapshot_version := OLD.snapshot_version + 1;
            ELSE
                -- A write that leaves the snapshot's fields alone never
                -- moves the version, whatever it asked for.
                NEW.snapshot_version := OLD.snapshot_version;
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        f"""
        CREATE TRIGGER {_TRIGGER}
        BEFORE UPDATE ON users
        FOR EACH ROW EXECUTE FUNCTION {_FUNCTION}()
        """
    )


def downgrade() -> None:
    op.execute(f"DROP TRIGGER IF EXISTS {_TRIGGER} ON users")
    op.execute(f"DROP FUNCTION IF EXISTS {_FUNCTION}()")
    op.drop_column("users", "snapshot_version")
