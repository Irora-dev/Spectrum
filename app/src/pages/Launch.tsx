import type { CSSProperties } from 'react'
import { useSearchParams } from 'react-router-dom'
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
              {isVersion ? 'New Version' : 'Launch a Basket'}
            </h1>
          </div>
          <p className="enter max-w-md text-pretty text-sm leading-relaxed text-ink-dim sm:text-right sm:text-balance" style={{ '--enter-i': 1 } as CSSProperties}>
            {isVersion
              ? 'Edit the prefilled basket below and deploy it as a new, separate immutable version. The original stays live and unchanged; holders move only if they choose to.'
              : 'Pick a set of tokens, weight it, set your fee config, and deploy one basket token. Mints settle straight into the pool, and there is no management fee.'}
          </p>
        </div>
      </header>
      <BasketBuilder predecessor={from} predecessorChainId={fromChain} />
    </div>
  )
}
