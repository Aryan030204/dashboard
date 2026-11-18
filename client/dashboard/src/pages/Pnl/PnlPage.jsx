import { useCallback, useEffect, useMemo, useState } from "react";
import { useTheme } from "@mui/material";
import dayjs from "dayjs";
import { getPnlCostConfigs, getPnlSeries, getPnlSummary } from "../../lib/api.js";
import { useInrCurrency } from "../../lib/currency.js";
import "./pnl.css";
import PnlHeader from "./components/PnlHeader.jsx";
import PnlKpiRow from "./components/PnlKpiRow.jsx";
import PnlTrendChart from "./components/PnlTrendChart.jsx";
import PnlCostMix from "./components/PnlCostMix.jsx";
import PnlStatement from "./components/PnlStatement.jsx";
import PnlMetaAdsSection from "./components/PnlMetaAdsSection.jsx";
import PnlGoogleAdsSection from "./components/PnlGoogleAdsSection.jsx";
import PnlProductCogsCard from "./components/PnlProductCogsCard.jsx";
import { Banner } from "./components/pnlUi.jsx";
import { DEFAULT_PRESET, formatRange, rangeForPreset } from "./pnlFormat.js";

const AD_SOURCES = [
  { id: "meta", label: "Meta Ads", spendKey: "metaAdSpend" },
  { id: "google", label: "Google Ads", spendKey: "googleAdSpend" },
];

function scrollToId(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Loads `fetcher(args)` whenever `key` changes; ignores stale responses.
function useLoad(fetcher, args, key, enabled = true) {
  const [state, setState] = useState({ data: null, loading: false, error: false });
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: false }));
    fetcher(args)
      .then((result) => {
        if (cancelled) return;
        if (result?.error) setState({ data: null, loading: false, error: true });
        else setState({ data: result, loading: false, error: false });
      })
      .catch(() => {
        if (!cancelled) setState({ data: null, loading: false, error: true });
      });
    return () => {
      cancelled = true;
    };
    // `key` stands in for `args`, which is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return state;
}

