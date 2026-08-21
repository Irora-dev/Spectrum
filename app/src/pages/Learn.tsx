import { Children, isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { chainCfg, SUPPORTED_CHAIN_IDS } from '../lib/chain/chains'
import { WALLET_ENABLED } from '../lib/config/features'
import { useAllBaskets } from '../lib/spectrum/hooks'
import { Carousel } from '../components/Carousel'
import { Bezel, Eyebrow, IslandCta, LoopLadder, Reveal, SectionHead, SPECTRAL, SplitCta } from '../components/home/Spine'
import { CodeBlock } from '../components/DocKit'
import mcpManifest from '../generated/mcp-tools.json'
import learnArt from '../assets/bundle-hero.jpg'
import learnArt1280 from '../assets/bundle-hero.1280.jpg'

// The homepage hero's own mask, so the banner dissolves into the page the same way
// rather than ending on a hard edge. Sides taper into the animated light bands; the
// foot fades so the art never butts against the content below it.
const LANE = 'max(18px, min(13vw, 19.5vw - 66.5px, 50vw - 484px))'
const SIDE_TAPER = `linear-gradient(90deg, transparent 0, rgba(0,0,0,0.4) calc(${LANE} * 0.4), black calc(${LANE}), black calc(100% - ${LANE}), rgba(0,0,0,0.4) calc(100% - (${LANE} * 0.4)), transparent 100%)`
const FOOT_FADE = 'linear-gradient(180deg, black 0%, black 72%, transparent 100%)'
import { ConvictionCard } from '../components/home/Showcase'
import { basketHref } from '../lib/spectrum/short-url'

// ONE doc surface for a person (owner 2026-08-01: "so many pages, so many
// systems — it's very hard for the average person"). /learn and /faq were two
// pages answering the same question for the same reader, so the explainer and
// the Q&A now live here together and /faq redirects in. The INTEGRATOR
// reference (/docs) deliberately stays its own page: it is a different reader
// (indexers, price feeds) and folding an ABI manual into a beginner page would
// have made this surface worse, not simpler.

// ─────────────────────────────────────────────────────────────────────────────
// THE REFERENCE, MADE SCANNABLE (owner 2026-08-02: "condense information, less
// text more visuals, better search system and menu for the learn contents").
//
// Nothing is deleted. Every word still ships; it is the DEFAULT STATE that
// changed. The reference used to be six open prose sections plus a Q&A, which is
// a wall of text you must scroll past. It is now an INDEX you expand, which is
// the same progressive-disclosure idiom already used for detail behind the ⓘ and
// for the visitor/creator split in the More menu.
//
// The search is deliberately NON-INVASIVE: `Group` reads its children's own `q`
// props through React.Children rather than the content being restructured into a
// data table. That means a Q&A answer stays JSX with its links and its
// chain-derived sentences intact, and no answer could be lost in a migration —
// the risk of rewriting thirty answers to gain a filter was not worth taking.
// ─────────────────────────────────────────────────────────────────────────────

/** Every question on the page, extracted so the result count is computed from
 *  the SAME strings the groups filter on. A question added below without a
 *  line here would undercount, so a test asserts the two stay equal. */
export const QA_QUESTIONS: string[] = [
  "What is Spectrum?",
  "What is a basket token?",
  "What is a bundle?",
  "Which network does it run on?",
  "How are baskets priced?",
  "How do mint and redeem work?",
  "What are the fees?",
  "As a holder, how do I receive my share of the fees?",
  "Does Spectrum charge a management fee?",
  "Can I always exit?",
  "Can anyone launch a basket?",
  "What can go in a basket?",
  "Can a launched basket be changed later?",
  "How is a basket's displayed value calculated?",
  "Why isn't the price taken from the basket's own pool?",
  "Does Spectrum hold my assets?",
  "Are baskets vetted or endorsed?",
  "What are the risks?",
]

/** Does this text match the query? Whitespace-split so "fee creator" matches an
 *  entry containing both words in any order, which is how people actually type. */
function matches(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  const h = haystack.toLowerCase()
  return q.split(/\s+/).every((t) => h.includes(t))
}

// ─────────────────────────────────────────────────────────────────────────────
// QOL ROUND 2026-08-05 · items (a) and (b) below: "the Learn page has no
// search-empty state and no way to link a specific answer."
//
// (a) Every question gets an anchor made of its OWN WORDS, so /learn#what-are-
// the-fees is a link a person can read before they click it and a support reply
// can point at one answer instead of "scroll down to the fee question". The
// anchor is derived from the question text rather than from its position, so
// adding a question above it never breaks a link someone already sent.
// ─────────────────────────────────────────────────────────────────────────────

/** Question text → URL fragment. Deterministic and case-folded; apostrophes are
 *  dropped rather than hyphenated so "basket's" reads as `baskets`, not
 *  `basket-s`. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/['‘’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** The anchor table, resolved ONCE from the registry. Two questions that reduce
 *  to the same slug would otherwise fight over one fragment and the second would
 *  be unreachable, so the later one takes a numbered suffix. Resolved in
 *  registry order, which means the suffix a link was copied with stays put. */
const QA_ANCHOR: Record<string, string> = (() => {
  const seen = new Map<string, number>()
  const table: Record<string, string> = {}
  for (const q of QA_QUESTIONS) {
    const base = slugify(q) || 'question'
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    table[q] = n === 1 ? base : `${base}-${n}`
  }
  return table
})()

/** The anchor for a question. Falls back to a plain slug so a question added to
 *  the page without a registry line is still linkable rather than silently
 *  anchor-less (the registry drift itself is caught by learn-search.test.ts). */
export function qaAnchor(question: string): string {
  return QA_ANCHOR[question] ?? (slugify(question) || 'question')
}

/** The absolute URL of one answer. Query strings are dropped on purpose: the
 *  link is to the answer, and carrying `?ref=` or `?demo=1` into a link someone
 *  pastes into a chat would share more than they meant to. */
function anchorUrl(anchor: string): string {
  return `${window.location.origin}${window.location.pathname}#${anchor}`
}

/** The current fragment, from the router AND from native anchor clicks. This
 *  page's own menus are plain <a href="#id">, which fires `hashchange` without a
 *  popstate, so the router alone would miss half of them. */
function useHash(): string {
  const { hash: routed } = useLocation()
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const read = () => setHash(window.location.hash)
    read()
    window.addEventListener('hashchange', read)
    return () => window.removeEventListener('hashchange', read)
  }, [routed])
  return hash
}

/** Open this <details> and scroll it in when the URL fragment names it. Attach
 *  the returned ref to the element.
 *
 *  BOTH halves of this page's index are collapsed <details> — the six explainer
 *  sections and the Q&A answers — so before this, every link into either landed
 *  the reader on a closed heading they had to notice was closed and click. That
 *  included the page's OWN contents pills (#basket, #mechanism, #fee…), which is
 *  why this is a shared hook rather than an answers-only trick: half the
 *  navigation working and half not is the inconsistency someone reports as a bug.
 *
 *  COLLAPSED-BY-DEFAULT IS UNTOUCHED. Nothing opens unless a fragment names it,
 *  so a reader arriving at plain /learn still gets the compact index the owner
 *  asked for (2026-08-02: "condense information, less text more visuals").
 *
 *  Opened imperatively rather than through an `open` prop: a controlled prop
 *  makes React the owner of the state and it re-closes the element on the next
 *  render, and every one of these must stay a normal thing you can click shut. */
