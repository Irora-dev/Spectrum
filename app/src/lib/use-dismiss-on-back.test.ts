import { beforeEach, describe, expect, it } from 'vitest'
import { isMarkerCurrent, isSelfPop, markerState, nextMarkerId, noteSelfBack } from './use-dismiss-on-back'

// The hook's DOM half (pushState, the popstate order, StrictMode's double mount)
// is NOT covered here: this repo runs vitest in a plain node env with no jsdom
// (see vitest.config.ts), and faking a history stack would only test the fake.
// What is covered is where every decision actually lives — the pure predicates
// the hook consults before it closes an overlay or rewinds an entry.

describe('overlay history marker', () => {
  it('stamps the overlay id without dropping the router’s own state', () => {
    // react-router works out how far a pop travelled from idx/key, so its state
    // has to survive our push.
    const routerState = { usr: null, key: 'ab12cd', idx: 4 }
    expect(markerState(routerState, 'x1-1')).toEqual({ usr: null, key: 'ab12cd', idx: 4, spectrumOverlay: 'x1-1' })
  })

  it('tolerates an entry that carries no usable state', () => {
    expect(markerState(null, 'x1-1')).toEqual({ spectrumOverlay: 'x1-1' })
    expect(markerState(undefined, 'x1-1')).toEqual({ spectrumOverlay: 'x1-1' })
    expect(markerState('not an object', 'x1-1')).toEqual({ spectrumOverlay: 'x1-1' })
  })

  it('recognises its own entry and nothing else', () => {
    const mine = markerState({ idx: 2 }, 'x1-1')
    expect(isMarkerCurrent(mine, 'x1-1')).toBe(true)
    expect(isMarkerCurrent(mine, 'x1-2')).toBe(false)
    expect(isMarkerCurrent({ idx: 2 }, 'x1-1')).toBe(false)
    expect(isMarkerCurrent(null, 'x1-1')).toBe(false)
    expect(isMarkerCurrent(undefined, 'x1-1')).toBe(false)
    expect(isMarkerCurrent('x1-1', 'x1-1')).toBe(false)
  })

  it('stacked overlays: the pop closes the inner one and leaves the outer open', () => {
    // Back from [outer, inner] lands on the outer overlay's own entry.
    const outer = 'x1-1'
    const inner = 'x1-2'
    const landedOn = markerState({ idx: 7 }, outer)
    expect(isMarkerCurrent(landedOn, inner)).toBe(false) // inner: my entry is gone, close
    expect(isMarkerCurrent(landedOn, outer)).toBe(true) // outer: still standing on mine, stay
  })

  it('a link inside the overlay wins: after a router push there is nothing of ours to rewind', () => {
    // The router pushes fresh state, so our marker is no longer current and the
    // cleanup must not call back() — that would undo the navigation.
    const afterRouterPush = { usr: null, key: 'zz99', idx: 8 }
    expect(isMarkerCurrent(afterRouterPush, 'x1-1')).toBe(false)
  })

  it('gives every overlay its own id, namespaced to this page load', () => {
    const a = nextMarkerId()
    const b = nextMarkerId()
    expect(a).not.toBe(b)
    // Not a bare counter: history state outlives a reload, and a restored entry
    // stamped "1" must not look like this page load's first overlay.
    expect(a).not.toBe('1')
    expect(a.split('-')[0]).toBe(b.split('-')[0])
    expect(a.split('-')[0]).not.toBe('')
  })
})

describe('self-inflicted popstate guard', () => {
  // 0 is the module's "nothing pending" sentinel, so this is the reset.
  beforeEach(() => noteSelfBack(0))

  it('treats a pop as a real gesture when we called no back()', () => {
    expect(isSelfPop(1000)).toBe(false)
  })

  it('swallows the pop from our own back(), exactly once', () => {
    noteSelfBack(1000)
    expect(isSelfPop(1004)).toBe(true)
    expect(isSelfPop(1008)).toBe(false)
  })

  it('cannot stay armed: a pop that never arrived will not swallow a later gesture', () => {
    noteSelfBack(1000)
    expect(isSelfPop(9000)).toBe(false) // far outside the window, and it disarms
    noteSelfBack(9000)
    expect(isSelfPop(9001)).toBe(true) // the guard still works afterwards
  })
})
