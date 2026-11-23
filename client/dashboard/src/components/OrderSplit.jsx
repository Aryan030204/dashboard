import { useEffect, useState } from 'react';
import { Card, CardContent, Typography, Skeleton, Stack, useTheme } from '@mui/material';
import { GlassChip } from './ui/GlassChip.jsx';
import { Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  BarElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
} from 'chart.js';
import { getOrderSplit } from '../lib/api.js';

ChartJS.register(BarElement, CategoryScale, LinearScale, Tooltip, Legend);

const nfInt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const nfPct1 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export default function OrderSplit({ query }) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState({ cod_orders: 0, prepaid_orders: 0, partially_paid_orders: 0, total: 0, cod_percent: 0, prepaid_percent: 0, partially_paid_percent: 0 });
  const brandKey = query?.brand_key;
  const refreshKey = query?.refreshKey;
  const productId = query?.product_id || '';

  useEffect(() => {
    let cancelled = false;
    if (!query?.start || !query?.end) {
      setData({ cod_orders: 0, prepaid_orders: 0, partially_paid_orders: 0, total: 0, cod_percent: 0, prepaid_percent: 0, partially_paid_percent: 0 });
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
    getOrderSplit(params)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setLoading(false);
      })
      .catch(() => setLoading(false));
    return () => { cancelled = true; };
  }, [query.start, query.end, brandKey, productId, refreshKey, query.utm_source, query.utm_medium, query.utm_campaign, query.sales_channel, query.device_type, query.discount_code, query.city]);

  const empty = data.total === 0;

  const chartData = {
    labels: ['Payment split'],
    datasets: [
      {
        label: 'COD',
        data: [data.cod_percent],
        backgroundColor: '#eb6834',
        borderRadius: 8,
        barThickness: 28,
        stack: 'percent',
      },
      {
        label: 'Prepaid',
        data: [data.prepaid_percent],
        backgroundColor: '#2a78d6',
        borderRadius: 8,
        barThickness: 28,
        stack: 'percent',
      },
      {
        label: 'Partially paid',
        data: [data.partially_paid_percent],
        backgroundColor: '#1baf7a',
        borderRadius: 8,
        barThickness: 28,
        stack: 'percent',
      },
    ],
  };

  const options = {
    indexAxis: 'y',
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
            const label = ctx.dataset.label || '';
            let count = 0;
            if (label === 'COD') count = data.cod_orders;
            else if (label === 'Prepaid') count = data.prepaid_orders;
            else if (label === 'Partially paid') count = data.partially_paid_orders;
            const pct = ctx.parsed.x;
            return `${label}: ${nfInt.format(count)} (${nfPct1.format(pct)}%)`;
          }
        }
      }
    },
    scales: {
      x: {
        stacked: true,
        beginAtZero: true,
        max: 100,
        ticks: { display: false },
        grid: { display: false },
        border: { display: false },
      },
      y: {
        stacked: true,
        grid: { display: false },
        border: { display: false },
        ticks: {
          color: isDark ? '#e0e0e0' : '#666'
        }
      },
    },
  };

  return (
    <Card elevation={0}>
      <CardContent sx={{ minHeight: 180 }}>
        <Typography variant="subtitle2" color="text.primary" sx={{ mb: 1 }}>
          Payment split (By Order Count)
        </Typography>
        {loading ? (
          <Skeleton variant="rounded" width="100%" height={120} />
        ) : empty ? (
          <Typography variant="body2" color="text.secondary">No orders in selected range.</Typography>
        ) : (
          <>
            <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: 'wrap', rowGap: 0.5, columnGap: 0.5 }}>
              <GlassChip size="small" label={`COD ${nfPct1.format(data.cod_percent)}% (${nfInt.format(data.cod_orders)})`} color="warning" isDark={isDark} />
              <GlassChip size="small" label={`Prepaid ${nfPct1.format(data.prepaid_percent)}% (${nfInt.format(data.prepaid_orders)})`} color="success" isDark={isDark} />
              <GlassChip size="small" label={`Partially paid ${nfPct1.format(data.partially_paid_percent)}% (${nfInt.format(data.partially_paid_orders)})`} color="primary" isDark={isDark} />
            </Stack>
            <div style={{ position: 'relative', height: 120 }}>
              <Bar data={chartData} options={options} />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
