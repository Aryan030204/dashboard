import { useEffect, useState } from "react";
import { Alert, Box, Button, Card, Chip, CircularProgress, Stack, Typography } from "@mui/material";
import dayjs from "dayjs";
import {
  disconnectMetaAds,
  getMetaAdsStatus,
  getMetaOauthConfig,
  getMetaOauthLog,
  logMetaOauthToken,
} from "../../../lib/api.js";

const OAUTH_PENDING_KEY = "meta_oauth_pending_brand";

function parseHashParams(hash) {
  return Object.fromEntries(new URLSearchParams((hash || "").replace(/^#/, "")));
}

export default function PnlMetaAdsSection({ brandKey, onConnectionChange }) {
  const [status, setStatus] = useState(null);
  const [loadingStatus, setLoadingStatus] = useState(false);

  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState("");
  const [connectMessage, setConnectMessage] = useState("");

  const [disconnecting, setDisconnecting] = useState(false);

  // Last token the OAuth flow captured for this brand (masked) — prefilled
  // from the backend so a refresh doesn't lose track of what was connected.
  const [oauthLog, setOauthLog] = useState(null);

  useEffect(() => {
    if (!brandKey) return;
    let cancelled = false;
    setLoadingStatus(true);
    setOauthLog(null);
    Promise.all([
      getMetaAdsStatus({ brand_key: brandKey }),
      getMetaOauthLog({ brand_key: brandKey }),
    ]).then(([statusResult, logResult]) => {
      if (cancelled) return;
      setStatus(statusResult.error ? null : statusResult.data);
      setOauthLog(logResult.error ? null : logResult.data?.log || null);
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
  useEffect(() => {
    const pendingBrand = window.sessionStorage.getItem(OAUTH_PENDING_KEY);
    const params = parseHashParams(window.location.hash);
    if (!pendingBrand || !params.access_token) return;

    window.sessionStorage.removeItem(OAUTH_PENDING_KEY);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    setConnecting(true);

    logMetaOauthToken({
      brand_key: pendingBrand,
      access_token: params.access_token,
      expires_in: params.expires_in,
    })
      .then((result) => {
        setConnecting(false);
        if (result.error) {
          setConnectError(result.data?.error || "Failed to log the token on the backend.");
          return;
        }
        setConnectMessage("Received a token from Meta and logged it on the backend.");
        if (result.data?.log) setOauthLog(result.data.log);
        onConnectionChange?.();
      })
      .catch(() => {
        setConnecting(false);
        setConnectError("Failed to log the token on the backend.");
      });
    // Only meant to run once, on the redirect back from Meta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const handleDisconnect = async () => {
    setDisconnecting(true);
    await disconnectMetaAds({ brand_key: brandKey });
    setDisconnecting(false);
    setStatus({ connected: false });
    onConnectionChange?.();
  };

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
      ) : status?.connected ? (
        <Stack spacing={1}>
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
              This connect flow is a work in progress: it sends you to Meta&apos;s login page and the token
              it returns is logged on the backend for now, not yet wired into ad spend syncing.
            </Typography>
            {connectError ? <Alert severity="error">{connectError}</Alert> : null}
            {connectMessage ? <Alert severity="success">{connectMessage}</Alert> : null}
            {oauthLog ? (
              <Typography variant="caption" color="text.secondary">
                Token {oauthLog.tokenSuffix} captured{" "}
                {dayjs(oauthLog.capturedAt).format("MMM DD, YYYY HH:mm")}
                {oauthLog.updatedByEmail ? ` by ${oauthLog.updatedByEmail}` : ""}
                {oauthLog.expiresIn ? ` · expires in ${oauthLog.expiresIn}s` : ""}
              </Typography>
            ) : null}
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
