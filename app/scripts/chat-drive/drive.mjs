// THE CONVERSATION DRIVER: runs the real agent against live Base and audits
// the conversation graph — every static chip, every welcome tile, every
// reply-emitted chip must land on a real answer (the "Add another asset"
// bug class, automated). A turn that answers with the generic fallback or
// an off-intent reply is a FINDING.
//
// DRIVE_FAST=1 (npm run chat:drive:fast): offline-only mode — runs just the
// turns whose ANSWER never needs a chain (the QA-bank probes + the static
// sends that resolve in the bank/showcase/question layers), with the network
// severed so nothing can flake or hang. Chain-reading sends and sections 3–5
// (they settle tickers / read baskets live) are skipped, counted, and printed.
import { readFileSync } from 'node:fs'

// the app env (Alchemy key etc), like the MCP e2e
for (const line of readFileSync(new URL('../../.env.local', import.meta.url).pathname, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, '')
}

const FAST = !!process.env.DRIVE_FAST
if (FAST) {
  // Sever the network BEFORE the agent loads. Every fetch answers instantly
  // with a JSON-RPC error the transport does NOT retry (-32601 is
  // deterministic; a plain rejection would ride viem's retryCount:4 backoff,
  // ~6s per call). Offline answers never touch fetch; the catch-guarded
  // pass-throughs (the entity layer's findBasket) fail fast to null.
  globalThis.fetch = async (_url, init) => {
    let body = null
    try {
      body = JSON.parse(init?.body ?? 'null')
    } catch {
      /* not JSON — answer the single-error shape */
    }
    const rpcErr = (id) => ({ jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: 'DRIVE_FAST: network disabled' } })
    const payload = Array.isArray(body) ? body.map((r) => rpcErr(r?.id)) : rpcErr(body?.id)
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
}
const { handle, DEFAULT_AGENT_CTX } = await import('./agent-bundle.mjs')

// the wallet the drive reads AS (positions/holdings turns are realistic when
// it actually holds baskets). Operators: point DRIVE_OWNER at your own wallet;
// the default is a public Spectrum wallet with live holdings, kept so the kit
// driver exercises wallet-connected turns out of the box.
const OWNER = process.env.DRIVE_OWNER ?? '0x40B1e5818b449Db3A7bb0FE482B5784F77fCD2c0'
const findings = []
let turns = 0

const GENERIC = /I did not catch that/
async function turn(text, ctx, expect, label) {
  turns++
  let reply
  try {
    reply = await Promise.race([
      handle(text, ctx),
      new Promise((_, rej) => setTimeout(() => rej(new Error('45s timeout')), 45_000)),
    ])
  } catch (e) {
    findings.push(`💥 "${label ?? text}" threw: ${e.message.slice(0, 120)}`)
    return { ctx }
  }
  const kinds = reply.actions.map((a) => a.kind).join('+')
  const first = reply.actions[0]
  const textOut = first?.kind === 'text' || first?.kind === 'assetPicker' ? first.text : ''
  if (GENERIC.test(textOut)) findings.push(`❌ "${label ?? text}" → GENERIC FALLBACK`)
  else if (expect && !expect.test(kinds + ' ' + textOut.slice(0, 200)))
    findings.push(`⚠ "${label ?? text}" → [${kinds}] "${textOut.slice(0, 90)}" (wanted ${expect})`)
  return reply
}

// ── 1. every WELCOME TILE + STATIC CHIP the UI hardcodes ─────────────────────
const STATIC_SENDS = [
  ['What is a basket?', /hero/],
  ['Show me what is live', /baskets/],
  ['Earn as a creator', /hero/],
  ['How easy is it to get started?', /hero/],
  ['What baskets are there?', /baskets/],
  ['Best performers in the last 24 hours?', /movers/],
  ['Help me create my own basket', /Drop 2 to 12|assets/],
  ['What do I hold?', /Connect a wallet|positions|No basket holdings/],
  ['How does this work?', /hero|basket is one ERC-20/],
  ['How do fees work?', /fee/i],
  ['Help', /operate|Try/],
  ['Best performers this week?', /movers/],
  ['Best performers this month?', /movers/],
  ['How do I exit?', /Which basket|trade|Two ways out/],
  ['Get my referral link', /Connect a wallet|referral/],
  ['Read a basket', /Which one|baskets/],
  ['What is NAV?', /NAV/],
  ['Is it safe?', /Non-custodial/],
  ['Buy a basket', /Which basket|trade/],
  ['What baskets are there on Base?', /baskets/],
  ['What baskets are there on Robinhood?', /baskets/],
  ['Share a basket', /Which basket|share/],
  ['Start over', /Draft cleared|Nothing in progress/i, 'Start over (no draft)'],
]
// Sends whose ANSWER path stays off-chain (showcase heroes, question-layer
// says, help, guided-create arming, referral link building, no-draft start
// over). Everything else here reads live chains — movers/baskets/positions/
// read/trade/exit/share — and is skipped under DRIVE_FAST. Allow-list on
// purpose: a NEW static send defaults to skipped-in-fast (visible in the
// count) rather than silently re-introducing network flake.
const OFFLINE_STATIC = new Set([
  'What is a basket?',
  'Earn as a creator',
  'How easy is it to get started?',
  'Help me create my own basket',
  'How does this work?',
  'How do fees work?',
  'Help',
  'Get my referral link',
  'What is NAV?',
  'Is it safe?',
  'Start over',
])
let skippedStatic = 0
let ctx = { ...DEFAULT_AGENT_CTX, account: OWNER }
for (const [send, expect, label] of STATIC_SENDS) {
  if (FAST && !OFFLINE_STATIC.has(send)) {
    skippedStatic++
    continue
  }
  const r = await turn(send, { ...ctx, lastList: null, pending: null, draft: null }, expect, label)
  void r
}

