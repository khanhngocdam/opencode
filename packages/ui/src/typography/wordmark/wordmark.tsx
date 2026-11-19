import { createUniqueId, type ComponentProps } from "solid-js"

// Codev: the lowercase "codev" wordmark on the 24x6 pixel grid of packages/ui/src/components/logo.tsx, one outline
// path per letter so the outline draw animation still traces each glyph.
export function Wordmark(
  props: Pick<ComponentProps<"svg">, "class"> & { fade?: boolean; muted?: boolean; outline?: boolean },
) {
  const mask = createUniqueId()
  const maskGradient = createUniqueId()

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 6"
      fill="none"
      classList={{
        [props.class ?? ""]: !!props.class,
        "overflow-visible [&_path]:[vector-effect:non-scaling-stroke]": props.outline,
      }}
    >
      <g opacity={props.muted === false ? 1 : 0.6} class="[[data-color-scheme=dark]_&]:opacity-100">
        <g mask={props.fade === false ? undefined : `url(#${mask})`}>
          <g
            opacity={props.muted === false ? 1 : 0.16 * 0.7}
            fill={props.outline ? "none" : "currentColor"}
            stroke={props.outline ? "currentColor" : undefined}
            stroke-width={props.outline ? 1 : undefined}
          >
            <path pathLength={props.outline ? 1 : undefined} d="M0 1H4V2H1V5H4V6H0Z" />
            <path pathLength={props.outline ? 1 : undefined} d="M5 1H9V6H5ZM6 2V5H8V2Z" />
            <path pathLength={props.outline ? 1 : undefined} d="M10 1H13V0H14V6H10ZM11 2V5H13V2Z" />
            <path pathLength={props.outline ? 1 : undefined} d="M15 1H19V4H16V5H19V6H15ZM16 2V3H18V2Z" />
            <path pathLength={props.outline ? 1 : undefined} d="M20 1H21V5H20ZM23 1H24V5H23ZM21 5H23V6H21Z" />
          </g>
        </g>
      </g>
      <defs>
        <mask id={mask} style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="6">
          <rect width="24" height="6" fill={`url(#${maskGradient})`} />
        </mask>
        <linearGradient id={maskGradient} x1="12" y1="3.163" x2="12" y2="6" gradientUnits="userSpaceOnUse">
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
