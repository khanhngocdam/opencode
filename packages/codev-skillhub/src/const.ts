// Mirrors the hub's src/lib/const.ts (skill-relevant slice). The base host is
// base64-obfuscated to keep it out of trivial greps, matching the hub and the
// landing-page convention for netmind hosts.
const BASE_URL = atob("aHR0cHM6Ly9uZXRtaW5kLnZpZXR0ZWwudm4=")

export const SKILLHUB_URL = `${BASE_URL}/netmindhub`

// The codev-storage MinIO backend, reached through the shared reverse proxy's
// /codev-storage route. The codev-office bucket holds the CoDev Office offline
// skill bundles + setup scripts (deterministic names, see office.ts), all
// anonymous read-only.
export const OFFICE_DOWNLOADS_URL = `${BASE_URL}/codev-storage/codev-office`