// ── 2. the QA bank sample: one probe per family ──────────────────────────────
const BANK_PROBES = [
  ['what is spectrum', /open-source|software/],
  ['is this open source?', /open source/i],
  ['who built this?', /kit|operator/],
  ['who is specter?', /ghost/],
  ['gm', /gm/],
  ['is this like an ETF?', /compare/],
  ['why not just buy the coins individually?', /compare/],
  ['does spectrum have a token?', /no token|software/i],
  ['whats the minimum buy?', /\$10|one unit/],
  ['how much is gas?', /gas/],
  ['which wallets work?', /Connect|wallet/i],
  ['does it work on mobile?', /phone|wallet/i],
  ['can i pay with eth?', /settlement|USDC/i],
  ['what is slippage?', /floor|simulation/i],
  ['where do prices come from?', /chain|pools/i],
  ['what is the AUM?', /AUM/],
  ['can the creator rug me?', /immutable|Non-custodial/],
  ['is the code audited?', /verif/i],
  ['what if a token in the basket rugs?', /redeem|in kind|exit/i],
  ['can i make my basket private?', /public/],
  ['can i delete my basket?', /cannot be deleted|immutable/i],
  ['what apy do baskets pay?', /no yield|pay no/i],
  ['will SVI go up?', /predict|measure/i],
  ['which basket should i buy?', /Not my call|endorsement/i],
  ['do i owe taxes?', /Not tax advice/i],
  ['how do creators make money?', /hero/],
  ['can you add my token?', /routable|basket/i],
  ['can i put ETH in a basket?', /ETH and WETH|hub/i],
  ['how many tokens can a basket hold?', /2 to 12/],
  ['what are the fee limits?', /1%|30%/],
  ['what does it cost to deploy?', /deploy price|native/i],
  ['what is salt mining?', /CREATE2|address/i],
  ['why does my basket hold nothing?', /first buy|seeds/i],
  ['how do i copy a basket?', /legs and weights|building/i],
  ['what should i name my basket?', /thesis|Name/],
  ['give me basket ideas', /movers|thesis/i],
  ['what is a bundle?', /groups|shareable/i],
  ['what is a thesis?', /creator|case/i],
  ['how do i claim a creator name?', /claim|name/i],
  ['what is the league?', /rank/i],
  ['is there an API?', /MCP/],
  ['my transaction failed', /steps/],
  ['how do i cancel a pending transaction?', /wallet|nonce/i],
  ['the site is slow', /RPC|retry/i],
  ['what happens when i buy?', /steps/],
  ['what is redeem in kind?', /hero/],
  ['can i set a limit order?', /No order book|floor/i],
  ['when are fees charged?', /pooled|Holding costs/i],
  ['does it rebalance automatically?', /No silent|weights/i],
  ['what is the total supply?', /Supply|shares/],
  ['is there a token allowlist?', /No allowlist/i],
  ['how long does deploy take?', /minute|seconds/i],
  ['can i change the fee later?', /immutable|No:/i],
  ['can i deploy the same basket on multiple chains?', /per chain|one chain/i],
  ['what is the interface fee?', /5%|interfaces/i],
  ['what is robinhood chain?', /networks|Robinhood/],
  ['what is the default slippage?', /tolerance|dial/i],
  ['can i gift a basket?', /ERC-20|send/i],
  ['do holders get airdrops?', /No emissions|no points/i],
  ['what makes a good basket?', /thesis|liquidity/i],
  ['is this a dex?', /infrastructure|pool/i],
  ['how do i track my basket after deploy?', /steps/],
  ['what data do you collect?', /privacy|chain/i],
  ['where are the terms?', /terms/i],
  ['i found a bug', /Learn|say exactly/i],
  ['how many baskets are there?', /live on|baskets/],
  // the natural-language round (2026-08-20): more real questions, filler-hardened
  ['is this a scam?', /open source|trust|read/i],
  ['can i lose money?', /tracks its holdings|falls|risk/i],
  ['who holds my money?', /You do|your wallet/i],
  ['whats the difference between a basket and a bundle?', /storefront|one ERC-20|groups/i],
  ['can i change the weights later?', /immutable|fresh basket/i],
  ['how do i get usdc?', /exchange|bridge/i],
  ['what happens if this site goes down?', /open source|on-chain|redeem/i],
  ['can i sell just half?', /Any amount|slice/i],
  ['are prices live?', /straight at the chain|pools/i],
  ['where can i see my past trades?', /wallet|explorer/i],
  ['do you have a discord?', /operator|footer|public/i],
  ['do i need to know how to code?', /No code|signs/i],
  ['how long does a buy take?', /One transaction|seconds/i],
  ['can i dca?', /No order book|floor|wallet/i],
  ['is there a mobile app?', /phone|wallet/i],
  ['what should i add to my basket?', /movers|thesis|ideas/i],
  ['ok so how do fees work', /fee/i],
  // the orientation family + the endless catch-all (owner 11:04 live miss:
  // "what can i do here" hit the shrug)
  ['what can i do here', /whole site|map/i],
  ['im new here', /whole site|map/i],
  ['where do i start', /whole site|map/i],
  ['what are my options', /whole site|map/i],
  ['show me around', /whole site|map/i],
  ['why is the sky blue', /honest map/i, 'an off-map question never dead-ends'],
  // the multilingual operational layer (offline: heroes + bank + localized map)
  ['¿qué es una cesta?', /hero/, 'es: what is a basket'],
  ['was ist ein korb?', /hero/, 'de: what is a basket'],
  ['wat is een mandje?', /hero/, 'nl: what is a basket'],
  ['qu est-ce qu un panier?', /hero/, 'fr: what is a basket'],
  ['什么是篮子', /basket is one ERC-20|hero/i, 'zh: what is a basket'],
  ['¿cuánto cuesta?', /fee/i, 'es: fees'],
  ['grüße wie geht es dir heute', /Ich spreche am besten Englisch/, 'de junk gets the localized map lead'],
  ['no entiendo nada de esto', /Hablo mejor ingles/, 'es junk gets the localized map lead'],
  // the agentic-feel round (offline halves)
  ['what is a wallet?', /keys|MetaMask/i],
  ['i lost my seed phrase', /seed phrase IS the account|recover/i],
  ['can i short with leverage?', /No leverage|spot/i],
  ['wen moon', /measured|promises/i],
  ['can i use a ledger?', /Connect|wallet/i],
  ['nevermind', /All good|Dropped/i],
  ['what were we doing?', /Fresh slate|Where we stand/i],
  ['yes', /To what/i, '"yes" with no standing offer asks'],
  ['whats the fee and how do i exit', /fee/i, 'two questions, both answered'],
  // the question-shaped create round (owner 2026-08-20 19:1x: "can i create a
  // basket" hit the map — request-shaped interrogatives ARE the intent)
  ['can i create a basket', /assetPicker/, 'question-shaped create opens the flow'],
  ['could we start a basket', /assetPicker|Drop 2 to 12/, 'could-we start opens the flow'],
  ['how do i make my own basket', /assetPicker|Drop 2 to 12/, 'how-do-i create opens the flow'],
  ['what does it cost to create a basket', /deploy|cost|gas/i, 'cost question KEEPS the bank row'],
  ['help', /Ethereum, Base and Robinhood/, 'orientation lead names all three chains'],
]
// The probes whose ANSWER is a live read (the how-many count block calls
// listBasketsForChain unguarded); every other bank probe resolves offline —
// the entity layer's findBasket pass-through is catch-guarded, so the severed
// network in FAST mode just answers it null instantly.
const CHAIN_PROBES = new Set(['how many baskets are there?'])
let skippedProbes = 0
for (const [send, expect] of BANK_PROBES) {
  if (FAST && CHAIN_PROBES.has(send)) {
    skippedProbes++
    continue
  }
  await turn(send, { ...ctx, lastList: null, pending: null, draft: null }, expect)
}

