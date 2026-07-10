import { describe, it, expect } from 'vitest'
import { loadSiteMetadata, siteMetadataKey } from './site-metadata'
import { conventionPath } from './persist-metadata'

const BASKET = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01' as `0x${string}`

describe('siteMetadataKey', () => {
  it('is the project-root-absolute glob key, address lowercased', () => {
    expect(siteMetadataKey(8453, BASKET)).toBe('/metadata/8453/0xabcdef0123456789abcdef0123456789abcdef01.json')
  })

  it('is exactly `/metadata/` + the shared conventionPath (host + bundle agree)', () => {
    expect(siteMetadataKey(1, BASKET)).toBe('/metadata/' + conventionPath(1, BASKET))
  })
})

describe('loadSiteMetadata', () => {
  it('returns null for a basket with no committed blob (no import, no throw)', async () => {
    await expect(loadSiteMetadata(999999, BASKET)).resolves.toBeNull()
  })
})