export default function PnlPage({ brandKey }) {
  const dark = useTheme().palette.mode === "dark";
  const { formatAmount } = useInrCurrency(brandKey);

  const [granularity, setGranularity] = useState("daily");
  const [preset, setPreset] = useState(DEFAULT_PRESET.daily);
  const [customRange, setCustomRange] = useState(null);
  const range = useMemo(
    () => (preset === "custom" && customRange ? customRange : rangeForPreset(preset)),
    [preset, customRange],
  );

  const [metric, setMetric] = useState("netSales");
  const [selected, setSelected] = useState(null);
  const [collapsed, setCollapsed] = useState({});
  const [highlighted, setHighlighted] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [configTick, setConfigTick] = useState(0);
  const [adSources, setAdSources] = useState({ meta: null, google: null });
  const [openSignals, setOpenSignals] = useState({ meta: 0, google: 0 });
  const [dismissed, setDismissed] = useState({});

  // A new brand, range or granularity starts from the full range.
  useEffect(() => {
    setSelected(null);
  }, [brandKey, range.start, range.end, granularity]);
  useEffect(() => {
    setHighlighted(null);
    setDismissed({});
    setAdSources({ meta: null, google: null });
  }, [brandKey]);

  const seriesArgs = { brand_key: brandKey, start: range.start, end: range.end, granularity };
  const series = useLoad(
    getPnlSeries,
    seriesArgs,
    `${brandKey}|${range.start}|${range.end}|${granularity}|${refreshTick}`,
    !!brandKey,
  );

  // A selected bar narrows the summary to that bucket, compared with the
  // bucket it's charted against.
  const bucket = selected != null ? series.data?.current?.[selected] : null;
  const prevBucket = selected != null ? series.data?.previous?.[selected] : null;
  const scope = bucket
    ? { start: bucket.start, end: bucket.end, compareStart: prevBucket?.start, compareEnd: prevBucket?.end }
    : { start: range.start, end: range.end };
  const summaryArgs = { brand_key: brandKey, granularity, ...scope };
  const summaryState = useLoad(
    getPnlSummary,
    summaryArgs,
    `${brandKey}|${scope.start}|${scope.end}|${scope.compareStart}|${scope.compareEnd}|${granularity}|${refreshTick}`,
    !!brandKey,
  );
  const summary = summaryState.data;

  const configState = useLoad(getPnlCostConfigs, { brand_key: brandKey }, `${brandKey}|${configTick}`, !!brandKey);
  const [config, setConfig] = useState(null);
  useEffect(() => {
    setConfig(configState.data?.data?.config || null);
  }, [configState.data]);

  const rows = useMemo(() => summary?.lineItems || [], [summary]);
  const lines = useMemo(() => Object.fromEntries(rows.map((r) => [r.key, r])), [rows]);
  const scopeLabel = formatRange(summary?.start || scope.start, summary?.end || scope.end);
  const prevLabel = summary?.previousStart ? formatRange(summary.previousStart, summary.previousEnd) : "the previous period";
  const days = dayjs(scope.end).diff(dayjs(scope.start), "day") + 1;

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);
  const onMetaStatus = useCallback((status) => setAdSources((s) => ({ ...s, meta: status })), []);
  const onGoogleStatus = useCallback((status) => setAdSources((s) => ({ ...s, google: status })), []);
  const openSource = (source) => {
    setOpenSignals((s) => ({ ...s, [source]: s[source] + 1 }));
    scrollToId(`source-${source}`);
  };
  const dismiss = (key) => setDismissed((d) => ({ ...d, [key]: true }));

  // ---- Banners ---------------------------------------------------------
  const banners = [];
  if (summaryState.error) {
    banners.push(
      <Banner key="error" tone="bad" title="Couldn't load the P&L." action="Try again" onAction={refresh}>
        Check your connection and try again.
      </Banner>,
    );
  }
  const coverage = summary?.coverage;
  if (!summaryState.loading && coverage) {
    if (coverage.days === 0) {
      banners.push(
        <Banner key="coverage" title={`No P&L figures have been built for ${scopeLabel} yet.`}>
          {coverage.previousDays > 0 ? "The previous period's figures are unaffected. " : ""}
          Connect or reconnect an ad account to rebuild the last 30 days, or wait for tonight&apos;s run.
        </Banner>,
      );
    } else if (coverage.days < coverage.expectedDays && !dismissed.partial) {
      banners.push(
        <Banner key="partial" tone="info" onDismiss={() => dismiss("partial")}>
          Figures cover {coverage.days} of {coverage.expectedDays} days in this range; the rest haven&apos;t been
          built yet.
        </Banner>,
      );
    }
  }
  if (!summaryState.loading && summary) {
    for (const source of AD_SOURCES) {
      const spend = summary[source.spendKey];
      const status = adSources[source.id];
      if (!spend || spend.available !== false || !status || dismissed[source.id]) continue;
      banners.push(
        status.connected ? (
          <Banner
            key={source.id}
            title={`${source.label} spend isn't synced for this range yet.`}
            onDismiss={() => dismiss(source.id)}
          >
            It shows as a dash in CM2 until the sync catches up.
          </Banner>
        ) : (
          <Banner
            key={source.id}
            title={`${source.label} isn't connected.`}
            action={`Connect ${source.label}`}
            onAction={() => openSource(source.id)}
            onDismiss={() => dismiss(source.id)}
          >
            Its spend is missing from CM2 and shows as a dash until you connect it.
          </Banner>
        ),
      );
    }
  }

  return (
    <div className={`pnl ${dark ? "t-dark" : "t-light"}`}>
      <PnlHeader
        granularity={granularity}
        onGranularityChange={(g) => {
          setGranularity(g);
          setPreset(DEFAULT_PRESET[g]);
          setCustomRange(null);
        }}
        preset={preset}
        range={range}
        onPresetChange={(p) => {
          setPreset(p);
          setCustomRange(null);
        }}
        onCustomRange={(start, end) => {
          setCustomRange({ start, end });
          setPreset("custom");
        }}
      />

      {banners}

      <PnlKpiRow
        kpis={summary?.kpis}
        points={series.data?.current || []}
        selected={selected}
        metric={metric}
        onMetricChange={setMetric}
        loading={summaryState.loading || (!summary && !summaryState.error)}
        formatAmount={formatAmount}
      />

      <div className="pnl-duo">
        <PnlTrendChart
          series={series.data}
          metric={metric}
          selected={selected}
          onSelect={setSelected}
          loading={series.loading || (!series.data && !series.error)}
          error={series.error}
          onRetry={refresh}
          formatAmount={formatAmount}
        />
        <PnlCostMix
          lines={lines}
          scopeLabel={scopeLabel}
          highlighted={highlighted}
          onPick={(section) => {
            setHighlighted((h) => (h === section ? null : section));
            setCollapsed((c) => ({ ...c, [section]: false }));
            scrollToId("statement");
          }}
          loading={summaryState.loading || (!summary && !summaryState.error)}
          formatAmount={formatAmount}
        />
      </div>

      <PnlStatement
        brandKey={brandKey}
        rows={rows}
        loading={summaryState.loading || (!summary && !summaryState.error)}
        scopeLabel={scopeLabel}
        prevLabel={prevLabel}
        hasSelection={selected != null}
        onClearSelection={() => setSelected(null)}
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
        highlighted={highlighted}
        config={config}
        configError={configState.error ? "Couldn't load this brand's cost settings." : ""}
        onConfigSaved={(next) => (next ? setConfig(next) : setConfigTick((t) => t + 1))}
        adSources={adSources}
        onOpenSource={openSource}
        days={days}
        formatAmount={formatAmount}
      />

      <section id="sources" className="pnl-sources" aria-label="Data sources">
        <h2 className="pnl-h2">Data sources</h2>
        <div className="pnl-source-grid">
          <PnlMetaAdsSection
            brandKey={brandKey}
            onConnectionChange={refresh}
            onStatusChange={onMetaStatus}
            openSignal={openSignals.meta}
          />
          <PnlGoogleAdsSection
            brandKey={brandKey}
            onConnectionChange={refresh}
            onStatusChange={onGoogleStatus}
            openSignal={openSignals.google}
          />
          <PnlProductCogsCard brandKey={brandKey} onUploaded={() => setConfigTick((t) => t + 1)} />
        </div>
      </section>
    </div>
  );
}
