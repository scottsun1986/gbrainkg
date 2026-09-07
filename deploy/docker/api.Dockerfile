FROM oven/bun:1.3.5@sha256:e90cdbaf9ccdb3d4bd693aa335c3310a6004286a880f62f79b18f9b1312a8ec3 AS bun-runtime

FROM node:22-bookworm AS build

ARG GBRAIN_VERSION=0.47.6.0
ARG GBRAIN_COMMIT=3f2f300483bb24f97e0276f44ee3053b5d30a36b
ARG MCP_SDK_VERSION=1.29.0
ARG MCP_SDK_SHA512=zo37mZA9hJWpULgkRpowewez1y6ML5GsXJPY8FI0tBBCd77HEvza4jDqRKOXgHNn867PVGCyTdzqpz0izu5ZjQ==
ENV CI=1
WORKDIR /app

RUN npm install --global pnpm@9.0.0

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/gbrain-adapter/package.json packages/gbrain-adapter/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
RUN pnpm install --frozen-lockfile

COPY apps/api apps/api
COPY packages packages
RUN test ! -f /app/packages/database/.env && test ! -f /app/apps/api/.env
RUN pnpm --filter database exec prisma generate --schema=prisma/schema.prisma \
  && pnpm --filter @llmwiki/shared-types build \
  && pnpm --filter @llmwiki/gbrain-adapter build \
  && pnpm --filter api build

FROM node:22-bookworm

ARG GBRAIN_VERSION=0.47.6.0
ARG GBRAIN_COMMIT=3f2f300483bb24f97e0276f44ee3053b5d30a36b
ARG MCP_SDK_VERSION=1.29.0
ARG MCP_SDK_SHA512=zo37mZA9hJWpULgkRpowewez1y6ML5GsXJPY8FI0tBBCd77HEvza4jDqRKOXgHNn867PVGCyTdzqpz0izu5ZjQ==
ENV NODE_ENV=production \
    PATH=/root/.bun/bin:$PATH \
    GBRAIN_BIN=/root/.bun/bin/gbrain
WORKDIR /app

RUN npm install --global pnpm@9.0.0

RUN mkdir -p /root/.bun/bin
COPY --from=bun-runtime /usr/local/bin/bun /root/.bun/bin/bun
RUN curl --fail --location --retry 5 --retry-all-errors \
       "https://codeload.github.com/garrytan/gbrain/tar.gz/${GBRAIN_COMMIT}" \
       --output /tmp/gbrain.tar.gz \
  && mkdir -p /opt/gbrain \
  && tar -xzf /tmp/gbrain.tar.gz --strip-components=1 -C /opt/gbrain \
  && test "$(node -p "require('/opt/gbrain/package.json').version")" = "${GBRAIN_VERSION}" \
  && cd /opt/gbrain \
  && /root/.bun/bin/bun install --frozen-lockfile \
  && if [ ! -f node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js ]; then \
       curl --fail --location --retry 5 --retry-all-errors \
         "https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-${MCP_SDK_VERSION}.tgz" \
         --output /tmp/mcp-sdk.tgz; \
       test "$(openssl dgst -sha512 -binary /tmp/mcp-sdk.tgz | openssl base64 -A)" = "${MCP_SDK_SHA512}"; \
       rm -rf node_modules/@modelcontextprotocol/sdk; \
       mkdir -p node_modules/@modelcontextprotocol/sdk; \
       tar -xzf /tmp/mcp-sdk.tgz --strip-components=1 -C node_modules/@modelcontextprotocol/sdk; \
     fi \
  && ln -s /opt/gbrain/src/cli.ts /root/.bun/bin/gbrain \
  && /root/.bun/bin/gbrain --version \
  && rm -f /tmp/gbrain.tar.gz /tmp/mcp-sdk.tgz

COPY --from=build /app /app
RUN node -e "const a=require('/app/apps/api/node_modules/@firecrawl/anydoc'); if(typeof a.toMarkdown !== 'function') process.exit(1)"
RUN mkdir -p /var/lib/llmwiki/brain_repos /var/lib/llmwiki/uploads /var/lib/llmwiki/gbrain-home

EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
