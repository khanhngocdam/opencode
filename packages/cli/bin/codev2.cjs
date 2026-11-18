#!/usr/bin/env node

const childProcess = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")

// Source preview only: never resolve an upstream @opencode/cli-* binary.
const entry = path.join(__dirname, "../src/index.ts")
if (!fs.existsSync(entry)) {
  console.error("Codev2 preview requires the source checkout. Packaged installation is not available yet.")
  process.exit(1)
}
const child = childProcess.spawn("bun", [entry, ...process.argv.slice(2)], { stdio: "inherit" })
child.on("error", (error) => {
  console.error(`Unable to start Codev2: ${error.message}`)
  process.exitCode = 1
})
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal))
child.on("exit", (code) => { process.exitCode = code ?? 1 })
