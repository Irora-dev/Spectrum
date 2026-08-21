// The streamlined chat inside the site-wide Specter widget (owner 2026-08-20:
// "full capabilities of the chat system, just not the right hand column").
// Everything conversational is the SAME machinery the /chat page runs —
// useChatSession + the page's own MessageList/SuggestionRail — so the two
// surfaces cannot drift. This file owns only the popover chrome.
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { ChatMascot, type MascotHandle } from './ChatMascot'
import { playSfx, preloadSfx, setSfxEnabled, sfxEnabled } from './sfx'
import { useChatSession, useStickyScroll } from './useChatSession'
import { DraftPill, MessageList, SuggestionRail } from '../../pages/Chat'

const GRADIENT = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

export default function WidgetChat({ onClose, active = true }: { onClose: () => void; active?: boolean }) {
  const mascot = useRef<MascotHandle>(null)
  const [sfx, setSfx] = useState(sfxEnabled)
  const { msgs, input, setInput, busy, chips, draftLabel, confirmClear, recallLast, send, newChat, noteDeployed, inputHint } = useChatSession({ mascot })
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const { jump, toBottom } = useStickyScroll(scrollRef, msgs)
  // opening the popover puts the caret straight in the input (QoL): no second
  // click before typing. The component stays mounted while hidden, so focus
  // rides the visibility transition, not the mount.
  useEffect(() => {
    if (active) {
      // display:none zeroes layout, so a REOPEN comes back at scrollTop 0 —
      // land on the latest message instantly, then focus
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
      const t = setTimeout(() => inputRef.current?.focus(), 260) // after the pop-in
      return () => clearTimeout(t)
    }
  }, [active])

  return (
    <div
      className="widget-pop flex h-full min-h-0 flex-col overflow-hidden rounded-[24px] border border-white/[0.12] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.07),0_24px_64px_rgba(0,0,0,0.4)]"
      style={{ background: 'linear-gradient(rgba(255,255,255,0.05), rgba(255,255,255,0.05)), var(--color-panel)' }}
    >
      <div aria-hidden className="h-px w-full shrink-0 opacity-70" style={{ background: GRADIENT }} />

      {/* header: who this is + the doors (expand · new · sound · close) */}
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-white/[0.08] px-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="relative shrink-0">
            <div className="rounded-full p-[1.5px]" style={{ background: GRADIENT }}>
              <div className="grid h-9 w-9 place-items-center overflow-hidden rounded-full bg-void">
                <ChatMascot ref={mascot} entrance={false} size={27} />
              </div>
            </div>
            <span aria-hidden className="chat-dot absolute bottom-0 right-0 h-2 w-2 rounded-full border-2 border-void" style={{ background: 'var(--color-teal)' }} />
          </div>
          <div className="min-w-0">
            <p className="font-display text-[13px] font-bold uppercase tracking-[0.08em] leading-tight text-ink">Agent Specter</p>
            <p className="truncate text-[11px] leading-tight text-ink-dim">Boo-lish on baskets</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Link
            to="/chat"
            title="Open the full chat"
            aria-label="Open the full chat page"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-full border border-white/[0.16] text-ink-faint transition-colors hover:border-white/[0.3] hover:text-ink-dim"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6" />
              <path d="M10 14 21 3" />
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            </svg>
          </Link>
          <button
            type="button"
            onClick={newChat}
            title={confirmClear ? 'Tap again: this clears your draft' : 'New chat'}
            aria-label={confirmClear ? 'Tap again to confirm clearing the draft' : 'Start a new chat'}
            className={`grid h-7 w-7 place-items-center rounded-full border transition-colors ${confirmClear ? 'border-[color:var(--color-amber)] text-ink' : 'border-white/[0.16] text-ink-faint hover:border-white/[0.3] hover:text-ink-dim'}`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => {
              const on = !sfx
              setSfx(on)
              setSfxEnabled(on)
              if (on) {
                preloadSfx()
                playSfx('hello')
                mascot.current?.wave()
              }
            }}
            title={sfx ? 'Sound on' : 'Sound off'}
            aria-pressed={sfx}
            aria-label={sfx ? 'Turn Specter sounds off' : 'Turn Specter sounds on'}
            className={`grid h-7 w-7 place-items-center rounded-full border transition-colors ${sfx ? 'border-white/[0.28] text-ink' : 'border-white/[0.16] text-ink-faint hover:border-white/[0.3] hover:text-ink-dim'}`}
          >
            {sfx ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 5 6 9H2v6h4l5 4V5Z" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 5 6 9H2v6h4l5 4V5Z" />
                <line x1="22" x2="16" y1="9" y2="15" />
                <line x1="16" x2="22" y1="9" y2="15" />
              </svg>
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            aria-label="Close the chat"
            className="grid h-7 w-7 place-items-center rounded-full border border-white/[0.16] text-ink-faint transition-colors hover:border-white/[0.3] hover:text-ink"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* messages — the page's own thread component, byte for byte. THE
          THREAD NEVER SCROLLS SIDEWAYS (owner 2026-08-20): cards resize to
          the popover (--chat-card-min zeroes their page min-widths) and
          overflow-x-hidden is the hard stop; rails (baskets, candidates)
          keep their OWN horizontal scroll inside ChatRail. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} aria-live="polite" className="chat-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden px-3.5 py-4 [--chat-card-min:0px]">
          <MessageList msgs={msgs} onPick={(line) => void send(line)} onDeployed={noteDeployed} />
        </div>
        {/* reading history? a new reply raises this instead of yanking */}
        {jump && (
          <button
            type="button"
            onClick={toBottom}
            className="chat-msg absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-white/[0.16] px-3.5 py-1.5 font-display text-[11px] font-bold uppercase tracking-[0.1em] text-ink shadow-[0_8px_24px_rgba(0,0,0,0.3)] backdrop-blur-md"
            style={{ background: 'color-mix(in srgb, var(--color-panel) 88%, transparent)' }}
          >
            New reply ↓
          </button>
        )}
      </div>

      {/* suggestions */}
      <div className="shrink-0 px-3.5 pb-2.5">
        <SuggestionRail chips={chips} onPick={(line) => void send(line)} />
      </div>

      {/* input */}
      <div className="shrink-0 border-t border-white/[0.08] bg-black/[0.12] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {draftLabel && (
          <div className="mb-2 flex px-1">
            <DraftPill label={draftLabel} onPick={(line) => void send(line)} />
          </div>
        )}
        {inputHint && <p className="mb-1.5 px-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">{inputHint}</p>}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void send()
          }}
          className="flex items-center gap-1.5 rounded-full border border-white/[0.14] bg-white/[0.05] p-1.5 transition-[border-color,background-color,box-shadow] duration-300 focus-within:border-white/[0.28] focus-within:bg-white/[0.08] focus-within:shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-violet-bright)_55%,transparent),0_0_28px_-8px_var(--color-violet-bright)]"
        >
          <input
            ref={inputRef}
            type="text"
            maxLength={400}
            value={input}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp' && !input.trim()) {
                const last = recallLast()
                if (last) {
                  e.preventDefault()
                  setInput(last)
                }
              }
            }}
            onChange={(e) => {
              setInput(e.target.value)
              mascot.current?.setTyping(true)
            }}
            onFocus={() => mascot.current?.setTyping(true)}
            onBlur={() => mascot.current?.setTyping(false)}
            placeholder="Buy SVI · create a basket of…"
            aria-label="Message Agent Specter"
            className="min-w-0 flex-1 bg-transparent px-3 text-sm text-ink outline-none placeholder:text-ink-faint"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            aria-label="Send"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-void transition-transform enabled:hover:scale-105 disabled:opacity-40"
            style={{ background: GRADIENT, boxShadow: '0 0 16px -4px color-mix(in srgb, var(--color-magenta) 65%, transparent)' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="ml-0.5">
              <path d="m22 2-7 20-4-9-9-4Z" />
              <path d="M22 2 11 13" />
            </svg>
          </button>
        </form>
        <p className="mt-1.5 px-2 text-center text-[10px] leading-relaxed text-ink-faint">Non-custodial: every action signs in your own wallet.</p>
      </div>
    </div>
  )
}
