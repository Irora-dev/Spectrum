// THE CHAT SESSION, as one shared hook (owner 2026-08-20: the site-wide
// Specter widget must be "the full capabilities of the chat system" — so the
// page and the widget mount the SAME machinery, never a copy). Everything
// conversational lives here: the message log + persistence, the send loop
// with its timeout/retry, greeting, restore acknowledgment, wallet-aware
// proactivity, the cheer/traded window events, chips. The consumers own only
// chrome: the page adds its stage + entrance, the widget its popover.
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useAccount } from 'wagmi'
import type { Address } from 'viem'
import { DEFAULT_AGENT_CTX, cachedBasket, cachedList, clampChainText, handle, loadWatches, saveWatches, type AgentAction, type AgentContext } from './agent'
import { playSfx } from './sfx'
import type { MascotHandle } from './ChatMascot'
import type { BasketData } from '../../lib/spectrum/basket-data'
import { erc20BalanceAbi } from '../../lib/spectrum/abis-v2'
import { clientFor } from '../../lib/chain/rpc'
import { CHAINS } from '../../lib/chain/chains'
import { setActiveChainId, useActiveChainId } from '../../lib/chain/active-chain'

export interface Msg {
  id: number
  role: 'user' | 'agent'
  text?: string
  actions?: AgentAction[]
  thinking?: boolean
  /** wall-clock of arrival — the tiny stamp under the bubble */
  at: number
}

export const stampOf = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

export const CHIPS = [
  'What baskets are there?',
  'Best performers in the last 24 hours?',
  'Help me create my own basket',
  'What do I hold?',
  'How does this work?',
]

export type Stage = { chainId: number; data: BasketData; weights: number[] } | null

/** Suggestions tailored to what the agent just answered (owner 2026-08-19:
 *  always-on, always contextual, always resettable). Null = keep the mains. */
export function chipsFor(actions: AgentAction[]): string[] | null {
  for (const a of actions) {
    if (a.kind === 'basket') {
      const s = a.data.symbol
      return [`Buy $${s}`, `Sell $${s}`, 'How do I exit?', 'What baskets are there?']
    }
    if (a.kind === 'trade') {
      const s = a.basket.symbol
      return a.side === 'buy'
        ? ['What do I hold?', `Sell $${s}`, 'What baskets are there?']
        : ['What do I hold?', `Buy $${s}`, 'What baskets are there?']
    }
    if (a.kind === 'positions' && a.rows.length > 0) {
      const s = a.rows[0].symbol
      return [`Sell $${s}`, `Buy $${s}`, 'How do I exit?', 'What baskets are there?']
    }
    if (a.kind === 'baskets' && a.rows.length > 0) {
      const picks = a.rows.slice(0, 2).map((r) => `Read $${r.symbol}`)
      return [...picks, 'What do I hold?', 'Create a basket of VVV and AERO']
    }
    if (a.kind === 'create') return ['What baskets are there?', 'What do I hold?']
    if (a.kind === 'movers') {
      const picks = a.baskets.slice(0, 2).map((b) => `Read $${b.symbol}`)
      return [...picks, 'Best performers this week?', 'Best performers this month?']
    }
    if (a.kind === 'share') return [`Get my referral link`, 'What baskets are there?']
    if (a.kind === 'referral') return ['What do I hold?', 'What baskets are there?']
    if (a.kind === 'candidates') return ['Start over']
    if (a.kind === 'bundle') return ['What is a bundle?', 'What baskets are there?']
  }
  return null
}

let msgId = 0

// ── session persistence (owner greenlight 2026-08-19): the conversation, the
// draft, the stage and the chain survive a refresh — and now page↔widget
// (same key, same shape). Actions are plain JSON (no bigints anywhere in
// AgentAction), thinking bubbles are dropped, the log is bounded. A failed
// parse or quota just means a fresh session. ──
const PERSIST_KEY = 'specter-chat-v1'
interface PersistShape {
  msgs: Msg[]
  ctx: Pick<AgentContext, 'chainId' | 'lastBasket' | 'draft' | 'drafts' | 'deployedBaskets'>
  stage: Stage
  /** wall-clock of the last save — stale-session hygiene reads it */
  savedAt?: number
}
/** ~3 days: past this, a session with no draft restarts fresh (an ancient
 *  transcript greeting you forever is anti-QoL); a live draft ALWAYS survives
 *  and the restore announce says its age instead. */
