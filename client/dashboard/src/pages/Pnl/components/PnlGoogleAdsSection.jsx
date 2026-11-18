import { useEffect, useState } from "react";
import dayjs from "dayjs";
import { Banner, Checklist, Field, Segmented, Skeleton, SourceCard } from "./pnlUi.jsx";
import { syncNotice } from "../pnlFormat.js";
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
// `onStatusChange` / `openSignal`: see PnlMetaAdsSection.
export default function PnlGoogleAdsSection({ brandKey, onConnectionChange, onStatusChange, openSignal }) {
  const [status, setStatus] = useState(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    onStatusChange?.(status ? { connected: !!status.connected } : null);
  }, [status, onStatusChange]);

  useEffect(() => {
    if (openSignal) setExpanded(true);
  }, [openSignal]);

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
    const connected =
      effectiveCustomerIds.length > 1
        ? `${effectiveCustomerIds.length} Google Ads accounts connected.`
        : "Google Ads account connected.";
    setConnectMessage([connected, syncNotice(result.data?.sync)].filter(Boolean).join(" "));
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
    setConnectMessage(
      ["Google Ads token saved.", syncNotice(result.data?.sync) || "Spend shows once the next sync has run."].join(" "),
    );
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

  const connected = !!status?.connected;
  const connectedIds = connected
    ? (status.customerIds?.length ? status.customerIds : [status.customerId]).filter(Boolean)
    : [];

  const mccField = (
    <Field label="Manager (MCC) customer id — optional" hint="Only if this account is reached through a manager account.">
      <input
        type="text"
        placeholder="987-654-3210"
        autoComplete="off"
        value={loginCustomerId}
        onChange={(event) => setLoginCustomerId(event.target.value)}
      />
    </Field>
  );

  let body;
  if (loadingStatus) {
    body = <Skeleton height={44} />;
  } else if (pending) {
    body = (
      <div className="pnl-source-form">
        <p className="pnl-source-detail">
          Google login verified. Pick which of this brand&apos;s Google Ads account(s) to connect
          {pickerForOtherBrand ? ` for brand ${pending.brandKey}` : ""}.
        </p>
        {pickerForOtherBrand ? (
          <Banner>
            This connect was started for brand <strong>{pending.brandKey}</strong>, not the one currently selected.
            Cancel and reconnect if that isn&apos;t what you want.
          </Banner>
        ) : null}
        {connectError ? <Banner tone="bad">{connectError}</Banner> : null}
        {accounts.length > 0 ? (
          <Checklist label="Ad accounts" options={accountOptions} value={customerIds} onChange={setCustomerIds} />
        ) : (
          <>
            {accountsListError ? (
              <Banner>
                Couldn&apos;t list your Google Ads accounts automatically ({accountsListError}). Type the customer
                id(s) below instead — separate multiple with a comma.
              </Banner>
            ) : null}
            <Field
              label="Customer id(s)"
              hint="Shown at the top right of Google Ads. Dashes optional, comma-separate for more than one."
            >
              <input
                type="text"
                placeholder="123-456-7890, 987-654-3210"
                autoComplete="off"
                value={typedCustomerIds}
                onChange={(event) => setTypedCustomerIds(event.target.value)}
              />
            </Field>
          </>
        )}
        {mccField}
        <div className="pnl-edit-actions">
          <button
            type="button"
            className="pnl-btn"
            onClick={handleFinishOauthConnect}
            disabled={saving || !canFinishOauth}
          >
            {saving ? "Connecting…" : "Connect this account"}
          </button>
          <button type="button" className="pnl-ctl" onClick={resetPending} disabled={saving}>
            Cancel
          </button>
        </div>
      </div>
    );
  } else if (connected) {
    body = (
      <>
        {connectMessage ? <Banner tone="good">{connectMessage}</Banner> : null}
        <p className="pnl-source-detail" style={{ flex: "1 1 auto" }}>
          Customer ID{connectedIds.length > 1 ? "s" : ""}{" "}
          <strong>{connectedIds.map(formatCustomerId).join(", ")}</strong>
          {status.loginCustomerId ? `, via manager ${formatCustomerId(status.loginCustomerId)}` : ""}.
          {status.authMethod === "oauth" ? " Connected with a Google login." : ""}
          {status.tokenSuffix ? ` Token ${status.tokenSuffix}.` : ""}
          {status.capturedAt
            ? ` Saved ${dayjs(status.capturedAt).format("DD MMM YYYY, HH:mm")}${status.updatedByEmail ? ` by ${status.updatedByEmail}` : ""}.`
            : ""}{" "}
          Spend flows into the Google Ads line.
        </p>
        {status.lastError ? (
          <Banner>Last spend sync failed: {status.lastError}. Reconnect if the token was revoked.</Banner>
        ) : null}
        <button
          type="button"
          className="pnl-ctl"
          style={{ alignSelf: "flex-start" }}
          onClick={handleDisconnect}
          disabled={disconnecting}
        >
          {disconnecting ? "Disconnecting…" : "Disconnect"}
        </button>
      </>
    );
  } else {
    body = (
      <>
        <p className="pnl-source-detail" style={{ flex: "1 1 auto" }}>
          Sign in with the Google account that manages this brand&apos;s Ads account to pull spend into the Google
          Ads line.
        </p>
        {connectError ? <Banner tone="bad">{connectError}</Banner> : null}
        {connectMessage ? <Banner tone="good">{connectMessage}</Banner> : null}
        {!expanded ? (
          <button type="button" className="pnl-btn" style={{ alignSelf: "flex-start" }} onClick={() => setExpanded(true)}>
            Connect Google Ads
          </button>
        ) : (
          <div className="pnl-source-form">
            <Segmented
              label="How to connect Google Ads"
              value={connectMode}
              onChange={(mode) => {
                setConnectMode(mode);
                setConnectError("");
              }}
              options={[
                { value: "oauth", label: "Google login" },
                { value: "manual", label: "Refresh token" },
              ]}
            />
            {connectMode === "oauth" ? (
              <>
                <p className="pnl-source-detail">
                  You&apos;ll be sent to Google to sign in with the account that has access to this brand&apos;s Ads
                  account, then asked for the Customer ID. The refresh token from that login is stored encrypted and
                  never shown again.
                </p>
                <div className="pnl-edit-actions">
                  <button type="button" className="pnl-btn" onClick={handleConnectWithGoogle} disabled={connecting}>
                    {connecting ? "Working…" : "Connect with Google"}
                  </button>
                  <button type="button" className="pnl-ctl" onClick={() => setExpanded(false)}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="pnl-source-detail">
                  For a brand that already has a Google Ads refresh token: paste the customer id and token directly.
                  Stored encrypted and never shown again.
                </p>
                <Field label="Customer id" hint="Shown at the top right of Google Ads. Dashes optional.">
                  <input
                    type="text"
                    placeholder="123-456-7890"
                    autoComplete="off"
                    value={manualCustomerId}
                    onChange={(event) => setManualCustomerId(event.target.value)}
                  />
                </Field>
                {mccField}
                <Field label="Refresh token">
                  <input
                    type="password"
                    autoComplete="off"
                    value={manualToken}
                    onChange={(event) => setManualToken(event.target.value)}
                  />
                </Field>
                <div className="pnl-edit-actions">
                  <button
                    type="button"
                    className="pnl-btn"
                    onClick={handleManualSave}
                    disabled={saving || !canManualSave}
                  >
                    {saving ? "Saving…" : "Save token"}
                  </button>
                  <button type="button" className="pnl-ctl" onClick={() => setExpanded(false)}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <SourceCard
      id="source-google"
      name="Google Ads"
      status={loadingStatus ? null : connected ? "Connected" : "Not connected"}
      tone={connected ? "good" : "warn"}
    >
      {body}
    </SourceCard>
  );
}
