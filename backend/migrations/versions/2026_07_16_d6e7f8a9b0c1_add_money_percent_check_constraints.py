"""add_money_percent_check_constraints

Revision ID: d6e7f8a9b0c1
Revises: 1a2b3c4d5e6f
Create Date: 2026-07-16 00:00:00.000000+00:00

W5 (probekit sweep 2026-07-13): three of the four purchases money columns
had no DB-level CheckConstraint. Originally scoped as "promos.discount_percent
+ all four purchases columns had no constraint" -- that was wrong. A grep of
migrations/versions/ (done AFTER an earlier version of this migration almost
shipped two collisions, caught by the navigator) shows two of the five
constraints first written here already exist:
  - ck_promos_discount_percent_positive (2026_02_21_d0e1f2a3b4c5) already
    enforces discount_percent > 0 AND discount_percent <= 100 on promos --
    identical predicate to what this migration would have added under a
    different name. Redundant; dropped from this migration entirely.
  - ck_purchases_discount_cents_non_negative (2026_02_21_e1f2a3b4c5d6)
    already exists on purchases with the identical name AND predicate
    (discount_cents >= 0). Re-creating it would raise "constraint already
    exists" and fail the deploy outright -- NOT VALID does not help here,
    that only protects against bad existing DATA, not a NAME collision.
  - Also already there: ck_purchases_paid_equals_amount_minus_discount
    (same migration as above) -- paid_cents = amount_cents - discount_cents,
    an invariant stronger than anything added here. It does not by itself
    make amount_cents/paid_cents non-negative (e.g. amount_cents=-500,
    discount_cents=-600, paid_cents=100 satisfies the equation), so this
    migration's amount_cents/paid_cents constraints are still needed.

The three genuinely missing constraints, added here:
  - purchases.amount_cents >= 0
  - purchases.paid_cents >= 0
  - purchases.commission_cents >= 0

NOT VALID (operator decision, PROMPT №422): added via raw
ALTER TABLE ... CHECK (...) NOT VALID, not op.create_check_constraint()
(which does not emit NOT VALID). Postgres skips validating existing rows
and enforces only new inserts/updates -- this migration cannot fail on
whatever is already sitting in the operator's hand-seeded TEST database.
Full validation (ALTER TABLE ... VALIDATE CONSTRAINT ...) is a separate,
later, deliberate command once someone has actually looked at what's in
there -- not part of this batch.

Range chosen for all three: >= 0, deliberately NOT > 0 like the withdrawals
precedent (ck_withdrawals_amount_positive). purchase.py's
create_purchase_for_booking legitimately writes 0 for free practices
(price_cents=0) for amount_cents/paid_cents, and commission_cents starts at
0 at creation (set later by auto_finalize_practice / the early-cancel
finalize path in payments/refund.py, both computing
paid_cents * settings.commission_percent // 100, non-negative given
paid_cents >= 0 and commission_percent in [0, 100], config.py CQ-02). A
> 0 constraint on any of the three would break every free-practice
purchase -- the exact outage this constraint exists to prevent.
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d6e7f8a9b0c1"
down_revision: str | None = "1a2b3c4d5e6f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add the three missing NOT VALID check constraints on purchases."""
    op.execute(
        "ALTER TABLE purchases "
        "ADD CONSTRAINT ck_purchases_amount_cents_non_negative "
        "CHECK (amount_cents >= 0) NOT VALID"
    )
    op.execute(
        "ALTER TABLE purchases "
        "ADD CONSTRAINT ck_purchases_paid_cents_non_negative "
        "CHECK (paid_cents >= 0) NOT VALID"
    )
    op.execute(
        "ALTER TABLE purchases "
        "ADD CONSTRAINT ck_purchases_commission_cents_non_negative "
        "CHECK (commission_cents >= 0) NOT VALID"
    )


def downgrade() -> None:
    """Drop only the three constraints this migration creates."""
    op.execute(
        "ALTER TABLE purchases "
        "DROP CONSTRAINT ck_purchases_commission_cents_non_negative"
    )
    op.execute(
        "ALTER TABLE purchases "
        "DROP CONSTRAINT ck_purchases_paid_cents_non_negative"
    )
    op.execute(
        "ALTER TABLE purchases "
        "DROP CONSTRAINT ck_purchases_amount_cents_non_negative"
    )
