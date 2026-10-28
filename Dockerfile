# syntax=docker/dockerfile:1
# Build BottleShip and serve it (COOP/COEP + Range) with deploy/server.ts.
# Requires the vendor/v86 submodule: git submodule update --init
FROM oven/bun:1.2.22 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile && bun run build

FROM oven/bun:1.2.22-alpine
WORKDIR /app
COPY --from=build /src/dist ./dist
COPY deploy/server.ts deploy/wgb-etag.ts deploy/lan-relay.ts ./deploy/
COPY src/net/lan-protocol.ts ./src/net/lan-protocol.ts
ENV NODE_ENV=production PORT=5173 BS_DIST_DIR=/app/dist BS_APPS_DIR=/apps
VOLUME /apps
EXPOSE 5173
HEALTHCHECK CMD wget -q -O- http://127.0.0.1:5173/healthz || exit 1
CMD ["bun", "/app/deploy/server.ts"]
