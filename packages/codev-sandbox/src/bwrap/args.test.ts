import { expect, test } from "bun:test"
import { GUEST_WORKSPACE, bindableRootfsEntries, buildBwrapArgs } from "./args"

const spec = {
  rootfsDir: "/data/default/rootfs",
  rootfsEntries: [
    { name: "usr", symlinkTarget: null },
    { name: "bin", symlinkTarget: "usr/bin" },
    { name: "etc", symlinkTarget: null },
    { name: "proc", symlinkTarget: null },
    { name: "home", symlinkTarget: null },
  ],
  projectDir: "/host/project",
  bundleDir: "/host/bundle",
  bridgeDir: "/data/default/bridge",
  runtimeDir: "/data/default/runtime",
  homeDir: "/data/default/home",
  env: { CODEV_SERVER_PASSWORD: "secret", PATH: "/usr/bin" },
  command: ["/bin/sh", "-c", "exec node server"],
}

test("drops rootfs entries that would shadow managed mounts", () => {
  expect(bindableRootfsEntries(spec.rootfsEntries).map((entry) => entry.name)).toEqual(["usr", "bin", "etc"])
})

test("builds an isolated namespace with loopback-only networking", () => {
  const args = buildBwrapArgs(spec)
  expect(args).toContain("--unshare-net")
  expect(args).toContain("--unshare-pid")
  expect(args).toContain("--die-with-parent")
  expect(args).toContain("--clearenv")
  expect(args.join(" ")).toContain("--proc /proc")
})

test("binds rootfs dirs read-only and recreates merged-usr symlinks", () => {
  const joined = buildBwrapArgs(spec).join(" ")
  expect(joined).toContain("--ro-bind /data/default/rootfs/usr /usr")
  expect(joined).toContain("--symlink usr/bin /bin")
  expect(joined).not.toContain("/rootfs/proc")
  expect(joined).not.toContain("/rootfs/home")
})

test("mounts the workspace rw and the bundle/bridge ro after the rootfs binds", () => {
  const joined = buildBwrapArgs(spec).join(" ")
  expect(joined).toContain("--bind /host/project /workspace")
  expect(joined).toContain("--ro-bind /host/bundle /opt/codev")
  expect(joined).toContain("--ro-bind /data/default/bridge /codev-bridge")
  expect(joined).toContain("--bind /data/default/runtime /run/codev")
  expect(joined).toContain("--bind /data/default/home /home/codev")
  expect(joined.indexOf("--bind /host/project")).toBeGreaterThan(joined.indexOf("--ro-bind /data/default/rootfs/usr"))
  expect(joined).toContain(`--chdir ${GUEST_WORKSPACE}`)
})

// bwrap creates missing mount points, but only where it can write: its own
// tmpfs root, never inside a read-only rootfs bind. A destination nested under
// a bound rootfs entry must therefore already exist in the image — which the
// image only guarantees for /opt/codev. GUEST_BRIDGE lived at /opt/codev-bridge
// and failed every real start with EROFS; the integration test missed it
// because its host-rootfs allowlist excludes /opt.
test("never nests a mount destination inside a read-only rootfs bind", () => {
  const args = buildBwrapArgs({ ...spec, rootfsEntries: [{ name: "opt", symlinkTarget: null }] })
  const destinations = args.flatMap((arg, index) =>
    (arg === "--bind" || arg === "--ro-bind") && !args[index + 1].startsWith(spec.rootfsDir) ? [args[index + 2]] : [],
  )
  expect(destinations.filter((destination) => destination.startsWith("/opt/"))).toEqual(["/opt/codev"])
})

test("binds extra mounts rw under /mnt, after the rootfs binds", () => {
  const joined = buildBwrapArgs({
    ...spec,
    rootfsEntries: [...spec.rootfsEntries, { name: "mnt", symlinkTarget: null }],
    mounts: [
      { path: "/host/docs", guestPath: "/mnt/docs" },
      { path: "/host/data", guestPath: "/mnt/data" },
    ],
  }).join(" ")
  expect(joined).toContain("--bind /host/docs /mnt/docs")
  expect(joined).toContain("--bind /host/data /mnt/data")
  // The image's own /mnt must not be ro-bound: bwrap can only create the
  // /mnt/<name> mount points on its tmpfs root.
  expect(joined).not.toContain("/rootfs/mnt")
  expect(joined.indexOf("--bind /host/docs")).toBeGreaterThan(joined.indexOf("--ro-bind /data/default/rootfs/usr"))
})

test("clears the environment before setting the boot env", () => {
  const args = buildBwrapArgs(spec)
  const joined = args.join(" ")
  expect(joined).toContain("--setenv CODEV_SERVER_PASSWORD secret")
  expect(joined.indexOf("--setenv")).toBeGreaterThan(joined.indexOf("--clearenv"))
  expect(args.slice(-4)).toEqual(["--", "/bin/sh", "-c", "exec node server"])
})

test("installs the seccomp program from the inherited fd, after the env is cleared", () => {
  const args = buildBwrapArgs({ ...spec, seccompFd: 3 })
  const joined = args.join(" ")
  expect(joined).toContain("--seccomp 3")
  expect(joined.indexOf("--seccomp 3")).toBeGreaterThan(joined.indexOf("--clearenv"))
  expect(joined.indexOf("--seccomp 3")).toBeLessThan(joined.indexOf("--setenv"))
  expect(args.slice(-4)).toEqual(["--", "/bin/sh", "-c", "exec node server"])
  expect(buildBwrapArgs(spec)).not.toContain("--seccomp")
})
