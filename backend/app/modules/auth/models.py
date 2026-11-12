# =============================================================================
# VELO Backend -- Auth models: the Mini App `signature` measurement (BE-201)
# =============================================================================
#
# One row per person who has signed in from the Mini App: when they last
# came WITH Telegram's `signature` field in initData and when they last
# came WITHOUT it. This is the measurement BE-183 is decided on (moving
# the Mini App login onto Telegram's public-key check, which old clients
# without `signature` cannot pass); the table goes away there together
# with the bot-token check.
#
# Kept in the database, not in the log: the deploy machine does not keep
# container logs across deploys, and the measurement has to survive them.
#
# Writer: app/modules/auth/signature_stats.py record(), on the login path
# only (POST /api/v1/auth/telegram). Reader: the same module's count(),
# called by scripts/signature_stats.py. Nothing about the person is here
# beyond the internal user id.
# =============================================================================

from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class MiniAppSignatureSeen(Base):
    """When a person last signed in from the Mini App with / without
    `signature`.

    Both times are nullable: a person who has only ever come with the
    field has no `last_without_signature_at`, and the other way round. A
    row always has at least one of them -- it is only ever written by a
    sign-in, which sets one.
    """

    __tablename__ = "mini_app_signature_seen"

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    last_with_signature_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    last_without_signature_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