// ── 3. the flows: draft build-up, slot release, ordinals (live-only) ─────────
if (!FAST) {
  let c = { ...DEFAULT_AGENT_CTX, account: OWNER }
  let r = await turn('Help me create my own basket', c, /Drop 2 to 12/)
  c = r.ctx
  r = await turn('VVV', c, /draft holds|matches/, 'VVV (guided single)')
  c = r.ctx
  if (c.pending?.queue) {
    findings.push('ℹ VVV was contested (candidate rail) — picking the first is not automated here')
  } else {
    r = await turn('add AERO to my basket', c, /draft basket|matches|create/, 'add AERO')
    c = r.ctx
  }
  r = await turn('Best performers in the last 24 hours?', c, /movers/, 'movers releases an armed slot')
  c = r.ctx
  r = await turn('what baskets are there?', c, /baskets/)
  c = r.ctx
  r = await turn('read the first one', c, /basket/, 'ordinal vs the rail')
}

// ── 4. the cross-chain bundle flow (owner 23:1x: "vvv… aero… then cashcat
// on robinhood"): two chains collecting legs = two buckets + the bundle prompt ─
if (!FAST) {
  let cc = { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }
  let rr = await turn('create a basket of VVV and AERO', cc, /draft|matches/, 'cross-chain: base legs')
  cc = rr.ctx
  // resolve a contested ticker if the flow paused on candidates
  while (cc.pending?.queue?.length && rr.actions.some((a) => a.kind === 'candidates')) {
    const cand = rr.actions.find((a) => a.kind === 'candidates')
    rr = await turn(`use ${cand.hits[0].address} for ${cand.ticker}`, cc, /draft|matches/, `pick ${cand.ticker}`)
    cc = rr.ctx
  }
  rr = await turn('cashcat on robinhood', cc, /Robinhood|bundle|matches|spans chains|crossDraft|Nothing settled/i, 'cross-chain: rh leg prompts the bundle')
  cc = rr.ctx
  while (cc.pending?.queue?.length && rr.actions.some((a) => a.kind === 'candidates')) {
    const cand = rr.actions.find((a) => a.kind === 'candidates')
    rr = await turn(`use ${cand.hits[0].address} for ${cand.ticker}`, cc, /draft|bundle|spans/i, `pick ${cand.ticker}`)
    cc = rr.ctx
  }
  // the spans-chains prompt is ONE CARD since 2026-08-21 (kind crossDraft,
  // owner design spec) — the old text+steps shapes stay accepted for history
  const spans = rr.actions.some((a) => a.kind === 'crossDraft' || (a.kind === 'text' && /spans chains|BUNDLE/i.test(a.text)) || (a.kind === 'steps' && /cross-chain/i.test(a.title)))
  const buckets = Object.entries(cc.drafts ?? {}).filter(([, v]) => v.length).map(([k, v]) => `${k}:${v.map((x) => x.symbol).join('+')}`)
  console.log('  cross-chain buckets:', buckets.join(' · ') || 'none')
  if (buckets.length >= 2 && !spans) findings.push('❌ two buckets live but no bundle prompt')
  if (buckets.length < 2) findings.push(`⚠ cross-chain: expected 2 buckets, got [${buckets.join(' · ')}]`)
  // FINALIZE (owner 2026-08-21): the building card is weights-only; "finalize
  // basket" reveals what gets made where (crossDraft mode=finalized) + deploy
  if (buckets.length >= 2) {
    const fr = await turn('finalize basket', cc, /crossDraft|what gets made/i, 'finalize reveals the per-chain breakdown')
    const fcd = fr.actions.find((a) => a.kind === 'crossDraft')
    if (!fcd || fcd.mode !== 'finalized') findings.push(`❌ finalize: expected crossDraft mode=finalized, got ${fcd ? fcd.mode : 'no crossDraft'}`)
    cc = fr.ctx
  }
  // a bare "on <chain>" is what the bundle steps themselves instruct — it must
  // land on that chain's bucket state, never the generic fallback
  rr = await turn('on base', cc, /base|draft|assets/i, 'bare chain switch (the steps say to say this)')
}

