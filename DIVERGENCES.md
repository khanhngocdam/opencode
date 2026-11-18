# Codev2 divergences from upstream

## Policy

Prefer config, plugins, skills and agents, then additive `packages/codev-*`
packages, and edit upstream files only when those boundaries cannot implement
an integration. Every edited or deleted upstream file must have its own row
below in the same PR. New fork-only files belong in the module inventory.
Never rename internal `@opencode/*` packages or wire identifiers merely for branding.
Keep upstream attribution and license notices.

`codev.upstream.json` pins the upstream baseline, independently of `origin/dev`
(the fork PR base). `bun run check:divergences` checks cumulative changes against
that baseline, including working-tree changes. It requires the baseline Git object.

## Syncing with upstream

This v2 fork retains upstream history. The v1 release-tag patch procedure does
not apply. Do not truncate history or merge unrelated histories.

1. Start with a clean tree. Fetch `origin` and the upstream repository recorded
   in `codev.upstream.json`; create `sync-upstream` from `origin/dev`.
2. Record the target upstream commit. Verify it shares ancestry with the pinned
   baseline using `git merge-base`; stop if it does not.
3. Merge that target. For conflicts use the table below, preserving the upstream
   implementation around the smallest required Codev integration.
4. Update the pinned upstream commit/version only after resolving the merge.
   Reconcile renamed/deleted paths in this table; remove obsolete divergences.
5. Regenerate clients from `packages/client` if Protocol/HttpApi changed. Resolve
   manifests first, then regenerate the lockfile with Bun; never hand-edit it.
6. Run divergence checks, package tests and root `bun run check`. Verify Codev2
   does not discover or replace an OpenCode or Codev v1 service.
7. Open a conventional-title PR targeting `dev`, documenting target SHA, flags,
   migration effects and checks. Preserve upstream authorship and attribution.

## Changed upstream files

| File | Change | Why | On conflict |
| --- | --- | --- | --- |
| `AGENTS.md` | Add fork policy and Codev2 live-testing guidance. | Keep future work divergence-aware. | Keep fork policy; take newer architecture and testing rules. |
| `package.json` | Add divergence verification. | Make the fork policy executable. | Preserve the check alongside upstream scripts. |

| `packages/util/src/global.ts` | Use Codev2 global roots. | Isolate the Codev2 preview from existing installations. | Keep the Codev2 root; retain upstream path and layer behavior. |
| `packages/util/test/global.test.ts` | Assert Codev2 global paths. | Isolate the Codev2 preview from existing installations. | Adapt expectations to the fork root while retaining upstream contracts. |
| `packages/client/src/service-probe.ts` | Discover the Codev2 service registration. | Isolate the Codev2 preview from existing installations. | Keep the Codev2 root; preserve wire authentication identifiers. |
| `packages/client/src/effect/service.ts` | Spawn codev2 when ensuring a service. | Isolate the Codev2 preview from existing installations. | Preserve explicit command overrides and upstream lifecycle fixes. |
| `packages/client/src/promise/service.ts` | Spawn codev2 when ensuring a service. | Isolate the Codev2 preview from existing installations. | Preserve explicit command overrides and upstream lifecycle fixes. |
| `packages/client/src/service.ts` | Document the fork service command. | Isolate the Codev2 preview from existing installations. | Keep public option semantics; update the example. |
| `packages/cli/src/services/service-config.ts` | Allocate separate preview and channel service ports. | Isolate the Codev2 preview from existing installations. | Keep separate ports and hash namespace, including Windows reserved-port handling. |
| `packages/cli/test/service.test.ts` | Verify Codev2 service port allocation. | Isolate the Codev2 preview from existing installations. | Keep channel and Windows contracts, adjust only fork ports. |
| `packages/cli/src/commands/commands.ts` | Name the preview CLI codev2. | Isolate the Codev2 preview from existing installations. | Keep upstream commands and parameter definitions. |
| `packages/cli/script/build.ts` | Compile the Codev2 CLI display name. | Isolate the Codev2 preview from existing installations. | Keep upstream build internals and binary filenames until fork packaging is ready. |
| `packages/cli/package.json` | Expose only the codev2 executable from the workspace. | Isolate the Codev2 preview from existing installations. | Do not reinstall opencode or codev aliases. |
| `packages/cli/src/index.ts` | Provide a preview-only updater with no upstream install actions. | Isolate the Codev2 preview from existing installations. | Keep the Codev updater binding until a fork release channel is verified. |

| `packages/core/package.json` | Depend on the pure Codev branding adapter. | Brand prompts at their assembly boundary. | Preserve the additive dependency. |
| `packages/core/src/session/system-prompt.ts` | Rebrand assembled prompts. | Keep upstream prompt sources intact. | Preserve the final rebrand call after upstream tool guidance. |
| `packages/cli/test/service-lifecycle.test.ts` | Discover the preview registration in Codev2 state. | Test the actual isolated service. | Keep upstream lifecycle scenarios with the fork root. |
| `bun.lock` | Resolve additive Codev workspaces and the preview bin. | Keep reproducible installation. | Regenerate with Bun after resolving manifests. |

