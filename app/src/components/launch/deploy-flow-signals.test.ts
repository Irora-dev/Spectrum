import { describe, expect, it } from 'vitest'
import type { DeployStatus } from '../../lib/spectrum/use-deploy'
import { autoSwitchVerdict } from '../reshape/auto-switch'
import { deployLaneShape, deployVerdict } from './deploy-flow-signals'

const ALL: DeployStatus[] = [
  'idle',
  'mining',
  'preparing',
  'ready',
  'signing',
  'confirming',
  'seeding',
  'success',
  'error',
]

describe('the pre-deploy verdict', () => {
  it('claims "simulated" at exactly ONE status — the one a passing simulation produces', () => {
    const simulated = ALL.filter((s) => deployVerdict({ status: s }).tone === 'simulated')
    expect(simulated).toEqual(['ready'])
  })

  it('says nothing has been spent yet, because nothing has', () => {
    expect(deployVerdict({ status: 'ready' }).line).toContain('Nothing has been spent')
  })

  it('reports work as work while the simulation is still running', () => {
    expect(deployVerdict({ status: 'preparing' }).tone).toBe('working')
    expect(deployVerdict({ status: 'mining' }).tone).toBe('working')
  })

  it('quotes the refusal it was given', () => {
    const v = deployVerdict({ status: 'error', error: 'CREATE2Failed' })
    expect(v.tone).toBe('refused')
    expect(v.line).toContain('CREATE2Failed')
  })

  it('never invents a cause it does not have', () => {
    const v = deployVerdict({ status: 'error', error: null })
    expect(v.tone).toBe('refused')
    expect(v.line).toContain('without saying why')
  })

  it('goes quiet once the wallet has it — this signal is about BEFORE the spend', () => {
    for (const s of ['signing', 'confirming', 'seeding', 'success', 'idle'] as const)
      expect(deployVerdict({ status: s }).tone, s).toBe('none')
  })

  it('a "none" verdict carries no line for a surface to render', () => {
    expect(deployVerdict({ status: 'idle' }).line).toBe('')
  })
})

describe('the single deploy in lane terms', () => {
  const BASE = 8453

  it('the switch step is exactly `ready` — after the simulation, before the signature', () => {
    const switching = ALL.filter((s) => deployLaneShape(s, BASE).laneState === 'switch')
    expect(switching).toEqual(['ready'])
    expect(deployLaneShape('ready', BASE).shipping).toBe(true)
  })

  it('reports a busy wallet for the WHOLE window it is busy, not just the prompt', () => {
    for (const s of ['signing', 'confirming', 'seeding'] as const)
      expect(deployLaneShape(s, BASE).signing, s).toBe(true)
    for (const s of ['idle', 'mining', 'preparing', 'ready'] as const)
      expect(deployLaneShape(s, BASE).signing, s).toBe(false)
  })

  it('an unknown target chain is never a lane', () => {
    expect(deployLaneShape('ready', null).laneChainId).toBeNull()
  })
})

describe('the four laws still hold for a single deploy — decided by the ceremonies’ own module', () => {
  const BASE = 8453
  const ETH = 1
  const ask = (status: DeployStatus, over: Record<string, unknown> = {}) =>
    autoSwitchVerdict({
      ...deployLaneShape(status, BASE),
      demo: false,
      connected: true,
      walletChainId: ETH,
      switching: false,
      declined: false,
      asked: [],
      ...over,
    })

  it('asks once the simulation has passed and the wallet is elsewhere', () => {
    expect(ask('ready')).toBe('ask')
  })

  it('never asks before the deploy is simulated and safe to sign', () => {
    for (const s of ['idle', 'mining', 'preparing'] as const) expect(ask(s), s).not.toBe('ask')
  })

  it('(b) never while a signature is out — refused twice over, by two independent facts', () => {
    // The single deploy is DOUBLY covered here, and the verdict names whichever
    // refusal it reaches first: autoSwitchVerdict tests `shipping` before
    // `signing`, and this flow stops shipping the moment it leaves `ready`. So
    // these statuses come back 'not-shipping' rather than 'signature-out'. What
    // law (b) actually promises is that nothing ASKS, and nothing does.
    for (const s of ['signing', 'confirming', 'seeding'] as const) {
      expect(ask(s), s).not.toBe('ask')
      expect(deployLaneShape(s, BASE).signing, s).toBe(true)
    }
    // And the signing flag refuses on its own merits: force the lane to look
    // like the switch step while a signature is out, and it still says no.
    expect(autoSwitchVerdict({
      shipping: true,
      laneChainId: BASE,
      laneState: 'switch',
      signing: true,
      demo: false,
      connected: true,
      walletChainId: ETH,
      switching: false,
      declined: false,
      asked: [],
    })).toBe('signature-out')
  })

  it('(a) once per chain, and never after a refusal', () => {
    expect(ask('ready', { asked: [BASE] })).toBe('already-asked')
    expect(ask('ready', { declined: true })).toBe('declined')
    expect(ask('ready', { switching: true })).toBe('already-asking')
  })

  it('(c) a wallet already on the target is asked nothing', () => {
    expect(ask('ready', { walletChainId: BASE })).toBe('already-there')
  })

  it('(d) a walkthrough never asks, before anything else is considered', () => {
    expect(ask('ready', { demo: true })).toBe('walkthrough')
  })

  it('no wallet, or an unknown wallet chain, is never a reason to ask', () => {
    expect(ask('ready', { connected: false })).toBe('no-wallet')
    expect(ask('ready', { walletChainId: null })).toBe('no-wallet')
  })
})
