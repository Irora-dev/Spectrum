import { useEffect, useRef } from 'react'

// ─────────────────────────────────────────────────────────────────────────────
// USE-HOTKEY — one global key listener, registered once (QOL #18, 2026-08-05).
//
// The whole difficulty of a global shortcut is NOT firing it: a bare "/" that
// steals a keystroke from a text field is worse than no shortcut at all, and a
// site that swallows the browser's own combinations is worse still. So the
// decision is a pure function (`shouldFireHotkey`) that a test can walk, and the
// effect around it is deliberately dumb.
// ─────────────────────────────────────────────────────────────────────────────

export interface HotkeySpec {
  /** Lower-case key, e.g. 'k' or '/'. */
  key: string
  /** Require the platform's command key (Meta on mac, Control elsewhere). */
  mod?: boolean
}

/** Is the event target a place where a keystroke is TEXT rather than a command? */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el !== 'object' || !('tagName' in el)) return false
  const tag = String(el.tagName || '').toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  return el.isContentEditable === true
}

/**
 * Should this keydown fire the given shortcut?
 *
 * Rules, each one a real failure it prevents:
 *  · never while typing — a bare "/" must not eat a character;
 *  · a mod shortcut needs exactly its own modifier, so Command+Shift+K (a
 *    browser command) is left alone;
 *  · a bare shortcut needs NO modifiers at all, so Control+/ stays the
 *    browser's;
 *  · an IME composition is mid-word input, never a command.
 */
export function shouldFireHotkey(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> & {
    target?: EventTarget | null
    isComposing?: boolean
  },
  spec: HotkeySpec,
  mac: boolean,
): boolean {
  if (e.isComposing) return false
  if (String(e.key || '').toLowerCase() !== spec.key) return false
  if (isTypingTarget(e.target ?? null)) return false
  if (spec.mod) {
    const wanted = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
    return wanted && !e.altKey && !e.shiftKey
  }
  return !e.metaKey && !e.ctrlKey && !e.altKey
}

/** Register one document-level shortcut for the lifetime of the caller. */
export function useHotkey(specs: HotkeySpec[], onFire: () => void, mac: boolean): void {
  // The handler is held in a ref so a fresh closure each render never
  // re-registers the listener.
  const fire = useRef(onFire)
  fire.current = onFire
  const key = specs.map((s) => `${s.mod ? 'mod+' : ''}${s.key}`).join(',')
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const hit = specs.some((s) => shouldFireHotkey(e, s, mac))
      // preventDefault ONLY when actually handling it (a bare "/" is Firefox's
      // quick-find; Command+K is a browser command in some setups).
      if (!hit) return
      e.preventDefault()
      fire.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, mac])
}
