// /chat — talk to the baskets. A conversational surface over the app's own
// money plumbing: the agent (components/chat/agent.ts) parses plain language,
// reads the chain through the same modules every page uses, and answers with
// REAL surfaces — the live trade card embedded in a bubble, basket tables,
// a prepped composer link. The mascot above the sheet is the site's face for
// it (sprite state machine per the owner's 2026-08-19 animation spec).
//
// Owner's reference layout (2026-08-19): mascot floating over a starfield,
// glass sheet with rounded top, avatar header, bubbles, pill input. Rebuilt
// here in the site's own tokens (white-alpha plates, ink text, the brand
// gradient) so the light-mode preset re-inks it like every other surface.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import type { Address } from 'viem'
import { ChatMascot, MASCOT_ANIM, preloadMascot, type MascotHandle } from '../components/chat/ChatMascot'
import { playSfx, preloadSfx, setSfxEnabled, sfxEnabled } from '../components/chat/sfx'
import mascotIdle from '../assets/mascot/f9.png'
import chatPaperBg from '../assets/chat-paper-bg.webp'
import type { AgentAction } from '../components/chat/agent'
import { CHIPS, stampOf, useChatSession, useStickyScroll, type Msg, type Stage } from '../components/chat/useChatSession'
import { DexSwapCard } from '../components/DexSwapCard'
import { DeployCard } from '../components/chat/DeployCard'
import { BundleCard } from '../components/chat/BundleCard'
import { ClaimCard } from '../components/chat/ClaimCard'
import { MultiBuyCard } from '../components/chat/MultiBuyCard'
import { VersionCard } from '../components/chat/VersionCard'
import { CrossChainDraftCard } from '../components/chat/CrossChainDraftCard'
import { RedeemCard } from '../components/chat/RedeemCard'
import { ThesisCard } from '../components/chat/ThesisCard'
import { ProfileCard } from '../components/chat/ProfileCard'
import { AssetPickerCard } from '../components/chat/AssetPickerCard'
import { MigrateModal } from '../components/MigrateModal'
import { CopyRow, cheerSpecter } from '../components/chat/CopyRow'
import { WalletButton } from '../components/WalletButton'
import { BasketAvatar } from '../components/BasketAvatar'
import { BasketBento } from '../components/BasketBento'
import { BasketSpark } from '../components/BasketSpark'
import { BlueprintBasket } from '../components/BlueprintBasket'
import { SpectrumLoader } from '../components/SpectrumLoader'
import sealViolet from '../assets/seals/seal-violet.webp'
import sealTeal from '../assets/seals/seal-teal.webp'
import sealAmber from '../assets/seals/seal-amber.webp'
import sealRainbow from '../assets/seals/seal-rainbow.webp'
import { listBasketsForChain } from '../lib/spectrum/basket-data'
import { showSymbol } from '../lib/spectrum/safe-copy'
import { CHAINS } from '../lib/chain/chains'
import type { BasketData } from '../lib/spectrum/basket-data'
import { WALLET_ENABLED } from '../lib/config/features'

const GRADIENT = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

// Msg/stampOf/CHIPS/chipsFor + the whole conversational session live in the
// shared hook (owner 2026-08-20: the site-wide widget mounts the SAME
// machinery as this page, never a copy) — see components/chat/useChatSession.

// ── message renderers ─────────────────────────────────────────────────────────

function AgentText({ text }: { text: string }) {
  // break-words: a pasted 0x address in a sentence must wrap, never widen the
  // thread (the widget's no-horizontal-scroll law, owner 2026-08-20)
  return <p className="max-w-[62ch] whitespace-pre-line break-words text-sm leading-relaxed text-ink">{text}</p>
}

/** The in-bubble rail: horizontal snap strip with faded edges — long answers
 *  spend WIDTH, not height (owner 2026-08-19: list replies should read
 *  carousel-y, not a tower). Native drag/wheel scroll; scrollbar hidden. */
function ChatRail({ children }: { children: ReactNode }) {
  const railRef = useRef<HTMLDivElement>(null)
  const [can, setCan] = useState({ left: false, right: false })
  const measure = () => {
    const el = railRef.current
    if (!el) return
    setCan({ left: el.scrollLeft > 8, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 8 })
  }
  useEffect(() => {
    measure()
    const el = railRef.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children])
  const nudge = (dir: 1 | -1) => railRef.current?.scrollBy({ left: dir * 320, behavior: 'smooth' })
  const chevron = (dir: 1 | -1) => (
    <button
      type="button"
      onClick={() => nudge(dir)}
      aria-label={dir === 1 ? 'Scroll right' : 'Scroll left'}
      className={`absolute top-1/2 z-10 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full border border-white/[0.2] bg-void/70 text-ink shadow-lg backdrop-blur transition-opacity hover:border-white/[0.4] ${dir === 1 ? 'right-0' : 'left-0'}`}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        {dir === 1 ? <path d="m9 18 6-6-6-6" /> : <path d="m15 18-6-6 6-6" />}
      </svg>
    </button>
  )
  return (
    <div className="relative min-w-0">
      {can.left && chevron(-1)}
      {can.right && chevron(1)}
      <div
        ref={railRef}
        onScroll={measure}
        onWheel={(e) => {
          // a mouse wheel scrolls vertically — translate it so the rail slides
          // (trackpads already send deltaX); the page itself never scrolls
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) railRef.current?.scrollBy({ left: e.deltaY })
        }}
        className="scrollbar-none -mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain px-1 pb-1"
        style={{ WebkitMaskImage: 'linear-gradient(90deg, transparent 0, black 12px, black calc(100% - 12px), transparent 100%)', maskImage: 'linear-gradient(90deg, transparent 0, black 12px, black calc(100% - 12px), transparent 100%)' }}
      >
        {children}
      </div>
    </div>
  )
}

function RailCard({ onClick, wide = false, children }: { onClick?: () => void; wide?: boolean; children: ReactNode }) {
  const cls = `group flex ${wide ? 'w-[188px]' : 'w-[148px]'} shrink-0 snap-start flex-col items-center gap-2 rounded-2xl border border-white/[0.1] bg-white/[0.04] px-3 py-4 text-center shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)] transition-all ${onClick ? 'hover:-translate-y-0.5 hover:border-white/[0.26] hover:bg-white/[0.08]' : ''}`
  if (!onClick) return <div className={cls}>{children}</div>
  return (
    <button type="button" onClick={onClick} className={cls}>
      {children}
    </button>
  )
}

/** Signed percent chip: teal up, alert down. the site's own success/error voices. */
function PctChip({ v }: { v: number }) {
  const up = v >= 0
  const color = up ? 'var(--color-teal)' : 'var(--color-alert)'
  return (
    <span
      className="rounded-full border px-2 py-0.5 font-mono text-[11px] font-semibold"
      style={{ color, borderColor: `color-mix(in srgb, ${color} 40%, transparent)`, background: `color-mix(in srgb, ${color} 10%, transparent)` }}
    >
      {up ? '+' : ''}
      {v.toFixed(1)}%
    </span>
  )
}

// cheerSpecter + CopyRow live in components/chat/CopyRow.tsx now, shared with
// the chat's other cards (BundleCard) — same component, one definition.

function BasketRows({ chainId, rows, onPick }: { chainId: number; rows: { address: Address; symbol: string; name: string }[]; onPick: (line: string) => void }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-sm text-ink">
        {rows.length} basket{rows.length === 1 ? '' : 's'} on {CHAINS[chainId]?.name}. Swipe through, tap one to read it:
      </p>
      <ChatRail>
        {rows.map((b) => (
          <RailCard key={b.address} onClick={() => onPick(`read $${b.symbol}`)}>
            <BasketAvatar address={b.address} symbol={b.symbol} size={40} />
            <span className="font-display text-sm font-bold leading-none text-ink">${showSymbol(b.symbol)}</span>
            <span className="line-clamp-2 min-h-[2rem] text-[12px] leading-4 text-ink-dim">{b.name}</span>
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint transition-colors group-hover:text-ink-dim">read →</span>
          </RailCard>
        ))}
      </ChatRail>
    </div>
  )
}

/** The contract address on the read card, tap to copy — the "what is the CA"
 *  answer says the address is on the card, so it has to actually be there. */
function AddressChip({ address }: { address: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(address).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1400)
        })
      }}
      title={copied ? 'Copied' : 'Copy the contract address'}
      aria-label={copied ? 'Contract address copied' : 'Copy the contract address'}
      className="ml-auto shrink-0 rounded-full border border-white/[0.12] bg-white/[0.04] px-2.5 py-1 font-mono text-[10px] transition-colors hover:border-white/[0.28]"
      style={{ color: copied ? 'var(--color-teal)' : undefined }}
    >
      {copied ? 'copied' : `${address.slice(0, 6)}…${address.slice(-4)} ⧉`}
    </button>
  )
}