// ── 5. old-ctx migration: a PERSISTED old-shape context (the single `draft`
// from before the per-chain buckets design) restored into a new session must
// FOLD into drafts[chainId] on the next draft turn — the stored pick joins the
// new one in the bucket, never lost, never left as a shadow single-draft ──────
if (!FAST) {
  // a real Base token address from the curated set (token-meta.ts): $VVV
  const VVV = '0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf'
  let mc = {
    ...DEFAULT_AGENT_CTX,
    account: OWNER,
    chainId: 8453,
    draft: { picks: [{ address: VVV, symbol: 'VVV' }] },
    drafts: undefined,
  }
  let mr = await turn('add AERO to my basket', mc, /draft|matches|candidates/, 'old-ctx migration: add AERO onto a legacy single draft')
  mc = mr.ctx
  // a contested candidate pauses exactly like section 4 — pick by address
  while (mc.pending?.queue?.length && mr.actions.some((a) => a.kind === 'candidates')) {
    const cand = mr.actions.find((a) => a.kind === 'candidates')
    mr = await turn(`use ${cand.hits[0].address} for ${cand.ticker}`, mc, /draft|matches|candidates/, `pick ${cand.ticker} (migration)`)
    mc = mr.ctx
  }
  const bucket = mc.drafts?.[8453] ?? []
  const held = bucket.map((x) => `$${x.symbol}`).join('+')
  console.log('  old-ctx migration bucket:', bucket.length ? `8453:${held}` : 'EMPTY')
  if (!bucket.some((x) => x.address.toLowerCase() === VVV))
    findings.push(`❌ old-ctx migration: the legacy draft pick ($VVV ${VVV.slice(0, 10)}…) was LOST — drafts[8453] holds [${held || 'nothing'}]`)
  if (!bucket.some((x) => x.symbol.toUpperCase() === 'AERO'))
    findings.push(`❌ old-ctx migration: the NEW pick ($AERO) never landed — drafts[8453] holds [${held || 'nothing'}]`)

  // ── the ASSET-PICKER CARD's sentence contract (2026-08-21): a tile tap
  // SPEAKS "add <address> on <chain>" and an untap "remove <sym> on <chain>" —
  // these exact shapes must keep working cold or the visual picker goes mute
  let pc = { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 4663 }
  let pr = await turn(`add ${VVV} on base`, pc, /draft|matches|Base/i, 'picker tap: add <addr> on <chain>, cold + cross-chain')
  pc = pr.ctx
  const pBucket = pc.drafts?.[8453] ?? []
  if (!pBucket.some((x) => x.address.toLowerCase() === VVV))
    findings.push(`❌ picker tap: "add <addr> on base" from 4663 did not land in the 8453 bucket (holds [${pBucket.map((x) => x.symbol).join('+') || 'nothing'}])`)
  pr = await turn('remove VVV on base', pc, /Dropped|dropped|draft|empty|Building on/i, 'picker untap: remove <sym> on <chain>')
  pc = pr.ctx
  if ((pc.drafts?.[8453] ?? []).some((x) => x.address.toLowerCase() === VVV))
    findings.push('❌ picker untap: "remove VVV on base" left $VVV in the 8453 bucket')
}

if (FAST)
  console.log(
    `⏩ DRIVE_FAST: skipped ${skippedStatic} chain-reading static sends + ${skippedProbes} live-count probe + the live sections 3–10 (draft/ordinal flows, cross-chain bundle, old-ctx migration, the agentic/creator/watch rounds, the real-AI-feel round — every one settles tickers or reads baskets on live chains); ran offline turns only, network severed`,
  )

// ── 6. the natural-language round: fillers, cold add, availability (owner
// 2026-08-20: "add pons must just detect pons and add to a basket") ─────────
if (!FAST) {
  let n = { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }
  let nr = await turn('add vvv', n, /draft|matches/i, 'cold "add vvv" starts a draft')
  n = nr.ctx
  while (n.pending?.queue?.length && nr.actions.some((a) => a.kind === 'candidates')) {
    const cand = nr.actions.find((a) => a.kind === 'candidates')
    nr = await turn(`use ${cand.hits[0].address} for ${cand.ticker}`, n, /draft|matches/i, `pick ${cand.ticker}`)
    n = nr.ctx
  }
  nr = await turn('can you add aero', n, /draft|matches/i, 'filler-framed add extends the draft')
  n = nr.ctx
  while (n.pending?.queue?.length && nr.actions.some((a) => a.kind === 'candidates')) {
    const cand = nr.actions.find((a) => a.kind === 'candidates')
    nr = await turn(`use ${cand.hits[0].address} for ${cand.ticker}`, n, /draft|matches/i, `pick ${cand.ticker}`)
    n = nr.ctx
  }
  nr = await turn('can you add my token?', n, /routable|basket/i, 'policy question stays a bank answer mid-draft')
  n = nr.ctx
  const nb = (n.drafts?.[8453] ?? []).map((p) => p.symbol).join('+')
  console.log('  natural-add bucket:', nb || 'none')
  if (!/VVV/i.test(nb) || !/AERO/i.test(nb)) findings.push(`❌ natural add: wanted VVV+AERO in the bucket, got [${nb}]`)
  await turn('please show me the baskets', { ...DEFAULT_AGENT_CTX, account: OWNER }, /baskets/, 'polite filler before a list')
  await turn('add pons', { ...DEFAULT_AGENT_CTX, account: OWNER }, /draft|matches|Nothing settled|nothing by that symbol/i, 'the owner case: cold "add pons"')
  // the chain-tail + then-chain harvests (live find 2026-08-21: "aero on base"
  // failed the ticker shape and the last asset silently vanished)
  {
    const rTail = await turn('add vvv and aero on base', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 4663 }, /draft|matches/i, 'cold add with a chain tail keeps BOTH assets')
    const bTail = (rTail.ctx.drafts?.[8453] ?? []).map((x) => x.symbol.toUpperCase()).join('+')
    if (!/VVV/.test(bTail) || !/AERO/.test(bTail)) findings.push(`❌ chain-tail add: wanted VVV+AERO in the 8453 bucket, got [${bTail || 'nothing'}]`)
    const rThen = await turn('add vvv then add aero', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /draft|matches/i, '"then"-chained adds harvest both')
    const bThen = (rThen.ctx.drafts?.[8453] ?? []).map((x) => x.symbol.toUpperCase()).join('+')
    if (!/VVV/.test(bThen) || !/AERO/.test(bThen)) findings.push(`❌ then-chained add: wanted VVV+AERO, got [${bThen || 'nothing'}]`)
  }
  await turn('do you have vvv?', { ...DEFAULT_AGENT_CTX, account: OWNER }, /measured|hold|basket|live/i, 'availability question resolves the ticker')
}

