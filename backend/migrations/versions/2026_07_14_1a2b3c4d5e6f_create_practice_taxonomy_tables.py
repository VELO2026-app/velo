"""create_practice_taxonomy_tables

Revision ID: 1a2b3c4d5e6f
Revises: 9f1e2d3c4b5a
Create Date: 2026-07-14 00:00:00.000000+00:00

R5 (batch R stage 1): practice_directions + practice_styles, DB-backed catalog
for MASTER METHODS only (data.profile.methods). Practice-creation taxonomy
validation is UNCHANGED -- stays on settings.practice_allowed_directions /
practice_allowed_styles_by_direction (operator decision, PROMPT №394).

Seeded byte-for-byte from the two existing hand-kept-in-sync sources:
  - values + which directions have styles: core/config.py:154-171
    (practice_allowed_directions / practice_allowed_styles_by_direction)
  - Russian labels + display order: frontend/src/utils/practiceOptions.ts:170-220
    (DIRECTION_OPTIONS / STYLE_OPTIONS_BY_DIRECTION) -- the backend has no
    labels today, so they are copied verbatim from the FE const, same order.
All seeded rows get source='seed'. The enum (PracticeDirection) and config
list are NOT touched -- they remain the fallback/seed source, per the
operator's explicit "do not delete" instruction.
"""

import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "1a2b3c4d5e6f"
down_revision: str | None = "9f1e2d3c4b5a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# -- Seed data: byte-for-byte from config.py (values) + practiceOptions.ts
# (labels + order). See module docstring for the exact source lines. --
_DIRECTIONS: list[tuple[str, str]] = [
    ("meditation", "Медитация"),
    ("yoga", "Йога"),
    ("breathwork", "Дыхательные практики"),
    ("somatic", "Соматика"),
    ("tantra", "Тантра"),
    ("circles", "Круги"),
    ("sound_healing", "Саундхиллинг"),
    ("art", "Арт-практики"),
    ("narrative", "Нарративные практики"),
    ("movement", "Движение"),
]

_STYLES_BY_DIRECTION: dict[str, list[tuple[str, str]]] = {
    "meditation": [
        ("silence", "Медитация молчания"),
        ("presence", "Медитация присутствия"),
        ("sound", "Звуковая медитация"),
        ("taoist", "Даосская медитация"),
    ],
    "yoga": [
        ("nidra", "Йога-нидра"),
        ("yin", "Инь-йога"),
        ("hatha", "Хатха-йога"),
        ("vinyasa", "Виньяса"),
        ("kundalini", "Кундалини-йога"),
        ("ashtanga", "Аштанга-йога"),
    ],
    "circles": [
        ("womens", "Женский круг"),
        ("mens", "Мужской круг"),
        ("sharing", "Круг шеринга"),
    ],
}


def upgrade() -> None:
    """Apply this migration."""
    op.create_table(
        "practice_directions",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("value", sa.String(length=50), nullable=False),
        sa.Column("label", sa.String(length=100), nullable=False),
        sa.Column(
            "display_order", sa.Integer(), server_default="0", nullable=False,
        ),
        sa.Column(
            "is_active", sa.Boolean(), server_default="true", nullable=False,
        ),
        sa.Column(
            "source", sa.String(length=20), server_default="custom", nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("value", name="uq_practice_directions_value"),
    )

    op.create_table(
        "practice_styles",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "direction_id",
            sa.UUID(),
            sa.ForeignKey("practice_directions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("value", sa.String(length=50), nullable=False),
        sa.Column("label", sa.String(length=100), nullable=False),
        sa.Column(
            "display_order", sa.Integer(), server_default="0", nullable=False,
        ),
        sa.Column(
            "is_active", sa.Boolean(), server_default="true", nullable=False,
        ),
        sa.Column(
            "source", sa.String(length=20), server_default="custom", nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "direction_id", "value", name="uq_practice_styles_direction_value",
        ),
    )
    op.create_index(
        "ix_practice_styles_direction_id", "practice_styles", ["direction_id"],
    )

    # -- Seed (source='seed'), byte-for-byte -- see module docstring. --
    directions_table = sa.table(
        "practice_directions",
        sa.column("id", sa.UUID()),
        sa.column("value", sa.String()),
        sa.column("label", sa.String()),
        sa.column("display_order", sa.Integer()),
        sa.column("source", sa.String()),
    )
    styles_table = sa.table(
        "practice_styles",
        sa.column("id", sa.UUID()),
        sa.column("direction_id", sa.UUID()),
        sa.column("value", sa.String()),
        sa.column("label", sa.String()),
        sa.column("display_order", sa.Integer()),
        sa.column("source", sa.String()),
    )

    direction_ids: dict[str, uuid.UUID] = {}
    direction_rows = []
    for order, (value, label) in enumerate(_DIRECTIONS):
        direction_id = uuid.uuid4()
        direction_ids[value] = direction_id
        direction_rows.append(
            {
                "id": direction_id,
                "value": value,
                "label": label,
                "display_order": order,
                "source": "seed",
            }
        )
    op.bulk_insert(directions_table, direction_rows)

    style_rows = []
    for direction_value, styles in _STYLES_BY_DIRECTION.items():
        for order, (value, label) in enumerate(styles):
            style_rows.append(
                {
                    "id": uuid.uuid4(),
                    "direction_id": direction_ids[direction_value],
                    "value": value,
                    "label": label,
                    "display_order": order,
                    "source": "seed",
                }
            )
    op.bulk_insert(styles_table, style_rows)


def downgrade() -> None:
    """Revert this migration."""
    op.drop_index("ix_practice_styles_direction_id", table_name="practice_styles")
    op.drop_table("practice_styles")
    op.drop_table("practice_directions")
