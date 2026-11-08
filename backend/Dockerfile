# =============================================================================
# VELO Backend -- Dockerfile
# =============================================================================
#
# Built from the REPOSITORY ROOT (context `.`, `-f backend/Dockerfile`): the
# test stage needs comms-profile/, which lives beside backend/, not inside it.
# What the context carries is the allowlist in backend/Dockerfile.dockerignore
# (BuildKit reads it instead of a root .dockerignore).
#
# STAGES (PRIMER-PROTOCOL 3.3, 7.1):
#   builder       runtime dependencies into /opt/venv, strictly by
#                 backend/requirements.txt (hashes, wheels only).
#   builder-test  builder + the dev dependencies of
#                 backend/requirements-dev.txt, the same way.
#   runtime       what runs on a server: the venv of `builder`, app/,
#                 migrations/, alembic.ini, scripts/ -- no tests, no dev
#                 tools. docker-compose.yml builds this.
#   test          runtime + the venv of `builder-test` + tests/,
#                 pyproject.toml (the pytest configuration), primer.yaml and
#                 docker-compose.yml at /, and the comms profile at
#                 /comms-profile. primer.yaml's
#                 test.target and CI (.github/workflows/backend-tests.yml) build
#                 this; the suite runs in it, not in the runtime image.
#
# BUILD ARGUMENTS: PRIMER_RELEASE and PRIMER_COMMIT, given by the deploy
# machine (protocol 3.4), required -- an empty or missing one fails the build
# at the end of `runtime`, and both runtime and test carry them as ENV (the
# process reads them; /health reports them, BE-190). They are declared only
# there, after every dependency layer: a build with another commit takes
# builder and builder-test from the cache.
#
# The project itself is never installed -- only its locked dependencies.
# PYTHONPATH=/app makes `from app.core.config import settings` work
# everywhere: uvicorn, alembic, pytest, scripts/.
# =============================================================================

# ---------------------------------------------------------------------------
# Base image (BE-157): pinned by the INDEX digest of the multi-arch manifest
# list -- the pull picks the platform (servers are amd64). The tag only names
# what is inside (Python 3.12.15 on Debian 13 trixie); the digest decides.
# The same string is in BOTH FROM lines that name it below (builder, runtime;
# builder-test and test derive from those) and in scripts/velo-manage.sh
# (run_codec_vector_diff): moving the base means changing all three at once.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# builder -- runtime dependencies by the lock
# ---------------------------------------------------------------------------
# --require-hashes: every line of the lock must be pinned (==) and hashed, and
# every dependency of every line must itself be a line -- a lock edited
# without hashes, or missing a transitive dependency, fails here.
# --only-binary :all:: no source build, whose build dependencies pip would
# fetch unpinned and unhashed. The base image's own pip, fixed by the digest.
FROM python:3.12.15-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1 AS builder

WORKDIR /build

COPY backend/requirements.txt ./

RUN python -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir --require-hashes \
        --only-binary :all: -r requirements.txt

# ---------------------------------------------------------------------------
# builder-test -- the dev dependencies on top, by their own lock
# ---------------------------------------------------------------------------
# requirements-dev.txt is the whole set (runtime + dev), compiled against
# requirements.txt as a constraint: the shared lines are the same pins, so pip
# only adds the dev packages, still checking every hash.
FROM builder AS builder-test

COPY backend/requirements-dev.txt ./

RUN /opt/venv/bin/pip install --no-cache-dir --require-hashes \
        --only-binary :all: -r requirements-dev.txt

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM python:3.12.15-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1 AS runtime

WORKDIR /app

# Non-root user (TD-005).
RUN groupadd --gid 1000 velo && \
    useradd --uid 1000 --gid velo --shell /bin/sh velo

COPY --from=builder /opt/venv /opt/venv

