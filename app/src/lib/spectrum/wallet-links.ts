import { recoverMessageAddress } from 'viem'
import type { Hex } from 'viem'
import { SUPPORTED_CHAIN_IDS } from '../chain/chains'

// ─────────────────────────────────────────────────────────────────────────────
// WALLET LINKS — the multi-wallet group (owner ruling 2026-08-03 ~11:0x: "build
// out the multi wallet system where you can sign with each wallet to link them
// to the same portfolio").
//
// WHAT A LINK IS, honestly: a LOCAL, per-browser record that wallet M signed a
// plain-language message binding itself to wallet A's portfolio view. Nothing
// goes on-chain, nothing leaves this device, and no backend exists to hold it.
// The signature proves — to THIS browser, at link time — that whoever linked M
// controlled M. It approves nothing, spends nothing, and can be undone by
// deleting the record.
//
// WHAT THE GROUP CHANGES: the portfolio READ. Holdings across the group merge
// into one book. Acting — signing, trading, claiming — always stays with the
// wallet that is actually connected, because that is the only wallet that CAN
// act. A linked wallet is a lens, never a key.
//
// The group is anchored by the wallet that started it (`anchor`). Records all
// point member → anchor, so resolution works from either side: viewing from
// the anchor finds its members; viewing from a member finds its anchor and
// siblings. Pure module — no React; the React face is use-wallet-group.ts.
//
// v1 verification is EOA signature recovery (recoverMessageAddress). A smart-
// contract wallet (ERC-1271) cannot link yet — verify would need a chain call;
// honest limitation, stated at the ceremony rather than silently failing.
// ─────────────────────────────────────────────────────────────────────────────

export interface WalletLink {
  /** The group's anchor wallet (the one that started the group), lowercase. */
  anchor: string
  /** The linked member wallet, lowercase. */
  member: string
  /** The exact message that was signed — kept whole so verify needs no rebuild. */
  message: string
  /** The member's signature over `message`. */
  signature: Hex
  /** When the link was made, ms epoch. */
  linkedAt: number
}

export interface WalletGroup {
  /** The group's anchor (equals `self` when the wallet is in no group). */
  anchor: string
  /** Every address in the group, anchor first, lowercase, deduped. */
  addresses: string[]
  /** The linked members (anchor excluded). */
  members: WalletLink[]
}

const KEY = 'spectrum.wallet-links.v1'

/** Import bound: records past this are tampering, not a big family. */
export const IMPORT_BUNDLE_CAP = 64
/** The real link message is ~300 chars; anything past this never reaches the
 *  regexes or the crypto. Declared HERE, above every use: at the file's end it
 *  was safe only because nothing calls importBundle during module evaluation
 *  (a top-level call would have hit the temporal dead zone). */
export const MAX_LINK_MESSAGE_CHARS = 2_000

/** Fired on every registry mutation, so EVERY useWalletGroup instance (the
 *  ceremony's, the page's, another tab's via 'storage') re-reads — two mounts
 *  of the hook must never disagree about the group. */
export const LINKS_CHANGED_EVENT = 'spectrum:wallet-links-changed'

function announce(): void {
  try {
    window.dispatchEvent(new Event(LINKS_CHANGED_EVENT))
  } catch {
    /* no window (tests) — nothing to notify */
  }
}

const norm = (a: string) => a.toLowerCase()

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

/** The message a joining wallet signs. Plain language, self-describing, and
 *  scope-stamped (host + date) so a signature pasted elsewhere reads as what
 *  it is. Format is FROZEN — verify checks the stored string verbatim. */
export function linkMessage(anchor: string, member: string, host: string, atMs: number): string {
  const day = new Date(atMs).toISOString().slice(0, 10)
  return [
    `Link wallet ${norm(member)}`,
    `to the portfolio of ${norm(anchor)}`,
    `on ${host} (${day}).`,
    '',
    'This signature only proves ownership so the two wallets can be viewed as one portfolio in this browser. It approves nothing, spends nothing, and can be undone there at any time.',
  ].join('\n')
}

export function loadLinks(): WalletLink[] {
  const s = storage()
  if (!s) return []
  try {
    const raw = s.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (l): l is WalletLink =>
        typeof l === 'object' &&
        l != null &&
        typeof (l as WalletLink).anchor === 'string' &&
        typeof (l as WalletLink).member === 'string' &&
        typeof (l as WalletLink).message === 'string' &&
        typeof (l as WalletLink).signature === 'string',
    )
  } catch {
    return []
  }
}

/** True when the write actually LANDED. A quota/private-browsing failure used
 *  to be silent: the ceremony showed the wallet linked, every read that
 *  session agreed, and the reload lost the group — the runner's storage law
 *  (a record that cannot be written is a guard that does not exist) applied
 *  here unfelt. Callers surface it; the in-memory group still works for the
 *  session either way. */
