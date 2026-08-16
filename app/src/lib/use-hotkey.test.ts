import { describe, expect, it } from 'vitest'
import { isTypingTarget, shouldFireHotkey } from './use-hotkey'

const ev = (over: Record<string, unknown> = {}) =>
  ({ key: 'k', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null, ...over }) as never

const MOD = { key: 'k', mod: true }
const SLASH = { key: '/' }

describe('the search shortcut fires only when a keystroke is a COMMAND', () => {
  it('mod+K fires on the platform key, and only that one', () => {
    expect(shouldFireHotkey(ev({ metaKey: true }), MOD, true)).toBe(true)
    expect(shouldFireHotkey(ev({ ctrlKey: true }), MOD, true)).toBe(false)
    expect(shouldFireHotkey(ev({ ctrlKey: true }), MOD, false)).toBe(true)
    expect(shouldFireHotkey(ev({ metaKey: true }), MOD, false)).toBe(false)
  })

  it('leaves the browser its own combinations alone', () => {
    expect(shouldFireHotkey(ev({ metaKey: true, shiftKey: true }), MOD, true)).toBe(false)
    expect(shouldFireHotkey(ev({ metaKey: true, altKey: true }), MOD, true)).toBe(false)
    // Control+/ on mac is not ours
    expect(shouldFireHotkey(ev({ key: '/', ctrlKey: true }), SLASH, true)).toBe(false)
  })

  it('NEVER steals a keystroke from a text field', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(shouldFireHotkey(ev({ key: '/', target: { tagName } }), SLASH, true)).toBe(false)
      expect(shouldFireHotkey(ev({ metaKey: true, target: { tagName } }), MOD, true)).toBe(false)
    }
    expect(
      shouldFireHotkey(ev({ key: '/', target: { tagName: 'DIV', isContentEditable: true } }), SLASH, true),
    ).toBe(false)
    // a plain div is not typing
    expect(shouldFireHotkey(ev({ key: '/', target: { tagName: 'DIV' } }), SLASH, true)).toBe(true)
  })

  it('a bare shortcut needs no modifiers at all', () => {
    expect(shouldFireHotkey(ev({ key: '/' }), SLASH, true)).toBe(true)
    expect(shouldFireHotkey(ev({ key: '/', metaKey: true }), SLASH, true)).toBe(false)
  })

  it('mid-word input from an IME is never a command', () => {
    expect(shouldFireHotkey(ev({ metaKey: true, isComposing: true }), MOD, true)).toBe(false)
  })

  it('the wrong key never fires, whatever the modifiers', () => {
    expect(shouldFireHotkey(ev({ key: 'j', metaKey: true }), MOD, true)).toBe(false)
    expect(shouldFireHotkey(ev({ key: 'K', metaKey: true }), MOD, true)).toBe(true) // case-insensitive
  })

  it('isTypingTarget survives junk targets', () => {
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget({} as never)).toBe(false)
  })
})