const STALE_MS = 72 * 3600_000
/** A pick is {address, symbol} with string fields; a bucket is an array of
 *  them. localStorage is attacker-writable on a shared machine / via an
 *  extension (audit 2026-08-21): a `drafts` value of "x" instead of an array
 *  slipped past the old Array.isArray(msgs)-only check and crashed
 *  draftLabelOf's `.map` inside a useState initializer with no try/catch —
 *  render threw, the chat never mounted, and the poison persisted (a permanent
 *  chat DoS). So the restore is SHAPE-VALIDATED here and dropped whole on any
 *  malformation: a fresh session is always safe, a half-trusted one is not. */
const isPicks = (v: unknown): boolean =>
  Array.isArray(v) && v.every((p) => p != null && typeof p === 'object' && typeof (p as { address?: unknown }).address === 'string' && typeof (p as { symbol?: unknown }).symbol === 'string')
function ctxLooksSane(ctx: unknown): boolean {
  if (ctx == null || typeof ctx !== 'object') return true // absent ctx → defaults; fine
  const c = ctx as Record<string, unknown>
  if (c.drafts != null) {
    if (typeof c.drafts !== 'object' || Array.isArray(c.drafts)) return false
    for (const v of Object.values(c.drafts as Record<string, unknown>)) if (!isPicks(v)) return false
  }
  if (c.draft != null) {
    if (typeof c.draft !== 'object') return false
    if (!isPicks((c.draft as { picks?: unknown }).picks)) return false
  }
  if (c.deployedBaskets != null && !Array.isArray(c.deployedBaskets)) return false
  return true
}
function loadSession(): PersistShape | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as PersistShape
    if (!Array.isArray(p.msgs)) return null
    // every restored message must at least be an object; an actions array, if
    // present, must hold objects with a string `kind` (a poisoned actions blob
    // otherwise renders straight through ActionBlock without ever passing
    // handle()) — drop the whole restore rather than render a forged card
    if (!p.msgs.every((m) => m != null && typeof m === 'object' && (m.actions == null || (Array.isArray(m.actions) && m.actions.every((a) => a != null && typeof (a as { kind?: unknown }).kind === 'string'))))) return null
    if (!ctxLooksSane(p.ctx)) return null
    const hasDraft = Object.values(p.ctx?.drafts ?? {}).some((x) => x.length > 0) || (p.ctx?.draft?.picks.length ?? 0) > 0
    if (p.savedAt && Date.now() - p.savedAt > STALE_MS && !hasDraft) return null
    return p
  } catch {
    return null
  }
}
function saveSession(p: PersistShape): void {
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify({ ...p, savedAt: Date.now(), msgs: p.msgs.filter((m) => !m.thinking).slice(-60) }))
  } catch {
    // quota or private mode — the session just will not persist
  }
}
function clearSession(): void {
  try {
    localStorage.removeItem(PERSIST_KEY)
  } catch {
    // nothing to clear
  }
}

/** Every agent reply announces itself (the FAB's unread dot listens — a
 *  narration landing while the popover is closed must not vanish silently). */
let titleBadged = false
const replyLanded = () => {
  window.dispatchEvent(new Event('specter:reply-landed'))
  // a reply into a HIDDEN tab badges the title until the reader returns
  if (typeof document !== 'undefined' && document.hidden && !titleBadged) {
    titleBadged = true
    const orig = document.title
    document.title = `(1) ${orig}`
    const restore = () => {
      if (document.hidden) return
      document.title = orig
      titleBadged = false
      document.removeEventListener('visibilitychange', restore)
    }
    document.addEventListener('visibilitychange', restore)
  }
}

/** Stick-to-bottom that respects reading: new messages scroll the thread only
 *  while the reader is already near the bottom; scrolled up, they raise a
 *  "new reply" jump pill instead of yanking (QoL 2026-08-20). Shared by the
 *  page and the widget so the two threads behave identically. */
