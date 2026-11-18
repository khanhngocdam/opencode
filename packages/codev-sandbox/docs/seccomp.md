# Adding a seccomp BPF filter to the bubblewrap sandbox

Status: implemented (`src/seccomp/`, `bwrap/args.ts`, `bwrap/provider.ts`) — see
"What shipped" at the end for where the implementation departs from the plan
below. The rest of this document is the original design, kept for the
reasoning.
Scope: Linux `bwrap` backend (and, by reuse, the Windows WSL backend that boots the same rootfs)
Owner: TBD

## Problem

The `bwrap` backend isolates the guest with namespaces only
(`args.ts:51–64`: `--unshare-user/pid/net/uts/ipc`). Namespaces control what the
guest can _see_; they do nothing to reduce what it can _say to the host kernel_.
Because a user-namespace sandbox shares the host kernel, every one of the ~350
syscalls is reachable attack surface, and a single kernel LPE inside the guest is
a full host escape with no second wall behind it. This is the gap that a hypervisor
backend (`vz`) does not have and that `bwrap` structurally does.

Anthropic's own Linux sandbox (`sandbox-runtime`) pairs bubblewrap with a seccomp
BPF filter for exactly this reason. This doc plans the equivalent for CoDev.

Non-goals: this does not add cgroup resource limits, does not change the egress
broker, and does not touch the `vz` backend (a VM already bounds the syscall
surface at the hypervisor). It also is not a substitute for the unfinished
AppArmor-userns profile noted in `README.md:112–115` — that is orthogonal
(it governs whether bwrap can start at all on Ubuntu 24.04+).

## Decisions taken

- **Policy posture: strict allowlist (srt-style)**, default-deny with an enumerated
  set of permitted syscalls — the strongest posture, reached via an audit-first
  rollout (see Phasing). Not a Docker-style denylist.
- **Filter delivery: precompiled per-arch BPF blobs**, built in CI with a small
  libseccomp-based tool, shipped as assets and handed to bwrap via a file
  descriptor. No native dependency added to the Electron app.
- **Because bwrap has no audit flag**, audit vs enforce is encoded in the BPF
  return action (`SECCOMP_RET_LOG` vs `SECCOMP_RET_ERRNO`). That means **two blobs
  per arch per policy version** (`audit`, `enforce`), for `x64` and `arm64`.

## How bwrap consumes the filter

bwrap reads a _precompiled_ classic-BPF program from a file descriptor and installs
it on the guest just before `exec`. Two flags exist:

- `--seccomp N` — install exactly one program from fd `N`.
- `--add-seccomp-fd N` — additive; requires bwrap ≥ 0.5.0.

We use `--add-seccomp-fd` (additive form is future-proof if we later split policies)
and gate on a capability probe (below). Crucially, bwrap installs the program
_itself_, so we do **not** need a guest-side shim, a libseccomp binding in the app,
or any change to the inline boot script. The guest already runs under
`--unshare-user`, so `no_new_privs` is set and the filter installs unprivileged.

The fd is passed by extending the spawn `stdio` array. Today the spawn is:

```
spawnImpl(bwrap, buildBwrapArgs({...}), { stdio: ["ignore", "ignore", "pipe"] })
```

(`provider.ts:153–174`). Node maps `stdio` index 3 to child fd 3, and accepts a
raw open fd number in that slot. So we open the blob read-only in the parent, place
its fd at index 3, and pass `--add-seccomp-fd 3`. No pipe, no write race — the blob
is a static file, and bwrap reads it fully at startup.

## Change map (files and anchors)

### 1. Filter source + build tool (new)

- `packages/codev-sandbox/seccomp/policy.ts` — the single source of truth:
  the allowlisted syscall names, grouped and commented by why each is needed
  (core libc/runtime, Node/libuv + `io_uring` for Bun-free Node 22, threads/futex,
  file & dir ops, process spawn for the agent's own tools, the `socket` family
  **restricted to `AF_UNIX`** so loopback dev servers work but raw network cannot,
  signal handling). This file is data, consumed by the build tool; it never runs
  in the app.
