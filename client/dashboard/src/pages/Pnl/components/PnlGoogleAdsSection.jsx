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
  disconnectGoogleAds,
  exchangeGoogleOauthCode,
  getGoogleAdsStatus,
  getGoogleOauthConfig,
  refreshGoogleAdsCustomers,
  setGoogleAdsCustomer,
} from "../../../lib/api.js";
import { openGoogleOauthPopup, waitForGoogleOauthResult } from "../../../lib/googleOauthPopup.js";

// sessionStorage key holding { brandKey, state, redirectUri } while the tab
// is away at Google (full-tab fallback only, when the popup was blocked).
// `state` is echoed back by Google and checked on return so a stray ?code=
// in the URL can't be attached to the wrong brand.
const OAUTH_PENDING_KEY = "google_oauth_pending";
const OAUTH_QUERY_KEYS = ["code", "state", "scope", "authuser", "prompt", "hd", "error"];

function randomState() {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function readPending() {
  try {
    const raw = window.sessionStorage.getItem(OAUTH_PENDING_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function stripOauthQuery() {
  const url = new URL(window.location.href);
  OAUTH_QUERY_KEYS.forEach((key) => url.searchParams.delete(key));
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}

function formatCustomerId(id) {
  const digits = String(id || "").replace(/\D/g, "");
  return digits.length === 10 ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` : digits;
}

function describeCustomer(customer) {
  const bits = [formatCustomerId(customer.id)];
  if (customer.currencyCode) bits.push(customer.currencyCode);
  if (customer.manager) bits.push("Manager account");
  return bits.join(" · ");
}

export default function PnlGoogleAdsSection({ brandKey, onConnectionChange }) {
  const [status, setStatus] = useState(null);
  const [loadingStatus, setLoadingStatus] = useState(false);

  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState("");
  const [connectMessage, setConnectMessage] = useState("");

  const [pickingCustomer, setPickingCustomer] = useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [manualCustomerId, setManualCustomerId] = useState("");
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [refreshingCustomers, setRefreshingCustomers] = useState(false);

  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    if (!brandKey) return;
    let cancelled = false;
    setLoadingStatus(true);
    getGoogleAdsStatus({ brand_key: brandKey }).then((result) => {
      if (cancelled) return;
      setStatus(result.error ? null : result.data);
      setLoadingStatus(false);
    });
    return () => {
      cancelled = true;
    };
  }, [brandKey]);

  // Swaps the one-time code from Google for a stored refresh token and shows
  // the customer picker when the brand hasn't chosen one yet.
  const finishConnect = async ({ brandKey: pendingBrandKey, code, redirectUri }) => {
    setConnecting(true);
    setConnectError("");
    setConnectMessage("");
    try {
      const result = await exchangeGoogleOauthCode({ brand_key: pendingBrandKey, code, redirect_uri: redirectUri });
      if (result.error) {
        setConnectError(result.data?.error || "Failed to exchange the Google code on the backend.");
        return;
      }
      setStatus(result.data);
      setConnectMessage("Google Ads connected. Refresh token stored.");
      if (!result.data?.customerId) setPickingCustomer(true);
      onConnectionChange?.();
    } catch {
      setConnectError("Failed to exchange the Google code on the backend.");
    } finally {
      setConnecting(false);
    }
  };

  // Full-tab fallback return path (popup blocked): Google put ?code=&state=
  // in this tab's query string. The popup path never reaches here — the
  // popup relays its result via lib/googleOauthPopup.js before the app boots.
  useEffect(() => {
    const pending = readPending();
    if (!pending) return;
    const params = new URLSearchParams(window.location.search);
    if (!params.get("code") && !params.get("error")) return;

    window.sessionStorage.removeItem(OAUTH_PENDING_KEY);
    const code = params.get("code");
    const state = params.get("state");
    const oauthError = params.get("error");
    stripOauthQuery();

    if (oauthError) {
      setConnectError(oauthError === "access_denied" ? "Google login was cancelled." : `Google returned: ${oauthError}`);
      return;
    }
    if (!state || state !== pending.state) {
      setConnectError("OAuth state mismatch — please start the Google connect again.");
      return;
    }

    finishConnect({ brandKey: pending.brandKey, code, redirectUri: pending.redirectUri });
    // Only meant to run once, on the redirect back from Google.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConnectWithGoogle = async () => {
    setConnecting(true);
    setConnectError("");
    setConnectMessage("");

    const config = await getGoogleOauthConfig({ brand_key: brandKey });
    if (config.error || !config.data?.clientId) {
      setConnecting(false);
      setConnectError(config.data?.error || "Google OAuth client is not configured on the backend.");
      return;
    }

    const { clientId, authUrl, scope } = config.data;
    const redirectUri = `${window.location.origin}${window.location.pathname}`;
    const state = randomState();
    const oauthUrl = `${authUrl}?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope,
      // offline + consent is what makes Google hand back a refresh token.
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    })}`;

    // Preferred: Google's login + consent in a popup window, so this tab (and
    // whatever the user has on screen) stays put. The popup comes back to the
    // same redirect URI and hands the code over, then closes itself.
    const popup = openGoogleOauthPopup(oauthUrl);
    if (!popup) {
      // Popup blocked: fall back to sending this tab to Google.
      window.sessionStorage.setItem(OAUTH_PENDING_KEY, JSON.stringify({ brandKey, state, redirectUri }));
      window.location.assign(oauthUrl);
      return;
    }

    let code;
    try {
      ({ code } = await waitForGoogleOauthResult({ popup, state }));
    } catch (error) {
      setConnecting(false);
      setConnectError(error?.message || "Google connect did not finish.");
      return;
    }
    await finishConnect({ brandKey, code, redirectUri });
  };

  const applyStatus = (next) => {
    setStatus(next);
    setPickingCustomer(false);
    setSelectedCustomerId("");
    setManualCustomerId("");
  };

  const handleSaveCustomer = async () => {
    const customerId = selectedCustomerId || manualCustomerId;
    if (!customerId) return;
    setSavingCustomer(true);
    setConnectError("");
    const result = await setGoogleAdsCustomer({ brand_key: brandKey, customer_id: customerId });
    setSavingCustomer(false);
    if (result.error) {
      setConnectError(result.data?.error || "Failed to save the customer id.");
      return;
    }
    applyStatus(result.data);
    setConnectMessage("Google Ads customer saved.");
    onConnectionChange?.();
  };

  const handleRefreshCustomers = async () => {
    setRefreshingCustomers(true);
    setConnectError("");
    const result = await refreshGoogleAdsCustomers({ brand_key: brandKey });
    setRefreshingCustomers(false);
    if (result.error) {
      setConnectError(result.data?.error || "Failed to list Google Ads accounts.");
      return;
    }
    setStatus(result.data);
    if (result.data?.customersError) setConnectError(result.data.customersError);
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    await disconnectGoogleAds({ brand_key: brandKey });
    setDisconnecting(false);
    applyStatus({ connected: false, developerTokenConfigured: status?.developerTokenConfigured });
    setConnectMessage("");
    onConnectionChange?.();
  };

  const customers = status?.accessibleCustomers || [];
  const showPicker = status?.connected && (pickingCustomer || !status.customerId);
  const chosenCustomer = customers.find((c) => c.id === status?.customerId);

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
            Google Ads Integration
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Connect this brand&apos;s Google Ads account to pull real ad spend into the Google line above.
          </Typography>
        </Stack>
        {status?.connected ? <Chip label="Connected" size="small" color="success" /> : null}
      </Stack>

      {loadingStatus || connecting ? (
        <Stack direction="row" spacing={1} alignItems="center">
          <CircularProgress size={16} />
          {connecting ? <Typography variant="body2">Waiting for Google…</Typography> : null}
        </Stack>
      ) : status?.connected ? (
        <Stack spacing={1.5} sx={{ maxWidth: 520 }}>
          {connectError ? <Alert severity="error">{connectError}</Alert> : null}
          {connectMessage ? <Alert severity="success">{connectMessage}</Alert> : null}
          {!status.developerTokenConfigured ? (
            <Alert severity="info">
              GOOGLE_ADS_DEVELOPER_TOKEN isn&apos;t set on the backend, so accounts can&apos;t be listed and spend
              can&apos;t be pulled yet. The refresh token is stored; enter the customer id manually for now.
            </Alert>
          ) : null}
          {status.lastError ? <Alert severity="warning">Last Google Ads call failed: {status.lastError}</Alert> : null}

          {showPicker ? (
            <Stack spacing={1.5}>
              <Typography variant="body2" color="text.secondary">
                Pick the Google Ads customer to pull spend for.
              </Typography>
              {customers.length > 0 ? (
                <FormControl size="small" fullWidth>
                  <InputLabel id="google-ads-customer-label">Customer</InputLabel>
                  <Select
                    labelId="google-ads-customer-label"
                    label="Customer"
                    value={selectedCustomerId}
                    onChange={(event) => {
                      setSelectedCustomerId(event.target.value);
                      setManualCustomerId("");
                    }}
                  >
                    {customers.map((customer) => (
                      <MenuItem key={customer.id} value={customer.id}>
                        <Stack spacing={0}>
                          <Typography variant="body2">{customer.name || formatCustomerId(customer.id)}</Typography>
                          <Typography variant="caption" color="text.secondary">
                            {describeCustomer(customer)}
                          </Typography>
                        </Stack>
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              ) : null}
              <TextField
                size="small"
                label={customers.length > 0 ? "Or type a customer id" : "Customer id"}
                placeholder="123-456-7890"
                value={manualCustomerId}
                onChange={(event) => {
                  setManualCustomerId(event.target.value);
                  setSelectedCustomerId("");
                }}
                helperText="Shown at the top right of Google Ads. Dashes optional."
              />
              <Stack direction="row" spacing={1} flexWrap="wrap">
                <Button
                  variant="contained"
                  size="small"
                  onClick={handleSaveCustomer}
                  disabled={savingCustomer || (!selectedCustomerId && !manualCustomerId.trim())}
                >
                  {savingCustomer ? "Saving…" : "Use this customer"}
                </Button>
                {status.developerTokenConfigured ? (
                  <Button size="small" onClick={handleRefreshCustomers} disabled={refreshingCustomers}>
                    {refreshingCustomers ? "Listing…" : "Reload account list"}
                  </Button>
                ) : null}
                {status.customerId ? (
                  <Button size="small" onClick={() => setPickingCustomer(false)} disabled={savingCustomer}>
                    Cancel
                  </Button>
                ) : null}
              </Stack>
            </Stack>
          ) : (
            <Stack spacing={1}>
              <Typography variant="body2">
                Customer <strong>{chosenCustomer?.name || formatCustomerId(status.customerId)}</strong>
                {chosenCustomer?.name ? ` (${formatCustomerId(status.customerId)})` : ""}
                {chosenCustomer?.currencyCode ? ` · ${chosenCustomer.currencyCode}` : ""}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Connected {dayjs(status.capturedAt).format("MMM DD, YYYY HH:mm")}
                {status.updatedByEmail ? ` by ${status.updatedByEmail}` : ""}
                {customers.length > 1 ? ` · ${customers.length} accounts visible` : ""}
              </Typography>
              <Stack direction="row" spacing={1}>
                <Button size="small" onClick={() => setPickingCustomer(true)}>
                  Change customer
                </Button>
                <Button size="small" color="error" onClick={handleDisconnect} disabled={disconnecting}>
                  {disconnecting ? "Disconnecting…" : "Disconnect"}
                </Button>
              </Stack>
            </Stack>
          )}
        </Stack>
      ) : (
        <Box>
          <Stack spacing={1.5} sx={{ maxWidth: 480 }}>
            <Typography variant="body2" color="text.secondary">
              A Google window opens to log in and grant read access to Google Ads, then you pick which
              customer to connect. A refresh token is stored encrypted so spend can be pulled any time.
            </Typography>
            {connectError ? <Alert severity="error">{connectError}</Alert> : null}
            {connectMessage ? <Alert severity="success">{connectMessage}</Alert> : null}
            <Box>
              <Button variant="contained" size="small" onClick={handleConnectWithGoogle} disabled={connecting}>
                Connect with Google
              </Button>
            </Box>
          </Stack>
        </Box>
      )}
    </Card>
  );
}