export function useStickyScroll(scrollRef: RefObject<HTMLDivElement | null>, dep: unknown): { jump: boolean; toBottom: () => void } {
  const [jump, setJump] = useState(false)
  const atBottom = useRef(true)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 96
      if (atBottom.current) setJump(false)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (atBottom.current) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    else setJump(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep])
  const toBottom = () => {
    const el = scrollRef.current
    el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setJump(false)
  }
  return { jump, toBottom }
}

/** One line naming the live draft buckets ("Base: $VVV · $AERO"), or null. */
function draftLabelOf(ctx: AgentContext): string | null {
  // defensive by construction: loadSession shape-validates a restored ctx, but
  // this also runs in a useState initializer with no try/catch, so it never
  // assumes picks is an array (a malformed ctx returns no label, never throws)
  const parts: string[] = []
  for (const [id, picks] of Object.entries(ctx.drafts ?? {})) {
    if (Array.isArray(picks) && picks.length) parts.push(`${CHAINS[Number(id)]?.name ?? `chain ${id}`}: ${picks.map((p) => `$${p.symbol}`).join(' · ')}`)
  }
  if (!parts.length && Array.isArray(ctx.draft?.picks) && ctx.draft.picks.length) parts.push(ctx.draft.picks.map((p) => `$${p.symbol}`).join(' · '))
  return parts.length ? parts.join('  ·  ') : null
}

// ── THE WATCH POLLER (module-level: ONE per tab however many surfaces mount).
// Every 60s each persisted watch reads its basket's live NAV; a move past the
// threshold narrates into every mounted thread (specter:watch-tripped) and
// re-baselines so the next move re-alerts. Cross-tab dedupe: the trip
// re-reads storage first — if another tab already re-baselined this minute,
// it stays silent. On LOAD (the multi-session ask): each watch catches up
// against its stored baseline and reports what moved while no tab was open.
let watchPollerStarted = false
let watchCaughtUp = false
let watchTicks = 0
// LEADER ELECTION (rpc thrift): with several tabs open only ONE polls — a
// tab claims the leader key and heartbeats it; a stale heartbeat (>150s)
// means the leader closed and the next tick elects whoever arrives first.
const LEADER_KEY = 'specter-watch-leader'
const TAB_ID = Math.random().toString(36).slice(2)
function iAmLeader(): boolean {
  try {
    const raw = localStorage.getItem(LEADER_KEY)
    const cur = raw ? (JSON.parse(raw) as { id: string; at: number }) : null
    if (!cur || Date.now() - cur.at > 150_000 || cur.id === TAB_ID) {
      localStorage.setItem(LEADER_KEY, JSON.stringify({ id: TAB_ID, at: Date.now() }))
      return true
    }
    return false
  } catch {
    return true // storage broken = poll anyway (single-tab likely)
  }
}
async function watchTick(catchUp: boolean): Promise<void> {
  const watches = loadWatches()
  if (watches.length === 0) return
  for (const w of watches) {
    try {
      const d = await cachedBasket(w.address as Address, w.chainId)
      const nav = d?.navPerToken
      if (!d || nav == null || !(nav > 0) || !(w.baselineNav > 0)) continue
      const pct = (nav / w.baselineNav - 1) * 100
      if (Math.abs(pct) < w.thresholdPct) continue
      // cross-tab dedupe: trust the freshest stored baseline
      const fresh = loadWatches().find((x) => x.chainId === w.chainId && x.address.toLowerCase() === w.address.toLowerCase())
      if (!fresh || Math.abs((nav / fresh.baselineNav - 1) * 100) < fresh.thresholdPct) continue
      const dir = pct >= 0 ? 'up' : 'down'
      const text = catchUp
        ? `While you were away: $${w.symbol} moved ${dir} ${Math.abs(pct).toFixed(2)}% (NAV $${w.baselineNav.toFixed(4)} \u2192 $${nav.toFixed(4)}). Still watching at \u00b1${w.thresholdPct}%.`
        : `$${w.symbol} just moved ${dir} ${Math.abs(pct).toFixed(2)}% (NAV $${w.baselineNav.toFixed(4)} \u2192 $${nav.toFixed(4)}). Watch re-armed at \u00b1${w.thresholdPct}% from here.`
      saveWatches(loadWatches().map((x) => (x.chainId === w.chainId && x.address.toLowerCase() === w.address.toLowerCase() ? { ...x, baselineNav: nav, lastNotifiedAt: Date.now() } : x)))
      window.dispatchEvent(new CustomEvent('specter:watch-tripped', { detail: { text, symbol: w.symbol, chainId: w.chainId, address: w.address } }))
    } catch {
      /* one unreadable watch never blocks the rest */
    }
  }
}
function startWatchPoller(): void {
  if (watchPollerStarted || typeof window === 'undefined') return
  watchPollerStarted = true
  if (!watchCaughtUp) {
    watchCaughtUp = true
    setTimeout(() => void watchTick(true), 4000) // the catch-up, after first paint
  }
  setInterval(() => {
    watchTicks++
    // one tab polls (leader); a HIDDEN leader slows to every 5th tick — the
    // alert still lands near-time, at a fifth of the read cost
    if (!iAmLeader()) return
    if (typeof document !== 'undefined' && document.hidden && watchTicks % 5 !== 0) return
    void watchTick(false)
  }, 60_000)
}

