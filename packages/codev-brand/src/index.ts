export const PRODUCT_NAME = "Codev Code 2.0"
export const COMMAND_NAME = "codev2"
/** Unscoped npm package name for public CLI releases (like v1 `codev-code`). */
export const PACKAGE_NAME = "codev2-code"
// Base64 (like codev-gateway's const.ts) to keep the host out of casual greps,
// not as a secret — the decoded URL ships in the system prompt the model reads.
export const DOCS_URL = atob("aHR0cHM6Ly9uZXRtaW5kLnZpZXR0ZWwudm4vY29kZXYvZW4vZG9jcy9jb2Rl")
export const REPO_URL = "https://github.com/khanhngocdam/opencode"
export const ISSUES_URL = "https://github.com/khanhngocdam/opencode/issues"

// Upstream names that must survive verbatim. Package ids and the config JSON
// Schema URL are real identifiers the fork deliberately keeps (see "Known
// rebrand gaps" in DIVERGENCES.md), so a blind rename would break the model's
// advice: it would tell users to `import "@codev/plugin"` or point their editor
// at a schema URL that does not exist. Trade-off: prose that hyphenates the
// upstream name ("opencode-managed") is preserved too and stays upstream-branded.
const PRESERVED =
  /(https:\/\/github\.com\/khanhngocdam\/opencode(?:\/[^\s]*)?|@opencode(?:-ai)?\/[\w.-]+|https:\/\/opencode\.ai\/config\.json|opencode-[\w][\w.@-]*|opencode:\/\/|ai\.opencode\.[\w]+|api\.opencode\.ai|opencode\.ai\/(?:zen|go|auth|s\/|changelog\.json)|opencode\.db|opencode\.jsonc?|\.opencode\b)/g

// Longest match first: the URL rules have to consume their hosts before the
// bare-name rule can rewrite the word inside them.
const RULES: readonly (readonly [RegExp, string])[] = [
  [/https:\/\/github\.com\/anomalyco\/opencode\/issues/g, ISSUES_URL],
  [/https:\/\/github\.com\/anomalyco\/opencode/g, REPO_URL],
  [/https:\/\/opencode\.ai(?:\/docs)?/g, DOCS_URL],
  [/\bopencode\.ai\b/g, DOCS_URL.replace("https://", "")],
  [/\bopencode\.jsonc\b/g, "opencode.jsonc"],
  [/\bopencode\.json\b/g, "opencode.json"],
  [/\.opencode\b/g, ".opencode"],
  // Command invocations keep the binary name; everything else is the product name.
  [
    /\bopencode (?=(?:auth|run|serve|models|agent|plugin|mcp|upgrade|tui|github|configure|codegraph|debug|stats)\b)/g,
    `${COMMAND_NAME} `,
  ],
  [/\bOpenCode\b/g, PRODUCT_NAME],
  [/\bopencode\b/g, PRODUCT_NAME],
]

// Inputs are module-level prompt constants and tool descriptions, so the key
// space is bounded by the number of distinct prompts loaded in a process.
const cache = new Map<string, string>()

// `split` on a regex with one capture group interleaves the matched spans at odd
// indices, so preserved names pass through without ever being offered to RULES.
const partition = (text: string) => text.split(PRESERVED)

/** Rewrite upstream product names in model-visible text to the fork's. */
export function rebrand(text: string) {
  const cached = cache.get(text)
  if (cached !== undefined) return cached
  const result = RULES.reduce(
    (value, [pattern, replacement]) =>
      partition(value)
        .map((part, index) => (index % 2 === 1 ? part : part.replace(pattern, replacement)))
        .join(""),
    text,
  )
  cache.set(text, result)
  return result
}

/**
 * Lines still carrying the upstream name after {@link rebrand}, ignoring
 * preserved identifiers. The guard test fails on a non-empty result, so an
 * upstream sync that introduces a new brand phrasing surfaces as a test failure
 * instead of shipping silently.
 */
export function brandLeaks(text: string) {
  return partition(rebrand(text))
    .filter((_, index) => index % 2 === 0)
    .flatMap((part) => part.split("\n").filter((line) => /opencode/i.test(line)))
}
