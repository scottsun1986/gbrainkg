FROM node:22-bookworm-slim AS build

ENV CI=1
WORKDIR /app
RUN npm install --global pnpm@9.0.0

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/gbrain-adapter/package.json packages/gbrain-adapter/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
RUN pnpm install --frozen-lockfile
COPY apps/web apps/web
COPY packages packages
RUN pnpm --filter web build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN npm install --global pnpm@9.0.0
COPY --from=build /app /app
EXPOSE 3000
CMD ["pnpm", "--filter", "web", "start", "--", "--hostname", "0.0.0.0", "--port", "3000"]
