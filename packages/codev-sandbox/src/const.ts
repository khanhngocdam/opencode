// Base64 (matching @codev/brand and codev-gateway convention) keeps the
// storage host out of casual greps — not a secret; the decoded URLs are
// user-visible at download time.
const STORAGE_BASE = atob("aHR0cHM6Ly9uZXRtaW5kLnZpZXR0ZWwudm4vY29kZXYtc3RvcmFnZQ==")

export const SANDBOX_IMAGES_BASE_URL = `${STORAGE_BASE}/codev/sandbox`

export const SANDBOX_MANIFEST_URL = `${SANDBOX_IMAGES_BASE_URL}/manifest.json`

// mc uploads take an object key, not a URL, and CODEV_STORAGE_TARGET already
// carries the alias and bucket — so the key is the URL path minus its first
// segment (the bucket). Deriving the publish destination from the same
// constant clients read is what keeps a prefix move from updating one side
// only: when the bucket went codev-code/sandbox → codev/sandbox the publish
// script kept uploading to the old prefix, which reads 403, so a publish
// appeared to succeed while the manifest clients fetch never changed.
export function sandboxStorageObjectKey(url: string) {
  return new URL(url).pathname.split("/").filter(Boolean).slice(1).join("/")
}

// WSL MSI installers mirrored for corporate networks where only the storage
// host is whitelisted; the Microsoft `wsl --install` path stays as fallback.
export const INSTALLERS_BASE_URL = `${STORAGE_BASE}/installers`

// The WSL install bundle is one hand-uploaded zip so a corporate whitelist
// rule covers a single URL. The member names are part of the contract: the
// install flow extracts them from the zip by exact name. The MSI carries the
// pinned WSL runtime version in its filename; the .wsl file is the Ubuntu
// distro image for the WSL servers feature (`wsl --install --from-file`),
// not the sandbox rootfs, which ships via the image manifest instead.
export const WSL_INSTALLER_ZIP_URL = `${INSTALLERS_BASE_URL}/wsl.zip`
export const WSL_DISTRO_IMAGE_NAME = "ubuntu-24.04.4-wsl-amd64.wsl"

// The WSL runtime installers, published under the same `/codev` prefix as the
// sandbox images rather than beside wsl.zip: that zip is already uploaded at
// the older path, and moving it would break the distro install for no gain.
//
// Bare MSIs rather than a second zip because the sandbox needs only the
// runtime — it brings its own rootfs and its own server — so there is nothing
// to bundle alongside and nothing to extract. It is also what makes ARM64
// reachable at all: the zip is x64-only.
export const WSL_INSTALLERS_BASE_URL = `${STORAGE_BASE}/codev/installers/wsl`

// The pointer every client reads. Unversioned, like the image manifest, with
// the installers themselves under a per-version directory it names — so
// bumping WSL is an upload, not an app release, and the version pin lives with
// the files instead of in this file.
export const WSL_INSTALLER_MANIFEST_URL = `${WSL_INSTALLERS_BASE_URL}/manifest.json`

// Where a given version's installers live. The manifest carries absolute URLs,
// so this is only used when building one.
export function wslInstallerAssetUrl(version: string, arch: "x64" | "arm64") {
  return `${WSL_INSTALLERS_BASE_URL}/${version}/wsl.${version}.0.${arch}.msi`
}
