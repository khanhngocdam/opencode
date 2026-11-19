import { type ColorInput, TextAttributes } from "@opentui/core"
import { For } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme, useThemes } from "../context/theme"
import { badge, brand, wordmarkHalves } from "../logo"

// Brand-locked like the landing page wordmark: "co" navy on light and the theme text on dark, "dev" red, no shadow.
export function Logo() {
  const theme = useTheme()
  const themes = useThemes()
  const dimensions = useTerminalDimensions()
  const co = () => (themes.mode() === "light" ? brand.navy : theme.text.base)
  const line = (text: string, fg: ColorInput) => (
    <text fg={fg} attributes={TextAttributes.BOLD} selectable={false}>
      {text}
    </text>
  )

  return (
    <box>
      {dimensions().height < 12 ? null : dimensions().width < 22 ? (
        <For each={badge}>{(row) => line(row, brand.red)}</For>
      ) : dimensions().width < 44 ? (
        <>
          <For each={wordmarkHalves.slice(1)}>{(row) => line(row.left, co())}</For>
          <For each={wordmarkHalves}>{(row) => line(row.right, brand.red)}</For>
        </>
      ) : (
        <For each={wordmarkHalves}>
          {(row) => (
            <box flexDirection="row" gap={1}>
              {line(row.left, co())}
              {line(row.right, brand.red)}
            </box>
          )}
        </For>
      )}
    </box>
  )
}
