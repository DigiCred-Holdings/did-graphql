# Build from the REPO ROOT, not this directory — the example imports
# client/server/test as TS source via relative paths
# (../../client/src/..., ../../server/src/..., ../../test/helpers/...),
# so the build context needs all of them:
#
#   docker build -f examples/case-manager/Dockerfile -t case-manager .
#   docker run --rm -p 4321:4321 case-manager
#   docker run --rm -p 4321:4321 -e CONTROLLER_SEED=whatever-you-like case-manager

# node:*-alpine will NOT work here: @openwallet-foundation/askar-nodejs
# ships a prebuilt native library (not compiled from source at install
# time) that's dynamically linked against glibc — confirmed with
# `ldd`, it pulls in libc.so.6/ld-linux-x86-64.so.2. Alpine's musl libc
# can't load it. Use a Debian-based image instead.
FROM node:22-slim

WORKDIR /app

# @2060.io/ref-napi (a transitive dep of askar-nodejs, for its FFI
# bindings) has no prebuilt binary for every platform/Node combo and
# falls back to compiling from source via node-gyp — which needs
# Python + a C++ toolchain, neither present in the plain slim image.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Only the repo root's own package.json/node_modules matter — the
# example never imports client/server through their own published
# packages (@digicred/did-graphql-client / -server), only through
# relative paths straight to their .ts source, which tsx resolves
# directly. client/ and server/'s own package.json/node_modules (for
# building THEIR OWN dist/) are irrelevant to running this and
# deliberately not copied in.
COPY package*.json ./
RUN npm ci

COPY client/src ./client/src
COPY server/src ./server/src
COPY test ./test
COPY examples ./examples

ENV PORT=4321
EXPOSE 4321

CMD ["npx", "tsx", "examples/case-manager/server.ts"]
