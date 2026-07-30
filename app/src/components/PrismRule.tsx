import { useEffect, useRef, useState } from 'react'

// The prism wipe (owner 2026-07-29): section boundaries draw themselves in as
// a thin spectral hairline when scrolled into view — the brand's light
// language instead of dead gaps. IntersectionObserver + a CSS transition;
// nothing runs after the draw completes. Respects reduced motion (renders
// already-drawn).
export function PrismRule({ className = '' }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [drawn, setDrawn] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    if (drawn || !ref.current) return
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setDrawn(true)
          io.disconnect()
        }
      },
      { rootMargin: '0px 0px -12% 0px' },
    )
    io.observe(ref.current)
    return () => io.disconnect()
  }, [drawn])
  return (
    <div ref={ref} aria-hidden className={`flex justify-center ${className}`}>
      <div
        className="h-px rounded-full transition-[width,opacity] duration-1000 ease-out"
        style={{
          width: drawn ? '100%' : '0%',
          opacity: drawn ? 1 : 0,
          maxWidth: '36rem',
          background:
            'linear-gradient(90deg, transparent, var(--color-cyan) 20%, var(--color-violet-bright) 50%, var(--color-magenta) 80%, transparent)',
        }}
      />
    </div>
  )
}
