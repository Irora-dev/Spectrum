import { Link } from 'react-router-dom'
import brand from '../brand.config'
import { LegalDoc, LegalSection } from '../components/LegalDoc'

// Copy reflects Spectrum's actual model (self-custodial, onchain, creator-issued
// baskets, no accounts) and the deployment model (this app is open-source software
// any operator self-hosts; the operator runs the site, the creators run nothing).
export function Terms() {
  return (
    <LegalDoc
      title="Terms of Use"
      intro="These terms cover your use of this site. Spectrum is software for interacting with permissionless smart contracts; this site is one independently operated deployment of it. Please read these alongside the Risk Disclosure."
    >
      <LegalSection title="This site is an independent deployment">
        <p>
          This site ({brand.name}) is a self-hosted deployment of the open-source Spectrum
          interface, run by its own operator. It is not operated, endorsed, or controlled by the
          creators of the Spectrum software or the deployers of the underlying contracts, and
          running or using it creates no partnership, agency, or other relationship with them.
          The operator of this deployment is responsible for it. Anyone can run a site with this
          software — the site you are on is never the thing to trust; the contracts are (see the{' '}
          <Link to="/risk" className="text-cyan hover:underline">Risk Disclosure</Link> on
          verifying addresses).
        </p>
      </LegalSection>

      <LegalSection title="What Spectrum is">
        <p>
          Spectrum is a software interface to a set of permissionless, immutable smart contracts
          for creating and reading onchain basket tokens. It is non-custodial: neither this site
          nor the software holds your assets, executes transactions on your behalf, or manages any
          basket. You interact directly with the contracts from your own wallet.
        </p>
      </LegalSection>

      <LegalSection title="Baskets are issued by their creators">
        <p>
          Each basket is deployed by a third-party creator, who is its issuer and is solely responsible
          for it, including its composition, naming, fee configuration, and any description they
          provide. Spectrum is not the issuer of, and does not endorse, any basket. Listing or display
          of a basket is not a recommendation.
        </p>
      </LegalSection>

      <LegalSection title="Not advice or an offer">
        <p>
          Nothing on Spectrum is financial, investment, legal, or tax advice, a solicitation, or a
          recommendation to buy, sell, or hold anything. You are responsible for your own decisions.
        </p>
      </LegalSection>

      <LegalSection title="Wallets and self-custody">
        <p>
          You connect and use your own self-custodial wallet. You are responsible for securing your
          keys and for all activity from your wallet. Onchain transactions are irreversible and settle
          on public blockchains outside Spectrum&rsquo;s control.
        </p>
      </LegalSection>

      <LegalSection title="Fees">
        {/* Burn copy — the "pool mint/redeem fees" qualifier is load-bearing: the
            in-kind exit's haircut stays with remaining holders and never feeds the
            burn. */}
        <p>
          The fee rate varies per basket and is set by each basket&rsquo;s creator at launch, within
          protocol bounds, immutably. A fixed protocol share of every fee goes to an autonomous PRISM
          buy-and-burn — the same on every basket, set by the protocol rather than the creator — and
          fixed protocol interface and launcher shares are carved off the rest only when a routing
          interface or a launcher is attached. Of what remains, the creator takes a single share they
          fix at launch (bounded by the protocol, and removable) and basket holders receive the rest;
          there is no creator-defined routing table. Each basket&rsquo;s page shows its exact split,
          read live from its contract. Network (gas) costs apply separately. Neither this site nor the
          software charges a separate management or subscription fee. All of this is a factual
          description of how the contracts work — it is not an inducement, and not a promise of
          earnings to anyone.
        </p>
      </LegalSection>

      <LegalSection title="Eligibility and your responsibility">
        <p>
          You must be permitted to use a service like this under the laws that apply to you, and you
          must not use it where doing so is restricted. You are responsible for determining and meeting
          your own legal and tax obligations, including any that arise from deploying a basket. The
          operator of this deployment is responsible for any access restrictions, notices, or
          registrations required where it operates.
        </p>
      </LegalSection>

      <LegalSection title="Open source and license">
        <p>
          The software behind this site is open source, dedicated to the public domain under{' '}
          <a
            href="https://creativecommons.org/publicdomain/zero/1.0/"
            target="_blank"
            rel="noreferrer"
            className="text-cyan hover:underline"
          >
            CC0 1.0
          </a>{' '}
          (see the LICENSE file in the repository the software ships from). Anyone may run, modify,
          and redeploy it. &ldquo;Powered by Spectrum&rdquo; describes the software this site is built
          with, nothing more; a deployment&rsquo;s own branding and modifications belong to its
          operator, and no deployment may present itself as official or as the protocol itself.
        </p>
      </LegalSection>

      <LegalSection title="No warranty; limitation of liability">
        <p>
          The interface and contracts are provided &ldquo;as is,&rdquo; without warranties of any kind,
          and may contain errors. To the maximum extent permitted by law, neither the operator of this
          deployment nor the Spectrum contributors are liable for any losses arising from your use of
          this site, the software, the contracts, or any basket.
        </p>
      </LegalSection>

      <LegalSection title="Changes">
        <p>
          These terms may be updated. Continued use after a change means you accept the updated terms.
          See also the <Link to="/risk" className="text-cyan hover:underline">Risk Disclosure</Link> and{' '}
          <Link to="/privacy" className="text-cyan hover:underline">Privacy</Link> notice.
        </p>
      </LegalSection>
    </LegalDoc>
  )
}
