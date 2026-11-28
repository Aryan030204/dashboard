import { useEffect, useState } from "react";
import { Alert, Button, Skeleton, Stack } from "@mui/material";
import { PageHeader } from "../../components/datum/index.js";
import { getMarketplaceOverview } from "../../lib/api.js";
import { kpis, rangeParams, shortDay } from "./marketplaceFormat.js";
import FilterRow from "./components/FilterRow.jsx";
import KpiRow from "./components/KpiRow.jsx";
import GapChart from "./components/GapChart.jsx";
import ProductTable from "./components/ProductTable.jsx";
import ProductHistory from "./components/ProductHistory.jsx";
import "./marketplace.css";

// The response is kept with the request it answers, so a slower earlier brand or range is never shown.
function useOverview(brandKey, params, pincode, attempt) {
  const key = JSON.stringify([brandKey, params, pincode, attempt]);
  const [state, setState] = useState({ key: null, brandKey: null, data: null, error: false });
  useEffect(() => {
    const controller = new AbortController();
    const [brand, range, pin] = JSON.parse(key);
    getMarketplaceOverview({ brandKey: brand, ...range, pincode: pin, signal: controller.signal }).then((res) => {
      if (res.aborted) return;
      setState({ key, brandKey: brand, data: res.error ? null : res.data, error: Boolean(res.error) });
    });
    return () => controller.abort();
  }, [key]);
  const current = state.key === key;
  // While a new range loads, the same brand's previous answer stays on screen.
  return {
    data: state.brandKey === brandKey ? state.data : null,
    error: current && state.error,
    loading: !current,
  };
}

function Page({ brandKey }) {
  const [preset, setPreset] = useState("3M");
  const [custom, setCustom] = useState(null);
  const [unit, setUnit] = useState("pct");
  const [pincode, setPincode] = useState("");
  const [hidden, setHidden] = useState([]);
  const [variantId, setVariantId] = useState(null);
  const [attempt, setAttempt] = useState(0);

  const params = rangeParams(preset, custom);
  const { data, loading, error } = useOverview(brandKey, params, pincode, attempt);

  const marketplaces = data?.marketplaces || [];
  const codes = marketplaces.map((m) => m.code).filter((c) => !hidden.includes(c));
  const shown = marketplaces.filter((m) => codes.includes(m.code));
  const names = Object.fromEntries(marketplaces.map((m) => [m.code, m.name]));
  const products = data?.products || [];
  const rows = products.filter((row) => codes.some((code) => row.cells[code]?.state !== "unlisted"));
  const known = products.some((p) => p.sizes.some((s) => s.variantId === variantId));
  const selected = known ? variantId : rows[0]?.variantId ?? null;

  const select = (id) => setVariantId(id);

  return (
    <div className="mh-page">
      <PageHeader
        title="Marketplace history"
        description="How our website prices compare with marketplaces, and how both moved over time."
        meta={data?.asOf ? [`Latest price check: ${shortDay(data.asOf)}`, `History since ${shortDay(data.firstDay)}`] : []}
      />
      <FilterRow
        preset={preset}
        custom={custom}
        onPreset={(value) => { setPreset(value); setCustom(null); }}
        onCustom={setCustom}
        unit={unit}
        onUnit={setUnit}
        marketplaces={marketplaces}
        selected={codes}
        onSelected={(next) => setHidden(marketplaces.map((m) => m.code).filter((c) => !next.includes(c)))}
        pincodes={data?.pincodes || []}
        pincode={data?.pincode || pincode}
        onPincode={setPincode}
      />

      {error && (
        <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>}>
          Could not load marketplace prices.
        </Alert>
      )}
      {loading && !data && !error && (
        <Stack spacing={1.5} role="status" aria-label="Loading marketplace prices">
          <Skeleton variant="rounded" height={92} />
          <Skeleton variant="rounded" height={340} />
          <Skeleton variant="rounded" height={260} />
        </Stack>
      )}
      {data && data.available === false && (
        <Alert severity="info">Marketplace tracking is not set up for this brand yet.</Alert>
      )}
      {data && data.available !== false && products.length === 0 && (
        <Alert severity="info">No marketplace listings yet. They appear once matches are made or approved.</Alert>
      )}
      {data && data.available !== false && products.length > 0 && (
        <Stack spacing={2.5} sx={{ opacity: loading ? 0.6 : 1 }} aria-busy={loading}>
          <KpiRow summary={kpis(rows, codes)} names={names} asOf={data.asOf} />
          <GapChart series={data.series} codes={codes} names={names} unit={unit} />
          <ProductTable rows={rows} marketplaces={shown} unit={unit} selectedVariant={selected} onSelect={select} />
          <ProductHistory
            brandKey={brandKey}
            products={products}
            variantId={selected}
            onSelect={select}
            preset={preset}
            custom={custom}
            pincode={data.pincode}
            unit={unit}
          />
        </Stack>
      )}
    </div>
  );
}

// A new brand starts from the default filters.
export default function MarketplaceHistoryPage({ brandKey }) {
  return <Page key={brandKey} brandKey={brandKey} />;
}