// ── 8. the agentic-feel round: anaphora, yes, amount edits, ellipsis, meta,
// compare, spoken weights (owner 2026-08-20: close every non-agentic tell) ───
if (!FAST) {
  let g = { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }
  let gr = await turn('what baskets are there?', g, /baskets/, 'agentic: the list')
  g = gr.ctx
  const rows = gr.actions.find((a) => a.kind === 'baskets')?.rows ?? []
  if (rows.length === 0) findings.push('⚠ agentic round: no baskets on base, anaphora/compare unexercised')
  else {
    const sym = rows[0].symbol
    gr = await turn(`read $${sym}`, g, /basket/, 'agentic: read one')
    g = gr.ctx
    gr = await turn('buy $25 of it', g, /trade/, '"buy it" rides lastBasket')
    g = gr.ctx
    const t1 = gr.actions.find((a) => a.kind === 'trade')
    if (!t1 || t1.amountUsd !== 25) findings.push(`❌ "buy $25 of it": wanted a $25 trade card, got [${gr.actions.map((a) => a.kind).join('+')}] amount ${t1?.amountUsd}`)
    gr = await turn('open it', g, /link/, '"open it" links the basket page')
    g = gr.ctx
    gr = await turn('make it $100', g, /trade/, 'amount-only edit re-emits the card')
    g = gr.ctx
    const t2 = gr.actions.find((a) => a.kind === 'trade')
    if (!t2 || t2.amountUsd !== 100) findings.push(`❌ "make it $100": wanted the card at $100, got ${t2?.amountUsd}`)
    const mangled = sym.length >= 3 ? sym.toLowerCase().slice(0, -1) + 'x' : null
    if (mangled) await turn(mangled, { ...DEFAULT_AGENT_CTX, account: OWNER }, /Did you mean|basket/i, `did-you-mean on "${mangled}"`)
    if (rows.length >= 2) {
      const cr = await turn(`compare ${rows[0].symbol.toLowerCase()} and ${rows[1].symbol.toLowerCase()}`, { ...DEFAULT_AGENT_CTX, account: OWNER }, /side by side/i, 'compare two baskets')
      const reads = cr.actions.filter((a) => a.kind === 'basket').length
      if (reads !== 2) findings.push(`❌ compare: wanted 2 basket reads, got ${reads}`)
    }
  }
  // a spoken yes accepts the standing offer (the reply's first chip)
  let y = { ...DEFAULT_AGENT_CTX, account: OWNER }
  let yr = await turn('what is a basket?', y, /hero/, 'agentic: an answer that leaves an offer')
  y = yr.ctx
  if (!y.lastOffer) findings.push('❌ lastOffer empty after a chipped answer')
  yr = await turn('yes', y, undefined, '"yes" accepts the standing offer')
  if (yr.actions.some((a) => a.kind === 'text' && /To what/.test(a.text))) findings.push('❌ "yes" did not fire the standing offer')
  // the elliptical chain follow-up re-runs the last list there
  let e = { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }
  let er = await turn('what baskets are there?', e, /baskets/, 'agentic: list before the ellipsis')
  e = er.ctx
  er = await turn('and on robinhood?', e, /baskets|answered empty/i, 'elliptical chain re-run')
  if (er.ctx.chainId !== 4663) findings.push(`❌ elliptical: chain should be 4663, got ${er.ctx.chainId}`)
  // the meta question mid-draft reports real state
  let m = { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }
  let mr = await turn('add vvv', m, /draft|matches/i, 'agentic: a draft for the meta probe')
  m = mr.ctx
  while (m.pending?.queue?.length && mr.actions.some((a) => a.kind === 'candidates')) {
    const cand = mr.actions.find((a) => a.kind === 'candidates')
    mr = await turn(`use ${cand.hits[0].address} for ${cand.ticker}`, m, /draft|matches/i, `pick ${cand.ticker}`)
    m = mr.ctx
  }
  await turn('what were we doing?', m, /Where we stand|draft holds/i, 'meta: the agent reports its own state')
  // "undo" pops the last pick (QoL 2026-08-20) — from the one-leg draft the
  // meta probe left, undo must empty it in words, never fall to the generic
  {
    const ur = await turn('undo', m, /dropped|empty again|draft/i, '"undo" pops the last pick')
    const ub = (ur.ctx.drafts?.[8453] ?? []).map((p) => p.symbol).join('+')
    if (/VVV/i.test(ub)) findings.push(`❌ undo: VVV still in the bucket [${ub}]`)
  }
  // spoken weights ride into the create card (a candidate pause loses them by design)
  let w = { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }
  let wr = await turn('create a basket of VVV and AERO 70/30', w, /draft|matches/i, 'spoken weights at create')
  w = wr.ctx
  let paused = false
  while (w.pending?.queue?.length && wr.actions.some((a) => a.kind === 'candidates')) {
    paused = true
    const cand = wr.actions.find((a) => a.kind === 'candidates')
    wr = await turn(`use ${cand.hits[0].address} for ${cand.ticker}`, w, /draft|matches/i, `pick ${cand.ticker}`)
    w = wr.ctx
  }
  const created = wr.actions.find((a) => a.kind === 'create')
  if (!created) findings.push('❌ weights probe: no create card came back')
  else if (!paused && JSON.stringify(created.weights) !== JSON.stringify([70, 30]))
    findings.push(`❌ spoken weights not applied: got ${JSON.stringify(created.weights)}`)
  else console.log(`  spoken weights: ${JSON.stringify(created.weights) ?? 'lost to a candidate pause (by design)'}`)
}

