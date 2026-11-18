# @codev/sandbox

The desktop sandbox: an isolated environment (VM or container) that runs the
whole codev sidecar server, so model-driven tools and skills execute away from
the host. A ready sandbox appears in the desktop app as an ordinary server
connection (`sandbox:<name>`), under the **Work** side of the sidebar.

Runtime code sticks to Node APIs (no Bun-only calls) so it runs inside the
Electron main process.

## Platform core

- `provider.ts` — the `SandboxProvider` contract every backend implements:
  `availability` / `create` / `start` / `destroy` / `reset`, plus the optional
  `applyMounts` hot path. Also the persisted `SandboxConfig` shape (project
  dir, extra mounts, per-sandbox cpu/memory limits) and its validation.
- `controller.ts` — lifecycle state machine: runtime states, the job queue,
  stale-start guards. Create, reset and destroy run **one at a time across all
  sandboxes** — not for the sandboxes' sake, but because create and reset stage
  images through one shared cache whose resumable-download bookkeeping assumes
  a single writer. Jobs queue rather than supersede, so a job on one sandbox
  can never abort another sandbox's half-downloaded image; only a second job
  for the _same_ sandbox supersedes the first. `initialize()` starts every
  persisted sandbox except the ones the user stopped — stopping is a decision,
  so it persists in the config and survives a relaunch, and only an explicit
  start clears it.
- `policy.ts` — OS version gates: hard block below macOS 12, tiered
  warn-never-block on Windows, always-supported on Linux.
- `manifest.ts` / `image.ts` — pinned manifest parsing and content-addressed,
  SHA-256-verified staging of guest images and the mirrored WSL installer.
  Downloads resume across retries and across calls (images are hundreds of MB
  and storage hosts cut long transfers), and report progress for the UI.
- `broker.ts` — the sandbox's only egress path: a host-side proxy that forwards
  exclusively to configured upstreams (default: the LLM gateway), authenticated
  with a per-start shared secret. Guests have no network device; there is no
  full-outbound mode. Extra upstreams are an admin-editable allowlist of named
  rules, never a general proxy.
- `boot.ts` — the guest boot contract shared by every backend (credentials,
  env, serve args, health polling). Two of those env entries exist because a
  guest is not a normal machine: `CODEV_SQLITE_SYNCHRONOUS=FULL`, because
  stopping a sandbox cuts its power and the server's default WAL +
  `synchronous=NORMAL` only survives a crashed process, not a machine that
  disappears; and `CODEV_DISABLE_CHANNEL_DB=1`, because a dev build takes its
  channel from the host repo's current branch, which otherwise re-keyed the
  guest's whole database every time the host changed branch.
- `mounts.ts` — guest paths for extra host folders (`/mnt/<name>` on vz/bwrap,
  the wslpath translation on WSL) and the structural validation shared with the
  desktop IPC handler.
- `socket.ts` / `const.ts` — AF_UNIX-safe socket dirs, and the pinned storage
  URLs for images and the mirrored WSL installer.

## Backends

### macOS — `vz/` + `native/vzhelper`

- `native/vzhelper` — `codev-vmm`, a small Swift helper (SwiftPM, macOS 12+)
  that boots one Linux VM via Virtualization.framework: VZLinuxBootLoader
  (kernel + optional initrd + virtio disk), virtio-fs shares, guest serial
  console on stderr, and **no network device** — the guest's only egress is
  vsock, which the helper bridges to host unix sockets (host-to-guest for the
  server path, guest-to-host for the broker path). Build with
  `bun run build:vzhelper` (`--universal` for arm64+x86_64); dev builds are
  ad-hoc signed with the `com.apple.security.virtualization` entitlement,
  release packaging re-signs with the app identity.
- `vz/protocol.ts` — the helper wire protocol: VmConfig JSON in,
  newline-delimited state/error events out.
- `vz/provider.ts` — availability gates on macOS 12+ and helper presence;
  `create` unpacks the vz image tarball (`vmlinux` + `initrd` + `rootfs.img`)
  and clones the instance disk copy-on-write (APFS clonefile); `start` writes
  the guest `boot.json` and `mounts.json` (credentials, serve args, extra
  mounts, shared read-only via the `config` virtio-fs tag), waits for the
  helper's `running` event, then reuses the TCP→unix forwarder and health gate;
  `reset` re-clones the pristine disk, re-provisioning first when the manifest
  has moved on — which makes reset the image-upgrade path.

### Windows — `wsl/`

