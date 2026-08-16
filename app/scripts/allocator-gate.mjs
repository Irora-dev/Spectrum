#!/usr/bin/env node
/**
 * THE ALLOCATOR GATE — mechanical gates A1–A5 of the allocator change protocol
 * (docs/allocator/ALLOCATOR-CHANGE-PROTOCOL.md). Modelled on the contracts
 * lane's `tools/contract-change-gate.sh`, but targeting THIS lane's root causes:
 * we do not own an immutable contract, we compose calldata FOR one and we show
 * money to a human. Those are different failure classes and they need different
 * gates.
 *
 * Run: node scripts/allocator-gate.mjs            (all gates)
 *      node scripts/allocator-gate.mjs --gate A1  (one)
 *
 * EXIT 0 only when every gate PASSES. A gate that cannot VERIFY is a FAILURE,
 * not a pass — "I could not check" and "I checked and it is fine" are different
 * answers, and conflating them is the read-failed law in tooling form.
 *
 * ⚠ THIS SCRIPT IS NOT THE PROTOCOL. It is gates A1–A5, the cheap mechanical
 * ones. A6 (independent adversarial review) and A7 (stated residuals) are human
 * gates and cannot be automated — and A6 is empirically the only gate that has
 * ever caught a real defect in this lane's history. A green run here means the
 * mechanical gates passed; it does NOT mean a money-path change may land.
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { keccak256, toHex } from 'viem'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
// The contracts checkout: env override first, then the maintainer layout
// (~/Irora-dev/spectrum-contracts beside the kit checkouts). Gates that need
// it SKIP WITH A NOTE when absent (existsSync below) — never a hard fail.
const CONTRACTS =
  process.env.SPECTRUM_CONTRACTS_DIR ?? join(APP, '..', '..', 'Irora-dev', 'spectrum-contracts')
const SOL = join(CONTRACTS, 'src/periphery/batcher/SpectrumPortfolioBatcher.sol')
const ARTIFACT = join(CONTRACTS, 'out/SpectrumPortfolioBatcher.sol/SpectrumPortfolioBatcher.json')

const only = process.argv.includes('--gate') ? process.argv[process.argv.indexOf('--gate') + 1] : null
const results = []
const read = (p) => readFileSync(join(APP, p), 'utf8')
function gate(id, title, fn) {
  if (only && only !== id) return
  const notes = []
  let verdict
  try {
    verdict = fn((m) => notes.push(m)) ?? 'PASS'
  } catch (e) {
    notes.push(String(e.message || e))
    verdict = 'FAIL'
  }
  results.push({ id, title, verdict, notes })
}

// ── A1 — MIRROR PARITY ──────────────────────────────────────────────────────
// The app RESTATES laws that live in an immutable contract. Restating is the
// drift engine, and here the drift is not cosmetic: composing against a stale
// law produces calldata the chain reverts, or worse, one it accepts.
// This is the gate for the defect that actually happened (2026-08-06: the fee
// flipped from inclusive to exclusive and the old scaling helper double-netted
// it — caught by a conservation test, not by anyone reading the contract).
gate('A1', 'MIRROR PARITY — every mirrored contract law matches the contract SOURCE', (note) => {
  if (!existsSync(SOL) || !existsSync(ARTIFACT)) {
    note(`cannot verify: contract source or artifact absent (${SOL})`)
    note('a gate that cannot verify FAILS — this is not a pass')
    return 'FAIL'
  }
  const sol = readFileSync(SOL, 'utf8')
  const abi = JSON.parse(readFileSync(ARTIFACT, 'utf8')).abi
  const app = read('src/lib/spectrum/portfolio-batcher.ts')
  const quote = read('src/lib/spectrum/zeroex-quote.ts')
  let bad = 0

  // (a) the selector, recomputed from the ARTIFACT's own tuple shape rather
  //     than from a signature string retyped by hand
  const fn = abi.find((e) => e.type === 'function' && e.name === 'batchBuy')
  if (!fn) throw new Error('batchBuy absent from the artifact ABI')
  const typeOf = (i) => (i.type === 'tuple' || i.type === 'tuple[]' ? `(${i.components.map(typeOf).join(',')})${i.type === 'tuple[]' ? '[]' : ''}` : i.type)
  const sig = `batchBuy(${fn.inputs.map(typeOf).join(',')})`
  const selector = keccak256(toHex(sig)).slice(0, 10)
  const pinned = /PORTFOLIO_BATCH_BUY_SELECTOR\s*=\s*'(0x[0-9a-fA-F]{8})'/.exec(app)?.[1]
  if (pinned !== selector) {
    note(`selector drift: app pins ${pinned}, artifact computes ${selector} for ${sig}`)
    bad++
  } else note(`selector ${selector} matches ${sig}`)

  // (b) numeric + address constants the app mirrors
  const solConst = (name) => {
    const m = new RegExp(`constant\\s+${name}\\s*=\\s*([^;]+);`).exec(sol)
    return m ? m[1].trim() : null
  }
  const checks = [
    ['MAX_LEGS', solConst('MAX_LEGS'), /PORTFOLIO_MAX_LEGS\s*=\s*(\d+)/.exec(app)?.[1]],
    ['MAX_FEE_BPS', solConst('MAX_FEE_BPS')?.replace(/\s*\/\/.*$/, ''), /PORTFOLIO_MAX_FEE_BPS\s*=\s*(\d+)/.exec(app)?.[1]],
  ]
  for (const [name, onChain, inApp] of checks) {
    const want = (onChain ?? '').replace(/_/g, '')
    if (!want || !inApp || want !== inApp) {
      note(`${name} drift: contract=${onChain ?? 'UNREADABLE'} app=${inApp ?? 'ABSENT'}`)
      bad++
    } else note(`${name} = ${inApp} matches`)
  }
  // MAX_DEADLINE_WINDOW is written as `24 hours` in Solidity — compare seconds
  const windowSol = solConst('MAX_DEADLINE_WINDOW')
  const windowSec = /^(\d+)\s*hours$/.exec(windowSol ?? '') ? Number(RegExp.$1) * 3600 : null
  const windowApp = Number(/PORTFOLIO_MAX_DEADLINE_WINDOW_SEC\s*=\s*([\d_]+)/.exec(app)?.[1]?.replace(/_/g, ''))
  if (!windowSec || windowSec !== windowApp) {
    note(`MAX_DEADLINE_WINDOW drift: contract=${windowSol} (${windowSec}s) app=${windowApp}s`)
    bad++
  } else note(`MAX_DEADLINE_WINDOW = ${windowSec}s matches`)

  // (c) the baked router address — the one constant whose drift sends funds
  //     to the wrong place rather than merely reverting
  const solHolder = /ALLOWANCE_HOLDER\s*=\s*(0x[0-9a-fA-F]{40})/.exec(sol)?.[1]
  const appHolder = /ALLOWANCE_HOLDER:\s*Address\s*=\s*'(0x[0-9a-fA-F]{40})'/.exec(quote)?.[1]
  if (!solHolder || !appHolder || solHolder.toLowerCase() !== appHolder.toLowerCase()) {
    note(`ALLOWANCE_HOLDER drift: contract=${solHolder} app=${appHolder}`)
    bad++
  } else note('ALLOWANCE_HOLDER matches the baked constant')

  // (d) the FEE EQUATION's direction. The contract requires
  //     `committed + committed*feeBps/BPS <= received` (EXCLUSIVE). If the
  //     contract ever states it differently, the app's maxCommittedFor is
  //     solving the wrong inequality — the 2026-08-06 defect exactly.
  if (!/committed\s*\+\s*\(committed\s*\*\s*p\.feeBps\)\s*\/\s*BPS\s*>\s*received/.test(sol)) {
    note('the contract fee inequality no longer matches the shape maxCommittedFor inverts — re-derive it')
    bad++
  } else note('fee equation is still EXCLUSIVE (committed + fee <= received)')
  return bad ? 'FAIL' : 'PASS'
})

// ── A2 — NO UNMEASURED INPUT ON A MONEY PATH ────────────────────────────────
// Every input the floor formula needs must (i) have a real producer and (ii)
// refuse when unreadable. The floor is the user's ONLY protection, so an input
// that silently defaults is a floor built on a guess.
gate('A2', 'NO UNMEASURED INPUT — every floor input has a producer and refuses when unreadable', (note) => {
  let bad = 0
  const floors = read('src/lib/spectrum/floor-discipline.ts')
  // each named refusal reason must exist in the module AND be asserted in its test
  const test = read('src/lib/spectrum/floor-discipline.test.ts')
  for (const reason of ['unmeasured-market-slippage', 'unknown-buy-token-tax', 'unreadable-hop-reserve', 'exceeds-s-max', 'floor-rounds-to-zero', 'unreadable-quote']) {
    if (!floors.includes(`'${reason}'`)) { note(`refusal reason ${reason} missing from floor-discipline`); bad++ }
    else if (!test.includes(reason)) { note(`refusal reason ${reason} is never ASSERTED in its test — unproven guard`); bad++ }
  }
  // the hop reserve must have a producer, not just a parameter
  if (!existsSync(join(APP, 'src/lib/spectrum/hop-reserve.ts'))) {
    note('hopReserve is a required input with NO producer module — it was unmeasured for a whole day once')
    bad++
  } else note('hop-reserve.ts produces the hop input')
  // and the compose seam must refuse an unreadable hop BEFORE spending quotes
  const pb = read('src/lib/spectrum/portfolio-batcher.ts')
  if (!/hopReserveUsd == null[\s\S]{0,200}BatchComposeRefusal/.test(pb)) {
    note('the compose seam does not refuse an unreadable hop up front')
    bad++
  } else note('compose refuses an unreadable hop before fetching quotes')
  return bad ? 'FAIL' : 'PASS'
})

// ── A3 — THE DARK GATE IS A GATE, NOT A COMMENT ─────────────────────────────
// 2026-08-06: ZEROEX_COMPOSE_ENABLED was read by nothing; the only thing
// standing between the path and going live was a comment asking to be
// remembered. A flag that gates nothing is not a flag.
gate('A3', 'THE DARK GATE — the flag is enforced in code, and no app file imports the unchecked path', (note) => {
  let bad = 0
  const pb = read('src/lib/spectrum/portfolio-batcher.ts')
  if (!/if\s*\(!ZEROEX_COMPOSE_ENABLED\)[\s\S]{0,160}throw/.test(pb)) {
    note('the live entry does not enforce ZEROEX_COMPOSE_ENABLED')
    bad++
  } else note('assembleZeroExBatchBuyLive enforces the flag')
  // ⚠ AND THE FLAG MUST ACTUALLY BE DARK. Found by bite-testing this gate
  // (2026-08-07): flipping ZEROEX_COMPOSE_ENABLED to `true` passed A3
  // cleanly, because the gate only verified the flag was READ and enforced —
  // never that it was SET dark. That is the same class of change as flipping
  // SIMULATED, which this gate does catch two checks below, so the asymmetry
  // was the defect: the 0x compose path could have gone live on a one-word
  // edit with every gate green. Turning it on is a decision for the owner, and a
  // failing gate is how a decision gets asked for.
  if (!/ZEROEX_COMPOSE_ENABLED\s*=\s*false/.test(pb)) {
    note('ZEROEX_COMPOSE_ENABLED is no longer false — taking the 0x compose path live needs the owner’s explicit word, not a gate run')
    bad++
  } else note('ZEROEX_COMPOSE_ENABLED = false (the path is dark)')
  // nothing outside tests may reach the unchecked path
  const hits = grep('assembleZeroExBatchBuyUnchecked').filter((l) => !l.includes('.test.') && !l.includes('portfolio-batcher.ts'))
  if (hits.length) { note(`app code reaches the UNCHECKED path:\n    ${hits.join('\n    ')}`); bad++ }
  else note('no app file imports the unchecked path')
  // SIMULATED must still be true while the executor is not ruled live
  const alloc = read('src/lib/spectrum/allocation.ts')
  if (!/SIMULATED\s*=\s*true/.test(alloc)) {
    note('SIMULATED is no longer true — this is a LIVE-MONEY change and needs the owner’s explicit word, not a gate run')
    bad++
  } else note('SIMULATED = true')
  return bad ? 'FAIL' : 'PASS'
})

// ── A4 — BOTH STANDING SWEEPS COVER EVERY MONEY MODULE ──────────────────────
// The standing law: a new money module gets a case in hostile-numbers AND
// hostile-strings, or its unreadable-input handling is untested by construction.
gate('A4', 'STANDING SWEEPS — every money module appears in BOTH hostile sweeps', (note) => {
  // Each money module declares which sweeps APPLY. An exemption must carry a
  // reason, and it is listed here rather than assumed — because the alternative
  // to a named exemption is a VACUOUS test written to satisfy a gate, which is
  // the tautology class the contracts lane's GATE 1 exists to catch. A gate that
  // extracts a meaningless test has made the codebase worse.
  const MONEY = [
    { m: 'floor-discipline', numbers: true, strings: true },
    { m: 'zeroex-quote', numbers: true, strings: true },
    { m: 'portfolio-batcher', numbers: true, strings: true },
    { m: 'hop-reserve', numbers: true, strings: true },
    { m: 'capability-ladder', numbers: true, strings: true },
    { m: 'realised-price', numbers: true, strings: true },
    {
      m: 'economic-leg-cap',
      numbers: true,
      strings: false,
      why: 'emits no deployer-controlled text: its messages are fixed sentences about the network, with no token symbol in them.',
    },
    { m: 'assemble-batch', numbers: true, strings: true },
    { m: 'plan-legs', numbers: true, strings: true },
    { m: 'batcher', numbers: true, strings: true },
    { m: 'displayed-vs-signed', numbers: true, strings: true },
    {
      m: 'acquisition-inputs',
      numbers: true,
      strings: false,
      why: 'emits no text at all — it returns verdict unions and a sell-path enum. The symbol it carries is rendered by acquisition-route, which IS swept for it.',
    },
    {
      m: 'pool-safety',
      numbers: true,
      strings: false,
      why: 'every verdict message is a FIXED sentence — verified: zero template interpolations in the module, so no deployer-controlled string can reach shown text through it. Its string inputs (addresses, pool ids) are compared, never rendered.',
    },
    {
      m: 'zerox-proxy-request',
      numbers: true,
      strings: false,
      why: 'every refusal string is a compile-time literal chosen from a fixed set — no caller input is ever interpolated (pinned: "never echoes caller input into the refusal text"). Its numeric inputs (chainId, sellAmount, slippageBps) are the hostile surface and ARE swept.',
    },
    {
      m: 'zerox-proxy-handler',
      numbers: false,
      strings: false,
      why: 'it emits no numbers and no deployer-controlled text: every response body is one of a fixed set of {name, message} literals, and the only variable content it returns is the upstream JSON passed through verbatim. Its hostile surface is REQUEST shapes, swept in zerox-proxy-handler.test.ts (14 cases) rather than by value sweeps that cannot express a Request.',
    },
    {
      m: 'acquisition-route',
      numbers: false,
      strings: true,
      why: 'no numeric input exists: its inputs are three unions (an aggregator verdict, a pool verdict, a sell-path enum) and a symbol. A hostile-number case here could only assert something already true by types. (Reason refreshed 2026-08-07 when the aggregator input stopped being a boolean — a stale REASON is not something this gate can detect for itself.)',
    },
  ]
  const nums = read('src/lib/spectrum/hostile-numbers.test.ts')
  const strs = read('src/lib/spectrum/hostile-strings.test.ts')
  let bad = 0
  for (const { m, numbers, strings, why } of MONEY) {
    // ⚠ AN IMPORT IS NOT COVERAGE (A6 review, 2026-08-07). This tested only
    // that the specifier string appeared in the sweep file, so a module could
    // be imported and never exercised and still print ✅ — which is exactly
    // what had happened to acquisition-route, whose sweep touched one of its
    // four verdicts. Require at least one CALL of something imported from the
    // module, so the declaration means the sweep ran it.
    const callsFrom = (src) => {
      // ⚠ ALL import statements, not the first. A module can be imported twice
      // (a value import and a type import), and reading only the first gave a
      // FALSE POSITIVE on `batcher` — whose `asFundingRaw` is genuinely called
      // from a second statement. A gate that cries wolf gets weakened, so this
      // bug was worth more care than the check it guards.
      const names = [...src.matchAll(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*'\\./${m}'`, 'g'))]
        .flatMap((imp) => imp[1]
          .split(',')
          .map((x) => x.replace(/^.*\bas\b/, '').replace(/\btype\b/, '').trim())
          .filter(Boolean))
      if (!names.length) return false
      return names.some((n) => new RegExp(`\\b${n}\\s*\\(`).test(src))
    }
    const inN = nums.includes(`'./${m}'`) && callsFrom(nums)
    const inS = strs.includes(`'./${m}'`) && callsFrom(strs)
    if (numbers && !inN) { note(`${m}: MISSING from hostile-numbers`); bad++ }
    if (strings && !inS) { note(`${m}: MISSING from hostile-strings`); bad++ }
    // an exemption that is no longer true must fail too: if the module HAS a
    // case in a sweep it declared N/A, the declaration is stale
    if (!numbers && inN) { note(`${m}: declared numbers-N/A but HAS a numbers case — update the declaration`); bad++ }
    if (!strings && inS) { note(`${m}: declared strings-N/A but HAS a strings case — update the declaration`); bad++ }
    if (!numbers && why) note(`${m}: numbers N/A — ${why}`)
    if (!strings && why) note(`${m}: strings N/A — ${why}`)
  }
  if (!bad) note(`all ${MONEY.length} money modules are covered where the sweep applies`)
  return bad ? 'FAIL' : 'PASS'
})

// ── A5 — SHOWN TEXT IS BOUNDED ──────────────────────────────────────────────
// Shown text is a money surface. A deployer-controlled symbol reached WALLET
// PROMPT labels (2026-08-06), so this is the detector from that sweep, kept as
// a gate with the known-correct exemptions named individually.
gate('A5', 'SHOWN TEXT — no unbounded deployer symbol outside the named identity exemptions', (note) => {
  // a symbol here is an IDENTIFIER, not text: bounding it changes what it
  // identifies. Each exemption is listed so a NEW one cannot hide among them.
  const EXEMPT = [
    'src/components/BasketBento.tsx',            // React key: chainId:address:symbol
    'src/components/allocate/PortfolioFlow.tsx', // React key + its derivation
    'src/lib/spectrum/insights.ts',              // insight id: depeg:<symbol>
    'src/lib/spectrum/safe-copy.ts',             // the helper's own comment
  ]
  const out = grepE("\\$\\{[A-Za-z_$][A-Za-z0-9_$]*(\\??\\.[A-Za-z0-9_$]+)*[sS]ymbol\\}")
    .filter((l) => !l.includes('.test.') && !l.includes('showSymbol'))
    .filter((l) => !EXEMPT.some((e) => l.startsWith(e)))
  if (out.length) { note(`unbounded shown symbols:\n    ${out.slice(0, 20).join('\n    ')}`); return 'FAIL' }
  note(`bounded everywhere outside the ${EXEMPT.length} named identity exemptions`)
})

function grep(needle) {
  try {
    return execFileSync('grep', ['-rn', '--include=*.ts', '--include=*.tsx', needle, 'src'], { cwd: APP, encoding: 'utf8' })
      .trim().split('\n').filter(Boolean)
  } catch { return [] }
}
function grepE(re) {
  try {
    return execFileSync('grep', ['-rnE', '--include=*.ts', '--include=*.tsx', re, 'src'], { cwd: APP, encoding: 'utf8' })
      .trim().split('\n').filter(Boolean)
  } catch { return [] }
}

// ── report ──────────────────────────────────────────────────────────────────
const W = 74
console.log('\n' + '─'.repeat(W))
console.log('THE ALLOCATOR GATE — mechanical gates A1–A5')
console.log('─'.repeat(W))
for (const r of results) {
  console.log(`\n${r.verdict === 'PASS' ? '✅' : '⛔'} ${r.id}  ${r.title}`)
  for (const n of r.notes) console.log(`     ${n}`)
}
const failed = results.filter((r) => r.verdict !== 'PASS')
console.log('\n' + '─'.repeat(W))
console.log(`${results.length - failed.length}/${results.length} mechanical gates pass`)
console.log('⚠ A6 (independent adversarial review) and A7 (stated residuals) are HUMAN gates.')
console.log('  A6 is the only gate in this lane that has ever caught a real defect. A green')
console.log('  run here does NOT authorise a money-path change to land.')
console.log('─'.repeat(W) + '\n')
process.exit(failed.length ? 1 : 0)