- `packages/codev-sandbox/seccomp/build-seccomp.rs` (or a tiny Rust crate under
  `seccomp/`) — uses `libseccomp` to compile `policy.ts`'s list into raw BPF for
  a target arch and return action, emitting `bwrap-seccomp-<arch>-<mode>.bpf`.
  Rust chosen over C for reproducible CI builds and because libseccomp's Rust
  binding handles the multi-arch/compat-ABI details (`x86_64` vs x32, arm64
  native) that a hand-rolled cBPF assembler gets wrong. Default action
  `SCMP_ACT_ERRNO(EPERM)` for enforce, `SCMP_ACT_LOG` for audit; explicitly
  `SCMP_ACT_KILL_PROCESS` for the hard-block set (`unshare` of new userns,
  `keyctl`, `add_key`, `bpf`, `init_module`/`finit_module`, `ptrace`,
  `userfaultfd`, `perf_event_open`, `kexec_load`/`kexec_file_load`) — these are
  the SharedRoot-class escalation primitives and should die loudly, not return
  an errno a program might paper over. Note `socket` is allowlisted only with an
  `AF_UNIX` argument filter; `AF_INET`/`AF_INET6`/`AF_NETLINK` fall through to
  the default deny.

### 2. CI + manifest

- `packages/codev-sandbox/script/build-image.ts` — extend `describeAsset`
  (`:207–219`) / the arch loop (`collectArchs`, `:171–175`) to also produce the four
  blobs and record them. Follow the `manifestImageKey` convention
  (`manifest.ts:64–66`): new keys `bwrap-seccomp-<arch>-<mode>` in `images`, using
  the existing `SandboxAsset {url, sha256, bytes}` shape (`manifest.ts:3–7`) so
  `parseAsset` validation (`:107–117`) applies unchanged. The blobs are tiny
  (hundreds of bytes) but versioning them with the image keeps policy and rootfs
  in lockstep — a rootfs that adds a tool needing a new syscall ships with the
  matching filter. Alternative rejected: shipping blobs in `electron-builder`
  `extraResources` (`electron-builder.config.ts:243–255`, currently empty for
  Linux) — that decouples policy from image version and complicates hotfixing a
  too-tight filter.
- `packages/codev-sandbox/src/const.ts` — add a resolver for the blob object key
  mirroring `wslInstallerAssetUrl` (`:42–54`).
- Reuse the existing staging/caching path (`image.ts:19–47`,
  content-addressed by sha256) verbatim for the blob download.

### 3. Backend wiring

- `packages/codev-sandbox/src/bwrap/args.ts`
  - `BwrapSpec` (`:23–35`): add `seccompFd?: number`.
  - `buildBwrapArgs` (`:49–93`): when `seccompFd` is set, emit
    `--add-seccomp-fd <fd>` immediately after `--clearenv` (`:87`), before the
    `--setenv` block. Do **not** disturb the trailing `-- <command>` structure —
    `args.test.ts:90` asserts `args.slice(-4)`.
- `packages/codev-sandbox/src/bwrap/provider.ts`
  - Availability probe (`:93–103`): add a one-time capability check for
    `--add-seccomp-fd`. The existing functional-probe style
    (`runCommand(bwrap, ["--ro-bind","/","/","true"])`, `:95`) is the model — run
    `bwrap --ro-bind / / --add-seccomp-fd <fd-of-a-trivial-allow-all-blob> true`
    and treat non-zero/spawn-error as "seccomp unsupported". Cache alongside the
    existing availability result. There is no `bwrap --version` call anywhere in
    the repo today, and we should not add version-string parsing — probe behavior.
  - Blob resolution + fd open: resolve the arch-appropriate `enforce`/`audit` blob
    (downloaded via the manifest path, same as the rootfs), `fs.openSync(path, "r")`
    in the parent, and inject the fd.
  - Spawn (`:153–174`): widen `stdio` to
    `["ignore","ignore","pipe", seccompFd]` and pass `seccompFd: 3` into
    `buildBwrapArgs`. Close the fd after spawn (bwrap has already read it; the child
    inherited a dup). On the failure path (`:199`) ensure the fd is closed too.
  - Degradation policy (needs a product call — see Open questions): if the running
    bwrap lacks `--add-seccomp-fd`, either (a) proceed without a filter and surface
    a warning, or (b) refuse to start. Recommend (a) with a persisted one-time
    warning for now, matching the fork's "warn, don't block on Windows tiers"
    instinct, but (b) is defensible for a security feature.

