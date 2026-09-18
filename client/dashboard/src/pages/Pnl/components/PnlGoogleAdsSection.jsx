import { useEffect, useState } from "react";
import { Alert, Box, Button, Card, Chip, CircularProgress, Stack, TextField, Typography } from "@mui/material";
import dayjs from "dayjs";
import { connectGoogleAds, disconnectGoogleAds, getGoogleAdsStatus } from "../../../lib/api.js";

function formatCustomerId(id) {
  const digits = String(id || "").replace(/\D/g, "");
  return digits.length === 10 ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` : digits;
}

// Google Ads card on the P&L page. No OAuth: the merchant pastes their
// customer id and token, the backend stores it encrypted, and the pipeline's
// Google Ads sync uses it to fill the rollup the Google line reads from.
export default function PnlGoogleAdsSection({ brandKey, onConnectionChange }) {
  const [status, setStatus] = useState(null);
  const [loadingStatus, setLoadingStatus] = useState(false);

  const [editing, setEditing] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [loginCustomerId, setLoginCustomerId] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveMessage, setSaveMessage] = useState("");

  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    if (!brandKey) return;
    let cancelled = false;
    setLoadingStatus(true);
    setEditing(false);
    setSaveError("");
    setSaveMessage("");
    getGoogleAdsStatus({ brand_key: brandKey }).then((result) => {
      if (cancelled) return;
      setStatus(result.error ? null : result.data);
      setLoadingStatus(false);
    });
    return () => {
      cancelled = true;
    };
  }, [brandKey]);

  const resetForm = () => {
    setCustomerId("");
    setLoginCustomerId("");
    setToken("");
    setEditing(false);
  };

  const startEditing = () => {
    setCustomerId(status?.customerId ? formatCustomerId(status.customerId) : "");
    setLoginCustomerId(status?.loginCustomerId ? formatCustomerId(status.loginCustomerId) : "");
    setToken("");
    setSaveError("");
    setSaveMessage("");
    setEditing(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError("");
    setSaveMessage("");
    const result = await connectGoogleAds({
      brand_key: brandKey,
      customer_id: customerId.trim(),
      login_customer_id: loginCustomerId.trim() || null,
      token: token.trim(),
    });
    setSaving(false);
    if (result.error) {
      setSaveError(result.data?.error || "Failed to save the Google Ads token.");
      return;
    }
    setStatus(result.data);
    resetForm();
    setSaveMessage("Google Ads token saved. Spend shows once the next sync has run.");
    onConnectionChange?.();
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    await disconnectGoogleAds({ brand_key: brandKey });
    setDisconnecting(false);
    setStatus({ connected: false });
    resetForm();
    setSaveMessage("");
    onConnectionChange?.();
  };

  const canSave = customerId.replace(/\D/g, "").length === 10 && token.trim().length > 0;
  const showForm = editing || !status?.connected;

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
            Paste this brand&apos;s Google Ads customer id and token so real ad spend can be pulled into the
            Google line above.
          </Typography>
        </Stack>
        {status?.connected ? <Chip label="Connected" size="small" color="success" /> : null}
      </Stack>

      {loadingStatus ? (
        <CircularProgress size={20} />
      ) : showForm ? (
        <Stack spacing={1.5} sx={{ maxWidth: 520 }}>
          <Typography variant="body2" color="text.secondary">
            The token is stored encrypted and never shown again. The nightly sync uses it to pull daily
            spend; until that has run, the Google line shows &quot;-&quot;.
          </Typography>
          {saveError ? <Alert severity="error">{saveError}</Alert> : null}
          <TextField
            size="small"
            label="Customer id"
            placeholder="123-456-7890"
            value={customerId}
            onChange={(event) => setCustomerId(event.target.value)}
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
            label="Token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            helperText="The Google Ads API token for this account."
            autoComplete="off"
            multiline
            minRows={2}
          />
          <Stack direction="row" spacing={1}>
            <Button variant="contained" size="small" onClick={handleSave} disabled={saving || !canSave}>
              {saving ? "Saving…" : status?.connected ? "Replace token" : "Save token"}
            </Button>
            {status?.connected ? (
              <Button size="small" onClick={resetForm} disabled={saving}>
                Cancel
              </Button>
            ) : null}
          </Stack>
        </Stack>
      ) : (
        <Stack spacing={1}>
          {saveMessage ? <Alert severity="success">{saveMessage}</Alert> : null}
          {status.lastError ? (
            <Alert severity="warning">Last spend sync failed: {status.lastError}. Replace the token if it was revoked.</Alert>
          ) : null}
          <Typography variant="body2">
            Customer <strong>{formatCustomerId(status.customerId)}</strong>
            {status.loginCustomerId ? ` · via manager ${formatCustomerId(status.loginCustomerId)}` : ""}
            {status.tokenSuffix ? ` · token ${status.tokenSuffix}` : ""}
          </Typography>
          {status.capturedAt ? (
            <Typography variant="caption" color="text.secondary">
              Saved {dayjs(status.capturedAt).format("MMM DD, YYYY HH:mm")}
              {status.updatedByEmail ? ` by ${status.updatedByEmail}` : ""}
            </Typography>
          ) : null}
          <Stack direction="row" spacing={1}>
            <Button size="small" onClick={startEditing}>
              Replace token
            </Button>
            <Button size="small" color="error" onClick={handleDisconnect} disabled={disconnecting}>
              {disconnecting ? "Disconnecting…" : "Disconnect"}
            </Button>
          </Stack>
        </Stack>
      )}
    </Card>
  );
}
