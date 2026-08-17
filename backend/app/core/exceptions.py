# =============================================================================
# VELO Backend — Base Exceptions
# =============================================================================
#
# WHY CUSTOM EXCEPTIONS?
#   Python's built-in exceptions (ValueError, KeyError) don't carry HTTP
#   context. When a user requests a non-existent practice, we need to know:
#   - What went wrong (message)
#   - What HTTP status to return (404)
#   - A machine-readable error code ("practice_not_found")
#
#   Custom exceptions carry all this info. FastAPI exception handlers
#   then convert them into proper HTTP responses automatically.
#
# HIERARCHY:
#   VeloError (base — all our exceptions inherit from this)
#   ├── UnauthorizedError    → 401 (missing or invalid token)
#   ├── NotFoundError        → 404
#   ├── ForbiddenError       → 403
#   ├── ConflictError        → 409 (e.g., double booking)
#   ├── BadRequestError      → 400 (e.g., invalid input beyond Pydantic)
#   └── TooManyRequestsError → 429 (rate limited; T-47)
#
# USAGE (in future modules):
#   from app.core.exceptions import NotFoundError
#   raise NotFoundError("Practice not found", code="practice_not_found")
# =============================================================================


class VeloError(Exception):
    """Base exception for all VELO application errors.

    Attributes:
        message: Human-readable error description.
        code: Machine-readable error code for frontend/API consumers.
              Example: "practice_not_found", "insufficient_balance"
        status_code: HTTP status code to return in the API response.
    """

    def __init__(
        self,
        message: str = "An error occurred",
        code: str = "internal_error",
        status_code: int = 500,
    ) -> None:
        self.message = message
        self.code = code
        self.status_code = status_code
        super().__init__(message)


class UnauthorizedError(VeloError):
    """Authentication required or token invalid (HTTP 401).

    Examples: missing Bearer token, expired session, invalid initData.
    """

    def __init__(
        self,
        message: str = "Authentication required",
        code: str = "unauthorized",
    ) -> None:
        super().__init__(message=message, code=code, status_code=401)


class NotFoundError(VeloError):
    """Resource not found (HTTP 404).

    Examples: practice doesn't exist, user not found, booking missing.
    """

    def __init__(
        self,
        message: str = "Resource not found",
        code: str = "not_found",
    ) -> None:
        super().__init__(message=message, code=code, status_code=404)


class ForbiddenError(VeloError):
    """Action not allowed for this user (HTTP 403).

    Examples: user tries to edit someone else's practice,
    non-master tries to create a practice.
    """

    def __init__(
        self,
        message: str = "Action not allowed",
        code: str = "forbidden",
    ) -> None:
        super().__init__(message=message, code=code, status_code=403)


class ConflictError(VeloError):
    """Action conflicts with current state (HTTP 409).

    Examples: double booking the same practice,
    withdrawing more than available balance.
    """

    def __init__(
        self,
        message: str = "Conflict with current state",
        code: str = "conflict",
    ) -> None:
        super().__init__(message=message, code=code, status_code=409)


class BadRequestError(VeloError):
    """Invalid request that goes beyond Pydantic validation (HTTP 400).

    Examples: trying to book a cancelled practice,
    applying expired promo code.
    """

    def __init__(
        self,
        message: str = "Bad request",
        code: str = "bad_request",
    ) -> None:
        super().__init__(message=message, code=code, status_code=400)


class TooManyRequestsError(VeloError):
    """Rate limit exceeded (HTTP 429).

    Examples: repeated auth attempts from one source, abusive bursts.

    T-47: added because rate limiting used to answer 400, which tells a
    caller "your request was malformed" when the request was fine and the
    only problem was its rate -- and denies well-behaved clients the one
    status code they know how to back off from.
    """

    def __init__(
        self,
        message: str = "Too many requests",
        code: str = "too_many_requests",
    ) -> None:
        super().__init__(message=message, code=code, status_code=429)
