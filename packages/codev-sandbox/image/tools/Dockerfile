# Small helper image for rootfs->ext4 conversion and sparse-aware tarring;
# runs as root inside the container so file ownership survives, and gives the
# pipeline GNU tar + mkfs.ext4 -d regardless of the host OS.
FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241
RUN apt-get update && apt-get install -y --no-install-recommends e2fsprogs tar gzip \
  && rm -rf /var/lib/apt/lists/*