### 4. Config schema

- `packages/codev-sandbox/src/provider.ts` — `SandboxConfig` (`:5–36`): add
  `seccompMode?: "off" | "audit" | "enforce"`. Default resolved to `enforce` once
  the policy has cleared the audit phase; `off` is the escape hatch for a user
  whose workload a too-tight filter breaks.
- `packages/desktop/src/main/sandbox/controller.ts` — the normalizer whitelist
  (`:128–166`) **must** learn the new field or it is silently dropped on reload;
  add it there with a safe fallback like the resource-validation pattern
  (`:139–141`).
- A per-sandbox toggle changeable after creation needs a new IPC channel: there is
  no generic update path today, only `sandbox-update-mounts` (`ipc.ts:183`). Add
  `sandbox-update-seccomp` calling `patchConfig` (`controller.ts:72`). For v1 a
  global default (plumbed via `BwrapProviderOptions`, `provider.ts:29–48`, the same
  seam `bundleDir`/`resolveEgress` use) is simpler than per-sandbox UI and covers
  the common case.

### 5. Tests

- `bwrap/args.test.ts` — add a case asserting `--add-seccomp-fd` appears with the
  right fd and does not shift the trailing `-- <command>` tuple.
- `bwrap/provider.test.ts` — the injected fake `spawnImpl` (`:41–44`) currently
  ignores the options arg; widen it to capture `stdio`, and assert the fd lands at
  index 3. Add an availability-probe test for the unsupported-bwrap path (mirrors
  the `bwrapCommand: "false"` case at `:87`).
- `bwrap/bwrap.integration.test.ts` — the real payoff test. Its `probeBwrap()`
  (`:10–17`) is the model for a `seccompSupported` probe; add
  `test.skipIf(!seccompSupported)` cases that build a real enforce blob and assert:
  (1) an allowed op (write under `/workspace`) succeeds; (2) a denied op fails with
  the expected errno — e.g. a raw `AF_INET` socket, or `unshare(CLONE_NEWUSER)`.
  Uses the host `/` rootfs harness already in that file (`:23–43`).

### 6. Docs

- `README.md` — extend the arg listing (`:96` area) with the seccomp flag, and add
  a "Known gaps" entry (`:182–194`) tracking the audit→enforce rollout and the
  degradation policy.
- `SECURITY.md:17,30` — currently states the product does not sandbox the agent
  and that sandbox escapes are out of scope. Update to reflect that the bwrap
  backend now applies a syscall filter (while being honest that it is defense in
  depth on a shared kernel, not a hypervisor wall).
- `DIVERGENCES.md` — add a sandbox-hardening entry alongside the existing
  `SandboxConfig.mounts` note (`:129`).

## Phasing (this is how "strict allowlist" ships safely)

A default-deny allowlist that is wrong breaks real workloads in ways that look like
random tool failures (`pip install` hanging, `git` erroring on an obscure syscall).
So the allowlist is _reached_, not shipped cold:

1. **Audit blob first.** Ship the `audit`-mode blob (`SECCOMP_RET_LOG`), default
   `seccompMode: "audit"`. Zero behavior change; the kernel logs every syscall that
   _would_ have been denied. Collect from real sessions (internal dogfood + opt-in).
2. **Tune `policy.ts`** from the audit logs until the deny set is empty across the
   toolchains the image ships (Node 22, git, the language runtimes in the rootfs)
   plus common agent tasks (package installs, builds, test runners).
