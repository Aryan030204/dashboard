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
import { connectMetaAds, disconnectMetaAds, getMetaAdsStatus } from "../../../lib/api.js";

export default function PnlMetaAdsSection({ brandKey, onConnectionChange }) {
  const [status, setStatus] = useState(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [editing, setEditing] = useState(false);

  const [adAccountId, setAdAccountId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    if (!brandKey) return;
    let cancelled = false;
    setLoadingStatus(true);
    getMetaAdsStatus({ brand_key: brandKey }).then((result) => {
      if (cancelled) return;
      setStatus(result.error ? null : result.data);
      setLoadingStatus(false);
      setEditing(result.error || !result.data?.connected);
    });
    return () => {
      cancelled = true;
    };
  }, [brandKey]);

  const handleConnect = async (event) => {
    event.preventDefault();
    setSaving(true);
    setSaveError("");
    const result = await connectMetaAds({
      brand_key: brandKey,
      ad_account_id: adAccountId,
      access_token: accessToken,
    });
    setSaving(false);
    if (result.error) {
      setSaveError(result.data?.error || "Failed to connect Meta Ads. Check the token and ad account ID.");
      return;
    }
    setStatus(result.data);
    setEditing(false);
    setAdAccountId("");
    setAccessToken("");
    onConnectionChange?.();
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    await disconnectMetaAds({ brand_key: brandKey });
    setDisconnecting(false);
    setStatus({ connected: false });
    setEditing(true);
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
      ) : editing || !status?.connected ? (
        <Box component="form" onSubmit={handleConnect}>
          <Stack spacing={1.5} sx={{ maxWidth: 480 }}>
            <TextField
              label="Ad Account ID"
              placeholder="123456789012345 or act_123456789012345"
              size="small"
              value={adAccountId}
              onChange={(e) => setAdAccountId(e.target.value)}
              required
            />
            <TextField
              label="Access Token"
              type="password"
              placeholder="Long-lived System User token with ads_read"
              size="small"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              required
            />
            {saveError ? <Alert severity="error">{saveError}</Alert> : null}
            <Stack direction="row" spacing={1}>
              <Button type="submit" variant="contained" size="small" disabled={saving}>
                {saving ? "Verifying…" : "Connect"}
              </Button>
              {status?.connected ? (
                <Button size="small" onClick={() => setEditing(false)} disabled={saving}>
                  Cancel
                </Button>
              ) : null}
            </Stack>
          </Stack>
        </Box>
      ) : (
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
            <Button size="small" onClick={() => setEditing(true)}>
              Update token
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
