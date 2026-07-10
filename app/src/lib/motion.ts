import { useEffect, useRef, useState, type RefObject } from 'react'

// Respects the OS "reduce motion" setting — animations fall back to instant.
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const on = () => setReduced(mq.matches)
    on()
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  return reduced
}

// Fires once when the element first scrolls into view (then stops observing).
// Used to gate entrance reveals + count-ups so they only play on first sight.
export function useInViewOnce<T extends Element>(
  ref: RefObject<T | null>,
  rootMargin = '0px 0px -8% 0px',
): boolean {
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true)
          io.disconnect()
        }
      },
      { rootMargin },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [ref, seen, rootMargin])
  return seen
}

// Eases a number from 0 → target over `duration` once `run` is true. Animates
// only the first time; later target changes (e.g. a price refetch) snap through
// without replaying. rAF-based, so it idles in background tabs and resolves to
// the exact target when complete.
export function useCountUp(target: number, run: boolean, duration = 850): number {
  const reduced = usePrefersReducedMotion()
  const [val, setVal] = useState(0)
  const done = useRef(false)
  useEffect(() => {
    if (!run) return
    if (reduced || done.current) {
      setVal(target)
      done.current = true
      return
    }
    const start = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3) // easeOutCubic
      setVal(target * eased)
      if (t < 1) raf = requestAnimationFrame(tick)
      else done.current = true
    }
    raf = requestAnimationFrame(tick)
    // Safety net: rAF is paused in backgrounded/throttled tabs, so guarantee the
    // value still lands on target (snaps instead of animating in that case).
    const fallback = window.setTimeout(() => {
      setVal(target)
      done.current = true
    }, duration + 250)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(fallback)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, target, reduced])
  return done.current ? target : val
}
