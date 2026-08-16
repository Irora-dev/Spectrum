// Fixed 48px header: wordmark · freshness · settings. Freshness is
// load-bearing, not decor — this surface renders a CACHE, and a stale number
// presented as live is the dishonesty this product avoids everywhere else.

import brand from '@app/brand.config'
import { ageLabel } from '../state'
import { MicroLabel, SpinnerArc } from './bits'

export function Header({
  snapshotAt,
  refreshing,
  onRefresh,
  onSettings,
  watching,
}: {
  snapshotAt: number | null
  refreshing: boolean
  onRefresh: () => void
  onSettings: () => void
  watching: boolean
}) {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="truncate font-display text-[14px] font-semibold uppercase tracking-[0.08em] text-ink">
          {brand.name}
        </span>
        <MicroLabel>lens</MicroLabel>
      </div>

      <div className="flex items-center gap-3">
        {watching && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            title={refreshing ? 'Reading chain…' : 'Refresh now'}
            className="press flex items-center gap-2 rounded-full border border-line bg-white/[0.03] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-line-bright hover:text-ink"
          >
            {refreshing ? (
              <>
                <SpinnerArc />
                <span>reading</span>
              </>
            ) : (
              <span>{snapshotAt ? `as of ${ageLabel(snapshotAt)}` : 'refresh'}</span>
            )}
          </button>
        )}
        <button
          type="button"
          onClick={onSettings}
          title="Settings"
          aria-label="Settings"
          className="press grid h-7 w-7 place-items-center rounded-full text-ink-dim hover:text-ink"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
            <path
              d="M8 5.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2Zm5.5 2.6c0-.4 0-.8-.1-1.1l1.3-1-1.1-1.9-1.6.5a5 5 0 0 0-1.9-1.1L9.8 1.7H7.6l-.3 1.7a5 5 0 0 0-1.9 1.1l-1.6-.5-1.1 1.9 1.3 1a5.6 5.6 0 0 0 0 2.2l-1.3 1 1.1 1.9 1.6-.5a5 5 0 0 0 1.9 1.1l.3 1.7h2.2l.3-1.7a5 5 0 0 0 1.9-1.1l1.6.5 1.1-1.9-1.3-1c.1-.3.1-.7.1-1.1Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </header>
  )
}

/** Failed reads are named, never rendered as zeros: the figures above simply
 *  don't include the failed chain, and this strip says exactly that. */
export function DegradedNote({ chainsFailed, labels }: { chainsFailed: number[]; labels: (id: number) => string }) {
  if (chainsFailed.length === 0) return null
  const names = chainsFailed.map(labels).join(', ')
  return (
    <div className="flex items-center gap-2 border-b border-line bg-alert/[0.06] px-4 py-2">
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-alert" />
      <p className="font-mono text-[10px] leading-relaxed text-ink-dim">
        {names} read failed. Its holdings are missing from these figures, and drift and value alerts
        pause until every chain answers. Retrying on the next check.
      </p>
    </div>
  )
}

/** Whole checks are failing (the worker is backing off). An ever-aging
 *  freshness pill with no explanation would be a lie of omission — this strip
 *  is the explanation. */
export function FailingNote({ failures, snapshotAt }: { failures: number; snapshotAt: number }) {
  if (failures === 0) return null
  return (
    <div className="flex items-center gap-2 border-b border-line bg-alert/[0.06] px-4 py-2">
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-alert" />
      <p className="font-mono text-[10px] leading-relaxed text-ink-dim">
        The last {failures === 1 ? 'check' : `${failures} checks`} failed. Showing the last good read
        (as of {ageLabel(snapshotAt)}), backing off, then retrying.
      </p>
    </div>
  )
}
