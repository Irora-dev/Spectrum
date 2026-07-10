import { Link } from 'react-router-dom'
import { LegalDoc, LegalSection } from '../components/LegalDoc'

// Copy reflects Spectrum's actual model (onchain, self-custodial, creator-issued,
// NAV from static on-chain views cross-checked off-chain) plus the deployment model:
// anyone can run a site with this software, so "verify the contract, not the site"
// is the load-bearing disclosure — keep it prominent.
export function Risk() {
  return (
    <LegalDoc
      title="Risk Disclosure"
      intro="Interacting with onchain assets carries real risk. Please read this before you do. If anything here is unclear, don't proceed until it is."
    >
      <LegalSection title="You can lose money">
        <p>
          Onchain assets are volatile and can fall sharply and quickly. You can lose some or all of
          what you put in. Only commit what you can afford to lose entirely.
        </p>
      </LegalSection>

      <LegalSection title="No guarantees">
        <p>
          Nothing in a basket, its chart, or any description is a promise of anything. Past performance
          does not predict future results, and a value shown now can change at any moment.
        </p>
      </LegalSection>

      <LegalSection title="Smart-contract and transaction risk">
        <p>
          Spectrum is software interacting with smart contracts that may contain bugs or behave unexpectedly.
          Onchain transactions are irreversible and settle on public blockchains, and a mistaken or
          malicious transaction generally cannot be undone.
        </p>
      </LegalSection>

      <LegalSection title="Verify the contract, not the site">
        <p>
          Spectrum is open-source software: anyone can run a site with it, including bad actors
          pointing a lookalike site at counterfeit contracts. The site you are on is never the thing
          to trust — the contracts are, and no website (this one included) is an address authority;
          the chain is. Before you sign anything, check that the contract addresses this site is
          configured with match a source you trust: open them on the block explorer, confirm the
          contracts are verified, and check the deployer. This site&rsquo;s{' '}
          <Link to="/verify" className="text-cyan hover:underline">verify page</Link> shows exactly
          which addresses this deployment runs on and checks them against the protocol&rsquo;s
          published anchor where one resolves — an &ldquo;unverifiable&rdquo; result means it could
          not confirm, never that a site is safe. If addresses differ from a verified canonical
          deployment, or a site hides them, leave.
        </p>
      </LegalSection>

      <LegalSection title="Creator / issuer risk">
        <p>
          Each basket is created and issued by a third party, not by Spectrum. Its composition, weights,
          fee routing, and the creator&rsquo;s conduct are their responsibility. Anyone can deploy a
          basket, including ones that are low-quality, illiquid, or named misleadingly. Do your own
          diligence.
        </p>
      </LegalSection>

      <LegalSection title="Concentration and liquidity">
        <p>
          A basket can be concentrated in a few holdings or a single theme, and its constituents may be
          thinly traded. A focused or illiquid basket can move far more than the broad market, in either
          direction, and may be costly to exit.
        </p>
      </LegalSection>

      <LegalSection title="Pricing and data">
        <p>
          A basket&rsquo;s displayed value (NAV) comes primarily from its own static on-chain views,
          which are display-grade marks, they report whether every constituent was priced, and they
          are not a manipulation-resistant oracle. This app cross-checks them against public market
          data, which can be delayed, incomplete, or wrong; historical charts are reconstructed
          off-chain. Displayed values are estimates, not a guaranteed exit price. (See the{' '}
          <Link to="/docs/valuation" className="text-cyan hover:underline">valuation method</Link>.)
        </p>
      </LegalSection>

      <LegalSection title="Exit mechanics">
        {/* Keep this framed as a mechanical contract swap — never a
            "fund redemption right". */}
        <p>
          Every basket exposes an unconditional in-kind exit: <code className="font-mono text-ink">redeemInKind</code>{' '}
          is a mechanical contract swap that returns the underlying constituent tokens pro-rata. It
          never routes through a pool, so it works even if every pool is dead; a per-leg mask lets the
          caller explicitly skip a frozen or reverting constituent (the skipped share stays in reserve
          for remaining holders). What those constituents are then worth, and whether they can be
          sold, is your risk.
        </p>
      </LegalSection>
    </LegalDoc>
  )
}