function saveLinks(links: WalletLink[]): boolean {
  const s = storage()
  if (!s) return false
  try {
    s.setItem(KEY, JSON.stringify(links))
    return true
  } catch {
    return false
  }
}

/** Did the LAST registry mutation persist? Read by the ceremony to say so. */
let lastWritePersisted = true
export function lastLinkWritePersisted(): boolean {
  return lastWritePersisted
}

/** Add (or refresh) a link. One group per member: a wallet re-linking to a
 *  different anchor MOVES — two groups both claiming a wallet would make the
 *  merged view ambiguous. Returns the new full list. */
export function addLink(link: WalletLink): WalletLink[] {
  const next = loadLinks().filter((l) => norm(l.member) !== norm(link.member))
  next.push({ ...link, anchor: norm(link.anchor), member: norm(link.member) })
  lastWritePersisted = saveLinks(next)
  announce()
  return next
}

/** Remove a member's link — AND anything that reached the group only through
 *  it. Returns the new full list.
 *
 *  ⚠ THE ORPHAN (found 2026-08-11). Deletion keyed on `member` alone, so a
 *  record anchored TO the removed wallet survived. With an imported chain
 *  (A←M, M←X) unlinking M dropped only A←M: X vanished from A's panel — no
 *  longer listed, no longer unlinkable — while its record sat in storage and
 *  silently merged back the next time the user connected M. The subtree under
 *  a removed member has no remaining proof of membership in THIS group (its
 *  signature binds it to the removed wallet, not to the anchor), so it leaves
 *  with it. Visibly: the panel already stopped showing those wallets the
 *  moment the link went, so this makes storage agree with the screen rather
 *  than changing what the user sees. */
export function removeLink(member: string): WalletLink[] {
  const links = loadLinks()
  // collect the removed wallet and everything hanging below it
  const doomed = new Set([norm(member)])
  for (;;) {
    const before = doomed.size
    for (const l of links) if (doomed.has(norm(l.anchor))) doomed.add(norm(l.member))
    if (doomed.size === before) break
  }
  const next = links.filter((l) => !doomed.has(norm(l.member)))
  lastWritePersisted = saveLinks(next)
  announce()
  return next
}

/** Resolve the group an address belongs to, from ANY side — transitively.
 *
 *  Records are immutable once signed (the anchor field is bound to the signed
 *  message — see linkFieldsMatchMessage), so a cross-device import can
 *  legitimately produce CHAINS: this browser holds M→A, the imported bundle
 *  holds X→M. One-hop resolution made the "same" group show different books
 *  from different wallets (review finding, 2026-08-03); resolution now climbs
 *  to the root and collects the whole tree, so every member sees one group.
 *  A cycle (importable: A→B here, B→A elsewhere) breaks deterministically at
 *  the lexicographically smallest address IN THE CYCLE — not in the whole
 *  walked path. Taking the smallest of everything walked was wrong whenever a
 *  wallet hung OFF a cycle (records Z→A, A→B, B→A): from Z the walk was
 *  [Z,A,B] and a lexicographically-small Z became its own root, so Z saw a
 *  group of ONE while A and B saw all three — the very split-view defect the
 *  climb exists to prevent (found + pinned 2026-08-11). */
export function groupFor(address: string | undefined, links: WalletLink[] = loadLinks()): WalletGroup {
  const self = norm(address ?? '')
  if (!self) return { anchor: '', addresses: [], members: [] }

  // Climb: while the current root is itself someone's member, go up.
  let root = self
  const walked: string[] = []
  const seen = new Set<string>()
  for (;;) {
    if (seen.has(root)) {
      // The cycle is the walk from this address's FIRST appearance onward;
      // anything before it merely led here and must not decide the root.
      const cycle = walked.slice(walked.indexOf(root))
      root = [...cycle].sort()[0]
      break
    }
    seen.add(root)
    walked.push(root)
    const up = links.find((l) => norm(l.member) === root)
    if (!up) break
    root = norm(up.anchor)
  }

  // Collect: breadth-first down the anchor→member edges from the root.
  const inGroup = new Set([root])
  const addresses = [root]
  const members: WalletLink[] = []
  const queue = [root]
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const l of links) {
      const m = norm(l.member)
      if (norm(l.anchor) === cur && !inGroup.has(m)) {
        inGroup.add(m)
        addresses.push(m)
        members.push(l)
        queue.push(m)
      }
    }
  }
  return { anchor: root, addresses, members }
}

/** The ceremony's "already linked" verdict (owner 2026-08-05, the three-state
 *  flow): armed, and the connected account is one this book ALREADY reads —
 *  but not the account the ceremony started from (standing still is not a
 *  switch), and not the armed candidate (the sign face owns that account).
 *  Pure so it can be derived fresh on every render: a stored flag here would
 *  go stale the moment the user switches onward. */
