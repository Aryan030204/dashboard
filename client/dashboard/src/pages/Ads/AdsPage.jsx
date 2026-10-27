import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Stack, Tab, Tabs, Typography } from "@mui/material";
import SyncIcon from "@mui/icons-material/Sync";
import dayjs from "dayjs";
import {
  getAdsCampaigns,
  getAdsLandingPages,
  getAdsOverview,
  getAdsProducts,
  triggerAdsSync,
} from "../../lib/api.js";
import { useInrCurrency } from "../../lib/currency.js";
import { FunnelRangeOrDatePicker } from "../../components/DailyFunnelPanel.jsx";
import AdsOverview from "./components/AdsOverview.jsx";
import AdsCampaignTable from "./components/AdsCampaignTable.jsx";
import AdsProductTable from "./components/AdsProductTable.jsx";
import AdsLandingPagesPanel from "./components/AdsLandingPagesPanel.jsx";
import AdsAlertsPanel from "./components/AdsAlertsPanel.jsx";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "campaigns", label: "Campaigns" },
  { id: "products", label: "Products" },
  { id: "landing", label: "LC → LPV & site speed" },
  { id: "alerts", label: "Alerts" },
];

function formatDate(value) {
  return dayjs(value).format("YYYY-MM-DD");
}

// Loads one tab's data for the current range; refetches when any dep changes.
function useAdsData(loader, args, enabled, deps) {
  const [state, setState] = useState({ data: null, loading: false, error: false });
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: false }));
    loader(args).then((result) => {
      if (cancelled) return;
      setState({ data: result?.error ? null : result?.data || null, loading: false, error: Boolean(result?.error) });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);
  return state;
}

