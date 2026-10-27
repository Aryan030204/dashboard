import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Skeleton,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import dayjs from "dayjs";
import { getAdsAlertEvents, getAdsAlertRules, saveAdsAlertRules } from "../../../lib/api.js";
import { ALERT_METRICS, ALERT_METRIC_BY_ID, CHANNEL_LABELS, RULE_PRESETS, formatMetric } from "../adsFormat.js";

const EMPTY_RULE = {
  name: "",
  channel: "all",
  metric: "roas",
  operator: "below",
  threshold: "",
  min_spend: 0,
  min_clicks: 0,
  lookback_days: 3,
  severity: "medium",
  is_active: true,
};

const SEVERITY_COLORS = { low: "default", medium: "warning", high: "error" };

function describeRule(rule, formatAmount) {
  const metric = ALERT_METRIC_BY_ID[rule.metric]?.label || rule.metric;
  const gates = [
    rule.min_spend ? `spend ≥ ${formatAmount(rule.min_spend)}` : null,
    rule.min_clicks ? `${rule.metric === "lpv_rate" ? "link clicks" : "clicks"} ≥ ${rule.min_clicks}` : null,
  ].filter(Boolean);
  return `${CHANNEL_LABELS[rule.channel]} · ${metric} ${rule.operator} ${formatMetric(rule.metric, Number(rule.threshold), formatAmount)} over ${rule.lookback_days}d${gates.length ? ` · when ${gates.join(", ")}` : ""}`;
}

