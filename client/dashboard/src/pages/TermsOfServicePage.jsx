import { Divider, Link } from "@mui/material";
import LegalPageLayout, { List, Mail, P, Section } from "./LegalPageLayout.jsx";

export default function TermsOfServicePage() {
  return (
    <LegalPageLayout title="Terms of Service" lastUpdated="November 23, 2026">
      <P>
        These Terms of Service (&quot;Terms&quot;) govern your use of Datum, the analytics
        dashboard for e-commerce brands built and operated by TechIt (trytechit.co), including
        the web app at datum.trytechit.co and its APIs (together, the &quot;Service&quot;).
        &quot;We&quot; and &quot;us&quot; refer to TechIt. &quot;You&quot; means the person using
        the Service and, where you use it on behalf of a brand or company, that brand or company
        too. By using the Service you agree to these Terms. If you do not agree, do not use the
        Service.
      </P>

      <Divider />

      <Section title="1. The Service">
        <P>
          Datum brings together a brand&apos;s store, traffic, advertising and inventory data
          into dashboards, reports, alerts and insights. We may add, change or remove features
          over time to improve the Service. If a separate written agreement between your brand
          and TechIt covers the Service, that agreement takes priority over these Terms where
          the two conflict.
        </P>
      </Section>

      <Section title="2. Accounts and access">
        <List
          items={[
            "Access to Datum is granted by TechIt or by an administrator of your brand, who decides which brands and features you can see.",
            "You must give accurate information and keep your password, sign-in and any API keys confidential. You are responsible for activity under your account.",
            <>
              Tell us promptly at <Mail /> if you suspect unauthorized access to your account.
            </>,
            "You must be at least 18 years old and able to enter a binding agreement to use the Service.",
          ]}
        />
      </Section>

      <Section title="3. Your data and connected accounts">
        <P>
          Your brand keeps all rights to its data, including store data and data from connected
          advertising accounts such as Google Ads and Meta. You grant us permission to access,
          store and process that data only as needed to provide, secure and improve the Service
          for you, as described in our <Link href="/privacy-policy">Privacy Policy</Link>.
        </P>
        <P>
          When you connect a store or an advertising account, you confirm that you are authorized
          to do so on behalf of its owner. Your use of those platforms remains subject to their
          own terms, and you can disconnect them or revoke our access at any time.
        </P>
      </Section>

      <Section title="4. Acceptable use">
        <P>You agree not to:</P>
        <List
          items={[
            "use the Service for any unlawful purpose or in violation of these Terms;",
            "access, or try to access, data for brands you have not been authorized to see;",
            "interfere with or disrupt the Service, or probe, scan or test its security without our written permission;",
            "reverse engineer, copy or resell the Service, or use it to build a competing product;",
            "send excessive automated requests, or share API keys or sign-in credentials with anyone not authorized by your brand;",
            "upload malicious code or content that infringes anyone else's rights.",
          ]}
        />
      </Section>

      <Section title="5. Accuracy of data">
        <P>
          We work to keep the data and insights in Datum as accurate and reliable as possible.
          Much of it is collected from third-party sources outside our control, such as store
          platforms and advertising networks, which can be delayed, revised or incomplete. We
          therefore cannot guarantee absolute accuracy, and you should allow a margin of error of
          up to 5% when interpreting metrics and insights. Business decisions you make using the
          Service are your own responsibility.
        </P>
      </Section>

      <Section title="6. Fees">
        <P>
          Any fees for the Service are set out in your brand&apos;s agreement or order with
          TechIt. Questions about subscriptions or billing can be sent to <Mail />.
        </P>
      </Section>

      <Section title="7. Intellectual property">
        <P>
          The Service, including its software, design, text and graphics, belongs to TechIt and
          is protected by copyright, trademark and other laws. These Terms give you a limited,
          non-exclusive, non-transferable right to use the Service for your brand&apos;s internal
          business purposes while your access is active. If you send us feedback or suggestions,
          we may use them without any obligation to you.
        </P>
      </Section>

      <Section title="8. Third-party services">
        <P>
          The Service relies on third-party services such as Shopify, Google, Meta, Amazon Web
          Services and Vercel. We are not responsible for the availability or behavior of those
          services, and changes they make may affect features of the Service.
        </P>
      </Section>

      <Section title="9. Suspension and termination">
        <P>
          You can stop using the Service at any time. We may suspend or end your access if you
          breach these Terms, if your brand&apos;s agreement with TechIt ends, or if we need to
          protect the Service, other users or the law. When access ends, your right to use the
          Service stops, and we handle your data as described in the Privacy Policy. Sections 3,
          5, 7, 10 and 11 continue to apply after termination.
        </P>
      </Section>

      <Section title="10. Disclaimer">
        <P>
          The Service is provided &quot;as is&quot; and &quot;as available&quot;. To the fullest
          extent permitted by law, we disclaim all warranties, express or implied, including
          merchantability, fitness for a particular purpose and non-infringement. We do not
          promise that the Service will be uninterrupted or error-free.
        </P>
      </Section>

      <Section title="11. Limitation of liability">
        <P>
          To the fullest extent permitted by law, TechIt will not be liable for any indirect,
          incidental, special, consequential or punitive damages, or for any loss of profits,
          revenue, data or business opportunity, arising from your use of, or inability to use,
          the Service. Our total liability for any claim relating to the Service is limited to
          the fees your brand paid TechIt for the Service in the 12 months before the claim
          arose.
        </P>
      </Section>

      <Section title="12. Changes to these Terms">
        <P>
          We may update these Terms from time to time. The latest version will always be
          available at this page, with the date it was last updated shown at the top. If we make
          significant changes, we will let users know in the app or by email. Continuing to use
          the Service after changes take effect means you accept the updated Terms.
        </P>
      </Section>

      <Section title="13. Contact us">
        <P>
          Questions about these Terms can be sent to <Mail />.
        </P>
      </Section>
    </LegalPageLayout>
  );
}