export function alreadyLinkedMember(
  connected: string | undefined,
  anchor: string | null,
  origin: string | null,
  candidate: string | null,
  links: WalletLink[] = loadLinks(),
): string | null {
  if (!connected || !anchor) return null
  const c = norm(connected)
  if (c === norm(origin ?? '') || c === norm(candidate ?? '')) return null
  const grp = groupFor(anchor, links)
  return c === grp.anchor || grp.addresses.includes(c) ? c : null
}

const ADDR_RE = /^0x[0-9a-f]{40}$/

/** The record's FIELDS must match the signed MESSAGE (frozen format). The
 *  signature pins the member cryptographically, but `groupFor` resolves by
 *  the anchor FIELD — left uncompared, a tampered bundle could point a
 *  genuinely-signed record at any anchor and pull a stranger's holdings into
 *  the book (review finding, 2026-08-03). Self-inconsistent records are
 *  definitively bad: no RPC needed to refuse them. */
export function linkFieldsMatchMessage(link: WalletLink): boolean {
  const member = norm(link.member)
  const anchor = norm(link.anchor)
  if (!ADDR_RE.test(member) || !ADDR_RE.test(anchor)) return false
  // Bound BEFORE the regex — loadLinks type-checks only, so a hand-edited row
  // could otherwise walk a multi-megabyte string through here.
  if (link.message.length > MAX_LINK_MESSAGE_CHARS) return false
  // ⚠ WHOLE-MESSAGE EQUALITY, not two greps (hole found + closed 2026-08-11).
  // This used to run /^Link wallet (0x…)$/m and /^to the portfolio of (0x…)$/m
  // over the message. `/m` makes those LINE anchors and exec takes the FIRST
  // hit, so any message merely CONTAINING the two lines passed — including a
  // login/SIWE message on an unrelated site whose user-supplied field an
  // attacker controls. The victim signs "to log in" and the attacker holds a
  // record that satisfies both this check and signature recovery, minted
  // without the victim ever visiting this app; phished through the import
  // door it merges a stranger's wallet into their book. Proven with a real
  // viem signature, pinned in wallet-links.test.ts.
  //
  // The scope stamp (host + day) is the message's only variable part: read it
  // back, REBUILD the whole message through linkMessage — the one authority on
  // the format, so the two can never drift — and compare verbatim. A message
  // that is not exactly what this app would have produced is not a link.
  const stamp = /\non ([^\n]{1,255}) \((\d{4}-\d{2}-\d{2})\)\.\n/.exec(link.message)
  if (!stamp) return false
  const atMs = Date.parse(`${stamp[2]}T00:00:00.000Z`)
  if (!Number.isFinite(atMs)) return false
  return link.message === linkMessage(anchor, member, stamp[1], atMs)
}

/** A pluggable on-chain verifier (ERC-1271/6492): does this signature verify
 *  as the address's on `chainId`? Injected so the pure suite can exercise the
 *  dispatch without a chain. */
export type ChainVerifier = (
  chainId: number,
  args: { address: `0x${string}`; message: string; signature: Hex },
) => Promise<boolean>

/** The real verifier: viem's verifyMessage on the chain's own client — it
 *  handles deployed smart wallets (ERC-1271) and pre-deploy ones (ERC-6492)
 *  alike. Imported lazily so the pure module stays light until needed. */
const chainVerifier: ChainVerifier = async (chainId, args) => {
  const { clientFor } = await import('../chain/rpc')
  return clientFor(chainId).verifyMessage(args)
}

/** Does the stored signature really verify as the member's? EOA recovery is
 *  the fast path; a smart-contract wallet (whose signature never RECOVERS to
 *  its address) falls through to on-chain verification on each supported
 *  chain until one vouches. Corrupted or hand-edited records must not
 *  silently join the read; pass `verify: null` to forbid the chain fallback. */
export async function verifyLink(link: WalletLink, verify: ChainVerifier | null = chainVerifier): Promise<boolean> {
  if (!linkFieldsMatchMessage(link)) return false
  try {
    const recovered = await recoverMessageAddress({ message: link.message, signature: link.signature })
    if (norm(recovered) === norm(link.member)) return true
  } catch {
    /* not an EOA signature shape — the 1271 path below decides */
  }
  if (!verify) return false
  for (const chainId of SUPPORTED_CHAIN_IDS) {
    try {
      if (await verify(chainId, { address: link.member as `0x${string}`, message: link.message, signature: link.signature }))
        return true
    } catch {
      /* this chain could not answer — the next may */
    }
  }
  return false
}

/** Verify a whole list, keeping only the sound records. */
export async function verifyLinks(
  links: WalletLink[],
  verify: ChainVerifier | null = chainVerifier,
): Promise<WalletLink[]> {
  const checks = await Promise.all(links.map((l) => verifyLink(l, verify)))
  return links.filter((_, i) => checks[i])
}

