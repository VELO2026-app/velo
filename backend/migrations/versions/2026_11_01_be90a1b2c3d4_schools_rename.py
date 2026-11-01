"""BE-90 step 2: the school's database objects and values are named "school".

Revision ID: be90a1b2c3d4
Revises: be46a1b2c3d4
Create Date: 2026-11-01

Owner ruling 2026-11-01: the entity is called "school" everywhere, before
the production release. Step 1 renamed the code; this revision renames what
the database holds, in ONE transaction:

  1. names -- seven tables, the school column of six of them
     (group_id -> school_id) and of practices (curator_group_id ->
     school_id), every index, key and constraint carrying the old name
     (Postgres' own automatic names included), the journal's identity
     sequence. Catalog-only: no row is rewritten for a name;
  2. the trigger function practices_school_lost_goes_public: its body
     names the column and the audience value as literals, so it is
     replaced. The trigger itself follows the column by attnum and needs
     nothing;
  3. ck_practices_school_audience_has_school: dropped, the data moved,
     recreated -- its expression carries both old literals;
  4. data -- practices.audience_kind 'curator_groups' -> 'schools'; the
     four journal kinds group_* -> school_*; the master's right to found
     schools, master_profiles.data.account.can_create_groups ->
     can_create_schools (value kept).

audit_logs is NOT rewritten: it is a record of what was said at the time.

LOCKS. Renaming a table or a column takes ACCESS EXCLUSIVE on it until the
commit, and so does the CHECK; the whole revision is one transaction, so
practices and the seven school tables are closed for its duration (the
UPDATE of practices is the only part that reads rows). lock_timeout makes a
revision that cannot get its locks fail at once instead of queueing behind
a long transaction and stalling every reader queued behind it. The CHECK is
added validated, not NOT VALID + VALIDATE: the table is already held
exclusively until the commit, so splitting the check would buy nothing.

downgrade() is the exact inverse; every mapping here is one-to-one, so rows
written after the upgrade map back without loss.
"""
from collections.abc import Sequence

from alembic import op

revision: str = "be90a1b2c3d4"
down_revision: str | None = "be46a1b2c3d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_CHECK = "ck_practices_school_audience_has_school"
_FUNCTION = "practices_school_lost_goes_public"

# (old, new), in the order applied by upgrade().
_TABLES = [
    ("curator_group", "school"),
    ("curator_group_member", "school_member"),
    ("curator_group_block", "school_block"),
    ("curator_group_invite", "school_invite"),
    ("curator_group_transfer", "school_transfer"),
    ("curator_group_master_offer", "school_master_offer"),
    ("curator_group_event", "school_event"),
]

# (table as named AFTER the table renames, old column, new column).
_COLUMNS = [
    ("school_member", "group_id", "school_id"),
    ("school_block", "group_id", "school_id"),
    ("school_invite", "group_id", "school_id"),
    ("school_transfer", "group_id", "school_id"),
    ("school_master_offer", "group_id", "school_id"),
    ("school_event", "group_id", "school_id"),
    ("practices", "curator_group_id", "school_id"),
]

# Indexes that are not constraints (ALTER INDEX).
_INDEXES = [
    ("ix_curator_group_block_user_id", "ix_school_block_user_id"),
    ("ix_curator_group_curator_user_id", "ix_school_curator_user_id"),
    ("ix_curator_group_event_group_seq", "ix_school_event_school_seq"),
    ("ix_curator_group_master_offer_to_user_id",
     "ix_school_master_offer_to_user_id"),
    ("ix_curator_group_member_user_id", "ix_school_member_user_id"),
    ("ix_curator_group_transfer_to_user_id", "ix_school_transfer_to_user_id"),
    ("ix_practices_curator_group_id", "ix_practices_school_id"),
    ("uq_curator_group_block_group_user", "uq_school_block_school_user"),
    ("uq_curator_group_curator_name_key", "uq_school_curator_name_key"),
    ("uq_curator_group_invite_group", "uq_school_invite_school"),
    ("uq_curator_group_invite_token", "uq_school_invite_token"),
    ("uq_curator_group_master_offer_group_user",
     "uq_school_master_offer_school_user"),
    ("uq_curator_group_member_group_user", "uq_school_member_school_user"),
    ("uq_curator_group_transfer_group", "uq_school_transfer_school"),
]