- `wsl/provider.ts` — a managed distro per sandbox (`wsl --import` of the same
  rootfs tarball bubblewrap uses; WSL brings its own kernel). The host bundle
  is bind-mounted in, so version parity with the app is automatic. Every
  `wsl.exe` call is bounded by a timeout, with longer budgets for import and
  unregister. This is the one backend that implements `applyMounts`: the
  distro's mount namespace is shared and automounted drives need no guest work,
  so mounts apply without a restart.
- `wsl/firewall.ts` — the egress firewall. WSL2 distros share one utility VM,
  one network namespace and one IP, so the guest is not NIC-less and host-side
  Hyper-V rules cannot target a single distro. Enforcement is instead nftables
  inside the shared guest kernel, matching a cgroup v1 `net_cls` classid the
  boot script gives this sandbox's process tree: loopback and the host broker
  endpoint are allowed, everything else is rejected. Fail-closed — a guest that
  cannot set the rules up refuses to start rather than run open. The file
  documents the residual shared-loopback exposure.
- `wsl/cli.ts` — `wsl.exe` invocation, distro list parsing, and loopback port
  reservation (all WSL2 distros share one loopback, so both the server port and
  the guest broker stub port are reserved per sandbox rather than fixed).

### Linux — `bwrap/`

- `bwrap/args.ts` — the bubblewrap invocation: unshared user/pid/net/uts/ipc
  namespaces (loopback-only networking), read-only rootfs binds with merged-usr
  symlinks preserved, workspace rw at `/workspace`, server bundle ro at
  `/opt/codev`, per-sandbox home, cleared env, and `--seccomp` on an inherited
  fd carrying the syscall filter.
- `seccomp/` — the syscall filter. Namespaces decide what the guest can see;
  this decides what it can say to the shared host kernel, which is the wall a
  container backend lacks and a VM has for free. `policy.ts` is the data: a
  strict allowlist derived from Docker's default profile minus everything that
  profile only grants to a capability the guest happens to hold inside its user
  namespace, an escalation set that kills the caller (bpf, perf_event_open,
  userfaultfd, module loading, kexec, the key syscalls), and the argument rules
  — `clone`/`unshare` asking for a new user namespace is fatal, any other new
  namespace is refused, and `socket` is limited to AF_UNIX, AF_INET, AF_INET6
  and route netlink. `bpf.ts` compiles that into classic BPF on the host at
  every start (no libseccomp, no native dependency, no separately versioned
  blob); the program is written to `runtime/seccomp.bpf` and handed to bwrap
  as stdio slot 3. Unlisted syscalls get EPERM, or ENOSYS from the unified
  numbering (424) up so libc fallbacks like clone3 → clone keep working. Three
  modes: `enforce` (default), `audit` (the kernel logs what enforce would
  refuse; nothing is blocked), `off`. The desktop's machine-wide default comes
  from `CODEV_SANDBOX_SECCOMP`; a persisted per-sandbox `seccomp` field wins
  over it. `syscalls-{x64,arm64}.ts` are generated from the kernel headers by
  `script/gen-syscall-tables.ts`; `docs/seccomp.md` has the design history.
- `bwrap/bridge.ts` — how TCP crosses the guest's network namespace: unix
  sockets in the shared `/run/codev` dir, with a host-side TCP→unix forwarder
  (also used by the vz backend) and a guest-side node forward script for the
  server and broker paths.
- `bwrap/rootfs.ts` — image unpack (tar) and rootfs layout probing.
- `bwrap/provider.ts` — availability probe (detects the Ubuntu 23.10+ AppArmor
  userns restriction), create/start/destroy/reset, health-gated startup with
  stderr capture, seccomp program generation per start.

`bwrap.integration.test.ts` exercises real bubblewrap — including the seccomp
filter: ordinary work passes, `mount` is refused, `unshare -U` dies with
SIGSYS — and auto-skips where bwrap can't run (macOS, restricted CI runners). Packaging note: the .deb should
ship an AppArmor profile permitting unprivileged user namespaces on Ubuntu
24.04+.

## Image pipeline

`image/` builds every backend's guest from one Debian rootfs, fully
containerized (any machine with Docker):

- `image/Dockerfile` — base toolchain (node 22, python3 + pip/venv,
  build-essential, git, ripgrep/jq/sqlite3/curl/unzip, socat, iproute2) plus
  the optional office layer: `image/office/install-office.sh` translates the
  codev-office setup script system-wide — pandoc + LibreOffice + fonts from
  Debian, .NET 8 SDK at `/opt/dotnet`, the pinned Python package set, the
  bundle's node-module trees (pure-JS ones verbatim; sharp's native binary
  re-resolved for the guest arch) reachable three ways — `NODE_PATH`,
  `~/.node_modules` via skel, and `/usr/local/lib/node`, the one that needs
  neither the environment nor `$HOME` — and the office skills at
  `/opt/codev-skills` with an `/etc/skel` codev.json pointing at them. Fresh
  sandbox homes get skel (vz at image build; bwrap seeded by the boot script),
  and images declare extra env in `/etc/codev-guest.env`.