// Remount-proof one-shots (the widget mounts/unmounts as it opens): the
// restore acknowledgment speaks once per page LOAD, and a wallet is greeted
// once per load — never once per popover open.
let announcedRestore = false
const greetedWallets = new Set<string>()

export function useChatSession(opts: { mascot: RefObject<MascotHandle | null>; onStage?: (s: Stage) => void }) {
  const { mascot, onStage } = opts
  const { address } = useAccount()
  const restored = useRef(loadSession())
  const [msgs, setMsgs] = useState<Msg[]>(() => restored.current?.msgs ?? [])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [chips, setChips] = useState<string[]>(CHIPS)
  // the draft pill's reactive source (ctxRef itself is not reactive)
  const [draftLabel, setDraftLabel] = useState<string | null>(() => draftLabelOf({ ...DEFAULT_AGENT_CTX, ...(restored.current?.ctx ?? {}) }))
  // the chain rides the app-wide active store (the nav's coins drive it)
  const chainId = useActiveChainId()
  const ctxRef = useRef<AgentContext>({ ...DEFAULT_AGENT_CTX, ...(restored.current?.ctx ?? {}) })
  // the last REAL user text, so a timeout's 'Try again' chip can resend it
  const lastSentRef = useRef('')
  const greeted = useRef((restored.current?.msgs.length ?? 0) > 0)
  // the stage is persisted HERE (so a widget conversation stages what the
  // page shows later); rendering it is the consumer's business via onStage
  const stageRef = useRef<Stage>(restored.current?.stage ?? null)

  useEffect(() => {
    const top = restored.current?.msgs.reduce((m, x) => Math.max(m, x.id), 0) ?? 0
    if (top > msgId) msgId = top
  }, [])

  // confirmed small wins (copy landed, deploy confirmed) → the thumbs-up
  useEffect(() => {
    const cheer = () => mascot.current?.thumbsup()
    window.addEventListener('specter:cheer', cheer)
    return () => window.removeEventListener('specter:cheer', cheer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // the watch poller (one per tab) + trips narrating into THIS thread
  useEffect(() => {
    startWatchPoller()
    const onTrip = (e: Event) => {
      const info = (e as CustomEvent<{ text: string; symbol: string }>).detail
      if (!info) return
      mascot.current?.lightbulb()
      playSfx('reply', 0.25)
      setMsgs((m) => [...m.slice(-198), { id: ++msgId, role: 'agent', at: Date.now(), actions: [{ kind: 'text', text: info.text }] }])
      setChips([`Read $${info.symbol}`, `Sell $${info.symbol}`, 'My watches'])
      replyLanded()
    }
    window.addEventListener('specter:watch-tripped', onTrip)
    return () => window.removeEventListener('specter:watch-tripped', onTrip)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // a confirmed trade comes BACK into the conversation (the flow's result
  // never strands inside its card): one narration line + the next steps
  useEffect(() => {
    const onTraded = (e: Event) => {
      const info = (e as CustomEvent<{ side: 'buy' | 'sell'; symbol: string; label: string; hash: string }>).detail
      if (!info) return
      mascot.current?.thumbsup()
      playSfx('happy', 0.3)
      setMsgs((m) => [
        ...m.slice(-198),
        {
          id: ++msgId,
          role: 'agent',
          at: Date.now(),
          actions: [
            {
              kind: 'text',
              text: `Landed: ${info.label}. The receipt is the transaction itself; your position is live.`,
            },
          ],
        },
      ])
      setChips(['What do I hold?', `Read $${info.symbol}`, info.side === 'buy' ? `Sell $${info.symbol}` : 'Best performers in the last 24 hours?'])
      replyLanded()
    }
    window.addEventListener('specter:traded', onTraded)
    return () => window.removeEventListener('specter:traded', onTraded)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // a restored session gets ACKNOWLEDGED, not just silently loaded: the agent
  // says what survived (the draft buckets) and offers the next move
  useEffect(() => {
    if (announcedRestore || !greeted.current) return
    const drafts = ctxRef.current.drafts ?? {}
    const parts = Object.entries(drafts)
      .filter(([, p]) => p.length > 0)
      .map(([id, p]) => `${CHAINS[Number(id)]?.name ?? `chain ${id}`} holds ${p.map((x) => `$${x.symbol}`).join(' · ')}`)
    if (parts.length === 0) return
    // an old draft says its age — "still here from last time" reads wrong a
    // week later (QoL 2026-08-20)
    const ageDays = restored.current?.savedAt ? Math.floor((Date.now() - restored.current.savedAt) / 86_400_000) : 0
    const when = ageDays >= 2 ? `from ${ageDays} days ago` : ageDays === 1 ? 'from yesterday' : 'from last time'
    // the flag flips INSIDE the timeout: StrictMode's dev double-invoke clears
    // the first timer, and a pre-flipped flag would silence the announce for
    // real (the widget shot caught the greeting version of this)
    const t = setTimeout(() => {
      if (announcedRestore) return
      announcedRestore = true
      setMsgs((m) => [
        ...m.slice(-198),
        {
          id: ++msgId,
          role: 'agent',
          at: Date.now(),
          actions: [{ kind: 'text', text: `Still here ${when}: your draft ${parts.join('; ')}. Keep going or start over.` }],
        },
      ])
      setChips(['Add another asset', 'Start over', 'Best performers in the last 24 hours?'])
    }, 900)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (greeted.current) return
    const t = setTimeout(() => {
      if (greeted.current) return
      greeted.current = true
      playSfx('hello') // no-op unless sound was turned on a previous visit
      setMsgs([
        {
          id: ++msgId,
          role: 'agent',
          at: Date.now(),
          actions: [
            {
              kind: 'text',
              text: 'Hey, Specter here. I operate baskets from this chat. reading, buying, selling, creating. Name a basket, paste an address, or ask what exists. Everything I bring you signs in YOUR wallet; I never hold keys.',
            },
          ],
        },
      ])
    }, 500)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    ctxRef.current.account = (address as Address | undefined) ?? null
  }, [address])

  // WALLET-AWARE PROACTIVITY (owner greenlight): the first time a wallet
  // connects this page load, Specter reads its holdings once and opens with
  // something real — the positions rail + the top holding's live 24h. Silent
  // when nothing is held; never repeats for the same address.
  useEffect(() => {
    if (!address || greetedWallets.has(address) || busy) return
    greetedWallets.add(address)
    let alive = true
    void (async () => {
      try {
        const list = await cachedList(chainId)
        if (list.length === 0) return
        const client = clientFor(chainId)
        const balances = await Promise.all(
          list.map((b) =>
            client
              .readContract({ address: b.address as Address, abi: erc20BalanceAbi, functionName: 'balanceOf', args: [address as Address] })
              .then((v) => v as bigint)
              .catch(() => 0n),
          ),
        )
        const rows = list
          .map((b, i) => ({ address: b.address as Address, symbol: clampChainText(b.symbol), name: clampChainText(b.name), raw: balances[i] }))
          .filter((r) => r.raw > 0n)
          .map((r) => ({ address: r.address, symbol: r.symbol, name: r.name, shares: (Number(r.raw) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 6 }) }))
        if (!alive || rows.length === 0) return
        const top = await cachedBasket(rows[0].address, chainId).catch(() => null)
        const chg = top?.navSeries && top.navSeries.length >= 2 ? (top.navSeries[top.navSeries.length - 1].value / top.navSeries[0].value - 1) * 100 : null
        const line =
          rows.length === 1
            ? `Wallet read. You hold $${rows[0].symbol}${chg != null ? `, ${chg >= 0 ? 'up' : 'down'} ${Math.abs(chg).toFixed(1)}% over the chart window` : ''}. Want the sell card, a top-up, or the exit?`
            : `Wallet read. You hold ${rows.length} baskets here${chg != null ? `; $${rows[0].symbol} is ${chg >= 0 ? 'up' : 'down'} ${Math.abs(chg).toFixed(1)}% over the chart window` : ''}. Tap one:`
        setMsgs((m) => [...m.slice(-198), { id: ++msgId, role: 'agent', at: Date.now(), actions: [{ kind: 'text', text: line }, { kind: 'positions', chainId, rows }] }])
        setChips([`Sell $${rows[0].symbol}`, `Buy $${rows[0].symbol}`, 'How do I exit?'])
        mascot.current?.wave()
        playSfx('reply', 0.25)
      } catch {
        // a failed read greets nobody — silence over a wrong claim
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, chainId])

  useEffect(() => {
    ctxRef.current.chainId = chainId
  }, [chainId])

  useEffect(() => {
    saveSession({
      msgs,
      ctx: {
        chainId,
        lastBasket: ctxRef.current.lastBasket,
        draft: ctxRef.current.draft,
        drafts: ctxRef.current.drafts,
        deployedBaskets: ctxRef.current.deployedBaskets,
      },
      stage: stageRef.current,
    })
  }, [msgs, chainId])

  async function send(raw?: string) {
    const typed = (raw ?? input).trim()
    if (!typed || busy) return
    // the retry chip resends the last real message, never the words 'Try
    // again' (and never becomes the remembered message itself); with nothing
    // remembered it just falls through to the agent as text
    const text = typed === 'Try again' && lastSentRef.current ? lastSentRef.current : typed
    if (typed !== 'Try again') lastSentRef.current = typed
    setInput('')
    setBusy(true)
    mascot.current?.setTyping(false)
    playSfx('send')
    const thinkingId = ++msgId
    // the log is bounded: a marathon session trims its oldest turns, never the UI thread
    setMsgs((m) => [...m.slice(-198), { id: ++msgId, role: 'user', text, at: Date.now() }, { id: thinkingId, role: 'agent', thinking: true, at: Date.now() }])
    if (Math.random() < 0.33) playSfx('think', 0.22) // an occasional curious "hmm?", never every turn
    mascot.current?.setTalking(true)
    const askedAt = Date.now()
    try {
      // a hung RPC must never lock the input — 45s and the turn answers in words
      const reply = await Promise.race([
        handle(text, ctxRef.current),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('the chain did not answer within 45s. try again in a moment')), 45_000)),
      ])
      // the thinking floor (owner 2026-08-19: instant answers felt canned —
      // claimed by ac7bad08's message, never actually shipped): the dots show
      // 550-1000ms minimum; a slow chain read never gets slower
      const floor = 550 + Math.random() * 450
      const elapsed = Date.now() - askedAt
      if (elapsed < floor) await new Promise((r) => setTimeout(r, floor - elapsed))
      ctxRef.current = reply.ctx
      setDraftLabel(draftLabelOf(reply.ctx))
      if (reply.ctx.chainId !== chainId) setActiveChainId(reply.ctx.chainId) // 'on base' in a message flips the nav coin too
      setMsgs((m) => m.map((msg) => (msg.id === thinkingId ? { id: thinkingId, role: 'agent' as const, actions: reply.actions, at: Date.now() } : msg)))
      // whatever basket this turn touched takes the stage (the page's card —
      // noted here either way so a widget conversation stages it for later)
      for (const a of reply.actions) {
        if (a.kind === 'basket') stageRef.current = { chainId: a.chainId, data: a.data, weights: a.weights ?? a.data.holdings.map((h) => h.targetWeightPct) }
        else if (a.kind === 'trade') stageRef.current = { chainId: a.chainId, data: a.basket, weights: a.basket.holdings.map((h) => h.targetWeightPct) }
      }
      if (reply.actions.some((a) => a.kind === 'basket' || a.kind === 'trade')) onStage?.(stageRef.current)
      setChips(reply.chips ?? chipsFor(reply.actions) ?? CHIPS)
      replyLanded()
      if (reply.celebrate) {
        if (reply.actions.some((a) => a.kind === 'create')) mascot.current?.party()
        else mascot.current?.happy()
        playSfx('happy')
      } else {
        const refused = reply.actions.length === 1 && reply.actions[0].kind === 'text' && /refus|did not|could not|cannot|no token|nothing/i.test(reply.actions[0].text)
        if (refused) mascot.current?.confused()
        else if (reply.actions.some((a) => a.kind === 'basket' || a.kind === 'baskets' || a.kind === 'trade' || a.kind === 'positions' || a.kind === 'movers' || a.kind === 'candidates'))
          mascot.current?.lightbulb() // a live read landed: the tool-hit eureka (yields if the sprite is busy)
        playSfx('reply')
      }
    } catch (e) {
      mascot.current?.confused()
      playSfx('oops')
      setMsgs((m) =>
        m.map((msg) =>
          msg.id === thinkingId
            ? {
                id: thinkingId,
                role: 'agent' as const,
                at: Date.now(),
                actions: [{ kind: 'text' as const, text: `Something refused: ${e instanceof Error ? e.message.split('\n')[0] : 'unknown'}. Nothing was sent.` }],
              }
            : msg,
        ),
      )
      setChips(['Try again']) // one tap resends the message that timed out
      replyLanded()
    } finally {
      mascot.current?.setTalking(false)
      setBusy(false)
    }
  }

  // "New chat" with a LIVE DRAFT arms a confirm first (one mis-tap was the
  // whole draft gone); 3s later it disarms
  const [confirmClear, setConfirmClear] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function newChat() {
    if (draftLabel && !confirmClear) {
      setConfirmClear(true)
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
      confirmTimer.current = setTimeout(() => setConfirmClear(false), 3000)
      return
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    setConfirmClear(false)
    clearSession()
    setInput('')
    ctxRef.current = { ...DEFAULT_AGENT_CTX, account: ctxRef.current.account, chainId }
    setDraftLabel(null)
    stageRef.current = null
    onStage?.(null)
    setChips(CHIPS)
    greeted.current = false
    setMsgs([])
    mascot.current?.wave()
    setTimeout(() => {
      if (!greeted.current) {
        greeted.current = true
        setMsgs([{ id: ++msgId, role: 'agent', at: Date.now(), actions: [{ kind: 'text', text: 'Fresh slate. What are we doing?' }] }])
      }
    }, 300)
  }

  /** Baskets deployed in this chat prefill the bundle flow (deduped by leg). */
  function noteDeployed(b: { chainId: number; address: Address; symbol: string }) {
    const list = ctxRef.current.deployedBaskets ?? []
    ctxRef.current.deployedBaskets = [...list.filter((x) => !(x.chainId === b.chainId && x.address.toLowerCase() === b.address.toLowerCase())), b]
  }

  // paste-an-address affordance: the input recognizes what it holds
  const inputHint = useMemo(() => {
    const v = input.trim()
    if (/^0x[0-9a-fA-F]{40}$/.test(v)) return 'contract address. ⏎ reads it'
    if (/^\$[A-Za-z][A-Za-z0-9]{1,11}$/.test(v)) return 'ticker. ⏎ reads it'
    return null
  }, [input])

  return {
    msgs,
    input,
    setInput,
    busy,
    chips,
    draftLabel,
    confirmClear,
    /** ArrowUp on an empty input recalls the last sent message for editing. */
    recallLast: () => lastSentRef.current,
    chainId,
    send,
    newChat,
    noteDeployed,
    inputHint,
    initialStage: restored.current?.stage ?? null,
  }
}
