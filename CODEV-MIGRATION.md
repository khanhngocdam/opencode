# Codev2 migration

Target: OpenCode 2.3.0 at the commit pinned in `codev.upstream.json`.
Source: Codev 1.18.23-9. Keep the v2 UI and integrate existing backend services.
Experimental command: `codev2`; v1 remains installed independently.

## Status

| Area | State | Acceptance gate |
| --- | --- | --- |
| Fork governance | Implemented, verification pending | Missing divergence fails CI; upstream history retained |
| Brand and isolated CLI/service | Implemented, verification pending | Run alongside v1 without shared state or ports |
| Desktop identity and update isolation | Implemented, verification pending | Installer/deep links/updater never target v1 or upstream |
| Gateway/SSO | Implemented (package + CLI `configure` + TUI `DialogConfigure`) | Configure, login, models and expired-key recovery on v2 |
| SkillHub/Stack/Office/CodeGraph | Implemented (package + CLI `skill`/`codegraph`; UI/server proxy still follow-up) | Install/use/update against existing services |
| Upload/statistics | Implemented (package + CLI; server stats reader uses v2 `/api/session` adapter) | v2 adapter, backend payload compatibility, opt-out and deduplication |
| Sandbox and Code/Work | Preview stub (`sandboxPreviewAvailability`; no VM/IPC yet) | Guest v2 server, mounts, broker, lifecycle and permission checks |
| Remaining v1 divergences | Classified (covered/port/drop/review; none pending) | Every source inventory row classified with evidence |
| Migration | Implemented (`codev2 migrate-v1` snapshot; session import remains manual against the copy) | Snapshot import, warnings and idempotence; source untouched |
| VS Code and release artifacts | VS Code preview pack script (`sdks/vscode/script/pack-codev2.ts`); release publish still off | Isolated VSIX/CLI/desktop artifacts, no automatic publication |

## Phase 1 coverage (brand + isolation)

These v1 inventory rows are classified as covered by the Codev2 identity work
(or intentionally deferred to a later phase). Status lives in
`codev-v1-inventory.json`.

- Root / data dir rename → `codev2` via `packages/util/src/global.ts`
- CLI bin / help naming → `codev2`
- Brand package + prompt rebrand
- Desktop app IDs, deep links, updater isolation
- Service discovery / ports under Codev2 state
- Fork governance files (`DIVERGENCES.md`, check scripts, CI)

## Implementation constraints

- Keep `@opencode/*` identifiers and upstream config semantics where they are contracts.
- Use the existing v2 migration only on a copy of v1 data, after fixture verification.
- Port `codev-brand`, `codev-gateway`, `codev-skillhub`, `codev-upload`, then
  `codev-sandbox`; adapt consumers to v2 rather than copying v1 session execution.
- New HTTP groups are experimental. Regenerate clients, never edit generated code.
- New behavior uses the existing v2 feature-flag mechanism until verified for release.
- Preserve v2 locales, typography, UI state machines and durable session semantics.
- Final verification includes package tests, `bun run check`, live TUI and desktop,
  platform packaging, and an upstream-sync rehearsal.

## VS Code

The upstream extension in `sdks/vscode` (`sst-dev.opencode`, `opencode.*` commands) is not renamed.
`sdks/vscode/script/pack-codev2.ts` stages an isolated preview in `sdks/vscode/dist-codev2/`:
extension `codev.codev2`, display name `Codev Code 2.0`, commands `codev2.*`, terminal and binary `codev2`.
Nothing is published automatically.

```sh
cd sdks/vscode
bun install
bun script/pack-codev2.ts          # stage dist-codev2/ only (patched package.json and src/extension.ts)
bun script/pack-codev2.ts --vsix   # also bundle with esbuild and package dist-codev2/*.vsix with vsce
code --install-extension dist-codev2/codev2-*.vsix
```

The extension opens a terminal and runs `codev2`, so install the preview CLI first. Verify the VSIX
installs next to Codev v1 and OpenCode without sharing commands or keybindings before marking this done.

## Inventory classification

`codev-v1-inventory.json` rows use `covered` (implemented in v2), `port` (needs v2 integration),
`drop` (not applicable to the fork), or `review` (needs manual comparison against v2). No row is `pending`.
`review` rows are not evidence of implementation.

## First build (`2.3.0-1`)

Version rule matches Codev v1: upstream base + fork revision suffix.

```sh
bun bump 2.3.0-1
# or: bun bump   # auto → 2.3.0-1 from 2.3.0

# CLI (all platforms for npm; use --single --baseline for local/desktop-only)
cd packages/cli
$env:OPENCODE_VERSION="2.3.0-1"
$env:OPENCODE_CHANNEL="latest"
bun run build

# Desktop (requires CLI dist above, prefers baseline)
cd ../desktop
$env:OPENCODE_VERSION="2.3.0-1"
$env:OPENCODE_CHANNEL="latest"
bun run build
bun run pack

# npm (requires npm login; dist already built → --skip-build)
cd ../cli
bun run release -- --skip-build
# users: npm i -g codev2.0-code && codev2
```