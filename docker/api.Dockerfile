# syntax=docker/dockerfile:1.7
#
# API server and the local delivery sink, built from source.
#
# Three ideas hold this file together:
#
#   1. The dependency layer is keyed ONLY on the files that decide the dependency
#      graph — the lockfile, the workspace file, and every package.json. Editing
#      source never reinvalidates it, which is what keeps the rebuild cycle short
#      (FR-042, SC-013).
#
#   2. The build runs on Linux, so the workspace's `sh`-syntax scripts execute in
#      the shell they were written for and no host toolchain is involved at all
#      (FR-038, FR-039).
#
#   3. The runtime stage carries the bundle and nothing else. esbuild produces a
#      self-contained bundle — deploy/api/package.json, the shipped equivalent,
#      declares no dependencies — so there is no node_modules in the final image.
#
# Targets: `api` (the server), `mail` (the local delivery sink), `sms` (the
# Twilio/Vonage gateway adapter).

ARG NODE_VERSION=22-bookworm-slim


# ---------------------------------------------------------------------------
# deps — install the workspace once
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true

# The repository pins no packageManager, so pin pnpm here. 10.x is required:
# pnpm-workspace.yaml uses `minimumReleaseAge` (10.16+) and `onlyBuiltDependencies`.
RUN corepack enable && corepack prepare pnpm@10.18.0 --activate

WORKDIR /repo

# Only dependency-graph inputs. Order matters for cache reuse.
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
# build-api — esbuild bundle
# ---------------------------------------------------------------------------
FROM deps AS build-api

# The workspace libraries export TypeScript source directly (lib/db exports
# ./src/index.ts), so esbuild bundles them from source and no library build
# step is needed first.
# tsconfig.base.json is required, not optional: the root tsconfig extends
# ./tsconfig.base.json and every package tsconfig extends ../../tsconfig.base.json.
# esbuild only warns when it is missing, so the API bundle would still build — but
# it would build with the wrong compiler options, silently.
COPY tsconfig.json tsconfig.base.json ./
COPY lib/ lib/
COPY artifacts/api-server/ artifacts/api-server/

RUN pnpm --filter @workspace/api-server run build


# ---------------------------------------------------------------------------
# api — runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS api

ENV NODE_ENV=production
WORKDIR /app

# The bundle plus the pino transport files esbuild-plugin-pino emits beside it.
COPY --from=build-api --chown=node:node /repo/artifacts/api-server/dist ./dist

USER node
EXPOSE 3001

CMD ["node", "--enable-source-maps", "dist/index.mjs"]


# ---------------------------------------------------------------------------
# mail — local verification-code sink
# ---------------------------------------------------------------------------
# A real SMTP server and a real webhook endpoint that capture messages instead of
# forwarding them, so the API's genuine delivery code runs against them. Uses only
# Node built-ins (node:net, node:http) — no dependencies, no build.
FROM node:${NODE_VERSION} AS mail

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node deploy/local-delivery.mjs ./local-delivery.mjs

USER node
EXPOSE 2525 2526

CMD ["node", "local-delivery.mjs"]


# ---------------------------------------------------------------------------
# sms — SMS gateway adapter
# ---------------------------------------------------------------------------
# The last mile between the API and a carrier. The API posts {to, body} here;
# this normalises the number to E.164 and hands it to Twilio or Vonage over
# their REST APIs. Built on the same idea as the `mail` target: only Node
# built-ins (node:http, node:crypto), so no dependencies and no build.
#
# Unlike `mail` this one really does send, and really does cost money — which is
# why the provider defaults to `dryrun` in the script and has to be turned on by
# name.
FROM node:${NODE_VERSION} AS sms

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node deploy/sms-gateway.mjs ./sms-gateway.mjs

USER node
EXPOSE 2527

CMD ["node", "sms-gateway.mjs"]