export default function AdsPage({ brandKey }) {
  // The worker syncs through yesterday, so default to the last 7 complete days.
  const [rangeStart, setRangeStart] = useState(() => formatDate(dayjs().subtract(7, "day")));
  const [rangeEnd, setRangeEnd] = useState(() => formatDate(dayjs().subtract(1, "day")));
  const [tab, setTab] = useState("overview");
  const [channel, setChannel] = useState("all");
  const [refreshTick, setRefreshTick] = useState(0);
  const [syncNote, setSyncNote] = useState(null);
  const [syncing, setSyncing] = useState(false);

  const { formatAmount } = useInrCurrency(brandKey);
  const args = useMemo(() => ({ brand_key: brandKey, start: rangeStart, end: rangeEnd }), [brandKey, rangeStart, rangeEnd]);
  const rangeDeps = [brandKey, rangeStart, rangeEnd, refreshTick];

  const overview = useAdsData(getAdsOverview, args, Boolean(brandKey), rangeDeps);
  const campaigns = useAdsData(getAdsCampaigns, { ...args, channel }, Boolean(brandKey) && tab === "campaigns", [...rangeDeps, channel]);
  const products = useAdsData(getAdsProducts, args, Boolean(brandKey) && tab === "products", rangeDeps);
  const landing = useAdsData(getAdsLandingPages, args, Boolean(brandKey) && tab === "landing", rangeDeps);

  const notSetUp = overview.data && overview.data.setup === false;
  const nothingSynced = overview.data?.setup && !overview.data.coverage?.syncedDays;
  const noneInRange = overview.data?.setup && overview.data.coverage?.syncedDays > 0 && !overview.data.coverage?.daysInRange;

  const handleSync = async () => {
    setSyncing(true);
    const result = await triggerAdsSync({ brand_key: brandKey });
    setSyncing(false);
    const data = result?.data || {};
    if (data.syncing) {
      setSyncNote({ severity: "success", text: "Sync started for the last 30 days. Figures update in a few minutes — refresh to see them." });
    } else if (data.reason === "not_configured") {
      setSyncNote({ severity: "warning", text: "Manual sync isn't configured on this server; data refreshes with the nightly run." });
    } else {
      setSyncNote({ severity: "error", text: "Couldn't start a sync right now. Try again in a minute." });
    }
  };

  return (
    <Stack spacing={2.5} sx={{ p: { xs: 1.5, md: 2 } }}>
      <Stack direction={{ xs: "column", sm: "row" }} alignItems={{ xs: "flex-start", sm: "center" }} justifyContent="space-between" spacing={1.5}>
        <Stack spacing={0.25}>
          <Typography variant="h4" sx={{ fontWeight: 600 }} color="text.primary">
            Ads
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Meta &amp; Google performance by campaign, product and landing page
            {overview.data?.coverage?.lastSyncedDate
              ? ` · synced through ${dayjs(overview.data.coverage.lastSyncedDate).format("D MMM YYYY")}`
              : ""}
          </Typography>
        </Stack>
        <Stack direction="row" spacing={1.25} alignItems="center" flexWrap="wrap" useFlexGap>
          <FunnelRangeOrDatePicker
            startDate={rangeStart}
            endDate={rangeEnd}
            onApply={(nextStart, nextEnd) => {
              setRangeStart(nextStart);
              setRangeEnd(nextEnd);
            }}
            compact
          />
          <Button size="small" variant="outlined" startIcon={<SyncIcon />} onClick={handleSync} disabled={syncing || !brandKey}>
            {syncing ? "Starting…" : "Sync now"}
          </Button>
        </Stack>
      </Stack>

      {syncNote ? (
        <Alert severity={syncNote.severity} onClose={() => setSyncNote(null)}>
          {syncNote.text}
        </Alert>
      ) : null}
      {overview.error ? <Alert severity="error">Failed to load ad performance.</Alert> : null}
      {notSetUp ? (
        <Alert severity="info">
          Ad performance tables aren't set up for this brand yet (pipeline migration 007_ads_performance.sql). Once
          they are, the nightly P&amp;L run fills them from the Meta / Google accounts connected on the P&amp;L page.
        </Alert>
      ) : null}
      {nothingSynced ? (
        <Alert severity="info">
          No ad performance has been synced yet. Connect Meta (System User token) or Google on the P&amp;L page, then
          use <strong>Sync now</strong> to backfill the last 30 days.
        </Alert>
      ) : null}
      {noneInRange ? (
        <Alert severity="info">Nothing synced for {rangeStart} – {rangeEnd}. Try a range ending on or before the last synced date.</Alert>
      ) : null}

      <Tabs value={tab} onChange={(_e, next) => setTab(next)} variant="scrollable" allowScrollButtonsMobile>
        {TABS.map((t) => (
          <Tab key={t.id} value={t.id} label={t.label} />
        ))}
      </Tabs>

      {tab === "overview" ? <AdsOverview overview={overview.data} loading={overview.loading} formatAmount={formatAmount} /> : null}
      {tab === "campaigns" ? (
        <>
          {campaigns.error ? <Alert severity="error">Failed to load campaigns.</Alert> : null}
          <AdsCampaignTable
            brandKey={brandKey}
            start={rangeStart}
            end={rangeEnd}
            campaigns={campaigns.data?.campaigns}
            loading={campaigns.loading}
            channel={channel}
            onChannelChange={setChannel}
            formatAmount={formatAmount}
          />
        </>
      ) : null}
      {tab === "products" ? (
        <>
          {products.error ? <Alert severity="error">Failed to load products.</Alert> : null}
          <AdsProductTable data={products.data} loading={products.loading} formatAmount={formatAmount} />
        </>
      ) : null}
      {tab === "landing" ? (
        <>
          {landing.error ? <Alert severity="error">Failed to load landing pages.</Alert> : null}
          <AdsLandingPagesPanel data={landing.data} loading={landing.loading} formatAmount={formatAmount} />
        </>
      ) : null}
      {tab === "alerts" ? (
        <AdsAlertsPanel brandKey={brandKey} formatAmount={formatAmount} onRulesChange={() => setRefreshTick((t) => t + 1)} />
      ) : null}
    </Stack>
  );
}