# Constraints (ALTER TABLE ... RENAME CONSTRAINT; a key's index follows its
# constraint). Table as named AFTER the table renames.
_CONSTRAINTS = [
    ("school", "curator_group_pkey", "school_pkey"),
    ("school", "curator_group_curator_user_id_fkey",
     "school_curator_user_id_fkey"),
    ("school_member", "curator_group_member_pkey", "school_member_pkey"),
    ("school_member", "curator_group_member_group_id_fkey",
     "school_member_school_id_fkey"),
    ("school_member", "curator_group_member_user_id_fkey",
     "school_member_user_id_fkey"),
    ("school_block", "curator_group_block_pkey", "school_block_pkey"),
    ("school_block", "curator_group_block_group_id_fkey",
     "school_block_school_id_fkey"),
    ("school_block", "curator_group_block_user_id_fkey",
     "school_block_user_id_fkey"),
    ("school_block", "curator_group_block_blocked_by_user_id_fkey",
     "school_block_blocked_by_user_id_fkey"),
    ("school_invite", "curator_group_invite_pkey", "school_invite_pkey"),
    ("school_invite", "curator_group_invite_group_id_fkey",
     "school_invite_school_id_fkey"),
    ("school_transfer", "curator_group_transfer_pkey", "school_transfer_pkey"),
    ("school_transfer", "curator_group_transfer_group_id_fkey",
     "school_transfer_school_id_fkey"),
    ("school_transfer", "curator_group_transfer_to_user_id_fkey",
     "school_transfer_to_user_id_fkey"),
    ("school_master_offer", "curator_group_master_offer_pkey",
     "school_master_offer_pkey"),
    ("school_master_offer", "curator_group_master_offer_group_id_fkey",
     "school_master_offer_school_id_fkey"),
    ("school_master_offer", "curator_group_master_offer_to_user_id_fkey",
     "school_master_offer_to_user_id_fkey"),
    ("school_event", "curator_group_event_pkey", "school_event_pkey"),
    ("school_event", "curator_group_event_group_id_fkey",
     "school_event_school_id_fkey"),
    ("school_event", "uq_curator_group_event_seq", "uq_school_event_seq"),
    ("practices", "fk_practices_curator_group_id_curator_group",
     "fk_practices_school_id_school"),
]

_SEQUENCE = ("curator_group_event_seq_seq", "school_event_seq_seq")

# Journal kinds that carried the old root; the others never did.
_JOURNAL_KINDS = [
    ("group_created", "school_created"),
    ("group_renamed", "school_renamed"),
    ("group_description_changed", "school_description_changed"),
    ("group_avatar_changed", "school_avatar_changed"),
]

_FUNCTION_BODY = """
        CREATE OR REPLACE FUNCTION {function}() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF OLD.{column} IS NOT NULL
               AND NEW.{column} IS NULL
               AND NEW.audience_kind = '{kind}' THEN
                NEW.audience_kind := 'public';
            END IF;
            RETURN NEW;
        END
        $$
"""


def _move_right(old_key: str, new_key: str) -> None:
    """Move master_profiles.data.account.<old_key> to <new_key>, value kept.

    Only rows that carry the old key are touched; a profile without it, or
    without an account object, is left as it is.
    """
    op.execute(
        f"""
        UPDATE master_profiles
           SET data = jsonb_set(
                   data #- '{{account,{old_key}}}',
                   '{{account,{new_key}}}',
                   data #> '{{account,{old_key}}}'
               )
         WHERE data #> '{{account,{old_key}}}' IS NOT NULL
        """
    )


def upgrade() -> None:
    """Apply this migration."""
    op.execute("SET LOCAL lock_timeout = '5s'")

    for old, new in _TABLES:
        op.execute(f"ALTER TABLE {old} RENAME TO {new}")
    for table, old, new in _COLUMNS:
        op.execute(f"ALTER TABLE {table} RENAME COLUMN {old} TO {new}")
    for old, new in _INDEXES:
        op.execute(f"ALTER INDEX {old} RENAME TO {new}")
    for table, old, new in _CONSTRAINTS:
        op.execute(f"ALTER TABLE {table} RENAME CONSTRAINT {old} TO {new}")
    op.execute(f"ALTER SEQUENCE {_SEQUENCE[0]} RENAME TO {_SEQUENCE[1]}")

    op.execute(
        _FUNCTION_BODY.format(
            function=_FUNCTION, column="school_id", kind="schools",
        )
    )

    op.drop_constraint(_CHECK, "practices", type_="check")
    op.execute(
        "UPDATE practices SET audience_kind = 'schools' "
        "WHERE audience_kind = 'curator_groups'"
    )
    op.create_check_constraint(
        _CHECK,
        "practices",
        "audience_kind <> 'schools' OR school_id IS NOT NULL",
    )

    for old, new in _JOURNAL_KINDS:
        op.execute(
            f"UPDATE school_event SET event = '{new}' WHERE event = '{old}'"
        )
    _move_right("can_create_groups", "can_create_schools")


def downgrade() -> None:
    """Revert this migration -- the exact inverse of upgrade()."""
    op.execute("SET LOCAL lock_timeout = '5s'")

    _move_right("can_create_schools", "can_create_groups")
    for old, new in _JOURNAL_KINDS:
        op.execute(
            f"UPDATE school_event SET event = '{old}' WHERE event = '{new}'"
        )

    op.drop_constraint(_CHECK, "practices", type_="check")
    op.execute(
        "UPDATE practices SET audience_kind = 'curator_groups' "
        "WHERE audience_kind = 'schools'"
    )

    op.execute(f"ALTER SEQUENCE {_SEQUENCE[1]} RENAME TO {_SEQUENCE[0]}")
    for table, old, new in reversed(_CONSTRAINTS):
        op.execute(f"ALTER TABLE {table} RENAME CONSTRAINT {new} TO {old}")
    for old, new in reversed(_INDEXES):
        op.execute(f"ALTER INDEX {new} RENAME TO {old}")
    for table, old, new in reversed(_COLUMNS):
        op.execute(f"ALTER TABLE {table} RENAME COLUMN {new} TO {old}")
    for old, new in reversed(_TABLES):
        op.execute(f"ALTER TABLE {new} RENAME TO {old}")

    op.execute(
        _FUNCTION_BODY.format(
            function=_FUNCTION, column="curator_group_id", kind="curator_groups",
        )
    )
    op.create_check_constraint(
        _CHECK,
        "practices",
        "audience_kind <> 'curator_groups' OR curator_group_id IS NOT NULL",
    )
