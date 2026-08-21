// /mcp — the agent surface, sold and documented on one page (owner 2026-08-19:
// "part marketing part documentation on what's possible"). Same register as
// /integrate: a pitch up top for the person deciding, the working reference
// below for the agent-wirer. Every claim here mirrors mcp/README.md in the
// kit; the code snippets are the real interface, kept short on purpose.
// House style: no em dashes on this page.
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Callout, CodeBlock, IC, Table } from '../components/DocKit'
import mcpManifest from '../generated/mcp-tools.json'

const GRADIENT = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

const REGISTER = `{
  "mcpServers": {
    "spectrum": { "command": "/path/to/kit/mcp/run.sh" }
  }
}`

const BUILD = `git clone https://github.com/Irora-dev/Spectrum
cd Spectrum/app && npm install && npm run mcp:build
bash ../mcp/run.sh --check   # proves the install: build, handshake, live health
# Claude Code, one line:
claude mcp add spectrum -- /path/to/Spectrum/mcp/run.sh`

const CONVERSATION = `"What baskets are there on Base?"     > the factory's live list
"Read the SVI basket."                > NAV with provenance, legs, weights
"Buy $100 of it."                     > { approval, swap } to sign, floor pre-simulated
"Actually migrate it into TRINITY."   > the sell, then the sequenced buy
"Get me out."                         > redeemInKind calldata, no pool, no floor`

function Pillar({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/[0.18] bg-white/[0.07] p-6 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.09)] transition-colors hover:border-white/[0.3]">
      <div className="font-display text-lg font-bold uppercase tracking-tight text-ink">{title}</div>
      <p className="mt-2 text-[15px] leading-relaxed text-ink-dim">{children}</p>
    </div>
  )
}