function useFragmentTarget(id: string) {
  const hash = useHash()
  const targeted = hash === `#${id}`
  const ref = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!targeted || !el) return
    el.open = true
    // One frame, so the opened content has laid out before we measure where to
    // stop. scrollIntoView honours scroll-margin, which is this page's scroll-mt-24.
    const frame = requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    return () => cancelAnimationFrame(frame)
  }, [targeted])
  return ref
}

function SearchField({ value, onChange, resultCount }: { value: string; onChange: (v: string) => void; resultCount: number | null }) {
  return (
    <div className="relative">
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className="pointer-events-none absolute left-5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.3-4.3" />
      </svg>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type="search"
        placeholder="Search the answers — fees, custody, launching…"
        aria-label="Search the reference"
        spellCheck={false}
        className="h-12 w-full rounded-full border border-white/12 bg-white/[0.03] pl-12 pr-32 font-mono text-[13px] text-ink outline-none transition-all placeholder:text-ink-faint focus:border-cyan/50 focus:shadow-[0_0_24px_rgba(53,224,255,0.2)]"
      />
      {/* the count is the honest half of a search: it says whether the thing you
          typed exists at all, rather than silently showing an empty page */}
      {resultCount != null && (
        <span className="pointer-events-none absolute right-5 top-1/2 -translate-y-1/2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          {resultCount === 0 ? 'no matches' : `${resultCount} answer${resultCount === 1 ? '' : 's'}`}
        </span>
      )}
    </div>
  )
}

function Section({ id, label, title, children }: { id: string; label: string; title: ReactNode; children: ReactNode }) {
  // COLLAPSED BY DEFAULT (owner: "condense information, less text"). Nothing is
  // removed — the default state changed, so the reference reads as an index of
  // headings you open rather than six essays you scroll past. Native <details>,
  // so it costs no state, survives print, and Cmd-F still finds closed text in
  // every current browser.
  //
  // …EXCEPT when the URL asks for this one by name (QOL round 2026-08-05). The
  // contents menu at the top of the page and the jump pills both link straight
  // here, and until now those pills scrolled the reader to a shut section. The
  // resting default is unchanged: no fragment, no open section.
  const ref = useFragmentTarget(id)
  return (
    <details ref={ref} id={id} className="group scroll-mt-24 border-b border-white/[0.07] last:border-0">
      <summary className="flex cursor-pointer list-none items-baseline gap-4 py-5 [&::-webkit-details-marker]:hidden">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">{label}</span>
        <h3 className="flex-1 font-display text-lg font-semibold tracking-tight text-ink transition-colors group-hover:text-cyan">
          {title}
        </h3>
        <span
          aria-hidden
          className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border border-white/12 text-ink-faint transition-all duration-200 group-open:rotate-180 group-open:border-cyan/50 group-open:text-cyan"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </summary>
      <div className="max-w-[62ch] space-y-4 pb-6 text-sm leading-relaxed text-ink-dim [&_a:hover]:underline [&_a]:text-cyan">
        {children}
      </div>
    </details>
  )
}

/** The copy-link affordance. Quiet on purpose: a small faint `#` that brightens
 *  on hover, sitting left of the chevron and sized to match its ring so the two
 *  read as one pair of controls. Visible at rest rather than hover-only, because
 *  a control you can tap but cannot see is worse on a phone than a control that
 *  is simply understated.
 *
 *  The confirmation is a glyph swap inside a FIXED cell, not a word: "Link
 *  copied" would widen the button mid-row and shove the question text onto a
 *  second line for a second and a half. */
function CopyAnchor({ anchor, label }: { anchor: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(anchorUrl(anchor))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard unavailable — the answer is open and the URL bar shows the page */
    }
  }
  return (
    <button
      type="button"
      // Inside a <summary>, so both are needed: preventDefault stops the click
      // toggling the answer open, stopPropagation keeps it off the summary itself.
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        void copy()
      }}
      aria-label={copied ? 'Link copied' : `Copy a link to: ${label}`}
      title={copied ? 'Link copied' : 'Copy a link to this answer'}
      className={`press grid h-7 w-7 shrink-0 place-items-center rounded-full font-mono text-[13px] font-normal transition-colors ${
        copied ? 'text-cyan' : 'text-ink-faint hover:text-cyan'
      }`}
    >
      {copied ? (
        <svg viewBox="0 0 24 24" aria-hidden className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : (
        '#'
      )}
    </button>
  )
}

