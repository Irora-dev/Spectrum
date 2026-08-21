// THE SITE-WIDE SPECTER (owner 2026-08-20): a small circle bottom-right on
// every page except /chat, the mascot idling inside it; click pops the
// streamlined chat (WidgetChat — the full system minus the stage column).
// This file stays TINY and eager (the FAB must paint everywhere); the
// conversation chunk lazy-loads on first open and STAYS mounted after close,
// so the session survives open/close and even page navigation (the widget
// lives at the app root, outside the transformed route wrapper — fixed
// positioning would silently re-scope inside it).
import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router'
import { ChatMascot } from './ChatMascot'
import { SpectrumLoader } from '../SpectrumLoader'

const WidgetChat = lazy(() => import('./WidgetChat'))

const GRADIENT = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

export function SpecterWidget() {
  const { pathname } = useLocation()
  const [open, setOpen] = useState(false)
  const openedOnce = useRef(false)
  if (open) openedOnce.current = true
  // a reply landing while the popover is closed marks the circle unread —
  // the session stays mounted behind a closed popover, so a slow turn or a
  // trade narration can land unseen (QoL 2026-08-20)
  const [unread, setUnread] = useState(false)
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    const onReply = () => {
      if (!openRef.current) setUnread(true)
    }
    window.addEventListener('specter:reply-landed', onReply)
    return () => window.removeEventListener('specter:reply-landed', onReply)
  }, [])
  useEffect(() => {
    if (open) setUnread(false)
  }, [open])

  // Esc closes — the fastest door out
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // the chat page owns the full experience — the widget stands down there
  // (and in embeds); navigating to /chat mid-conversation just continues it,
  // same session key
  useEffect(() => {
    if (pathname.startsWith('/chat')) setOpen(false)
  }, [pathname])
  // the homepage and /creators embed the FULL chat now — a second mounted
  // session would diverge from it (each hook instance owns its own state)
  if (pathname === '/' || pathname.startsWith('/chat') || pathname.startsWith('/embed') || pathname.startsWith('/creators')) return null

  return (
    <>
      {/* the popover (mounted once opened, hidden on close so the session,
          timers and any in-flight turn survive) */}
      {openedOnce.current && (
        <div
          className="fixed bottom-[4.75rem] right-4 z-[55] h-[min(640px,calc(100dvh-10rem))] w-[min(400px,calc(100vw-2rem))] lg:bottom-4 lg:h-[min(640px,calc(100dvh-5.5rem))]"
          style={{ display: open ? undefined : 'none', paddingBottom: 'env(safe-area-inset-bottom)' }}
          role="dialog"
          aria-label="Chat with Agent Specter"
        >
          <Suspense
            fallback={
              <div
                className="widget-pop grid h-full place-items-center rounded-[24px] border border-white/[0.12]"
                style={{ background: 'linear-gradient(rgba(255,255,255,0.05), rgba(255,255,255,0.05)), var(--color-panel)' }}
              >
                <SpectrumLoader size={32} label="waking Specter" />
              </div>
            }
          >
            <WidgetChat onClose={() => setOpen(false)} active={open} />
          </Suspense>
        </div>
      )}

      {/* the circle: Specter idling in the corner (its own idle loop IS the
          little animations — blinks, sways, the occasional flourish) */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Chat with Agent Specter"
          title="Chat with Specter"
          className="group fixed bottom-[4.75rem] right-4 z-[55] rounded-full p-[2px] shadow-[0_10px_32px_rgba(0,0,0,0.35)] transition-transform hover:scale-105 active:scale-95 lg:bottom-4"
          style={{ background: GRADIENT, marginBottom: 'env(safe-area-inset-bottom)' }}
        >
          <span className="relative grid h-14 w-14 place-items-center overflow-hidden rounded-full bg-void">
            <span className="pointer-events-none">
              <ChatMascot entrance={false} size={46} interactive={false} />
            </span>
          </span>
          <span aria-hidden className="chat-dot absolute bottom-1 right-1 h-2.5 w-2.5 rounded-full border-2 border-void" style={{ background: 'var(--color-teal)' }} />
          {/* unread: a reply landed while closed */}
          {unread && (
            <span className="absolute -right-0.5 -top-0.5 grid h-4 w-4 place-items-center rounded-full border-2 border-void" style={{ background: 'var(--color-magenta)' }}>
              <span className="sr-only">New reply waiting</span>
            </span>
          )}
        </button>
      )}
    </>
  )
}