export function Mcp() {
  return (
    <div className="pb-10">
      {/* ── HERO: the pitch ── */}
      <section className="relative pt-10 text-center sm:pt-16">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-24 mx-auto h-80 max-w-3xl opacity-30 blur-3xl"
          style={{ background: 'radial-gradient(50% 60% at 50% 30%, var(--color-violet-bright), transparent 70%)' }}
        />
        <div className="relative">
          <div className="font-mono text-sm font-semibold uppercase tracking-[0.25em] text-ink-dim sm:text-base">For AI agents and the people who run them</div>
          <h1 className="mt-6 font-display text-[2.5rem] font-bold uppercase leading-[0.92] tracking-tight text-ink sm:text-7xl">
            Baskets,
            <br />
            <span className="spectral-text">operable by agents</span>
          </h1>
          <p className="mx-auto mt-6 max-w-3xl text-balance text-base text-ink-dim sm:text-xl">
            This site ships with a Model Context Protocol server: any MCP-speaking agent (Claude, Cursor, your own)
            can discover baskets, read them, and compose buys, sells, migrations, creations and exits. The agent
            talks; your wallet signs.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              to="/chat"
              className="rounded-full px-6 py-3 font-display text-sm font-bold uppercase tracking-[0.12em] text-void transition-transform hover:scale-[1.03]"
              style={{ background: GRADIENT }}
            >
              Try the in-site agent
            </Link>
            <a
              href="https://github.com/Irora-dev/Spectrum/tree/main/mcp"
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-white/[0.16] bg-white/[0.06] px-6 py-3 font-display text-sm font-bold uppercase tracking-[0.12em] text-ink transition-colors hover:border-white/[0.3]"
            >
              The server, on GitHub
            </a>
          </div>
        </div>
      </section>

      {/* ── the four claims that matter ── */}
      <section className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Pillar title="Nothing to host">
          No daemon, no port, no server bill. Your MCP client spawns it per session over stdio and it reads the
          chains directly. Build once, register once, done.
        </Pillar>
        <Pillar title="Never holds keys">
          Every action returns a transaction plus a plain-English review. Your wallet signs, or nothing happens.
          Autonomous sending exists only behind an operator key you set yourself.
        </Pillar>
        <Pillar title="Floors from live simulation">
          A buy or sell floor is derived by simulating the actual trade on-chain, minus a bounded slippage.
          An agent supplies an amount and a tolerance. It can never supply a floor.
        </Pillar>
        <Pillar title="Refuses in words">
          An unknown chain, a decimal where raw units belong, an unbuyable basket: each refusal is a sentence
          that says what happened and what to do, decoded from the protocol&rsquo;s own errors.
        </Pillar>
      </section>

      {/* ── what a conversation looks like ── */}
      <section className="mt-14">
        <h2 className="font-display text-2xl font-bold uppercase tracking-tight text-ink">What it feels like</h2>
        <p className="mt-2 max-w-3xl text-[15px] leading-relaxed text-ink-dim">
          Plain language in, real transactions out. The same flows power the <Link to="/chat" className="text-cyan hover:underline">in-site agent chat</Link>.
        </p>
        <div className="mt-4">
          <CodeBlock code={CONVERSATION} title="a session" />
        </div>
      </section>

      {/* ── the tools: mapped from the GENERATED manifest (mcp/build.mjs
             writes app/src/generated/mcp-tools.json from the live registry),
             so this table and the server cannot disagree ── */}
      <section className="mt-14">
        <h2 className="font-display text-2xl font-bold uppercase tracking-tight text-ink">The tools</h2>
        <p className="mt-2 max-w-3xl text-[15px] leading-relaxed text-ink-dim">
          {mcpManifest.tools.length} tools, each reusing the app&rsquo;s own money modules verbatim. This table is
          generated from the server&rsquo;s registry: the server and this site cannot disagree.
        </p>
        <div className="mt-4">
          <Table
            head={['Tool', 'Kind', 'What it does']}
            rows={mcpManifest.tools.map((t) => [
              <IC key={t.name}>{t.name}</IC>,
              t.kind,
              t.description,
            ])}
          />
        </div>
        <p className="mt-4 max-w-3xl text-[15px] leading-relaxed text-ink-dim">
          The server also ships two MCP prompts, <IC>spectrum-safety</IC> and <IC>spectrum-flows</IC>: the operating
          law (address provenance, review-then-confirm, floors never invented, the always-standing exit) and the
          worked buy, sell, and migrate sequences. Any prompt-aware client loads the safety persona for free.
          Repeated reads answer from a short cache; anything touching money runs fresh, every time.
        </p>
      </section>

      {/* ── quick start ── */}
      <section className="mt-14">
        <h2 className="font-display text-2xl font-bold uppercase tracking-tight text-ink">Run it in five minutes</h2>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <CodeBlock code={BUILD} title="build" />
          <CodeBlock code={REGISTER} title="register (Claude Desktop / Claude Code / any MCP client)" />
        </div>
        <Callout>
          Live buy and sell quotes simulate the real trade first, which needs an RPC supporting{' '}
          <IC>eth_simulateV1</IC> or state overrides. Provider endpoints qualify; some public ones do not. Reads,
          create, and the exit work on any RPC. Full detail lives in the kit&rsquo;s <IC>mcp/README.md</IC>.
        </Callout>
      </section>

      {/* ── the Bankr lane ── */}
      <section className="mt-14">
        <h2 className="font-display text-2xl font-bold uppercase tracking-tight text-ink">Bankr, and other agent marketplaces</h2>
        <p className="mt-2 max-w-3xl text-[15px] leading-relaxed text-ink-dim">
          The kit ships a ready Bankr skill (<IC>mcp/bankr-skill/</IC>): the instructions that teach a marketplace
          agent to drive baskets safely. It carries the whole safety posture in its text, refusal grammar included:
          addresses only from the server&rsquo;s own tools, nothing executes without the review shown and confirmed,
          and floors are never invented.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Pillar title="Where the runtime speaks MCP">
            The skill points at this server and the agent gets all {mcpManifest.tools.length} tools: reads, quotes,
            floored composes, the unconditional exit. Everything on this page, driven from the marketplace.
          </Pillar>
          <Pillar title="Everywhere else: deep links">
            No process to spawn? The skill hands the user pre-filled links into any Spectrum site: a trade console
            with basket, amount and chain already set, basket pages for reads, referral credit riding the URL. The
            user signs on-site with every protection intact.
          </Pillar>
        </div>
        <p className="mt-4 max-w-3xl text-[15px] leading-relaxed text-ink-dim">
          Submitting it to the Bankr registry takes one pull request; <IC>mcp/bankr-skill/SUBMITTING.md</IC> has the
          steps, and <IC>bash mcp/run.sh --check</IC> proves an install end to end before you send it.
        </p>
      </section>

      {/* ── closing row ── */}
      <div className="mt-14 flex flex-wrap items-center gap-4 border-t border-white/10 pt-8">
        <Link
          to="/chat"
          className="rounded-full px-5 py-2.5 font-display text-sm font-bold text-void transition-transform hover:scale-[1.03]"
          style={{ background: GRADIENT }}
        >
          Talk to Agent Specter
        </Link>
        <Link to="/docs" className="rounded-full border border-white/[0.16] bg-white/[0.06] px-5 py-2.5 text-sm text-ink transition-colors hover:border-white/[0.3]">
          Developer docs
        </Link>
        <Link to="/integrate" className="rounded-full border border-white/[0.16] bg-white/[0.06] px-5 py-2.5 text-sm text-ink transition-colors hover:border-white/[0.3]">
          Route baskets
        </Link>
      </div>
    </div>
  )
}
