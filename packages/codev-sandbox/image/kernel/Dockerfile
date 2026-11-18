# Minimal sandbox guest kernel: virtio blk/fs/vsock/console + ext4 compiled
# in, no modules, no initrd, no network drivers. Built per-arch by
# script/build-image.ts; docker layer caching makes rebuilds cheap unless
# KERNEL_VERSION or the fragment changes.
FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241 AS build
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential bc bison flex libssl-dev libelf-dev python3 curl xz-utils kmod cpio ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ARG KERNEL_VERSION=6.6.100
WORKDIR /src
RUN curl -fsSL "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-${KERNEL_VERSION}.tar.xz" | tar -xJ --strip-components=1
COPY codev.config /src/codev.config
RUN make defconfig \
  && scripts/kconfig/merge_config.sh -m .config codev.config \
  && make olddefconfig
RUN make -j"$(nproc)" $(case "$(uname -m)" in aarch64) echo Image ;; x86_64) echo bzImage ;; esac)
# Normalize the artifact name; the vz provider expects "vmlinux".
RUN mkdir /out && cp "$(case "$(uname -m)" in aarch64) echo arch/arm64/boot/Image ;; x86_64) echo arch/x86/boot/bzImage ;; esac)" /out/vmlinux

FROM scratch AS artifact
COPY --from=build /out/vmlinux /vmlinux