// ── 8b. the exit carries BOTH doors in-chat + the new live answers ──────────
if (!FAST) {
  let x = { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }
  let xr = await turn('what baskets are there?', x, /baskets/, 'exit round: the list')
  x = xr.ctx
  const xrows = xr.actions.find((a) => a.kind === 'baskets')?.rows ?? []
  if (xrows.length) {
    xr = await turn(`read $${xrows[0].symbol}`, x, /basket/, 'exit round: read one')
    x = xr.ctx
    // ONE WAY OUT ON SCREEN (owner 2026-08-21). This used to assert BOTH cards
    // in one reply; that WAS the multiple-options state. The contract now: the
    // sell card leads alone, and the in-kind door is offered in WORDS so the
    // capability stays discoverable without being a second armed primary.
    xr = await turn('get me out', x, /settlement/i, 'exit leads with ONE card')
    const exitCards = xr.actions.filter((a) => a.kind === 'trade' || a.kind === 'redeem')
    if (exitCards.length !== 1 || exitCards[0].kind !== 'trade') findings.push(`❌ exit: ${exitCards.length} money cards (${exitCards.map((a) => a.kind)}), wanted exactly one trade card`)
    if (!/redeem in kind/i.test(xr.actions.map((a) => a.text ?? '').join(' '))) findings.push('❌ exit: the in-kind door is not offered in words')
    if (xr.actions.some((a) => a.kind === 'link' && /basket page/i.test(a.label ?? ''))) findings.push('❌ exit still links out to the nonexistent page redeem')
    x = xr.ctx
    xr = await turn('redeem in kind', x, /redeem/, 'explicit in-kind ask gets the card alone')
    if (!xr.actions.some((a) => a.kind === 'redeem')) findings.push('❌ in-kind ask: no redeem card')
    x = xr.ctx
    xr = await turn(`how is $${xrows[0].symbol} doing this week?`, x, /perf|measured|NAV/i, 'perf question answers with the spark card')
    if (!xr.actions.some((a) => a.kind === 'perf' && a.range === '7D')) findings.push('❌ perf: no 7D perf card')
  }
  {
    const ev = await turn('what do i hold everywhere', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /across|positions|any supported chain/i, 'the everywhere sweep')
    const rails = ev.actions.filter((a) => a.kind === 'positions').length
    console.log(`  everywhere sweep: ${rails} chain rail(s)`)
    if (rails === 0 && !/any supported chain/.test(ev.actions[0]?.text ?? '')) findings.push('❌ everywhere: no rails and no honest empty answer')
  }
  await turn('whats the eth price', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /ETH is \$|did not read/, 'live ETH price')
  await turn('whats the tvl here', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /across \d+ baskets|\$\d/, 'live TVL sum')
  // draft pill's door: build one leg, then reopen the compose card by words
  let dp = { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }
  let dpr = await turn('add vvv', dp, /draft|matches/i, 'draft for the pill door')
  dp = dpr.ctx
  while (dp.pending?.queue?.length && dpr.actions.some((a) => a.kind === 'candidates')) {
    const cand = dpr.actions.find((a) => a.kind === 'candidates')
    dpr = await turn(`use ${cand.hits[0].address} for ${cand.ticker}`, dp, /draft/i, `pick ${cand.ticker}`)
    dp = dpr.ctx
  }
  dpr = await turn('show my draft', dp, /draft/i, '"show my draft" reopens the compose view')
  if (!(dpr.ctx.drafts?.[8453] ?? []).length) findings.push('❌ show-draft: the bucket did not survive the reopen')
}

// ── 8b2. the amount ASK (owner: never default a dollar figure) ───────────────
if (!FAST) {
  let aa = { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }
  let ar = await turn('buy SVI', aa, /How much would you like/i, 'amountless buy ASKS')
  aa = ar.ctx
  ar = await turn('$100', aa, /trade/, 'the $100 chip answers the ask')
  const at1 = ar.actions.find((a) => a.kind === 'trade')
  if (!at1 || at1.amountUsd !== 100 || at1.side !== 'buy') findings.push(`❌ ask-flow: got side ${at1?.side} amount ${at1?.amountUsd}`)
  // the two-step: which basket → how much → word amount
  let bb = { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }
  let br2 = await turn('Buy a basket', bb, /Which basket/i, 'buy-a-basket asks which')
  bb = br2.ctx
  br2 = await turn('SVI', bb, /How much would you like/i, 'basket answer still asks amount')
  bb = br2.ctx
  br2 = await turn('fifty bucks', bb, /trade/, 'a word amount answers the ask')
  const at2 = br2.actions.find((a) => a.kind === 'trade')
  if (!at2 || at2.amountUsd !== 50) findings.push(`❌ two-step ask: amount ${at2?.amountUsd}`)
  // amount GIVEN up front still cards directly (the fast path stands)
  const dr = await turn('buy $25 of SVI', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /trade/, 'explicit amount skips the ask')
  const at3 = dr.actions.find((a) => a.kind === 'trade')
  if (!at3 || at3.amountUsd !== 25) findings.push(`❌ fast path: amount ${at3?.amountUsd}`)
}

// ── 8c. fractional sells: "sell half my X" presets REAL half-balance shares ──
if (!FAST) {
  let f = { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 4663 }
  const fp = await turn('what do i hold?', f, /positions|No basket holdings/i, 'fractional: the holding')
  f = fp.ctx
  const frow = fp.actions.find((a) => a.kind === 'positions')?.rows?.[0]
  if (frow) {
    const fr = await turn(`sell half my $${frow.symbol}`, f, /trade/, 'sell half presets shares')
    const tr = fr.actions.find((a) => a.kind === 'trade')
    const held = Number(String(frow.shares).replace(/,/g, ''))
    const preset = tr?.sharesAmount ? Number(tr.sharesAmount) : null
    console.log(`  fractional: hold ${held} → preset ${preset} (side ${tr?.side})`)
    if (tr?.side !== 'sell') findings.push('❌ fractional: card not on the sell side')
    if (preset == null || Math.abs(preset - held / 2) / (held / 2) > 0.01) findings.push(`❌ fractional: preset ${preset} is not half of ${held}`)
  } else console.log('  fractional: no live holding to halve (skipped)')
}

// ── 8d. in-chat migrate + the operator brain seam ────────────────────────────
if (!FAST) {
  // migrate: two real Base baskets, the card carries both identities
  const mg = await turn('migrate SVI into TRINITY', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /migrate|in kind/i, 'in-chat migrate')
  const mga = mg.actions.find((a) => a.kind === 'migrate')
  if (!mga) findings.push('❌ migrate: no migrate card in the reply')
  else console.log(`  migrate card: ${mga.from.symbol} → ${mga.to.symbol}`)
  const mg2 = await turn('migrate SVI into NOSUCHBSK', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /did not match a basket/i, 'migrate with a bad target asks')
  void mg2

  // THE BRAIN SEAM: a local operator brain speaks + delegates; junk falls back
  const { createServer } = await import('node:http')
  let mode = 'delegate'
  const brain = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      if (mode === 'junk') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ actions: [{ kind: 'trade', evil: true }] })) // NOT the contract — must be ignored
        return
      }
      if (mode === 'boom') {
        res.writeHead(500)
        res.end('no')
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ say: ['The operator brain heard you.'], sendThrough: 'what baskets are there?', chips: ['Read $SVI'] }))
    })
  })
  await new Promise((r) => brain.listen(0, '127.0.0.1', r))
  const port = brain.address().port
  process.env.VITE_AGENT_ENDPOINT = `http://127.0.0.1:${port}/brain`
  const br = await turn('hello wise ghost', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /operator brain heard/i, 'brain speaks + delegates')
  if (!br.actions.some((a) => a.kind === 'baskets')) findings.push('❌ brain: the delegated message did not run the regex machinery')
  if (br.ctx.lastOffer !== 'Read $SVI') findings.push('❌ brain: chips did not become the standing offer')
  mode = 'junk'
  const bj = await turn('what is a basket?', { ...DEFAULT_AGENT_CTX }, /hero/, 'junk brain reply falls back to regex')
  if (bj.actions.some((a) => a.kind === 'trade')) findings.push('❌ brain: a fabricated action LEAKED through the seam')
  mode = 'boom'
  await turn('what is nav?', { ...DEFAULT_AGENT_CTX }, /NAV/, 'a 500 brain falls back to regex')
  delete process.env.VITE_AGENT_ENDPOINT
  brain.close()
  await turn('is it safe?', { ...DEFAULT_AGENT_CTX }, /Non-custodial/, 'seam off again: pure regex')
}

