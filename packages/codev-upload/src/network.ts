import { execFileSync } from "node:child_process"

// macOS project dirs on a network share (SMB/AFP/NFS/...) can hang
// realpathSync for as long as the mount is unreachable. The stats reader
// names projects without resolving those — see projectFolderName's resolve
// option. Other platforms never report a network dir.

const NETWORK_FS_TYPES = new Set(["smbfs", "afpfs", "nfs", "webdav", "ftp", "autofs"])
// The firmlinked data volume: the mount table lists /System/Volumes/Data/...
// while sessions record the user-facing path without that prefix.
const DATA_VOLUME = "/System/Volumes/Data"

export function networkVolumeFilter(
  platform: NodeJS.Platform = process.platform,
  readMounts: () => string = () => execFileSync("/sbin/mount", { encoding: "utf8", timeout: 5000 }),
): (dir: string) => boolean {
  if (platform !== "darwin") return () => false
  let table: string
  try {
    table = readMounts()
  } catch {
    return () => false
  }
  const roots = parseNetworkMounts(table).flatMap((mount) =>
    mount.startsWith(`${DATA_VOLUME}/`) ? [mount, mount.slice(DATA_VOLUME.length)] : [mount],
  )
  return (dir) => roots.some((root) => dir === root || dir.startsWith(`${root}/`))
}

// `mount` lines look like "//user@host/share on /Volumes/share (smbfs, ...)".
export function parseNetworkMounts(table: string): string[] {
  return table.split("\n").flatMap((line) => {
    const match = / on (.+) \(([^,)]+)/.exec(line)
    if (!match?.[1] || !match[2] || !NETWORK_FS_TYPES.has(match[2].trim())) return []
    return [match[1]]
  })
}
