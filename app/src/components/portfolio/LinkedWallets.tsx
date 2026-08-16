import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { formatUsdCompact, shortAddr } from '../../lib/spectrum/format'
import { downloadStateBackup, importAnyBundle } from '../../lib/spectrum/state-bundle'
import { loadExecLogGroup } from '../../lib/spectrum/exec-log'
import type { UseWalletGroup } from '../../lib/spectrum/use-wallet-group'
import { CopyAddress } from '../CopyAddress'
import { setWalletName, walletName, WALLET_NAMES_CHANGED } from '../../lib/spectrum/wallet-names'

// The utility row's shared chrome (owner 2026-08-05 #10: "real pill buttons",
// not bare text links). One literal so Tailwind's scanner sees every class.
const UTILITY_PILL =
  'press inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-full border border-white/10 bg-white/[0.04] px-2.5 font-mono text-[9px] uppercase tracking-[0.1em] text-ink-dim transition-colors hover:border-cyan/40 hover:text-ink'

// ─────────────────────────────────────────────────────────────────────────────
// LinkedWallets — the wallet-group manager (owner ruling 2026-08-03: sign with
// each wallet to link them to the same portfolio). One control, two faces:
//
//   the PILL — how many wallets this book reads, always visible, one glance.
//   the PANEL — the members, the unlink per member, and the LINK CEREMONY:
//     begin → "switch accounts in your wallet" → the new address arrives →
//     "sign to link it" → signed, verified, stored. The hook owns the state
//     machine (use-wallet-group.ts); this renders it and never invents state.
//
// Honesty in the copy: linking changes the READ ("viewed as one"), acting
// stays with the connected wallet, and the group lives in THIS browser.
// ─────────────────────────────────────────────────────────────────────────────

/** A deterministic identity dot per address — the same address always wears
 *  the same hue, so members are tellable apart at a glance without ENS.
 *  Exported: attribution surfaces (the found step's rows) wear the same dot,
 *  so "which wallet holds this" reads by colour alone across the system. */
export function walletHue(address: string): number {
  let h = 0
  for (let i = 2; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) % 360
  return h
}

export function WalletDot({ address, size = 10 }: { address: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="shrink-0 rounded-full"
      style={{ width: size, height: size, background: `oklch(0.75 0.14 ${walletHue(address)})` }}
    />
  )
}


/** Inline local-name editor for one member — the name is this browser's own
 *  shorthand (wallet-names.ts), never signed, never exported. Click the name
 *  (or "name this wallet") to edit; Enter/blur saves, Escape cancels. */
function WalletNameEditor({ address }: { address: string }) {
  const [tick, setTick] = useState(0)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  useEffect(() => {
    const onChange = () => setTick((v) => v + 1)
    window.addEventListener(WALLET_NAMES_CHANGED, onChange)
    return () => window.removeEventListener(WALLET_NAMES_CHANGED, onChange)
  }, [])
  void tick
  const name = walletName(address)
  if (editing)
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setWalletName(address, draft)
          setEditing(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') setEditing(false)
        }}
        maxLength={24}
        placeholder="name this wallet"
        aria-label={`Name for ${shortAddr(address)}`}
        className="mb-0.5 block w-full max-w-[160px] rounded border border-white/15 bg-black/30 px-1.5 py-0.5 font-mono text-[10px] text-ink outline-none focus:border-cyan/50"
      />
    )
  return (
    <button
      type="button"
      onClick={() => {
        setDraft(name ?? '')
        setEditing(true)
      }}
      title="Name this wallet (saved on this device only)"
      className="press mb-0.5 block max-w-[160px] truncate text-left font-mono text-[10px] uppercase tracking-[0.12em] hover:text-cyan"
    >
      {name ? <span className="text-ink">{name}</span> : <span className="text-ink-faint">name this wallet ✎</span>}
    </button>
  )
}

