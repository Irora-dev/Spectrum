import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import {
  lastLinkWritePersisted,
  addLink,
  alreadyLinkedMember,
  classifyLink,
  exportBundle,
  groupFor,
  importBundle,
  linkMessage,
  LINKS_CHANGED_EVENT,
  loadLinks,
  removeLink,
  verifyLink,
  type WalletGroup,
  type WalletLink,
} from './wallet-links'

// ─────────────────────────────────────────────────────────────────────────────
// use-wallet-group — the React face of wallet-links (the analytical core stays
// React-free, the house law). Owns two things:
//
//  1. THE GROUP for the active address: links loaded once, signature-verified
//     before they join the read (a hand-edited record must not merge wallets),
//     resolved from either side (anchor or member).
//
//  2. THE LINK CEREMONY, a three-state machine driven by the wallet itself:
//       idle → 'switch'  (user said "link another" — now switch accounts in
//                         the wallet app; we cannot do that for them)
//            → 'sign'    (a NEW address arrived while armed — it signs the
//                         plain-language message binding it to the anchor)
//            → idle      (verified + stored, group refreshes)
//     The anchor is CAPTURED when the ceremony starts — the active address
//     will change mid-flow by design, and the message must bind to the wallet
//     the user started from, not whatever is connected at sign time.
// ─────────────────────────────────────────────────────────────────────────────

export type LinkStage = 'idle' | 'switch' | 'sign' | 'signing'

export interface UseWalletGroup {
  group: WalletGroup
  /** The addresses the portfolio should read. Never empty when active is set. */
  addresses: string[]
  /** True when the group is more than the active wallet alone. */
  isGroup: boolean
  stage: LinkStage
  /** The wallet that will sign next (stage 'sign'/'signing'). */
  candidate: string | null
  /** Start the ceremony: arm for the next NEW account the wallet presents —
   *  and summon the wallet's own account picker where the wallet supports it. */
  beginLink: (opts?: { into?: string }) => void
  cancelLink: () => void
  /** Re-summon the wallet's account picker (stage 'switch') — the manual
   *  switch instructions stay as the fallback for wallets without one. */
  chooseAccount: () => void
  /** Whether `chooseAccount` is expected to DO anything on this connector.
   *  Rabby-class wallets silently ignore `wallet_requestPermissions` (accounts
   *  switch in the extension's own UI), so the step's button reads as dead
   *  there (the owner, live 15:4x) — the panel swaps it for the passive
   *  instruction instead. Detection is POSITIVE-only (announced name/id, or
   *  the provider's own `isRabby` flag): an unknown wallet keeps the button,
   *  which stays best-effort + watcher-backed as before. */
  pickerSupported: boolean
  /** Stage 'sign' only: ask the connected (candidate) wallet to sign. */
  signLink: () => Promise<boolean>
  unlink: (member: string) => void
  /** The group as a carryable JSON bundle (cross-device, user-transported). */
  exportJson: () => string
  /** Absorb a bundle: every record re-verified before it joins. Null = not a
   *  bundle at all. */
  importJson: (json: string) => Promise<{ added: number; rejected: number; capped: number } | null>
  /** Stored links the session screen could not JUDGE today (RPC weather) —
   *  kept in the read, and the panel says so rather than hiding the state. */
  unverifiedToday: number
  /** Armed, and the connected account is one this book ALREADY reads (and not
   *  the account the ceremony started from): the panel says so instead of
   *  waiting forever — the third of the owner's three states (2026-08-05). */
  alreadyLinked: string | null
  /** Last ceremony error, user-worded. Cleared on any state advance. */
  error: string | null
}

/** ONE session screen per page load, shared by every mount (found 2026-08-11).
 *  The hook mounts at least twice on a page — the nav's book total and the page
 *  itself — and each ran the whole classify sweep independently: a doubled RPC
 *  bill on the smart-contract-wallet path, and two sweeps finishing at
 *  different moments, so the two mounts could briefly disagree about the group
 *  the header comment below promises they never will. The verdicts are the
 *  same for both; compute them once and hand the same answer out. */
let sessionScreen: Promise<{ unknown: number; bad: Set<string> }> | null = null
function screenOnce(): Promise<{ unknown: number; bad: Set<string> }> {
  if (!sessionScreen) {
    const initial = loadLinks()
    sessionScreen = Promise.all(initial.map((l) => classifyLink(l))).then((verdicts) => ({
      unknown: verdicts.filter((v) => v === 'unknown').length,
      bad: new Set(initial.filter((_, i) => verdicts[i] === 'unsound').map((l) => l.member.toLowerCase())),
    }))
  }
  return sessionScreen
}

