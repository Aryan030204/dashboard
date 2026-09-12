import { useEffect, useMemo, useState } from "react";
import { Alert, Stack, Typography } from "@mui/material";
import dayjs from "dayjs";
import { getPnlSummary } from "../../lib/api.js";
import { useInrCurrency } from "../../lib/currency.js";
import PnlFilterBar from "./components/PnlFilterBar.jsx";
import PnlKpiRow from "./components/PnlKpiRow.jsx";
import PnlTable from "./components/PnlTable.jsx";
import PnlConfigSection from "./components/PnlConfigSection.jsx";

function formatDate(value) {
  return dayjs(value).format("YYYY-MM-DD");
}

export default function PnlPage({ brandKey }) {
  const today = useMemo(() => formatDate(dayjs()), []);

  const [granularity, setGranularity] = useState("daily");
  const [rangeStart, setRangeStart] = useState(() => formatDate(dayjs().subtract(6, "day")));
  const [rangeEnd, setRangeEnd] = useState(today);

  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const { formatAmount } = useInrCurrency(brandKey);

  useEffect(() => {
    if (!brandKey) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    getPnlSummary({ brand_key: brandKey, start: rangeStart, end: rangeEnd, granularity })
      .then((result) => {
        if (cancelled) return;
        if (result?.error) {
          setSummary(null);
          setError("Failed to load P&L data.");
          return;
        }
        setSummary(result);
      })
      .catch(() => {
        if (cancelled) return;
        setSummary(null);
        setError("Failed to load P&L data.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [brandKey, rangeStart, rangeEnd, granularity]);

  const handleRangeChange = (nextStart, nextEnd) => {
    setRangeStart(nextStart);
    setRangeEnd(nextEnd);
  };

  const channelNote = summary?.filters?.channel?.available === false ? summary.filters.channel.message : null;
  const productNote = summary?.filters?.product?.available === false ? summary.filters.product.message : null;

  return (
    <Stack spacing={2.5} sx={{ p: { xs: 1.5, md: 2 } }}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        alignItems={{ xs: "flex-start", sm: "center" }}
        justifyContent="space-between"
        spacing={1.5}
      >
        <Stack spacing={0.25}>
          <Typography variant="h4" sx={{ fontWeight: 600 }} color="text.primary">
            P&amp;L
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Gross Sales → Net Sales → CM1 → CM2 → CM3 → EBITDA
          </Typography>
        </Stack>

        <PnlFilterBar
          start={rangeStart}
          end={rangeEnd}
          granularity={granularity}
          onRangeChange={handleRangeChange}
          onGranularityChange={setGranularity}
        />
      </Stack>

      {error ? <Alert severity="error">{error}</Alert> : null}
      {!loading && (channelNote || productNote) ? (
        <Alert severity="info">{channelNote || productNote}</Alert>
      ) : null}

      <Stack spacing={1}>
        <Typography variant="subtitle2" color="text.secondary">
          Summary
        </Typography>
        <PnlKpiRow kpis={summary?.kpis} loading={loading} formatAmount={formatAmount} />
      </Stack>

      <PnlTable
        rows={summary?.lineItems || []}
        loading={loading}
        start={summary?.start || rangeStart}
        end={summary?.end || rangeEnd}
        previousStart={summary?.previousStart}
        previousEnd={summary?.previousEnd}
        formatAmount={formatAmount}
      />

      <PnlConfigSection />
    </Stack>
  );
}