| `script/check-greys.ts` | Normalize Windows separators before checking path exceptions. | Run the existing colour audit consistently on Windows. | Keep normalization unless upstream makes glob paths portable. |

| `packages/desktop/src/main/constants.ts` | Separate desktop names and app IDs. | Keep userData and single-instance locks separate from v1 and upstream. | Preserve Codev2 IDs across build and runtime. |
| `packages/desktop/src/main/lifecycle/environment.ts` | Use the Codev2 desktop URL scheme. | Do not register or intercept another installed product scheme. | Keep registration, parser, routing and fixtures consistent. |
| `packages/desktop/src/main/lifecycle/index.ts` | Use the Codev2 desktop URL scheme. | Do not register or intercept another installed product scheme. | Keep registration, parser, routing and fixtures consistent. |
| `packages/desktop/src/main/lifecycle/deep-link.ts` | Use the Codev2 desktop URL scheme. | Do not register or intercept another installed product scheme. | Keep registration, parser, routing and fixtures consistent. |
| `packages/desktop/src/main/lifecycle/deep-link.test.ts` | Use the Codev2 desktop URL scheme. | Do not register or intercept another installed product scheme. | Keep registration, parser, routing and fixtures consistent. |
| `packages/desktop/src/main/deep-links/machine.test.ts` | Use the Codev2 desktop URL scheme. | Do not register or intercept another installed product scheme. | Keep registration, parser, routing and fixtures consistent. |
| `packages/gui-plugins/src/updater/main.ts` | Disable preview desktop updates. | Never download an upstream desktop over Codev2. | Keep disabled until a fork-owned feed is configured and tested. |
| `packages/desktop/electron-builder.config.ts` | Separate installer identity, scheme and cache name; remove upstream feeds and Linux legacy entry. | Install beside existing clients without overwriting their launchers. | Keep runtime and packager IDs aligned; do not restore upstream feeds or compatibility launchers. |
| `packages/desktop/script/copy-metainfo.ts` | Generate metadata for the separate app ID. | Match Linux package identity. | Keep the fork ID and support link; preserve upstream attribution. |
| `packages/desktop/script/build.ts` | Require a locally built fork CLI for every desktop channel. | Prevent staging an upstream server in a Codev2 desktop. | Keep failure on missing CLI instead of restoring download fallback. |
| `packages/tui/src/logo.ts` | Use the Codev wordmark geometry. | Rebrand the TUI without copying v1 theme implementation. | Keep semantic colors and responsive renderer from v2. |
| `packages/tui/src/component/logo.tsx` | Show a compact Codev c badge. | Keep narrow terminal branding consistent. | Retain responsive breakpoints and semantic theme tokens. |

| `packages/desktop/src/main/service/desktop-cli.ts` | Disable the upstream macOS CLI installer. | Prevent overwriting the installed opencode command from Codev2. | Keep preview installation unavailable until a fork installer is tested. |
| `packages/desktop/src/main/service/background-service.ts` | Discover the local-channel service under Codev2 state. | Match CLI registration and SDK discovery. | Keep all discovery roots aligned. |
| `packages/desktop/script/dev.ts` | Reject downloading an upstream development server. | Keep the desktop preview on this fork. | Preserve source/build modes and reject the upstream download path. |
| `sdks/vscode/.gitignore` | Ignore the generated `dist-codev2/` preview staging directory. | Keep the Codev2 VSIX staging output out of Git without renaming the upstream extension. | Keep the extra `dist-codev2` line; take upstream's other entries. |

## Fork-only modules

- `packages/codev-brand`: pure branding adapter and contract tests.
- `packages/codev-sandbox`: v1 sandbox providers copied for later integration; only `src/preview.ts`
  (`sandboxPreviewAvailability`, always unsupported in the preview, never boots a VM) is exported for v2 UI use.
- `sdks/vscode/script/pack-codev2.ts`: stages an isolated `CoDev Code 2` extension (`codev.codev2`, `codev2.*`
  commands, `codev2` binary) in `sdks/vscode/dist-codev2/`; leaves the upstream extension untouched.
- `packages/cli/src/services/codev-updater.ts`: preview update policy; no upstream installers.
- `packages/cli/test/codev-updater.test.ts`: preview update isolation contract.
- `packages/cli/bin/codev2.cjs`: isolated command entry point.
- `script/check-divergences.ts`: validates this registry against the pinned baseline.
- `.github/workflows/check-codev.yml`: validates divergence coverage with full history.
- `codev.upstream.json`: upstream and v1 source provenance.
- `CODEV-MIGRATION.md`: implementation status and acceptance gates.
- `codev-v1-inventory.json`: source divergence inventory; `pending`, `port` and `review` entries are not implemented.

## Known gaps

The migration status is recorded in `CODEV-MIGRATION.md`. A listed or copied module
is not evidence that its v2 integration is implemented or tested.
