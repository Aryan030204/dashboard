import { useEffect, useState } from "react";
import { Alert, Box, Button, Card, Chip, CircularProgress, Stack, TextField, Typography } from "@mui/material";
import dayjs from "dayjs";
import SearchableSelect from "../../../components/ui/SearchableSelect.jsx";
import {
  connectGoogleAds,
  connectGoogleOauth,
  disconnectGoogleAds,
  exchangeGoogleOauthCode,
  getGoogleAdsStatus,
  getGoogleOauthConfig,
} from "../../../lib/api.js";

const OAUTH_PENDING_KEY = "google_oauth_pending_brand";
const OAUTH_STATE_KEY = "google_oauth_pending_state";

function formatCustomerId(id) {
  const digits = String(id || "").replace(/\D/g, "");
  return digits.length === 10 ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` : digits;
}

function describeAccount(account) {
  const bits = [formatCustomerId(account.id)];
  if (account.currency) bits.push(account.currency);
  if (account.isManager) bits.push("Manager (MCC)");
  return bits.join(" · ");
}

// Splits a manually typed fallback (accounts didn't list) into candidate
// customer ids - commas, whitespace, or newlines.
function splitTypedIds(raw) {
  return String(raw || "")
    .split(/[,\s]+/)
    .map((part) => part.replace(/\D/g, ""))
    .filter(Boolean);
}

function randomState() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Google Ads card on the P&L page. "Connect with Google" sends the brand
// through Google's OAuth consent screen for a refresh token - the backend
// exchanges the code for it server-side (Google's exchange needs the app's
// client secret, so it can never happen in the browser) and the token is
// never sent back to this page. Pasting a refresh token directly stays as a
// fallback for a brand that already has one.
export default function PnlGoogleAdsSection({ brandKey, onConnectionChange }) {
  const [status, setStatus] = useState(null);
  const [loadingStatus, setLoadingStatus] = useState(false);

  const [connectMode, setConnectMode] = useState("oauth");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState("");
  const [connectMessage, setConnectMessage] = useState("");

  // Set once the OAuth code exchange has verified a refresh token for the
  // brand (parked server-side): the brand still needs to say which customer
  // id(s) it's for before anything is finalized.
  const [pending, setPending] = useState(null); // { brandKey }
  const [accounts, setAccounts] = useState([]); // every account the login can see (checkbox picker)
  const [accountsListError, setAccountsListError] = useState(""); // listing failed - fall back to typing
  const [customerIds, setCustomerIds] = useState([]); // picked (or typed) ids to connect
  const [typedCustomerIds, setTypedCustomerIds] = useState(""); // fallback free-text entry
  const [loginCustomerId, setLoginCustomerId] = useState("");
  const [manualToken, setManualToken] = useState("");
  const [manualCustomerId, setManualCustomerId] = useState(""); // paste-a-refresh-token tab only
  const [saving, setSaving] = useState(false);

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

  // Google's redirect back lands on this same page with ?code=...&state=...
  // in the query string (not the hash - unlike Meta's implicit grant, an
  // authorization code isn't a secret worth hiding from server logs the same
  // way, and Google's own examples use the query string).
  useEffect(() => {
    const pendingBrand = window.sessionStorage.getItem(OAUTH_PENDING_KEY);
    const pendingState = window.sessionStorage.getItem(OAUTH_STATE_KEY);
    if (!pendingBrand) return;

    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    const error = params.get("error");
    if (!code && !error) return;

    window.sessionStorage.removeItem(OAUTH_PENDING_KEY);
    window.sessionStorage.removeItem(OAUTH_STATE_KEY);
    window.history.replaceState(null, "", window.location.pathname);

    if (error) {
      setConnectError(error === "access_denied" ? "Google sign-in was cancelled." : error);
      return;
    }
    if (state !== pendingState) {
      setConnectError("Could not verify this Google login (state mismatch). Please try connecting again.");
      return;
    }

    setConnecting(true);
    setConnectError("");
    setConnectMessage("");
    const redirectUri = `${window.location.origin}${window.location.pathname}`;
    exchangeGoogleOauthCode({ brand_key: pendingBrand, code, redirect_uri: redirectUri })
      .then((result) => {
        setConnecting(false);
        if (result.error) {
          setConnectError(result.data?.error || "Failed to verify the Google login.");
          return;
        }
        const listedAccounts = Array.isArray(result.data?.accounts) ? result.data.accounts : [];
        setPending({ brandKey: pendingBrand });
        setAccounts(listedAccounts);
        setAccountsListError(listedAccounts.length === 0 ? result.data?.listError || "" : "");
        setCustomerIds(listedAccounts.length === 1 ? [listedAccounts[0].id] : []);
        setTypedCustomerIds("");
        setLoginCustomerId("");
      })
      .catch(() => {
        setConnecting(false);
        setConnectError("Failed to verify the Google login.");
      });
    // Only meant to run once, on the redirect back from Google.
  }, []);

  const handleConnectWithGoogle = async () => {
    setConnecting(true);
    setConnectError("");
    setConnectMessage("");

    const config = await getGoogleOauthConfig({ brand_key: brandKey });
    if (config.error || !config.data?.clientId) {
      setConnecting(false);
      setConnectError(config.data?.error || "Google app is not configured on the backend.");
      return;
    }

    const { clientId, scope } = config.data;
    const redirectUri = `${window.location.origin}${window.location.pathname}`;
    const state = randomState();
    const oauthUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope,
      access_type: "offline",
      prompt: "consent",
      state,
    })}`;

    window.sessionStorage.setItem(OAUTH_PENDING_KEY, brandKey);
    window.sessionStorage.setItem(OAUTH_STATE_KEY, state);
    window.location.assign(oauthUrl);
  };

  const resetPending = () => {
    setPending(null);
    setAccounts([]);
    setAccountsListError("");
    setCustomerIds([]);
    setTypedCustomerIds("");
    setLoginCustomerId("");
    setManualToken("");
    setManualCustomerId("");
    setConnectError("");
  };

  // Ids actually being submitted: the checkbox picker's selection, or the
  // typed fallback when the account list couldn't be fetched.
  const effectiveCustomerIds = accounts.length > 0 ? customerIds : splitTypedIds(typedCustomerIds);

  // Finishes the OAuth path: the refresh token is already parked server-side
  // from the code exchange above, this just says which customer id(s) it's for.
  const handleFinishOauthConnect = async () => {
    if (!pending || effectiveCustomerIds.length === 0) return;
    setSaving(true);
    setConnectError("");
    const result = await connectGoogleOauth({
      brand_key: pending.brandKey,
      customer_ids: effectiveCustomerIds,
      login_customer_id: loginCustomerId.trim() || null,
    });
    setSaving(false);
    if (result.error) {
      setConnectError(result.data?.error || "Failed to connect these customer ids.");
      return;
    }
    resetPending();
    setStatus(result.data);
    setConnectMessage(
      effectiveCustomerIds.length > 1
        ? `${effectiveCustomerIds.length} Google Ads accounts connected.`
        : "Google Ads account connected.",
    );
    onConnectionChange?.();
  };

  // Fallback for a brand that already has a refresh token and pastes it
  // directly - same persistence as the OAuth path, minus the consent screen.
  // No account listing here (nothing to exchange it against yet), so it
  // stays a single typed customer id.
  const handleManualSave = async () => {
    setSaving(true);
    setConnectError("");
    const result = await connectGoogleAds({
      brand_key: brandKey,
      customer_ids: [manualCustomerId.trim()],
      login_customer_id: loginCustomerId.trim() || null,
      token: manualToken.trim(),
    });
    setSaving(false);
    if (result.error) {
      setConnectError(result.data?.error || "Failed to save the Google Ads token.");
      return;
    }
    resetPending();
    setStatus(result.data);
    setConnectMessage("Google Ads token saved. Spend shows once the next sync has run.");
    onConnectionChange?.();
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    await disconnectGoogleAds({ brand_key: brandKey });
    setDisconnecting(false);
    setStatus({ connected: false });
    resetPending();
    setConnectMessage("");
    onConnectionChange?.();
  };

  const pickerForOtherBrand = pending && brandKey && pending.brandKey !== brandKey;
  const canFinishOauth = effectiveCustomerIds.length > 0;
  const canManualSave = manualCustomerId.replace(/\D/g, "").length === 10 && manualToken.trim().length > 0;
  const accountOptions = accounts.map((account) => ({
    id: account.id,
    label: account.name,
    detail: describeAccount(account),
  }));

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
        {status?.connected ? (
          <Stack direction="row" spacing={0.75}>
            <Chip label="Connected" size="small" color="success" />
            {status.authMethod === "oauth" ? (
              <Chip label="Google login" size="small" variant="outlined" />
            ) : null}
          </Stack>
        ) : null}
      </Stack>

      {loadingStatus ? (
        <CircularProgress size={20} />
      ) : pending ? (
        <Stack spacing={1.5} sx={{ maxWidth: 480 }}>
          <Typography variant="body2" color="text.secondary">
            Google login verified. Pick which of this brand&apos;s Google Ads account(s) to connect
            {pickerForOtherBrand ? ` for brand ${pending.brandKey}` : ""}.
          </Typography>
          {pickerForOtherBrand ? (
            <Alert severity="warning">
              This connect was started for brand <strong>{pending.brandKey}</strong>, not the one currently
              selected. Cancel and reconnect if that isn&apos;t what you want.
            </Alert>
          ) : null}
          {connectError ? <Alert severity="error">{connectError}</Alert> : null}
          {accounts.length > 0 ? (
            <SearchableSelect
              label="Ad accounts"
              options={accountOptions}
              value={customerIds}
              onChange={setCustomerIds}
              multiple
              size="small"
              sx={{ width: "100%" }}
              selectSx={{ width: "100%" }}
            />
          ) : (
            <>
              {accountsListError ? (
                <Alert severity="warning">
                  Couldn&apos;t list your Google Ads accounts automatically ({accountsListError}). Type the
                  customer id(s) below instead — separate multiple with a comma.
                </Alert>
              ) : null}
              <TextField
                size="small"
                label="Customer id(s)"
                placeholder="123-456-7890, 987-654-3210"
                value={typedCustomerIds}
                onChange={(event) => setTypedCustomerIds(event.target.value)}
                helperText="Shown at the top right of Google Ads. Dashes optional, comma-separate for more than one."
                autoComplete="off"
              />
            </>
          )}
          <TextField
            size="small"
            label="Manager (MCC) customer id — optional"
            placeholder="987-654-3210"
            value={loginCustomerId}
            onChange={(event) => setLoginCustomerId(event.target.value)}
            helperText="Only if this account is reached through a manager account."
            autoComplete="off"
          />
          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              size="small"
              onClick={handleFinishOauthConnect}
              disabled={saving || !canFinishOauth}
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
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
            {(status.customerIds?.length ? status.customerIds : [status.customerId]).filter(Boolean).map((id) => (
              <Chip key={id} label={formatCustomerId(id)} size="small" variant="outlined" />
            ))}
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {status.loginCustomerId ? `Via manager ${formatCustomerId(status.loginCustomerId)}` : ""}
            {status.loginCustomerId && status.tokenSuffix ? " · " : ""}
            {status.tokenSuffix ? `Token ${status.tokenSuffix}` : ""}
          </Typography>
          {status.capturedAt ? (
            <Typography variant="caption" color="text.secondary">
              Saved {dayjs(status.capturedAt).format("MMM DD, YYYY HH:mm")}
              {status.updatedByEmail ? ` by ${status.updatedByEmail}` : ""}
            </Typography>
          ) : null}
          {status.lastError ? (
            <Alert severity="warning">
              Last spend sync failed: {status.lastError}. Reconnect if the token was revoked.
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
                variant={connectMode === "oauth" ? "contained" : "outlined"}
                onClick={() => {
                  setConnectMode("oauth");
                  setConnectError("");
                }}
              >
                Google login
              </Button>
              <Button
                size="small"
                variant={connectMode === "manual" ? "contained" : "outlined"}
                onClick={() => {
                  setConnectMode("manual");
                  setConnectError("");
                }}
              >
                Refresh token
              </Button>
            </Stack>

            {connectError ? <Alert severity="error">{connectError}</Alert> : null}
            {connectMessage ? <Alert severity="success">{connectMessage}</Alert> : null}

            {connectMode === "oauth" ? (
              <>
                <Typography variant="body2" color="text.secondary">
                  You&apos;ll be sent to Google to sign in with the account that has access to this brand&apos;s
                  Ads account, then asked for the Customer ID. The refresh token from that login is stored
                  encrypted and never shown again.
                </Typography>
                <Box>
                  <Button variant="contained" size="small" onClick={handleConnectWithGoogle} disabled={connecting}>
                    {connecting ? "Working…" : "Connect with Google"}
                  </Button>
                </Box>
              </>
            ) : (
              <>
                <Typography variant="body2" color="text.secondary">
                  For a brand that already has a Google Ads refresh token: paste the customer id and token
                  directly. Stored encrypted and never shown again.
                </Typography>
                <TextField
                  size="small"
                  label="Customer id"
                  placeholder="123-456-7890"
                  value={manualCustomerId}
                  onChange={(event) => setManualCustomerId(event.target.value)}
                  helperText="Shown at the top right of Google Ads. Dashes optional."
                  autoComplete="off"
                />
                <TextField
                  size="small"
                  label="Manager (MCC) customer id — optional"
                  placeholder="987-654-3210"
                  value={loginCustomerId}
                  onChange={(event) => setLoginCustomerId(event.target.value)}
                  helperText="Only if this account is reached through a manager account."
                  autoComplete="off"
                />
                <TextField
                  size="small"
                  label="Refresh token"
                  type="password"
                  value={manualToken}
                  onChange={(event) => setManualToken(event.target.value)}
                  autoComplete="off"
                  multiline
                  minRows={2}
                />
                <Box>
                  <Button
                    variant="contained"
                    size="small"
                    onClick={handleManualSave}
                    disabled={saving || !canManualSave}
                  >
                    {saving ? "Saving…" : "Save token"}
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
