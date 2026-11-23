import React from 'react';
import { Skeleton, useTheme, Box } from '@mui/material';
import { alpha } from '@mui/material/styles';
import dayjs from 'dayjs';
import { useInrCurrency } from '../lib/currency.js';
import { useDashboardModeOfPaymentData } from "../features/dashboard/widgetDataHooks.js";

const COLORS = {
    Prepaid: '#2cc995',
    Partial: '#8da399',
    COD: '#1f5748',
};

const LABELS = {
    Prepaid: 'Prepaid',
    Partial: 'Partially paid',
    COD: 'COD'
};

const METRIC_TYPES = {
    QUANTITY: 'quantity',
    VALUE: 'value'
};

function getPreviousRange(start, end) {
    if (!start || !end) return { start: null, end: null };
    const s = dayjs(start);
    const e = dayjs(end);
    const diff = e.diff(s, 'day') + 1;
    const prevEnd = s.subtract(1, 'day');
    const prevStart = prevEnd.subtract(diff - 1, 'day');
    return {
        start: prevStart.format('YYYY-MM-DD'),
        end: prevEnd.format('YYYY-MM-DD')
    };
}

function getTimezoneParts(date, timezone) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone || 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hour12: false,
    });
    const parts = formatter.formatToParts(date).reduce((acc, part) => {
        if (part.type !== 'literal') acc[part.type] = part.value;
        return acc;
    }, {});
    const hour = Number(parts.hour || 0);
    return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        hour: hour === 24 ? 0 : hour,
    };
}

function getHourlyCutoffForTodayRange(start, end, timezone) {
    if (!start || !end) return null;

    const nowLocal = getTimezoneParts(new Date(), timezone);
    const includesToday = start <= nowLocal.date && end >= nowLocal.date;

    if (!includesToday) return null;

    return Math.max(0, nowLocal.hour - 1);
}

// Share of a payment type: the hook's percent when present, otherwise value / total (null when unavailable).
const shareOf = (entry, rawTotal) => {
    if (entry.percent === null) return null;
    if (entry.percent !== undefined) return Number(entry.percent);
    return rawTotal > 0 ? (entry.value / rawTotal) * 100 : 0;
};

const TREND_RADIOS = {
    quantity: 'payment_orders',
    value: 'payment_sales',
};

