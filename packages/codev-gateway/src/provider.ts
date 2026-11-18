// The provider identities CoDev Code writes into the global codev.json —
// mirrors the hub's src/lib/provider.ts so hub-managed and self-configured
// installs stay indistinguishable.

export interface ProviderIdentity {
  id: string
  name: string
}

// SSO-issued gateway keys (the configure gate's SSO flow, including the
// manual-paste branch for accounts without a provisioned key).
export const GATEWAY_PROVIDER: ProviderIdentity = {
  id: "aigw",
  name: "AIGW",
}

// The SSO identity before the AIGW rename. Recognition-only: the candidate
// sets (config attribution, the inline-key migration, the upload readers)
// still match it and the desktop's silent key refresh re-keys it, but nothing
// writes new config blocks under this id any more — pre-rename installs keep
// working and converge on the new id at their next full config rewrite.
export const LEGACY_GATEWAY_PROVIDER_IDS: string[] = ["netgate"]

// The custom-provider flow's fallback, used when the user leaves the provider
// name blank or types something that yields no usable id.
export const CUSTOM_FALLBACK_PROVIDER: ProviderIdentity = {
  id: "ai-gateway",
  name: "AI Gateway",
}

const MAX_ID_LENGTH = 32

// The charset is deliberately [a-z0-9-]: slash-free so the top-level
// "<id>/<model>" string stays parseable, and TOML-bare-key safe for the hub's
// codex writer. Returns "" when the name yields nothing usable (e.g. all
// punctuation), which callers read as "fall back to the default identity".
export function slugifyProviderName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_ID_LENGTH)
    .replace(/-+$/, "") // second trim: the 32-char cut can land on a dash
}

// Custom-provider flow: turn what the user typed into the pair we write.
export function providerFromName(name: string): ProviderIdentity {
  const id = slugifyProviderName(name)
  if (!id) return CUSTOM_FALLBACK_PROVIDER
  return { id, name: name.trim() }
}
