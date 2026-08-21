// Specter's voice box: six tiny ElevenLabs-rendered cues (owner-initiated
// batch, 2026-08-19) the chat fires on events. OFF by default — sound starts
// only from the user's own click on the speaker toggle (which is also what
// satisfies the browser's autoplay gesture rule), and the choice persists.
import helloUrl from '../../assets/mascot/sfx/specter.hello.mp3'
import sendUrl from '../../assets/mascot/sfx/specter.send.mp3'
import replyUrl from '../../assets/mascot/sfx/specter.reply.mp3'
import happyUrl from '../../assets/mascot/sfx/specter.happy.mp3'
import thinkUrl from '../../assets/mascot/sfx/specter.think.mp3'
import oopsUrl from '../../assets/mascot/sfx/specter.oops.mp3'
import boopUrl from '../../assets/mascot/sfx/specter.boop.mp3'
import introPopUrl from '../../assets/mascot/sfx/specter.intro-pop.mp3'

export type SfxName = 'hello' | 'send' | 'reply' | 'happy' | 'think' | 'oops' | 'boop' | 'intro-pop'

const URLS: Record<SfxName, string> = {
  hello: helloUrl,
  send: sendUrl,
  reply: replyUrl,
  happy: happyUrl,
  think: thinkUrl,
  oops: oopsUrl,
  boop: boopUrl,
  'intro-pop': introPopUrl,
}

const KEY = 'specter-sfx'
let enabled: boolean | null = null

export function sfxEnabled(): boolean {
  if (enabled == null) {
    try {
      enabled = localStorage.getItem(KEY) === 'on'
    } catch {
      enabled = false
    }
  }
  return enabled
}

export function setSfxEnabled(on: boolean): void {
  enabled = on
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off')
  } catch {
    // storage refused (private mode) — the session still keeps the in-memory choice
  }
}

const cache = new Map<SfxName, HTMLAudioElement>()

/** Fire one cue. Silent unless the user turned sound on; a blocked or failed
 *  play never throws into the caller — a sound is garnish, never load-bearing. */
export function playSfx(name: SfxName, volume = 0.32): void {
  if (!sfxEnabled()) return
  try {
    let a = cache.get(name)
    if (!a) {
      a = new Audio(URLS[name])
      a.preload = 'auto'
      cache.set(name, a)
    }
    a.volume = volume
    a.currentTime = 0
    void a.play().catch(() => {})
  } catch {
    // no Audio in this environment — fine
  }
}

/** Warm the cache once sound is on, so the first cue has no fetch lag. */
export function preloadSfx(): void {
  for (const name of Object.keys(URLS) as SfxName[]) {
    if (!cache.has(name)) {
      const a = new Audio(URLS[name])
      a.preload = 'auto'
      cache.set(name, a)
    }
  }
}
