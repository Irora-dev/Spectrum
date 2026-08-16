import type { DeployStatus } from '../../lib/spectrum/use-deploy'
import { deployVerdict } from './deploy-flow-signals'

// ─────────────────────────────────────────────────────────────────────────────
// THE PRE-DEPLOY VERDICT, VISIBLE (the owner 2026-08-13, greenlit).
//
// The flow has always simulated before letting a wallet sign — reaching `ready`
// requires a successful simulateContract of the real deploy call. It just never
// said so, so the creator's last moment before spending gas looked identical
// whether the chain had agreed or nobody had asked it.
//
// The confidence here is earned, not decorative: "simulated" is a report of
// something that already happened. Everything else says what is actually going
// on, and a refusal quotes the chain rather than guessing at it.
// ─────────────────────────────────────────────────────────────────────────────

const DRESS: Record<string, string> = {
  working: 'border-white/12 bg-white/[0.03] text-ink-dim',
  simulated: 'border-teal/40 bg-teal/[0.07] text-teal',
  refused: 'border-amber/40 bg-amber/[0.06] text-amber',
}

const MARK: Record<string, string> = { working: '…', simulated: '✓', refused: '⚠' }

export function DeployVerdictLine({
  status,
  error,
  cause,
  className = '',
}: {
  status: DeployStatus
  error?: string | null
  cause?: unknown
  className?: string
}) {
  const v = deployVerdict({ status, error, cause })
  if (v.tone === 'none') return null
  return (
    <p
      role="status"
      className={`flex items-start gap-2 rounded-xl border px-3.5 py-2.5 font-mono text-[11px] leading-relaxed ${DRESS[v.tone]} ${className}`}
    >
      <span aria-hidden className="shrink-0">
        {MARK[v.tone]}
      </span>
      <span className="min-w-0">{v.line}</span>
    </p>
  )
}
