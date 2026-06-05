# syntax=docker/dockerfile:1
#
# Multi-Stage build for the agentic-knowledge MCP server (@codemcp/knowledge-server).
#
# The server talks JSON-RPC over stdio. Run it with `docker run -i`, mounting a
# working directory that contains `.knowledge/config.yaml`:
#
#   docker run -i --rm -v "$PWD:/workspace" agentic-knowledge-mcp:latest
#
# Design notes: see docs/docker-deployment-design.md
#  - pnpm monorepo; tsup bundles core + content-loader into mcp-server/dist, so the
#    only runtime node_modules are the externals @modelcontextprotocol/sdk + adm-zip.
#  - `init_docset` clones git repos via `execSync("git ...")` -> the runtime image
#    MUST ship the `git` binary and have network egress.
#  - The working dir is mounted READ-WRITE (docsets are downloaded/cached there).

# ---- Build stage: install workspace, compile, produce a pruned prod deploy ----
FROM node:22-alpine AS build
WORKDIR /app

# pnpm via corepack, pinned to the version from the root package.json.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

# `prepare: husky` would fail without a .git dir; disable it for the image build.
ENV HUSKY=0

# Install deps from the lockfile. Copy only manifests first for layer caching.
# Do NOT use --ignore-scripts: esbuild (via tsup) needs its postinstall.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/core/package.json            packages/core/package.json
COPY packages/content-loader/package.json  packages/content-loader/package.json
COPY packages/mcp-server/package.json      packages/mcp-server/package.json
COPY packages/cli/package.json             packages/cli/package.json
RUN pnpm install --frozen-lockfile

# Sources + build config, then build the whole workspace (turbo -> tsup/tsc).
COPY tsconfig.base.json tsconfig.build.json tsconfig.json turbo.json ./
COPY packages/ ./packages/
RUN pnpm run build

# Flatten the symlinked pnpm node_modules into a real, prod-only directory.
# /deploy then holds the mcp-server `dist` + its externals (sdk, adm-zip).
# --legacy: pnpm v10 otherwise refuses to deploy non-injected workspaces.
RUN pnpm --filter=@codemcp/knowledge-server deploy --prod --legacy /deploy

# ---- Runtime stage: node + git + the deployed server ----
FROM node:22-alpine

ARG VERSION=0.0.0-dev
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="agentic-knowledge-mcp" \
      org.opencontainers.image.description="MCP server for agentic knowledge guidance (search_docs/list_docsets/init_docset)" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.source="https://github.com/mrsimpson/agentic-knowledge-mcp" \
      org.opencontainers.image.licenses="MIT"

# `git` is required at runtime: init_docset clones docsets via execSync("git ...").
RUN apk add --no-cache git

# Server code + runtime deps (sdk, adm-zip) produced by `pnpm deploy`.
COPY --from=build /deploy /app

# The server discovers `.knowledge/config.yaml` by walking up from cwd and writes
# downloaded docsets relative to it. /workspace is the read-write mount point.
WORKDIR /workspace

# Run unprivileged. NOTE: the mounted /workspace volume must be writable by uid 1000.
USER node

# stdio transport — `docker run -i` keeps stdin open for JSON-RPC.
ENTRYPOINT ["node", "/app/dist/bin.js"]
