import { spawn } from "node:child_process"
import { mkdir, readdir, readlink, rm } from "node:fs/promises"
import { join } from "node:path"
import type { RootfsEntry } from "./args"

export type RunCommandResult = {
  code: number | null
  stdout: string
  stderr: string
}

export function runCommand(
  command: string,
  args: string[],
  opts?: { signal?: AbortSignal },
): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], signal: opts?.signal })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk
    })
    child.once("error", reject)
    child.once("exit", (code) => resolve({ code, stdout, stderr }))
  })
}

export async function unpackRootfs(imagePath: string, rootfsDir: string, opts?: { signal?: AbortSignal }) {
  await rm(rootfsDir, { recursive: true, force: true })
  await mkdir(rootfsDir, { recursive: true })
  const result = await runCommand("tar", ["-xf", imagePath, "-C", rootfsDir], opts)
  if (result.code !== 0)
    throw new Error(`sandbox rootfs unpack failed: ${result.stderr.trim() || `tar exited ${result.code}`}`)
}

// Top-level dirs and symlinks of the unpacked rootfs; symlinks are reported
// with their target so merged-usr layouts (/bin -> usr/bin) are recreated as
// symlinks instead of duplicate binds.
export async function readRootfsEntries(rootfsDir: string): Promise<RootfsEntry[]> {
  const entries = await readdir(rootfsDir, { withFileTypes: true })
  return Promise.all(
    entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map(async (entry) => ({
        name: entry.name,
        symlinkTarget: entry.isSymbolicLink() ? await readlink(join(rootfsDir, entry.name)) : null,
      })),
  )
}