# alembic.ini + migrations/: the machine runs `migrate` in a one-shot
# container of this image (protocol 6.5). scripts/: seeds and verbs run in the
# app container (primer.yaml).
COPY backend/app/ ./app/
COPY backend/scripts/ ./scripts/
COPY backend/alembic.ini ./
COPY backend/migrations/ ./migrations/
# The log configuration of protocol 9.4 (BE-190): uvicorn takes it with
# --log-config below, migrations/env.py and the app apply the same file
# (app/core/logging.py).
COPY backend/logging.json ./
# The edition -> modules table, one for the repository (BE-182): at / so
# that app/core/editions.py finds it at parents[3], as from the repository.
COPY editions.json /editions.json

ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
# CRITICAL: alembic, pytest, and any CLI tool can find `app` package.
ENV PYTHONPATH="/app"

# Last, after every dependency layer and the code (see the header).
ARG PRIMER_RELEASE
ARG PRIMER_COMMIT
RUN for name in PRIMER_RELEASE PRIMER_COMMIT; do \
        eval "value=\${$name}"; \
        if [ -z "$value" ]; then \
            echo "build argument $name is required and must not be empty" \
                "(--build-arg $name=<value>)" >&2; \
            exit 1; \
        fi; \
    done
ENV PRIMER_RELEASE="$PRIMER_RELEASE"
ENV PRIMER_COMMIT="$PRIMER_COMMIT"

USER velo
EXPOSE 8000

# --no-proxy-headers (BE-40): uvicorn's own X-Forwarded-For handling is OFF.
# It is on by default, trusts 127.0.0.1/::1 unless FORWARDED_ALLOW_IPS says
# otherwise, and when it trusts the peer it rewrites scope["client"] from the
# header without validating it. The application reads the client address
# itself -- X-Real-IP from nginx, see _extract_client_ip in
# app/core/middleware.py -- and needs scope["client"] to stay the TCP peer
# the OS reported. Off, no environment variable can turn the header back on.
#
# --log-config (BE-190): every line uvicorn writes -- the supervisor process
# of --workers included, which never imports the app -- is a JSON line of
# protocol 9.4, and its access line (the client's address) is off.
CMD ["uvicorn", "app.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--workers", "2", \
     "--no-proxy-headers", \
     "--log-config", "/app/logging.json"]

# ---------------------------------------------------------------------------
# test -- the image the suite runs in (protocol 7.1)
# ---------------------------------------------------------------------------
# FROM runtime, so the code under test is the code that ships, byte for byte.
# The venv of builder-test replaces the runtime one: the same runtime pins plus
# the dev packages, installed once in builder-test and only copied here.
FROM runtime AS test

COPY --from=builder-test /opt/venv /opt/venv

COPY backend/tests/ ./tests/
# [tool.pytest.ini_options]: asyncio_mode = "auto", testpaths, cache_dir.
COPY backend/pyproject.toml ./
# BE-192: what the deploy machine is told about this product -- read by
# tests/test_primer_env.py, which holds Settings, compose's app.environment
# and primer.yaml's env and egress together, and (BE-193) the storage
# stack's root login against primer.yaml's env. / is
# where the tests' Path(__file__).resolve().parents[2] lands from /app/tests,
# as for the comms profile below. No file holds a value (protocol 5.1); the
# storage file holds one constant of the product, the root login.
COPY primer.yaml docker-compose.yml docker-compose.storage.yml /
# The one settings environment of CI and the two workflows that read it --
# test_primer_env.py holds them and Settings together (BE-190 fix). The
# values are invented; the runtime stage has none of them.
COPY backend/ci.env /backend/ci.env
COPY .github/workflows/ci.yml .github/workflows/backend-tests.yml /.github/workflows/
# The comms product profile, which the suite checks every notification
# against (tests/notification_guard.py). /comms-profile is where the tests'
# Path(__file__).resolve().parents[2] / "comms-profile" lands from
# /app/tests -- the only place some of them look. The runtime image does not
# need it: comms gets the profile itself (protocol 4.5).
COPY comms-profile/ /comms-profile/
