# The firmware-bench image: the KubeCoder catalog's `bench` service, a sidecar in an environment's
# pod. It serves the page, the holder's WebSocket and the job images on 3520, and the agent API on
# 127.0.0.1:3521, which only the pod's own containers reach. It reads the build directories it
# flashes under /work and writes its log to /work/.bench, so its catalog entry mounts /work.
#
# Node 24 is the Node the frontend toolchain runs the suite on, and package.json's engines. The tag
# floats within that major, as the estate's base images do: the version-poller's scheduled rebuild
# then brings in the base's patches, which a digest would hold back. The lockfile carries the musl
# builds of the build stage's native packages (rolldown, lightningcss), so both stages are alpine.
FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:24-alpine

WORKDIR /app
# package.json comes along for its "type": "module", and the server finds its page beside it, in
# dist/page.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist

# No root needed. The pod's securityContext runs the container as the environment's uid, 1000,
# which is also `node` here, so the log it writes under /work is the agent's to read.
USER node

# The page. The agent API, 3521, listens on 127.0.0.1 only and is not exposed.
EXPOSE 3520

CMD ["node", "dist/node/server/main.js"]
