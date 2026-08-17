# =============================================================================
# VELO Backend — Dockerfile
# =============================================================================
#
# MULTI-STAGE BUILD:
#   Stage 1 ("builder"): installs ALL dependencies (prod + dev) into a venv.
#   Stage 2 ("runtime"): copies venv + app code + tests + scripts.
#
# Dev dependencies (pytest, ruff, httpx) are ALWAYS installed because
# tests run inside this same container on the VPS. There is no separate
# "production" image — the test VPS IS the only environment.
#
# PYTHONPATH=/app ensures `from app.core.config import settings` works
# everywhere: uvicorn, alembic, pytest — without `pip install -e .`.
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Builder — install all dependencies
# ---------------------------------------------------------------------------
FROM python:3.12-slim AS builder

WORKDIR /build

COPY pyproject.toml ./

RUN python -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip && \
    /opt/venv/bin/pip install --no-cache-dir ".[dev]"

# ---------------------------------------------------------------------------
# Stage 2: Runtime
# ---------------------------------------------------------------------------
FROM python:3.12-slim AS runtime

WORKDIR /app

# Non-root user (TD-005).
RUN groupadd --gid 1000 velo && \
    useradd --uid 1000 --gid velo --shell /bin/sh velo

COPY --from=builder /opt/venv /opt/venv

# Copy everything the app needs.
COPY app/ ./app/
COPY tests/ ./tests/
COPY scripts/ ./scripts/
COPY pyproject.toml ./
COPY alembic.ini ./
COPY migrations/ ./migrations/
# T-14: documentation, not a secret (.env itself is never copied in) --
# needed by test_config.py's sync test, which runs inside this image.
COPY .env.example ./

ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
# CRITICAL: alembic, pytest, and any CLI tool can find `app` package.
ENV PYTHONPATH="/app"

USER velo
EXPOSE 8000

CMD ["uvicorn", "app.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--workers", "2", \
     "--proxy-headers"]
