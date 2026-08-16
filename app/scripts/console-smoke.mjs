#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// CONSOLE SMOKE — mount every route in a real browser and fail on anything the
// console screams about.
//
// WHY THIS EXISTS. The suite is 126 files and ~1630 tests, but 99 of them are
// pure logic under lib/spectrum and vitest runs with `environment: 'node'` —
// so no component is ever mounted, nothing is clicked, and no layout is
// measured. Typecheck, tests, lint and build were ALL GREEN while:
//   · two fixture baskets shared one address, so React logged a duplicate key
//     on /explore and every address-keyed lookup answered with whichever came
//     first (2026-08-07 — found by running this check by hand, nothing else);
//   · a sticky table column painted an opaque colour on a translucent card and
//     showed a black box behind the tickers on every basket page;
//   · the /create gap went NEGATIVE on a 700px-tall window.
// A gate that never renders the app cannot see any of that. This one renders it.
//
// NO NEW DEPENDENCY, deliberately. This is a self-host kit people clone; it is
// not getting playwright in devDependencies for one check. Node 22 ships a
// WebSocket client and every machine that can build this already has a
// Chromium, so the whole thing is CDP over the built-in socket.
//
// USAGE
//   npm run smoke:console                 build + preview + check every route
//   node scripts/console-smoke.mjs --base http://localhost:5309   use a running dev server
//   BROWSER_PATH=/path/to/chrome npm run smoke:console
//
// EXIT 0 clean · EXIT 1 a real console error, an uncaught exception, or a route
// that rendered nothing · EXIT 2 the harness itself could not run.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from 'node:child_process'
import http from 'node:http'
import { readFileSync, existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const externalBase = argOf('--base', null)
const settleMs = Number(argOf('--settle', 7000))
const CDP_PORT = Number(argOf('--cdp-port', 9333))
const PREVIEW_PORT = Number(argOf('--port', 4173))

// ── the noise allowlist ──────────────────────────────────────────────────────
// Every entry is a thing headless CANNOT do, not a thing we tolerate. Anything
// suppressed is counted and printed at the end, so this list can never quietly
// grow into a blindfold.
const NOISE = [
  { re: /WebGL|THREE\.|Paper Shaders|ShaderMount|webgl/i, why: 'headless has no GPU — the shader surfaces cannot mount' },
  { re: /Analytics SDK|analytics/i, why: 'no network to the analytics host in CI' },
  { re: /favicon|Failed to load resource|net::ERR_|ERR_NAME_NOT_RESOLVED/i, why: 'asset/network fetch outside the app' },
  { re: /rate limit|429|Too Many Requests/i, why: 'public RPC throttling is chain-side, not a kit defect' },
  { re: /WalletConnect|Content Security Policy|Lit is in dev mode/i, why: 'wallet/CSP chatter with no wallet present' },
]

// Routes come from App.tsx so a new page is covered the day it is added rather
// than the day someone remembers this file. Parameterised routes cannot be
// guessed, so they carry one representative URL each below.
function discoverRoutes() {
  const src = readFileSync(join(appDir, 'src/App.tsx'), 'utf8')
  const found = [...src.matchAll(/path="([^"]+)"/g)].map((m) => m[1])
  return found
    .filter((p) => p.startsWith('/') && !p.includes(':') && !p.includes('*'))
    // the test harnesses are developer fixtures, not user routes
    .filter((p) => !/-test$/.test(p))
    .sort()
}

// One representative deep link per parameterised route. A wrong-looking value is
// fine and even useful: the not-found path has to be quiet too.
//
// (The hostile-deployer STRING guarantee is NOT here. It cannot be: fixtures are
// `import.meta.env.DEV`-only by design — you do not ship fake baskets to
// production — and this smoke serves the production build by design, so a
// fixture basket never renders in the environment the smoke runs against. That
// guarantee lives in `src/lib/spectrum/deployer-strings.guard.test.ts`, a
// source scan that fails if a render site stops routing a deployer string
// through safe-copy. The a11y checks below DO belong here — they run on the
// real production routes and depend on no fixture.)
const DEEP_LINKS = [
  '/token?addr=0x0000000000000000000000000000000000ba5e01&chain=8453',
  '/no-such-page-404',
]

function findBrowser() {
  if (process.env.BROWSER_PATH) return process.env.BROWSER_PATH
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

// SERVE dist THE WAY A CONFIGURED HOST DOES, not the way `vite preview` does.
// `base: './'` makes index.html ask for `./assets/…`, which on a nested route
// resolves to `/portfolio/assets/…`; a plain SPA fallback answers that with
// index.html and the browser gets HTML where it wanted a module — a blank page
// that is an artifact of the SERVER, not of the app. Production handles it with
// one rewrite per nested route in `public/_redirects`; this is the same rule in
// its general form, so the smoke measures the app instead of the harness.
// (`src/redirects-coverage.test.ts` is what proves the real file has them all.)
function serveDist(port) {
  const root = join(appDir, 'dist')
  if (!existsSync(join(root, 'index.html'))) return null
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    let pathname = decodeURIComponent(url.pathname)
    // any depth of `…/assets/<file>` is the one real bundle
    pathname = pathname.replace(/^.*\/assets\//, '/assets/')
    const candidate = join(root, normalize(pathname).replace(/^(\.\.[/\\])+/, ''))
    let file = null
    if (candidate.startsWith(root) && existsSync(candidate) && statSync(candidate).isFile()) file = candidate
    else file = join(root, 'index.html') // SPA fallback
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  // A BUSY PORT MUST BE FATAL, never a shrug. An orphaned `vite preview` from an
  // earlier run held 4173 once and the smoke happily measured IT instead —
  // reporting three nested routes blank, because that server does not apply the
  // asset rewrite. A check that can silently grade the wrong server is worse
  // than no check.
  server.on('error', (err) => {
    console.error(`console-smoke: cannot serve on ${port} — ${err.message}`)
    console.error('  something else is already listening. Free the port, or pass --port <n>.')
    process.exit(2)
  })
  server.listen(port)
  return server
}

async function waitForServer(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual' })
      if (res.status < 500) return true
    } catch {
      /* not up yet */
    }
    await sleep(400)
  }
  return false
}

let seq = 0
function rpc(ws, method, params = {}) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id !== id) return
      ws.removeEventListener('message', onMsg)
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function cdpTarget(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* browser still starting */
    }
    await sleep(250)
  }
  return null
}

