import { Segmented } from './datum/index.js';
import { useEffect, useState, useMemo, useRef, memo } from 'react';
import { Card, CardContent, Typography, Skeleton, Stack, useTheme, Select, MenuItem, FormControl, Box, Grid, Alert } from '@mui/material';
import { TrendingUp, TrendingDown } from '@mui/icons-material';
import { Doughnut } from 'react-chartjs-2';
import {
    Chart as ChartJS,
    ArcElement,
    Tooltip as ChartTooltip,
} from 'chart.js';
import dayjs from 'dayjs';
import { useDashboardTrafficSourceSplitData } from "../features/dashboard/widgetDataHooks.js";

ChartJS.register(ArcElement, ChartTooltip);

const nfPct1 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const nfCompact = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });
const TRAFFIC_COLORS = {
    meta: '#2a78d6',
    google: '#eb6834',
    direct: '#1baf7a',
    others: '#eda100',
};

function useCountUp(end, duration = 800) {
    const [count, setCount] = useState(0);
    const countRef = useRef(0);

    useEffect(() => {
        let startTime = null;
        const startVal = countRef.current;
        const diff = end - startVal;

        if (diff === 0) return;

        let frameId;

        const animate = (timestamp) => {
            if (!startTime) startTime = timestamp;
            const progress = timestamp - startTime;
            const percentage = Math.min(progress / duration, 1);

            // Ease Out Quart
            const ease = 1 - Math.pow(1 - percentage, 4);

            const current = startVal + (diff * ease);
            setCount(current);
            countRef.current = current;

            if (progress < duration) {
                frameId = requestAnimationFrame(animate);
            } else {
                setCount(end);
                countRef.current = end;
            }
        };

        frameId = requestAnimationFrame(animate);
        return () => cancelAnimationFrame(frameId);
    }, [end, duration]);

    return count;
}

