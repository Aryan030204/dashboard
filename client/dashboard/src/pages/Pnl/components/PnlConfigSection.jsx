import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Card,
  CircularProgress,
  IconButton,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import dayjs from "dayjs";
import { clearPnlCostConfig, getPnlCostConfigs, savePnlCostConfig } from "../../../lib/api.js";

// Mirrors analytics/services/pnlCostConfig.service.js's CATEGORY_FIELD_MAP —
// keep these two lists in sync when a category is added or renamed.
const CATEGORIES = [
  { key: "cogs", label: "COGS (SKU level)" },
  { key: "packaging", label: "Packaging Cost" },
  { key: "freight_inwards", label: "Freight Inwards" },
  { key: "shipping", label: "Shipping" },
  { key: "rto", label: "RTO" },
  { key: "influencers", label: "Influencers" },
  { key: "content", label: "Content" },
  { key: "sponsorships", label: "Sponsorships" },
  { key: "other_brand", label: "Other Brand Marketing" },
  { key: "salaries", label: "Salaries" },
  { key: "rent", label: "Rent" },
  { key: "technology", label: "Technology" },
  { key: "agency_fees", label: "Agency Fees" },
  { key: "other_overheads", label: "Other Overheads" },
];

function CostConfigRow({ brandKey, category, label, config, onSaved }) {
  const [value, setValue] = useState(config ? String(config.value) : "");
  const [valueType, setValueType] = useState(config?.valueType || "flat");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setValue(config ? String(config.value) : "");
    setValueType(config?.valueType || "flat");
  }, [config]);

  const dirty = value !== (config ? String(config.value) : "") || valueType !== (config?.valueType || "flat");

  const handleSave = async () => {
    const numericValue = Number(value);
    if (!value || Number.isNaN(numericValue)) {
      setError("Enter a number");
      return;
    }
    setError("");
    setSaving(true);
    const result = await savePnlCostConfig({
      brand_key: brandKey,
      category,
      value: numericValue,
      value_type: valueType,
    });
    setSaving(false);
    if (result.error) {
      setError(result.data?.error || "Failed to save");
      return;
    }
    onSaved(category, result.data);
  };

  const handleClear = async () => {
    setSaving(true);
    const result = await clearPnlCostConfig({ brand_key: brandKey, category });
    setSaving(false);
    if (result.error) {
      setError(result.data?.error || "Failed to clear");
      return;
    }
    setValue("");
    setValueType("flat");
    onSaved(category, null);
  };

  return (
    <Stack
      direction={{ xs: "column", sm: "row" }}
      alignItems={{ xs: "stretch", sm: "center" }}
      spacing={1}
      sx={{ p: 1.5, border: "1px solid", borderColor: "divider", borderRadius: 1.5 }}
    >
      <Box sx={{ minWidth: { sm: 180 }, flexShrink: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          {label}
        </Typography>
        {config?.updatedAt ? (
          <Typography variant="caption" color="text.secondary">
            Updated {dayjs(config.updatedAt).format("MMM DD, YYYY")}
            {config.updatedByEmail ? ` by ${config.updatedByEmail}` : ""}
          </Typography>
        ) : null}
      </Box>

      <TextField
        size="small"
        type="number"
        placeholder="Amount"
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
        <ToggleButton value="flat">₹ Flat</ToggleButton>
        <ToggleButton value="percentage">% of Sales</ToggleButton>
      </ToggleButtonGroup>

      <Stack direction="row" spacing={0.5} sx={{ ml: { sm: "auto" } }}>
        <Button size="small" variant="contained" disabled={!dirty || saving} onClick={handleSave}>
          {saving ? <CircularProgress size={16} /> : "Save"}
        </Button>
        {config ? (
          <IconButton size="small" onClick={handleClear} disabled={saving} title="Clear override">
            <CloseIcon fontSize="small" />
          </IconButton>
        ) : null}
      </Stack>
    </Stack>
  );
}

export default function PnlConfigSection({ brandKey, onConfigChange }) {
  const [configs, setConfigs] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!brandKey) return;
    let cancelled = false;
    setLoading(true);
    getPnlCostConfigs({ brand_key: brandKey }).then((result) => {
      if (cancelled) return;
      setConfigs(result.error ? {} : result.data?.configs || {});
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [brandKey]);

  const handleSaved = (category, updatedConfig) => {
    setConfigs((prev) => {
      const next = { ...(prev || {}) };
      if (updatedConfig) next[category] = updatedConfig;
      else delete next[category];
      return next;
    });
    onConfigChange?.();
  };

  const configuredCount = useMemo(
    () => Object.keys(configs || {}).length,
    [configs],
  );

  return (
    <Card variant="outlined" sx={{ p: 2.5 }}>
      <Stack spacing={0.5} sx={{ mb: 2 }}>
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          Brand Cost Configuration
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Manual cost overrides for categories that aren&apos;t derivable from order data. A
          flat amount or a percentage of Net Sales for the period — takes effect immediately
          and applies until changed.
          {configuredCount ? ` ${configuredCount} of ${CATEGORIES.length} configured.` : ""}
        </Typography>
      </Stack>

      {loading || !configs ? (
        <CircularProgress size={20} />
      ) : (
        <Stack spacing={1}>
          {CATEGORIES.map(({ key, label }) => (
            <CostConfigRow
              key={key}
              brandKey={brandKey}
              category={key}
              label={label}
              config={configs[key] || null}
              onSaved={handleSaved}
            />
          ))}
        </Stack>
      )}
    </Card>
  );
}
