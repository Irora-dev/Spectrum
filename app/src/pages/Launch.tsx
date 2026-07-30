import type { CSSProperties } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { BasketBuilder } from '../components/launch/BasketBuilder'

export function Launch() {
  const [params] = useSearchParams()
  const from = params.get('from') ?? undefined
  const fromChain = Number(params.get('chain')) || undefined
  const isVersion = !!from

  return (
    <div className="space-y-8">
      <header className="relative mx-auto max-w-5xl overflow-hidden rounded-3xl border border-white/10 bg-white/[0.02] px-6 py-8 backdrop-blur-md sm:px-8 sm:py-9">
        {/* aurora */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute -left-20 -top-24 h-64 w-64 rounded-full bg-cyan/15 blur-[110px]" />
          <div className="absolute right-0 -top-16 h-56 w-56 rounded-full bg-violet/15 blur-[120px]" />
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
        </div>

        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-10">
          <div className="enter" style={{ '--enter-i': 0 } as CSSProperties}>
            {/* bespoke layout, canonical type (see PageHeader — lg tier) */}
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
              {isVersion ? 'New version' : 'Create a basket'}
            </div>
            <h1 className="mt-3 font-display text-5xl font-bold uppercase leading-[0.95] tracking-tight text-ink sm:text-6xl">
              {isVersion ? (
                <>New<br />Version</>
              ) : (
                <>Launch<br />a Basket</>
              )}
            </h1>
          </div>
          <div className="enter flex flex-col items-start gap-3 sm:items-end" style={{ '--enter-i': 1 } as CSSProperties}>
            <p className="text-sm leading-relaxed text-ink-dim sm:text-right">
              {isVersion ? (
                'Edit the prefilled basket below and deploy it as a new, separate immutable version. The original stays live and unchanged; holders move only if they choose to.'
              ) : (
                <>
                  <span className="block sm:whitespace-nowrap">Pick tokens, weight them, set your fee, deploy.</span>
                  <span className="block sm:whitespace-nowrap">No management fee, ever.</span>
                </>
              )}
            </p>
            {/* the Composer as a creator TOOL off the launch page (owner 2026-07-29:
                it left the primary nav; this is now its front door) */}
            {!isVersion && (
              <Link
                to="/compose"
                title="The Composer is the research bench: build a candidate mix, see how it would have performed as one basket, and hand it to this launch flow prefilled."
                className="rounded-lg border border-white/12 px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-dim press hover:border-cyan/50 hover:text-cyan"
              >
                Not sure about the mix? Open the Composer ⓘ
              </Link>
            )}
          </div>
        </div>
      </header>
      <BasketBuilder predecessor={from} predecessorChainId={fromChain} />
    </div>
  )
}
