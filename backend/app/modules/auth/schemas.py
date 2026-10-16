# =============================================================================
# VELO Backend — Auth Schemas
# =============================================================================
#
# Pydantic models for auth request/response validation.
# FastAPI auto-generates OpenAPI docs from these.
#
# NOTE: UserResponse lives in users/schemas.py (moved in Phase 1.4).
# Imported here for AuthResponse backward compatibility.
# =============================================================================

from typing import Annotated

from pydantic import BaseModel, Field

from app.modules.users.schemas import UserResponse


class TelegramAuthRequest(BaseModel):
    """POST /api/v1/auth/telegram — request body."""

    init_data: str = Field(
        ...,
        description="Raw initData string from Telegram WebApp",
        min_length=1,
    )


class AuthResponse(BaseModel):
    """POST /api/v1/auth/telegram — response body."""

    user: UserResponse
    session_token: str


# -- Browser sign-in through Telegram (Standalone phase 3) --------------------
#
# The MARK is a random string the browser keeps while the person is away at
# Telegram (modules/auth/browser_login.py, WHY THE MARK). The frontend makes
# it with 32 random bytes in base64url (43 characters); the bounds below leave
# room and refuse anything that is not that alphabet.

Mark = Annotated[str, Field(min_length=32, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")]


class BrowserLoginStartRequest(BaseModel):
    """POST /api/v1/auth/telegram/browser/start -- request body."""

    mark: Mark


class BrowserLoginStartResponse(BaseModel):
    """Where to send the browser, and the state the frontend keeps next to
    its mark until the return."""

    url: str
    state: str


class BrowserLoginCompleteRequest(BaseModel):
    """POST /api/v1/auth/telegram/browser/complete -- request body.

    `code` and `state` are what Telegram put on the return address; `mark` is
    the browser's own. `language` is the browser's language tag: untrusted,
    optional, bounded here, and used only through normalize_language and only
    when the account is created (auth/service.py, upsert_user_on_login).
    """

    code: str = Field(..., min_length=1, max_length=512)
    state: str = Field(..., min_length=1, max_length=256)
    mark: Mark
    language: str | None = Field(default=None, max_length=35)


class BrowserLoginResponse(AuthResponse):
    """POST /api/v1/auth/telegram/browser/complete -- response body: the same
    as POST /auth/telegram, plus whether THIS sign-in gave the bot the right
    to write to the person (telegram_oidc.py, THE BOT'S RIGHT TO WRITE)."""

    bot_access_granted: bool
