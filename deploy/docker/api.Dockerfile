FROM oven/bun:1 AS bun-runtime

FROM node:22-bookworm AS build

ARG GBRAIN_VERSION=0.47.6.0
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
RUN pnpm --filter database exec prisma generate --schema=prisma/schema.prisma \
  && pnpm --filter @llmwiki/shared-types build \
  && pnpm --filter @llmwiki/gbrain-adapter build \
  && pnpm --filter api build

FROM node:22-bookworm

ARG GBRAIN_VERSION=0.47.6.0
ENV NODE_ENV=production \
    PATH=/root/.bun/bin:$PATH \
    GBRAIN_BIN=/root/.bun/bin/gbrain
WORKDIR /app

RUN npm install --global pnpm@9.0.0

RUN mkdir -p /root/.bun/bin
COPY --from=bun-runtime /usr/local/bin/bun /root/.bun/bin/bun
RUN git clone --depth 1 --filter=blob:none --no-checkout --branch "v${GBRAIN_VERSION}" \
       https://github.com/garrytan/gbrain.git /opt/gbrain \
  && cd /opt/gbrain \
  && git sparse-checkout init --no-cone \
  && git sparse-checkout set /src /skills /templates /recipes /plugin-variants /scripts /package.json /bun.lock \
  && git checkout --detach \
  && cd /opt/gbrain \
  && /root/.bun/bin/bun install --frozen-lockfile \
  && ln -s /opt/gbrain/src/cli.ts /root/.bun/bin/gbrain

COPY --from=build /app /app
RUN mkdir -p /var/lib/llmwiki/brain_repos /var/lib/llmwiki/uploads /var/lib/llmwiki/gbrain-home

EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
