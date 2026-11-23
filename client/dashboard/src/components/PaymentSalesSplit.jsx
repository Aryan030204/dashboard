import { useEffect, useState } from 'react';
import { Card, CardContent, Typography, Skeleton, Stack, Tooltip, useTheme } from '@mui/material';
import { GlassChip } from './ui/GlassChip.jsx';
import { Doughnut } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  ArcElement,
  Tooltip as ChartTooltip,
  Legend,
} from 'chart.js';
import { getPaymentSalesSplit } from '../lib/api.js';
import { useInrCurrency } from '../lib/currency.js';

ChartJS.register(ArcElement, ChartTooltip, Legend);

const nfPct1 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export default function PaymentSalesSplit({ query }) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState({ cod_sales: 0, prepaid_sales: 0, partial_sales: 0, total: 0, cod_percent: 0, prepaid_percent: 0, partial_percent: 0 });
  const brandKey = query?.brand_key;
  const refreshKey = query?.refreshKey;
  const productId = query?.product_id || '';
  const { convertAmount, formatConvertedAmount } = useInrCurrency(brandKey, query?.end);

  useEffect(() => {
    let cancelled = false;
    if (!query?.start || !query?.end) {
      setData({ cod_sales: 0, prepaid_sales: 0, partial_sales: 0, total: 0, cod_percent: 0, prepaid_percent: 0, partial_percent: 0 });
      setLoading(false);
      return () => { cancelled = true; };
    }
    setLoading(true);
    const params = {
      start: query.start,
      end: query.end,
      brand_key: brandKey,
      product_id: productId,
      utm_source: query.utm_source,
      utm_medium: query.utm_medium,
      utm_campaign: query.utm_campaign,
      sales_channel: query.sales_channel,
      device_type: query.device_type,
      discount_code: query.discount_code,
      city: query.city,
      refreshKey,
    };
    getPaymentSalesSplit(params)
      .then(res => { if (!cancelled) { setData(res); setLoading(false); } })
      .catch(() => setLoading(false));
    return () => { cancelled = true; };
  }, [query.start, query.end, brandKey, productId, refreshKey, query.utm_source, query.utm_medium, query.utm_campaign, query.sales_channel, query.device_type, query.discount_code, query.city]);

  const empty = data.total === 0;
  const convertedCodSales = convertAmount(data.cod_sales);
  const convertedPrepaidSales = convertAmount(data.prepaid_sales);
  const convertedPartialSales = convertAmount(data.partial_sales);
  const convertedTotal = convertAmount(data.total);

  const chartData = {
    labels: ['COD', 'Prepaid', 'Partially paid'],
    datasets: [
      {
        data: [convertedCodSales, convertedPrepaidSales, convertedPartialSales],
        // Darken partial slice slightly for better contrast (emerald-300)
        backgroundColor: ['#eb6834', '#2a78d6', '#1baf7a'],
        borderWidth: 0,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: true,
        position: 'bottom',
        labels: {
          color: isDark ? '#e0e0e0' : '#666'
        }
      },
      tooltip: {
        callbacks: {
          label: (ctx) => {
            const label = ctx.label;
            const raw = ctx.parsed;
            const pct = convertedTotal > 0 ? (raw / convertedTotal) * 100 : 0;
            return `${label}: ${formatConvertedAmount(raw, { maximumFractionDigits: 0 })} (${nfPct1.format(pct)}%)`;
          }
        }
      }
    }
  };

  return (
    <Card elevation={0}>
      <CardContent sx={{ minHeight: 260 }}>
        <Typography variant="subtitle2" color="text.primary" sx={{ mb: 1, display: 'flex', alignItems: 'center' }}>
          Payment split (By Sales)
          <Tooltip title="Does not include cancelled orders" arrow placement="right">
            <Typography component="span" variant="inherit" sx={{ fontWeight: 'bold', ml: 0.5, cursor: 'help' }}>*</Typography>
          </Tooltip>
        </Typography>
        {loading ? (
          <Skeleton variant="rounded" width="100%" height={180} />
        ) : empty ? (
          <Typography variant="body2" color="text.secondary">No sales in selected range.</Typography>
        ) : (
          <>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={0.75}
              sx={{ mb: 1, flexWrap: 'wrap', rowGap: 0.75, columnGap: 0.75 }}
              alignItems={{ xs: 'flex-start', sm: 'center' }}
            >
              <GlassChip
                size="small"
                label={`COD ${nfPct1.format(data.cod_percent)}% (${formatConvertedAmount(convertedCodSales, { notation: 'compact', maximumFractionDigits: 1 })})`}
                color="warning"
                isDark={isDark}
              />
              <GlassChip
                size="small"
                label={`Prepaid ${nfPct1.format(data.prepaid_percent)}% (${formatConvertedAmount(convertedPrepaidSales, { notation: 'compact', maximumFractionDigits: 1 })})`}
                color="success"
                isDark={isDark}
              />
              <GlassChip
                size="small"
                label={`Partial ${nfPct1.format(data.partial_percent)}% (${formatConvertedAmount(convertedPartialSales, { notation: 'compact', maximumFractionDigits: 1 })})`}
                color="primary"
                isDark={isDark}
              />
            </Stack>
            <div style={{ position: 'relative', height: 180 }}>
              <Doughnut data={chartData} options={options} />
            </div>
          </>
        )}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          * Cancellations not included.
        </Typography>
      </CardContent>
    </Card>
  );
}
