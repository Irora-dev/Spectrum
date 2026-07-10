import { LegalDoc, LegalSection } from '../components/LegalDoc'

// Copy reflects Spectrum's actual model (static, client-side, no accounts, no server)
// and the deployment model: the DEFAULT build ships no cookies/analytics/tracking;
// anything an operator adds on top is theirs to disclose here.
export function Privacy() {
  return (
    <LegalDoc
      title="Privacy"
      intro="This site is a static, client-side application. There are no accounts and no login, and the default build runs no server that collects your personal data. Here's what that means in practice."
    >
      <LegalSection title="No accounts">
        <p>
          You don&rsquo;t create an account or sign in with an email or social login. You connect a
          self-custodial wallet directly in your browser; that connection is held locally by your
          wallet, not by this site.
        </p>
      </LegalSection>

      <LegalSection title="What's public by nature">
        <p>
          Your wallet address and any onchain transactions you make are public on the blockchain, which
          is inherent to a public ledger, not something this site collects or controls.
        </p>
      </LegalSection>

      <LegalSection title="What stays in your browser">
        <p>
          If you follow a creator or basket, that preference is saved in your browser&rsquo;s local
          storage only. It is never uploaded, published, or shared, and clearing your browser data
          removes it.
        </p>
      </LegalSection>

      <LegalSection title="Data the app reads">
        <p>
          To display baskets, the app reads public onchain data through RPC providers and public market
          data from third-party APIs (for example, DexScreener for token prices). Those providers, and
          the hosting provider serving this site, may receive your IP address and standard request data
          under their own privacy policies — as with any website. This site does not sell personal
          data; the default build collects none to sell.
        </p>
      </LegalSection>

      <LegalSection title="Cookies and analytics">
        <p>
          The default build sets no cookies and ships no analytics, tracking, or error-reporting of any
          kind. If the operator of this deployment has added any such service, the operator is
          responsible for disclosing it on this page.
        </p>
      </LegalSection>

      <LegalSection title="Contact">
        <p>
          Privacy questions about this deployment go to its operator, through the contact channels the
          operator publishes.
        </p>
      </LegalSection>
    </LegalDoc>
  )
}
