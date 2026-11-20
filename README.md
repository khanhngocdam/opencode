<p align="center">
  <picture>
    <source srcset=".github/assets/codev-logo-dark.svg" media="(prefers-color-scheme: dark)">
    <source srcset=".github/assets/codev-logo-light.svg" media="(prefers-color-scheme: light)">
    <img src=".github/assets/codev-logo-light.svg" alt="Codev Code logo" width="360">
  </picture>
</p>
<p align="center"><b>Codev Code 2.0</b> — the CoDev AI coding agent, built on OpenCode.</p>
<p align="center">
  <a href="https://www.npmjs.com/package/codev2-code"><img alt="npm" src="https://img.shields.io/npm/v/codev2-code?style=flat-square" /></a>
</p>

---

### Installation

```bash
npm i -g codev2-code     # or bun/pnpm/yarn
codev2 --version
```

Codev Code 2.0 installs the `codev2` command. It runs alongside Codev v1 (`codev`) and OpenCode without touching them: its data directory, background service, credentials and desktop identity are all separate.

Updates are manual: install the newer release with `npm i -g codev2-code@latest`.

### Getting started

```bash
codev2 configure   # sign in to the CoDev AI gateway (SSO or API key)
codev2             # open the terminal UI in the current directory
```

### Codev commands

| Command                               | What it does                                            |
| ------------------------------------- | ------------------------------------------------------- |
| `codev2 configure`                    | Configure the CoDev AI gateway (SSO or API key)         |
| `codev2 skill search \| pull \| push` | Search, install and publish SkillHub skills             |
| `codev2 skill stack list \| pull`     | List SkillHub stacks or install every skill in one      |
| `codev2 skill office`                 | Install the CoDev Office skills bundle                  |
| `codev2 upload`                       | Upload session statistics to the CoDev analysis backend |
| `codev2 codegraph`                    | Show how to enable the CodeGraph MCP server             |

Run `codev2 --help` for every command, including the ones inherited from OpenCode.

### Agents

Codev Code includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

### Development

```bash
bun install
bun dev                   # run the CLI from source
bun run dev:live          # run this worktree's TUI against the installed codev2 service
bun run check             # divergence check, lint and typecheck
cd packages/core && bun test   # tests run from a package directory, never the repo root
```

This repository is a fork of [OpenCode](https://github.com/anomalyco/opencode). The pinned upstream version is in [`codev.upstream.json`](codev.upstream.json), and every change to an upstream file is recorded in [DIVERGENCES.md](DIVERGENCES.md); read it before editing. Migration status from Codev v1 is tracked in [CODEV-MIGRATION.md](CODEV-MIGRATION.md).

Releases use the version `<upstream>-N` (for example `2.3.0-1`), set with `bun bump`, and are published to npm from `packages/cli` with `bun run release`.

### License

MIT, inherited from OpenCode; the upstream copyright notice is kept in [LICENSE](LICENSE). Report issues at [github.com/khanhngocdam/opencode/issues](https://github.com/khanhngocdam/opencode/issues).
