import { expect, test } from "bun:test"
import { mountGuestName, resolveGuestMounts, validateMountPaths } from "./mounts"

test("guest name is the sanitized basename", () => {
  expect(mountGuestName("/home/user/my repo", new Set())).toBe("my-repo")
  expect(mountGuestName("/home/user/docs/", new Set())).toBe("docs")
  expect(mountGuestName("C:\\Users\\dev\\Notes", new Set())).toBe("Notes")
  expect(mountGuestName("/home/user/.config", new Set())).toBe("config")
})

test("guest name falls back and dedupes", () => {
  expect(mountGuestName("/héllo/世界", new Set())).toBe("folder")
  expect(mountGuestName("/a/data", new Set(["data"]))).toBe("data-2")
  expect(mountGuestName("/b/data", new Set(["data", "data-2"]))).toBe("data-3")
})

test("guest name keeps the virtiofs tag under its 36-byte cap", () => {
  const name = mountGuestName(`/deep/${"x".repeat(80)}`, new Set())
  expect(name.length).toBeLessThanOrEqual(24)
  expect(`mnt-${name}-99`.length).toBeLessThanOrEqual(36)
})

test("resolveGuestMounts maps to /mnt paths with stable in-order dedup", () => {
  const resolved = resolveGuestMounts([{ path: "/a/data" }, { path: "/b/data" }, { path: "/c/other" }])
  expect(resolved).toEqual([
    { path: "/a/data", guestName: "data", guestPath: "/mnt/data", tag: "mnt-data" },
    { path: "/b/data", guestName: "data-2", guestPath: "/mnt/data-2", tag: "mnt-data-2" },
    { path: "/c/other", guestName: "other", guestPath: "/mnt/other", tag: "mnt-other" },
  ])
})

test("validateMountPaths accepts distinct sibling folders", () => {
  expect(validateMountPaths("/home/user/project", [{ path: "/home/user/docs" }, { path: "/srv/data" }])).toBeNull()
})

test("validateMountPaths rejects duplicates, case-insensitively for Windows paths", () => {
  expect(validateMountPaths("/p", [{ path: "/a" }, { path: "/a/" }])).toEqual({ code: "duplicate", path: "/a/" })
  expect(validateMountPaths("C:\\p", [{ path: "C:\\Data" }, { path: "c:\\data" }])).toEqual({
    code: "duplicate",
    path: "c:\\data",
  })
  // Unix paths stay case-sensitive.
  expect(validateMountPaths("/p", [{ path: "/a/Data" }, { path: "/a/data" }])).toBeNull()
})

test("validateMountPaths rejects nesting in either direction", () => {
  expect(validateMountPaths("/home/user/project", [{ path: "/home/user/project/src" }])).toEqual({
    code: "nested",
    path: "/home/user/project/src",
    other: "/home/user/project",
  })
  expect(validateMountPaths("/home/user/project", [{ path: "/home/user" }])).toEqual({
    code: "nested",
    path: "/home/user",
    other: "/home/user/project",
  })
  expect(validateMountPaths("/p", [{ path: "/data" }, { path: "/data/sub" }])).toEqual({
    code: "nested",
    path: "/data/sub",
    other: "/data",
  })
  // Shared prefixes without a separator boundary are not nesting.
  expect(validateMountPaths("/p", [{ path: "/data" }, { path: "/database" }])).toBeNull()
})

test("validateMountPaths rejects nesting against a Windows project dir", () => {
  expect(validateMountPaths("C:\\Users\\dev\\proj", [{ path: "c:\\users\\dev\\proj\\docs" }])).toEqual({
    code: "nested",
    path: "c:\\users\\dev\\proj\\docs",
    other: "C:\\Users\\dev\\proj",
  })
})

test("validateMountPaths rejects UNC paths", () => {
  expect(validateMountPaths("C:\\p", [{ path: "\\\\server\\share" }])).toEqual({
    code: "unc",
    path: "\\\\server\\share",
  })
})
