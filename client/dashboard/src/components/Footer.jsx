import { Box, Typography, Container, Stack, Link, Dialog, DialogTitle, DialogContent, IconButton, Tabs, Tab } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useState } from 'react';

const privacyContent = (
  <Stack spacing={2}>
    <Typography variant="h6">Privacy Policy</Typography>
    <Typography variant="caption" color="text.secondary">Last updated: 11/11/2025</Typography>
    <Typography variant="body2">At Datum, we value your privacy and are committed to protecting your personal information. This Privacy Policy explains how we collect, use, and safeguard your data when you use our app.</Typography>
    <Typography variant="subtitle2">1. Information We Collect</Typography>
    <Typography variant="body2" component="div">
      <ul style={{ margin: 0, paddingLeft: '1.1em' }}>
        <li>Usage Data: Information about how you use the app (e.g., sessions, clicks, device info).</li>
        <li>Personal Data (if applicable): Name, email, or account details you provide voluntarily.</li>
        <li>Cookies & Analytics: Used to improve app performance and user experience, including Microsoft Clarity session analytics on Datum.</li>
      </ul>
    </Typography>
    <Typography variant="subtitle2">2. How We Use Your Information</Typography>
    <Typography variant="body2" component="div">
      <ul style={{ margin: 0, paddingLeft: '1.1em' }}>
        <li>To operate, maintain, and improve the app.</li>
        <li>To personalize insights and analytics.</li>
        <li>To communicate important updates or provide support.</li>
      </ul>
    </Typography>
    <Typography variant="subtitle2">3. Data Security</Typography>
    <Typography variant="body2">We use industry-standard security measures to protect your data from unauthorized access, alteration, or disclosure.</Typography>
    <Typography variant="subtitle2">4. Sharing of Data</Typography>
    <Typography variant="body2">We do not sell or rent your data. We may share limited information with trusted service providers who help us operate the app (e.g., analytics, hosting), including Microsoft Clarity for product usage analysis.</Typography>
    <Typography variant="subtitle2">5. Updates to this Policy</Typography>
    <Typography variant="body2">We may update this Privacy Policy periodically. The latest version will always be available here.</Typography>
    <Typography variant="body2">For any questions regarding this policy, please contact us at <Link href="mailto:hello@trytechit.co">hello@trytechit.co</Link>.</Typography>
  </Stack>
);

const termsContent = (
  <Stack spacing={2}>
    <Typography variant="h6">Terms of Use</Typography>
    <Typography variant="caption" color="text.secondary">Last updated: 11/11/2025</Typography>
    <Typography variant="body2">Welcome to Datum. By using our app, you agree to these Terms of Use.</Typography>
    <Typography variant="subtitle2">1. Use of the App</Typography>
    <Typography variant="body2">Datum provides data analytics and insight tools for users. You agree to use the app only for lawful purposes and not to misuse, disrupt, or interfere with its normal operations.</Typography>
    <Typography variant="subtitle2">2. Intellectual Property</Typography>
    <Typography variant="body2">All content, design, and code within the app are the property of Datum and protected by applicable copyright and trademark laws.</Typography>
    <Typography variant="subtitle2">3. Disclaimer</Typography>
    <Typography variant="body2">Datum strives to provide data and insights that are as accurate and reliable as possible. However, since much of this data is aggregated from third-party sources not under our control, we cannot guarantee absolute accuracy. Users should consider a safe margin of error of up to 5% when interpreting analytics or insights provided through the app.</Typography>
    <Typography variant="subtitle2">4. Limitation of Liability</Typography>
    <Typography variant="body2">Datum will not be liable for any direct, indirect, or consequential damages arising from the use or inability to use the app.</Typography>
    <Typography variant="subtitle2">5. Termination</Typography>
    <Typography variant="body2">We reserve the right to suspend or terminate accounts that violate these terms or engage in misuse of the platform.</Typography>
    <Typography variant="subtitle2">6. Contact</Typography>
    <Typography variant="body2">For questions or concerns, please contact us at <Link href="mailto:hello@trytechit.co">hello@trytechit.co</Link>.</Typography>
  </Stack>
);

const supportContent = (
  <Stack spacing={2}>
    <Typography variant="h6">Support</Typography>
    <Typography variant="body2">Need help or have a question? We’re here for you.</Typography>
    <Typography variant="subtitle2">Get in touch</Typography>
    <Typography variant="body2">Email: <Link href="mailto:hello@trytechit.co">hello@trytechit.co</Link></Typography>
    <Typography variant="body2">Response Time: Within 1–2 business days</Typography>
    <Typography variant="body2">Support Hours: Monday–Friday, 10 AM – 6 PM IST</Typography>
    <Typography variant="subtitle2">Common Queries</Typography>
    <Typography variant="body2" component="div">
      <ul style={{ margin: 0, paddingLeft: '1.1em' }}>
        <li>Account access or login issues</li>
        <li>Data insights or dashboard errors</li>
        <li>Subscription or billing questions</li>
        <li>Bug reports and feature requests</li>
      </ul>
    </Typography>
    <Typography variant="body2">We value your feedback — every suggestion helps make Datum better for you.</Typography>
  </Stack>
);

export default function Footer() {
  const year = new Date().getFullYear();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('privacy');
  const handleOpen = (key) => { setTab(key); setOpen(true); };
  const handleClose = () => setOpen(false);

  return (
    <Box component="footer" sx={{ mt: 6, borderTop: '1px solid', borderColor: 'divider', bgcolor: 'background.default', py: 2 }}>
      <Container maxWidth={false} sx={{ maxWidth: 1320 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems="center" justifyContent="space-between" sx={{ textAlign: { xs: 'center', sm: 'left' } }}>
          <Typography variant="body2" color="text.secondary">©{year} Datum. All rights reserved.</Typography>
          <Stack direction="row" spacing={3} sx={{ opacity: 0.9 }}>
            <Link underline="hover" variant="caption" onClick={() => handleOpen('privacy')} sx={{ cursor: 'pointer', color: 'primary.main' }}>Privacy</Link>
            <Link underline="hover" variant="caption" onClick={() => handleOpen('terms')} sx={{ cursor: 'pointer', color: 'primary.main' }}>Terms</Link>
            <Link underline="hover" variant="caption" onClick={() => handleOpen('support')} sx={{ cursor: 'pointer', color: 'primary.main' }}>Support</Link>
          </Stack>
        </Stack>
      </Container>

      <Dialog open={open} onClose={handleClose} fullWidth maxWidth="md">
        <DialogTitle sx={{ pr: 5 }}>
          <Tabs value={tab} onChange={(e,v)=>setTab(v)} variant="scrollable" allowScrollButtonsMobile>
            <Tab value="privacy" label="Privacy" />
            <Tab value="terms" label="Terms" />
            <Tab value="support" label="Support" />
          </Tabs>
          <IconButton aria-label="close" onClick={handleClose} sx={{ position: 'absolute', right: 8, top: 8 }}>
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers sx={{ maxHeight: 560 }}>
          {tab === 'privacy' && privacyContent}
          {tab === 'terms' && termsContent}
          {tab === 'support' && supportContent}
        </DialogContent>
      </Dialog>
    </Box>
  );
}