const ModeOfPayment = React.memo(function ModeOfPayment({
    query,
    selectedMetrics = [],
    onToggleMetric,
}) {
    const theme = useTheme();
    const isDark = theme.palette.mode === 'dark';
    const start = query?.start;
    const end = query?.end;
    const brandKey = query?.brand_key;
    const productId = query?.product_id;
    const utmSource = query?.utm_source;
    const utmMedium = query?.utm_medium;
    const utmCampaign = query?.utm_campaign;
    const salesChannel = query?.sales_channel;
    const deviceType = query?.device_type;
    const discountCode = query?.discount_code;
    const city = query?.city;
    const timezone = query?.timezone;
    const { convertAmount, formatConvertedAmount } = useInrCurrency(brandKey, end);
    const { loading, prevRange, data } = useDashboardModeOfPaymentData({
        query,
        convertAmount,
        formatConvertedAmount,
    });

    // Presentation: swatch colors follow the Datum series palette by payment type; values/percentages come from the hook unchanged.
    const colorFor = (entry) => {
        const n = String(entry.name || '').toLowerCase();
        if (n.includes('partial')) return 'var(--dz-c3)';
        if (n.includes('prepaid')) return 'var(--dz-c1)';
        if (n.includes('cod')) return 'var(--dz-c2)';
        return entry.color;
    };

    const renderChart = (title, chartData, totalLabel, rawTotal, trendMetricKey) => {
        const isSelected = selectedMetrics.includes(trendMetricKey);
        const pctOf = (entry) => {
            if (entry.percent === null) return null;
            if (entry.percent !== undefined) return Number(entry.percent);
            return rawTotal > 0 ? (entry.value / rawTotal) * 100 : 0;
        };
        const summary = chartData
            .map((entry) => {
                const p = pctOf(entry);
                return `${entry.name} ${p === null ? 'n/a' : `${p.toFixed(1)}%`}`;
            })
            .join(', ');
        return (
            <div style={{ flex: 1, minWidth: 0 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, mb: 0.75 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <span style={{ fontSize: 12.5, color: 'var(--dz-muted)' }}>{title}</span>
                        {typeof onToggleMetric === 'function' && (
                            <Box
                                component="button"
                                type="button"
                                aria-pressed={isSelected}
                                aria-label={`${isSelected ? 'Deselect' : 'Select'} ${title}`}
                                onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    onToggleMetric(trendMetricKey);
                                }}
                                sx={{
                                    width: 18,
                                    height: 18,
                                    borderRadius: '50%',
                                    border: '1.5px solid',
                                    borderColor: isSelected ? 'var(--dz-accent)' : alpha(theme.palette.text.secondary, 0.35),
                                    bgcolor: isSelected ? 'var(--dz-accent)' : 'transparent',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    transition: 'all 0.18s ease',
                                    cursor: 'pointer',
                                    p: 0,
                                    outline: 'none',
                                    appearance: 'none',
                                    WebkitAppearance: 'none',
                                    '&:focus-visible': { boxShadow: '0 0 0 2px var(--dz-accent-line)' },
                                }}
                            >
                                {isSelected && (
                                    <Box
                                        component="span"
                                        sx={{
                                            width: 7,
                                            height: 4,
                                            borderLeft: '2px solid #fff',
                                            borderBottom: '2px solid #fff',
                                            transform: 'rotate(-45deg) translateY(-1px)',
                                        }}
                                    />
                                )}
                            </Box>
                        )}
                    </Box>
                    <b className="dz-num" style={{ fontSize: 13 }}>{totalLabel}</b>
                </Box>
                <div className="dz-stackbar" role="img" aria-label={`${title}: ${summary}`}>
                    {chartData.map((entry, index) => {
                        const p = pctOf(entry);
                        return <i key={index} style={{ background: colorFor(entry), width: `${Math.max(0, p || 0)}%` }} title={`${entry.name}: ${entry.formattedValue}`} />;
                    })}
                </div>
            </div>
        );
    };

    const isToday = end ? dayjs(end).isSame(dayjs(), 'day') : false;

    const compareLabel = (() => {
        if (!(prevRange && start && end && !isToday)) return null;
        const fmt = (s0, e0) => {
            const st = dayjs(s0);
            const en = dayjs(e0);
            if (st.isSame(en, 'day')) return st.format('MMM D');
            return `${st.format('MMM D')} - ${en.format('MMM D')}`;
        };
        return `${fmt(start, end)} vs ${fmt(prevRange.start, prevRange.end)}`;
    })();

    return (
        <section className="dz-panel" style={{ width: '100%', height: '100%' }}>
            <div className="dz-ph">
                <div style={{ minWidth: 0 }}>
                    <h2 className="dz-pt">Mode of payment</h2>
                    <p className="dz-ps">{compareLabel || 'Orders and sales by payment type'}</p>
                </div>
            </div>
            <div className="dz-pb">
                {loading ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
                        {[1, 2].map((i) => (
                            <div key={i} style={{ flex: '1 1 240px' }}>
                                <Skeleton variant="text" width={120} />
                                <Skeleton variant="rounded" height={12} />
                                <Skeleton variant="text" width="100%" height={28} />
                                <Skeleton variant="text" width="100%" height={28} />
                            </div>
                        ))}
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                        {renderChart('Orders', data.quantity, data.totalQuantity, data.rawTotalQuantity, TREND_RADIOS.quantity)}
                        {renderChart('Sales', data.value, data.totalValue, data.rawTotalValue, TREND_RADIOS.value)}
                        <div className="dz-tw" style={{ border: '1px solid var(--dz-line)', borderRadius: 10 }}>
                            <table className="dz-tbl" aria-label="Mode of payment">
                                <thead>
                                    <tr>
                                        <th scope="col">Payment type</th>
                                        <th scope="col" className="is-r">Orders</th>
                                        <th scope="col" className="is-r">Share</th>
                                        <th scope="col" className="is-r">Sales</th>
                                        <th scope="col" className="is-r">Share</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.quantity.map((q, index) => {
                                        const v = (data.value || []).find((x) => x.name === q.name);
                                        const qp = shareOf(q, data.rawTotalQuantity);
                                        const vp = v ? shareOf(v, data.rawTotalValue) : null;
                                        return (
                                            <tr key={index}>
                                                <td>
                                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                                                        <i className="dz-sw" style={{ background: colorFor(q) }} />
                                                        {q.name}
                                                    </span>
                                                </td>
                                                <td className="is-r"><b style={{ fontWeight: 600 }}>{q.formattedValue}</b></td>
                                                <td className="is-r is-m">{qp === null ? '' : `${qp.toFixed(1)}%`}</td>
                                                <td className="is-r"><b style={{ fontWeight: 600 }}>{v ? v.formattedValue : ''}</b></td>
                                                <td className="is-r is-m">{vp === null ? '' : `${vp.toFixed(1)}%`}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}
            </div>
        </section>
    );
});

export default ModeOfPayment;
