import { Divider, Link } from "@mui/material";
import LegalPageLayout, { CONTACT_EMAIL, List, Mail, P, Section } from "./LegalPageLayout.jsx";

const DELETION_MAILTO = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(
  "Data deletion request",
)}`;

export default function DataDeletionPage() {
  return (
    <LegalPageLayout title="Data Deletion" lastUpdated="November 24, 2026">
      <P>
        You can ask us to delete the data Datum holds about you or your brand at any time. Datum
        is built and operated by TechIt (trytechit.co). This page explains how to make a request
        and what happens next.
      </P>

      <Divider />

      <Section title="1. How to request deletion">
        <P>
          Email us at{" "}
          <Link href={DELETION_MAILTO}>{CONTACT_EMAIL}</Link> with the subject &quot;Data
          deletion request&quot;. Please send it from the email address you use to sign in to
          Datum, and include:
        </P>
        <List
          items={[
            "the email address of your Datum account;",
            "the brand or store your request relates to;",
            "what you want deleted: your personal account, a connected Google Ads or Meta account, or all of your brand's data.",
          ]}
        />
      </Section>

      <Section title="2. What we delete">
        <List
          items={[
            "Your account: your name, email address, role, sign-in details, browser notification tokens and session history.",
            "Connected advertising accounts: the stored Google Ads or Meta access tokens and the advertising data we imported with them.",
            "Brand data, when requested by the brand: the store, traffic, inventory and advertising data Datum processed for that brand, along with its dashboards, alerts and support requests.",
          ]}
        />
        <P>
          We may keep a limited record of the request itself, and any information we are legally
          required to keep, such as for accounting or security purposes.
        </P>
      </Section>

      <Section title="3. What happens next">
        <P>
          We will confirm your identity using the email address on your account, and may reply
          to ask for more details if we need them. Once the deletion is done, we will email you
          to confirm it.
        </P>
      </Section>

      <Section title="4. Removing Datum's access yourself">
        <P>
          You can also stop Datum from receiving any new data from your Google or Facebook
          account straight away:
        </P>
        <List
          items={[
            <>
              Google: remove Datum at{" "}
              <Link
                href="https://myaccount.google.com/permissions"
                target="_blank"
                rel="noopener noreferrer"
              >
                myaccount.google.com/permissions
              </Link>
              .
            </>,
            <>
              Facebook: go to Settings &amp; privacy → Settings → Business Integrations, select
              Datum and choose Remove.
            </>,
          ]}
        />
        <P>
          Removing access stops new data from being collected. To delete the data we already
          hold, email us as described above.
        </P>
      </Section>

      <Section title="5. Questions">
        <P>
          For anything else about your data, see our{" "}
          <Link href="/privacy-policy">Privacy Policy</Link> or contact us at <Mail />.
        </P>
      </Section>
    </LegalPageLayout>
  );
}