/** In-chat migrate: the card explains the in-kind move, the button mounts the
 *  REAL MigrateModal (redeem → overlap straight back in → mint) — the flow
 *  the app already trusts, launched from the conversation. */
function MigrateCard({ action }: { action: Extract<AgentAction, { kind: 'migrate' }> }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex w-full min-w-0 flex-col gap-2.5">
      <div className="flex items-center gap-2.5 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2">
        <BasketAvatar address={action.from.address} symbol={action.from.symbol} size={26} />
        <span className="font-display text-sm font-bold text-ink">${showSymbol(action.from.symbol)}</span>
        <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-ink-faint">
          <path d="M5 12h14" />
          <path d="m12 5 7 7-7 7" />
        </svg>
        <BasketAvatar address={action.to.address} symbol={action.to.symbol} size={26} />
        <span className="font-display text-sm font-bold text-ink">${showSymbol(action.to.symbol)}</span>
      </div>
      <p className="text-[12px] text-ink-faint">In kind: shared assets move without touching a DEX. Only the difference trades.</p>
      {/* buttons BELOW the info, always */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-fit rounded-full px-5 py-2.5 font-display text-[13px] font-bold text-void transition-transform hover:scale-[1.02]"
        style={{ background: GRADIENT }}
      >
        Start the migration, your wallet signs
      </button>
      {open && (
        <MigrateModal
          open={open}
          onClose={() => setOpen(false)}
          fromAddr={action.from.address}
          fromSymbol={action.from.symbol}
          toAddr={action.to.address}
          toSymbol={action.to.symbol}
          chainId={action.chainId}
        />
      )}
    </div>
  )
}

function BasketReadCard({ action, onPick }: { action: Extract<AgentAction, { kind: 'basket' }>; onPick: (line: string) => void }) {
  const { data, weights, chainId } = action
  return (
    <div className="flex w-full min-w-0 flex-col gap-3 sm:min-w-[var(--chat-card-min,24rem)]">
      <div className="flex items-center gap-3">
        <BasketAvatar address={data.address} symbol={data.symbol} size={40} />
        <div className="min-w-0">
          <div className="font-display text-lg font-bold leading-tight text-ink">${showSymbol(data.symbol)}</div>
          <div className="truncate text-[13px] text-ink-dim">{data.name}</div>
        </div>
        <AddressChip address={data.address} />
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        {[
          ['NAV', `$${data.navPerToken.toFixed(4)}`],
          ['AUM', `$${data.aumUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`],
          ['Supply', Number(data.totalSupply).toLocaleString(undefined, { maximumFractionDigits: 2 })],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg border border-white/[0.1] bg-white/[0.04] px-2 py-2">
            <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">{k}</div>
            <div className="mt-1 font-display text-sm font-bold text-ink">{v}</div>
          </div>
        ))}
      </div>
      {!data.fullyPriced && <p className="text-[12px] text-ink-faint">Not every leg is priced right now. treat the NAV as partial.</p>}
      {weights ? (
        <div className="overflow-hidden rounded-2xl border border-white/[0.12] bg-white/[0.04]">
          <BasketBento
            items={data.holdings.map((l, i) => ({ symbol: l.symbol || '?', address: l.asset as Address, weightPct: weights[i] ?? 0, chainId }))}
            aspect={2.2}
            className="w-full"
          />
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {data.holdings.map((l) => (
            <div key={l.asset} className="flex items-center justify-between gap-2 text-[13px]">
              <span className="text-ink">{l.symbol ? showSymbol(l.symbol) : `${l.asset.slice(0, 8)}…`}</span>
              <span className="font-mono text-ink-dim">weight unread</span>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="button"
          onClick={() => onPick(`buy $${data.symbol}`)}
          className="rounded-full px-4 py-2 font-display text-sm font-bold text-void transition-transform hover:scale-[1.03]"
          style={{ background: GRADIENT }}
        >
          Buy it
        </button>
        <Link
          to={`/t/${chainId}/${data.address}`}
          className="rounded-full border border-white/[0.16] bg-white/[0.06] px-4 py-2 text-sm text-ink transition-colors hover:border-white/[0.3]"
        >
          Open the page
        </Link>
      </div>
    </div>
  )
}

function TradeEmbed({ action }: { action: Extract<AgentAction, { kind: 'trade' }> }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm leading-relaxed text-ink">
        {action.side === 'buy' ? 'Here is the live buy card' : 'Here is the live sell card'} for ${showSymbol(action.basket.symbol)}
        {action.side === 'buy' && action.amountUsd ? `. I preset $${action.amountUsd}` : ''}
        {action.side === 'sell' && action.sharesAmount ? `. I preset ${action.sharesAmount} shares` : ''}. Floors come from a live simulation; you
        sign in your own wallet.
      </p>
      {action.note && <p className="text-[12px] text-ink-faint">{action.note}</p>}
      <div className="max-w-full overflow-hidden rounded-2xl">
        <DexSwapCard
          chainId={action.chainId}
          fixedBasket={action.basket}
          initialDir={action.side}
          initialSlippageBps={action.slippageBps}
          // the chat quotes DOLLARS, so the hub side opens on the chain's
          // settlement (USDC here, USDG on Robinhood via usdcSymbol) — the
          // card was inheriting the ETH default and "$25" preset 25 ETH
          // (owner live report 2026-08-20)
          defaultHub="USDC"
          // the chat owns the whole flow, so a landed buy must not hand the
          // reader off to another page: Done is the primary here, and the
          // portfolio stays available as a quiet link (owner 2026-08-21; his
          // 2026-08-16 portfolio-primary ruling still governs /swap and /token)
          stayHere
          initialAmount={action.side === 'sell' ? (action.sharesAmount ?? undefined) : action.amountUsd != null ? String(action.amountUsd) : undefined}
          onTraded={(info) => window.dispatchEvent(new CustomEvent('specter:traded', { detail: info }))}
        />
      </div>
    </div>
  )
}

function PositionRows({ chainId, rows, onPick }: { chainId: number; rows: { address: Address; symbol: string; name: string; shares: string }[]; onPick: (line: string) => void }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-sm text-ink">You hold {rows.length} basket{rows.length === 1 ? '' : 's'} on {CHAINS[chainId]?.name}. tap one to sell:</p>
      <ChatRail>
        {rows.map((r) => (
          <RailCard key={r.address} onClick={() => onPick(`sell $${r.symbol}`)}>
            <BasketAvatar address={r.address} symbol={r.symbol} size={40} />
            <span className="font-display text-sm font-bold leading-none text-ink">${showSymbol(r.symbol)}</span>
            <span className="line-clamp-2 min-h-[2rem] text-[12px] leading-4 text-ink-dim">{r.name}</span>
            <span className="font-mono text-[11px] text-ink-dim">{r.shares} sh</span>
          </RailCard>
        ))}
      </ChatRail>
    </div>
  )
}

/** floor(100/n) with the remainder spread over the first legs — integers, sum 100 */
function equalSplit(n: number): number[] {
  const base = Math.floor(100 / n)
  const rem = 100 - base * n
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0))
}

/** The in-chat composer: the REAL BasketBento over live weight state — play
 *  with the split right here, then carry tokens+weights into the full
 *  composer (owner 2026-08-19: "pop up the actual bento grid in the chat"). */