export function LinkedWallets({
  group,
  active,
  readableByWallet,
  prominent = false,
  drop = 'down',
  trigger,
  icon = false,
}: {
  group: UseWalletGroup
  /** The wallet actually connected right now — the one that can act. */
  active?: string
  /** Per-wallet readable USD (from the merged read's contributors) — shown
   *  beside each member so the group's composition is a fact, not a vibe. */
  readableByWallet?: Map<string, number>
  /** A first-class ACTION face (owner 1410: bigger, obviously an option) —
   *  taller, brighter. Absent = the quiet trigger exactly as it was. */
  prominent?: boolean
  /** Panel direction; 'up' opens above the trigger (owner 1410 — the popup
   *  clipped below the fold). Absent = downward, as it was. */
  drop?: 'down' | 'up'
  /** ICON-ONLY trigger (the owner live 2026-08-13: the hero pair "can just be
   *  made nice symbols and moved next to each other") — a square glyph
   *  button, words on title/aria, the armed state a pulsing badge. Absent =
   *  the labelled pill exactly as it was. */
  icon?: boolean
  /** Optional-absent (the convergence law): absent renders the pill exactly
   *  as before. 'cog' renders the header-idiom settings cog instead — the
   *  PERSISTENT management entry the owner asked for (2026-08-06 16:3x, via
   *  UIGuy's desk) — opening the same panel, anchored viewport-safe (the
   *  cluster sits at the page's left; on phones the panel goes fixed so a
   *  left anchor cannot push it off-screen). A cog instance never AUTO-opens
   *  on ceremony/switch events: two instances share one machine, and the
   *  ambient catcher stays the rail pill alone — a deliberate door, not a
   *  second popup. */
  trigger?: 'cog'
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const { addresses, isGroup, stage, candidate, alreadyLinked, beginLink, cancelLink, chooseAccount, pickerSupported, signLink, unlink, exportJson, unverifiedToday, error } =
    group
  const fileRef = useRef<HTMLInputElement>(null)
  const [importNote, setImportNote] = useState<string | null>(null)
  // The link's MOMENT: a successful sign marks the new member's row for a
  // few seconds — the ceremony otherwise ended in silence.
  const [justLinked, setJustLinked] = useState<string | null>(null)
  const justLinkedTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(justLinkedTimer.current), [])
  async function signAndMark() {
    const member = candidate
    if (!(await signLink()) || !member) return
    setJustLinked(member.toLowerCase())
    window.clearTimeout(justLinkedTimer.current)
    justLinkedTimer.current = window.setTimeout(() => setJustLinked(null), 4000)
  }

  // UNLINK IS IRREVERSIBLE AND WAS ONE TAP. Getting a member back means
  // switching accounts in the wallet and re-doing the whole sign ceremony, so
  // the first tap only ARMS the row and the second removes it — the same
  // two-click guard Setup's Reset uses, auto-disarming after 3s so a forgotten
  // arm never sits waiting for a stray tap. One armed row at a time.
  // THE GROUP'S OWN HISTORY (2026-08-11): the merged timeline existed only in
  // the CSV export — nothing on screen ever showed that the record follows the
  // book. Read when the panel OPENS (localStorage, cheap, but no reason to
  // re-read per render) and re-read whenever the membership changes.
  const [history, setHistory] = useState<ReturnType<typeof loadExecLogGroup>>([])
  useEffect(() => {
    if (!open) return
    setHistory(loadExecLogGroup(addresses))
  }, [open, addresses])

  const [armedUnlink, setArmedUnlink] = useState<string | null>(null)
  const armedTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(armedTimer.current), [])
  function onUnlink(a: string) {
    window.clearTimeout(armedTimer.current)
    if (armedUnlink !== a) {
      setArmedUnlink(a)
      armedTimer.current = window.setTimeout(() => setArmedUnlink(null), 3000)
      return
    }
    setArmedUnlink(null)
    unlink(a)
  }

  function downloadBundle() {
    const blob = new Blob([exportJson()], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'spectrum-wallet-group.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  async function onImportFile(file: File | undefined) {
    if (!file) return
    // one door, both file kinds — shared with the portfolio's recovery door
    setImportNote(await importAnyBundle(await file.text()))
    // reset so re-picking the SAME file (fixed and re-saved) fires again
    if (fileRef.current) fileRef.current.value = ''
  }


  // The ceremony opens the panel and keeps it open; click-outside closes only
  // when idle (mid-ceremony a stray click must not eat the instructions).
  // The COG instance opts out: with two instances on one machine, an ambient
  // stage change (extension-side switch, a ceremony begun in the rail) would
  // otherwise pop BOTH panels. A ceremony begun IN the cog panel needs no
  // auto-reopen — mid-ceremony the panel cannot be closed at all (click-
  // outside is blocked below, Escape cancels the ceremony instead).
  useEffect(() => {
    if (stage !== 'idle' && trigger !== 'cog') setOpen(true)
  }, [stage, trigger])
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (stage !== 'idle') return
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    // CAPTURE phase + preventDefault: Escape closing THIS popover must be
    // consumed before any host dialog's bubble-phase handler sees it — one
    // keypress was closing the panel AND dismissing the whole onboarding
    // (burning its one-shot latch). The host checks defaultPrevented.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (stage !== 'idle') cancelLink()
      else setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey, { capture: true })
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey, { capture: true })
    }
  }, [open, stage, cancelLink])

  if (addresses.length === 0) return null
  const activeLower = active?.toLowerCase()

  return (
    <div ref={rootRef} className="relative inline-block">
      {trigger === 'cog' ? (
        /* THE SETTINGS COG — the header cluster's idiom exactly (the ⓘ/eye
           split): an unpainted 32px tap target, the drawn 15.5px circle
           inside, -m-2 so the box never moves the line. */
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label="Manage linked wallets"
          title="Manage linked wallets"
          className="press -m-2 grid min-h-[32px] min-w-[32px] shrink-0 place-items-center"
        >
          <span
            className={`grid h-[15.5px] w-[15.5px] place-items-center rounded-full border transition-colors ${
              open ? 'border-cyan/50 text-cyan' : 'border-white/25 bg-white/[0.07] text-ink-dim hover:border-white/40'
            }`}
          >
            <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="3.2" />
              <path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1" />
            </svg>
          </span>
        </button>
      ) : (
        /* The action wears its name (owner 2026-08-05 #10): a rounded-rect
           "Link a new wallet" at the hero's top right — the member COUNT lives
           in the header line and the panel title, so the button stays pure
           action. The F6 growth flourish retired with the count label; the
           member row's own "✓ linked" mark still celebrates a new member. */
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label="Link a new wallet"
          title={stage !== 'idle' && !open ? 'Linking…' : 'Link a new wallet'}
          className={
            prominent
              ? 'press inline-flex h-12 items-center gap-2.5 rounded-full border border-cyan/45 bg-cyan/10 px-6 font-display text-[13px] font-bold uppercase tracking-[0.12em] text-cyan transition-colors hover:border-cyan'
              : icon
                ? 'press relative inline-flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-ink-dim transition-colors hover:border-cyan/40 hover:text-ink'
                : 'press inline-flex h-9 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim transition-colors hover:border-cyan/40 hover:text-ink'
          }
        >
          {/* A WALLET, NOT DOTS (the owner 2026-08-06 12:49 #9). The identity dots
              said "these three addresses" on a button whose whole job is adding a
              fourth — the members are named in the panel this opens, and the
              glyph says what the control is instead of restating what it isn't. */}
          <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a1 1 0 0 1 1 1v2" />
            <path d="M3 7.5V17a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1v-2" />
            <path d="M20 10.5h-4a1.75 1.75 0 0 0 0 3.5h4a1 1 0 0 0 1-1v-1.5a1 1 0 0 0-1-1Z" />
          </svg>
          {/* an ARMED machine never hides silently: closing the panel
              mid-ceremony leaves this saying so (audit 2026-08-06 #12) — the
              icon form keeps the vow as a pulsing badge, title carries words */}
          {icon ? (
            stage !== 'idle' && !open ? (
              <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-pulse rounded-full bg-cyan" />
            ) : null
          ) : stage !== 'idle' && !open ? (
            'linking…'
          ) : prominent ? (
            'Link more wallets'
          ) : (
            'Link a new wallet'
          )}
        </button>
      )}

      {open && (
        <div
          className={`intro-step-in z-40 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-white/10 bg-panel p-4 shadow-2xl ${
            trigger === 'cog'
              ? // the cluster sits at the page's LEFT edge: anchor left on
                // desktop. On phones NO pure anchor fits a 320px panel from a
                // mid-header trigger, so it goes fixed — in practice contained
                // by the hero's transformed panel (fixed-in-transform), which
                // lands it as a full-width sheet under the header row; if that
                // containment ever vanishes it degrades to a viewport sheet,
                // still on-screen
                'max-sm:fixed max-sm:inset-x-4 max-sm:top-20 sm:absolute sm:left-0 sm:mt-2'
              : drop === 'up'
                ? 'absolute bottom-full right-1/2 mb-2 translate-x-1/2' // centered on the trigger — right-anchored ran off the left edge of a phone (audit #11)
                : 'absolute right-0 mt-2'
          }`}
        >
          {/* pt-1 on p-4: 20px above the region title (owner #10, "padding
              above the region title") — on the scale, not a random nudge */}
          <p className="pt-1 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
            one portfolio · {addresses.length} wallet{addresses.length === 1 ? '' : 's'} · this browser
          </p>
          {/* the tri-state made VISIBLE: a link the screen could not judge
              today (RPC weather) is kept — and said, not hidden */}
          {unverifiedToday > 0 && (
            <p className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-amber">
              {unverifiedToday} link{unverifiedToday === 1 ? '' : 's'} could not be verified today · kept
            </p>
          )}

          {/* 10+ wallets scroll instead of growing the panel past the
              viewport (the hardening pass) — the panel opens upward on the
              onboarding card, so unbounded height would climb off-screen */}
          <ul className="mt-3 max-h-64 divide-y divide-white/5 overflow-y-auto overscroll-contain">
            {addresses.map((a) => {
              const isActive = a === activeLower
              const isAnchor = a === group.group.anchor
              const usd = readableByWallet?.get(a)
              return (
                <li key={a} className={`flex items-center gap-2.5 py-2 ${a === justLinked ? 'intro-step-in' : ''}`}>
                  <WalletDot address={a} />
                  {/* the shared copy chip (UIGuy's QOL round) — every truncated
                      address is the SAME control, and tapping copies the FULL hex */}
                  <span className="min-w-0 flex-1">
                    {/* the wallet's LOCAL NAME (owner's queue: "name them") —
                        display-only, this browser's shorthand, editable in
                        place; the address chip stays the identity */}
                    <WalletNameEditor address={a} />
                    <CopyAddress address={a} what="wallet address" size="xs" />
                  </span>
                  {a === justLinked && (
                    <span className="intro-step-in font-mono text-[9px] uppercase tracking-[0.12em] text-teal">
                      ✓ linked
                    </span>
                  )}
                  {usd != null && usd > 0 && (
                    // TOKENS + BASKETS since 2026-08-11: the basket read
                    // carries per-wallet attribution now, so this row is what
                    // the wallet actually holds rather than half of it under a
                    // footnote. (The old note said baskets were unattributable
                    // — they were, until the merge started keeping who.)
                    <span
                      className="font-num text-[11px] font-semibold tabular-nums text-ink-dim"
                      title="what this wallet holds — its tokens and its baskets"
                    >
                      {formatUsdCompact(usd)}
                    </span>
                  )}
                  {isActive && a !== justLinked && (
                    <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-cyan">acting</span>
                  )}
                  {!isAnchor && (
                    /* disabled mid-ceremony: unlinking yourself while a link
                       is armed strands the ceremony on its pinned anchor —
                       the signed link would land in a group you just left */

                    /* the 32px tap floor, on a control that was a bare 9px
                       word: the height comes from padding and the -my-1.5
                       gives it back, so the box is tappable without the row
                       growing. Fixed width + right-aligned so "confirm" swaps
                       in under the finger, never shifting the row. */
                    <button
                      type="button"
                      onClick={() => onUnlink(a)}
                      disabled={stage !== 'idle'}
                      className={`-my-1.5 -mr-2 inline-flex min-h-[32px] min-w-[4.5rem] items-center justify-end px-2 font-mono text-[9px] uppercase tracking-[0.12em] transition-colors disabled:pointer-events-none disabled:opacity-40 ${
                        armedUnlink === a ? 'text-magenta' : 'text-ink-faint hover:text-magenta'
                      }`}
                      aria-label={armedUnlink === a ? `Confirm unlinking ${shortAddr(a)}` : `Unlink ${shortAddr(a)}`}
                    >
                      {armedUnlink === a ? 'confirm' : 'unlink'}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>

          {/* the record follows the book: recent runs across every member,
              each tagged with the wallet that made it. Group-only — with one
              wallet this is just the wallet's own history and the CSV already
              carries it. */}
          {isGroup && history.length > 0 && (
            <div className="mt-3 border-t border-white/8 pt-3">
              <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
                recent activity · all {addresses.length} wallets
              </p>
              <ul className="mt-2 space-y-1.5">
                {history.slice(0, 4).map((h) => (
                  <li key={`${h.wallet}:${h.ts}:${h.kind}`} className="flex items-center gap-2">
                    <WalletDot address={h.wallet} size={8} />
                    <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-dim">{h.kind}</span>
                    {h.totalUsd != null && (
                      <span className="font-num text-[10px] tabular-nums text-ink-dim">
                        {formatUsdCompact(h.totalUsd)}
                      </span>
                    )}
                    {h.partial && <span className="font-mono text-[9px] uppercase text-amber-300/85">partial</span>}
                    <span className="ml-auto shrink-0 font-mono text-[9px] uppercase tracking-[0.1em] text-ink-faint">
                      {new Date(h.ts).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                    </span>
                  </li>
                ))}
              </ul>
              {history.length > 4 && (
                <p className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">
                  +{history.length - 4} more · the CSV export carries them all
                </p>
              )}
            </div>
          )}

          {stage === 'idle' && (
            <>
              {/* ⚠ THE ERROR NOBODY COULD SEE (found 2026-08-11). signLink sets
                  stage 'idle' BEFORE setting the persist warning, and the only
                  other {error} renderer sits inside the sign box — which needs
                  stage 'sign'. So the one sentence that matters most, "this
                  browser refused to save the link, export the bundle to keep
                  it", rendered nowhere: the user saw a green ✓, the count tick
                  up, and lost the group on reload with no explanation. */}
              {error && (
                <p className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2 text-[11px] leading-relaxed text-amber-200/90">
                  {error}
                </p>
              )}
              <button
                type="button"
                onClick={() => beginLink()}
                className="spectral-btn press mt-3 inline-flex h-9 w-full items-center justify-center rounded-full font-display text-[11px] font-bold uppercase tracking-[0.12em] text-void"
              >
                Link another wallet
              </button>
              {/* two lines, condensed (owner #10) — the read-vs-act honesty
                  kept: linking changes what the book READS, never who acts */}
              <p className="mt-2.5 text-[11px] leading-relaxed text-ink-faint">
                Linked wallets read as one portfolio. Actions come from the connected wallet.
              </p>
              {/* cross-device: the group travels as a file the user carries;
                  every record is re-verified on the other side. Real pills
                  (owner #10), one shared chrome. */}
              {/* ONE LINE (the owner, 2026-08-07: "these need to fit on one line").
                  They were flex-wrap, so inside a 320px panel the third pill
                  dropped to its own row and the group read as a list of
                  unrelated doors instead of one utility strip. flex-nowrap with
                  tighter gutters and a shorter last label; the pills keep their
                  own padding so the touch targets do not shrink. */}
              <div className="mt-2.5 flex flex-nowrap items-center gap-1.5 border-t border-white/5 pt-2.5">
                {isGroup && (
                  <button type="button" onClick={downloadBundle} className={UTILITY_PILL}>
                    export group
                  </button>
                )}
                {/* the whole-browser backup (targets, drafts, records, links —
                    caches excluded): one file, restore is additive-never-
                    clobber, links re-verify. The one import door reads both
                    file kinds. */}
                <button type="button" onClick={downloadStateBackup} className={UTILITY_PILL}>
                  full backup
                </button>
                <button type="button" onClick={() => fileRef.current?.click()} className={UTILITY_PILL}>
                  import
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json"
                  className="hidden"
                  onChange={(e) => void onImportFile(e.target.files?.[0])}
                />
                {/* the tour's visible door — the replay param, findable
                    without knowing a URL */}
                <Link to="/portfolio?intro=replay" className={UTILITY_PILL}>
                  replay intro
                </Link>
              </div>
              {importNote && <p className="mt-2 text-[11px] leading-relaxed text-ink-dim">{importNote}</p>}
            </>
          )}

          {/* THE THREE STATES (owner #10): none detected · already linked ·
              new wallet detected. One box at a time, each saying which it is. */}

          {stage === 'switch' && !alreadyLinked && (
            <div className="mt-3 rounded-lg border border-cyan/25 bg-cyan/[0.06] p-3">
              {/* LEAD WITH THE INSTRUCTION, not the absence (owner 2026-08-16:
                  "no new wallet detected yet" read as a fault report while the
                  panel was simply waiting — the headline now says what to DO,
                  and the pulse says we are watching for it) */}
              <p className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-cyan">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan" aria-hidden />
                switch to your next wallet
              </p>
              {/* CONNECTOR-ADAPTIVE (desk 215 — the owner on Rabby: "seems
                  redundant or?"): Rabby-class wallets ignore the picker
                  summons, and a button that does nothing is a dead button —
                  the passive instruction IS the step there. The watcher
                  behind both versions is the same switch-detection. */}
              <p className="mt-1.5 text-[11px] leading-relaxed text-ink-dim">
                {pickerSupported
                  ? 'Pick the account you want to add, or switch to it in your wallet app. It appears here the moment it connects.'
                  : 'In your wallet extension, switch to the account you want to add. It appears here the moment it connects.'}
              </p>
              <div className="mt-2.5 flex items-center gap-3">
                {pickerSupported && (
                  <button
                    type="button"
                    onClick={chooseAccount}
                    className="spectral-btn press inline-flex h-9 items-center rounded-full px-5 font-display text-[11px] font-bold uppercase tracking-[0.12em] text-void"
                  >
                    Open account picker
                  </button>
                )}
                <button
                  type="button"
                  onClick={cancelLink}
                  className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint transition-colors hover:text-ink"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* the say-so face — a neutral fact in neutral ink, not a caution:
              the switched-to account is one this book already reads (before
              this, the panel just kept "waiting" — and from the sign face, a
              stale candidate guaranteed a wallet-side rejection) */}
          {alreadyLinked && (
            <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.04] p-3">
              <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink">
                <WalletDot address={alreadyLinked} size={8} />
                {shortAddr(alreadyLinked)} is already linked
              </p>
              <p className="mt-1.5 text-[11px] leading-relaxed text-ink-dim">
                This portfolio already reads that wallet. Switch to a different account to add a
                new one.
              </p>
              <div className="mt-2.5 flex items-center gap-3">
                {/* gated like the switch face's twin (found 2026-08-11: the
                    pickerSupported fix had landed on ONE of the two faces, so
                    Rabby still showed the dead button here) */}
                {pickerSupported && (
                  <button
                    type="button"
                    onClick={chooseAccount}
                    className="spectral-btn press inline-flex h-9 items-center rounded-full px-5 font-display text-[11px] font-bold uppercase tracking-[0.12em] text-void"
                  >
                    Open account picker
                  </button>
                )}
                <button
                  type="button"
                  onClick={cancelLink}
                  className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint transition-colors hover:text-ink"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {(stage === 'sign' || stage === 'signing') && candidate && !alreadyLinked && (
            <div className="mt-3 rounded-lg border border-cyan/25 bg-cyan/[0.06] p-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-cyan">
                new wallet detected
              </p>
              {/* the address IS the content here — the shared copy chip, full
                  hex on tap; the "signature proves ownership" paragraph is
                  gone (owner #10), the signed message itself still says what
                  signing means */}
              <p className="mt-2">
                <CopyAddress address={candidate} what="the detected wallet address" size="sm" />
              </p>
              {error && <p className="mt-1.5 text-[11px] leading-relaxed text-magenta">{error}</p>}
              <div className="mt-2.5 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void signAndMark()}
                  disabled={stage === 'signing'}
                  className="spectral-btn press inline-flex h-9 items-center rounded-full px-5 font-display text-[11px] font-bold uppercase tracking-[0.12em] text-void disabled:opacity-50"
                >
                  {stage === 'signing' ? 'Waiting for the wallet…' : 'Sign to link'}
                </button>
                <button
                  type="button"
                  onClick={cancelLink}
                  className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint transition-colors hover:text-ink"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
