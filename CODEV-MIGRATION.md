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
| Gateway/SSO | Pending | Configure, login, models and expired-key recovery on v2 |
| SkillHub/Stack/Office/CodeGraph | Pending | Install/use/update against existing services |
| Upload/statistics | Pending | v2 adapter, backend payload compatibility, opt-out and deduplication |
| Sandbox and Code/Work | Pending | Guest v2 server, mounts, broker, lifecycle and permission checks |
| Remaining v1 divergences | In progress | Every source inventory row classified with evidence |
| Migration | Pending | Snapshot import, warnings and idempotence; source untouched |
| VS Code and release artifacts | Pending | Isolated VSIX/CLI/desktop artifacts, no automatic publication |

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
