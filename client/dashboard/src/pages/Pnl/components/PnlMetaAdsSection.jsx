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
  TextField,
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

  // Which "not connected yet" option is showing: the OAuth login button, or
  // the paste-a-System-User-token form.
  const [connectMode, setConnectMode] = useState("system_user");
  const [manualToken, setManualToken] = useState("");

  // Set once we have a token to work with (either Meta's OAuth redirect, or a
  // pasted System User token): the brand the connect was started for, the
  // token itself, which kind of token it is, and the ad accounts that token
  // can see. The token lives only in memory — a refresh mid-pick means
  // starting over.
  const [pending, setPending] = useState(null); // { brandKey, accessToken, tokenType }
  const [adAccounts, setAdAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [saving, setSaving] = useState(false);

  // Shared by both the OAuth redirect handler and the manual System User
  // token form: given any Meta access token, verify it by listing the ad
  // accounts it can see, then let the brand pick one.
  const startWithToken = (forBrandKey, accessToken, tokenType) => {
    setPending({ brandKey: forBrandKey, accessToken, tokenType });
    setAdAccounts([]);
    setSelectedAccountId("");
    setConnecting(true);
    setConnectError("");
    setConnectMessage("");

    listMetaOauthAdAccounts({ brand_key: forBrandKey, access_token: accessToken })
      .then((result) => {
        setConnecting(false);
        if (result.error) {
          setPending(null);
          setConnectError(result.data?.error || "Failed to list ad accounts for this token.");
          return;
        }
        const accounts = Array.isArray(result.data?.accounts) ? result.data.accounts : [];
        if (accounts.length === 0) {
          setPending(null);
          setConnectError(
            tokenType === "system_user"
              ? "This System User has no ad accounts assigned to it in Business Settings."
              : "This Meta login has no ad accounts. Log in with a user who can see the brand's account.",
          );
          return;
        }
        setAdAccounts(accounts);
        setSelectedAccountId(accounts.length === 1 ? accounts[0].id : "");
      })
      .catch(() => {
        setConnecting(false);
        setPending(null);
        setConnectError("Failed to list ad accounts for this token.");
      });
  };

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

    startWithToken(pendingBrand, params.access_token, "user");
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

  // System User tokens are generated manually in Meta Business Settings
  // (System Users → the relevant system user → Generate New Token, with the
  // ad account granted to it and "Never" expiry) — there's no OAuth dialog
  // for these, so this just verifies whatever was pasted by listing the ad
  // accounts it can see, same as the OAuth path.
  const handleUseSystemUserToken = () => {
    const token = manualToken.trim();
    if (!brandKey || !token) return;
    startWithToken(brandKey, token, "system_user");
  };

  const resetPending = () => {
    setPending(null);
    setAdAccounts([]);
    setSelectedAccountId("");
    setManualToken("");
  };

  // Posts the picked account + token to the real connect endpoint, which
  // verifies the pair against Graph, exchanges for a long-lived token (user
  // tokens only — System User tokens are stored exactly as pasted), and
  // stores it encrypted in meta_ads_credentials.
  const handleSaveAccount = async () => {
    if (!pending || !selectedAccountId) return;
    setSaving(true);
    setConnectError("");
    const result = await connectMetaAds({
      brand_key: pending.brandKey,
      ad_account_id: selectedAccountId,
      access_token: pending.accessToken,
      token_type: pending.tokenType,
    });
    setSaving(false);
    if (result.error) {
      setConnectError(result.data?.error || "Failed to connect the ad account.");
      return;
    }
    resetPending();
    setStatus(result.data);
    setConnectMessage(
      pending.tokenType === "system_user"
        ? "Meta ad account connected with a System User token."
        : "Meta ad account connected.",
    );
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
        {status?.connected ? (
          <Stack direction="row" spacing={0.75}>
            <Chip label="Connected" size="small" color="success" />
            {status.tokenType === "system_user" ? (
              <Chip label="System User token" size="small" variant="outlined" />
            ) : null}
          </Stack>
        ) : null}
      </Stack>

      {loadingStatus ? (
        <CircularProgress size={20} />
      ) : pending ? (
        <Stack spacing={1.5} sx={{ maxWidth: 480 }}>
          <Typography variant="body2" color="text.secondary">
            {pending.tokenType === "system_user" ? "Token verified." : "Meta login succeeded."} Pick the ad
            account to connect
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
              {status.expiresAt
                ? ` · token expires ${dayjs(status.expiresAt).format("MMM DD, YYYY")}`
                : status.tokenType === "system_user"
                  ? " · System User token, no expiry tracked"
                  : ""}
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
            <Stack direction="row" spacing={1}>
              <Button
                size="small"
                variant={connectMode === "system_user" ? "contained" : "outlined"}
                onClick={() => {
                  setConnectMode("system_user");
                  setConnectError("");
                }}
              >
                System User token
              </Button>
              <Button
                size="small"
                variant={connectMode === "oauth" ? "contained" : "outlined"}
                onClick={() => {
                  setConnectMode("oauth");
                  setConnectError("");
                }}
              >
                Meta login
              </Button>
            </Stack>

            {connectError ? <Alert severity="error">{connectError}</Alert> : null}
            {connectMessage ? <Alert severity="success">{connectMessage}</Alert> : null}

            {connectMode === "system_user" ? (
              <>
                <Typography variant="body2" color="text.secondary">
                  Paste a System User access token from Meta Business Settings (System Users → the system
                  user → Generate New Token, with this brand&apos;s ad account granted and expiry set to
                  Never). Stored exactly as pasted — never exchanged or modified.
                </Typography>
                <TextField
                  size="small"
                  fullWidth
                  label="System User access token"
                  value={manualToken}
                  onChange={(event) => setManualToken(event.target.value)}
                  disabled={connecting}
                />
                <Box>
                  <Button
                    variant="contained"
                    size="small"
                    onClick={handleUseSystemUserToken}
                    disabled={connecting || !manualToken.trim()}
                  >
                    {connecting ? "Verifying…" : "Verify token"}
                  </Button>
                </Box>
              </>
            ) : (
              <>
                <Typography variant="body2" color="text.secondary">
                  You&apos;ll be sent to Meta to log in, then asked which ad account to connect. This issues
                  a regular user token, exchanged for a long-lived one (~60 days) — it will need
                  reconnecting when that expires. Prefer a System User token above for a connection that
                  doesn&apos;t expire.
                </Typography>
                <Box>
                  <Button variant="contained" size="small" onClick={handleConnectWithMeta} disabled={connecting}>
                    {connecting ? "Redirecting to Meta…" : "Connect with Meta"}
                  </Button>
                </Box>
              </>
            )}
          </Stack>
        </Box>
      )}
    </Card>
  );
}
