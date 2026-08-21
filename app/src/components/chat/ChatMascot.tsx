// The chat mascot, generation 3: the Ludo 18-state flipbook set (2x-upscaled
// source, re-encoded as animated WebPs with true frame replacement). This
// component decides WHICH state lives; the files carry their own timing.
//
// New in v3 (desk item w-141, 2026-08-19): thinking (the answering base),
// twirl (the entrance's third act), confused (refusals), party (creations),
// thumbsup (copies), cool/juggle/lightbulb (rare idle variety), sleeping
// (long-idle nap, any interaction wakes), exit (the overlay's dissolve), and
// BOOP: click the ghost, it squashes and giggles. The live-eyes rig stays
// parked by the owner's call: DOM eyes swim against the bob and it reads badly.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import animIntro from '../../assets/mascot/anim-intro.webp'
import animExit from '../../assets/mascot/anim-exit.webp'
import animIdle from '../../assets/mascot/anim-idle-breathe.webp'
import animBlink from '../../assets/mascot/anim-blink.webp'
import animSway from '../../assets/mascot/anim-sway.webp'
import animTyping from '../../assets/mascot/anim-typing.webp'
import animRainbow from '../../assets/mascot/anim-rainbow.webp'
import animWave from '../../assets/mascot/anim-wave.webp'
import animHappy from '../../assets/mascot/anim-happy.webp'
import animThinking from '../../assets/mascot/anim-thinking.webp'
import animConfused from '../../assets/mascot/anim-confused.webp'
import animParty from '../../assets/mascot/anim-party.webp'
import animTwirl from '../../assets/mascot/anim-twirl.webp'
import animCool from '../../assets/mascot/anim-cool.webp'
import animJuggle from '../../assets/mascot/anim-juggle.webp'
import animLightbulb from '../../assets/mascot/anim-lightbulb.webp'
import animSleeping from '../../assets/mascot/anim-sleeping.webp'
import animThumbsup from '../../assets/mascot/anim-thumbsup.webp'
import stillIdle from '../../assets/mascot/f9.png'
import { playSfx } from './sfx'

type MascotState =
  | 'intro'
  | 'exit'
  | 'idle'
  | 'blink'
  | 'sway'
  | 'typing'
  | 'rainbow'
  | 'wave'
  | 'happy'
  | 'thinking'
  | 'confused'
  | 'party'
  | 'twirl'
  | 'cool'
  | 'juggle'
  | 'lightbulb'
  | 'sleeping'
  | 'thumbsup'

export const MASCOT_ANIM: Record<MascotState, string> = {
  intro: animIntro,
  exit: animExit,
  idle: animIdle,
  blink: animBlink,
  sway: animSway,
  typing: animTyping,
  rainbow: animRainbow,
  wave: animWave,
  happy: animHappy,
  thinking: animThinking,
  confused: animConfused,
  party: animParty,
  twirl: animTwirl,
  cool: animCool,
  juggle: animJuggle,
  lightbulb: animLightbulb,
  sleeping: animSleeping,
  thumbsup: animThumbsup,
}

/** One-shot durations (ms): how long each owns the sprite before base resumes. */
const ONE_SHOT_MS: Partial<Record<MascotState, number>> = {
  intro: 2000,
  exit: 2000,
  blink: 1333, // 12fps
  sway: 2000,
  wave: 2100,
  happy: 2100,
  confused: 2000,
  party: 2400,
  twirl: 2000,
  cool: 2400,
  juggle: 2400,
  lightbulb: 2000,
  thumbsup: 2000,
  thinking: 2400,
  typing: 2400,
  sleeping: 2400,
  rainbow: 2600,
}

// the idle SHOWCASE (owner 2026-08-19 21:2x: "put all of these into the
// animation rotation… all go back to idle") — every state takes a turn while
// the ghost rests bottom-right; each plays once and idle resumes
const ROTATION: MascotState[] = ['juggle', 'cool', 'lightbulb', 'rainbow', 'wave', 'juggle', 'happy', 'party', 'thinking', 'sleeping', 'twirl', 'juggle', 'thumbsup', 'confused', 'intro', 'sway']
const NAP_AFTER_MS = 100_000 // ~100s of stillness → the ghost naps

export interface MascotHandle {
  wave: () => void
  happy: () => void
  /** BIG celebration (a creation) — the party hat comes out. */
  party: () => void
  /** A refusal/error turn — dizzy confusion, then back to base. */
  confused: () => void
  /** A copy/small-win acknowledgment. */
  thumbsup: () => void
  /** The agent FOUND something (a live read landed) — the eureka bulb. A
   *  flourish, not a semantic cue: it yields when the sprite is busy/resting,
   *  so back-to-back data turns don't strobe the same face. */
  lightbulb: () => void
  setTyping: (on: boolean) => void
  /** The agent is answering — the thinking pose while true. */
  setTalking: (on: boolean) => void
}

