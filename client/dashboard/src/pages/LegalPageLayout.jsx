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

// Shared shell for the public legal pages (/privacy-policy, /terms-of-service).
// They render straight from main.jsx, outside <App />, so they need no login
// and make no API calls.

export const CONTACT_EMAIL = "hello@trytechit.co";

export function Section({ title, children }) {
  return (
    <Stack spacing={1.5} component="section">
      <Typography variant="h6" component="h2" sx={{ fontWeight: 600 }}>
        {title}
      </Typography>
      {children}
    </Stack>
  );
}

export function P({ children }) {
  return (
    <Typography variant="body1" sx={{ lineHeight: 1.7 }}>
      {children}
    </Typography>
  );
}

export function List({ items }) {
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

export const Mail = () => <Link href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</Link>;

export default function LegalPageLayout({ title, lastUpdated, children }) {
  const prefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  const theme = useMemo(
    () => createTheme({ palette: { mode: prefersDark ? "dark" : "light" } }),
    [prefersDark],
  );

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {/* Explicit colors: the app's global Tailwind/Polaris body styles would
          otherwise leave inherited text dark on a dark background. */}
      <Box sx={{ minHeight: "100vh", bgcolor: "background.default", color: "text.primary" }}>
        <Container maxWidth="md" sx={{ py: { xs: 4, md: 8 } }}>
          <Stack spacing={4}>
            <Stack spacing={1}>
              <Typography variant="h4" component="h1" sx={{ fontWeight: 700 }}>
                {title}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Last updated: {lastUpdated}
              </Typography>
            </Stack>

            {children}

            <Divider />
            <Typography variant="body2" color="text.secondary">
              © {new Date().getFullYear()} Datum by TechIt ·{" "}
              <Link href="/privacy-policy">Privacy Policy</Link> ·{" "}
              <Link href="/terms-of-service">Terms of Service</Link> ·{" "}
              <Link href="/data-deletion">Data Deletion</Link> ·{" "}
              <Link href="/">Back to Datum</Link>
            </Typography>
          </Stack>
        </Container>
      </Box>
    </ThemeProvider>
  );
}
