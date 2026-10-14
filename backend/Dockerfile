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
# Base image (BE-157): pinned by the INDEX digest of the multi-arch manifest
# list -- the pull picks the platform (servers are amd64). The tag only names
# what is inside (Python 3.12.15 on Debian 13 trixie); the digest decides.
# The same string is in BOTH stages below and in scripts/velo-manage.sh
# (run_codec_vector_diff): moving the base means changing all three at once.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Stage 1: Builder — install all dependencies
# ---------------------------------------------------------------------------
FROM python:3.12.15-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1 AS builder

WORKDIR /build

COPY pyproject.toml ./

RUN python -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip && \
    /opt/venv/bin/pip install --no-cache-dir ".[dev]"

# ---------------------------------------------------------------------------
# Stage 2: Runtime
# ---------------------------------------------------------------------------
FROM python:3.12.15-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1 AS runtime

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

# --no-proxy-headers (BE-40): uvicorn's own X-Forwarded-For handling is OFF.
# It is on by default, trusts 127.0.0.1/::1 unless FORWARDED_ALLOW_IPS says
# otherwise, and when it trusts the peer it rewrites scope["client"] from the
# header without validating it. The application reads the client address
# itself -- X-Real-IP from nginx, see _extract_client_ip in
# app/core/middleware.py -- and needs scope["client"] to stay the TCP peer
# the OS reported. Off, no environment variable can turn the header back on.
CMD ["uvicorn", "app.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--workers", "2", \
     "--no-proxy-headers"]
