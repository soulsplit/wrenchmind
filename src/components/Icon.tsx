/** Stroke icon; the accessible name always comes from the owning button. */
export function Icon({ d }: { d: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-6 w-6"
    >
      <path d={d} />
    </svg>
  )
}

/** Three filled dots for overflow triggers. */
export function Dots() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" className="h-6 w-6">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  )
}

export const CHEVRON_UP = 'M18 15l-6-6-6 6'
export const CHEVRON_DOWN = 'M6 9l6 6 6-6'
export const EXPAND_CORNERS = 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5'
export const SHRINK_CORNERS = 'M9 4v5H4 M15 4v5h5 M9 20v-5H4 M15 20v-5h5'
export const PAUSE_BARS = 'M9 5v14 M15 5v14'
export const FLASHLIGHT =
  'M10 9h4v11a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1V9z M7 3h10l-1.5 6h-7L7 3z M4.5 5.5 3 4 M19.5 5.5 21 4'
