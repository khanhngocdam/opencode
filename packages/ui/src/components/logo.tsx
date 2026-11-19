import { type ComponentProps } from "solid-js"

// Codev "C" (block art `█▀▀▀ / █ / ▀▀▀▀`, the same glyph as the TUI badge and the app icon). It stays on
// --icon-strong-base because its side-panel call site is an opacity-10 watermark, where brand red reads as pink.
export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path data-slot="logo-mark-c" d="M0 0H16V4H4V16H16V20H0Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

// The same "C" at 80x100, brand-locked through --logo-splash in logo.css.
export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path data-slot="logo-splash-c" d="M0 0H80V20H20V80H80V100H0Z" fill="var(--logo-splash)" />
    </svg>
  )
}

// Lowercase "codev" wordmark: the TUI pixel glyphs (`wordmarkHalves` in packages/tui/src/logo.ts) on a 24x6 grid.
// "co" is brand navy on light and the theme foreground on dark, "dev" is always brand red (see logo.css).
export const Logo = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-wordmark"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 6"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <path
        data-slot="logo-wordmark-co"
        d="M0 1h4v1h-4zM5 1h4v1h-4zM0 2h1v3h-1zM5 2h1v3h-1zM8 2h1v3h-1zM0 5h4v1h-4zM5 5h4v1h-4z"
        fill="var(--logo-wordmark-co)"
      />
      <path
        data-slot="logo-wordmark-dev"
        d="M13 0h1v1h-1zM10 1h4v1h-4zM15 1h4v1h-4zM20 1h1v4h-1zM23 1h1v4h-1zM10 2h1v3h-1zM13 2h1v3h-1zM15 2h1v1h-1zM18 2h1v1h-1zM15 3h4v1h-4zM15 4h1v1h-1zM10 5h4v1h-4zM15 5h4v1h-4zM21 5h2v1h-2z"
        fill="var(--logo-wordmark-dev)"
      />
    </svg>
  )
}
