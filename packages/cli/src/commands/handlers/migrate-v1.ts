import { cp, mkdir, stat, writeFile } from "node:fs/promises"
import { EOL } from "node:os"
import path from "node:path"
import { Effect, Option } from "effect"
import { Global } from "@opencode/util/global"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { requireCodevFlag } from "../../services/codev-flag"

// Codev v1 keeps its session database beside its other data. These are the only data files staged: credentials are
// never copied (sign in again with `codev2 configure`), and logs, caches and binaries are rebuilt by Codev2.
const DATABASE_FILES = ["opencode.db", "opencode.db-wal", "opencode.db-shm"]
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git"])

type Step = {
  readonly label: string
  readonly from: string
  readonly to: string
  readonly kind: "file" | "directory"
}

export default Runtime.handler(
  Commands.commands["migrate-v1"],
  Effect.fn("cli.migrate-v1")(function* (input) {
    yield* requireCodevFlag("codev_migrate_v1")
    const global = yield* Global.Service
    const source = Option.getOrUndefined(input.source)
    const v1 = {
      data: source ? path.resolve(source, "data") : path.join(global.home, ".local", "share", "codev"),
      config: source ? path.resolve(source, "config") : path.join(global.home, ".config", "codev"),
    }
    yield* requireSeparateRoots(v1, global)

    const snapshot = path.join(global.state, "migrations", `v1-${new Date().toISOString().replace(/[:.]/g, "-")}`)
    const steps = yield* Effect.promise(() => plan(v1, snapshot))
    const write = (line: string) => process.stdout.write(line + EOL)

    write(`Codev v1 config: ${v1.config}`)
    write(`Codev v1 data:   ${v1.data}`)
    write(`Snapshot:        ${snapshot}`)
    write("")
    if (steps.length === 0) return write("Nothing to import: no Codev v1 config or session database was found.")
    write(input.dryRun ? "Plan (dry run, nothing is copied):" : "Copying (v1 is only read):")
    steps.forEach((step) => write(`  ${step.label}: ${step.from} -> ${step.to}`))
    write("")
    if (!input.dryRun)
      yield* Effect.promise(async () => {
        await mkdir(snapshot, { recursive: true })
        for (const step of steps)
          await cp(step.from, step.to, {
            recursive: true,
            // The staged copy is the only thing ever written; the source is opened for reading.
            filter: (item) => !SKIPPED_DIRECTORIES.has(path.basename(item)),
          })
        await writeFile(
          path.join(snapshot, "manifest.json"),
          JSON.stringify({ source: v1, steps, createdAt: new Date().toISOString() }, null, 2),
        )
      })
    write("Not done automatically:")
    write("  - The staged config is a snapshot. Codev v1 config uses the older `provider`/`npm` shape; review it and")
    write("    port entries into your codev2 config (`codev2 debug paths config`) instead of copying it over.")
    write("  - Sessions in the staged database are imported by the Codev2 server's v1 migration, which must be run")
    write("    against this copy first (see packages/core/src/database/v1-migration.bun.ts), never against v1 itself.")
    write("  - Credentials are not copied. Run `codev2 configure` to sign in again.")
    if (input.dryRun) write("Run again without --dry-run to create the snapshot.")
  }),
)

function requireSeparateRoots(v1: { data: string; config: string }, global: Global.Interface) {
  const protectedRoots = [global.data, global.config, global.state].map((root) => path.resolve(root))
  const overlaps = [v1.data, v1.config].some((root) =>
    protectedRoots.some((target) => {
      const relative = path.relative(target, path.resolve(root))
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
    }),
  )
  return overlaps
    ? Effect.fail(new Error("The v1 source overlaps Codev2 data, config or state. Refusing to continue."))
    : Effect.void
}

async function plan(v1: { data: string; config: string }, snapshot: string) {
  const candidates: ReadonlyArray<Step> = [
    { label: "config", from: v1.config, to: path.join(snapshot, "config"), kind: "directory" },
    ...DATABASE_FILES.map((name) => ({
      label: "database",
      from: path.join(v1.data, name),
      to: path.join(snapshot, "data", name),
      kind: "file" as const,
    })),
  ]
  const present = await Promise.all(
    candidates.map((step) =>
      stat(step.from).then(
        (info) => (step.kind === "directory" ? info.isDirectory() : info.isFile()),
        () => false,
      ),
    ),
  )
  return candidates.filter((_, index) => present[index])
}
