# syntax=docker/dockerfile:1.7
#
# The front door: the real production nginx, serving the frontend built from source.
#
# The site configuration is not a copy. docker/nginx/render-config.sh reads
# deploy/nginx/*.conf on every build and applies a closed, documented set of
# substitutions, so what runs locally is what ships. See that script for the
# complete list.
#
# The render runs TWICE, deliberately:
#   - at build time, so `nginx -t` can fail the build on an invalid config (FR-014)
#   - at container start, via /docker-entrypoint.d, so changing a rate limit in
#     .env takes effect on restart without rebuilding an image (FR-022)

ARG NODE_VERSION=22-bookworm-slim
ARG NGINX_VERSION=1.27-alpine


# ---------------------------------------------------------------------------
# deps — same inputs as api.Dockerfile, so the layer is shared
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true

RUN corepack enable && corepack prepare pnpm@10.18.0 --activate

WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY artifacts/api-server/package.json       artifacts/api-server/package.json
COPY artifacts/bhi-card-portal/package.json  artifacts/bhi-card-portal/package.json
COPY artifacts/mockup-sandbox/package.json   artifacts/mockup-sandbox/package.json
COPY lib/api-client-react/package.json       lib/api-client-react/package.json
COPY lib/api-spec/package.json               lib/api-spec/package.json
COPY lib/api-zod/package.json                lib/api-zod/package.json
COPY lib/card-design/package.json            lib/card-design/package.json
COPY lib/db/package.json                     lib/db/package.json
COPY scripts/package.json                    scripts/package.json

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile


# ---------------------------------------------------------------------------
# build-web — vite build
# ---------------------------------------------------------------------------
FROM deps AS build-web

# tsconfig.base.json is required. Vite resolves `extends` eagerly and fails the
# build outright when it is missing — unlike esbuild, which only warns.
COPY tsconfig.json tsconfig.base.json ./
COPY lib/ lib/
COPY attached_assets/ attached_assets/
COPY artifacts/bhi-card-portal/ artifacts/bhi-card-portal/

# vite.config.ts THROWS unless both are set — including for `build`, where PORT is
# only ever consumed by the dev server. BASE_PATH must be exactly "/"; the config
# has a guard explaining that a shell which rewrites a leading slash produces a
# silently blank page. Inside a Linux container that class of failure cannot occur.
ENV PORT=5173 \
    BASE_PATH=/ \
    NODE_ENV=production

RUN pnpm --filter @workspace/bhi-card-portal run build


# ---------------------------------------------------------------------------
# web — runtime
# ---------------------------------------------------------------------------
FROM nginx:${NGINX_VERSION} AS web

# The stock site would also bind port 80.
RUN rm -f /etc/nginx/conf.d/default.conf

# The production nginx assets, verbatim. bhi-portal.conf names all three of these
# and nginx refuses to start if any is missing.
#
# proxy_params sits in /src/nginx with the other two rather than going straight
# to /etc/nginx: render-config.sh writes the /etc/nginx copy, because with a
# platform proxy in front it has to change the X-Forwarded-For line
# (substitution 9). With REAL_IP_FROM unset it copies the file through
# unchanged, so the rendered result is byte-identical to this source.
COPY deploy/nginx/proxy_params               /src/nginx/proxy_params
COPY deploy/nginx/bhi-portal-headers.conf    /etc/nginx/snippets/bhi-portal-headers.conf
COPY deploy/nginx/bhi-portal.conf            /src/nginx/bhi-portal.conf
COPY deploy/nginx/bhi-portal-limits.conf     /src/nginx/bhi-portal-limits.conf

# Runs at container start, before nginx — this is why a rate-limit change needs
# only a restart. The 20- prefix places it after the image's own scripts.
COPY docker/nginx/render-config.sh /docker-entrypoint.d/20-render-config.sh
RUN chmod +x /docker-entrypoint.d/20-render-config.sh

# The built frontend, at the path the production config already expects.
COPY --from=build-web /repo/artifacts/bhi-card-portal/dist/public /var/www/bhi-portal

# Render purely so an invalid config fails the BUILD rather than the start.
# The runtime render then overwrites this with the real values.
#
# Loopback upstreams here, not service names: nginx resolves upstream host names
# at config-parse time, and no compose network exists during a build — `api`
# would simply not resolve and `nginx -t` would fail on a config that is
# perfectly correct. The ports still differ, so the substitution assertions in
# render-config.sh remain meaningful.
#
# BOTH shapes are checked, because one image serves both and a config error in
# either one would otherwise surface as a container that will not start — the
# hardest failure to read on a platform where you reach the logs after the fact.
# The proxy-fronted shape goes first so the default is what remains on disk.
RUN INBOX=off REAL_IP_FROM=169.254.0.0/16 API_UPSTREAM=127.0.0.1:3001 \
    /docker-entrypoint.d/20-render-config.sh \
 && nginx -t \
 && API_UPSTREAM=127.0.0.1:3001 MAIL_UPSTREAM=127.0.0.1:2526 \
    /docker-entrypoint.d/20-render-config.sh \
 && nginx -t

EXPOSE 80
