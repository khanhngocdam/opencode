import { expect, test } from "bun:test"
import { mkdir, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { buildBwrapArgs, GUEST_HOME, GUEST_PATH } from "./args"
import { readRootfsEntries, runCommand } from "./rootfs"
import { buildSeccompProgram, seccompArch } from "../seccomp/bpf"

// Real-bwrap integration; runs only on Linux hosts where unprivileged user
// namespaces work (skipped on macOS/CI runners with AppArmor restrictions).
function probeBwrap() {
  if (process.platform !== "linux") return false
  try {
    return Bun.spawnSync(["bwrap", "--ro-bind", "/", "/", "true"]).exitCode === 0
  } catch {
    return false
  }
}

const bwrapUsable = probeBwrap()

// The host's own / serves as the rootfs (the safe subset of it), so the test
// needs no image download; entries keep their real dir/symlink shape.
const HOST_ROOTFS_ALLOWLIST = new Set(["usr", "bin", "sbin", "lib", "lib32", "lib64", "libx32", "etc"])

async function hostSpec(dir: string) {
  const projectDir = join(dir, "project")
  const dirs = { bridge: join(dir, "bridge"), runtime: join(dir, "runtime"), home: join(dir, "home") }
  await mkdir(projectDir, { recursive: true })
  await mkdir(dirs.bridge, { recursive: true })
  await mkdir(dirs.runtime, { recursive: true })
  await mkdir(dirs.home, { recursive: true })
  await writeFile(join(projectDir, "file.txt"), "hello from host")
  return {
    rootfsDir: "/",
    rootfsEntries: (await readRootfsEntries("/")).filter((entry) => HOST_ROOTFS_ALLOWLIST.has(entry.name)),
    projectDir,
    bundleDir: dirs.bridge,
    bridgeDir: dirs.bridge,
    runtimeDir: dirs.runtime,
    homeDir: dirs.home,
    env: { PATH: GUEST_PATH, HOME: GUEST_HOME, CODEV_SERVER_PASSWORD: "sekret" },
  }
}

test.skipIf(!bwrapUsable)("guest sees only loopback, the workspace, and the cleared env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-bwrap-int-"))
  const spec = await hostSpec(dir)
  const result = await runCommand(
    "bwrap",
    buildBwrapArgs({
      ...spec,
      command: [
        "/bin/sh",
        "-c",
        'cat /workspace/file.txt; echo; cat /proc/net/dev; echo "HOME=$HOME PASS=$CODEV_SERVER_PASSWORD"',
      ],
    }),
  )
  expect(result.code).toBe(0)
  expect(result.stdout).toContain("hello from host")
  expect(result.stdout).toContain("HOME=/home/codev PASS=sekret")
  const interfaces = result.stdout.match(/^\s*(\w+):/gm) ?? []
  expect(interfaces.map((line) => line.trim())).toEqual(["lo:"])

  await rm(dir, { recursive: true, force: true })
})

test.skipIf(!bwrapUsable)("workspace is writable while the rootfs stays read-only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-bwrap-int-"))
  const spec = await hostSpec(dir)
  const result = await runCommand(
    "bwrap",
    buildBwrapArgs({
      ...spec,
      command: [
        "/bin/sh",
        "-c",
        "touch /workspace/written && echo wrote-workspace; touch /usr/should-fail 2>/dev/null || echo usr-readonly",
      ],
    }),
  )
  expect(result.code).toBe(0)
  expect(result.stdout).toContain("wrote-workspace")
  expect(result.stdout).toContain("usr-readonly")
  expect(await stat(join(spec.projectDir, "written")).catch(() => null)).not.toBe(null)

  await rm(dir, { recursive: true, force: true })
})

// Runs a shell script in a real bwrap guest under the compiled filter, the
// way provider.ts does: program written to a file, its fd inherited in slot 3.
async function runFiltered(spec: Awaited<ReturnType<typeof hostSpec>>, dir: string, script: string) {
  const arch = seccompArch()
  if (!arch) throw new Error(`no seccomp table for ${process.arch}`)
  const path = join(dir, "seccomp.bpf")
  await writeFile(path, buildSeccompProgram(arch, "enforce").bytes)
  const file = await open(path, "r")
  const child = spawn("bwrap", buildBwrapArgs({ ...spec, seccompFd: 3, command: ["/bin/sh", "-c", script] }), {
    stdio: ["ignore", "pipe", "pipe", file.fd],
  })
  await file.close()
  let stdout = ""
  let stderr = ""
  child.stdout?.on("data", (chunk) => (stdout += chunk))
  child.stderr?.on("data", (chunk) => (stderr += chunk))
  const code = await new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)))
  return { code, stdout, stderr }
}

test.skipIf(!bwrapUsable)("the seccomp filter lets ordinary work through", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-bwrap-int-"))
  const spec = await hostSpec(dir)
  const result = await runFiltered(
    spec,
    dir,
    "cat /workspace/file.txt && echo && ls /workspace | wc -l && echo piped | cat && mkdir /workspace/sub && echo ok-$(id -u)",
  )
  expect(result.stderr).toBe("")
  expect(result.code).toBe(0)
  expect(result.stdout).toContain("hello from host")
  expect(result.stdout).toContain("piped")
  expect(result.stdout).toMatch(/ok-\d+/)
  await rm(dir, { recursive: true, force: true })
})

test.skipIf(!bwrapUsable)("the seccomp filter refuses mounts and kills user-namespace creation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-bwrap-int-"))
  const spec = await hostSpec(dir)
  // Both would succeed on the namespaces alone: the guest holds CAP_SYS_ADMIN
  // in its user namespace. 159 is 128 + SIGSYS, the shell's report of a
  // child killed by the filter.
  const result = await runFiltered(
    spec,
    dir,
    'mount -t tmpfs none /tmp 2>&1; echo "mount=$?"; unshare -U true 2>&1; echo "unshare=$?"',
  )
  expect(result.stdout).toContain("mount=")
  expect(result.stdout).not.toContain("mount=0")
  expect(result.stdout).toContain("unshare=159")
  await rm(dir, { recursive: true, force: true })
})