/** Classify a stored record for SESSION-LOAD screening, where "the RPC could
 *  not answer" must not read as "the signature is fake":
 *   · sound   — EOA recovery matched, or a chain vouched (1271/6492).
 *   · unsound — every chain ANSWERED and said no. (Recovery mismatch alone
 *     proves nothing: a contract wallet's signature recovers to noise.)
 *   · unknown — no chain could answer; keep it and ask again next session,
 *     because dropping a real group over a downed RPC lies about the money.
 *  The link CEREMONY keeps strict verifyLink — with the user present,
 *  refusing an unverifiable signature is right; silently shrinking a stored
 *  group over transport weather is not. */
export async function classifyLink(
  link: WalletLink,
  verify: ChainVerifier | null = chainVerifier,
): Promise<'sound' | 'unsound' | 'unknown'> {
  // Self-inconsistent (fields ≠ signed message) is DEFINITIVELY bad — no RPC
  // needed, and it must not survive as 'unknown' on a rainy day.
  if (!linkFieldsMatchMessage(link)) return 'unsound'
  try {
    const recovered = await recoverMessageAddress({ message: link.message, signature: link.signature })
    if (norm(recovered) === norm(link.member)) return 'sound'
  } catch {
    /* not an EOA shape — the chain decides */
  }
  if (!verify) return 'unknown'
  let answered = 0
  for (const chainId of SUPPORTED_CHAIN_IDS) {
    try {
      if (await verify(chainId, { address: link.member as `0x${string}`, message: link.message, signature: link.signature }))
        return 'sound'
      answered += 1
    } catch {
      /* this chain could not answer */
    }
  }
  return answered === SUPPORTED_CHAIN_IDS.length ? 'unsound' : 'unknown'
}

/** Session-load screening: drop only the DEFINITELY bad. */
export async function screenLinks(
  links: WalletLink[],
  verify: ChainVerifier | null = chainVerifier,
): Promise<WalletLink[]> {
  const verdicts = await Promise.all(links.map((l) => classifyLink(l, verify)))
  return links.filter((_, i) => verdicts[i] !== 'unsound')
}

// ── CROSS-DEVICE PORTABILITY (the export/import bundle) ─────────────────────
// The group lives in ONE browser by design (no backend). The privacy-safe way
// across devices is a bundle the user carries themselves: a JSON file whose
// every record is RE-VERIFIED on import — the signatures are the trust, the
// file is just transport. Nothing on-chain, nothing publicly linkable.

export interface WalletLinkBundle {
  v: 1
  exportedAt: number
  links: WalletLink[]
}

export function exportBundle(): WalletLinkBundle {
  return { v: 1, exportedAt: Date.now(), links: loadLinks() }
}

/** Absorb a bundle: parse defensively, verify every record (chain fallback
 *  included), and add the sound ones (a member re-linking MOVES, as always).
 *  Returns null when the text is not a bundle at all. */
export async function importBundle(
  json: string,
  verify: ChainVerifier | null = chainVerifier,
): Promise<{ added: number; rejected: number; capped: number } | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  const bundle = parsed as Partial<WalletLinkBundle>
  if (bundle?.v !== 1 || !Array.isArray(bundle.links)) return null
  // BOUNDED before any crypto (hardening pass 2026-08-06): a format-valid
  // hostile bundle would otherwise buy one signature recovery per record and
  // up to chains×records RPC calls through the 1271 fallback. Nobody carries
  // more than a few dozen wallets; a bundle past the cap is evidence of
  // tampering, not a big family. Oversize messages never reach the regexes
  // or the crypto either (the real message is ~300 chars).
  const overCap = bundle.links.length > IMPORT_BUNDLE_CAP
  const bounded = bundle.links.slice(0, IMPORT_BUNDLE_CAP)
  const shaped = bounded.filter(
    (l): l is WalletLink =>
      typeof l === 'object' &&
      l != null &&
      typeof l.anchor === 'string' &&
      typeof l.member === 'string' &&
      typeof l.message === 'string' &&
      l.message.length <= MAX_LINK_MESSAGE_CHARS &&
      typeof l.signature === 'string' &&
      l.signature.length <= 65_000 * 2 + 2,
  )
  const sound = await verifyLinks(shaped, verify)
  for (const l of sound) addLink(l)
  return {
    added: sound.length,
    rejected: bundle.links.length - sound.length,
    // said separately, because "cap-skipped" and "signature refused" are
    // different sentences: a legit 100-wallet bundle must not read as 36
    // bad signatures (audit 2026-08-06 #7)
    capped: overCap ? bundle.links.length - IMPORT_BUNDLE_CAP : 0,
  }
}

