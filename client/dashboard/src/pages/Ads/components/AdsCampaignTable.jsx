import { Fragment, useEffect, useMemo, useState } from "react";
import {
  Box,
  Card,
  Chip,
  Collapse,
  FormControlLabel,
  IconButton,
  Skeleton,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { getAdsCampaignAds } from "../../../lib/api.js";
import {
  ALERT_METRIC_BY_ID,
  CHANNEL_COLORS,
  CHANNEL_LABELS,
  MISSING,
  formatCount,
  formatMetric,
  formatPct,
  formatRoas,
  isMissing,
} from "../adsFormat.js";

const COLUMNS = [
  { id: "spend", label: "Spend", type: "currency" },
  { id: "roas", label: "ROAS", sub: "platform", type: "roas" },
  { id: "shopifyRoas", label: "ROAS", sub: "Shopify UTM", type: "roas" },
  { id: "utmSales", label: "UTM sales", type: "currency" },
  { id: "utmOrders", label: "UTM orders", type: "count" },
  { id: "ctr", label: "CTR", type: "pct2" },
  { id: "cpc", label: "CPC", type: "currency" },
  { id: "lpvRate", label: "LC → LPV", sub: "Meta", type: "pct" },
];

function formatCell(type, value, formatAmount) {
  if (type === "currency") return isMissing(value) ? MISSING : formatAmount(value);
  if (type === "roas") return formatRoas(value);
  if (type === "count") return formatCount(value);
  if (type === "pct2") return formatPct(value, 2);
  return formatPct(value);
}

function compare(a, b, key, direction) {
  const av = a[key];
  const bv = b[key];
  // Missing values always sink, whichever way the column is sorted.
  if (isMissing(av) && isMissing(bv)) return 0;
  if (isMissing(av)) return 1;
  if (isMissing(bv)) return -1;
  return direction === "asc" ? av - bv : bv - av;
}

function AlertBadge({ alerts, formatAmount }) {
  if (!alerts?.length) return null;
  const severe = alerts.some((a) => a.severity === "high");
  return (
    <Tooltip
      title={
        <Stack spacing={0.5}>
          {alerts.map((a) => (
            <Typography key={a.rule_id} variant="caption">
              {a.name}: {ALERT_METRIC_BY_ID[a.metric]?.label} {formatMetric(a.metric, a.value, formatAmount)} ({a.operator}{" "}
              {formatMetric(a.metric, a.threshold, formatAmount)})
            </Typography>
          ))}
        </Stack>
      }
    >
      <Chip
        size="small"
        icon={<WarningAmberIcon />}
        label={alerts.length === 1 ? "1 alert" : `${alerts.length} alerts`}
        color={severe ? "error" : "warning"}
        variant="outlined"
        sx={{ height: 22 }}
      />
    </Tooltip>
  );
}

function CampaignAds({ brandKey, start, end, campaign, formatAmount }) {
  const [state, setState] = useState({ loading: true, ads: [], error: false });

  useEffect(() => {
    let cancelled = false;
    getAdsCampaignAds({ brand_key: brandKey, start, end, channel: campaign.channel, campaignId: campaign.campaignId }).then(
      (result) => {
        if (cancelled) return;
        setState({ loading: false, ads: result?.data?.ads || [], error: Boolean(result?.error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [brandKey, start, end, campaign.channel, campaign.campaignId]);

  if (state.loading) return <Skeleton height={60} />;
  if (state.error) return <Typography variant="body2" color="error">Failed to load ads.</Typography>;
  if (!state.ads.length) return <Typography variant="body2" color="text.secondary">No ad-level rows for this range.</Typography>;

  const isMeta = campaign.channel === "meta";
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>{isMeta ? "Ad" : "Ad group"}</TableCell>
          {isMeta ? <TableCell>Landing page</TableCell> : null}
          <TableCell align="right">Spend</TableCell>
          <TableCell align="right">ROAS</TableCell>
          <TableCell align="right">UTM sales</TableCell>
          <TableCell align="right">CTR</TableCell>
          {isMeta ? <TableCell align="right">LC → LPV</TableCell> : null}
        </TableRow>
      </TableHead>
      <TableBody>
        {state.ads.map((ad) => (
          <TableRow key={ad.adId}>
            <TableCell sx={{ maxWidth: 280 }}>
              <Typography variant="body2" noWrap title={ad.adName}>
                {ad.adName}
              </Typography>
              {ad.adsetName ? (
                <Typography variant="caption" color="text.secondary" noWrap component="div">
                  {ad.adsetName}
                </Typography>
              ) : null}
            </TableCell>
            {isMeta ? (
              <TableCell sx={{ maxWidth: 220 }}>
                <Typography variant="caption" noWrap component="div" title={ad.landingPath || ""}>
                  {ad.landingPath || MISSING}
                </Typography>
              </TableCell>
            ) : null}
            <TableCell align="right">{formatAmount(ad.spend)}</TableCell>
            <TableCell align="right">{formatRoas(ad.roas)}</TableCell>
            <TableCell align="right">{formatAmount(ad.utmSales)}</TableCell>
            <TableCell align="right">{formatPct(ad.ctr, 2)}</TableCell>
            {isMeta ? <TableCell align="right">{formatPct(ad.lpvRate)}</TableCell> : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function AdsCampaignTable({
  brandKey,
  start,
  end,
  campaigns,
  loading,
  channel,
  onChannelChange,
  formatAmount,
}) {
  const theme = useTheme();
  const colors = CHANNEL_COLORS[theme.palette.mode === "dark" ? "dark" : "light"];
  const [sort, setSort] = useState({ key: "spend", direction: "desc" });
  const [search, setSearch] = useState("");
  const [alertingOnly, setAlertingOnly] = useState(false);
  const [expanded, setExpanded] = useState(null);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (campaigns || [])
      .filter((c) => !needle || c.campaignName.toLowerCase().includes(needle) || c.campaignId.includes(needle))
      .filter((c) => !alertingOnly || c.alerts?.length)
      .sort((a, b) => compare(a, b, sort.key, sort.direction));
  }, [campaigns, search, alertingOnly, sort]);

  const alertingCount = (campaigns || []).filter((c) => c.alerts?.length).length;

  const toggleSort = (key) =>
    setSort((prev) => (prev.key === key ? { key, direction: prev.direction === "desc" ? "asc" : "desc" } : { key, direction: "desc" }));

  return (
    <Card variant="outlined">
      <Stack
        direction={{ xs: "column", md: "row" }}
        spacing={1.5}
        alignItems={{ xs: "stretch", md: "center" }}
        justifyContent="space-between"
        sx={{ p: 2 }}
      >
        <ToggleButtonGroup size="small" exclusive value={channel} onChange={(_e, next) => next && onChannelChange(next)}>
          {["all", "meta", "google"].map((id) => (
            <ToggleButton key={id} value={id}>
              {CHANNEL_LABELS[id]}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
          <FormControlLabel
            control={<Switch size="small" checked={alertingOnly} onChange={(e) => setAlertingOnly(e.target.checked)} />}
            label={<Typography variant="body2">Only alerting ({alertingCount})</Typography>}
          />
          <TextField size="small" placeholder="Search campaigns" value={search} onChange={(e) => setSearch(e.target.value)} />
        </Stack>
      </Stack>

      <TableContainer sx={{ maxHeight: 640 }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: 36 }} />
              <TableCell>Campaign</TableCell>
              {COLUMNS.map((col) => (
                <TableCell key={col.id} align="right" sortDirection={sort.key === col.id ? sort.direction : false}>
                  <TableSortLabel
                    active={sort.key === col.id}
                    direction={sort.key === col.id ? sort.direction : "desc"}
                    onClick={() => toggleSort(col.id)}
                  >
                    <Box component="span" sx={{ textAlign: "right" }}>
                      {col.label}
                      {col.sub ? (
                        <Typography variant="caption" color="text.secondary" component="div" sx={{ lineHeight: 1 }}>
                          {col.sub}
                        </Typography>
                      ) : null}
                    </Box>
                  </TableSortLabel>
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {loading ? (
              [0, 1, 2, 3].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={COLUMNS.length + 2}>
                    <Skeleton />
                  </TableCell>
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMNS.length + 2}>
                  <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: "center" }}>
                    No campaigns for this range{alertingOnly ? " match an alert" : ""}.
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((campaign) => {
                const key = `${campaign.channel}:${campaign.campaignId}`;
                const open = expanded === key;
                return (
                  <Fragment key={key}>
                    <TableRow hover onClick={() => setExpanded(open ? null : key)} sx={{ cursor: "pointer", "& > td": { borderBottom: open ? "none" : undefined } }}>
                      <TableCell>
                        <IconButton size="small" aria-label={open ? "Hide ads" : "Show ads"}>
                          {open ? <KeyboardArrowDownIcon fontSize="small" /> : <KeyboardArrowRightIcon fontSize="small" />}
                        </IconButton>
                      </TableCell>
                      <TableCell sx={{ maxWidth: 340 }}>
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Box sx={{ width: 8, height: 8, borderRadius: "2px", flexShrink: 0, bgcolor: colors[campaign.channel] }} />
                          <Typography variant="body2" noWrap title={campaign.campaignName} sx={{ fontWeight: 500 }}>
                            {campaign.campaignName}
                          </Typography>
                          <AlertBadge alerts={campaign.alerts} formatAmount={formatAmount} />
                        </Stack>
                        <Typography variant="caption" color="text.secondary" noWrap component="div">
                          {CHANNEL_LABELS[campaign.channel]}
                          {campaign.type ? ` · ${campaign.type.replace(/_/g, " ").toLowerCase()}` : ""}
                          {campaign.status ? ` · ${campaign.status.toLowerCase()}` : ""}
                        </Typography>
                      </TableCell>
                      {COLUMNS.map((col) => (
                        <TableCell key={col.id} align="right">
                          {formatCell(col.type, campaign[col.id], formatAmount)}
                        </TableCell>
                      ))}
                    </TableRow>
                    <TableRow>
                      <TableCell colSpan={COLUMNS.length + 2} sx={{ py: 0, bgcolor: "action.hover" }}>
                        <Collapse in={open} timeout="auto" unmountOnExit>
                          <Box sx={{ py: 1.5, px: 1 }}>
                            <CampaignAds brandKey={brandKey} start={start} end={end} campaign={campaign} formatAmount={formatAmount} />
                          </Box>
                        </Collapse>
                      </TableCell>
                    </TableRow>
                  </Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </Card>
  );
}