function RuleDialog({ open, initial, onClose, onSave }) {
  const [rule, setRule] = useState(initial || EMPTY_RULE);
  useEffect(() => setRule(initial || EMPTY_RULE), [initial, open]);

  const set = (field) => (event) => setRule((prev) => ({ ...prev, [field]: event.target.value }));
  const metric = ALERT_METRIC_BY_ID[rule.metric];
  const valid = rule.name.trim() && rule.threshold !== "" && Number(rule.threshold) >= 0;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{initial?.rule_id ? "Edit alert rule" : "New alert rule"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField label="Name" value={rule.name} onChange={set("name")} size="small" fullWidth autoFocus />
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
            <TextField select label="Channel" value={rule.channel} onChange={set("channel")} size="small" fullWidth>
              {["all", "meta", "google"].map((id) => (
                <MenuItem key={id} value={id}>
                  {CHANNEL_LABELS[id]}
                </MenuItem>
              ))}
            </TextField>
            <TextField select label="Metric" value={rule.metric} onChange={set("metric")} size="small" fullWidth helperText={metric?.hint}>
              {ALERT_METRICS.map((m) => (
                <MenuItem key={m.id} value={m.id}>
                  {m.label}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
            <TextField select label="Alert when" value={rule.operator} onChange={set("operator")} size="small" fullWidth>
              <MenuItem value="below">falls below</MenuItem>
              <MenuItem value="above">rises above</MenuItem>
            </TextField>
            <TextField
              label={`Threshold${metric?.unit === "x" ? " (x)" : metric?.unit === "%" ? " (%)" : ""}`}
              type="number"
              value={rule.threshold}
              onChange={set("threshold")}
              size="small"
              fullWidth
              inputProps={{ min: 0, step: "any" }}
            />
            <TextField
              label="Over last (days)"
              type="number"
              value={rule.lookback_days}
              onChange={set("lookback_days")}
              size="small"
              fullWidth
              inputProps={{ min: 1, max: 30 }}
            />
          </Stack>
          <Typography variant="caption" color="text.secondary">
            Only check campaigns with enough volume, so a tiny test campaign doesn't page anyone:
          </Typography>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
            <TextField label="Min spend" type="number" value={rule.min_spend} onChange={set("min_spend")} size="small" fullWidth inputProps={{ min: 0 }} />
            <TextField
              label={rule.metric === "lpv_rate" ? "Min link clicks" : "Min clicks"}
              type="number"
              value={rule.min_clicks}
              onChange={set("min_clicks")}
              size="small"
              fullWidth
              inputProps={{ min: 0 }}
            />
            <TextField select label="Severity" value={rule.severity} onChange={set("severity")} size="small" fullWidth>
              {["low", "medium", "high"].map((s) => (
                <MenuItem key={s} value={s}>
                  {s}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!valid}
          onClick={() =>
            onSave({
              ...rule,
              name: rule.name.trim(),
              threshold: Number(rule.threshold),
              min_spend: Number(rule.min_spend) || 0,
              min_clicks: Number(rule.min_clicks) || 0,
              lookback_days: Math.min(30, Math.max(1, Number(rule.lookback_days) || 1)),
            })
          }
        >
          Save rule
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default function AdsAlertsPanel({ brandKey, formatAmount, onRulesChange }) {
  const [rules, setRules] = useState([]);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState({ open: false, index: null, initial: null });

  useEffect(() => {
    if (!brandKey) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([getAdsAlertRules({ brand_key: brandKey }), getAdsAlertEvents({ brand_key: brandKey })]).then(([rulesRes, eventsRes]) => {
      if (cancelled) return;
      setRules(rulesRes?.data?.rules || []);
      setEvents(eventsRes?.data?.events || []);
      setError(rulesRes?.error ? "Failed to load alert rules." : "");
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [brandKey]);

  const persist = async (next) => {
    setSaving(true);
    setError("");
    const result = await saveAdsAlertRules({ brand_key: brandKey, rules: next });
    setSaving(false);
    if (result?.error) {
      setError(result?.data?.error || result?.data?.message || "Failed to save alert rules.");
      return false;
    }
    setRules(result.data.rules || []);
    onRulesChange?.();
    return true;
  };

  const saveRule = async (rule) => {
    const next = [...rules];
    if (dialog.index === null) next.push(rule);
    else next[dialog.index] = { ...next[dialog.index], ...rule };
    if (await persist(next)) setDialog({ open: false, index: null, initial: null });
  };

  return (
    <Stack spacing={2}>
      {error ? <Alert severity="error">{error}</Alert> : null}

      <Card variant="outlined" sx={{ p: 2 }}>
        <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ xs: "flex-start", sm: "center" }} spacing={1}>
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Campaign alert rules
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Checked against every campaign after each nightly sync; a breach lands in the notifications bell once per
              campaign per day. Campaigns breaching a rule for the range on screen are also flagged on the Campaigns tab.
            </Typography>
          </Box>
          <Button startIcon={<AddIcon />} variant="contained" size="small" onClick={() => setDialog({ open: true, index: null, initial: null })}>
            New rule
          </Button>
        </Stack>

        {loading ? (
          <Skeleton height={80} />
        ) : rules.length === 0 ? (
          <Stack spacing={1} sx={{ mt: 2 }}>
            <Typography variant="body2" color="text.secondary">
              No rules yet. Start from one of these:
            </Typography>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {RULE_PRESETS.map((preset) => (
                <Chip key={preset.name} label={preset.name} icon={<AddIcon />} variant="outlined" onClick={() => setDialog({ open: true, index: null, initial: preset })} />
              ))}
            </Stack>
          </Stack>
        ) : (
          <Table size="small" sx={{ mt: 1 }}>
            <TableBody>
              {rules.map((rule, index) => (
                <TableRow key={rule.rule_id}>
                  <TableCell sx={{ width: 56 }}>
                    <Tooltip title={rule.is_active ? "Active" : "Paused"}>
                      <Switch
                        size="small"
                        checked={rule.is_active !== false}
                        disabled={saving}
                        onChange={(e) => persist(rules.map((r, i) => (i === index ? { ...r, is_active: e.target.checked } : r)))}
                      />
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography variant="body2" sx={{ fontWeight: 500 }}>
                        {rule.name}
                      </Typography>
                      <Chip size="small" label={rule.severity} color={SEVERITY_COLORS[rule.severity]} variant="outlined" sx={{ height: 20 }} />
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      {describeRule(rule, formatAmount)}
                    </Typography>
                  </TableCell>
                  <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
                    <IconButton size="small" aria-label="Edit rule" onClick={() => setDialog({ open: true, index, initial: rule })}>
                      <EditOutlinedIcon fontSize="small" />
                    </IconButton>
                    <IconButton size="small" aria-label="Delete rule" disabled={saving} onClick={() => persist(rules.filter((_, i) => i !== index))}>
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          Recent alerts
        </Typography>
        {loading ? (
          <Skeleton height={80} />
        ) : events.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Nothing has fired yet.
          </Typography>
        ) : (
          <Table size="small" sx={{ mt: 1 }}>
            <TableHead>
              <TableRow>
                <TableCell>Window</TableCell>
                <TableCell>Campaign</TableCell>
                <TableCell>Rule</TableCell>
                <TableCell align="right">Value</TableCell>
                <TableCell align="right">Threshold</TableCell>
                <TableCell align="right">Spend</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {events.map((event) => (
                <TableRow key={event.id}>
                  <TableCell sx={{ whiteSpace: "nowrap" }}>
                    {event.window_start === event.window_end
                      ? dayjs(event.window_end).format("D MMM")
                      : `${dayjs(event.window_start).format("D MMM")} – ${dayjs(event.window_end).format("D MMM")}`}
                  </TableCell>
                  <TableCell sx={{ maxWidth: 260 }}>
                    <Typography variant="body2" noWrap title={event.campaign_name}>
                      {event.campaign_name || event.campaign_id}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {CHANNEL_LABELS[event.channel] || event.channel}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Chip size="small" label={event.severity || "medium"} color={SEVERITY_COLORS[event.severity] || "warning"} variant="outlined" sx={{ height: 20, mr: 1 }} />
                    {event.rule_name}
                  </TableCell>
                  <TableCell align="right">{formatMetric(event.metric, event.value, formatAmount)}</TableCell>
                  <TableCell align="right">
                    {event.operator} {formatMetric(event.metric, event.threshold, formatAmount)}
                  </TableCell>
                  <TableCell align="right">{formatAmount(event.spend)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <RuleDialog
        open={dialog.open}
        initial={dialog.initial}
        onClose={() => setDialog({ open: false, index: null, initial: null })}
        onSave={saveRule}
      />
    </Stack>
  );
}
