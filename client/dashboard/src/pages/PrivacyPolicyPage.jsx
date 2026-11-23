import { useMemo } from "react";
import {
  Box,
  Container,
  CssBaseline,
  Divider,
  Link,
  Stack,
  ThemeProvider,
  Typography,
  createTheme,
  useMediaQuery,
} from "@mui/material";

// Public page served at /privacy-policy. Rendered straight from main.jsx,
// outside <App />, so it needs no login and makes no API calls.

const LAST_UPDATED = "November 23, 2026";
const CONTACT_EMAIL = "hello@trytechit.co";

function Section({ title, children }) {
  return (
    <Stack spacing={1.5} component="section">
      <Typography variant="h6" component="h2" sx={{ fontWeight: 600 }}>
        {title}
      </Typography>
      {children}
    </Stack>
  );
}

function P({ children }) {
  return (
    <Typography variant="body1" sx={{ lineHeight: 1.7 }}>
      {children}
    </Typography>
  );
}

function List({ items }) {
  return (
    <Box component="ul" sx={{ m: 0, pl: 3, "& li": { mb: 1, lineHeight: 1.7 } }}>
      {items.map((item, i) => (
        <Typography component="li" variant="body1" key={i}>
          {item}
        </Typography>
      ))}
    </Box>
  );
}

const mail = <Link href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</Link>;