export default memo(function TrafficSourceSplit({ query, compareMode = false, mappingRules = [] }) {
    const theme = useTheme();
    const isDark = theme.palette.mode === 'dark';
    const [metric, setMetric] = useState('sessions'); // 'sessions' or 'atc_sessions'

    const effectiveMappingRules = useMemo(() => mappingRules || [], [mappingRules]);
    const { loading, data } = useDashboardTrafficSourceSplitData({
        query,
        mappingRules: effectiveMappingRules,
    });

    const getMetricValue = (sourceObj) => sourceObj ? Number(sourceObj[metric] || 0) : 0;

    const validData = data && !data.error;
    const metaVal = validData ? getMetricValue(data.meta) : 0;
    const googleVal = validData ? getMetricValue(data.google) : 0;
    const directVal = validData ? getMetricValue(data.direct) : 0;
    const othersVal = validData ? getMetricValue(data.others) : 0;

    const isToday = query?.end && dayjs(query.end).isSame(dayjs(), 'day');

    const getDelta = (sourceObj) => {
        if (!sourceObj || !validData) return undefined;
        // In compare mode: show deltas only when curr is NOT today (full-day data available)
        // Outside compare mode: show deltas only when NOT today (existing behavior)
        if (isToday) return undefined;

        const d = metric === 'sessions' ? sourceObj.delta : sourceObj.atc_delta;
        if (d === undefined || d === null) return 0;
        return d;
    };

    const getPrevValue = (sourceObj) => {
        if (!sourceObj || !validData || isToday) return undefined;
        return Number(metric === 'sessions' ? sourceObj.prev_sessions : sourceObj.prev_atc_sessions) || 0;
    };


    // Derived comparison range
    const comparisonRange = useMemo(() => {
        if (data?.prev_range) return data.prev_range;
        if (!query?.start || !query?.end) return null;
        try {
            const s = dayjs(query.start);
            const e = dayjs(query.end);
            const diffDays = e.diff(s, 'day') + 1;
            const pEnd = s.subtract(1, 'day');
            const pStart = pEnd.subtract(diffDays - 1, 'day');
            return {
                start: pStart.format('YYYY-MM-DD'),
                end: pEnd.format('YYYY-MM-DD')
            };
        } catch (err) {
            console.error("Error deriving comparison range:", err);
            return null;
        }
    }, [data?.prev_range, query?.start, query?.end]);

    const total = metaVal + googleVal + directVal + othersVal;
    const empty = total === 0;

    const chartData = useMemo(() => ({
        labels: ['Meta', 'Google', 'Direct', 'Others'],
        datasets: [
            {
                label: 'Traffic Sources',
                data: [metaVal, googleVal, directVal, othersVal],
                backgroundColor: [TRAFFIC_COLORS.meta, TRAFFIC_COLORS.google, TRAFFIC_COLORS.direct, TRAFFIC_COLORS.others],
                borderWidth: 0,
                hoverOffset: 6,
            },
        ],
    }), [metaVal, googleVal, directVal, othersVal]);

    const tooltipRef = useRef(null);
    const tooltipHoverRef = useRef(false);

    const options = useMemo(() => ({
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
            mode: 'nearest',
            intersect: false,
        },
        plugins: {
            legend: { display: false },
            tooltip: {
                enabled: false,
                external: (context) => {
                    const { chart, tooltip } = context;
                    const tooltipEl = tooltipRef.current;

                    if (!tooltipEl) return;

                    if (tooltip.opacity === 0) {
                        // Only hide if not hovering the tooltip itself
                        if (!tooltipHoverRef.current) {
                            tooltipEl.style.opacity = 0;
                        }
                        return;
                    }

                    // Set Content
                    if (tooltip.body) {
                        const dataPoint = tooltip.dataPoints[0];
                        const datasetIndex = dataPoint.datasetIndex;
                        const index = dataPoint.dataIndex;
                        const label = chart.data.labels[index];

                        let contentHtml = '';

                        // Header
                        contentHtml += `<div style="font-weight: 700; font-size: 13px; margin-bottom: 6px; color: ${isDark ? '#fff' : '#000'}">${label}</div>`;

                        // Main Value
                        const raw = dataPoint.raw;
                        const totalVal = chart._metasets[datasetIndex].total;
                        const pct = totalVal > 0 ? (raw / totalVal) * 100 : 0;
                        contentHtml += `<div style="font-size: 12px; margin-bottom: 4px;">${nfCompact.format(raw)} (${nfPct1.format(pct)}%)</div>`;

                        // Previous period comparison value
                        const catKey = label === 'Meta' ? 'meta' : label === 'Google' ? 'google' : label === 'Direct' ? 'direct' : 'others';
                        const srcObj = data?.[catKey];
                        const prevVal = srcObj ? Number(metric === 'sessions' ? srcObj.prev_sessions : srcObj.prev_atc_sessions) : 0;
                        const showPrev = !isToday && prevVal !== undefined;
                        if (showPrev) {
                            const deltaVal = metric === 'sessions' ? srcObj.delta : srcObj.atc_delta;
                            const dColor = deltaVal > 0 ? '#00C853' : deltaVal < 0 ? '#FF1744' : (isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)');
                            const dSign = deltaVal > 0 ? '+' : '';
                            contentHtml += `<div style="font-size: 11px; margin-bottom: 8px; color: ${isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.5)'};">vs ${nfCompact.format(prevVal)} <span style="color: ${dColor}; font-weight: 600;">${dSign}${Math.round(deltaVal || 0)}%</span></div>`;
                        } else {
                            contentHtml += `<div style="margin-bottom: 4px;"></div>`;
                        }

                        // Breakdown logic (Others or Meta)
                        const isOthers = label === 'Others' && data?.others_breakdown?.length > 0;
                        const isMeta = label === 'Meta' && data?.meta_breakdown?.length > 0;

                        if (isOthers || isMeta) {
                            const breakdown = isOthers ? data.others_breakdown : data.meta_breakdown;

                            contentHtml += `<div style="border-top: 1px solid ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'}; margin: 4px 0; padding-top: 4px;"></div>`;
                            contentHtml += `<div style="font-weight: 600; font-size: 11px; margin-bottom: 4px; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.5px;">Top Sources</div>`;

                            // Scrollable container
                            contentHtml += `<div style="max-height: 120px; overflow-y: auto; padding-right: 4px; scrollbar-width: thin; scrollbar-color: ${isDark ? 'rgba(255,255,255,0.2) transparent' : 'rgba(0,0,0,0.2) transparent'};">`;

                            breakdown.forEach(d => {
                                contentHtml += `
                                    <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 3px; align-items: center;">
                                        <span style="opacity: 0.9;">${d.name}</span>
                                        <span style="opacity: 0.7; font-family: monospace;">${nfCompact.format(d.sessions)}</span>
                                    </div>
                                `;
                            });

                            contentHtml += `</div>`;
                        }

                        tooltipEl.innerHTML = contentHtml;
                    }

                    const { offsetLeft: positionX, offsetTop: positionY } = chart.canvas;

                    // Display, position, and set styles for font
                    tooltipEl.style.opacity = 1;

                    const tooltipRect = tooltipEl.getBoundingClientRect();

                    // Center horizontal
                    let left = positionX + tooltip.caretX;

                    // Vertical Positioning: Pivot based on chart center
                    const yOffset = 10;
                    const centerY = chart.height / 2;
                    let top;

                    if (tooltip.caretY > centerY) {
                        // Keep tooltip TOP if cursor is in BOTTOM half
                        top = positionY + tooltip.caretY - tooltipRect.height - yOffset;
                    } else {
                        // Keep tooltip BOTTOM if cursor is in TOP half
                        top = positionY + tooltip.caretY + yOffset;
                    }

                    // Horizontal Clamping
                    if (left + (tooltipRect.width / 2) > chart.width) {
                        left = positionX + chart.width - (tooltipRect.width / 2);
                    } else if (left - (tooltipRect.width / 2) < 0) {
                        left = positionX + (tooltipRect.width / 2);
                    }

                    // Vertical clamping to keep full tooltip visible inside chart bounds.
                    const minTop = positionY + 4;
                    const maxTop = positionY + chart.height - tooltipRect.height - 4;
                    if (maxTop >= minTop) {
                        top = Math.max(minTop, Math.min(top, maxTop));
                    } else {
                        top = minTop;
                    }

                    tooltipEl.style.left = left + 'px';
                    tooltipEl.style.top = top + 'px';
                }
            }
        },
        cutout: '70%',
        animation: {
            animateScale: true,
            animateRotate: true,
            duration: 800,
            easing: 'easeInOutQuart'
        },
        transitions: {
            active: {
                animation: {
                    duration: 400
                }
            }
        }
    }), [data, isDark, isToday, metric]);

    const getPercent = (val) => total > 0 ? (val / total) * 100 : 0;

    // Count component for Total
    const AnimatedTotal = ({ val }) => {
        const count = useCountUp(val);
        return nfCompact.format(Math.round(count));
    };

    const DetailItem = ({ label, value, color, delta, prevValue }) => {
        // We calculate pct based on current valid total, not animated total to avoid jumpiness
        const pct = getPercent(value);
        const animatedValue = useCountUp(value);

        const deltaColor = delta > 0 ? '#00C853' : delta < 0 ? '#FF1744' : 'text.secondary';
        return (
            <Box
                sx={{
                    p: 1.25, // Slightly reduced padding
                    borderRadius: 2,
                    bgcolor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
                    border: '1px solid',
                    borderColor: 'divider',
                    mb: 1.5,
                    position: 'relative',
                    overflow: 'hidden',
                    transition: 'all 0.3s ease' // Smooth transition for hover effects or updates
                }}
            >
                {/* Background color hint - Only Left Border */}
                <Box
                    sx={{
                        position: 'absolute', top: 0, bottom: 0, left: 0, width: 4,
                        bgcolor: color
                    }}
                />

                <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1} sx={{ flexWrap: 'wrap' }}>
                    <Stack spacing={0.25} sx={{ minWidth: 'fit-content' }}>
                        <Typography variant="body2" color="text.secondary" fontWeight={500} sx={{ fontSize: '0.8rem' }}>{label}</Typography>
                        <Stack direction="row" alignItems="baseline" spacing={0.5} sx={{ flexWrap: 'wrap' }}>
                            <Typography variant="subtitle1" fontWeight={700} sx={{ fontSize: '0.95rem', whiteSpace: 'nowrap' }}>
                                {nfCompact.format(Math.round(animatedValue))}
                            </Typography>
                            {prevValue !== undefined && (
                                <Typography variant="body2" color="text.secondary" sx={{ fontSize: '0.8rem', fontWeight: 400, whiteSpace: 'nowrap' }}>
                                    vs {nfCompact.format(prevValue)}
                                </Typography>
                            )}
                            <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                                ({nfPct1.format(pct)}%)
                            </Typography>
                        </Stack>
                    </Stack>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.8, flexShrink: 0, flexWrap: 'nowrap' }}>
                        <Box sx={{ width: 34, height: 24, borderRadius: '30%', display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: isDark ? 'rgba(102, 119, 121, 0.44)' : 'rgba(102, 119, 121, 0.06)', flexShrink: 0 }}>
                            <Typography variant="caption" fontWeight={700} sx={{ color: 'text.secondary', fontSize: '0.7rem' }}>{Math.round(pct)}%</Typography>
                        </Box>
                        {delta !== undefined && (
                            <Stack direction="row" alignItems="center" spacing={0} sx={{ bgcolor: delta > 0 ? '#00c85315' : delta < 0 ? '#ff174415' : 'transparent', px: 0.5, py: 0.2, borderRadius: 1 }}>
                                {delta > 0 ? (
                                    <TrendingUp sx={{ color: deltaColor, fontSize: '0.9rem' }} />
                                ) : delta < 0 ? (
                                    <TrendingDown sx={{ color: deltaColor, fontSize: '0.9rem' }} />
                                ) : null}
                                <Typography variant="caption" fontWeight={700} sx={{ color: deltaColor, fontSize: '0.75rem' }}>
                                    {Math.abs(Math.round(delta))}%
                                </Typography>
                            </Stack>
                        )}
                    </Box>
                </Stack>
            </Box>
        );
    };

    const sourceRows = [
        { key: 'meta', label: 'Meta', val: metaVal, obj: data?.meta, color: TRAFFIC_COLORS.meta },
        { key: 'google', label: 'Google', val: googleVal, obj: data?.google, color: TRAFFIC_COLORS.google },
        { key: 'direct', label: 'Direct', val: directVal, obj: data?.direct, color: TRAFFIC_COLORS.direct },
        { key: 'others', label: 'Others', val: othersVal, obj: data?.others, color: TRAFFIC_COLORS.others },
    ];
    const compareLabel = comparisonRange && query?.start && query?.end && !isToday
        ? (() => {
            const fmt = (s0, e0) => {
                const st = dayjs(s0);
                const en = dayjs(e0);
                return st.isSame(en, 'day') ? st.format('MMM D') : `${st.format('MMM D')} - ${en.format('MMM D')}`;
            };
            return `${fmt(query.start, query.end)} vs ${fmt(comparisonRange.start, comparisonRange.end)}`;
        })()
        : null;
    const metricNoun = metric === 'sessions' ? 'total sessions' : 'total ATC sessions';

    return (
        <section className="dz-panel" style={{ height: '100%' }}>
            <div className="dz-ph">
                <div style={{ minWidth: 0 }}>
                    <h2 className="dz-pt">Traffic split</h2>
                    <p className="dz-ps">{compareLabel || 'By source group'}</p>
                </div>
                <Segmented
                    ariaLabel="Traffic metric"
                    value={metric}
                    onChange={setMetric}
                    options={[
                        { value: 'sessions', label: 'Sessions' },
                        { value: 'atc_sessions', label: 'ATC sessions' },
                    ]}
                />
            </div>
            <div className="dz-pb" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {loading ? (
                    <Skeleton variant="rounded" width="100%" height={180} />
                ) : !validData || empty ? (
                    <div className="dz-tbl-empty" style={{ margin: 0 }}>No traffic data for this selection.</div>
                ) : (
                    <>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                            <span className="dz-num" style={{ fontSize: 28, fontWeight: 620, letterSpacing: '-0.02em' }}>{nfCompact.format(total)}</span>
                            <span className="dz-muted" style={{ fontSize: 12.5 }}>{metricNoun}</span>
                        </div>
                        <div
                            className="dz-stackbar"
                            style={{ height: 10 }}
                            role="img"
                            aria-label={sourceRows.map((r) => `${r.label} ${nfPct1.format(total > 0 ? (r.val / total) * 100 : 0)}%`).join(', ')}
                        >
                            {sourceRows.map((r) => (
                                <i key={r.key} style={{ background: r.color, width: `${total > 0 ? (r.val / total) * 100 : 0}%` }} />
                            ))}
                        </div>
                        <div>
                            {sourceRows.map((r) => {
                                const delta = getDelta(r.obj);
                                return (
                                    <div key={r.key} className="dz-num" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--dz-line)', fontSize: 13 }}>
                                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                                            <i className="dz-sw" style={{ background: r.color }} />
                                            {r.label}
                                        </span>
                                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 14 }}>
                                            {typeof delta === 'number' && delta !== 0 ? (
                                                <span style={{ fontSize: 12, fontWeight: 600, color: delta > 0 ? 'var(--dz-good)' : 'var(--dz-bad)' }}>
                                                    {delta > 0 ? '\u2191' : '\u2193'} {Math.abs(Math.round(delta))}%
                                                </span>
                                            ) : null}
                                            <b style={{ fontWeight: 600 }}>{nfCompact.format(r.val)}</b>
                                            <span className="dz-muted" style={{ width: 46, textAlign: 'right' }}>
                                                {nfPct1.format(total > 0 ? (r.val / total) * 100 : 0)}%
                                            </span>
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    </>
                )}
            </div>
        </section>
    );
});
