# =============================================================================
# VELO Frontend -- Dockerfile (primer era: FE-129 runtime config, FE-149 §3)
# =============================================================================
#
# MULTI-STAGE BUILD:
#   Stage 1 ("source"):  pnpm install --frozen-lockfile + source copied -- deps
#                        ready, NOTHING executed. `velo test` builds up to here
#                        and runs the suite ONCE, with live output.
#   Stage 2 ("builder"): pnpm run build -> produces dist/ + build-info.json
#   Stage 3 ("runtime"): nginx serves dist/; /config.json rendered at start
#
# NO INSTANCE VALUES IN THE BUILD (contract 3 rule 19): the machine passes
# exactly PRIMER_RELEASE, PRIMER_COMMIT -- and PRIMER_EDITION only to builds
# with an apply:build package (FE-130). apiBaseUrl, bot url, locales, brand
# ride the runtime /config.json, rendered by the entrypoint's envsubst from
# the container environment (nginx/config.json.template). The interim shell
# deploy keeps its vite.env source by feeding the frontend service's
# `environment` (docker-compose.yml) instead of build args.
#
# NO TESTS IN THE BUILD ANCESTRY (FE-149 §3): the machine builds runtime on
# every rollout of every instance -- a suite inside builder would run on each
# of those builds, prod included. The gate lives in CI (job frontend);
# `velo test` still runs the suite against --target source.
#
# WHY "source" EXISTS. `velo test` used to build --target builder (which runs
# the whole suite inside the build, silently, behind `-q`) and THEN run the
# suite again in a container -- the same ~3.5 minutes twice, the first half
# with no output at all. Building --target source instead means the suite runs
# exactly once, in the place whose output a human is actually reading.
#
# BUILD CONTEXT = REPOSITORY ROOT (FE-116): the pnpm workspace -- the
# lockfile, pnpm-workspace.yaml and every member manifest -- lives at the
# root, so `pnpm install` must run from there. The context used to be
# ./frontend alone; the root .dockerignore keeps it from dragging the
# backend tree and the working docs through every frontend build.
#
# Internal Nginx handles SPA fallback and, under the machine, the same-origin
# /api proxy and the /health //ready closure (see nginx.conf). The external
# nginx (the machine's) handles SSL + the public route.
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Source -- deps installed, nothing run
# ---------------------------------------------------------------------------
# Base images (BE-157): pinned by the INDEX digest of the multi-arch manifest
# list -- the pull picks the platform. The tag only names what is inside
# (Node 24.21.0 / nginx 1.31.6 on Alpine 3.24); the digest decides.
FROM node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS source

WORKDIR /app

# Install dependencies first (cached unless a manifest / pnpm-lock.yaml /
# pnpm-workspace.yaml changes). pnpm-workspace.yaml is required: without it
# pnpm errors out on the allowed-build-scripts check (esbuild, vue-demi).
# ALL member manifests are copied for the frozen-lockfile check, but only
# the APPLICATION's node_modules deploy: --filter velo-frontend installs
# the app and its dependency closure -- @velo/ui is not a dependency until
# P8, so the image stays free of the package's dev toolchain (storybook).
# The pnpm version here mirrors the packageManager pin in the ROOT
# package.json (the workspace root since FE-116).
#
# --trust-lockfile skips pnpm's supply-chain verification of the lockfile,
# and that is deliberate: the check is time-based (it rejects entries newer
# than minimumReleaseAge counted from NOW), so running it here makes the
# image build non-reproducible -- the same commit builds or fails depending
# on the hour. It also guards the wrong end: a freshly published package can
# only enter at `pnpm install` on a developer machine, where the lockfile is
# written. By the time we get here the lockfile is committed and reviewed.
# The policy therefore stays ON by default where lockfiles are produced and
# OFF where they are consumed. --frozen-lockfile still pins every version.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json frontend/
COPY packages/velo-ui/package.json packages/velo-ui/
RUN npm install -g pnpm@12.4.2 && pnpm install --frozen-lockfile --trust-lockfile --filter velo-frontend...

# Copy source. This stage deliberately ENDS here: it is what `velo test`
# builds, so building it must not execute the suite that `velo test` is
# about to run itself.
COPY frontend frontend
COPY packages packages
# FE-130: vite.config.ts reads the "edition -> modules" table from the repo
# root (../editions.json from frontend/), the one table shared with the
# backend. After the install layer, so editing the table does not throw
# away the dependency cache. Every other path the build reads outside
# frontend/ and packages/ is one of the three root files copied above.
COPY editions.json ./

# ---------------------------------------------------------------------------
# Stage 2: Build
# ---------------------------------------------------------------------------
FROM source AS builder

# Build identity (primer guide §3.1, contract 3 rule 19): the machine passes
# PRIMER_RELEASE (tag or branch) and PRIMER_COMMIT (sha) to EVERY build, and
# a build without them is red on the machine -- checked here, fail fast. The
# interim shell deploy passes neutral defaults through compose build.args.
# They surface as build-info.json next to index.html: BE-149's naming-files
# rule (never keep a stale build name) applies to it too -- nginx.conf serves
# it with no-cache.
ARG PRIMER_RELEASE
ARG PRIMER_COMMIT
# FE-130: the edition channel -- the machine passes PRIMER_EDITION exactly to
# builds of services with an apply:build package (ours: the skin); vite
# resolves it through editions.json. Absent in the interim shell build -> the
# golden all-on set (rule 19: this is the machine's third and last argument).
ARG PRIMER_EDITION
RUN test -n "$PRIMER_RELEASE" && test -n "$PRIMER_COMMIT"

# Type-check + bundle (pnpm run build = vue-tsc --noEmit && vite build),
# then stamp the identity next to index.html.
RUN pnpm -C frontend run build \
    && printf '{"release":"%s","commit":"%s"}\n' "$PRIMER_RELEASE" "$PRIMER_COMMIT" \
       > /app/frontend/dist/build-info.json

# ---------------------------------------------------------------------------
# Stage 3: Serve with Nginx
# ---------------------------------------------------------------------------
FROM nginx:1.31.6-alpine3.24@sha256:df221db836e1754089190208cee7eeda94f233197056426eda74a43ab1abeac2 AS runtime

# Remove default nginx site.
RUN rm -f /etc/nginx/conf.d/default.conf

# Runtime instance config (FE-129): the stock nginx image entrypoint runs
# 30-envsubst-on-templates.sh at start. The template renders /config.json
# from the container environment; the FILTER keeps envsubst to the four
# declared keys -- primer.yaml's env names (the brand is a skin property,
# not a start value -- owner 09.11) (primer-blank's pattern -- no instance value can leak into
# anything else, and nothing else can leak into the config). The context is
# the repo root since FE-116, so COPY paths carry the frontend/ prefix.
ENV NGINX_ENVSUBST_TEMPLATE_DIR=/etc/nginx/templates \
    NGINX_ENVSUBST_OUTPUT_DIR=/usr/share/nginx/html \
    NGINX_ENVSUBST_FILTER='^(API_BASE_URL|TELEGRAM_BOT_URL|DEFAULT_LANGUAGE|LANGUAGES)$'
COPY frontend/nginx/config.json.template /etc/nginx/templates/config.json.template
# FE-155: instance part of the manifest (lang, description) at start.
COPY --chmod=755 frontend/nginx/40-manifest-locale.sh /docker-entrypoint.d/40-manifest-locale.sh

# Copy our nginx config.
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Copy built static files from builder.
COPY --from=builder /app/frontend/dist /usr/share/nginx/html

EXPOSE 3000

CMD ["nginx", "-g", "daemon off;"]
