import { useMemo, useState } from 'react'
import { chainCfg } from '../lib/chain/chains'

// Deployer-facing "get this basket listed & discoverable" helper (owner
// 2026-07-07). The token is already tradeable through any v4 router the moment
// it deploys, so DEX aggregators index it automatically; the value here is the
// TRACKER submissions (CoinGecko / CMC / explorer / DexScreener) that need a
// human to file them, and the copy-ready metadata to paste into each form.
//
// External submission URLs are the trackers' canonical request entry points
// (verified 2026-07-07); the real payload is the copyable metadata, which stays
// correct even if a form URL moves. Lives on the Token page (deployer-gated) and
// in the creator dashboard.

interface ListingTarget {
  label: string
  href: string
  note: string
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-white/[0.07] bg-black/25 px-3 py-2">
      <span className="w-20 shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink" title={value}>{value}</span>
      <button
        type="button"
        onClick={copy}
        className="press shrink-0 rounded-md border border-white/12 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim hover:border-cyan/50 hover:text-cyan"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

export function ListingPipeline({
  addr,
  symbol,
  name,
  decimals,
  chainId,
  className = '',
}: {
  addr: string
  symbol: string
  name: string
  decimals: number
  chainId: number
  className?: string
}) {
  const cfg = chainCfg(chainId)
  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  const pageUrl = `${origin}/token?addr=${addr}&chain=${chainId}`
  const tokenlistUrl = `${origin}/tokenlist.json`
  const logoUrl = `${origin}/og/${chainId}/${addr}.png`

  const targets = useMemo<ListingTarget[]>(
    () => [
      { label: 'CoinGecko', href: 'https://support.coingecko.com/hc/en-us/requests/new', note: 'Request a new listing (needs a public verification post)' },
      { label: 'CoinMarketCap', href: 'https://coinmarketcap.com/request/', note: 'Select “Add cryptoasset”' },
      { label: `${cfg.name === 'Ethereum' ? 'Etherscan' : 'Basescan'} token info`, href: `${cfg.explorer.replace(/\/$/, '')}/tokenupdate`, note: 'Add logo, links & socials to the explorer' },
      { label: 'DexScreener', href: 'https://marketplace.dexscreener.com/product/token-info', note: 'Enhance the token profile that traders see' },
    ],
    [cfg.name, cfg.explorer],
  )

  const detailsBlob = [
    `Name: ${name}`,
    `Symbol: ${symbol}`,
    `Contract: ${addr}`,
    `Chain: ${cfg.name} (chainId ${chainId})`,
    `Decimals: ${decimals}`,
    `Website: ${pageUrl}`,
    `Logo: ${logoUrl}`,
    `Token list: ${tokenlistUrl}`,
  ].join('\n')

  const [copiedAll, setCopiedAll] = useState(false)
  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(detailsBlob)
      setCopiedAll(true)
      window.setTimeout(() => setCopiedAll(false), 1600)
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <section className={`rounded-2xl border border-white/10 bg-white/[0.02] p-5 ${className}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-lg font-bold uppercase tracking-tight text-ink">Get ${symbol} listed</h3>
        <button
          type="button"
          onClick={copyAll}
          className="press rounded-lg border border-white/12 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-dim hover:border-cyan/50 hover:text-cyan"
        >
          {copiedAll ? 'Copied all ✓' : 'Copy all details'}
        </button>
      </div>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-dim">
        ${symbol} trades through any Uniswap v4 router the moment it&rsquo;s live, so DEX aggregators pick
        it up on their own. These trackers need you to file them once, with the details below.
      </p>

      <div className="mt-4 space-y-1.5">
        <CopyRow label="Contract" value={addr} />
        <CopyRow label="Token list" value={tokenlistUrl} />
        <CopyRow label="Logo" value={logoUrl} />
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {targets.map((t) => (
          <a
            key={t.label}
            href={t.href}
            target="_blank"
            rel="noopener noreferrer"
            className="press group flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/25 px-3.5 py-2.5 transition-colors hover:border-cyan/40"
          >
            <span className="min-w-0">
              <span className="block font-display text-sm font-bold uppercase tracking-wide text-ink">{t.label}</span>
              <span className="block truncate font-mono text-[10px] text-ink-faint">{t.note}</span>
            </span>
            <span aria-hidden className="shrink-0 text-ink-faint transition-colors group-hover:text-cyan">↗</span>
          </a>
        ))}
      </div>
    </section>
  )
}
