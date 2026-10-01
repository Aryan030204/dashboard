import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Card,
  CardContent,
  CircularProgress,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import { getClientSettings, updateClientSettings } from "../lib/api";

export default function ClientSideSettingsForm() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    getClientSettings().then((r) => {
      if (cancelled) return;
      if (r.error) setError("Could not load client settings.");
      setEnabled(!!r.dashboardBannerEnabled);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggle = async (event) => {
    const next = event.target.checked;
    setEnabled(next);
    setSaving(true);
    setError("");
    const r = await updateClientSettings({ dashboardBannerEnabled: next });
    setSaving(false);
    if (r.error) {
      setError(r.error);
      setEnabled(!next);
    }
  };

  return (
    <Card elevation={0} sx={{ border: "1px solid", borderColor: "divider", maxWidth: 640 }}>
      <CardContent sx={{ p: { xs: 2, md: 3 } }}>
        <Typography variant="h6" sx={{ fontWeight: 700, mb: 0.5 }}>
          Client Side Settings
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Controls what brand users see on their dashboard. Changes apply for
          them within about a minute, with no page refresh needed.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {loading ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
            <CircularProgress size={24} />
          </Box>
        ) : (
          <Stack
            direction="row"
            alignItems="flex-start"
            justifyContent="space-between"
            spacing={2}
            sx={{
              p: 2,
              borderRadius: "10px",
              border: "1px solid",
              borderColor: "divider",
            }}
          >
            <Box>
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                Show data-discrepancy banner
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                When on, every brand user (not admins/authors) sees a warning
                banner at the top of the Dashboard tab: "Datum is facing some
                issues, data may have some discrepancies."
              </Typography>
            </Box>
            <Switch checked={enabled} onChange={handleToggle} disabled={saving} />
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}