// ── 8e. multilingual + word-amount OPERATIONS (live: verbs walk the money paths) ──
if (!FAST) {
  const es = await turn('compra $25 de SVI', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /trade/, 'es: compra walks the buy path')
  const esT = es.actions.find((a) => a.kind === 'trade')
  if (esT && (esT.side !== 'buy' || esT.amountUsd !== 25)) findings.push(`❌ compra: side ${esT.side} amount ${esT.amountUsd}`)
  const de = await turn('verkaufe die hälfte von meinem STONKMEME', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 4663 }, /trade/, 'de: verkaufe die hälfte presets half')
  const deT = de.actions.find((a) => a.kind === 'trade')
  if (deT && deT.side !== 'sell') findings.push('❌ verkaufe: not the sell side')
  if (deT?.sharesAmount) console.log(`  de half-sell preset: ${deT.sharesAmount} shares`)
  const wa = await turn('i wanna put like fifty bucks into SVI', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /trade/, 'word amount: fifty bucks into SVI')
  const waT = wa.actions.find((a) => a.kind === 'trade')
  if (waT && (waT.side !== 'buy' || waT.amountUsd !== 50)) findings.push(`❌ fifty bucks: side ${waT.side} amount ${waT.amountUsd}`)
}

// ── 8f. the support + creator round ─────────────────────────────────────────
if (!FAST) {
  // tx inspector: a REAL recent tx from the chain itself (stable by construction)
  const { createPublicClient, http } = await import('viem')
  const rpc = process.env.VITE_BASE_RPC_URL || 'https://mainnet.base.org'
  const pc = createPublicClient({ transport: http(rpc) })
  const blk = await pc.getBlock({ includeTransactions: true }).catch(() => null)
  const someTx = blk?.transactions?.find((x) => typeof x === 'object' && x.hash)
  if (someTx) {
    const ir = await turn(`what happened in ${someTx.hash}`, { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /Status: (landed|REVERTED)/, 'tx inspector reads a live receipt')
    void ir
  } else console.log('  tx inspector: no live block tx to probe (skipped)')
  await turn('what happened in 0x' + 'ab'.repeat(32), { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /No receipt/, 'a junk hash answers honestly')
  // creator view (owner wallet may hold or not — both answers honest)
  await turn('how are my baskets doing?', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /You created|No baskets deployed/i, 'creator view')
  // leaderboard
  const lb = await turn('top creators', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /top creators|ranked/i, 'the leaderboard in chat')
  if (!lb.actions.some((a) => a.kind === 'link' && a.href === '/league')) findings.push('❌ leaderboard: no league link')
  // thesis (BASECORE carries one on the home page)
  await turn('why does SVI exist?', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /creator.s own case|no published thesis/i, 'the thesis read')
}

// ── 8g. the creator round (owner: "a ton more creator features") ────────────
if (!FAST) {
  const fx = await turn('how do creator fees work?', { ...DEFAULT_AGENT_CTX, chainId: 8453 }, /Where each fee goes|split/i, 'the fee-split explainer')
  if (!fx.actions.some((a) => a.kind === 'steps')) findings.push('❌ creator explainer: no steps card')
  await turn('what fees am i earning?', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /Accrued to your address|Nothing accrued/i, 'live fee accruals read')
  const th = await turn('write a thesis for SVI', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /thesis/i, 'the thesis card emits')
  if (!th.actions.some((a) => a.kind === 'thesis')) findings.push('❌ thesis: no thesis action')
  const pf = await turn('update my creator profile', { ...DEFAULT_AGENT_CTX, account: OWNER }, /creator page|claim a name/i, 'the profile card emits')
  if (!pf.actions.some((a) => a.kind === 'profile')) findings.push('❌ profile: no profile action')
}

// ── 8h. the watchlist + activity + slippage + multi-buy round ───────────────
if (!FAST) {
  // watch → my watches → unwatch (the store is the driver's localStorage polyfill)
  let wr = await turn('watch SVI, tell me if it moves 3%', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /Watching \$SVI.*3%|survives refreshes/i, 'a watch registers with baseline')
  void wr
  await turn('my watches', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /±3%|SVI on Base/i, 'the watchlist reads back')
  await turn('unwatch SVI', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /unwatched|not on the watchlist/i, 'unwatch clears it')
  await turn('my watches', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /Nothing watched/i, 'the list is empty again')
  // activity (no device log in the driver = the honest empty answer)
  await turn('my recent activity', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /No activity logged|Your last/i, 'activity reads the exec log')
  // slippage rides into the card
  const sl = await turn('buy $50 of SVI with 1% slippage', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /trade/, 'slippage in language')
  const slT = sl.actions.find((a) => a.kind === 'trade')
  if (!slT || slT.slippageBps !== 100 || slT.amountUsd !== 50) findings.push(`❌ slippage: bps ${slT?.slippageBps} amount ${slT?.amountUsd}`)
  // multi-buy
  // ONE ORCHESTRATED CARD (owner 2026-08-21). This used to assert TWO live
  // trade cards — two armed primaries at once, which is what he rejected. The
  // contract now: exactly one multiBuy action carrying both baskets, and NO
  // loose trade cards beside it.
  const mb = await turn('buy $25 each of SVI and TRINITY', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /one at a time/, 'multi-buy: one orchestrated card')
  const mbCard = mb.actions.find((a) => a.kind === 'multiBuy')
  const looseTrades = mb.actions.filter((a) => a.kind === 'trade')
  if (!mbCard) findings.push('❌ multi-buy: no multiBuy card')
  else if (mbCard.baskets.length !== 2 || mbCard.amountUsd !== 25) findings.push(`❌ multi-buy: ${mbCard.baskets.length} baskets at $${mbCard.amountUsd}, wanted 2 at $25`)
  if (looseTrades.length) findings.push(`❌ multi-buy: ${looseTrades.length} loose trade card(s) beside the orchestrated one`)

  // NEW VERSION IN CHAT (owner 2026-08-21) — was impossible before: no action,
  // no card, no link, so a chat deploy was always an UNLINKED basket.
  const vr = await turn('new version of SVI', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /successor/i, 'new version: the linked-deploy card')
  const vCard = vr.actions.find((a) => a.kind === 'version')
  if (!vCard) findings.push('❌ new version: no version card')
  else if (!/^SVI$/i.test(vCard.predecessor.symbol)) findings.push(`❌ new version: predecessor is ${vCard.predecessor.symbol}, wanted SVI`)
  // the phrasing the audit found dead ("upgrade") must reach it too
  const vr2 = await turn('upgrade SVI', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /successor/i, 'new version: "upgrade" reaches it')
  if (!vr2.actions.some((a) => a.kind === 'version')) findings.push('❌ new version: "upgrade X" did not reach the version card')

  // FEE CLAIM IN CHAT (owner 2026-08-21) — claiming was the ONE money action
  // with no card; the reply must never hand out the flush console as the way
  // to take the money.
  const fr = await turn('what fees am i earning', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /accrued|Nothing accrued/i, 'creator fees: read live')
  if (fr.actions.some((a) => a.kind === 'link' && /flush/i.test(a.href ?? ''))) findings.push('❌ fee claim: still links OUT to the flush console')

  // missed-questions telemetry: a shrugged message lands in the ring —
  // seeded OUTSIDE turn() because hitting the catch-all here is the POINT,
  // not a finding
  await handle('flibbertigibbet quantum', { ...DEFAULT_AGENT_CTX })
  await turn('missed questions', { ...DEFAULT_AGENT_CTX }, /hit the catch-all|No missed questions/i, 'the missed ring reads back')
}

// ── 8i. the cool round: what-if, any-wallet, DD ──────────────────────────────
if (!FAST) {
  await turn('what if i put $100 in SVI a month ago?', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /Measured, not predicted|does not reach back/i, 'the what-if time machine')
  const aw = await turn(`what does ${OWNER} hold?`, { ...DEFAULT_AGENT_CTX, chainId: 4663 }, /holds \d+ basket|holds no baskets/i, 'any-wallet read')
  void aw
  const dd = await turn('dd SVI', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /DD on \$SVI, measured now/i, 'the DD health check')
  if (!dd.actions.some((a) => a.kind === 'basket')) findings.push('❌ dd: no read card beside the diagnostics')
}

// ── 9. cross-chain settle (owner 11:05 live find): "add aero" on Robinhood
// must land the real verified Base AERO in the Base bucket, not the $1 dust ──
if (!FAST) {
  const cs = { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 4663 }
  const csr = await turn('add aero', cs, /settles on|Base holds|matches|Heads up/i, 'cross-chain settle: rn "add aero"')
  const csb = (csr.ctx.drafts?.[8453] ?? []).map((p) => p.symbol).join('+')
  const csrn = (csr.ctx.drafts?.[4663] ?? []).map((p) => p.symbol).join('+')
  console.log(`  cross-settle buckets: base[${csb}] rn[${csrn}]`)
  if (!/AERO/i.test(csb) && !/AERO/i.test(csrn) && !csr.actions.some((a) => a.kind === 'candidates'))
    findings.push(`❌ cross-settle: AERO landed nowhere (base[${csb}] rn[${csrn}])`)
  else if (!/AERO/i.test(csb))
    findings.push(`⚠ cross-settle: AERO did not redirect to Base (base[${csb}] rn[${csrn}]) — dust/verification reality may have moved, check by hand`)
}

// ── 10. the real-AI-feel round: candidate repair, compound sequences, the
// repair acknowledgment (owner 2026-08-20) ───────────────────────────────────
if (!FAST) {
  // (a) candidate repair: rail → ordinal pick → "no the other one" must land
  // on a DIFFERENT basket than the pick did
  let ro = { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }
  let ror = await turn('what baskets are there?', ro, /baskets/, 'repair round: the rail')
  ro = ror.ctx
  const roRows = ror.actions.find((a) => a.kind === 'baskets')?.rows ?? []
  if (roRows.length < 2) console.log('  candidate repair: fewer than 2 live baskets (skipped)')
  else {
    ror = await turn('the first one', ro, /basket/, 'repair round: the ordinal pick')
    ro = ror.ctx
    const picked = ro.lastBasket?.address
    ror = await turn('no the other one', ro, /basket/, '"no the other one" repairs the pick')
    ro = ror.ctx
    const other = ro.lastBasket?.address
    if (!picked || !other || picked.toLowerCase() === other.toLowerCase())
      findings.push(`❌ candidate repair: expected a different basket read (picked ${picked?.slice(0, 10)}… then ${other?.slice(0, 10)}…)`)
  }

  // (b) compound sequence: "read X then buy $25 of it" lands BOTH the read
  // and the trade card, the amount threaded through
  if (roRows.length) {
    const sym = roRows[0].symbol
    const cq = await turn(`read ${sym} then buy $25 of it`, { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /basket.*trade/, 'compound: read then buy')
    const cqKinds = cq.actions.map((a) => a.kind)
    const tcard = cq.actions.find((a) => a.kind === 'trade')
    if (!cqKinds.includes('basket') || !tcard) findings.push(`❌ compound: wanted basket AND trade, got [${cqKinds.join('+')}]`)
    else if (tcard.amountUsd !== 25) findings.push(`❌ compound: trade amount ${tcard.amountUsd}, wanted 25`)
  } else console.log('  compound: no live basket to read (skipped)')

  // (c) the repair acknowledgment, cold: an apology + recovery, never a shrug
  await turn('thats wrong', { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }, /My read was off/, '"thats wrong" cold gets the recovery')
}

console.log(`\n════ ${turns} turns · ${findings.length} findings ════`)
for (const f of findings) console.log(f)
if (findings.length === 0) console.log('every chip and probe landed on a real answer')
process.exit(findings.some((f) => f.startsWith('❌') || f.startsWith('💥')) ? 1 : 0)
