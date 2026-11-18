# Guest image for the codev sandbox: one Debian rootfs consumed by all
# backends (bwrap tar, vz ext4 disk, later wsl --import tar).
# Built by script/build-image.ts via docker buildx; TARGETARCH is amd64|arm64.

FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241 AS base
ARG DEBIAN_FRONTEND=noninteractive
# Base toolchain: node/git/socat/ca-certs always; python + build tools + the
# CLI set per the sandbox plan. iproute2 is needed by the vz init (loopback).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl wget git unzip zip jq ripgrep sqlite3 socat iproute2 nftables busybox-static \
    procps less vim-tiny openssh-client \
    python3 python3-pip python3-venv python3-dev \
    build-essential pkg-config \
  && rm -rf /var/lib/apt/lists/*
ARG TARGETARCH
# Track the Node major Electron embeds (Electron 42 = Node 24): the guest runs
# the same server bundle as the desktop sidecar, and the bundle uses node:sqlite
# APIs (StatementSync.setReturnArrays) that Node 22 does not have — under 22
# every DB-touching route fails while /global/health still passes.
ARG NODE_VERSION=v24.19.0
RUN set -eux; \
  case "$TARGETARCH" in amd64) NODE_ARCH=x64 ;; arm64) NODE_ARCH=arm64 ;; *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; esac; \
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1; \
  node --version
RUN useradd --create-home --shell /bin/bash --uid 1000 codev
# The server bundle (mounted at /opt/codev) is ESM with two externals; ESM
# resolution walks parent dirs, so /opt/node_modules serves them without
# touching the host bundle. @lydell/node-pty resolves its native prebuild for
# this arch via optionalDependencies.
RUN cd /opt && npm install --no-save --no-audit --no-fund jsonc-parser @lydell/node-pty \
  && rm -f /opt/package.json /opt/package-lock.json

# Office layer: the codev-office skill dependencies (dotnet/pandoc/libreoffice/
# python packages/node module trees/skills), system-wide instead of per-user
# because sandbox homes are fresh. Skipped when OFFICE=0.
FROM base AS office
ARG OFFICE=1
# Bind-mounted, not COPYed: the bundle is well over a gigabyte, and a COPY
# would commit all of it to a layer that the install step cannot delete again.
RUN --mount=type=bind,source=office,target=/office \
  if [ "$OFFICE" = "1" ]; then bash /office/install-office.sh /office/bundle; fi

# Guest layer: the vz init (PID 1) and the mount points every backend expects.
# Harmless in the bwrap/wsl tars.
FROM office AS guest
COPY guest/codev-init /sbin/codev-init
COPY guest/server-launch.mjs /opt/codev-guest/server-launch.mjs
RUN chmod 755 /sbin/codev-init && mkdir -p /workspace /opt/codev /codev-config
