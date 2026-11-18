import { expect, test } from "bun:test"
import {
  manifestImageKey,
  parseSandboxManifest,
  parseWslInstallerManifest,
  requireImageAsset,
  requireWslInstallerAsset,
} from "./manifest"

const asset = (name: string) => ({
  url: `https://example.test/sandbox/${name}`,
  sha256: "a".repeat(64),
  bytes: 1024,
})

const validManifest = {
  schema: 1,
  imageVersion: "2026.08.1",
  images: {
    "vz-arm64": asset("vz-arm64.img"),
    "bwrap-x64": asset("bwrap-x64.tar"),
  },
  wslInstaller: {
    version: "2.7.11",
    recommendedMinBuild: 19045,
    assets: { x64: asset("wsl.x64.msi") },
  },
}

test("parses a valid manifest", () => {
  const manifest = parseSandboxManifest(validManifest)
  expect(manifest.imageVersion).toBe("2026.08.1")
  expect(requireImageAsset(manifest, "vz", "arm64").url).toContain("vz-arm64.img")
  expect(manifest.wslInstaller?.recommendedMinBuild).toBe(19045)
})

test("normalizes sha256 digests to lowercase", () => {
  const manifest = parseSandboxManifest({
    ...validManifest,
    images: { "bwrap-x64": { ...asset("x"), sha256: "A".repeat(64) } },
    wslInstaller: null,
  })
  expect(requireImageAsset(manifest, "bwrap", "x64").sha256).toBe("a".repeat(64))
})

test("wslInstaller is optional", () => {
  expect(parseSandboxManifest({ ...validManifest, wslInstaller: null }).wslInstaller).toBe(null)
  const withoutInstaller = { ...validManifest } as Record<string, unknown>
  delete withoutInstaller.wslInstaller
  expect(parseSandboxManifest(withoutInstaller).wslInstaller).toBe(null)
})

test("rejects manifests with the wrong shape", () => {
  expect(() => parseSandboxManifest(null)).toThrow("must be an object")
  expect(() => parseSandboxManifest({ ...validManifest, schema: 2 })).toThrow("unsupported sandbox manifest schema")
  expect(() => parseSandboxManifest({ ...validManifest, imageVersion: "" })).toThrow("missing imageVersion")
  expect(() =>
    parseSandboxManifest({ ...validManifest, images: { "vz-arm64": { ...asset("x"), url: "http://insecure" } } }),
  ).toThrow("needs an https url")
  expect(() =>
    parseSandboxManifest({ ...validManifest, images: { "vz-arm64": { ...asset("x"), sha256: "beef" } } }),
  ).toThrow("needs a sha256 hex digest")
  expect(() => parseSandboxManifest({ ...validManifest, images: { "vz-arm64": { ...asset("x"), bytes: 0 } } })).toThrow(
    "needs a positive byte size",
  )
})

test("names missing images by backend and arch", () => {
  const manifest = parseSandboxManifest(validManifest)
  expect(() => requireImageAsset(manifest, "wsl", "x64")).toThrow("no image for wsl-x64")
  expect(manifestImageKey("wsl", "arm64")).toBe("wsl-arm64")
})

test("the standalone WSL installer manifest parses and requires a digest", () => {
  const manifest = parseWslInstallerManifest({
    schema: 1,
    version: "2.7.11",
    recommendedMinBuild: 19041,
    assets: {
      x64: { url: "https://example.test/wsl.2.7.11.0.x64.msi", sha256: "b".repeat(64), bytes: 258990080 },
      arm64: { url: "https://example.test/wsl.2.7.11.0.arm64.msi", sha256: "c".repeat(64), bytes: 257032192 },
    },
  })
  expect(manifest.version).toBe("2.7.11")
  expect(requireWslInstallerAsset(manifest, "arm64").bytes).toBe(257032192)
  // An arch we publish nothing for must throw, so the caller falls back to
  // Microsoft's installer rather than staging a file that does not exist.
  expect(() => requireWslInstallerAsset({ ...manifest, assets: {} }, "x64")).toThrow("x64")
})

test("an installer manifest without digests is refused", () => {
  expect(() =>
    parseWslInstallerManifest({
      schema: 1,
      version: "2.7.11",
      recommendedMinBuild: 19041,
      assets: { x64: { url: "https://example.test/wsl.msi", bytes: 10 } },
    }),
  ).toThrow("sha256")
})

// The image manifest is regenerated on every image publish with wslInstaller
// null, which is why the installers carry their own document instead.
test("an unknown installer manifest schema is refused", () => {
  expect(() =>
    parseWslInstallerManifest({ schema: 2, version: "2.7.11", recommendedMinBuild: 19041, assets: {} }),
  ).toThrow("schema")
})
