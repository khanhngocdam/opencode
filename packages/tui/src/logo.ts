export const logo = {
  left: ["         ", "█▀▀▀ █▀▀█", "█___ █__█", "▀▀▀▀ ▀▀▀▀"],
  right: ["   ▄          ", "█▀▀█ █▀▀█ █__█", "█__█ █^^^ █__█", "▀▀▀▀ ▀▀▀▀  ▀▀ "],
}

// Codev brand palette (landing page --color-brand-navy / --color-brand-red). The wordmark is brand-locked rather
// than themed: "co" in navy on light and the theme text on dark, "dev" and the "c" badge always in red.
export const brand = {
  navy: "#19224c",
  red: "#ee0033",
}

// The wordmark with its shadow marks substituted to glyphs, split into halves so each takes its own brand color.
const substituteMarks = (line: string) =>
  Array.from(line, (char) =>
    char === "_" ? " " : char === "^" || char === "~" ? "▀" : char === "," ? "▄" : char,
  ).join("")
export const wordmarkHalves = logo.left.map((line, index) => ({
  left: substituteMarks(line),
  right: substituteMarks(logo.right[index] ?? ""),
}))

// The "c" of the wordmark as a flat outline, for narrow terminals and the mini splash.
export const badge = wordmarkHalves.slice(1).map((row) => row.left.slice(0, 4))

// Bold ANSI wordmark for plain terminal output. "co" keeps the default foreground because the banner cannot detect
// light vs dark; "dev" is brand red truecolor.
export function ansiWordmark(pad = "") {
  const reset = "\x1b[0m"
  const bold = "\x1b[1m"
  const red = "\x1b[1m\x1b[38;2;238;0;51m"
  return wordmarkHalves.map((row) => `${pad}${bold}${row.left}${reset} ${red}${row.right}${reset}`)
}

export const go = {
  left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],
  right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
}
