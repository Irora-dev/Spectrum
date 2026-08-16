import { describe, expect, it } from 'vitest'
import type { AwayDelta } from './away-diff'
import { awayInsights } from './insights'

// The briefing's dress layer: away-diff's ranked deltas become strip cards.
// The mapping is pinned per kind — the form heuristic (a travelled share takes
// the move mark; an arrival its share; a departure and the total draw nothing)
// and the sentence arriving VERBATIM as the headline (the diff's measured
// wording is the fact; the UI adds no wording).

const deltas: AwayDelta[] = [
  { kind: 'total-moved', pct: -3.2, fromUsd: 1000, toUsd: 968, sentence: 'Your total moved down 3.2% while you were away.' },
  { kind: 'share-moved', key: '8453:0xa', symbol: 'AERO', fromPct: 9, toPct: 21, sentence: '$AERO grew 12.0 points, from 9.0% to 21.0% of the book.' },
  { kind: 'exit-cost-moved', key: '8453:0xb', symbol: 'DEGEN', fromPct: 1.1, toPct: 3.4, sentence: 'Leaving $DEGEN now costs 3.4% of the position, up from 1.1%.' },
  { kind: 'position-new', key: '1:0xc', symbol: 'NVDA', pct: 8, sentence: '$NVDA is new since your last visit, at 8.0% of the book.' },
  { kind: 'position-gone', key: '1:0xd', symbol: 'OLD', wasPct: 6, sentence: '$OLD is no longer in the book. It was 6.0% of it.' },
]

describe('awayInsights — the briefing dressed as strip cards', () => {
  it('maps every kind, preserving the diff order (deltas arrive pre-ranked)', () => {
    const cards = awayInsights(deltas)
    expect(cards.map((c) => c.id)).toEqual([
      'away:total',
      'away:share:8453:0xa',
      'away:exit:8453:0xb',
      'away:new:1:0xc',
      'away:gone:1:0xd',
    ])
    // order must survive any magnitude re-sort a caller might apply
    const sorted = [...cards].sort((a, b) => b.magnitude - a.magnitude)
    expect(sorted.map((c) => c.id)).toEqual(cards.map((c) => c.id))
  })

  it('the sentence is the headline, verbatim — the UI adds no wording', () => {
    for (const [i, c] of awayInsights(deltas).entries()) expect(c.headline).toBe(deltas[i].sentence)
  })

  it('form heuristic: moves take the move mark, arrivals their share, the rest draw nothing', () => {
    const [total, share, exit, arrived, gone] = awayInsights(deltas)
    expect(total.mark).toEqual({ form: 'none' })
    expect(share.mark).toEqual({ form: 'move', fromPct: 9, toPct: 21 })
    expect(exit.mark).toEqual({ form: 'move', fromPct: 1.1, toPct: 3.4 })
    expect(arrived.mark).toEqual({ form: 'share', pct: 8 })
    expect(gone.mark).toEqual({ form: 'none' })
  })

  it('every card is kind away with a stat the card can lead with', () => {
    for (const c of awayInsights(deltas)) {
      expect(c.kind).toBe('away')
      expect(c.stat.length).toBeGreaterThan(0)
      expect(c.subject.length).toBeGreaterThan(0)
    }
  })

  it('a signed total stat says its direction', () => {
    const [total] = awayInsights(deltas)
    expect(total.stat).toBe('−3.2%')
    const [up] = awayInsights([{ ...deltas[0], pct: 2.5 } as AwayDelta])
    expect(up.stat).toBe('+2.5%')
  })

  it('empty deltas produce an empty strip lead — silence stays valid', () => {
    expect(awayInsights([])).toEqual([])
  })
})
