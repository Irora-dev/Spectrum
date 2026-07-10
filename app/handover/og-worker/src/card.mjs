// The per-basket OG card template (1200×630), as a satori element tree.
// Deliberately carries NO numbers (NAV/perf/TVL): link previews get cached by
// crawlers for days, and a stale performance figure in a social card is
// exactly the misleading-claim class §9 exists to prevent. Identity only:
// ticker, name, the brand, and a deterministic faux-bento drawn from the
// basket's address (same spirit as the site's wash identity).

const PALETTE = ['#35e0ff', '#a48bff', '#ff4db8', '#ff9248', '#34d6c4', '#7b5cff']

function hashUnit(s, salt) {
  let h = salt >>> 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return (h % 1013) / 1013
}

/** A deterministic 2×3 tile block echoing the basket's identity. */
function fauxBento(address) {
  const seed = address.toLowerCase()
  const tiles = []
  for (let i = 0; i < 6; i++) {
    const c = PALETTE[Math.floor(hashUnit(seed, i * 7 + 1) * PALETTE.length)]
    const grow = 1 + hashUnit(seed, i * 13 + 5) * 1.6
    tiles.push({
      type: 'div',
      props: {
        style: {
          flexGrow: grow,
          margin: 6,
          borderRadius: 14,
          background: `linear-gradient(135deg, ${c}66, ${c}22)`,
          border: `1px solid ${c}55`,
        },
      },
    })
  }
  return {
    type: 'div',
    props: {
      style: { display: 'flex', flexDirection: 'column', width: 380, height: 470, padding: 6 },
      children: [
        { type: 'div', props: { style: { display: 'flex', flex: 1 }, children: tiles.slice(0, 2) } },
        { type: 'div', props: { style: { display: 'flex', flex: 1.3 }, children: tiles.slice(2, 4) } },
        { type: 'div', props: { style: { display: 'flex', flex: 1 }, children: tiles.slice(4, 6) } },
      ],
    },
  }
}

/** Short 0x label, matching the site's shortAddr (first 6 + last 4). */
const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** Creator card (1200×630) — identity only, NO numbers (same §9 reason as the
 *  basket card: crawlers cache for days). The address drives both the headline
 *  label and the deterministic faux-bento, so each creator's card is distinct
 *  and stable without needing an ENS/handle lookup on the edge. */
export function buildCreatorCard({ address }) {
  const accent = PALETTE[Math.floor(hashUnit(address.toLowerCase(), 3) * PALETTE.length)]
  return {
    type: 'div',
    props: {
      style: {
        width: 1200,
        height: 630,
        display: 'flex',
        flexDirection: 'column',
        background: '#05050b',
        color: '#f5f4fa',
        fontFamily: 'Chakra Petch',
      },
      children: [
        { type: 'div', props: { style: { height: 10, width: '100%', background: 'linear-gradient(90deg,#35e0ff,#a48bff,#ff4db8)' } } },
        {
          type: 'div',
          props: {
            style: { display: 'flex', flex: 1, alignItems: 'center', padding: '0 72px' },
            children: [
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexDirection: 'column', flex: 1, paddingRight: 48 },
                  children: [
                    { type: 'div', props: { style: { fontSize: 30, letterSpacing: 10, color: '#8b8ca3', textTransform: 'uppercase' }, children: 'Spectrum · Creator' } },
                    { type: 'div', props: { style: { fontSize: 96, fontWeight: 700, lineHeight: 1.05, marginTop: 22, color: '#f5f4fa' }, children: shortAddr(address) } },
                    { type: 'div', props: { style: { fontSize: 40, marginTop: 14, color: '#b9bacb' }, children: 'Onchain baskets on Spectrum' } },
                    {
                      type: 'div',
                      props: {
                        style: { display: 'flex', alignItems: 'center', marginTop: 40 },
                        children: [
                          { type: 'div', props: { style: { width: 16, height: 16, borderRadius: 999, background: accent, marginRight: 14 } } },
                          { type: 'div', props: { style: { fontSize: 26, letterSpacing: 4, color: '#8b8ca3', textTransform: 'uppercase' }, children: 'Many assets · one token' } },
                        ],
                      },
                    },
                  ],
                },
              },
              fauxBento(address),
            ],
          },
        },
      ],
    },
  }
}

/** Referral-page card (1200×630) — static, no per-user data, no numbers. The
 *  hook for a shared /refer link; the page itself carries the detail. */
export function buildReferCard() {
  return {
    type: 'div',
    props: {
      style: {
        width: 1200,
        height: 630,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        background: '#05050b',
        color: '#f5f4fa',
        fontFamily: 'Chakra Petch',
      },
      children: [
        { type: 'div', props: { style: { height: 10, width: '100%', background: 'linear-gradient(90deg,#35e0ff,#a48bff,#ff4db8)' } } },
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column', flex: 1, justifyContent: 'center', padding: '0 80px' },
            children: [
              { type: 'div', props: { style: { fontSize: 30, letterSpacing: 10, color: '#8b8ca3', textTransform: 'uppercase' }, children: 'Spectrum · Refer & Earn' } },
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexDirection: 'column', fontSize: 100, fontWeight: 700, lineHeight: 1.1, marginTop: 20 },
                  children: [
                    { type: 'div', props: { style: { color: '#f5f4fa' }, children: 'Share Spectrum,' } },
                    { type: 'div', props: { style: { color: '#35e0ff' }, children: 'earn the fees.' } },
                  ],
                },
              },
              { type: 'div', props: { style: { fontSize: 40, marginTop: 24, color: '#b9bacb', maxWidth: 900 }, children: 'A slice of the protocol fee, onchain in USDC, on every trade and launch through your link. No signup.' } },
            ],
          },
        },
      ],
    },
  }
}

export function buildCard({ symbol, name, address }) {
  const accent = PALETTE[Math.floor(hashUnit(address.toLowerCase(), 3) * PALETTE.length)]
  return {
    type: 'div',
    props: {
      style: {
        width: 1200,
        height: 630,
        display: 'flex',
        flexDirection: 'column',
        background: '#05050b',
        color: '#f5f4fa',
        fontFamily: 'Chakra Petch',
      },
      children: [
        // the spectral hairline
        {
          type: 'div',
          props: { style: { height: 10, width: '100%', background: 'linear-gradient(90deg,#35e0ff,#a48bff,#ff4db8)' } },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', flex: 1, alignItems: 'center', padding: '0 72px' },
            children: [
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexDirection: 'column', flex: 1, paddingRight: 48 },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: { fontSize: 30, letterSpacing: 10, color: '#8b8ca3', textTransform: 'uppercase' },
                        children: 'Spectrum',
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        style: { fontSize: 128, fontWeight: 700, lineHeight: 1.05, marginTop: 18, color: '#f5f4fa' },
                        children: `$${symbol}`,
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        style: { fontSize: 42, marginTop: 12, color: '#b9bacb' },
                        children: name,
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        style: { display: 'flex', alignItems: 'center', marginTop: 40 },
                        children: [
                          {
                            type: 'div',
                            props: { style: { width: 16, height: 16, borderRadius: 999, background: accent, marginRight: 14 } },
                          },
                          {
                            type: 'div',
                            props: {
                              style: { fontSize: 26, letterSpacing: 4, color: '#8b8ca3', textTransform: 'uppercase' },
                              children: 'An onchain basket · one token',
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
              fauxBento(address),
            ],
          },
        },
      ],
    },
  }
}
