# syntax=docker/dockerfile:1
# Build BottleShip and serve it (COOP/COEP + Range) with deploy/server.ts.
# Requires the vendor/v86 submodule: git submodule update --init
FROM oven/bun:1.2.22@sha256:66ba69deede44e3af5dc542def218fdb3bcad2205900ea761dc5623bf973d2df AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile && bun run build

FROM oven/bun:1.2.22-alpine@sha256:ab596b6d0dcad05d23799b89451e92f4cdc16da184a9a4d240c42eaf3c4b9278
WORKDIR /app
COPY --from=build /src/dist ./dist
COPY deploy/server.ts deploy/wgb-etag.ts deploy/lan-relay.ts ./deploy/
COPY src/net/lan-protocol.ts ./src/net/lan-protocol.ts
ENV NODE_ENV=production PORT=5173 BS_DIST_DIR=/app/dist BS_APPS_DIR=/apps
USER bun
VOLUME /apps
EXPOSE 5173
HEALTHCHECK CMD wget -q -O- http://127.0.0.1:5173/healthz || exit 1
CMD ["bun", "/app/deploy/server.ts"]
