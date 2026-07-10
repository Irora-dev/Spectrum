import { useMemo, useRef, useState } from 'react'
import { suggestTags, suggestTagsForAssets, tagAllowed } from '../lib/spectrum/tags'

// ─────────────────────────────────────────────────────────────────────────────
// The tag input (R+C 2026-07-06): chips + closest-match autocomplete over the
// site's tag vocabulary, custom tags allowed (banned ones refused quietly with
// a reason), plus one row of suggestions derived from the basket's ASSETS.
// Used at the launch NAME step and in the signing ceremony — both feed the
// signed v4 `sectors[]`.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_TAGS = 8
const MAX_TAG_LEN = 24 // the signed struct's per-sector cap

export function TagInput({
  value,
  onChange,
  assetSymbols = [],
  disabled = false,
  placeholder = 'ai agents, defi, memes…',
}: {
  value: string[]
  onChange: (tags: string[]) => void
  /** Selected basket assets — drives the suggested-tags row. */
  assetSymbols?: string[]
  disabled?: boolean
  placeholder?: string
}) {
  const [draft, setDraft] = useState('')
  const [blocked, setBlocked] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const completions = useMemo(() => suggestTags(draft, 6, value), [draft, value])
  const assetSuggestions = useMemo(
    () => suggestTagsForAssets(assetSymbols).filter((t) => !value.some((v) => v.toLowerCase() === t.toLowerCase())),
    [assetSymbols, value],
  )

  const add = (raw: string) => {
    const tag = raw.trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_LEN)
    if (!tag || value.length >= MAX_TAGS) return
    if (value.some((v) => v.toLowerCase() === tag.toLowerCase())) {
      setDraft('')
      return
    }
    if (!tagAllowed(tag)) {
      setBlocked(true)
      window.setTimeout(() => setBlocked(false), 2200)
      return
    }
    onChange([...value, tag])
    setDraft('')
    setBlocked(false)
  }
  const remove = (tag: string) => onChange(value.filter((v) => v !== tag))

  return (
    <div>
      <div
        className={`flex flex-wrap items-center gap-1.5 rounded-xl border bg-black/40 px-3 py-2.5 transition-colors focus-within:border-cyan/60 ${
          blocked ? 'border-magenta/60' : 'border-white/12'
        }`}
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((tag) => (
          <span key={tag} className="inline-flex items-center gap-1.5 rounded-full border border-cyan/30 bg-cyan/10 py-0.5 pl-2.5 pr-1.5 font-mono text-[11px] text-cyan">
            #{tag.toLowerCase().replace(/\s+/g, '')}
            <button
              type="button"
              onClick={() => remove(tag)}
              disabled={disabled}
              aria-label={`Remove ${tag}`}
              className="press grid h-4 w-4 place-items-center rounded-full text-cyan/70 hover:bg-cyan/20 hover:text-cyan"
            >
              ✕
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            setBlocked(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              add(completions[0] && draft.trim() && completions[0].toLowerCase().startsWith(draft.trim().toLowerCase()) ? completions[0] : draft)
            }
            if (e.key === 'Backspace' && !draft && value.length) remove(value[value.length - 1])
          }}
          disabled={disabled || value.length >= MAX_TAGS}
          placeholder={value.length ? '' : placeholder}
          spellCheck={false}
          className="min-w-[8rem] flex-1 bg-transparent py-0.5 text-sm text-ink outline-none placeholder:text-ink-dim"
        />
      </div>

      {blocked && <p className="mt-1.5 font-mono text-[10px] text-magenta">That tag is on the site&rsquo;s ban list.</p>}

      {/* closest matches while typing */}
      {completions.length > 0 && draft.trim() && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {completions.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => add(t)}
              className="press rounded-full border border-white/12 px-2.5 py-1 font-mono text-[11px] text-ink-dim transition-colors hover:border-cyan/50 hover:text-cyan"
            >
              #{t.toLowerCase().replace(/\s+/g, '')}
            </button>
          ))}
        </div>
      )}

      {/* suggested from the basket's assets */}
      {!draft.trim() && assetSuggestions.length > 0 && value.length < MAX_TAGS && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">From your assets</span>
          {assetSuggestions.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => add(t)}
              className="press rounded-full border border-white/12 px-2.5 py-1 font-mono text-[11px] text-ink-dim transition-colors hover:border-cyan/50 hover:text-cyan"
            >
              + #{t.toLowerCase().replace(/\s+/g, '')}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