export const ChatMascot = forwardRef<MascotHandle, { size?: number; className?: string; entrance?: boolean; interactive?: boolean }>(function ChatMascot(
  { size = 176, className = '', entrance = true, interactive = true },
  ref,
) {
  const reduced =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  // a fresh <img> per activation, so every state starts at frame 0
  const [view, setView] = useState<{ state: MascotState; playId: number }>({ state: entrance ? 'intro' : 'idle', playId: 0 })
  const [squash, setSquash] = useState(false)
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  const busyUntil = useRef(0)
  // one-shots never chain: a rest window of breathing follows every one
  const restUntil = useRef(0)
  const lastTouch = useRef(Date.now()) // anything the user does resets the nap clock
  const napping = useRef(false)
  const typing = useRef(false)
  const talking = useRef(false)
  const introDone = useRef(false)

  useEffect(() => {
    const all = timers.current
    return () => {
      for (const t of all) clearTimeout(t)
      all.clear()
    }
  }, [])

  const at = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.current.delete(t)
      fn()
    }, ms)
    timers.current.add(t)
  }

  const base = (): MascotState =>
    talking.current ? 'thinking' : typing.current ? 'typing' : napping.current ? 'sleeping' : 'idle'
  const free = () => Date.now() >= busyUntil.current
  const rested = () => Date.now() >= restUntil.current

  const show = (state: MascotState) => setView((v) => ({ state, playId: v.playId + 1 }))

  const wake = () => {
    lastTouch.current = Date.now()
    if (napping.current) {
      napping.current = false
      if (free()) play('blink') // waking rubs its eyes
    }
  }

  const play = (state: MascotState) => {
    if (reduced) return
    const ms = ONE_SHOT_MS[state] ?? 2000
    busyUntil.current = Date.now() + ms
    restUntil.current = Date.now() + ms + 2600
    show(state)
    at(ms, () => show(base()))
  }

  // the entrance (panel-local; the page overlay owns the cinematic one)
  useEffect(() => {
    if (reduced || introDone.current || !entrance) return
    introDone.current = true
    busyUntil.current = Date.now() + (ONE_SHOT_MS.intro ?? 2000)
    restUntil.current = Date.now() + (ONE_SHOT_MS.intro ?? 2000) + 2600
    at(ONE_SHOT_MS.intro ?? 2000, () => show(base()))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced])

  // life while idle: blinks often, a sway sometimes, a RARE flourish
  // occasionally; a long stillness naps. Nothing fires over typing/answering.
  useEffect(() => {
    if (reduced) return
    let alive = true
    const idleFree = () => alive && free() && rested() && !typing.current && !talking.current
    const blinkLoop = () => {
      if (!alive) return
      at(4500 + Math.random() * 3500, () => {
        if (idleFree() && !napping.current) play('blink')
        blinkLoop()
      })
    }
    let rotIdx = Math.floor(Math.random() * ROTATION.length)
    const swayLoop = () => {
      if (!alive) return
      at(9000 + Math.random() * 5000, () => {
        if (idleFree() && !napping.current) {
          play(ROTATION[rotIdx % ROTATION.length]) // the full showcase, in a shuffled-start cycle
          rotIdx++
        }
        swayLoop()
      })
    }
    const napLoop = () => {
      if (!alive) return
      at(5000, () => {
        if (idleFree() && !napping.current && Date.now() - lastTouch.current > NAP_AFTER_MS) {
          napping.current = true
          show('sleeping')
        }
        napLoop()
      })
    }
    blinkLoop()
    swayLoop()
    napLoop()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced])

  useImperativeHandle(ref, () => ({
    wave: () => {
      wake()
      play('wave')
    },
    happy: () => {
      wake()
      play('happy')
    },
    party: () => {
      wake()
      play('party')
    },
    confused: () => {
      wake()
      play('confused')
    },
    thumbsup: () => {
      wake()
      play('thumbsup')
    },
    lightbulb: () => {
      wake()
      if (free() && rested()) play('lightbulb')
    },
    setTyping: (on: boolean) => {
      wake()
      if (typing.current === on) return
      typing.current = on
      if (!reduced && free()) show(base())
    },
    setTalking: (on: boolean) => {
      wake()
      if (talking.current === on) return
      talking.current = on
      if (!reduced && free()) show(base())
    },
  }))

  // THE BOOP: click the ghost — squash, giggle, a happy beat
  const boop = () => {
    wake()
    if (reduced) return
    playSfx('boop', 0.4)
    setSquash(true)
    at(180, () => setSquash(false))
    if (free()) play('happy')
  }

  if (reduced) {
    return <img src={stillIdle} alt="" aria-hidden draggable={false} width={size} height={size} className={`select-none ${className}`} />
  }
  const sprite = (
    <img
      key={`${view.state}-${view.playId}`}
      src={MASCOT_ANIM[view.state]}
      alt=""
      aria-hidden
      draggable={false}
      width={size}
      height={size}
      className={`select-none ${className}`}
    />
  )
  // interactive=false hosts (the site-wide FAB, itself a button — nesting
  // buttons is invalid DOM) get the living sprite without the boop
  if (!interactive) return <span aria-hidden>{sprite}</span>
  return (
    <button
      type="button"
      onClick={boop}
      aria-label="Boop Specter"
      className="cursor-pointer border-0 bg-transparent p-0 transition-transform duration-150 ease-out"
      style={{ transform: squash ? 'scale(1.08, 0.88)' : undefined }}
    >
      {sprite}
    </button>
  )
})

/** Warm every state so the first switch never flashes an empty frame. */
export function preloadMascot(): void {
  for (const src of Object.values(MASCOT_ANIM)) {
    const img = new Image()
    img.src = src
  }
}
