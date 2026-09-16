import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Card,
  CircularProgress,
  Divider,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import dayjs from "dayjs";
import {
  clearPnlCostConfig,
  getPnlCostConfigs,
  savePnlCostConfig,
  savePnlTotalConfig,
} from "../../../lib/api.js";

// Order of the cost lines as they appear in the P&L statement. Labels come
// from the API (`config.labels`) so the backend's list stays the contract;
// this is only the display order and the section grouping.
const SECTIONS = [
  { title: "Gross Margin", fields: ["cogs", "freight_inwards"] },
  { title: "CM1", fields: ["shipping", "rto", "payment_gateway", "packaging"] },
  { title: "CM2 — Paid marketing", fields: ["meta", "google", "other_paid"] },
  { title: "CM3 — Brand marketing", fields: ["influencers", "content", "sponsorships", "other_brand"] },
  { title: "EBITDA — Overheads", fields: ["salaries", "rent", "technology", "agency_fees", "other_overheads"] },
];

function CostLineRow({ brandKey, field, label, line, onSaved }) {
  const [value, setValue] = useState(line ? String(line.value) : "");
  const [valueType, setValueType] = useState(line?.valueType || "flat");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setValue(line ? String(line.value) : "");
    setValueType(line?.valueType || "flat");
  }, [line]);

  const dirty = value !== (line ? String(line.value) : "") || valueType !== (line?.valueType || "flat");

  const handleSave = async () => {
    const numericValue = Number(value);
    if (value === "" || Number.isNaN(numericValue)) {
      setError("Enter a number");
      return;
    }
    setError("");
    setSaving(true);
    const result = await savePnlCostConfig({
      brand_key: brandKey,
      category: field,
      value: numericValue,
      value_type: valueType,
    });
    setSaving(false);
    if (result.error) {
      setError(result.data?.error || "Failed to save");
      return;
    }
    onSaved(result.data?.config);
  };

  const handleClear = async () => {
    setSaving(true);
    const result = await clearPnlCostConfig({ brand_key: brandKey, category: field });
    setSaving(false);
    if (result.error) {
      setError(result.data?.error || "Failed to clear");
      return;
    }
    onSaved(result.data?.config);
  };

  return (
    <Stack
      direction={{ xs: "column", sm: "row" }}
      alignItems={{ xs: "stretch", sm: "center" }}
      spacing={1}
      sx={{ p: 1.25, border: "1px solid", borderColor: "divider", borderRadius: 1.5 }}
    >
      <Box sx={{ minWidth: { sm: 220 }, flexShrink: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          {label}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {line ? (line.valueType === "percentage" ? "% of Net Sales" : "₹ per month") : "Not configured — worker default applies"}
        </Typography>
      </Box>

      <TextField
        size="small"
        type="number"
        placeholder={valueType === "percentage" ? "%" : "₹ / month"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        error={!!error}
        helperText={error || " "}
        sx={{ width: { xs: "100%", sm: 140 } }}
      />

      <ToggleButtonGroup
        size="small"
        value={valueType}
        exclusive
        onChange={(_e, next) => next && setValueType(next)}
      >
        <ToggleButton value="flat">₹ / month</ToggleButton>
        <ToggleButton value="percentage">% of Sales</ToggleButton>
      </ToggleButtonGroup>

      <Stack direction="row" spacing={0.5} sx={{ ml: { sm: "auto" } }}>
        <Button size="small" variant="contained" disabled={!dirty || saving} onClick={handleSave}>
          {saving ? <CircularProgress size={16} /> : "Save"}
        </Button>
        {line ? (
          <IconButton size="small" onClick={handleClear} disabled={saving} title="Clear this line">
            <CloseIcon fontSize="small" />
          </IconButton>
        ) : null}
      </Stack>
    </Stack>
  );
}

function GstRow({ brandKey, gstPct, onSaved }) {
  const [value, setValue] = useState(String(gstPct ?? ""));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setValue(String(gstPct ?? ""));
  }, [gstPct]);

  const dirty = value !== String(gstPct ?? "");

  const handleSave = async () => {
    const numericValue = Number(value);
    if (value === "" || Number.isNaN(numericValue) || numericValue < 0 || numericValue > 100) {
      setError("0 to 100");
      return;
    }
    setError("");
    setSaving(true);
    const result = await savePnlTotalConfig({ brand_key: brandKey, gst_pct: numericValue });
    setSaving(false);
    if (result.error) {
      setError(result.data?.error || "Failed to save");
      return;
    }
    onSaved(result.data?.config);
  };

  return (
    <Stack
      direction={{ xs: "column", sm: "row" }}
      alignItems={{ xs: "stretch", sm: "center" }}
      spacing={1}
      sx={{ p: 1.25, border: "1px solid", borderColor: "divider", borderRadius: 1.5 }}
    >
      <Box sx={{ minWidth: { sm: 220 }, flexShrink: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          GST rate
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Backed out of sales as rate / (100 + rate)
        </Typography>
      </Box>
      <TextField
        size="small"
        type="number"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        error={!!error}
        helperText={error || " "}
        InputProps={{ endAdornment: <InputAdornment position="end">%</InputAdornment> }}
        sx={{ width: { xs: "100%", sm: 140 } }}
      />
      <Stack direction="row" spacing={0.5} sx={{ ml: { sm: "auto" } }}>
        <Button size="small" variant="contained" disabled={!dirty || saving} onClick={handleSave}>
          {saving ? <CircularProgress size={16} /> : "Save"}
        </Button>
      </Stack>
    </Stack>
  );
}

export default function PnlConfigSection({ brandKey, onConfigChange }) {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (!brandKey) return;
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    getPnlCostConfigs({ brand_key: brandKey }).then((result) => {
      if (cancelled) return;
      if (result.error || !result.data?.config) {
        setConfig(null);
        setLoadError("Failed to load cost configuration.");
      } else {
        setConfig(result.data.config);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [brandKey]);

  const handleSaved = (nextConfig) => {
    if (nextConfig) setConfig(nextConfig);
    onConfigChange?.();
  };

  const configuredCount = useMemo(
    () => Object.values(config?.costs || {}).filter(Boolean).length,
    [config],
  );
  const totalCount = Object.keys(config?.costs || {}).length;

  return (
    <Card variant="outlined" sx={{ p: 2.5 }}>
      <Stack spacing={0.5} sx={{ mb: 2 }}>
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          Brand Cost Configuration
        </Typography>
        <Typography variant="body2" color="text.secondary">
          One configuration per brand: the GST rate and every P&amp;L cost line, as a monthly
          amount or a percentage of Net Sales. The nightly P&amp;L worker applies it when it
          builds the daily rollup, so changes show on the next run.
          {totalCount ? ` ${configuredCount} of ${totalCount} cost lines configured.` : ""}
        </Typography>
        {config?.updatedAt ? (
          <Typography variant="caption" color="text.secondary">
            Last saved {dayjs(config.updatedAt).format("MMM DD, YYYY HH:mm")}
            {config.updatedByEmail ? ` by ${config.updatedByEmail}` : ""}
          </Typography>
        ) : null}
      </Stack>

      {loading || (!config && !loadError) ? (
        <CircularProgress size={20} />
      ) : loadError ? (
        <Typography variant="body2" color="error">
          {loadError}
        </Typography>
      ) : (
        <Stack spacing={1.5}>
          <GstRow brandKey={brandKey} gstPct={config.gstPct} onSaved={handleSaved} />

          {SECTIONS.map((section) => (
            <Box key={section.title}>
              <Divider textAlign="left" sx={{ mb: 1 }}>
                <Typography variant="caption" color="text.secondary">
                  {section.title}
                </Typography>
              </Divider>
              <Stack spacing={1}>
                {section.fields.map((field) => (
                  <CostLineRow
                    key={field}
                    brandKey={brandKey}
                    field={field}
                    label={config.labels?.[field] || field}
                    line={config.costs?.[field] || null}
                    onSaved={handleSaved}
                  />
                ))}
              </Stack>
            </Box>
          ))}
        </Stack>
      )}
    </Card>
  );
}
