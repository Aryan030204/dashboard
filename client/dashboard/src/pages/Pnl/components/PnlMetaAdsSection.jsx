import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import dayjs from "dayjs";
import SearchableSelect from "../../../components/ui/SearchableSelect.jsx";
import { syncNotice } from "../pnlFormat.js";
import {
  connectMetaAds,
  connectMetaOauth,
  disconnectMetaAds,
  exchangeMetaOauthCode,
  getMetaAdsStatus,
  getMetaOauthConfig,
  listMetaOauthAdAccounts,
} from "../../../lib/api.js";

const OAUTH_PENDING_KEY = "meta_oauth_pending_brand";
const OAUTH_STATE_KEY = "meta_oauth_pending_state";

function randomState() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
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

  // Which "not connected yet" option is showing: "Continue with Meta"
  // (Facebook Login for Business), or the paste-a-System-User-token form.
  const [connectMode, setConnectMode] = useState("oauth");
  const [manualToken, setManualToken] = useState("");

  // Set once we have a token to work with (either the "Continue with Meta"
  // redirect, or a pasted System User token): the brand the connect was
  // started for, the token itself, which kind of token it is, whether it
  // came via the OAuth dialog (UI copy only - both kinds are token_type
  // "system_user" once saved), and the ad accounts that token can see. The
  // token lives only in memory — a refresh mid-pick means starting over.
  const [pending, setPending] = useState(null); // { brandKey, accessToken, tokenType, viaOauth }
  const [adAccounts, setAdAccounts] = useState([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState([]);
  const [saving, setSaving] = useState(false);

  // Manual System User token paste path: verify the token by listing the ad
  // accounts it can see, then let the brand pick one. The "Continue with
  // Meta" path below never holds the token client-side, so this is only
  // reached from handleUseSystemUserToken now.
  const startWithToken = (forBrandKey, accessToken) => {
    setPending({ brandKey: forBrandKey, accessToken, tokenType: "system_user", viaOauth: false });
    setAdAccounts([]);
    setSelectedAccountIds([]);
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
          setConnectError("This System User has no ad accounts assigned to it in Business Settings.");
          return;
        }
        setAdAccounts(accounts);
        setSelectedAccountIds(accounts.length === 1 ? [accounts[0].id] : []);
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
  // navigate this same tab away to Meta and back: on return, the authorization
  // code is in the query string and sessionStorage tells us a connect was in
  // flight (and which state value to expect, for CSRF protection).
  //
  // response_type=code (not token): the code is exchanged for the access
  // token server-side, using the app secret, so the token itself never
  // reaches the browser. The dialog is scoped to a Facebook Login for
  // Business configuration (config_id, set below), so the token the exchange
  // gets back is a System-business access token already scoped to just the
  // ad account(s) the brand admin picked during consent — same non-expiring,
  // no-further-exchange handling as a manually pasted System User token.
  useEffect(() => {
    const pendingBrand = window.sessionStorage.getItem(OAUTH_PENDING_KEY);
    const pendingState = window.sessionStorage.getItem(OAUTH_STATE_KEY);
    if (!pendingBrand) return;

    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    const error = params.get("error");
    const errorDescription = params.get("error_description");
    if (!code && !error) return;

    window.sessionStorage.removeItem(OAUTH_PENDING_KEY);
    window.sessionStorage.removeItem(OAUTH_STATE_KEY);
    window.history.replaceState(null, "", window.location.pathname);

    if (error) {
      setConnectError(error === "access_denied" ? "Meta login was cancelled." : errorDescription || error);
      return;
    }
    if (state !== pendingState) {
      setConnectError("Could not verify this Meta login (state mismatch). Please try connecting again.");
      return;
    }

    setConnecting(true);
    setConnectError("");
    setConnectMessage("");
    const redirectUri = `${window.location.origin}${window.location.pathname}`;
    exchangeMetaOauthCode({ brand_key: pendingBrand, code, redirect_uri: redirectUri })
      .then((result) => {
        setConnecting(false);
        if (result.error) {
          setConnectError(result.data?.error || "Failed to verify the Meta login.");
          return;
        }
        const accounts = Array.isArray(result.data?.accounts) ? result.data.accounts : [];
        setPending({ brandKey: pendingBrand, viaOauth: true });
        setAdAccounts(accounts);
        setSelectedAccountIds(accounts.length === 1 ? [accounts[0].id] : []);
      })
      .catch(() => {
        setConnecting(false);
        setConnectError("Failed to verify the Meta login.");
      });
    // Only meant to run once, on the redirect back from Meta.
  }, []);

  const handleConnectWithMeta = async () => {
    setConnecting(true);
    setConnectError("");
    setConnectMessage("");

    const config = await getMetaOauthConfig({ brand_key: brandKey });
    if (config.error || !config.data?.appId || !config.data?.configId) {
      setConnecting(false);
      setConnectError(config.data?.error || "Meta app is not configured on the backend.");
      return;
    }

    const { appId, configId, apiVersion } = config.data;
    const redirectUri = `${window.location.origin}${window.location.pathname}`;
    const state = randomState();
    // config_id (not scope) drives which permissions and ad-account picker
    // Meta shows — it comes from the app's Facebook Login for Business
    // configuration, not from this page. response_type=code keeps the token
    // exchange server-side (see the redirect-back effect above).
    const oauthUrl = `https://www.facebook.com/${apiVersion}/dialog/oauth?${new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      response_type: "code",
      config_id: configId,
      state,
    })}`;

    window.sessionStorage.setItem(OAUTH_PENDING_KEY, brandKey);
    window.sessionStorage.setItem(OAUTH_STATE_KEY, state);
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
    startWithToken(brandKey, token);
  };

  const resetPending = () => {
    setPending(null);
    setAdAccounts([]);
    setSelectedAccountIds([]);
    setManualToken("");
  };

  // Manual System User token path: posts the picked account(s) + token to
  // the real connect endpoint, which verifies each pair against Graph and
  // stores them encrypted in meta_ads_credentials.
  const handleSaveAccount = async () => {
    if (!pending || selectedAccountIds.length === 0) return;
    setSaving(true);
    setConnectError("");
    const result = await connectMetaAds({
      brand_key: pending.brandKey,
      ad_account_ids: selectedAccountIds,
      access_token: pending.accessToken,
      token_type: pending.tokenType,
    });
    setSaving(false);
    if (result.error) {
      setConnectError(result.data?.error || "Failed to connect the ad account(s).");
      return;
    }
    resetPending();
    setStatus(result.data);
    setConnectMessage(
      ["Meta ad account(s) connected with a System User token.", syncNotice(result.data?.sync)]
        .filter(Boolean)
        .join(" "),
    );
    onConnectionChange?.();
  };

  // "Continue with Meta" path: the token is already parked server-side from
  // the code exchange, this just says which ad account(s) to connect.
  const handleFinishOauthConnect = async () => {
    if (!pending || selectedAccountIds.length === 0) return;
    setSaving(true);
    setConnectError("");
    const result = await connectMetaOauth({
      brand_key: pending.brandKey,
      ad_account_ids: selectedAccountIds,
    });
    setSaving(false);
    if (result.error) {
      setConnectError(result.data?.error || "Failed to connect the ad account(s).");
      return;
    }
    resetPending();
    setStatus(result.data);
    setConnectMessage(
      ["Meta ad account(s) connected via Continue with Meta (System-business token).", syncNotice(result.data?.sync)]
        .filter(Boolean)
        .join(" "),
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
  const adAccountOptions = adAccounts.map((account) => ({
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
            {pending.viaOauth ? "Continue with Meta succeeded." : "Token verified."} Pick which of this
            brand&apos;s ad account(s) to connect
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
            <SearchableSelect
              label="Ad accounts"
              options={adAccountOptions}
              value={selectedAccountIds}
              onChange={setSelectedAccountIds}
              multiple
              size="small"
              sx={{ width: "100%" }}
              selectSx={{ width: "100%" }}
            />
          )}
          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              size="small"
              onClick={pending.viaOauth ? handleFinishOauthConnect : handleSaveAccount}
              disabled={saving || connecting || selectedAccountIds.length === 0}
            >
              {saving ? "Connecting…" : "Connect these accounts"}
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
            Ad account{status.adAccountIds?.length > 1 ? "s" : ""}{" "}
            <strong>{(status.adAccountIds?.length ? status.adAccountIds : [status.adAccountId]).join(", ")}</strong>
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
                variant={connectMode === "oauth" ? "contained" : "outlined"}
                onClick={() => {
                  setConnectMode("oauth");
                  setConnectError("");
                }}
              >
                Continue with Meta
              </Button>
              <Button
                size="small"
                variant={connectMode === "system_user" ? "contained" : "outlined"}
                onClick={() => {
                  setConnectMode("system_user");
                  setConnectError("");
                }}
              >
                Paste a token
              </Button>
            </Stack>

            {connectError ? <Alert severity="error">{connectError}</Alert> : null}
            {connectMessage ? <Alert severity="success">{connectMessage}</Alert> : null}

            {connectMode === "oauth" ? (
              <>
                <Typography variant="body2" color="text.secondary">
                  Opens Meta&apos;s consent dialog. The brand admin logs in, picks which of their ad
                  account(s) to share, and grants access to just those — Meta returns a non-expiring
                  System-business token, the same as pasting one manually.
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Until the app has passed App Review for Standard access, this only works for people added
                  as admins/testers on the app (Limited access tier) — not real brand admins yet.
                </Typography>
                <Box>
                  <Button variant="contained" size="small" onClick={handleConnectWithMeta} disabled={connecting}>
                    {connecting ? "Working…" : "Continue with Meta"}
                  </Button>
                </Box>
              </>
            ) : (
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
            )}
          </Stack>
        </Box>
      )}
    </Card>
  );
}