export default function PrivacyPolicyPage() {
  const prefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  const theme = useMemo(
    () => createTheme({ palette: { mode: prefersDark ? "dark" : "light" } }),
    [prefersDark],
  );

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Container maxWidth="md" sx={{ py: { xs: 4, md: 8 } }}>
        <Stack spacing={4}>
          <Stack spacing={1}>
            <Typography variant="h4" component="h1" sx={{ fontWeight: 700 }}>
              Privacy Policy
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Last updated: {LAST_UPDATED}
            </Typography>
          </Stack>

          <P>
            Datum is an analytics dashboard for e-commerce brands, built and operated by TechIt
            (trytechit.co). This policy explains what information Datum collects, how we use it,
            who we share it with, and the choices you have. It applies to the Datum web app at
            datum.trytechit.co and its APIs. Throughout this policy, &quot;Datum&quot;,
            &quot;we&quot; and &quot;us&quot; refer to TechIt as the operator of Datum.
          </P>

          <Divider />

          <Section title="1. Information we collect">
            <P>
              <strong>Account information.</strong> When you are given access to Datum, we store
              your name, email address, the brands you can access and your role. If you sign in
              with a password, we store only a salted hash of it, never the password itself. If
              you sign in with Google, we receive your name, email address and profile picture
              from Google (the <code>openid</code>, <code>email</code> and <code>profile</code>{" "}
              scopes) and use them only to identify you.
            </P>
            <P>
              <strong>Store data.</strong> To build your dashboards we process data from the
              online stores of the brands you work with, including orders, products, inventory,
              discount codes, traffic sources and storefront session events. This data belongs to
              the brand and is processed on its behalf.
            </P>
            <P>
              <strong>Advertising account data.</strong> If a brand connects its Google Ads or
              Meta (Facebook and Instagram) ad accounts, we receive an access token for that
              connection and use it to read reporting data: account IDs and names, campaigns, ad
              groups, ads and their spend, impressions, clicks, conversions and conversion value.
              We use this only to show advertising performance and profit and loss in Datum. We
              do not create, edit, pause or delete campaigns, and we do not access your payment
              methods.
            </P>
            <P>
              <strong>Usage and device information.</strong> When you use Datum we record your
              session: a session ID, your user ID and email, the brand you are viewing, the page
              you are on, your browser and operating system, screen size, time zone and IP
              address. We use Microsoft Clarity to understand how the product is used (for
              example clicks, scrolling and page views), and Sentry to capture errors and
              performance problems so we can fix them.
            </P>
            <P>
              <strong>Notifications.</strong> If you allow browser notifications, we store a
              Firebase Cloud Messaging device token so we can send you alerts, such as low
              inventory or metric changes for your brands.
            </P>
            <P>
              <strong>Support requests.</strong> When you raise a request in Datum, we store its
              content, comments, status and the people involved, and keep it in sync with our
              task tracker (Todoist) so our team can resolve it.
            </P>
            <P>
              <strong>Information stored in your browser.</strong> Datum keeps your sign-in token
              and interface preferences (such as the selected brand, tab, filters and light or
              dark theme) in your browser&apos;s local storage so you stay signed in and the app
              remembers your settings. We do not use advertising cookies.
            </P>
          </Section>

          <Section title="2. How we use information">
            <List
              items={[
                "To sign you in, keep your account secure and show you only the brands you are authorized to see.",
                "To compute and display sales, traffic, funnel, inventory, advertising and profit metrics for those brands.",
                "To send alerts and notifications you have enabled.",
                "To respond to support requests and communicate important service updates.",
                "To monitor reliability, diagnose errors and improve Datum.",
                "To prevent abuse and meet legal obligations.",
              ]}
            />
            <P>We do not sell personal information, and we do not use it for advertising.</P>
          </Section>

          <Section title="3. Google user data">
            <P>
              Datum&apos;s use and transfer of information received from Google APIs to any other
              app will adhere to the{" "}
              <Link
                href="https://developers.google.com/terms/api-services-user-data-policy"
                target="_blank"
                rel="noopener noreferrer"
              >
                Google API Services User Data Policy
              </Link>
              , including the Limited Use requirements. Specifically:
            </P>
            <List
              items={[
                "Data from Google Sign-In is used only to authenticate you.",
                "Data from the Google Ads API is used only to show the connected brand its own advertising performance inside Datum.",
                "We do not use Google user data to serve advertisements, and we do not sell it or transfer it to third parties except as needed to provide Datum, to comply with law, or as part of a merger or acquisition.",
                "Our staff do not read this data except with your permission, for security purposes, to comply with law, or when it has been aggregated for internal operations.",
                "We do not use Google user data to develop, improve or train generalized artificial intelligence or machine learning models.",
              ]}
            />
          </Section>

          <Section title="4. Who we share information with">
            <P>
              We share information only with service providers that help us run Datum, and only
              as much as they need to do so:
            </P>
            <List
              items={[
                "Amazon Web Services: hosting of our servers and databases.",
                "Vercel: hosting of the Datum web app.",
                "Google: sign-in, the Google Ads API and Firebase Cloud Messaging.",
                "Meta: the Meta Marketing API, for connected ad accounts.",
                "Shopify: the source of store data for connected brands.",
                "Microsoft Clarity: product usage analytics.",
                "Sentry: error and performance monitoring.",
                "Todoist: tracking of support requests.",
              ]}
            />
            <P>
              We may also disclose information if required by law, to protect the rights and
              safety of our users or others, or to a successor if TechIt is involved in a merger,
              acquisition or sale of assets.
            </P>
          </Section>

          <Section title="5. Security">
            <P>
              All traffic to Datum is encrypted with HTTPS. Access tokens for connected Google Ads
              and Meta accounts are encrypted before they are stored. Each brand&apos;s data is
              isolated, and every request is authenticated and checked against the brands and
              permissions assigned to you. No system is perfectly secure, but we work to protect
              your information and will notify affected users of a breach where the law requires.
            </P>
          </Section>

          <Section title="6. Retention">
            <P>
              We keep account information for as long as your account is active. We keep brand
              data, including connected advertising data, for as long as the brand uses Datum. When
              an account is closed or a brand stops using Datum, we delete or anonymize the related
              data, unless we must keep it to meet legal, accounting or security obligations.
            </P>
          </Section>

          <Section title="7. Your choices and rights">
            <List
              items={[
                <>
                  You can revoke Datum&apos;s access to your Google account at any time at{" "}
                  <Link
                    href="https://myaccount.google.com/permissions"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    myaccount.google.com/permissions
                  </Link>
                  , and to your Meta account in your Facebook settings under Business
                  Integrations.
                </>,
                "You can turn off browser notifications at any time in your browser settings.",
                "You can clear the information Datum stores in your browser by signing out or clearing your browser's site data.",
                <>
                  You can ask us to access, correct, export or delete your personal information,
                  or to disconnect an advertising account, by emailing {mail}. We may need to
                  verify your identity first.
                </>,
              ]}
            />
          </Section>

          <Section title="8. Children">
            <P>
              Datum is a business tool and is not intended for anyone under 18. We do not
              knowingly collect information from children.
            </P>
          </Section>

          <Section title="9. Changes to this policy">
            <P>
              We may update this policy from time to time. The latest version will always be
              available at this page, with the date it was last updated shown at the top. If we
              make significant changes, we will let users know in the app or by email.
            </P>
          </Section>

          <Section title="10. Contact us">
            <P>Questions or requests about this policy or your data can be sent to {mail}.</P>
          </Section>

          <Divider />
          <Typography variant="body2" color="text.secondary">
            © {new Date().getFullYear()} Datum by TechIt. <Link href="/">Back to Datum</Link>
          </Typography>
        </Stack>
      </Container>
    </ThemeProvider>
  );
}
