# SupOps — single-image build: API + Socket.IO + built SPA + SQLite, on one port.
#
# The backend runs .ts directly via tsx (no transpile step), so the runtime image
# keeps node_modules (incl. tsx) and the workspace source. The web app is built to
# apps/web/dist and served by the server. No local data or secrets are baked in --
# see .dockerignore; the container provisions its own on first run.

# ---- builder: install deps (native better-sqlite3) and build the SPA ----
FROM node:22-bookworm AS builder
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

# Install with the full workspace manifest set so npm resolves every workspace.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/eval/package.json packages/eval/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci

# kubectl, for Kubernetes cluster targets (reached straight through their API server).
# Checksum-verified; override the version with --build-arg KUBECTL_VERSION=v1.xx.y.
ARG KUBECTL_VERSION=v1.36.4
ARG TARGETARCH
RUN ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" \
  && curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl" \
  && echo "$(curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl.sha256")  /usr/local/bin/kubectl" | sha256sum -c - \
  && chmod +x /usr/local/bin/kubectl

COPY . .
RUN npm run build --workspace=@supops/web

# ---- runtime: slim image, prebuilt native module copied from the builder ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production SERVE_WEB=1
# openssl for first-run secret generation in the entrypoint; ping and traceroute
# for the read-only network checks advisory runs make (net_check).
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl iputils-ping traceroute \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/bin/kubectl /usr/local/bin/kubectl
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
# Backend source runs from .ts; migrations must be present (auto-applied on boot).
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/server ./apps/server
COPY --from=builder /app/apps/web/package.json ./apps/web/package.json
COPY --from=builder /app/apps/web/dist ./apps/web/dist
# The licence and attribution travel with every copy of the image.
COPY --from=builder /app/LICENSE /app/NOTICE ./
COPY docker/entrypoint.sh ./docker/entrypoint.sh
# Strip any CRLF (a Windows checkout can rewrite the script) and make it executable,
# so the shebang exec never fails with "no such file or directory".
RUN sed -i 's/\r$//' ./docker/entrypoint.sh && chmod +x ./docker/entrypoint.sh

EXPOSE 3001
VOLUME ["/app/data"]
# Invoke via /bin/sh explicitly rather than relying on the shebang, for robustness.
ENTRYPOINT ["/bin/sh", "/app/docker/entrypoint.sh"]