3. **Flip default to `enforce`** once audit is quiet for a release cycle. Keep
   `audit` and `off` selectable for debugging and for the user whose workload trips
   a syscall we did not anticipate.
4. **Maintain.** Every rootfs change that adds a tool re-runs step 2; the blob is
   versioned with the image so they cannot drift.

## Risks / trade-offs

- **False denials are the main cost.** Mitigated by the audit-first phase and the
  `off` escape hatch. This is why srt-style strict is more work than a denylist —
  accepted per the decision above.
- **Policy maintenance burden** rides with the image toolchain; the versioned-blob
  approach keeps it honest but adds a CI step (the Rust build tool).
- **Not a hard wall.** seccomp shrinks and hardens the kernel surface; it does not
  make the shared-kernel guest equal to the `vz` VM. It closes the specific
  escalation primitives that turn a guest exploit into a host escape, which is the
  high-value 80%.
- **arm64 correctness.** Cross-arch cBPF has genuine footguns (compat ABIs, syscall
  number differences). Delegating to libseccomp in the build tool — rather than a
  TS assembler — is the specific mitigation.

## Open questions for the team

1. **Degradation**: on a bwrap too old for `--add-seccomp-fd`, warn-and-continue or
   refuse-to-start? (Recommendation: warn-and-continue for v1.)
2. **Config granularity for v1**: global default only, or per-sandbox toggle with
   the new IPC channel? (Recommendation: global for v1, per-sandbox later.)
3. **`ptrace`**: hard-block, or allow (many debuggers/tools use it, and the userns
   already limits its reach)? Leaning hard-block, revisit from audit data.
4. **Does the WSL backend inherit this automatically?** It boots the same rootfs but
   is not spawned through `buildBwrapArgs`; if we want parity, the filter needs a
   separate install path inside the WSL boot. Out of scope for v1 unless required.

## What shipped

The implementation follows the decisions above with these departures, each
chosen to make the feature self-contained in one PR:

- **The BPF program is generated in TypeScript at sandbox start**, not
  precompiled with libseccomp in CI and shipped through the image manifest. The
  arm64-correctness concern behind the libseccomp choice is met differently:
  the syscall tables (`syscalls-{x64,arm64}.ts`) are generated straight from the
  kernel uapi headers by `script/gen-syscall-tables.ts`, the program kills any
  non-native `arch` and the x32 bit before looking at a number, and
  `bpf.test.ts` runs the real program bytes through a cBPF interpreter for
  every syscall number on both architectures. The trade: the policy versions
  with the app, not with the rootfs image, so a rootfs that adds a tool needing
  a new syscall needs an app release too.
- **`--seccomp`, not `--add-seccomp-fd`.** One program is all there is, and
  the older flag exists in every bwrap release, which removes the
  degradation question (open question 1) entirely.
- **ptrace returns EPERM rather than killing** (open question 3): strace and
  gdb should print "Operation not permitted", not vanish with SIGSYS. The
  syscall is refused either way.
- **AF_INET/AF_INET6 are allowed**, not only AF_UNIX: the guest's own server,
  the broker stub, and any dev server the agent starts are loopback TCP, and
  `--unshare-net` already leaves nothing else to reach. AF_NETLINK is limited to
  NETLINK_ROUTE (getifaddrs).
- **Default is enforce, not audit.** With no fleet to collect audit logs from,
  an audit default would have shipped no protection. The allowlist is Docker's
  battle-tested profile minus capability-gated entries, verified by the
  integration tests and a manual smoke run (node http/spawn/worker/watch/dns,
  git, python sockets). `audit` and `off` remain, machine-wide via
  `CODEV_SANDBOX_SECCOMP` and per sandbox via the persisted `seccomp` field
  (open question 2: global default plus a hand-editable per-sandbox override, no
  IPC channel or UI).
- **Unlisted syscalls at or above 424 return ENOSYS**, below it EPERM — the
  Docker approach, so glibc's fallbacks (clone3 → clone, faccessat2 →
  faccessat) trigger. `io_uring_*` and `clone3` are deliberately unlisted.
- **WSL is untouched** (open question 4).