function CreateCard({ action, onLive }: { action: Extract<AgentAction, { kind: 'create' }>; onLive: (token: Address, symbol: string) => void }) {
  // spoken weights ("50/30/20") arrive on the action, already sanity-gated
  const [weights, setWeights] = useState<number[]>(() =>
    action.weights && action.weights.length === action.legs.length && action.weights.reduce((s, w) => s + w, 0) === 100
      ? action.weights
      : equalSplit(action.legs.length),
  )
  const sum = weights.reduce((s, w) => s + w, 0)
  const bump = (i: number, d: number) =>
    setWeights((prev) => prev.map((w, k) => (k === i ? Math.min(97, Math.max(1, w + d)) : w)))
  const items = useMemo(
    () => action.legs.map((l, i) => ({ symbol: l.symbol, address: l.address, weightPct: weights[i] ?? 0, chainId: action.chainId })),
    [action.legs, weights, action.chainId],
  )
  return (
    <div className="flex w-full min-w-0 flex-col gap-3 sm:min-w-[var(--chat-card-min,26rem)]">
      <p className="text-sm leading-relaxed text-ink">
        {action.legs.length} legs resolved on {CHAINS[action.chainId]?.name}. Set the split here (the tiles re-cut live), then deploy it below without leaving the chat.
      </p>
      <div className="overflow-hidden rounded-2xl border border-white/[0.12] bg-white/[0.04]">
        <BasketBento items={items} aspect={2.2} className="w-full" />
      </div>
      <div className="flex flex-col gap-1.5">
        {action.legs.map((l, i) => (
          <div key={l.address} className="flex items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate font-display text-sm font-bold text-ink">${showSymbol(l.symbol)}</span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => bump(i, -1)}
                aria-label={`Reduce ${showSymbol(l.symbol)} weight`}
                className="grid h-7 w-7 place-items-center rounded-full border border-white/[0.14] text-ink-dim transition-colors hover:border-white/[0.3] hover:text-ink"
              >
                −
              </button>
              <span className="w-11 text-center font-mono text-sm text-ink">{weights[i] ?? 0}%</span>
              <button
                type="button"
                onClick={() => bump(i, +1)}
                aria-label={`Increase ${showSymbol(l.symbol)} weight`}
                className="grid h-7 w-7 place-items-center rounded-full border border-white/[0.14] text-ink-dim transition-colors hover:border-white/[0.3] hover:text-ink"
              >
                +
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <span
          className="rounded-full border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em]"
          style={
            sum === 100
              ? { borderColor: 'color-mix(in srgb, var(--color-teal) 45%, transparent)', color: 'var(--color-teal)' }
              : { borderColor: 'color-mix(in srgb, var(--color-amber) 45%, transparent)', color: 'var(--color-amber)' }
          }
        >
          {sum === 100 ? 'sums to 100%' : `${sum}%, needs exactly 100`}
        </span>
      </div>
      {/* the PRIMARY flow deploys right here (owner: never forced out of the
          chat); the composer stays the advanced door inside the card's footer */}
      {sum === 100 && <DeployCard chainId={action.chainId} legs={action.legs} weights={weights} onLive={onLive} />}
    </div>
  )
}

function CandidatesRail({ action, onPick }: { action: Extract<AgentAction, { kind: 'candidates' }>; onPick: (line: string) => void }) {
  const fmt = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${n.toFixed(0)}`)
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <AgentText text={action.text} />
      {!action.hits.some((h) => h.verified) && (
        <p className="text-[12px]" style={{ color: 'var(--color-amber)' }}>
          None of these are on the verified token list. Check the address against the project&rsquo;s own channels before choosing.
        </p>
      )}
      <ChatRail>
        {action.hits.map((h) => (
          <RailCard key={h.address} wide onClick={() => onPick(`use ${h.address} for ${action.ticker}`)}>
            <span className="flex items-center gap-1.5 font-display text-sm font-bold leading-none text-ink">
              ${showSymbol(h.symbol)}
              {h.verified && (
                <span title="On the verified token list" className="rounded-full px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase" style={{ color: 'var(--color-teal)', background: 'color-mix(in srgb, var(--color-teal) 12%, transparent)' }}>
                  verified
                </span>
              )}
            </span>
            <span className="line-clamp-1 text-[12px] text-ink-dim">{h.name}</span>
            <span className="font-mono text-[11px] text-ink-dim">liq {fmt(h.liquidityUsd)} · mcap {h.marketCapUsd > 0 ? fmt(h.marketCapUsd) : '—'}</span>
            <span className="font-mono text-[10px] text-ink-faint">{h.address.slice(0, 6)}…{h.address.slice(-4)}</span>
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint transition-colors group-hover:text-ink-dim">this one →</span>
          </RailCard>
        ))}
      </ChatRail>
    </div>
  )
}

/** A small-caps section label for in-bubble blocks. */
function RailLabel({ children }: { children: ReactNode }) {
  return <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">{children}</p>
}

function MoversBlock({ action, onPick }: { action: Extract<AgentAction, { kind: 'movers' }>; onPick: (line: string) => void }) {
  const top3 = action.assets.slice(0, 3)
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {action.assets.length > 0 && (
        <div className="flex min-w-0 flex-col gap-2">
          <RailLabel>Top constituents · live 24h · {CHAINS[action.chainId]?.name}</RailLabel>
          <ChatRail>
            {action.assets.map((a) => (
              <RailCard key={a.address}>
                <span className="font-display text-sm font-bold leading-none text-ink">${showSymbol(a.symbol)}</span>
                <PctChip v={a.changePct} />
                <span className="line-clamp-1 text-[11px] text-ink-faint">held by ${showSymbol(a.fromBasket)}</span>
              </RailCard>
            ))}
          </ChatRail>
        </div>
      )}
      {action.baskets.length > 0 && (
        <div className="flex min-w-0 flex-col gap-2">
          <RailLabel>Top baskets · {action.windowLabel} NAV</RailLabel>
          <ChatRail>
            {action.baskets.map((b) => (
              <RailCard key={b.address} onClick={() => onPick(`read $${b.symbol}`)}>
                <BasketAvatar address={b.address} symbol={b.symbol} size={32} />
                <span className="font-display text-sm font-bold leading-none text-ink">${showSymbol(b.symbol)}</span>
                <PctChip v={b.changePct} />
                <span className="line-clamp-1 text-[11px] text-ink-faint">{b.name}</span>
              </RailCard>
            ))}
          </ChatRail>
        </div>
      )}
      {action.baskets.length === 0 && action.assets.length === 0 && <AgentText text="Nothing measurable over that window yet." />}
      {/* buttons live BELOW the info, always (owner rule 2026-08-19) */}
      {top3.length >= 2 && (
        <button
          type="button"
          onClick={() => onPick(`create a basket of ${top3.map((a) => a.address).join(', ')}`)}
          className="w-fit rounded-full px-4 py-2 font-display text-[13px] font-bold text-void transition-transform hover:scale-[1.03]"
          style={{ background: GRADIENT }}
        >
          Basket the top {top3.length} →
        </button>
      )}
      <p className="truncate text-[11px] text-ink-faint">Momentum is not advice{action.partial ? ' · unmeasurable baskets are omitted' : ''}.</p>
    </div>
  )
}

const SEAL_ART: Record<'violet' | 'teal' | 'amber' | 'rainbow', string> = {
  violet: sealViolet,
  teal: sealTeal,
  amber: sealAmber,
  rainbow: sealRainbow,
}

/** The showcase answer: a marketing-grade card for first-touch questions —
 *  seal art, display title, tick rows, one-line foot. Facts only. */
function HeroCard({ action, onPick }: { action: Extract<AgentAction, { kind: 'hero' }>; onPick: (line: string) => void }) {
  return (
    <div className="relative w-full min-w-0 overflow-hidden rounded-2xl border border-white/[0.14] bg-white/[0.05] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)] sm:min-w-[var(--chat-card-min,24rem)]">
      <div aria-hidden className="h-px w-full" style={{ background: GRADIENT }} />
      <div className="flex items-start gap-4 p-5">
        <img src={SEAL_ART[action.art]} alt="" aria-hidden draggable={false} width={56} height={56} className="mt-0.5 shrink-0 rotate-6 select-none drop-shadow-[0_6px_14px_rgba(0,0,0,0.22)]" />
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-lg font-bold uppercase leading-tight tracking-tight text-ink">{action.title}</h3>
          <ul className="mt-3 flex flex-col gap-2">
            {action.lines.map((l) => (
              <li key={l} className="flex items-start gap-2 text-[13.5px] leading-snug text-ink">
                <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-teal)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                <span className="min-w-0">{l}</span>
              </li>
            ))}
          </ul>
          {action.foot && <p className="mt-3 truncate font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">{action.foot}</p>}
          {/* the gentle nudge (owner 2026-08-21): a soft button under the answer
              inviting them to make their own — the button is below the info */}
          {action.cta && (
            <button
              type="button"
              onClick={() => onPick(action.cta!.send)}
              className="press mt-4 inline-flex items-center gap-1.5 rounded-full border border-cyan/40 bg-cyan/[0.08] px-4 py-1.5 font-display text-[12px] font-bold uppercase tracking-wide text-ink transition-colors hover:border-cyan/70 hover:bg-cyan/[0.14]"
            >
              {action.cta.label}
              <span aria-hidden className="text-cyan">→</span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** The numbered walkthrough: each step optionally tappable — the step IS the
 *  next action (owner: answers that convert into activity). */
function StepsCard({ action, onPick }: { action: Extract<AgentAction, { kind: 'steps' }>; onPick: (line: string) => void }) {
  return (
    <div className="w-full min-w-0 overflow-hidden rounded-2xl border border-white/[0.14] bg-white/[0.05] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)] sm:min-w-[var(--chat-card-min,22rem)]">
      <div aria-hidden className="h-px w-full" style={{ background: GRADIENT }} />
      <div className="flex flex-col gap-2.5 p-4">
        <h3 className="font-display text-[15px] font-bold uppercase tracking-tight text-ink">{action.title}</h3>
        {action.steps.map((st, i) => {
          const dot = (
            <span
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full font-display text-[11px] font-bold text-void"
              style={{ background: GRADIENT }}
            >
              {i + 1}
            </span>
          )
          return st.send ? (
            <button
              key={st.text}
              type="button"
              onClick={() => onPick(st.send!)}
              className="group flex items-center gap-3 rounded-xl border border-white/[0.12] bg-white/[0.04] px-3 py-2 text-left transition-colors hover:border-white/[0.28] hover:bg-white/[0.07]"
            >
              {dot}
              <span className="min-w-0 flex-1 text-[13.5px] leading-snug text-ink">{st.text}</span>
              <svg aria-hidden width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-ink-faint transition-colors group-hover:text-ink">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          ) : (
            <div key={st.text} className="flex items-center gap-3 px-3 py-1">
              {dot}
              <span className="min-w-0 flex-1 text-[13.5px] leading-snug text-ink">{st.text}</span>
            </div>
          )
        })}
        {action.foot && <p className="truncate px-1 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">{action.foot}</p>}
      </div>
    </div>
  )
}

/** Two columns, one verdict: pains on the left in faint ✕ rows, the basket's
 *  wins on the right under the brand hairline. */
function CompareCard({ action }: { action: Extract<AgentAction, { kind: 'compare' }> }) {
  return (
    <div className="w-full min-w-0 overflow-hidden rounded-2xl border border-white/[0.14] bg-white/[0.05] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)] sm:min-w-[var(--chat-card-min,26rem)]">
      <div aria-hidden className="h-px w-full" style={{ background: GRADIENT }} />
      <div className="p-4">
        <h3 className="font-display text-[15px] font-bold uppercase tracking-tight text-ink">{action.title}</h3>
        <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
          <div className="rounded-xl border border-white/[0.1] bg-white/[0.03] p-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">{action.left.head}</div>
            <ul className="mt-2 flex flex-col gap-1.5">
              {action.left.rows.map((r) => (
                <li key={r} className="flex items-start gap-2 text-[13px] leading-snug text-ink-dim">
                  <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="mt-0.5 shrink-0 text-ink-faint">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                  <span className="min-w-0">{r}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border p-3" style={{ borderColor: 'color-mix(in srgb, var(--color-teal) 40%, transparent)', background: 'color-mix(in srgb, var(--color-teal) 6%, transparent)' }}>
            <div className="font-mono text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--color-teal)' }}>{action.right.head}</div>
            <ul className="mt-2 flex flex-col gap-1.5">
              {action.right.rows.map((r) => (
                <li key={r} className="flex items-start gap-2 text-[13px] leading-snug text-ink">
                  <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-teal)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  <span className="min-w-0">{r}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        {action.foot && <p className="mt-2.5 truncate font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">{action.foot}</p>}
      </div>
    </div>
  )
}

function ActionBlock({
  action,
  onPick,
  onDeployed,
  superseded = false,
}: {
  action: AgentAction
  onPick: (line: string) => void
  /** a DeployCard success bubbles the live basket up (the bundle flow feeds on it) */
  onDeployed?: (b: { chainId: number; address: Address; symbol: string }) => void
  /** a LATER turn overtook this card — a single-chain create whose draft has
   *  since gone multichain must not still offer to deploy that chain alone */
  superseded?: boolean
}) {
  switch (action.kind) {
    case 'text':
      return <AgentText text={action.text} />
    case 'baskets':
      return <BasketRows chainId={action.chainId} rows={action.rows} onPick={onPick} />
    case 'basket':
      return <BasketReadCard action={action} onPick={onPick} />
    case 'trade':
      return <TradeEmbed action={action} />
    case 'positions':
      return <PositionRows chainId={action.chainId} rows={action.rows} onPick={onPick} />
    case 'create':
      if (superseded)
        return (
          <p className="text-[13px] leading-snug text-ink-faint">
            This draft has since grown across chains, so it is a bundle now and the launch below makes every chain. Ask
            again if you only want {CHAINS[action.chainId]?.name}.
          </p>
        )
      return (
        <CreateCard
          action={action}
          onLive={(token, symbol) => {
            onDeployed?.({ chainId: action.chainId, address: token, symbol })
            cheerSpecter() // a confirmed on-chain deploy is THE confirmed success
            onPick(`read ${token}`)
          }}
        />
      )
    case 'bundle':
      return <BundleCard legs={action.legs} />
    case 'claim':
      return <ClaimCard chainId={action.chainId} rows={action.rows} totalUsd={action.totalUsd} refLink={action.refLink} />
    case 'multiBuy':
      return <MultiBuyCard chainId={action.chainId} baskets={action.baskets} amountUsd={action.amountUsd} slippageBps={action.slippageBps} />
    case 'version':
      return (
        <VersionCard
          chainId={action.chainId}
          predecessor={action.predecessor}
          onDeployed={(leg) => {
            onDeployed?.(leg)
            cheerSpecter()
          }}
        />
      )
    case 'hero':
      return <HeroCard action={action} onPick={onPick} />
    case 'steps':
      return <StepsCard action={action} onPick={onPick} />
    case 'compare':
      return <CompareCard action={action} />
    case 'candidates':
      return <CandidatesRail action={action} onPick={onPick} />
    case 'movers':
      return <MoversBlock action={action} onPick={onPick} />
    case 'redeem':
      return <RedeemCard chainId={action.chainId} data={action.data} />
    case 'migrate':
      return <MigrateCard action={action} />
    case 'thesis':
      return <ThesisCard chainId={action.chainId} basket={action.basket} symbol={action.symbol} deployer={action.deployer} />
    case 'profile':
      return <ProfileCard />
    case 'assetPicker':
      return <AssetPickerCard action={action} onPick={onPick} />
    case 'crossDraft':
      return (
        <CrossChainDraftCard
          action={action}
          onPick={onPick}
          onDeployed={(leg) => {
            onDeployed?.(leg)
            cheerSpecter() // a confirmed on-chain deploy is THE confirmed success
          }}
        />
      )
    case 'perf':
      return (
        <div className="flex w-full min-w-0 flex-col gap-2 sm:min-w-[var(--chat-card-min,24rem)]">
          <div className="overflow-hidden rounded-2xl border border-white/[0.12] bg-white/[0.04] p-2">
            <BasketSpark
              chainId={action.chainId}
              assets={action.data.holdings.map((l, i) => ({ address: l.asset, weight: action.weights[i] ?? 0 }))}
              navPerToken={action.data.navPerToken}
              fallback={action.data.navSeries}
              range={action.range}
              ageSec={action.data.ageHours != null ? action.data.ageHours * 3600 : null}
              address={action.data.address}
              symbol={action.data.symbol}
              legs={action.data.holdings.map((l, i) => ({ symbol: l.symbol || '?', address: l.asset, weightPct: action.weights[i] ?? 0 }))}
            />
          </div>
          <div className="flex items-center justify-between gap-2 px-1">
            <span className="font-display text-sm font-bold text-ink">${showSymbol(action.data.symbol)}</span>
            {action.changePct != null && (
              <span className="font-mono text-[12px]" style={{ color: action.changePct >= 0 ? 'var(--color-teal)' : 'var(--color-alert)' }}>
                {action.changePct >= 0 ? '+' : ''}
                {action.changePct.toFixed(2)}% · {action.range}
              </span>
            )}
          </div>
        </div>
      )
    case 'share':
      return (
        <div className="flex min-w-0 flex-col gap-2">
          <AgentText text={action.text} />
          <CopyRow url={action.url} />
        </div>
      )
    case 'referral':
      return (
        <div className="flex min-w-0 flex-col gap-2">
          <AgentText text={action.text} />
          <CopyRow url={action.url} />
          <Link to="/refer" className="w-fit text-[12px] text-ink-dim underline underline-offset-2 transition-colors hover:text-ink">
            The referral program, explained →
          </Link>
        </div>
      )
    case 'link':
      return (
        <div className="flex flex-col gap-2">
          <AgentText text={action.text} />
          <Link to={action.href} className="w-fit rounded-full border border-white/[0.16] bg-white/[0.06] px-4 py-2 text-sm text-ink transition-colors hover:border-white/[0.3]">
            {action.label} →
          </Link>
        </div>
      )
  }
}

// ── the page ──────────────────────────────────────────────────────────────────

/** THE STAGE (owner 1809, deepened 19:2x): the last basket the conversation
 *  touched, living in the right column with its price history, native bento,
 *  and per-token insight rows. Buttons live BELOW the info, always. */
function StagePanel({ stage }: { stage: { chainId: number; data: BasketData; weights: number[] } | null }) {
  if (!stage) {
    return (
      <div className="pointer-events-none flex min-h-0 flex-1 flex-col p-3 opacity-90">
        <BlueprintBasket compact bare />
      </div>
    )
  }
  const { data, weights, chainId } = stage
  const legs = data.holdings.map((l, i) => ({ symbol: l.symbol || '?', address: l.asset, weightPct: weights[i] ?? 0 }))
  // the basket's own 24h move, from the same series the chart draws
  const chg24 = (() => {
    const srs = data.navSeries
    if (!srs || srs.length < 2) return null
    const target = Math.floor(Date.now() / 1000) - 86_400
    let base = srs[0]
    for (const pt of srs) {
      if (pt.time <= target) base = pt
      else break
    }
    const last = srs[srs.length - 1]
    return base.value > 0 ? (last.value / base.value - 1) * 100 : null
  })()
  const fmtPrice = (p: number) =>
    p >= 1 ? p.toLocaleString(undefined, { maximumFractionDigits: 2 }) : p >= 0.01 ? p.toFixed(4) : p.toExponential(1)
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-3 px-5 pt-5">
        <div className="flex min-w-0 items-center gap-3">
          <BasketAvatar address={data.address} symbol={data.symbol} size={40} />
          <div className="min-w-0">
            <div className="truncate font-display text-lg font-bold leading-tight text-ink">${showSymbol(data.symbol)}</div>
            <div className="truncate text-[12px] text-ink-dim">{data.name}</div>
          </div>
        </div>
        {/* the PRICE is the headline number (owner 21:1x) */}
        <div className="shrink-0 text-right">
          <div className="font-display text-xl font-bold leading-none text-ink">${data.navPerToken.toFixed(data.navPerToken >= 1 ? 2 : 4)}</div>
          <div className="mt-1 flex items-center justify-end gap-1.5">
            {chg24 != null && <PctChip v={chg24} />}
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">per share</span>
          </div>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-5 py-4">
        {/* the price graph: real reconstructed history, hoverable, range pills */}
        <div className="h-24 shrink-0 rounded-2xl border border-white/[0.12] bg-white/[0.06] p-2 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)]">
          <BasketSpark
            chainId={chainId}
            assets={data.holdings.map((l, i) => ({ address: l.asset, weight: weights[i] ?? 0 }))}
            navPerToken={data.navPerToken}
            fallback={data.navSeries}
            range="24H"
            withRanges
            ageSec={data.ageHours != null ? data.ageHours * 3600 : null}
            address={data.address}
            symbol={data.symbol}
            legs={legs}
          />
        </div>
        <div className="min-h-[5rem] flex-1 overflow-hidden rounded-2xl border border-white/[0.12] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)]">
          <BasketBento items={legs.map((l) => ({ ...l, chainId }))} fill className="h-full w-full" />
        </div>
        {/* token insights: live price, 24h move, weight, per constituent — always fully visible */}
        <div className="flex shrink-0 flex-col gap-1.5">
          {data.holdings.map((l, i) => (
            <div key={l.asset} className={`stage-row flex items-center gap-3 rounded-xl border border-white/[0.14] bg-white/[0.1] px-3.5 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.1)] ${data.holdings.length > 4 ? 'py-1.5' : 'py-2.5'}`}>
              <span className="min-w-0 flex-1 truncate font-display text-[13px] font-bold text-ink">
                {l.symbol ? showSymbol(l.symbol) : `${l.asset.slice(0, 8)}…`}
              </span>
              <span className="font-mono text-[11px] text-ink-dim">{l.priced && l.priceUsd > 0 ? `$${fmtPrice(l.priceUsd)}` : 'unpriced'}</span>
              {l.change24hPct != null && <PctChip v={l.change24hPct} />}
              <span className="w-10 text-right font-mono text-[11px] text-ink-faint">{weights[i] ?? 0}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** The card's bottom-left action rail: the stage basket's doors, stacked and
 *  left-aligned beside the mascot (owner 2026-08-19 21:0x: "buy/sell and other
 *  peripheral content on the left aligned with mascot"). */
function StageActions({
  stage,
  hintSymbol,
  tradeCardLive,
  onPick,
}: {
  stage: { chainId: number; data: BasketData; weights: number[] } | null
  hintSymbol: string | null
  /** a trade/redeem/migrate card is already on screen with its own armed
   *  primary — so these buttons stand down rather than compete with it */
  tradeCardLive: boolean
  onPick: (line: string) => void
}) {
  if (!stage) {
    return (
      <button
        type="button"
        onClick={() => hintSymbol && onPick(`read $${hintSymbol}`)}
        className="max-w-[16rem] text-left text-[14px] leading-relaxed text-ink-dim transition-colors hover:text-ink"
      >
        The basket you talk about appears here. Try &ldquo;read {hintSymbol ? `$${hintSymbol}` : 'a basket'}&rdquo;
      </button>
    )
  }
  const { data, chainId } = stage
  // Buy + Sell share the top row; Open page spans both below (owner 21:4x).
  // They stand down entirely while a live card owns the action, so there is
  // never a second gradient Buy beside the one that is actually armed.
  return (
    <div className="flex w-full max-w-[24rem] flex-col gap-2">
      {tradeCardLive ? (
        <p className="px-1 text-[13px] leading-snug text-ink-dim">
          ${showSymbol(data.symbol)} is on the card in the thread. Finish it there.
        </p>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onPick(`buy $${data.symbol}`)}
            className="flex-1 rounded-full px-4 py-2.5 text-center font-display text-[13px] font-bold text-void transition-transform hover:scale-[1.02]"
            style={{ background: GRADIENT }}
          >
            Buy ${showSymbol(data.symbol)}
          </button>
          <button
            type="button"
            onClick={() => onPick(`sell $${data.symbol}`)}
            className="flex-1 rounded-full border border-white/[0.16] bg-white/[0.06] px-4 py-2.5 text-center text-[13px] text-ink transition-colors hover:border-white/[0.3]"
          >
            Sell
          </button>
        </div>
      )}
      <Link
        to={`/t/${chainId}/${data.address}`}
        className="rounded-full border border-white/[0.16] bg-white/[0.06] px-4 py-2.5 text-center text-[13px] text-ink transition-colors hover:border-white/[0.3]"
      >
        Open page
      </Link>
    </div>
  )
}

/** The cinematic entrance (owner 2026-08-19): Specter bursts to life CENTER
 *  SCREEN, waves hello, does the rainbow twirl, then hands the page over.
 *  Click anywhere skips. Reduced motion never sees it. */
function IntroOverlay({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<'intro' | 'twirl' | 'out'>('intro')
  useEffect(() => {
    playSfx('intro-pop', 0.35)
    const t1 = setTimeout(() => setPhase('twirl'), 1900)
    const t2 = setTimeout(() => setPhase('out'), 1900 + 1700)
    const t3 = setTimeout(onDone, 1900 + 1700 + 650)
    return () => [t1, t2, t3].forEach(clearTimeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <button
      type="button"
      aria-label="Skip intro"
      onClick={onDone}
      className={`fixed inset-0 z-50 grid w-full cursor-default place-items-center bg-void/90 backdrop-blur-md transition-opacity duration-500 ${phase === 'out' ? 'opacity-0 duration-700' : 'opacity-100'}`}
    >
      <div className="relative">
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-24 opacity-30 blur-3xl"
          style={{ background: 'radial-gradient(closest-side, var(--color-violet-bright), transparent)' }}
        />
        {/* the ground shadow is a composed ellipse, not a filter: CSS
            drop-shadow on an animated image inside a backdrop-filter overlay
            rasterizes against a square tile (the owner saw the box) */}
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-6 left-1/2 h-10 w-48 -translate-x-1/2 rounded-full opacity-40 blur-xl"
          style={{ background: 'radial-gradient(closest-side, rgba(0,0,0,0.55), transparent)' }}
        />
        <img
          key={phase}
          src={MASCOT_ANIM[phase === 'out' ? 'exit' : phase]}
          alt=""
          aria-hidden
          draggable={false}
          width={320}
          height={320}
          className="relative select-none"
        />
        <p className="mt-2 text-center font-mono text-[11px] uppercase tracking-[0.22em] text-ink-faint">Agent Specter</p>
      </div>
    </button>
  )
}

/** The message thread, shared verbatim by the page and the site-wide widget
 *  (one bubble style, zero drift). The scroll container is the consumer's. */
/** Hover-copy on an agent bubble: the message's TEXT actions, joined. Cards
 *  carry their own copy affordances (CopyRow); this is for prose answers an
 *  operator wants to paste elsewhere. */
function BubbleCopy({ actions }: { actions: AgentAction[] }) {
  const [copied, setCopied] = useState(false)
  const text = actions
    .filter((a): a is Extract<AgentAction, { kind: 'text' }> => a.kind === 'text')
    .map((a) => a.text)
    .join('\n\n')
  if (!text) return null
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1400)
        })
      }}
      aria-label="Copy this answer"
      title={copied ? 'Copied' : 'Copy this answer'}
      className="absolute -right-1.5 -top-1.5 grid h-6 w-6 place-items-center rounded-full border border-white/[0.14] text-ink-faint opacity-0 shadow-[0_4px_12px_rgba(0,0,0,0.25)] transition-opacity focus-visible:opacity-100 group-hover/bubble:opacity-100"
      style={{ background: 'var(--color-panel)', color: copied ? 'var(--color-teal)' : undefined }}
    >
      {copied ? (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
        </svg>
      )}
    </button>
  )
}

export function MessageList({ msgs, onPick, onDeployed }: { msgs: Msg[]; onPick: (line: string) => void; onDeployed: (b: { chainId: number; address: Address; symbol: string }) => void }) {
  // A SINGLE-CHAIN CREATE CARD GOES INERT ONCE THE DRAFT OUTGROWS IT (owner
  // 2026-08-21). The chat emits a compose card as soon as one chain has 2+ legs.
  // If the draft then gains a pick on another chain it becomes a BUNDLE, and the
  // finalized card's one-button launch deploys that chain itself — but the older
  // card is still sitting above with its Deploy armed and its action frozen in
  // the message log, so pressing it deploys the chain a SECOND time. Two baskets,
  // one intent. A later crossDraft turn is the signal that the draft moved on,
  // so every create card before it stands down.
  const firstCrossDraft = msgs.findIndex((m) => m.role === 'agent' && (m.actions ?? []).some((a) => a.kind === 'crossDraft'))
  const supersededAt = (mi: number) => firstCrossDraft !== -1 && mi < firstCrossDraft
  return (
    <>
      {msgs.map((m, mi) =>
        m.role === 'user' ? (
          <div key={m.id} className="chat-msg flex w-full flex-col items-end gap-1">
            <div
              className="max-w-[85%] rounded-2xl rounded-tr-md px-4 py-3"
              style={{ background: GRADIENT, boxShadow: '0 8px 24px -10px color-mix(in srgb, var(--color-magenta) 55%, transparent)' }}
            >
              <p className="text-sm font-medium leading-relaxed text-void">{m.text}</p>
            </div>
            <span className="mr-1 text-[10px] text-ink-faint">{stampOf(m.at)}</span>
          </div>
        ) : (
          <div key={m.id} className="chat-msg flex w-full items-end gap-2">
            <img src={mascotIdle} alt="" aria-hidden draggable={false} className="mb-5 h-6 w-7 shrink-0 select-none opacity-90" />
            <div className="flex min-w-0 max-w-[88%] flex-col items-start gap-1">
              <div className="group/bubble relative max-w-full rounded-2xl rounded-bl-md border border-white/[0.1] bg-white/[0.06] px-4 py-3 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.07)] backdrop-blur-md">
                {!m.thinking && <BubbleCopy actions={m.actions ?? []} />}
                {m.thinking ? (
                  <SpectrumLoader size={24} label="thinking" />
                ) : (
                  <div className="flex flex-col gap-4">
                    {(m.actions ?? []).map((a, i) => (
                      <ActionBlock
                        key={i}
                        action={a}
                        onPick={onPick}
                        onDeployed={onDeployed}
                        /* a single-chain create card that a LATER turn has
                           overtaken — see supersededAt (owner 2026-08-21) */
                        superseded={supersededAt(mi)}
                      />
                    ))}
                  </div>
                )}
              </div>
              {!m.thinking && <span className="ml-1 text-[10px] text-ink-faint">{stampOf(m.at)}</span>}
            </div>
          </div>
        ),
      )}
    </>
  )
}

/** ONE suggestion system (owner 23:2x + 23:3x): starters + contextual in the
 *  same compact pill rail. Shared by the page and the widget. */
export function SuggestionRail({ chips, onPick }: { chips: string[]; onPick: (line: string) => void }) {
  const starters = [
    { art: sealViolet, title: 'What is a basket?', send: 'What is a basket?' },
    { art: sealTeal, title: 'Show me what is live', send: 'Show me what is live' },
    { art: sealAmber, title: 'Earn as a creator', send: 'Earn as a creator' },
    { art: sealRainbow, title: 'How easy is it?', send: 'How easy is it to get started?' },
  ]
  const arts = [sealTeal, sealViolet, sealAmber, sealRainbow]
  const contextual =
    chips === CHIPS
      ? []
      : chips
          .filter((c) => !starters.some((st) => st.send.toLowerCase() === c.toLowerCase()))
          .slice(0, 4)
          .map((c, i) => ({ art: arts[i % arts.length], title: c, send: c }))
  // contextual leads once it exists — the freshest suggestion sits first
  return (
    <ChatRail>
      {[...contextual, ...starters].map((tile) => (
        <button
          key={tile.send}
          type="button"
          onClick={() => onPick(tile.send)}
          className="group flex shrink-0 snap-start items-center gap-2 whitespace-nowrap rounded-full border border-white/[0.12] bg-white/[0.05] py-1.5 pl-2 pr-4 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.07)] transition-all hover:-translate-y-0.5 hover:border-white/[0.28] hover:bg-white/[0.08]"
        >
          <img src={tile.art} alt="" aria-hidden draggable={false} width={26} height={26} className="shrink-0 rotate-6 select-none transition-transform group-hover:rotate-12" />
          <span className="font-display text-[11.5px] font-bold uppercase tracking-tight text-ink">{tile.title}</span>
        </button>
      ))}
    </ChatRail>
  )
}

/** The living draft, always in sight: one tappable pill above the input
 *  naming the buckets; tap reopens the compose card (owner: more visual,
 *  the draft was memory-only between turns). Shared by page and widget. */
export function DraftPill({ label, onPick }: { label: string | null; onPick: (line: string) => void }) {
  if (!label) return null
  return (
    <button
      type="button"
      onClick={() => onPick('show my draft')}
      className="group flex w-fit min-w-0 max-w-full items-center gap-2 rounded-full border border-white/[0.14] bg-white/[0.05] py-1 pl-3 pr-2.5 transition-colors hover:border-white/[0.3]"
      title="Open the draft"
    >
      <span aria-hidden className="chat-dot h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--color-violet-bright)' }} />
      <span className="min-w-0 truncate text-[11px] text-ink-dim">
        Draft · <span className="text-ink">{label}</span>
      </span>
      <svg aria-hidden width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5">
        <path d="m9 18 6-6-6-6" />
      </svg>
    </button>
  )
}

export function Chat({ embed = false }: { embed?: boolean } = {}) {
  const mascot = useRef<MascotHandle>(null)
  const [sfx, setSfx] = useState(sfxEnabled)
  // the stage starts undefined = "not staged this mount": the restored
  // session's stage shows until the conversation stages something new
  const [stageState, setStageState] = useState<Stage | undefined>(undefined)
  const session = useChatSession({ mascot, onStage: setStageState })
  const { msgs, input, setInput, busy, chips, draftLabel, confirmClear, recallLast, chainId, send, newChat, noteDeployed, inputHint } = session
  const inputRef = useRef<HTMLInputElement>(null)
  // "/" focuses the chat input from anywhere on the page (not while typing
  // elsewhere) — the doc-site convention, cheap muscle memory
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return
      e.preventDefault()
      inputRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const stage = stageState === undefined ? session.initialStage : stageState
  const scrollRef = useRef<HTMLDivElement>(null)
  // the cinematic entrance on every load (owner 23:1x); reduced motion skips
  const [showIntro, setShowIntro] = useState(
    () => !embed && !(typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches),
  )
  // the page's own entrance plays AFTER the overlay dissolves (owner 23:4x):
  // cards + their elements ride the house .enter stagger once this flips
  const [entered, setEntered] = useState(() => !showIntro)
  // a real, live ticker for the empty stage's hint (never a made-up example)
  const [hintSymbol, setHintSymbol] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    listBasketsForChain(chainId)
      .then((l) => {
        if (alive) setHintSymbol(l[0]?.symbol ?? null)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [chainId])

  // the pastel backdrop paints on body::after (see index.css: a transformed
  // route wrapper re-scopes any in-tree fixed layer). Fades in over 2s to the
  // plane's cap; leaves cleanly on unmount.
  useEffect(() => {
    if (embed) return // the homepage owns its own backdrop
    const root = document.documentElement
    root.style.setProperty('--chat-bg-url', `url(${chatPaperBg})`)
    const t = requestAnimationFrame(() => root.style.setProperty('--chat-bg-live', 'var(--chat-bg-opacity, 0)'))
    return () => {
      cancelAnimationFrame(t)
      root.style.setProperty('--chat-bg-live', '0')
      root.style.removeProperty('--chat-bg-url')
    }
  }, [])

  useEffect(() => {
    preloadMascot()
  }, [])

  // /chat?q=… auto-asks once (marketing and support can link straight into a
  // question: /chat?q=how%20do%20fees%20work). One-shot; the param clears so
  // refresh does not re-send.
  const [params, setParams] = useSearchParams()
  const askedFromUrl = useRef(false)
  useEffect(() => {
    const q = params.get('q')
    if (!q || askedFromUrl.current || busy) return
    askedFromUrl.current = true
    setParams((p) => {
      const n = new URLSearchParams(p)
      n.delete('q')
      return n
    }, { replace: true })
    const timer = setTimeout(() => void send(q.slice(0, 400)), 600)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params])

  // stick-to-bottom only while the reader is already there; scrolled up, a
  // new reply raises the jump pill instead of yanking (QoL 2026-08-20)
  const { jump, toBottom } = useStickyScroll(scrollRef, msgs)

  // IS A TRADE CARD ALREADY ON SCREEN? (owner 2026-08-21, the one-button audit.)
  // A trade reply also sets the stage, so the stage used to paint its own
  // gradient "Buy $SYM" right beside the live card's armed gradient Buy — two
  // competing primaries for one action, and pressing the stage's one sends a buy
  // with NO amount, which restarts the how-much question and orphans the card.
  // While the latest reply carries a trade card, the stage stands its money
  // buttons down and keeps only "Open page".
  const tradeCardLive = useMemo(() => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role !== 'agent' || !m.actions?.length) continue
      return m.actions.some((a) => a.kind === 'trade' || a.kind === 'redeem' || a.kind === 'migrate')
    }
    return false
  }, [msgs])

  return (
    // Height math (owner: "the chat is always in the main viewport, never below
    // the scroll"): sticky nav ~64px + the shell's py-8 (64px) + slack = 8.5rem
    // on lg; phones also clear the fixed tab bar (3.5rem + safe area) = 12rem.
    // Messages scroll INSIDE the sheet; the page itself never has to.
    // WIDE + LANDSCAPE (owner): the sheet breaks out of the shell's 1000px main
    // (the house left-1/2 breakout, capped at 1280) and the height stops at
    // 680px on tall screens, so the panel reads wide rather than tall.
    <>
      {/* FIXED layers live OUTSIDE the layout root: its lg translate-x makes a
          transformed ancestor, which turns position:fixed into container-scoped
          (the backdrop stopped at the panel's edges — owner report) */}
      {showIntro && (
        <IntroOverlay
          onDone={() => {
            setShowIntro(false)
            setEntered(true)
          }}
        />
      )}
    <div
      className={
        embed
          ? 'flex h-[560px] w-full flex-col lg:relative lg:left-1/2 lg:h-[680px] lg:w-[min(1480px,calc(100vw-3rem))] lg:-translate-x-1/2 lg:flex-row lg:items-stretch lg:gap-6'
          : 'flex h-[calc(100dvh-12rem)] min-h-[380px] w-full flex-col lg:relative lg:left-1/2 lg:-mt-3 lg:h-[calc(100dvh-7.5rem)] lg:max-h-[780px] lg:w-[min(1480px,calc(100vw-3rem))] lg:-translate-x-1/2 lg:flex-row lg:items-stretch lg:gap-6'
      }
    >

      {/* ── the RIGHT COLUMN (owner 19:2x revision: chat LEFT, this card
             RIGHT): ONE glass card — the stage on top, the mascot below it,
             inside the same background card. Phones keep the compact mascot
             band above the sheet (the stage content lives in the bubbles
             there); lg:order-2 puts the card after the sheet visually. ── */}
      <div
        className={`relative z-[45] hidden lg:order-2 lg:flex lg:h-auto lg:w-[44%] lg:flex-col lg:overflow-hidden lg:rounded-[32px] lg:border lg:border-white/[0.12] lg:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.07),0_16px_48px_rgba(0,0,0,0.28)] ${entered ? 'enter' : 'opacity-0'}`}
        /* OPAQUE on every plane (owner: no see-through card on dark) — the
           panel token is the ground, the white wash rides on top of it */
        style={{ background: 'linear-gradient(rgba(255,255,255,0.05), rgba(255,255,255,0.05)), var(--color-panel)', ['--enter-i' as string]: 1 } as React.CSSProperties}
      >
        <div aria-hidden className="hidden h-px w-full shrink-0 opacity-70 lg:block" style={{ background: GRADIENT }} />
        <div className={`hidden min-h-0 flex-1 lg:flex ${entered ? 'enter' : ''}`} style={{ ['--enter-i' as string]: 3 } as React.CSSProperties}>
          <StagePanel stage={stage} />
        </div>
        {/* the bottom band: the stage's doors LEFT, the mascot RIGHT — the
            peripheral content shares the mascot's row so the stage above gets
            the card's height (owner 21:0x) */}
        <div className="relative flex min-h-0 flex-1 items-end justify-center lg:h-44 lg:flex-none lg:flex-row lg:items-center lg:justify-between lg:gap-4 lg:border-t lg:border-white/[0.08] lg:px-6">
          <div className="hidden min-w-0 flex-1 lg:block">
            <StageActions stage={stage} hintSymbol={hintSymbol} tradeCardLive={tradeCardLive} onPick={(line) => void send(line)} />
          </div>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 mx-auto opacity-25 blur-3xl"
            style={{ background: 'radial-gradient(55% 55% at 50% 45%, var(--color-violet-bright), transparent 72%)' }}
          />
          {[
            ['12%', '22%', 'var(--color-cyan)', '2.6s', '0s'],
            ['78%', '18%', 'var(--color-magenta)', '3.4s', '0.6s'],
            ['16%', '64%', 'var(--color-violet-bright)', '3s', '1.1s'],
            ['66%', '78%', 'var(--color-cyan)', '2.8s', '0.3s'],
            ['44%', '8%', 'var(--color-magenta)', '3.8s', '0.9s'],
          ].map(([l, t, c, dur, del], i) => (
            <span
              key={i}
              aria-hidden
              className="chat-tw pointer-events-none absolute h-1 w-1 rounded-full"
              style={{ left: l, top: t, background: c, boxShadow: `0 0 6px ${c}`, ['--dur' as string]: dur, ['--del' as string]: del }}
            />
          ))}
          <div className="chat-float relative lg:shrink-0">
            <ChatMascot ref={mascot} entrance={false} size={264} className="h-auto w-36 drop-shadow-[0_6px_16px_rgba(0,0,0,0.18)] sm:w-40 lg:w-44" />
          </div>
        </div>
      </div>

      {/* ── the sheet: bottom sheet on phones, the LEFT panel on lg ── */}
      <div
        className={`relative z-[45] flex min-h-0 flex-1 flex-col overflow-hidden rounded-[24px] border border-white/[0.12] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.07),0_-16px_48px_rgba(0,0,0,0.28)] lg:order-1 lg:rounded-[32px] lg:rounded-t-[32px] lg:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.07),0_16px_48px_rgba(0,0,0,0.28)] ${entered ? 'enter' : 'opacity-0'}`}
        style={{ background: 'linear-gradient(rgba(255,255,255,0.05), rgba(255,255,255,0.05)), var(--color-panel)' }}
      >
        {/* the brand hairline along the top edge (the Integrate bento's strip, quieter) */}
        <div aria-hidden className="h-px w-full shrink-0 opacity-70" style={{ background: GRADIENT }} />
        {/* ambient interior light: violet where the mascot leans in, cyan far corner */}
        <div
          aria-hidden
          className="pointer-events-none absolute -left-24 top-8 h-72 w-72 opacity-[0.13] blur-3xl"
          style={{ background: 'radial-gradient(closest-side, var(--color-violet-bright), transparent)' }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-24 -right-16 h-80 w-80 opacity-[0.09] blur-3xl"
          style={{ background: 'radial-gradient(closest-side, var(--color-cyan), transparent)' }}
        />
        <div aria-hidden className="absolute left-1/2 top-2.5 h-1 w-28 -translate-x-1/2 rounded-full bg-white/[0.14] lg:hidden" />

        {/* header */}
        <div className={`flex h-[72px] shrink-0 items-center justify-between gap-3 border-b border-white/[0.08] px-4 sm:px-6 ${entered ? 'enter' : ''}`} style={{ ['--enter-i' as string]: 2 } as React.CSSProperties}>
          <div className="flex min-w-0 items-center gap-3">
            <div className="relative">
              <div className="rounded-full p-[1.5px]" style={{ background: GRADIENT }}>
                <div className="grid h-10 w-10 place-items-center overflow-hidden rounded-full bg-void">
                  <ChatMascot entrance={false} size={30} />
                </div>
              </div>
              <span aria-hidden className="chat-dot absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-void" style={{ background: 'var(--color-teal)' }} />
            </div>
            <div className="min-w-0">
              <h1 className="font-display text-sm font-bold uppercase tracking-[0.08em] text-ink">Agent Specter</h1>
              <p className="truncate text-[12px] text-ink-dim">Your friendly ghost that&rsquo;s boo-lish on baskets</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => {
                newChat()
              }}
              title={confirmClear ? 'Tap again: this clears your draft' : 'New chat'}
              aria-label={confirmClear ? 'Tap again to confirm clearing the draft' : 'Start a new chat'}
              className={`grid h-8 w-8 place-items-center rounded-full border transition-colors ${confirmClear ? 'border-[color:var(--color-amber)] text-ink' : 'border-white/[0.16] text-ink-faint hover:border-white/[0.3] hover:text-ink-dim'}`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => {
                const on = !sfx
                setSfx(on)
                setSfxEnabled(on)
                if (on) {
                  // this click IS the autoplay gesture — greet in sound + wave
                  preloadSfx()
                  playSfx('hello')
                  mascot.current?.wave()
                }
              }}
              title={sfx ? 'Sound on. Specter chirps' : 'Sound off. click to let Specter chirp'}
              aria-pressed={sfx}
              aria-label={sfx ? 'Turn Specter sounds off' : 'Turn Specter sounds on'}
              className={`grid h-8 w-8 place-items-center rounded-full border transition-colors ${sfx ? 'border-white/[0.28] text-ink' : 'border-white/[0.16] text-ink-faint hover:border-white/[0.3] hover:text-ink-dim'}`}
            >
              {sfx ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 5 6 9H2v6h4l5 4V5Z" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 5 6 9H2v6h4l5 4V5Z" />
                  <line x1="22" x2="16" y1="9" y2="15" />
                  <line x1="16" x2="22" y1="9" y2="15" />
                </svg>
              )}
            </button>
            {WALLET_ENABLED && <WalletButton />}
          </div>
        </div>

        {/* messages */}
        <div className={`relative flex min-h-0 flex-1 flex-col ${entered ? 'enter' : ''}`} style={{ ['--enter-i' as string]: 3 } as React.CSSProperties}>
          <div ref={scrollRef} aria-live="polite" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden px-4 py-5 sm:px-6">
            <MessageList msgs={msgs} onPick={(line) => void send(line)} onDeployed={noteDeployed} />
          </div>
          {jump && (
            <button
              type="button"
              onClick={toBottom}
              className="chat-msg absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-white/[0.16] px-3.5 py-1.5 font-display text-[11px] font-bold uppercase tracking-[0.1em] text-ink shadow-[0_8px_24px_rgba(0,0,0,0.3)] backdrop-blur-md"
              style={{ background: 'color-mix(in srgb, var(--color-panel) 88%, transparent)' }}
            >
              New reply ↓
            </button>
          )}
        </div>

        {/* the phone stage strip: the staged basket stays in sight without the
            desktop card — avatar, price, 24h, Buy/Sell, one row (lg has the
            full stage panel instead) */}
        {stage && (
          <div className="flex shrink-0 items-center gap-2.5 border-t border-white/[0.08] px-4 py-2 lg:hidden">
            <BasketAvatar address={stage.data.address} symbol={stage.data.symbol} size={28} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-display text-[13px] font-bold leading-tight text-ink">${showSymbol(stage.data.symbol)}</div>
              <div className="truncate font-mono text-[10px] text-ink-dim">${stage.data.navPerToken.toFixed(stage.data.navPerToken >= 1 ? 2 : 4)}</div>
            </div>
            {/* same stand-down as the desktop stage: never a second Buy beside
                the armed one on the card (owner 2026-08-21) */}
            {tradeCardLive ? (
              <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.13em] text-ink-faint">on the card above</span>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => void send(`buy $${stage.data.symbol}`)}
                  className="shrink-0 rounded-full px-3.5 py-1.5 font-display text-[12px] font-bold text-void"
                  style={{ background: GRADIENT }}
                >
                  Buy
                </button>
                <button
                  type="button"
                  onClick={() => void send(`sell $${stage.data.symbol}`)}
                  className="shrink-0 rounded-full border border-white/[0.16] bg-white/[0.06] px-3.5 py-1.5 text-[12px] text-ink"
                >
                  Sell
                </button>
              </>
            )}
          </div>
        )}
        {/* ONE suggestion system (owner 23:2x + 23:3x: same row for starters
            and contextual, compact one-line pills, horizontal rail with
            chevrons + wheel/trackpad slide) */}
        <div className={`shrink-0 px-4 pb-3 sm:px-6 ${entered ? 'enter' : ''}`} style={{ ['--enter-i' as string]: 4 } as React.CSSProperties}>
          <SuggestionRail chips={chips} onPick={(line) => void send(line)} />
        </div>

        {/* (the phone stage strip renders ONCE, above the suggestion rail —
            a verbatim duplicate of it sat here for two days and phones drew
            the Buy/Sell strip twice; Daylight's kit adoption caught it) */}

        {/* input */}
        <div className={`shrink-0 border-t border-white/[0.08] bg-black/[0.12] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6 ${entered ? 'enter' : ''}`} style={{ ['--enter-i' as string]: 5 } as React.CSSProperties}>
          {draftLabel && (
            <div className="mb-2 flex px-1">
              <DraftPill label={draftLabel} onPick={(line) => void send(line)} />
            </div>
          )}
          {inputHint && <p className="mb-1.5 px-2 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-faint">{inputHint}</p>}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void send()
            }}
            className="flex items-center gap-1.5 rounded-full border border-white/[0.14] bg-white/[0.05] p-1.5 transition-[border-color,background-color,box-shadow] duration-300 focus-within:border-white/[0.28] focus-within:bg-white/[0.08] focus-within:shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-violet-bright)_55%,transparent),0_0_28px_-8px_var(--color-violet-bright)]"
          >
            <input
              ref={inputRef}
              type="text"
              maxLength={400}
              value={input}
              onKeyDown={(e) => {
                // ArrowUp on an EMPTY input recalls the last sent message
                if (e.key === 'ArrowUp' && !input.trim()) {
                  const last = recallLast()
                  if (last) {
                    e.preventDefault()
                    setInput(last)
                  }
                }
              }}
              onChange={(e) => {
                setInput(e.target.value)
                mascot.current?.setTyping(true)
              }}
              onFocus={() => mascot.current?.setTyping(true)}
              onBlur={() => mascot.current?.setTyping(false)}
              placeholder="Buy SVI · paste an address · create a basket of…"
              aria-label="Message Agent Specter"
              className="min-w-0 flex-1 bg-transparent px-3 text-sm text-ink outline-none placeholder:text-ink-faint"
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              aria-label="Send"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-void transition-transform enabled:hover:scale-105 disabled:opacity-40"
              style={{ background: GRADIENT, boxShadow: '0 0 16px -4px color-mix(in srgb, var(--color-magenta) 65%, transparent)' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="ml-0.5">
                <path d="m22 2-7 20-4-9-9-4Z" />
                <path d="M22 2 11 13" />
              </svg>
            </button>
          </form>
          <p className="mt-2 px-2 text-center text-[11px] leading-relaxed text-ink-faint">
            Non-custodial: every action returns a transaction your own wallet signs. Nothing here is financial advice.
          </p>
        </div>
      </div>
    </div>
    </>
  )
}