function argText(a) {
  if (a == null) return ''
  if (a.value !== undefined) return String(a.value)
  if (a.description) return a.description
  if (a.preview?.properties) return a.preview.properties.map((p) => `${p.name}=${p.value}`).join(' ')
  return ''
}

async function main() {
  if (typeof WebSocket === 'undefined') {
    console.error('console-smoke: this needs node 22+ (global WebSocket). Skipping is not a pass.')
    process.exit(2)
  }
  const browser = findBrowser()
  if (!browser) {
    console.error('console-smoke: no Chromium found. Set BROWSER_PATH=/path/to/chrome.')
    // In CI a missing browser must FAIL — a check that silently does not run is
    // worse than no check. Locally it is a skip with a loud line.
    process.exit(process.env.CI ? 2 : 0)
  }

  let server = null
  let base = externalBase
  if (!base) {
    base = `http://localhost:${PREVIEW_PORT}`
    server = serveDist(PREVIEW_PORT)
    if (!server) {
      console.error('console-smoke: no dist/index.html — run `npm run build` first.')
      process.exit(2)
    }
    // localhost, never 127.0.0.1: this repo has been bitten three times by the
    // v4 probe calling a healthy IPv6-bound server down.
    if (!(await waitForServer(base))) {
      server.close()
      console.error(`console-smoke: the static server never answered on ${base}.`)
      process.exit(2)
    }
  }

  const profile = mkdtempSync(join(tmpdir(), 'console-smoke-'))
  const proc = spawn(
    browser,
    ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-sandbox', '--disable-gpu', 'about:blank'],
    { stdio: 'ignore' },
  )

  const routes = [...discoverRoutes(), ...DEEP_LINKS]
  const failures = []
  const flaky = []
  const suppressed = new Map()

  try {
    const wsUrl = await cdpTarget(CDP_PORT)
    if (!wsUrl) throw new Error(`no CDP target on ${CDP_PORT}`)
    const ws = new WebSocket(wsUrl)
    await new Promise((res, rej) => {
      ws.onopen = res
      ws.onerror = rej
    })
    await rpc(ws, 'Page.enable')
    await rpc(ws, 'Runtime.enable')
    await rpc(ws, 'Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

    let bucket = []
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails
        bucket.push({ kind: 'uncaught exception', text: (d?.exception?.description ?? d?.text ?? '').slice(0, 300) })
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        bucket.push({ kind: 'console.error', text: m.params.args.map(argText).join(' ').slice(0, 300) })
      }
    })

    console.log(`console-smoke: ${routes.length} routes against ${base}\n`)

    // ONE RETRY, AND SAY SO. A cold CI runner occasionally needs longer than the
    // settle to paint, and a gate that cries wolf is a gate people start
    // ignoring — which is worse than no gate. But a silent retry would hide a
    // genuinely intermittent bug, so anything that only passed the second time
    // is listed at the end as flaky. Two failures in a row is a real failure.
    async function visit(route) {
      bucket = []
      await rpc(ws, 'Page.navigate', { url: base + route })
      await sleep(settleMs)

      const real = []
      for (const e of bucket) {
        const noise = NOISE.find((n) => n.re.test(e.text))
        if (noise) {
          suppressed.set(noise.why, (suppressed.get(noise.why) ?? 0) + 1)
          continue
        }
        real.push(e)
      }

      // A BLANK PAGE HAS NO CONSOLE ERRORS EITHER. Without this, a route that
      // renders nothing at all is the quietest — and therefore the "cleanest" —
      // route in the run. The bar is deliberately "did React mount anything",
      // not "is there a lot of text": /embed is a chrome-less card whose
      // not-found state is one honest sentence, and holding it to a word count
      // would fail an app that is behaving correctly.
      const { result } = await rpc(ws, 'Runtime.evaluate', {
        expression: `JSON.stringify({
          chars: (document.body?.innerText || '').trim().length,
          nodes: document.getElementById('root')?.querySelectorAll('*').length ?? 0,
        })`,
        returnByValue: true,
      })
      const painted = JSON.parse(result?.value ?? '{"chars":0,"nodes":0}')
      if (painted.nodes < 1 || painted.chars === 0) {
        real.push({
          kind: 'rendered nothing',
          text: `${painted.nodes} elements and ${painted.chars} chars under #root — the route mounted no content`,
        })
      }

      // BASIC ACCESSIBILITY, every route: an interactive control with no
      // accessible name and an image with no alt text are the two failures a
      // fast-built site ships most, and both are invisible to a sighted
      // reviewer. Deliberately narrow — this is a floor, not an audit — but a
      // floor that runs on all 34 routes automatically.
      const { result: a11y } = await rpc(ws, 'Runtime.evaluate', {
        expression: `(() => {
          const nameless = [...document.querySelectorAll('button, a[href], [role="button"]')].filter((el) => {
            const cs = getComputedStyle(el)
            if (cs.visibility === 'hidden' || cs.display === 'none' || el.getAttribute('aria-hidden') === 'true') return false
            const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').trim()
            return name.length === 0
          }).length
          const imgless = [...document.querySelectorAll('img')].filter((el) => el.getAttribute('alt') == null).length
          return JSON.stringify({ nameless, imgless })
        })()`,
        returnByValue: true,
      })
      const ax = JSON.parse(a11y?.value ?? '{"nameless":0,"imgless":0}')
      if (ax.nameless > 0) real.push({ kind: 'a11y', text: `${ax.nameless} interactive control(s) have no accessible name` })
      if (ax.imgless > 0) real.push({ kind: 'a11y', text: `${ax.imgless} image(s) have no alt attribute` })

      return real
    }

    for (const route of routes) {
      let real = await visit(route)
      if (real.length > 0) {
        // second look, with more room to settle
        await sleep(1500)
        const again = await visit(route)
        if (again.length === 0) {
          console.log(`  ✓ ${route}  (only on the second attempt)`)
          flaky.push(route)
          continue
        }
        real = again
      }
      if (real.length === 0) {
        console.log(`  ✓ ${route}`)
      } else {
        console.log(`  ✗ ${route}`)
        for (const e of real) console.log(`      ${e.kind}: ${e.text.replace(/\s+/g, ' ')}`)
        failures.push({ route, errors: real })
      }
    }
  } catch (err) {
    console.error(`console-smoke: harness failure — ${err.message}`)
    proc.kill('SIGKILL')
    server?.close()
    process.exit(2)
  } finally {
    proc.kill('SIGKILL')
    server?.close()
  }

  // Say what was filtered, always. A suppression list nobody reads is how a
  // real error ends up wearing a noise pattern's clothes.
  if (suppressed.size > 0) {
    console.log('\n  suppressed as environment noise:')
    for (const [why, n] of suppressed) console.log(`    ${String(n).padStart(3)} × ${why}`)
  }

  if (flaky.length > 0) {
    console.log(`\n  ⚠ passed only on a second attempt (slow to paint, or intermittent): ${flaky.join(', ')}`)
  }

  if (failures.length > 0) {
    console.error(`\nconsole-smoke: FAILED — ${failures.length} of ${routes.length} routes.`)
    process.exit(1)
  }
  console.log(`\nconsole-smoke: clean — ${routes.length} routes, no uncaught exceptions and no console errors.`)
}

await main()
