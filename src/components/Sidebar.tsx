import type { GuidanceResult } from '../types'
import type { FixitGuide } from '../services/ifixitApi'
import HudCard from './HudCard'

interface SidebarProps {
  guidance: GuidanceResult | null
  pending: boolean
  stepIndex: number
  onStepChange: (index: number) => void
  onScanAnother: () => void
  /** iFixit guide hits, passed through to the hosted HudCard. */
  guides?: FixitGuide[]
}

/**
 * Desktop guidance panel (D1/D2 matrix rows): the right-hand 1/3 beside the
 * feed, hosting the same HudCard content that is bottom-docked on mobile.
 * Scanner owns the guidance state; this panel only presents it.
 *
 * The hosted card stretches to the panel height (lifting its mobile 44dvh
 * cap via the child selector below) so long guidance scrolls inside the card
 * while Back/Next/Scan Another stay pinned. The 1/3 width plus the 480px cap
 * bounds line lengths at 1512px.
 */
export default function Sidebar({
  guidance,
  pending,
  stepIndex,
  onStepChange,
  onScanAnother,
  guides,
}: SidebarProps) {
  return (
    <aside
      aria-label="Repair guidance panel"
      className="flex min-h-0 w-1/3 max-w-[480px] shrink-0 flex-col gap-3 border-l border-white/10 bg-black p-4 [&>section]:min-h-0 [&>section]:max-h-none [&>section]:flex-1"
    >
      {guidance || pending ? (
        <HudCard
          guidance={guidance}
          pending={pending}
          stepIndex={stepIndex}
          onStepChange={onStepChange}
          onScanAnother={onScanAnother}
          guides={guides}
          sizingControls={false}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-white/10 bg-black/80 p-6 text-center">
          <div className="text-base font-semibold text-white">No part scanned yet</div>
          <p className="text-sm text-white/70">
            Point the camera at a part and ask about it — step-by-step guidance appears here.
          </p>
        </div>
      )}
    </aside>
  )
}