export function useWalletGroup(active?: string): UseWalletGroup {
  const { address: connected, connector } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const [links, setLinks] = useState<WalletLink[]>(() => loadLinks())
  const [stage, setStage] = useState<LinkStage>('idle')
  const [error, setError] = useState<string | null>(null)
  // The anchor is pinned at beginLink — see the header comment.
  const anchorRef = useRef<string | null>(null)
  // The account the ceremony STARTED from, pinned beside it: the already-linked
  // face must never fire for the wallet the user is simply still standing on.
  const originRef = useRef<string | null>(null)
  const [candidate, setCandidate] = useState<string | null>(null)

  // Screen stored records once per session: only the DEFINITELY bad drop —
  // a downed RPC (verdict 'unknown') must never shrink a real group, and the
  // KEPT-BUT-UNJUDGED count is surfaced so the panel can say so. The screen
  // can spend seconds on RPC, so its resolve filters the CURRENT registry
  // rather than writing back its mount-time snapshot — a link added meanwhile
  // (ceremony, import, another tab) must survive it.
  const [unverifiedToday, setUnverifiedToday] = useState(0)
  useEffect(() => {
    let alive = true
    if (loadLinks().length === 0) return
    void screenOnce().then(({ unknown, bad }) => {
      if (!alive) return
      setUnverifiedToday(unknown)
      // PERSIST the drop (found 2026-08-11). Filtering local state alone left
      // the rejected record in storage, and every instance re-reads storage on
      // the next mutation (`reload` below) — so the next link, unlink or
      // import RESURRECTED a signature this screen had judged definitively
      // unsound, until a full reload. 'unsound' means every chain answered no;
      // that verdict deserves to outlive the render. ('unknown' is still kept,
      // deliberately — transport weather must never shrink a real group.)
      if (bad.size > 0) {
        let next = loadLinks()
        for (const member of bad) next = removeLink(member)
        setLinks(next)
      }
    })
    return () => {
      alive = false
    }
  }, [])

  // EVERY instance of this hook re-reads on any registry mutation — the
  // ceremony's mount and the page's mount must never disagree about the
  // group (the intro links a wallet; the page behind it shows the merge).
  // The 'storage' listener extends the same law across tabs.
  useEffect(() => {
    const reload = () => setLinks(loadLinks())
    window.addEventListener(LINKS_CHANGED_EVENT, reload)
    window.addEventListener('storage', reload)
    return () => {
      window.removeEventListener(LINKS_CHANGED_EVENT, reload)
      window.removeEventListener('storage', reload)
    }
  }, [])

  // The ceremony's account watcher: armed + a genuinely NEW address = the
  // candidate has arrived. Also live at stage 'sign' (not 'signing'): a user
  // who switches to a THIRD account before signing gets that account offered
  // — the old candidate's name on the button with a different wallet
  // connected was a guaranteed wallet-side rejection blamed on the user.
  useEffect(() => {
    if ((stage !== 'switch' && stage !== 'sign') || !connected) return
    const anchor = anchorRef.current
    if (!anchor) return
    const grp = groupFor(anchor, links)
    const c = connected.toLowerCase()
    const promotable = c !== anchor && !grp.addresses.includes(c)
    if (promotable && c !== candidate) {
      setCandidate(c)
      setError(null)
      setStage('sign')
      return
    }
    // ⚠ THE STALE CANDIDATE (found 2026-08-11). Armed with candidate C, the
    // user switches BACK to the wallet they started from (or to any account
    // the book already reads). The promotion guard above cannot fire — so
    // `candidate` used to stay C while the wallet sat elsewhere, and the sign
    // face kept offering "sign as C". Pressing it asked the connector for C's
    // signature while it was pointed at another account: a guaranteed
    // wallet-side refusal, surfaced as "The signature was declined" — the
    // machine blaming the user for its own stale state. A candidate the
    // connected wallet cannot produce is not a candidate: drop it and go back
    // to asking for the switch (the already-linked face still speaks for the
    // member case, since it reads stage 'switch' too).
    if (!promotable && candidate) {
      setCandidate(null)
      setError(null)
      setStage('switch')
    }
  }, [stage, connected, links, candidate])

  // Does the connected wallet's picker actually answer? (desk 215 — the owner on
  // Rabby: "whats the open account picker supposed to do? seems redundant".)
  // Sync check on the announced identity first (EIP-6963 name/id), then the
  // provider's own flag for Rabby hiding behind the generic injected
  // connector. Defaults to true: only a POSITIVE identification hides the
  // button, so unknown wallets keep today's best-effort behavior.
  const [pickerSupported, setPickerSupported] = useState(true)
  useEffect(() => {
    let alive = true
    void (async () => {
      const meta = `${connector?.id ?? ''} ${connector?.name ?? ''}`.toLowerCase()
      let rabby = meta.includes('rabby')
      if (!rabby && connector) {
        try {
          const p = (await connector.getProvider()) as { isRabby?: boolean } | undefined
          rabby = p?.isRabby === true
        } catch {
          /* provider unreadable: keep the button (best-effort as before) */
        }
      }
      if (alive) setPickerSupported(!rabby)
    })()
    return () => {
      alive = false
    }
  }, [connector])

  // Summon the wallet's own account picker (super-easy path, owner ~11:3x):
  // `wallet_requestPermissions` re-opens the account selector on MetaMask-class
  // injected wallets. Best-effort by design — a wallet that rejects or does not
  // know the method simply leaves the manual switch instructions standing.
  const chooseAccount = useCallback(() => {
    void (async () => {
      try {
        const provider = (await connector?.getProvider()) as
          | { request?: (args: { method: string; params?: unknown[] }) => Promise<unknown> }
          | undefined
        if (!provider?.request) return
        await provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] })
      } catch {
        /* declined or unsupported — the watcher still catches a manual switch */
      }
    })()
  }, [connector])

  const beginLink = useCallback(
    (opts?: {
      /** The wallet whose GROUP the ceremony joins. Absent = the active
       *  account's own group (the original flow, byte-identical). Passed by
       *  the already-switched path (the onboarding latch, owner 2026-08-06
       *  16:2x): the user swapped FIRST, so the group to grow is the HELD
       *  book's — arming with the active account's own anchor made
       *  connected === anchor and the watcher could never promote, so the
       *  sign prompt never came. */
      into?: string
    }) => {
      const a = (active ?? connected)?.toLowerCase()
      if (!a) return
      const root = (opts?.into ?? a).toLowerCase()
      // The ceremony binds to the GROUP's anchor, so linking from a member
      // still grows the one group rather than starting a second.
      anchorRef.current = groupFor(root, links).anchor
      originRef.current = root
      setCandidate(null)
      setError(null)
      setStage('switch')
      // One click does it where the wallet allows: the picker opens
      // immediately; picking the other account IS the switch the watcher is
      // waiting for. SKIPPED when the connected account already qualifies as
      // the candidate (the already-switched path) — the watcher promotes it
      // on arm, and the picker there is pure noise (Rabby ignores it anyway).
      const anchor = anchorRef.current
      const c = connected?.toLowerCase()
      const alreadyQualifies = !!c && !!anchor && c !== anchor && !groupFor(anchor, links).addresses.includes(c)
      if (!alreadyQualifies) chooseAccount()
    },
    [active, connected, links, chooseAccount],
  )

  const cancelLink = useCallback(() => {
    anchorRef.current = null
    originRef.current = null
    setCandidate(null)
    setError(null)
    setStage('idle')
  }, [])

  const signLink = useCallback(async (): Promise<boolean> => {
    const anchor = anchorRef.current
    const member = candidate
    if (stage !== 'sign' || !anchor || !member) return false
    setStage('signing')
    setError(null)
    const message = linkMessage(anchor, member, window.location.host, Date.now())
    try {
      const signature = await signMessageAsync({ account: member as `0x${string}`, message })
      const link: WalletLink = { anchor, member, message, signature, linkedAt: Date.now() }
      // Verify what actually came back before storing. EOAs verify by
      // recovery; smart-contract wallets verify on-chain (ERC-1271/6492 —
      // verifyLink's fallback). Only a signature NOBODY vouches for refuses.
      if (!(await verifyLink(link))) {
        setError('This signature could not be verified as that wallet’s, so it cannot link.')
        setStage('sign')
        return false
      }
      setLinks(addLink(link))
      anchorRef.current = null
      originRef.current = null
      setCandidate(null)
      setStage('idle')
      if (!lastLinkWritePersisted()) {
        // the link WORKS this session (in-memory read), but the browser
        // refused the write — the honest sentence beats a silent reload-loss
        setError(
          'Linked for this session — but this browser refused to save it (private mode or full storage), so the link will not survive a reload. Export the bundle to keep it.',
        )
      }
      return true
    } catch {
      setError('The signature was declined.')
      setStage('sign')
      return false
    }
  }, [stage, candidate, signMessageAsync])

  const unlink = useCallback((member: string) => {
    setLinks(removeLink(member))
  }, [])

  const exportJson = useCallback(() => JSON.stringify(exportBundle(), null, 2), [])

  const importJson = useCallback(async (json: string) => {
    const res = await importBundle(json)
    if (res) setLinks(loadLinks())
    return res
  }, [])

  const group = useMemo(() => groupFor(active, links), [active, links])
  const addresses = group.addresses.length > 0 ? group.addresses : active ? [active.toLowerCase()] : []

  // Derived fresh each render, never stored — switching onward to a genuinely
  // new account must clear this the same instant the watcher offers the sign.
  // Not at 'signing': the wallet prompt is up for the candidate, and swapping
  // the face under a live prompt would blame the user for the wallet's error.
  const alreadyLinked = useMemo(
    () =>
      stage === 'switch' || stage === 'sign'
        ? alreadyLinkedMember(connected, anchorRef.current, originRef.current, candidate, links)
        : null,
    [stage, connected, candidate, links],
  )

  return {
    group,
    addresses,
    isGroup: addresses.length > 1,
    stage,
    candidate,
    beginLink,
    cancelLink,
    chooseAccount,
    pickerSupported,
    signLink,
    unlink,
    exportJson,
    importJson,
    unverifiedToday,
    alreadyLinked,
    error,
  }
}
