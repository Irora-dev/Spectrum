// E2E of the ENTIRE social layer against a local anvil (lab 2026-07-29):
// deploys the v2 SpectrumNotes (indexed kind), writes one of every kind from
// the wallets the semantics demand, then reads back through the REAL app
// readers (profile-registry + notes-social). Proves the contract change and
// the read seam agree end to end. Requires anvil on :8545.
//   anvil --port 8545   (separate terminal or bg)
//   npx vite-node scripts/notes-social-e2e.ts
import { createPublicClient, createWalletClient, http, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { NOTE_KINDS, fetchNotes, fetchOnchainProfile, notesRegistryAbi, encodeProfileJson } from '../src/lib/spectrum/profile-registry'
import {
  encodeAnnounceJson,
  encodeBundleNote,
  encodeBundleRetire,
  fetchCreatorBundles,
  encodeFollowJson,
  encodePostDeleteJson,
  encodePostJson,
  encodeReactionJson,
  encodeUpdateNoteJson,
  fetchAnnouncement,
  fetchBasketReactions,
  fetchCreatorPosts,
  fetchFollowers,
  fetchVersionNote,
} from '../src/lib/spectrum/notes-social'

const RPC = 'http://127.0.0.1:8545'
// anvil's default funded keys
const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
] as const

// The contract's canonical home is the spectrum-contracts repo
// (src/registry/SpectrumNotes.sol + its test suite + script/DeployNotes.s.sol).
// This E2E compiles nothing itself — it reads that repo's build artifact, so
// there is exactly one source of truth for the bytecode.
//
// Point NOTES_ARTIFACT at the json. There is no default path: the contracts repo
// is a SEPARATE checkout and where you keep it is your business (this used to
// assume one maintainer's home-directory layout, which is meaningless to anyone
// else reading it in the public kit).
const NOTES_ARTIFACT = process.env.NOTES_ARTIFACT ?? ''
let artifactRaw: string
try {
  if (!NOTES_ARTIFACT) throw new Error('NOTES_ARTIFACT is not set')
  artifactRaw = readFileSync(NOTES_ARTIFACT, 'utf8')
} catch {
  throw new Error(
    'SpectrumNotes artifact not found. Build it in your spectrum-contracts checkout\n' +
      '  (`forge build`), then point this script at the json:\n' +
      '  NOTES_ARTIFACT=/path/to/spectrum-contracts/out/SpectrumNotes.sol/SpectrumNotes.json \\\n' +
      '    npx vite-node scripts/notes-social-e2e.ts' +
      (NOTES_ARTIFACT ? `\n(tried: ${NOTES_ARTIFACT})` : ''),
  )
}
const artifact = JSON.parse(artifactRaw) as { abi: unknown[]; bytecode: { object: `0x${string}` } }

function must(cond: boolean, what: string) {
  if (!cond) throw new Error(`FAIL: ${what}`)
  console.log(`  ✓ ${what}`)
}

