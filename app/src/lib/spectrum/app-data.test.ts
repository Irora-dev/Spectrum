import { describe, expect, it } from 'vitest'
import { spectrumAppDataHex } from './app-data'
import { appDataRefusal, SPECTRUM_APP_DATA } from './cow'

describe('spectrumAppDataHex', () => {
  it('is a bytes32 and is stable across calls', () => {
    const a = spectrumAppDataHex()
    expect(a).toMatch(/^0x[0-9a-f]{64}$/)
    expect(spectrumAppDataHex()).toBe(a)
  })

  // The document is signed as a HASH, so anything inside it is invisible in the
  // wallet prompt — which is exactly why a fee can hide there. The guard runs on
  // every call, not once at review, so adding such a field crashes in
  // development rather than shipping a silently-skimming order.
  it('the shipped document carries nothing that can act for the user', () => {
    expect(appDataRefusal(SPECTRUM_APP_DATA)).toBeNull()
    expect(JSON.stringify(SPECTRUM_APP_DATA)).not.toMatch(/partnerFee|referrer|hooks/i)
  })
})