- `image/guest/codev-init` — the vz guest's PID 1: mounts the virtio-fs tags
  (including the extra mounts listed in `mounts.json`), runs the socat vsock
  bridges (4096 server / 8788 broker, host CID 2), and runs the launcher per
  `boot.json`; powers off (busybox) when it dies.
- `image/guest/server-launch.mjs` — the boot entrypoint every backend runs. The
  bundle's `node.js` is a library module (exports `Server`), not a CLI, so the
  launcher imports it and calls `Server.listen({...})` with the env-provided
  credentials/host/port — exactly what the desktop sidecar does. Baked at
  `/opt/codev-guest/server-launch.mjs`; `/opt/node_modules` holds the two
  externalized deps (`jsonc-parser`, `@lydell/node-pty`) so the host bundle
  needs nothing added.
- `image/kernel/` — a minimal pinned kernel (6.6 LTS) with virtio
  blk/fs/vsock/console + ext4 compiled in: no initrd, no modules, no network
  drivers. Cached by Docker layers after the first build.
- `script/build-image.ts` — orchestrates buildx → rootfs tar → ext4 disk
  (`mkfs.ext4 -d`, no root needed) → kernel → `vz-<arch>.tar.gz` /
  `bwrap-<arch>.tar.gz` → `manifest.json` (validated against `src/manifest.ts`
  before writing). `--office-bundle` stages the arch-independent parts of
  codev-office-ubuntu.zip; binaries are fetched arch-correct inside the build.
  Build each arch on a native host — x64 under emulation works but is slow.
- `script/publish-image.ts` — uploads artifacts first, `manifest.json` last
  (clients never see a version whose artifacts aren't in place), via `mc` when
  `CODEV_STORAGE_TARGET` is set, otherwise prints the commands. The destination
  key is derived from the same constant clients read, so a prefix move cannot
  update one side only.
- `script/e2e-vz.ts` / `script/e2e-wsl.ts` — boot a locally built image through
  the real backend and wait for the authenticated health check: the full-stack
  smoke tests.

The guest image contract for vz: init must mount the `workspace` / `bundle` /
`config` virtio-fs tags, read `/…/config/boot.json`, run the launcher with its
env, and bridge vsock port 4096 to the server's TCP port and TCP port 8788 to
vsock (e.g. via socat) for the broker.

## Where the rest lives

This package is platform code only; the desktop app owns everything user-facing.

- `packages/desktop/src/main/sandbox/` — `controller.ts` (picks the platform
  provider, persists configs), `ipc.ts` (the `sandbox-*` channels), `egress.ts`
  (broker routes, gateway credentials, the injected guest config — including
  the gateway's model catalogue, cached per credential set in
  `gateway-models.ts`), `bundle.ts` (the mounted server bundle).
- `packages/app/src/sandbox/` — the UI: add dialog, mounts dialog, settings
  rows, and the per-mount project seeding.
- `packages/desktop/src/renderer/sandbox/` — ready sandboxes as server
  connections.

## Known gaps

- **Stopping a sandbox is a power cut.** `native/vzhelper` calls
  `VZVirtualMachine.stop()`, which Apple documents as pulling the power cable;
  the guest never syncs. Durable SQLite commits cover the server's own data,
  but anything else the guest wrote to its disk in the last seconds is still
  lost. A graceful path — the helper asking the guest to power down, the guest
  syncing and powering off — needs a listener in the image and is worth doing
  the next time the image is rebuilt.
- **Image upgrades are manual.** Reset re-provisions from the current manifest,
  but nothing surfaces that a newer image exists, so guests stay stale until
  the user happens to reset.
- **The seccomp allowlist has not been through an audit phase.** It ships in
  enforce mode on the strength of Docker's profile and the workloads the
  integration and smoke tests cover (node dev servers, child processes,
  workers, file watching, git, python sockets). A tool that trips it fails with
  EPERM/ENOSYS or SIGSYS; `CODEV_SANDBOX_SECCOMP=audit` turns those into kernel
  log lines (`dmesg | grep SECCOMP`, or auditd) for widening the list, and `off`
  removes the filter. No UI exposes the mode yet.
- **The WSL backend has no syscall filter.** It boots the same rootfs but not
  through bwrap; installing the same program there needs a guest-side loader in
  the boot script.
