// ISOLATION PROBE for the one turn the full 226-turn drive reported (twice, as
// two findings from a single cause): "create a basket of VVV and AERO 70/30".
// Both findings hang on AERO resolving on Base; if it resolves here, the drive's
// red was upstream rate-limiting under load, not the code. Runs the turn N times
// against the SAME bundled agent the drive uses.
import { readFileSync } from 'node:fs'
for (const line of readFileSync(new URL('../../.env.local', import.meta.url).pathname, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, '')
}
const { handle, DEFAULT_AGENT_CTX } = await import('./agent-bundle.mjs')
const OWNER = process.env.DRIVE_OWNER ?? '0x40B1e5818b449Db3A7bb0FE482B5784F77fCD2c0'
const N = Number(process.env.N || 3)
let pass = 0
for (let i = 1; i <= N; i++) {
  const ctx = { ...DEFAULT_AGENT_CTX, account: OWNER, chainId: 8453 }
  const r = await handle('create a basket of VVV and AERO 70/30', ctx)
  const created = (r.actions ?? []).find((a) => a.kind === 'create')
  // the reply text rides the FIRST action, the way drive.mjs reads it
  const first = r.actions?.[0]
  const textOut = first?.kind === 'text' || first?.kind === 'assetPicker' ? (first.text ?? '') : ''
  const kinds = (r.actions ?? []).map((a) => a.kind).join('+')
  const ok = /draft|matches/i.test(kinds + ' ' + textOut) && JSON.stringify(created?.weights) === JSON.stringify([70, 30])
  if (ok) pass++
  console.log(`run ${i}: ${ok ? 'PASS' : 'FAIL'} · weights=${JSON.stringify(created?.weights)} · legs=${(created?.legs ?? created?.picks ?? []).length} · [${kinds}] "${textOut.slice(0, 80)}"`)
  await new Promise((s) => setTimeout(s, 1500))
}
console.log(`\n${pass}/${N} passed in isolation`)
process.exit(pass === N ? 0 : 1)
