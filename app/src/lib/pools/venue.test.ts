import { describe, expect, it } from 'vitest'
import { Venue, VENUE_LABEL } from './types'
import { configuredChainIds, deploymentFor } from '../chain/deployments'

describe('Venue enum', () => {
  it('mirrors the on-chain enum orders exactly (numbering is ABI-load-bearing)', () => {
    // V2-lineage factories: {V4, V3, V2}. The stocks fork appends V4Q — its
    // Solidity enum is {V4, V3, V2, V4Q}, so V4Q MUST be 3. A renumber here
    // deploys legs against the wrong venue on-chain.
    expect(Venue.V4).toBe(0)
    expect(Venue.V3).toBe(1)
    expect(Venue.V2).toBe(2)
    expect(Venue.V4Q).toBe(3)
  })

  it('labels every venue', () => {
    for (const v of [Venue.V4, Venue.V3, Venue.V2, Venue.V4Q]) {
      expect(VENUE_LABEL[v]).toBeTruthy()
    }
  })
})

describe('v4qLineage gate', () => {
  it('stays DARK on every shipped chain (no deployed factory accepts venue 3)', () => {
    // The flag may only flip after PROBING the live factory with a venue-3
    // predictTokenAddress call — never from lineage naming. Proven the hard
    // way (2026-07-30): the 4663 launch-ceremony factory 0x07Bf…7e6f is the
    // V4Q-REMOVED build (enum stops at V2 — venue 0 answers, venue 3 reverts
    // at decode), and arming this flag against it halted a live deploy at
    // predictTokenAddress. The V4Q machinery lives in the separate stocks
    // lineage; flip per-chain only when a factory that ANSWERS venue 3 ships.
    for (const id of configuredChainIds()) {
      expect(deploymentFor(id).v4qLineage, `chain ${id}`).toBe(false)
    }
  })
})