async function main() {
  const pub = createPublicClient({ chain: foundry, transport: http(RPC) })
  const [creator, delegate, holder, operator] = KEYS.map((k) =>
    createWalletClient({ account: privateKeyToAccount(k), chain: foundry, transport: http(RPC) }),
  )
  const BASKET = '0x00000000000000000000000000000000000b0b0b' as Address // any address works — subjects are just topics
  const FACTORY = '0x00000000000000000000000000000000000fac70' as Address

  // deploy v2
  const deployHash = await creator.deployContract({ abi: notesRegistryAbi, bytecode: artifact.bytecode.object })
  const rcpt = await pub.waitForTransactionReceipt({ hash: deployHash })
  const registry = rcpt.contractAddress!
  console.log(`SpectrumNotes v2 @ ${registry}`)

  const write = async (
    who: typeof creator,
    subject: Address,
    kind: `0x${string}`,
    note: string,
  ) => {
    const h = await who.writeContract({ address: registry, abi: notesRegistryAbi, functionName: 'setNote', args: [subject, kind, note] })
    await pub.waitForTransactionReceipt({ hash: h })
  }

  const CREATOR = creator.account.address
  const DELEGATE = delegate.account.address
  const HOLDER = holder.account.address
  const OPERATOR = operator.account.address

  console.log('\nprofile (with delegate declaration):')
  await write(creator, CREATOR, NOTE_KINDS.profile, encodeProfileJson({ name: 'E2E Creator', bio: 'proof', delegate: DELEGATE }))
  const prof = await fetchOnchainProfile(pub, registry, CREATOR)
  must(prof?.json.name === 'E2E Creator', 'profile reads back')
  must(prof?.json.delegate?.toLowerCase() === DELEGATE.toLowerCase(), 'delegate declaration reads back')

  console.log('\nreactions (holder wall):')
  await write(holder, BASKET, NOTE_KINDS.react, encodeReactionJson('💎'))
  await write(creator, BASKET, NOTE_KINDS.react, JSON.stringify({ v: 1, e: '🖕' })) // NOT in the approved set
  let reacts = await fetchBasketReactions(pub, registry, foundry.id, BASKET)
  must(reacts?.length === 1 && reacts[0].emoji === '💎' && reacts[0].holder.toLowerCase() === HOLDER.toLowerCase(), 'approved emoji renders; unapproved never does')
  await write(holder, BASKET, NOTE_KINDS.react, encodeReactionJson('🚀')) // replace
  reacts = await fetchBasketReactions(pub, registry, foundry.id, BASKET)
  must(reacts?.length === 1 && reacts[0].emoji === '🚀', 'latest reaction replaces')
  await write(holder, BASKET, NOTE_KINDS.react, '') // clear
  reacts = await fetchBasketReactions(pub, registry, foundry.id, BASKET)
  must(reacts?.length === 0, 'empty note clears the reaction')

  console.log('\nposts (feed + delegate + tombstone):')
  await write(creator, CREATOR, NOTE_KINDS.post, encodePostJson('first post'))
  await write(delegate, CREATOR, NOTE_KINDS.post, encodePostJson('delegate post', 'https://example.com'))
  let posts = await fetchCreatorPosts(pub, registry, foundry.id, CREATOR, DELEGATE)
  must(posts?.length === 2, 'creator + delegate posts both read')
  must(posts?.some((p) => p.viaDelegate && p.url === 'https://example.com'), 'delegate post is chipped + url kept')
  const victim = posts!.find((p) => !p.viaDelegate)!
  await write(creator, CREATOR, NOTE_KINDS.post, encodePostDeleteJson(victim.id))
  posts = await fetchCreatorPosts(pub, registry, foundry.id, CREATOR, DELEGATE)
  must(posts?.length === 1 && posts[0].viaDelegate === true, 'tombstone hides the deleted post only')

  console.log('\nversion note:')
  await write(creator, BASKET, NOTE_KINDS.update, encodeUpdateNoteJson('sold X, added Y'))
  const vn = await fetchVersionNote(pub, registry, foundry.id, CREATOR, BASKET)
  must(vn?.text === 'sold X, added Y', 'deployer release note reads back')

  console.log('\nfollows:')
  await write(holder, CREATOR, NOTE_KINDS.follow, encodeFollowJson())
  await write(operator, CREATOR, NOTE_KINDS.follow, encodeFollowJson())
  let fol = await fetchFollowers(pub, registry, foundry.id, CREATOR)
  must(fol?.list.length === 2 && fol.partial === false, 'two on-chain followers count (complete scan)')
  await write(operator, CREATOR, NOTE_KINDS.follow, '') // unfollow
  fol = await fetchFollowers(pub, registry, foundry.id, CREATOR)
  must(fol?.list.length === 1 && fol.list[0].toLowerCase() === HOLDER.toLowerCase(), 'unfollow clears')

  console.log('\nannouncement (pinned to {fee wallet, factory}):')
  await write(operator, FACTORY, NOTE_KINDS.announce, encodeAnnounceJson({ text: 'fees halved', level: 'info' }))
  await write(creator, FACTORY, NOTE_KINDS.announce, encodeAnnounceJson({ text: 'IMPOSTOR', level: 'warn' }))
  const ann = await fetchAnnouncement(pub, registry, foundry.id, OPERATOR, FACTORY)
  must(ann?.text === 'fees halved', "only the fee wallet's words render (impostor invisible)")
  const expired = encodeAnnounceJson({ text: 'gone', until: Math.floor(Date.now() / 1000) - 10 })
  await write(operator, FACTORY, NOTE_KINDS.announce, expired)
  must((await fetchAnnouncement(pub, registry, foundry.id, OPERATOR, FACTORY)) === null, 'expiry clears the banner')

  console.log('\nkind isolation:')
  const profAgain = await fetchOnchainProfile(pub, registry, CREATOR)
  must(profAgain?.json.name === 'E2E Creator', 'profile untouched by all the post/react traffic (kind topics isolate)')

  // ── the audit regressions (H2 · M2 · L3) ───────────────────────────────────
  console.log('\nbundles (published allocations):')
  const legs = [
    { chainId: 8453, address: '0x00000000000000000000000000000000000000b1', weight: 60 },
    { chainId: 1, address: '0x00000000000000000000000000000000000000b2', weight: 40 },
  ]
  await write(creator, CREATOR, NOTE_KINDS.bundle, encodeBundleNote({ slug: 'ai01', name: 'AI everywhere', legs }))
  let bundles = await fetchCreatorBundles(pub, registry, foundry.id, CREATOR)
  must(bundles?.length === 1 && bundles[0].name === 'AI everywhere' && bundles[0].legs.length === 2, 'a published bundle reads back with its legs')
  // re-publishing the SAME slug edits in place (no duplicate)
  await write(creator, CREATOR, NOTE_KINDS.bundle, encodeBundleNote({ slug: 'ai01', name: 'AI everywhere v2', legs }))
  bundles = await fetchCreatorBundles(pub, registry, foundry.id, CREATOR)
  must(bundles?.length === 1 && bundles[0].name === 'AI everywhere v2', 'same slug EDITS in place, never duplicates')
  // a second bundle coexists
  await write(creator, CREATOR, NOTE_KINDS.bundle, encodeBundleNote({ slug: 'rwa1', name: 'Stocks', legs: [legs[0]] }))
  bundles = await fetchCreatorBundles(pub, registry, foundry.id, CREATOR)
  must(bundles?.length === 2, 'a second bundle coexists')
  // retire one
  await write(creator, CREATOR, NOTE_KINDS.bundle, encodeBundleRetire('ai01'))
  bundles = await fetchCreatorBundles(pub, registry, foundry.id, CREATOR)
  must(bundles?.length === 1 && bundles[0].slug === 'rwa1', 'retiring drops only that bundle')
  // a STRANGER cannot put a bundle on the creator's shelf
  await write(holder, CREATOR, NOTE_KINDS.bundle, encodeBundleNote({ slug: 'fake', name: 'IMPOSTOR', legs }))
  bundles = await fetchCreatorBundles(pub, registry, foundry.id, CREATOR)
  must(!bundles?.some((b) => b.name === 'IMPOSTOR'), "a stranger's bundle never appears on the creator's shelf")

  console.log('\naudit regressions:')

  // M2 — a delegate must NOT be able to tombstone the CREATOR's posts.
  await write(creator, CREATOR, NOTE_KINDS.post, encodePostJson('creator survives'))
  const before = await fetchCreatorPosts(pub, registry, foundry.id, CREATOR, DELEGATE)
  const creatorPost = before!.find((p) => !p.viaDelegate && p.text === 'creator survives')!
  await write(delegate, CREATOR, NOTE_KINDS.post, encodePostDeleteJson(creatorPost.id))
  const after = await fetchCreatorPosts(pub, registry, foundry.id, CREATOR, DELEGATE)
  must(
    after!.some((p) => p.id === creatorPost.id),
    "a delegate's tombstone cannot erase the creator's post (author-scoped deletes)",
  )
  // …but the delegate CAN retract its own.
  const dpost = after!.find((p) => p.viaDelegate)!
  await write(delegate, CREATOR, NOTE_KINDS.post, encodePostDeleteJson(dpost.id))
  const after2 = await fetchCreatorPosts(pub, registry, foundry.id, CREATOR, DELEGATE)
  must(!after2!.some((p) => p.id === dpost.id), 'a delegate can still retract its OWN post')

  // H2 — a clear that lands while the reader is mid-round-trip must not be
  // swallowed forever. Simulated by clearing, then reading with a cache warmed
  // to the pre-clear tip: the watermark must not have jumped past the clear.
  await write(holder, BASKET, NOTE_KINDS.react, encodeReactionJson('🔥'))
  must((await fetchBasketReactions(pub, registry, foundry.id, BASKET))?.length === 1, 'reaction re-added')
  await write(holder, BASKET, NOTE_KINDS.react, '')
  must(
    (await fetchBasketReactions(pub, registry, foundry.id, BASKET))?.length === 0,
    'a clear is never swallowed by the watermark (H2)',
  )

  // L3 — a bad kind must throw, not silently widen to every kind.
  let threw = false
  try {
    await fetchNotes(pub, registry, { subject: BASKET, kind: undefined as unknown as `0x${string}` })
  } catch {
    threw = true
  }
  must(threw, 'an undefined kind is REFUSED (never a wildcard read)')

  console.log('\nALL GREEN')
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
