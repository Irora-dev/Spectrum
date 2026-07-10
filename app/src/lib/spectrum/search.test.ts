import { describe, expect, it } from 'vitest'
import { foldPlural, matchesTerms, parseQueryTerms, termsHitLabel } from './search'

describe('parseQueryTerms', () => {
  it('strips conversational filler down to the intent', () => {
    expect(parseQueryTerms("i'm interested in agents")).toEqual(['agent'])
    expect(parseQueryTerms('Show me all DeFi baskets')).toEqual(['defi'])
    expect(parseQueryTerms('what are the best meme baskets?')).toEqual(['meme'])
  })
  it('keeps multi-term intent (AND)', () => {
    expect(parseQueryTerms('base majors')).toEqual(['base', 'major'])
  })
  it('falls back to the raw words when everything was filler', () => {
    expect(parseQueryTerms('baskets')).toEqual(['basket'])
  })
  it('drops # and $ prefixes so tag/ticker paste works', () => {
    expect(parseQueryTerms('#agents')).toEqual(['agent'])
    expect(parseQueryTerms('$ROTATE2')).toEqual(['rotate2'])
  })
})

describe('foldPlural', () => {
  it('is length-guarded and -ss safe', () => {
    expect(foldPlural('agents')).toBe('agent')
    expect(foldPlural('memes')).toBe('meme')
    expect(foldPlural('as')).toBe('as')
    expect(foldPlural('grass')).toBe('grass')
  })
})

describe('matchesTerms', () => {
  it('matches conversational queries against name/tag haystacks', () => {
    const hay = 'AGENTS Agent Economy 0x…ba5e04 ai agents defi'
    expect(matchesTerms(hay, parseQueryTerms('im interested in agents'))).toBe(true)
    expect(matchesTerms(hay, parseQueryTerms('show me all defi baskets'))).toBe(true)
  })
  it('is plural-lenient in BOTH directions', () => {
    expect(matchesTerms('Meme Melange', parseQueryTerms('memes'))).toBe(true)
    expect(matchesTerms('ai agents', parseQueryTerms('agent'))).toBe(true)
  })
  it('AND semantics: every term must hit', () => {
    expect(matchesTerms('Base Core Majors', parseQueryTerms('base majors'))).toBe(true)
    expect(matchesTerms('Base Core Majors', parseQueryTerms('base memes'))).toBe(false)
  })
  it('empty query filters nothing', () => {
    expect(matchesTerms('anything at all', [])).toBe(true)
  })
})

describe('termsHitLabel (tag flagging)', () => {
  it('flags the tags a query names, compact + plural-lenient', () => {
    expect(termsHitLabel('AI Agents', parseQueryTerms('im interested in agents'))).toBe(true)
    expect(termsHitLabel('DeFi', parseQueryTerms('Show me all DeFi baskets'))).toBe(true)
    expect(termsHitLabel('DeFi', parseQueryTerms('memes'))).toBe(false)
  })
  it('never flags on an empty query', () => {
    expect(termsHitLabel('DeFi', [])).toBe(false)
  })
})
