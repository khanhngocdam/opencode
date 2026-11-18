export type SandboxPreviewAvailability = { supported: false; reason: string }

const platforms = new Set(["linux", "win32", "darwin"])

/**
 * Codev2 preview status of the Work sandbox. It never boots a VM: the guest v2
 * server image does not exist yet, so the UI can only show "coming soon".
 */
export function sandboxPreviewAvailability(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): SandboxPreviewAvailability {
  const enabled = (env.OPENCODE_FLAGS ?? "")
    .split(",")
    .map((key) => key.trim())
    .includes("codev_sandbox")
  if (enabled && platforms.has(platform)) return { supported: false, reason: "guest v2 server image pending" }
  return { supported: false, reason: "Codev2 Work sandbox is not enabled on this preview build" }
}