// Prettier dropdowns (owner 18:04): a bigger question face, a ringed chevron
// that lights cyan when open, and a soft open-state tint.
function Q({ q, children }: { q: string; children: ReactNode }) {
  const anchor = qaAnchor(q)
  // Same fragment behaviour as the explainer sections above, from the same hook.
  const ref = useFragmentTarget(anchor)
  return (
    <details
      ref={ref}
      id={anchor}
      className="group -mx-4 scroll-mt-24 border-b border-white/[0.07] px-4 transition-colors open:bg-white/[0.02] last:border-0 sm:-mx-5 sm:px-5"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4.5 text-[15px] font-semibold text-ink transition-colors hover:text-cyan [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">{q}</span>
        <span className="flex shrink-0 items-center gap-2">
          <CopyAnchor anchor={anchor} label={q} />
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-white/12 text-ink-faint transition-all duration-200 group-open:rotate-180 group-open:border-cyan/50 group-open:text-cyan">
            <svg
              viewBox="0 0 24 24"
              aria-hidden
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </span>
        </span>
      </summary>
      <div className="pb-5 pr-10 text-sm leading-relaxed text-ink-dim [&_a:hover]:underline [&_a]:text-cyan">
        {children}
      </div>
    </details>
  )
}

// The section titles read as real headings now (owner 18:04) with a spectral
// tick beside each.
/** Count the questions in a group that match, by reading the children's own `q`
 *  props. Exported shape kept identical so every existing <Group> call still
 *  works untouched. */
function visibleQs(children: ReactNode, query: string): ReactNode[] {
  return Children.toArray(children).filter((c) => {
    if (!isValidElement<{ q?: string }>(c)) return query.trim() === ''
    return matches(c.props.q ?? '', query)
  })
}

function Group({ id, label, children, query = '' }: { id: string; label: string; children: ReactNode; query?: string }) {
  const shown = visibleQs(children, query)
  // A group with nothing to show disappears rather than leaving a bare heading.
  if (shown.length === 0) return null
  return (
    <section id={id} className="scroll-mt-24">
      {/* 8px tick→heading, on the house scale where 10 was not, and the mark reads
          as part of the word rather than beside it (owner 2026-08-05 on marks and
          type: "shouldn't have too much spacing between each other"). */}
      <div className="flex items-center gap-2">
        <span aria-hidden className="h-5 w-1 rounded-full" style={{ background: 'linear-gradient(180deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }} />
        <h2 className="font-display text-2xl font-bold uppercase tracking-tight text-ink">{label}</h2>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          {shown.length}
        </span>
      </div>
      <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 sm:px-5">{shown}</div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// QOL ROUND 2026-08-05 · item (b): a search that matched nothing used to render
// nothing at all. Every group returns null, the Q&A intro is hidden while
// searching, and the reader was left facing a gap with only the field's "no
// matches" to explain it. Silence reads as breakage.
//
// The rule this panel is built to: SAY THE TRUE THING AND THEN BE USEFUL. It
// never paraphrases an answer the page does not have, and it never implies there
// is more content behind the search. It offers the two honest exits — the
// nearest questions that DO exist, and the group headings to browse.
// ─────────────────────────────────────────────────────────────────────────────

/** The Q&A group headings, for the browse list. Deliberately a second copy of
 *  the labels on the <Group> calls below: those props stay literal strings
 *  because learn-search.test.ts reads them out of the source, and threading them
 *  through a constant would blind that test. Every id here is asserted to exist
 *  by the same test. */
const QA_GROUPS: { id: string; label: string }[] = [
  { id: 'q-basics', label: 'Basics' },
  { id: 'q-mechanics', label: 'Mechanics & fees' },
  { id: 'q-launching', label: 'Launching' },
  { id: 'q-pricing', label: 'Pricing & data' },
  { id: 'q-risk', label: 'Custody & risk' },
]

/** The closest questions to a query that matched nothing. `matches` needs EVERY
 *  typed word, so a miss means one of them is absent; this ranks by how many of
 *  them are present and prefers the shorter question when two tie, which keeps
 *  the list stable for a given query. Words of one or two letters are ignored
 *  because "is" and "a" appear everywhere and would rank at random. Zero overlap
 *  returns nothing, and the panel falls back to the group list rather than
 *  offering a question that has nothing to do with what was typed. */
function nearestQuestions(query: string, limit = 4): string[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 2)
  if (terms.length === 0) return []
  return QA_QUESTIONS.map((q) => {
    const h = q.toLowerCase()
    return { q, score: terms.filter((t) => h.includes(t)).length }
  })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.q.length - b.q.length)
    .slice(0, limit)
    .map((r) => r.q)
}

/** A jump OUT of the empty state. Two things a plain link cannot do here: the
 *  search has to be cleared first, because while it is running the answer being
 *  pointed at is filtered off the page and the fragment resolves to nothing; and
 *  the scroll has to be done by hand, because this app leaves fragments to the
 *  browser (see App.tsx) and a router pushState never scrolls. Still a real <a>,
 *  so it can be middle-clicked, copied, or opened in a new tab, and a click with
 *  a modifier key is left to the browser exactly as on any other link. */
function JumpLink({
  anchor,
  onClear,
  className,
  children,
}: {
  anchor: string
  onClear: () => void
  className?: string
  children: ReactNode
}) {
  const navigate = useNavigate()
  return (
    <a
      href={`#${anchor}`}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
        e.preventDefault()
        onClear()
        navigate({ hash: `#${anchor}` })
        // One frame, so the cleared page has mounted the target before we move.
        requestAnimationFrame(() =>
          document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        )
      }}
    >
      {children}
    </a>
  )
}

function NoAnswers({ query, onClear }: { query: string; onClear: () => void }) {
  const near = useMemo(() => nearestQuestions(query), [query])
  return (
    <Bezel inner="p-6 sm:p-8">
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">no matching question</p>
      {/* PRECISE ABOUT WHAT THE SEARCH DOES. It filters question titles, not the
          answers and not the sections above them, so "nothing on this page uses
          those words" would be a false claim in the other direction: the words
          may well be in a section this field never looked at. Saying so is the
          difference between an empty state and a dead end. */}
      <p className="mt-4 max-w-[54ch] text-[14px] leading-relaxed text-ink-dim">
        No question here uses the words you typed. The search reads question titles only, so what you
        want may still sit inside one of the sections above. For the technical detail there is also the{' '}
        <Link to="/docs" className="text-cyan hover:underline">developer reference</Link>.
      </p>

      {near.length > 0 && (
        // 24px between the panel's blocks on a phone, 32 from sm (mobile sweep)
        <div className="mt-6 sm:mt-8">
          <p className="text-[13px] font-semibold text-ink">The closest questions that are here</p>
          {/* Same row idiom as the contents menu at the top of the page: a
              growing rule and the label, so a suggestion reads as navigation
              rather than as an answer. */}
          <ul className="mt-3 space-y-1">
            {near.map((q) => (
              <li key={q}>
                <JumpLink
                  anchor={qaAnchor(q)}
                  onClear={onClear}
                  className="press group flex items-baseline gap-3 rounded-lg py-1.5 text-ink-dim transition-colors hover:text-cyan"
                >
                  <span
                    aria-hidden
                    className="h-px w-5 shrink-0 translate-y-[-3px] bg-white/20 transition-all duration-300 group-hover:w-8 group-hover:bg-cyan"
                  />
                  <span className="text-[14px]">{q}</span>
                </JumpLink>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6 sm:mt-8">
        <p className="text-[13px] font-semibold text-ink">
          {near.length > 0 ? 'Or browse by group' : 'Browse by group'}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {QA_GROUPS.map((g) => (
            <JumpLink
              key={g.id}
              anchor={g.id}
              onClear={onClear}
              /* 36px below sm (mobile sweep 2026-08-06: measured 29px) */
                className="press inline-flex min-h-[36px] items-center rounded-full border border-white/12 px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-dim hover:border-cyan/50 hover:text-cyan sm:min-h-0"
            >
              {g.label}
            </JumpLink>
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={onClear}
        className="press mt-6 rounded-lg border border-white/20 bg-white/[0.04] px-5 py-2.5 font-mono text-xs uppercase tracking-[0.15em] text-ink hover:border-cyan hover:text-cyan sm:mt-8"
      >
        Show every answer
      </button>
    </Bezel>
  )
}

// One long page needs wayfinding or it is not actually simpler than four short
// ones. Anchors only — no state, no JS, works on a cold load and is linkable.
/** THE PAGE'S CONTENTS, in reading order and covering BOTH halves.
 *
 *  The menu used to list only the reference groups and it lived inside the
 *  reference, 128px below the entire marketing half — so you had to scroll past
 *  everything before you could see the thing that helps you skip it (owner
 *  2026-08-03: "i dont see the content menu"). It is now a real table of contents
 *  for the page, rendered directly under the hero where it is useful. */
const CONTENTS: { id: string; label: string; kind: 'part' | 'ref' }[] = [
  { id: 'portfolio', label: 'The portfolio', kind: 'part' },
  { id: 'loop', label: 'The loop', kind: 'part' },
  { id: 'publish', label: 'Publishing', kind: 'part' },
  { id: 'reference', label: 'How it works in full', kind: 'ref' },
  { id: 'q-basics', label: 'Q&A', kind: 'ref' },
  { id: 'q-risk', label: 'Custody & risk', kind: 'ref' },
]

const JUMP = [
  { id: 'basket', label: 'What it is' },
  { id: 'mechanism', label: 'How it works' },
  { id: 'fee', label: 'Fees' },
  { id: 'launch', label: 'Launching' },
  { id: 'bundles', label: 'Bundles' },
  { id: 'q-basics', label: 'Q&A' },
  { id: 'q-risk', label: 'Risk' },
]

/** The chains THIS build is wired to, written out in prose. Never hardcode the
 *  network: an operator's build may ship any subset, and the old copy still said
 *  "Base" months after Ethereum and Robinhood went live. */
function chainSentence(): string {
  const names = SUPPORTED_CHAIN_IDS.map((id) => chainCfg(id).name)
  if (names.length === 0) return 'the network this deployment is configured for'
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** Settlement asset per chain, deduped — USDC on Base/Ethereum, USDG on Robinhood. */
function settlementSentence(): string {
  const syms = [...new Set(SUPPORTED_CHAIN_IDS.map((id) => chainCfg(id).usdcSymbol))]
  if (syms.length === 0) return 'the settlement asset its factory is configured for'
  if (syms.length === 1) return syms[0]
  return `${syms.slice(0, -1).join(', ')} or ${syms[syms.length - 1]}, depending on the chain`
}

// ─────────────────────────────────────────────────────────────────────────────
// THE MARKETING HALF (owner 2026-08-02 17:39: "the learn page… needs to actually
// be like a proper marketing page with docs as well, not the other way around").
//
// ORDER CORRECTED 2026-08-02 (owner: "the learn needs to first talk about the
// portfolio system and then introduce the basket system imo"). He is right, and my
// first cut made the exact mistake the HOMEPAGE had already been corrected for:
// it opened on publishing, which sells the second half first. The settled funnel
// is MANAGE as the front door and the daily habit, PUBLISHING as the graduation —
// see the note at the top of HomeSpine.tsx, which records the same ruling.
//
// So this page now reads in the order a person actually arrives in: here is what
// holding your portfolio here does for you, and THEN, once that has landed, here
// is what happens if you turn it into something others can buy.
//
// The loop ladder is the bridge between the two halves rather than decoration: its
// four rungs already run hold → shape → tokenise → earn, which is precisely the
// portfolio-then-basket order, built from real on-chain product fragments.
//
// The homepage's publish card links here promising "How publishing works", so it
// points at #publish: the page reads portfolio-first while that link still lands
// on what it promised.
//
// COPY SCREEN APPLIED. The fee is real and concrete, so the copy says the FEE —
// "every trade through it pays you the fee" is a mechanism, while "earn X%" would
// be a returns promise and a hard stop. No load-bearing numbers are restated up
// here; the reference below derives them from chain config.
// ─────────────────────────────────────────────────────────────────────────────

const LOOP = [
  { n: '01', title: 'Hold it here', body: 'Any chain, one book.', accent: 'var(--color-cyan)', art: 'hold' as const },
  { n: '02', title: 'Shape it', body: 'Trim, add, one signature.', accent: 'var(--color-violet-bright)', art: 'shape' as const },
  { n: '03', title: 'Make it a token', body: 'Publish. Anyone can hold it.', accent: 'var(--color-magenta)', art: 'token' as const },
  { n: '04', title: 'Earn the fee', body: 'Every trade through it pays you.', accent: 'var(--color-teal)', art: 'earn' as const },
]

/** ACT ONE — what holding your portfolio here does. Facts about the mechanism,
 *  each checkable in the reference below, never a claim about outcomes. */
const PORTFOLIO_FACTS = [
  {
    k: 'Every chain, one book',
    v: 'What you hold across networks reads as a single portfolio, priced from chain rather than from a database.',
    accent: 'var(--color-cyan)',
  },
  {
    k: 'Reshape it in one flow',
    v: 'Trim what has run, add what has not, and the trims fund the adds. You review the whole plan before anything moves.',
    accent: 'var(--color-violet-bright)',
  },
  {
    k: 'Your wallet holds everything',
    v: 'Nothing is deposited anywhere. There is no account, no custody, and nothing to withdraw from.',
    accent: 'var(--color-teal)',
  },
]

/** ACT TWO — what changes if you publish. */
const PUBLISH_FACTS = [
  {
    k: 'Your mix becomes one token',
    v: 'The weights you chose are fixed at launch and visible on chain. Anyone can buy the whole thing in a single transaction.',
    accent: 'var(--color-cyan)',
  },
  {
    k: 'You keep your position',
    v: 'Publishing seeds the basket from a portion of what you hold, not all of it. You choose how much.',
    accent: 'var(--color-violet-bright)',
  },
  {
    k: 'Trades through it pay you',
    v: 'Your basket carries a fee, and a share of it goes to you as its creator for as long as people trade it.',
    accent: 'var(--color-teal)',
  },
]

function FactCards({ facts }: { facts: { k: string; v: string; accent: string }[] }) {
  // MOBILE SWEEP 2026-08-05. Two numbers mattered here, both paid three times per
  // act because this grid is SINGLE-COLUMN until lg — a tablet stacks these cards
  // exactly like a phone does, which is why the tightening holds to lg rather than
  // stopping at sm ("mobile/tablets", his words).
  //   · the gap to the head that introduces them: 56px → 24px on a phone. A head
  //     and its own evidence are the closest pair on the page; 56 put the first
  //     card off the bottom of the screen while the title was still on it.
  //   · the card's own padding and internal rhythm: 32/16 → 20/12, so the accent
  //     rule, the title and the sentence read as one fact instead of three rows.
  return (
    /* THE PAGE'S BULK ON A PHONE (mobile audit 2026-08-05): three tall cards
       per act, stacked, twice over. They are PEERS rather than a sequence, so
       a rail is honest here in a way it would not be for the how-it-works
       triptych on the homepage. Grid returns at lg, unchanged. */
    <Carousel
      label="What you get"
      gridFrom="lg"
      gridClassName="lg:grid-cols-3"
      peek="90%"
      className="mt-6 sm:mt-10 lg:mt-14"
    >
      {facts.map((c, i) => (
        <Reveal key={c.k} delay={i * 90} className="h-full">
          <Bezel className="h-full" glow={c.accent}>
            <div className="flex h-full flex-col gap-3 p-5 lg:gap-4 lg:p-8">
              <span aria-hidden className="h-px w-12" style={{ background: c.accent }} />
              <h3 className="font-display text-lg font-bold uppercase tracking-[0.04em] text-ink">{c.k}</h3>
              <p className="text-[13px] leading-relaxed text-ink-dim">{c.v}</p>
            </div>
          </Bezel>
        </Reveal>
      ))}
    </Carousel>
  )
}

function Pitch() {
  const { data } = useAllBaskets()
  const live = useMemo(() => (data ?? []).filter((b) => !b.supersededBy), [data])

  // ── SECTION RHYTHM, MOBILE-FIRST (owner 2026-08-05, mobile sweep: "sections on
  //    mobile/tablets shouldn't have giant gaps between them, it needs to be
  //    flowing and within 1 sec of scroll from one info to another").
  //
  //    96px between acts is generous on a 1440px screen and dead air on a 375px
  //    one: it is a seventh of the viewport, so the next idea is below the fold
  //    with nothing in between to read. 56px on a phone, 72px through the tablet
  //    range, and the desktop 96px comes back at lg untouched. Each act still
  //    opens with an eyebrow pill and a display title, which is what actually
  //    marks a boundary here — the air was never carrying that job alone.
  return (
    <div className="relative space-y-14 sm:space-y-18 lg:space-y-24">
      {/* ── THE HERO BANNER (owner 2026-08-03: "it could do with a hero banner").
           Full-bleed art behind the opening, masked with the SAME side-taper and
           foot-fade the homepage hero uses, so the two surfaces read as one site
           rather than two treatments. Reused art rather than a new asset: this
           page is where the homepage sends you, and continuity is the point.

           IT STARTS AT THE TOP NOW (owner 2026-08-06 23:13: "that hero background
           doesn't actually go up to the full height of the screen at the top").
           The cause was two content paddings the art layer was never meant to sit
           inside: the shell's <main> py-8 (32) plus this page's own py-6 (24). The
           layer is absolute to the Pitch box, so it began 56px down and the reader
           saw a black band above the picture. The pull is exactly those two
           paddings — the same thing the homepage hero does with its -mt-8, which
           cancels the one padding IT sits inside — and the box grows by the same
           56 so the foot fade still lands where it was composed to land, over the
           CTA row rather than above it. Both paddings are breakpoint-invariant, so
           one number is correct at every width. */}
      <div aria-hidden className="pointer-events-none absolute left-1/2 -top-14 -z-10 h-[616px] w-screen -translate-x-1/2 overflow-hidden">
        <img
          src={learnArt}
          srcSet={`${learnArt1280} 1280w, ${learnArt} 3840w`}
          sizes="100vw"
          alt=""
          /* ~20% VISIBLE (owner 2026-08-06 23:13: "that background needs to be
             darker, it needs to be like only 20%, 20% visible"). Dimmed with
             `brightness`, not a scrim div and not opacity: this art is masked, and
             a scrim would flatten the taper it dissolves through while opacity
             would let the page's light bands read straight through a picture that
             is supposed to be receding. Same idiom, same reason, as the homepage
             hero's brightness-[0.53] (HomeSpine.tsx). */
          className="h-full w-full object-cover object-[right_35%] brightness-[0.2]"
          style={{
            WebkitMaskImage: `${SIDE_TAPER}, ${FOOT_FADE}`,
            WebkitMaskComposite: 'source-in',
            maskImage: `${SIDE_TAPER}, ${FOOT_FADE}`,
            maskComposite: 'intersect',
          }}
        />
      </div>

      {/* ── ACT ONE · THE PORTFOLIO, which is the front door ─────────────── */}
      {/* CENTRED (owner 2026-08-05 ~22:0x: "i wanted the title and everything
          on this hero centered") — one axis: eyebrow, title, description and
          both CTAs. The ch caps stay (they set the line breaks) but become
          mx-auto so the measure centres instead of hugging the left rail.

          The centring is untouched by the 2026-08-05 mobile sweep; only the
          vertical gaps moved. On a phone the pill, the title and the sentence are
          ONE cluster at 16px ("Logos and text shouldn't have too much spacing
          between each other"), and the CTA row keeps a clearly wider 32px because
          it is a different band — the thing you DO, not the thing you read. */}
      <Reveal>
        <div className="flex flex-col items-center pt-4 text-center">
          <Eyebrow tone="spectral">how it works</Eyebrow>
          <h1
            className="mx-auto mt-4 max-w-[24ch] font-display font-semibold leading-[1.0] tracking-tight text-ink sm:mt-8"
            style={{ fontSize: 'clamp(2.25rem, 1.1rem + 5vw, 4.25rem)' }}
          >
            Hold anything, anywhere,
            <br />
            <span className="spectral-text">as one portfolio.</span>
          </h1>
          {/* TWO SHORT SENTENCES (owner 2026-08-06 23:13: "'Spectrum reads what
              your wallet holds' — that needs to be like literally two sentences…
              way, way less text", desktop AND mobile). 30 words → 19; five lines
              of 15px prose under the headline on a 390px phone, down to four.
              Four rather than three is deliberate: the honesty sentence alone is
              two lines at this measure, so the only way to a third line was to
              delete a fact, and the fact on the block was "you reshape it in one
              flow" — the page's whole first act. Words went, facts did not.
              WHAT WAS CUT IS RESTATEMENT, NOT FACT: "across every network as a
              single book" is what the headline immediately above already says
              ("Hold anything, anywhere, as one portfolio") and what the first fact
              card below says a third time ("Every chain, one book"). Both honesty
              lines survive verbatim — nothing is deposited (custody) and every
              number comes from chain (where the prices come from) — because those
              are the two claims a reader is owed before connecting a wallet, and
              they are the last thing that should pay for a copy trim. */}
          {/* bigger and shorter (the owner 2026-08-16): this is the first thing a
              reader meets, so it earns real size. Two plain sentences, no
              semicolon and no em dash. */}
          <p className="mx-auto mt-4 max-w-[42ch] text-[17px] leading-relaxed text-ink-dim sm:mt-8 sm:text-[19px]">
            Reshape your wallet in one flow. Nothing is deposited and every number comes from chain.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4 sm:mt-12">
            {WALLET_ENABLED && <SplitCta left={{ to: '/portfolio', label: 'Create portfolio' }} right={{ to: '/create', label: 'Create baskets' }} />}
            <IslandCta to="/explore" tone="quiet">
              See live baskets
            </IslandCta>
          </div>
        </div>
      </Reveal>

      {/* THE CONTENTS, WHERE THEY ARE USEFUL — directly under the hero rather than
          buried below the half of the page they exist to help you skip. Two
          registers so the shape of the page is legible at a glance: the argument,
          then the reference. */}
      <Reveal delay={90}>
        <Bezel inner="p-6 sm:p-8">
          <span aria-hidden className="absolute inset-x-0 top-0 h-px" style={{ background: SPECTRAL }} />
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">on this page</p>
          {/* a label and the list it labels — 16px on a phone (mobile sweep) */}
          <div className="mt-4 grid gap-x-10 gap-y-3 sm:mt-6 sm:grid-cols-2">
            {(['part', 'ref'] as const).map((kind) => (
              <ul key={kind} className="space-y-1">
                {CONTENTS.filter((c) => c.kind === kind).map((c) => (
                  <li key={c.id}>
                    <a
                      href={`#${c.id}`}
                      className="press group flex items-baseline gap-3 rounded-lg py-1.5 text-ink-dim transition-colors hover:text-cyan"
                    >
                      <span
                        aria-hidden
                        className="h-px w-5 shrink-0 translate-y-[-3px] bg-white/20 transition-all duration-300 group-hover:w-8 group-hover:bg-cyan"
                      />
                      <span className="font-display text-[15px] font-semibold tracking-tight">{c.label}</span>
                    </a>
                  </li>
                ))}
              </ul>
            ))}
          </div>
        </Bezel>
      </Reveal>

      <section id="portfolio" className="scroll-mt-24">
        <Reveal>
          <SectionHead
            eyebrow="the portfolio"
            size="display"
            title={
              <>
                What you get before
                <br />
              </>
            }
            spectralWord="you publish anything."
          />
        </Reveal>
        <FactCards facts={PORTFOLIO_FACTS} />
        {/* learn ends in DOING (owner ~17:0x: each act gets its door) — the
            ceremony shows this act with the reader's own wallet */}
        {WALLET_ENABLED && (
          <div className="mt-6 lg:mt-10">
            <IslandCta to="/portfolio?intro=replay" tone="quiet">
              See it with your wallet
            </IslandCta>
          </div>
        )}
      </section>

      {/* ── THE BRIDGE · the loop runs portfolio → basket in order ────────── */}
      <section id="loop" className="scroll-mt-24">
        <Reveal>
          <SectionHead
            eyebrow="the whole loop"
            size="display"
            title={
              <>
                It starts as your portfolio.
                <br />
              </>
            }
            spectralWord="It can become a token."
          />
        </Reveal>
        {/* same head→content ramp as FactCards, so the two acts share one rhythm */}
        <div className="mt-6 sm:mt-10 lg:mt-14">
          <LoopLadder rungs={LOOP} baskets={live} />
        </div>
      </section>

      {/* ── ACT TWO · THE BASKET, the graduation. #publish is what the
           homepage's "How publishing works" card points at. ──────────────── */}
      <section id="publish" className="scroll-mt-24">
        <Reveal>
          <SectionHead
            eyebrow="publishing"
            size="display"
            title={
              <>
                Then, if you want,
                <br />
              </>
            }
            spectralWord="others can hold it too."
          />
        </Reveal>
        <Reveal delay={90}>
          <p className="mt-4 max-w-[54ch] text-[15px] leading-relaxed text-ink-dim sm:mt-8">
            A basket token is a portfolio anyone can buy in one transaction. Publishing turns the mix
            you already built into one, and every trade through it pays you the fee.
          </p>
        </Reveal>
        <FactCards facts={PUBLISH_FACTS} />

        {/* THE VISUAL IS REAL PRODUCT, not a diagram (owner rejected invented
            icons on the homepage and was right). These are LIVE baskets someone
            already published, each with its own reconstructed chart, holders and
            value — the argument for publishing made by showing it happening
            rather than by describing it. Renders NOTHING when a deployment has
            no baskets yet, because a fresh operator install must not show
            placeholders where evidence belongs. */}
        {live.length > 0 && (
          // DELIBERATELY STILL THE WIDEST GAP INSIDE AN ACT (40px on a phone, was
          // 64). The argument ends and the evidence begins: two different kinds of
          // thing, so this one keeps air where the head→cards gaps gave theirs up.
          // Flow, not compression (owner 2026-08-05).
          <div className="mt-10 lg:mt-16">
            <Reveal>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
                baskets people have already published
              </p>
            </Reveal>
            <div className="mt-4 grid gap-4 sm:mt-6 sm:grid-cols-2 lg:grid-cols-3">
              {live.slice(0, 3).map((b, i) => (
                <Link key={`${b.chainId}:${b.address}`} to={basketHref(b)} className="press-lg group block h-full">
                  <ConvictionCard b={b} i={i} />
                </Link>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* the mutability answer, stated here rather than left in the FAQ —
          reworded to lead with the CAN (the owner 2026-08-10: "you can
          reweight/edit but it creates a new version that the holders of the
          old can swap into and they see there's a new version on the basket's
          page"). The trust fact stays: a shipped version never changes. */}
      <Reveal>
        {/* 24 → 32 → 48: a phone spends 96px of a 375px width on padding at p-12,
            which is what pushed this single paragraph into a screenful. */}
        <Bezel inner="p-6 sm:p-8 lg:p-12">
          <span aria-hidden className="absolute inset-x-0 top-0 h-px" style={{ background: SPECTRAL }} />
          <h2 className="max-w-[24ch] font-display text-2xl font-semibold tracking-tight text-ink">
            Reshape it any time. Every edit ships a new version.
          </h2>
          <p className="mt-5 max-w-[58ch] text-[14px] leading-relaxed text-ink-dim">
            Reweight or edit your basket whenever your thinking changes — the change goes out as a
            new version. The version anyone already bought never changes underneath them; that is
            what makes it trustworthy to buy. Holders see the new version right on the basket&rsquo;s
            page and can swap into it in one move, on their own schedule. Your own portfolio stays
            yours to reshape freely.
          </p>
          <div className="mt-6 sm:mt-8">
            {/* was /launch — the LEGACY builder, page-gated off on this
                funnel: a dead door at the exact moment the reader is sold.
                /create is the launch page now. */}
            <IslandCta to="/create" tone="quiet">
              Start a basket
            </IslandCta>
          </div>
        </Bezel>
      </Reveal>
    </div>
  )
}

export function Learn() {
  const [query, setQuery] = useState('')
  const searching = query.trim() !== ''
  // Counted from the SAME predicate the groups filter with, so the number can
  // never disagree with what is on screen.
  const answerCount = useMemo(() => QA_QUESTIONS.filter((q) => matches(q, query)).length, [query])

  return (
    <div className="relative py-6">
      {/* WAY DARKER (owner 2106 #12: "background way, way darker") — a fixed
          void layer under the whole page; fixed so the site's ambient light
          bands and glows are dimmed with it, not just the scroll body. */}
      <div
        aria-hidden
        className="fixed inset-0 -z-10"
        /* the page-wide dim rides the VOID token — a hardcoded black/60 painted
           the light plane with a full-page vignette (owner 2026-08-19) */
        style={{ background: 'color-mix(in srgb, var(--color-void) 60%, transparent)' }}
      />
      <Pitch />

      {/* ── THE REFERENCE ────────────────────────────────────────────────────
          Everything below is the previous page, unchanged in substance. It moves
          BELOW the argument rather than being the whole page, and keeps its
          narrow measure because reference prose is read, not scanned.

          MOBILE SWEEP 2026-08-05. This was the worst gap on the page: 128px above
          the rule plus 64px below it, so a phone scrolled through nearly TWO
          THIRDS of a viewport of nothing to cross from the argument into the
          reference. The border-t is what marks this boundary — a full-width rule
          separates two halves on its own, and it does not need 192px of air to
          help. 56 + 40 on a phone; the desktop pair is restored at lg.
          The internal rhythm between reference blocks goes 56 → 40 for the same
          reason: those blocks are all one half of the page, not six regions. */}
      <div id="reference" className="mx-auto mt-14 max-w-3xl scroll-mt-24 space-y-10 border-t border-white/10 pt-10 lg:mt-32 lg:space-y-14 lg:pt-16">
        <Reveal>
          <Eyebrow>the detail</Eyebrow>
          <h2 className="mt-4 font-display text-3xl font-semibold tracking-tight text-ink sm:mt-6">
            How it works, in full
          </h2>
          <p className="mt-5 max-w-[58ch] text-[14px] leading-relaxed text-ink-dim">
            Every section below is closed until you open it, so this reads as an index rather than a
            wall. Search jumps straight to an answer.
          </p>
        </Reveal>

        {/* SEARCH FIRST, then the menu. Someone who knows what they want types it;
            someone browsing uses the menu. Putting the field above the menu is
            what makes the second group optional rather than mandatory. */}
        <SearchField value={query} onChange={setQuery} resultCount={searching ? answerCount : null} />

        {/* The menu is GENERATED from the same list the anchors use, so a section
            can never exist without a way to reach it. Hidden while searching,
            because a jump list is noise when the page is already filtered. */}
        {!searching && (
          <nav aria-label="On this page" className="flex flex-wrap gap-2">
            {JUMP.map((j) => (
              <a
                key={j.id}
                href={`#${j.id}`}
                className="press rounded-full border border-white/12 px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-dim hover:border-cyan/50 hover:text-cyan"
              >
                {j.label}
              </a>
            ))}
          </nav>
        )}

      {/* the explainer, as one index rather than six stacked essays */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-5 sm:px-6">
      <Section id="basket" label="01 · Basket tokens" title="A whole basket, as one token">
        <p>
          A basket token holds many assets at fixed weights and trades as a single token. Buy one to
          hold the entire basket; sell it in one transaction. No bridging between a dozen positions,
          no rebalancing, the composition is fixed at launch and visible on-chain.
        </p>
      </Section>

      <Section id="mechanism" label="02 · The mechanism" title="The token is the pool">
        <p>
          Each basket <em className="not-italic text-ink">is</em> its own Uniswap V4 hook and its own
          liquidity. Buying routes through a custom hook that mints against the underlying assets
          straight into the pool: no vault, no wrapper, no second transaction.
        </p>
        <p>
          Because the token is its own liquidity, the price always reflects the real units backing it:
          there is no separate liquidity provider to drain, and you hold a claim on the assets rather
          than an LP position exposed to impermanent loss.
        </p>
      </Section>

      <Section id="fee" label="03 · The fee" title="The fee, and where it goes">
        {/* Per-basket rate, fixed protocol slices + a single capped creator
            share; holders get the rest. Never print a universal split for the
            rate. */}
        <p>
          Fees are set per basket, by its creator, at launch, once deployed they cannot be changed.
          The split is mostly fixed by the protocol:
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">Fixed protocol slices</div>
            <p className="mt-2 text-sm leading-relaxed">
              A fixed 10% of every fee goes to an autonomous PRISM buy-and-burn. Fixed ~5% interface
              and ~5% launcher shares are carved off the rest only when a routing interface or a
              launcher is attached, uniform on every basket, set by the protocol, not the creator.
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">Creator share + holders</div>
            <p className="mt-2 text-sm leading-relaxed">
              Of what remains, the creator takes a single share they fix at launch (0–30%, and they can
              take nothing); basket holders automatically receive the rest. Each basket&rsquo;s page
              shows its exact split, read live from chain.
            </p>
          </div>
        </div>
        <p>
          The holders&rsquo; share stays inside the basket and is claimable; it is not extracted by
          anyone, and when no interface or launcher is attached those slices flow to the creator and
          holders too. No one, including the people who wrote this software, can change a deployed
          basket&rsquo;s fee.
        </p>
      </Section>

      <Section id="different" label="04 · Why it's different" title="Built without the seam">
        <p>
          Every earlier basket-token design was two things stitched together: a vault that held the
          assets and a separate market that priced them. Every failure traced back to that seam:
          management fees, rented liquidity that walked away, persistent gaps between market price
          and the value of the underlying assets, impermanent loss.
        </p>
        <p>
          Spectrum removes the seam entirely. The token is the liquidity, valuation is unit-based, and
          there is nothing to rent, drift, or bleed.
        </p>
      </Section>

      <Section id="launch" label="05 · Launch" title="Anyone can launch one">
        {/* Was "win a launch slot in the factory's Dutch auction" — the shipped
            factories charge a FLAT launch fee, and the builder reads it live
            (useDeployPrice). Wording kept true under either lineage, and it
            deliberately prints no number: the fee is read from chain, never
            restated in copy. */}
        <p>
          Choose assets, weights and your fee config, and your basket deploys with a hook address
          mined in your browser. The launch fee is read live from the factory and shown in the builder
          before you sign, along with any wait for the next available slot. As the deployer you are
          recorded onchain as the basket&rsquo;s creator, and the fee rate and creator share you fixed
          at launch apply for as long as it trades. Pool routing, fees and tick spacing are detected
          automatically; you just pick the assets.
        </p>
        <Link
          to="/create"
          className="mt-1 inline-block rounded-lg border border-white/20 bg-white/[0.04] px-5 py-2.5 font-mono text-xs uppercase tracking-[0.15em] text-ink press hover:border-cyan hover:text-cyan"
        >
          Launch a Basket →
        </Link>
      </Section>

      <Section id="bundles" label="06 · Bundles" title="One idea, across networks">
        {/* A bundle is a READ, not a registry — the page derives it from the
            baskets themselves (same creator, shared name), so this copy states
            the mechanism and restates no number. Holder counts deliberately
            unmentioned (fixture-only today — no chain derivation yet). */}
        <p>
          A bundle is one idea published on more than one network: sibling baskets from the same
          creator sharing one name, one per chain, each with its own ticker and its own liquidity.
          The bundle&rsquo;s page reads them together &mdash; a combined price, combined TVL and the
          per-network split &mdash; while every basket in it stays an ordinary basket on its own
          chain.
        </p>
        <p>
          Buying a bundle is planned as one flow: the stake splits across the networks, pays in each
          chain&rsquo;s settlement asset, and bridges where funds need to move; selling works the
          same way in reverse. Reshaping ships a new version per network &mdash; the current baskets
          stay live, and holders can move into each new version from its own page, on their own
          schedule. Picks that span more than one network in the composer become a bundle on their
          own; nothing extra to configure.
        </p>
        <Link
          to="/create"
          className="mt-1 inline-block rounded-lg border border-white/20 bg-white/[0.04] px-5 py-2.5 font-mono text-xs uppercase tracking-[0.15em] text-ink press hover:border-violet-bright hover:text-violet-bright"
        >
          Compose a bundle →
        </Link>
      </Section>

      <Section id="prism" label="07 · PRISM" title="The burn mechanism">
        {/* Mechanism-neutral wording — no "owns the machine", no value framing.
            Burn copy uses the routing form, never present-tense "burns"/"buys
            and burns", until one observed end-to-end burn exists ("wired and
            in-flight, not yet realised"). */}
        <p>
          Basket quotes read as plain dollar values, backed unit-for-unit by what each basket holds.
          A fixed share of every basket&rsquo;s pool mint/redeem fees is routed to an autonomous
          PRISM buy-and-burn path that anyone can execute, with no operator, a mechanical property
          of the contracts, stated here as fact, not as a reason to hold anything.
        </p>
      </Section>

      <Section id="mcp" label="08 · AI agents" title="Drive it from an AI agent">
        {/* The footer's "For AI agents" door, upgraded into a real section (owner
            2026-08-20). Copy register mirrors /mcp; the tool count is read from
            the GENERATED manifest (mcp/build.mjs writes it from the server's own
            registry), the same file /mcp renders its table from, so this
            sentence and the server cannot disagree. No em dashes. */}
        <p>
          This site ships with a Model Context Protocol server. Any MCP-speaking agent (Claude,
          Cursor, your own) gets {mcpManifest.tools.length} tools to discover baskets, read them,
          and compose buys, sells, creations and exits.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">Nothing to host</div>
            <p className="mt-2 text-sm leading-relaxed">
              No daemon, no port. Your MCP client spawns the server per session over stdio, and it
              reads the chains directly.
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">Never holds keys</div>
            <p className="mt-2 text-sm leading-relaxed">
              Every action returns a transaction and a plain-English review. Your wallet signs, or
              nothing happens.
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">Floors from live simulation</div>
            <p className="mt-2 text-sm leading-relaxed">
              A buy or sell floor comes from simulating the actual trade on-chain. An agent supplies
              an amount and a tolerance, never a floor.
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">Agents compose, wallets sign</div>
            <p className="mt-2 text-sm leading-relaxed">
              The agent does the reading and the assembly. Execution stays with you, from your own
              wallet.
            </p>
          </div>
        </div>
        <CodeBlock code="claude mcp add spectrum -- bash /path/to/kit/mcp/run.sh" title="Claude Code, one line" />
        <Link
          to="/mcp"
          className="mt-1 inline-block rounded-lg border border-white/20 bg-white/[0.04] px-5 py-2.5 font-mono text-xs uppercase tracking-[0.15em] text-ink press hover:border-cyan hover:text-cyan"
        >
          The full tool reference →
        </Link>
      </Section>

      </div>

      {/* ── the former /faq, folded in ─────────────────────────────────────── */}
      {/* Uses the page's OWN heading idiom rather than PageHeader: this is a
          section of a page, not a second page's header, and the two treatments
          side by side read as two designs. Hidden while searching, because a
          results list does not need an introduction to itself. */}
      {!searching && (
        <Reveal>
          <div className="border-t border-white/10 pt-8 lg:pt-12">
            <Eyebrow>questions</Eyebrow>
            <h2 className="mt-4 font-display text-3xl font-semibold tracking-tight text-ink sm:mt-6">
              Questions &amp; answers
            </h2>
            <p className="mt-5 max-w-[58ch] text-[14px] leading-relaxed text-ink-dim">
              The short answers. Read the{' '}
              <Link to="/risk" className="text-cyan hover:underline">Risk Disclosure</Link> before
              interacting with any onchain asset.
            </p>
          </div>
        </Reveal>
      )}

      {/* Where the answers would have been, so the reader finds the explanation
          in the place the gap was. */}
      {searching && answerCount === 0 && <NoAnswers query={query} onClear={() => setQuery('')} />}

      <Group id="q-basics" label="Basics" query={query}>
        <Q q="What is Spectrum?">
          <p>
            Software for creating and reading onchain basket tokens, built on Uniswap V4. A basket
            bundles a fixed set of tokens into a single ERC-20 that trades like any token. Each basket
            is its own Uniswap V4 hook and liquidity, so there is no separate vault or wrapper.
          </p>
        </Q>
        <Q q="What is a basket token?">
          <p>
            An ERC-20 (18 decimals) backed by a fixed set of constituent tokens at set weights. Buying
            it mints against the constituents; selling redeems them. Its value tracks the combined
            value of everything inside.
          </p>
        </Q>
        <Q q="What is a bundle?">
          <p>
            One idea published on more than one network &mdash; sibling baskets sharing one name from
            one creator, one per chain. The bundle&rsquo;s page reads them as a whole (combined price
            and TVL, the per-network split), a buy or sell runs across the networks from one flow,
            and a reshape ships a new version per network while the current baskets stay live.
          </p>
        </Q>
        <Q q="Which network does it run on?">
          {/* Both facts are read from this build's chain config: the old copy
              said "Base" long after Ethereum and Robinhood were live, and an
              operator ships whatever subset they configure. */}
          <p>
            This deployment is wired to {chainSentence()}. Each basket lives on one chain and settles
            in that chain&rsquo;s settlement asset — {settlementSentence()}.
          </p>
        </Q>
        <Q q="How are baskets priced?">
          <p>
            At the live USD value of everything a basket holds, divided by supply. The V2
            contracts expose this as a static, non-reverting on-chain read; this app also
            cross-checks it against public market data. See the{' '}
            <Link to="/docs#nav">valuation method</Link>.
          </p>
        </Q>
      </Group>

      <Group id="q-mechanics" label="Mechanics &amp; fees" query={query}>
        <Q q="How do mint and redeem work?">
          <p>
            Minting and redeeming a basket are mechanical, peer-to-contract swaps against its
            constituents at the value of the reserves backing it, settled on-chain through the
            basket&rsquo;s own V4 hook. This app is informational: it does not execute, route, or
            take custody of any transaction. You interact with the onchain contracts directly from
            your own wallet.
          </p>
        </Q>
        <Q q="What are the fees?">
          {/* Fee split is two-part: a fixed protocol burn + a creator-set remainder.
              The rate is per-basket, so never print a universal split. The "pool
              mint/redeem fees" qualifier is load-bearing: the in-kind exit's haircut
              stays with remaining holders, never the burn. */}
          <p>
            The fee rate varies per basket. For every basket the split is mostly fixed by the protocol:
            (a) a fixed 10% of every fee goes to an autonomous PRISM buy-and-burn, and fixed ~5%
            interface and ~5% launcher shares are carved off the rest only when a routing interface or a
            launcher is attached; and (b) of what remains, the creator takes a single share they fix at
            launch (0–30%, removable) and basket holders receive the rest. The creator sets only the fee
            rate and their own share, there is no creator-defined routing table. Every basket&rsquo;s
            page shows its exact fee and split, read live from its contract. Network (gas) costs apply
            separately.
          </p>
        </Q>
        <Q q="As a holder, how do I receive my share of the fees?">
          {/* The community's own question, verbatim shape (Telegram 2026-08-01) —
              the mechanism was real but undocumented. Quarantine framing holds:
              a reserve accrues and is claimable; never "holders earn / are paid". */}
          <p>
            On-chain, per basket, as a pull. Each trade&rsquo;s holder share accrues inside the
            basket contract to a fee reserve, tracked per token you hold (the contract keeps a
            per-share accumulator, so your share is exact whenever your balance changes). It
            accrues in the settlement currency and sits <em>beside</em> the basket&rsquo;s NAV —
            it never inflates the token&rsquo;s price. You claim it whenever you like: the fee
            console shows your claimable amount per basket with a one-click claim straight to your
            wallet, and your holdings card on any basket page shows the same figure. Verifiable
            directly: <code>claimableFees(your address)</code> on the basket contract is the number
            the site displays. Claiming is permissionless — no operator holds the reserve, and
            nothing expires.
          </p>
        </Q>
        <Q q="Does Spectrum charge a management fee?">
          <p>
            No. There is no management or subscription fee. The only fee is the per-basket
            mint/redeem/swap fee described above, set once by each basket&rsquo;s creator within
            protocol bounds.
          </p>
        </Q>
        <Q q="Can I always exit?">
          <p>
            Every basket has an unconditional in-kind exit: <code className="font-mono text-ink">redeemInKind</code>{' '}
            is a mechanical contract swap that returns the underlying constituents pro-rata, never
            touches any pool, and works even if every pool is dead. A per-leg mask lets you skip a
            frozen constituent explicitly.
          </p>
        </Q>
      </Group>

      <Group id="q-launching" label="Launching" query={query}>
        <Q q="Can anyone launch a basket?">
          <p>
            Yes. Launching is permissionless: pick the assets, weights and fee config, and the basket
            deploys through the factory. The deployer is recorded onchain as the basket&rsquo;s
            creator; the fee rate and creator share they fixed at launch apply forever.{' '}
            <Link to="/create">Create a Basket</Link>.
          </p>
        </Q>
        <Q q="What can go in a basket?">
          <p>
            Tokens with sufficient Uniswap liquidity (V4, V3, or V2). The launcher detects the deepest
            pool for each asset automatically. Tokens that only trade on venues without hooks (for
            example Aerodrome) can&rsquo;t be used as constituents.
          </p>
        </Q>
        <Q q="Can a launched basket be changed later?">
          <p>
            No. Baskets are immutable by design, constituents, weights, the fee rate and the creator
            share are fixed at deploy, and a basket has no privileged functions over its live state: not
            even its creator can change any fee parameter afterwards. The system evolves by deploying new
            baskets, not by mutating live ones.
          </p>
        </Q>
      </Group>

      <Group id="q-pricing" label="Pricing &amp; data" query={query}>
        <Q q="How is a basket's displayed value calculated?">
          <p>
            Primarily from the basket&rsquo;s own static on-chain views (<code className="font-mono text-ink">exchangeRate()</code>),
            which are non-reverting and report whether every leg was priced. This app also
            reconstructs an aggregate-spot value, the sum of each constituent&rsquo;s held amount
            times its market price, divided by <code className="font-mono text-ink">effectiveSupply</code>,
            as a cross-check, and flags any meaningful divergence. See the{' '}
            <Link to="/docs#nav">valuation method</Link>.
          </p>
        </Q>
        <Q q="Why isn't the price taken from the basket's own pool?">
          <p>
            A basket&rsquo;s internal V4 self-pool is hook-mediated, so its quoted price is effectively
            static and does not track value. Price comes from the on-chain value views or the
            reconstruction.
          </p>
        </Q>
      </Group>

      <Group id="q-risk" label="Custody &amp; risk" query={query}>
        <Q q="Does Spectrum hold my assets?">
          <p>
            No. Spectrum is non-custodial software. You connect a self-custodial wallet and interact
            directly with the contracts; nothing here holds your assets or transacts on your behalf.
          </p>
        </Q>
        <Q q="Are baskets vetted or endorsed?">
          <p>
            No. Anyone can deploy a basket, including low-quality, illiquid, or misleadingly named
            ones. Listing or display is not an endorsement or a recommendation. Do your own diligence.
          </p>
        </Q>
        <Q q="What are the risks?">
          <p>
            Onchain assets are volatile and you can lose some or all of what you put in. There is
            smart-contract risk, creator / issuer risk, and liquidity risk. Read the full{' '}
            <Link to="/risk">Risk Disclosure</Link> and <Link to="/terms">Terms</Link>.
          </p>
        </Q>
      </Group>

      {/* The closing row now uses the page's OWN CTA idiom. Three flat buttons in
          a different shape from the islands above them was an inconsistency I
          introduced by adding the marketing half and leaving this untouched. The
          primary action is Create, because the reader who finished this page has
          a portfolio to build; the integrator reference keeps its own page since
          it is a different reader entirely. */}
      <div className="flex flex-wrap items-center gap-4 border-t border-white/10 pt-8 lg:pt-10">
        {WALLET_ENABLED && <SplitCta left={{ to: '/portfolio', label: 'Create portfolio' }} right={{ to: '/create', label: 'Create baskets' }} />}
        <IslandCta to="/explore" tone="quiet">
          Explore baskets
        </IslandCta>
        <IslandCta to="/docs" tone="quiet">
          Developer docs
        </IslandCta>
        <IslandCta to="/mcp" tone="quiet">
          For AI agents
        </IslandCta>
      </div>
      </div>
    </div>
  )
}
