# syntax=docker/dockerfile:1
# Build BottleShip and serve it (COOP/COEP + Range) with deploy/server.ts.
# Requires the vendor/v86 submodule: git submodule update --init
# CI publishes this image for each release as ghcr.io/ievans/bottleship (CONTRIBUTING.md, "Releases").

# The frontend builds on the build platform only: its output is static JS/WASM, the same for every
# architecture, so a multi-arch build does not run Vite under emulation. `bun run build` downloads
# the .wasm files CI published for tools/build-wasm/wasm.lock.json, so no wasm toolchain is needed.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile && bun run build

FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a
WORKDIR /app
COPY --from=build /src/dist ./dist
COPY deploy/server.ts deploy/wgb-etag.ts ./deploy/
ENV NODE_ENV=production PORT=5173 BS_DIST_DIR=/app/dist BS_APPS_DIR=/apps
USER bun
VOLUME /apps
EXPOSE 5173
HEALTHCHECK CMD wget -q -O- http://127.0.0.1:5173/healthz || exit 1
CMD ["bun", "/app/deploy/server.ts"]
