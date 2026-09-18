import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import dayjs from "dayjs";
import {
  connectMetaAds,
  disconnectMetaAds,
  getMetaAdsStatus,
  getMetaOauthConfig,
  listMetaOauthAdAccounts,
} from "../../../lib/api.js";

const OAUTH_PENDING_KEY = "meta_oauth_pending_brand";

function parseHashParams(hash) {
  return Object.fromEntries(new URLSearchParams((hash || "").replace(/^#/, "")));
}

function describeAccount(account) {
  const bits = [account.id];
  if (account.currency) bits.push(account.currency);
  if (account.accountStatusLabel) bits.push(account.accountStatusLabel);
  return bits.join(" · ");
}

export default function PnlMetaAdsSection({ brandKey, onConnectionChange }) {
  const [status, setStatus] = useState(null);
  const [loadingStatus, setLoadingStatus] = useState(false);

  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState("");
  const [connectMessage, setConnectMessage] = useState("");

  const [disconnecting, setDisconnecting] = useState(false);

  // Set once Meta redirects back with a user token: the brand the connect was
  // started for, the token itself, and the ad accounts that token can see.
  // The token lives only in memory — a refresh mid-pick means reconnecting.
  const [pending, setPending] = useState(null); // { brandKey, accessToken }
  const [adAccounts, setAdAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!brandKey) return;
    let cancelled = false;
    setLoadingStatus(true);
    getMetaAdsStatus({ brand_key: brandKey }).then((statusResult) => {
      if (cancelled) return;
      setStatus(statusResult.error ? null : statusResult.data);
      setLoadingStatus(false);
    });
    return () => {
      cancelled = true;
    };
  }, [brandKey]);

  // Meta's OAuth dialog sets Cross-Origin-Opener-Policy: same-origin, which
  // severs window.opener the moment a popup navigates there — so a
  // popup+postMessage handoff back to this tab is unreliable. Instead we
  // navigate this same tab away to Meta and back: on return, the token is in
  // the URL hash and sessionStorage tells us a connect was in flight.
  //
  // The token is a user-level grant (ads_read covers every ad account the
  // user can see), so Meta never asks which account — we list them here and
  // let the brand pick before anything is saved.
  useEffect(() => {
    const pendingBrand = window.sessionStorage.getItem(OAUTH_PENDING_KEY);
    const params = parseHashParams(window.location.hash);
    if (!pendingBrand) return;
    if (!params.access_token) {
      // Came back without a token (user cancelled the dialog, or Meta errored).
      if (params.error || params.error_description) {
        window.sessionStorage.removeItem(OAUTH_PENDING_KEY);
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
        setConnectError(params.error_description || params.error || "Meta did not return a token.");
      }
      return;
    }

    window.sessionStorage.removeItem(OAUTH_PENDING_KEY);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);

    const accessToken = params.access_token;
    setPending({ brandKey: pendingBrand, accessToken });
    setConnecting(true);
    setConnectError("");
    setConnectMessage("");

    listMetaOauthAdAccounts({ brand_key: pendingBrand, access_token: accessToken })
      .then((result) => {
        setConnecting(false);
        if (result.error) {
          setPending(null);
          setConnectError(result.data?.error || "Failed to list ad accounts for this Meta login.");
          return;
        }
        const accounts = Array.isArray(result.data?.accounts) ? result.data.accounts : [];
        if (accounts.length === 0) {
          setPending(null);
          setConnectError("This Meta login has no ad accounts. Log in with a user who can see the brand's account.");
          return;
        }
        setAdAccounts(accounts);
        setSelectedAccountId(accounts.length === 1 ? accounts[0].id : "");
      })
      .catch(() => {
        setConnecting(false);
        setPending(null);
        setConnectError("Failed to list ad accounts for this Meta login.");
      });
    // Only meant to run once, on the redirect back from Meta.
  }, []);

  const handleConnectWithMeta = async () => {
    setConnecting(true);
    setConnectError("");
    setConnectMessage("");

    const config = await getMetaOauthConfig({ brand_key: brandKey });
    if (config.error || !config.data?.appId) {
      setConnecting(false);
      setConnectError(config.data?.error || "Meta app is not configured on the backend.");
      return;
    }

    const { appId, apiVersion, scope } = config.data;
    const redirectUri = `${window.location.origin}${window.location.pathname}`;
    const oauthUrl = `https://www.facebook.com/${apiVersion}/dialog/oauth?${new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      response_type: "token",
      scope,
    })}`;

    window.sessionStorage.setItem(OAUTH_PENDING_KEY, brandKey);
    window.location.assign(oauthUrl);
  };

  const resetPending = () => {
    setPending(null);
    setAdAccounts([]);
    setSelectedAccountId("");
  };

  // Posts the picked account + user token to the real connect endpoint, which
  // verifies the pair against Graph, exchanges for a long-lived token, and
  // stores it encrypted in meta_ads_credentials.
  const handleSaveAccount = async () => {
    if (!pending || !selectedAccountId) return;
    setSaving(true);
    setConnectError("");
    const result = await connectMetaAds({
      brand_key: pending.brandKey,
      ad_account_id: selectedAccountId,
      access_token: pending.accessToken,
    });
    setSaving(false);
    if (result.error) {
      setConnectError(result.data?.error || "Failed to connect the ad account.");
      return;
    }
    resetPending();
    setStatus(result.data);
    setConnectMessage("Meta ad account connected.");
    onConnectionChange?.();
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    await disconnectMetaAds({ brand_key: brandKey });
    setDisconnecting(false);
    setStatus({ connected: false });
    setConnectMessage("");
    onConnectionChange?.();
  };

  const pickerForOtherBrand = pending && brandKey && pending.brandKey !== brandKey;

  return (
    <Card variant="outlined" sx={{ p: 2.5 }}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        alignItems={{ xs: "flex-start", sm: "center" }}
        justifyContent="space-between"
        spacing={1}
        sx={{ mb: 2 }}
      >
        <Stack spacing={0.25}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Meta Ads Integration
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Connect this brand&apos;s Meta Ads account to pull real ad spend into the Meta line above.
          </Typography>
        </Stack>
        {status?.connected ? <Chip label="Connected" size="small" color="success" /> : null}
      </Stack>

      {loadingStatus ? (
        <CircularProgress size={20} />
      ) : pending ? (
        <Stack spacing={1.5} sx={{ maxWidth: 480 }}>
          <Typography variant="body2" color="text.secondary">
            Meta login succeeded. Pick the ad account to connect
            {pickerForOtherBrand ? ` for brand ${pending.brandKey}` : ""}.
          </Typography>
          {pickerForOtherBrand ? (
            <Alert severity="warning">
              This connect was started for brand <strong>{pending.brandKey}</strong>, not the one currently
              selected. Cancel and reconnect if that isn&apos;t what you want.
            </Alert>
          ) : null}
          {connectError ? <Alert severity="error">{connectError}</Alert> : null}
          {connecting ? (
            <Stack direction="row" spacing={1} alignItems="center">
              <CircularProgress size={16} />
              <Typography variant="body2">Loading your ad accounts…</Typography>
            </Stack>
          ) : (
            <FormControl size="small" fullWidth>
              <InputLabel id="meta-ad-account-label">Ad account</InputLabel>
              <Select
                labelId="meta-ad-account-label"
                label="Ad account"
                value={selectedAccountId}
                onChange={(event) => setSelectedAccountId(event.target.value)}
              >
                {adAccounts.map((account) => (
                  <MenuItem key={account.id} value={account.id}>
                    <Stack spacing={0}>
                      <Typography variant="body2">{account.name}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {describeAccount(account)}
                      </Typography>
                    </Stack>
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}
          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              size="small"
              onClick={handleSaveAccount}
              disabled={saving || connecting || !selectedAccountId}
            >
              {saving ? "Connecting…" : "Connect this account"}
            </Button>
            <Button size="small" onClick={resetPending} disabled={saving}>
              Cancel
            </Button>
          </Stack>
        </Stack>
      ) : status?.connected ? (
        <Stack spacing={1}>
          {connectMessage ? <Alert severity="success">{connectMessage}</Alert> : null}
          <Typography variant="body2">
            Ad account <strong>{status.adAccountId}</strong>
          </Typography>
          {status.lastVerifiedAt ? (
            <Typography variant="caption" color="text.secondary">
              Last verified {dayjs(status.lastVerifiedAt).format("MMM DD, YYYY HH:mm")}
              {status.expiresAt ? ` · token expires ${dayjs(status.expiresAt).format("MMM DD, YYYY")}` : ""}
            </Typography>
          ) : null}
          {status.lastError ? (
            <Alert severity="warning">
              Last fetch failed: {status.lastError}. The P&amp;L page is showing an estimate until this is
              fixed.
            </Alert>
          ) : null}
          <Stack direction="row" spacing={1}>
            <Button size="small" color="error" onClick={handleDisconnect} disabled={disconnecting}>
              {disconnecting ? "Disconnecting…" : "Disconnect"}
            </Button>
          </Stack>
        </Stack>
      ) : (
        <Box>
          <Stack spacing={1.5} sx={{ maxWidth: 480 }}>
            <Typography variant="body2" color="text.secondary">
              You&apos;ll be sent to Meta to log in, then asked which ad account to connect. The token is
              verified, exchanged for a long-lived one, and stored encrypted.
            </Typography>
            {connectError ? <Alert severity="error">{connectError}</Alert> : null}
            {connectMessage ? <Alert severity="success">{connectMessage}</Alert> : null}
            <Box>
              <Button variant="contained" size="small" onClick={handleConnectWithMeta} disabled={connecting}>
                {connecting ? "Redirecting to Meta…" : "Connect with Meta"}
              </Button>
            </Box>
          </Stack>
        </Box>
      )}
    </Card>
  );
}
