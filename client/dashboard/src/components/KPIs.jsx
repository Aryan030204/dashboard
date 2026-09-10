import {
  cloneElement,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Grid from "@mui/material/Grid2";
import {
  Box,
  IconButton,
  Stack,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import ChevronLeftRoundedIcon from "@mui/icons-material/ChevronLeftRounded";
import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import DragIndicatorRoundedIcon from "@mui/icons-material/DragIndicatorRounded";
import PushPinOutlinedIcon from "@mui/icons-material/PushPinOutlined";
import PushPinRoundedIcon from "@mui/icons-material/PushPinRounded";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AnimatePresence, motion } from "framer-motion";
import { GlassChip } from "./ui/GlassChip.jsx";
import KPIStat from "./KPIStat.jsx";
import { useInrCurrency } from "../lib/currency.js";
import { useDashboardKpiData } from "../features/dashboard/widgetDataHooks.js";
import {
  DEFAULT_DESKTOP_KPI_LAYOUT,
  deriveRenderedDesktopKpiOrder,
  MAX_PINNED_KPIS,
  normalizeDesktopKpiLayout,
  paginateKpiIds,
  reorderDesktopKpiLayout,
} from "../lib/kpiLayout.js";

const nfInt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const nfFloat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const nfPct = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 2,
});
const KPI_PAGE_SLOT_COUNT = 8;
const MOBILE_KPI_PAGE_SIZE = 6;
const MOBILE_KPI_SLOT_PLACEHOLDER_HEIGHT = 110;

function deriveMobileTopKpiOrder(layout, defaultIds) {
  const normalized = normalizeDesktopKpiLayout(layout);
  const allowed = new Set(defaultIds);
  const ordered = deriveRenderedDesktopKpiOrder(normalized).filter((id) =>
    allowed.has(id),
  );

  for (const id of defaultIds) {
    if (!ordered.includes(id)) {
      ordered.push(id);
    }
  }

  return ordered;
}

function mergeMobileTopKpiOrder(layout, topOrder, defaultIds) {
  const normalized = normalizeDesktopKpiLayout(layout);
  const allowed = new Set(defaultIds);
  const queue = [...topOrder.filter((id) => allowed.has(id))];
  const nextOrder = [];

  for (const id of normalized.order) {
    if (allowed.has(id)) {
      nextOrder.push(queue.shift() ?? id);
    } else {
      nextOrder.push(id);
    }
  }

  while (queue.length > 0) {
    nextOrder.push(queue.shift());
  }

  return {
    ...normalized,
    order: nextOrder,
  };
}

function buildPinAccessory(isPinned, onTogglePin) {
  return (
    <Stack direction="row" spacing={0.5} alignItems="center">
      <Tooltip title={isPinned ? "Unpin KPI" : "Pin KPI"}>
        <IconButton
          size="small"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onTogglePin();
          }}
          sx={{
            width: 24,
            height: 24,
            color: isPinned ? "#f5c451" : "rgba(255,255,255,0.46)",
            bgcolor: "rgba(0,0,0,0.18)",
            border: "1px solid rgba(255,255,255,0.08)",
            "&:hover": {
              bgcolor: "rgba(255,255,255,0.08)",
            },
          }}
        >
          {isPinned ? (
            <PushPinRoundedIcon sx={{ fontSize: 14 }} />
          ) : (
            <PushPinOutlinedIcon sx={{ fontSize: 14 }} />
          )}
        </IconButton>
      </Tooltip>
    </Stack>
  );
}

function MobileEditableKpiCard({
  card,
  isPinned = false,
  onTogglePin,
  setNodeRef,
  style,
  listeners,
  attributes,
  isDragging = false,
}) {
  const node = cloneElement(card.node, {
    bottomRightAccessory:
      typeof onTogglePin === "function"
        ? buildPinAccessory(isPinned, () => onTogglePin(card.id))
        : undefined,
  });

  return (
    <Box
      ref={setNodeRef}
      style={style}
      sx={{
        opacity: isDragging ? 0.3 : 1,
        transformOrigin: "center",
        position: "relative",
        "& .mobile-kpi-edit-card": {
          pointerEvents: "none",
        },
      }}
    >
      <Box className="mobile-kpi-edit-card">{node}</Box>
      <Tooltip title="Drag to reorder">
        <Box
          {...attributes}
          {...listeners}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          sx={{
            position: "absolute",
            top: 10,
            right: 12,
            zIndex: 20,
            width: 28,
            height: 28,
            borderRadius: "10px",
            display: "grid",
            placeItems: "center",
            color: "#dff1ff",
            bgcolor: "rgba(10,10,10,0.96)",
            border: "1px solid rgba(91,163,224,0.42)",
            backdropFilter: "blur(18px)",
            boxShadow: "0 14px 28px rgba(0,0,0,0.28)",
            cursor: "grab",
            touchAction: "none",
            "&:active": {
              cursor: "grabbing",
            },
          }}
        >
          <DragIndicatorRoundedIcon sx={{ fontSize: 16 }} />
        </Box>
      </Tooltip>
    </Box>
  );
}

function SortableMobileKpiCard({ id, card, isPinned, onTogglePin }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  return (
    <MobileEditableKpiCard
      card={card}
      isPinned={isPinned}
      onTogglePin={onTogglePin}
      setNodeRef={setNodeRef}
      attributes={attributes}
      listeners={listeners}
      isDragging={isDragging}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    />
  );
}

function MobileKpiPages({
  cards,
  footerCards = [],
  kpiLayout = DEFAULT_DESKTOP_KPI_LAYOUT,
  onKpiLayoutChange,
  canEdit = false,
  dashboardLayoutEditing = false,
}) {
  const [pageIndex, setPageIndex] = useState(0);
  const [pageDirection, setPageDirection] = useState(1);
  const [, setActiveId] = useState(null);
  const [pinMessage, setPinMessage] = useState("");
  const touchStartXRef = useRef(null);
  const isEditing = canEdit && dashboardLayoutEditing;
  const cardsById = useMemo(
    () => new Map(cards.map((card) => [card.id, card])),
    [cards],
  );
  const defaultIds = useMemo(() => cards.map((card) => card.id), [cards]);
  const normalizedLayout = useMemo(
    () => normalizeDesktopKpiLayout(kpiLayout),
    [kpiLayout],
  );
  const pinnedSet = useMemo(
    () => new Set(normalizedLayout.pinned.filter((id) => defaultIds.includes(id))),
    [defaultIds, normalizedLayout.pinned],
  );
  const derivedOrder = useMemo(
    () => deriveMobileTopKpiOrder(kpiLayout, defaultIds),
    [defaultIds, kpiLayout],
  );
  const [editingOrder, setEditingOrder] = useState(derivedOrder);
  const activeOrder = isEditing ? editingOrder : derivedOrder;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 8 } }),
  );
  const pages = useMemo(() => {
    const nextPages = [];
    for (let index = 0; index < activeOrder.length; index += MOBILE_KPI_PAGE_SIZE) {
      nextPages.push(activeOrder.slice(index, index + MOBILE_KPI_PAGE_SIZE));
    }
    if (nextPages.length === 0) nextPages.push([]);
    return nextPages;
  }, [activeOrder]);

  useEffect(() => {
    setPageIndex((current) => Math.min(current, Math.max(pages.length - 1, 0)));
  }, [pages.length]);

  useEffect(() => {
    setEditingOrder(derivedOrder);
  }, [derivedOrder, isEditing]);

  useEffect(() => {
    if (isEditing) return;
    setPageDirection(1);
    setPageIndex(0);
  }, [isEditing, derivedOrder]);

  useEffect(() => {
    if (!pinMessage) return undefined;
    const timer = window.setTimeout(() => setPinMessage(""), 2200);
    return () => window.clearTimeout(timer);
  }, [pinMessage]);

  const handleTogglePin = (metricId) => {
    if (pinnedSet.has(metricId)) {
      const nextLayout = {
        ...normalizedLayout,
        pinned: normalizedLayout.pinned.filter((id) => id !== metricId),
      };
      if (isEditing) {
        setEditingOrder(deriveMobileTopKpiOrder(nextLayout, defaultIds));
      }
      onKpiLayoutChange?.(nextLayout, { persist: !isEditing });
      return;
    }

    if (normalizedLayout.pinned.length >= MAX_PINNED_KPIS) {
      setPinMessage("You can pin a maximum of 3 KPIs.");
      return;
    }

    const nextLayout = {
      ...normalizedLayout,
      pinned: [...normalizedLayout.pinned, metricId],
    };
    if (isEditing) {
      setEditingOrder(deriveMobileTopKpiOrder(nextLayout, defaultIds));
    }
    onKpiLayoutChange?.(nextLayout, { persist: !isEditing });
  };

  const handlePageChange = (nextIndex) => {
    if (nextIndex < 0 || nextIndex >= pages.length || nextIndex === pageIndex) return;
    setPageDirection(nextIndex > pageIndex ? 1 : -1);
    setPageIndex(nextIndex);
  };

  const handleTouchStart = (event) => {
    if (isEditing) return;
    touchStartXRef.current = event.changedTouches?.[0]?.clientX ?? null;
  };

  const handleTouchEnd = (event) => {
    if (isEditing) return;
    const startX = touchStartXRef.current;
    const endX = event.changedTouches?.[0]?.clientX ?? null;
    touchStartXRef.current = null;
    if (startX === null || endX === null) return;

    const deltaX = endX - startX;
    if (Math.abs(deltaX) < 42) return;
    handlePageChange(deltaX < 0 ? pageIndex + 1 : pageIndex - 1);
  };

  const pageVariants = {
    enter: (direction) => ({
      x: direction > 0 ? 28 : -28,
      opacity: 0.38,
    }),
    center: {
      x: 0,
      opacity: 1,
    },
    exit: (direction) => ({
      x: direction > 0 ? -28 : 28,
      opacity: 0.38,
    }),
  };

  const currentPage = pages[pageIndex] || [];
  const currentPageSlots = Array.from(
    { length: MOBILE_KPI_PAGE_SIZE },
    (_, index) => currentPage[index] || null,
  );

  return (
    <>
    <Stack spacing={1.25} sx={{ display: { xs: "flex", md: "none" } }}>
      {pages.length > 1 ? (
        <Box
          sx={{
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: 0.5,
            minHeight: 28,
          }}
        >
          <IconButton
            size="small"
            onClick={() => handlePageChange(pageIndex - 1)}
            disabled={pageIndex === 0}
            sx={{
              color: "rgba(255,255,255,0.7)",
              "&.Mui-disabled": { color: "rgba(255,255,255,0.22)" },
            }}
          >
            <ChevronLeftRoundedIcon sx={{ fontSize: 18 }} />
          </IconButton>
          <Typography variant="caption" color="text.secondary" sx={{ minWidth: 28, textAlign: "center" }}>
            {pageIndex + 1}/{pages.length}
          </Typography>
          <IconButton
            size="small"
            onClick={() => handlePageChange(pageIndex + 1)}
            disabled={pageIndex === pages.length - 1}
            sx={{
              color: "rgba(255,255,255,0.7)",
              "&.Mui-disabled": { color: "rgba(255,255,255,0.22)" },
            }}
          >
            <ChevronRightRoundedIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Box>
      ) : null}
      {pinMessage ? (
        <Typography variant="caption" color="warning.main" sx={{ minHeight: 18 }}>
          {pinMessage}
        </Typography>
      ) : null}
      {isEditing ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={({ active }) => setActiveId(active.id)}
          onDragCancel={() => setActiveId(null)}
          onDragEnd={({ active, over }) => {
            setActiveId(null);
            if (!over || active.id === over.id) return;
            if (!activeOrder.includes(active.id) || !activeOrder.includes(over.id)) {
              return;
            }
            const activePinned = pinnedSet.has(active.id);
            const overPinned = pinnedSet.has(over.id);
            if (activePinned !== overPinned) return;

            const nextTopOrder = [...activeOrder];
            const fromIndex = nextTopOrder.indexOf(active.id);
            const toIndex = nextTopOrder.indexOf(over.id);
            if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
              return;
            }
            const [moved] = nextTopOrder.splice(fromIndex, 1);
            nextTopOrder.splice(toIndex, 0, moved);
            setEditingOrder(nextTopOrder);
            onKpiLayoutChange?.(
              mergeMobileTopKpiOrder(normalizedLayout, nextTopOrder, defaultIds),
            );
          }}
        >
          <SortableContext items={activeOrder} strategy={rectSortingStrategy}>
            <Stack spacing={1.5}>
              {pages.map((pageItems, pageNumber) => (
                <Box
                  key={`mobile-edit-page-${pageNumber}`}
                  sx={{
                    p: 1.2,
                    borderRadius: "20px",
                    border: "1px solid rgba(255,255,255,0.08)",
                    bgcolor: "rgba(255,255,255,0.02)",
                  }}
                >
                  <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: "block" }}>
                    Page {pageNumber + 1}
                  </Typography>
                  <Box
                    sx={{
                      display: "grid",
                      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                      gap: 2,
                    }}
                  >
                    {Array.from(
                      { length: MOBILE_KPI_PAGE_SIZE },
                      (_, index) => pageItems[index] || null,
                    ).map((metricId, index) =>
                      metricId ? (
                        <SortableMobileKpiCard
                          key={metricId}
                          id={metricId}
                          card={cardsById.get(metricId)}
                          isPinned={pinnedSet.has(metricId)}
                          onTogglePin={handleTogglePin}
                        />
                      ) : (
                        <Box
                          key={`empty-mobile-edit-slot-${pageNumber}-${index}`}
                          aria-hidden="true"
                          sx={{
                            minHeight: MOBILE_KPI_SLOT_PLACEHOLDER_HEIGHT,
                            borderRadius: "12px",
                            visibility: "hidden",
                          }}
                        />
                      ),
                    )}
                  </Box>
                </Box>
              ))}
            </Stack>
          </SortableContext>
        </DndContext>
      ) : (
        <Box
          sx={{ position: "relative", overflow: "hidden" }}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          <AnimatePresence initial={false} custom={pageDirection} mode="wait">
            <motion.div
              key={pageIndex}
              custom={pageDirection}
              variants={pageVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.22, ease: "easeOut" }}
            >
              <Grid container spacing={2} columns={12}>
                {currentPageSlots.map((metricId, index) =>
                  metricId ? (
                    <Grid
                      key={metricId}
                      size={cardsById.get(metricId)?.size}
                      sx={cardsById.get(metricId)?.sx}
                    >
                      {cloneElement(cardsById.get(metricId)?.node, {
                        bottomRightAccessory: buildPinAccessory(
                          pinnedSet.has(metricId),
                          () => handleTogglePin(metricId),
                        ),
                      })}
                    </Grid>
                  ) : (
                    <Grid
                      key={`empty-mobile-kpi-slot-${pageIndex}-${index}`}
                      size={{ xs: 6, sm: 6, md: 3 }}
                    >
                      <Box
                        aria-hidden="true"
                        sx={{
                          minHeight: MOBILE_KPI_SLOT_PLACEHOLDER_HEIGHT,
                          borderRadius: "12px",
                          visibility: "hidden",
                        }}
                      />
                    </Grid>
                  ),
                )}
              </Grid>
            </motion.div>
          </AnimatePresence>
        </Box>
      )}
      {footerCards.length > 0 ? (
        <Grid container spacing={2} columns={12}>
          {footerCards.map((card) => (
            <Grid key={card.id} size={card.size} sx={card.sx}>
              {card.node}
            </Grid>
          ))}
        </Grid>
      ) : null}
    </Stack>
    </>
  );
}

function DesktopKpiCard({
  metric,
  isPinned,
  isEditing,
  isDragging = false,
  setNodeRef,
  style,
  listeners,
  attributes,
  onTogglePin,
}) {
  const topAction = metric.action || null;
  const bottomRightAccessory = (
    <Stack direction="row" spacing={0.5} alignItems="center">
      <Tooltip title={isPinned ? "Unpin KPI" : "Pin KPI"}>
        <IconButton
          size="small"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onTogglePin(metric.id);
          }}
          sx={{
            width: 26,
            height: 26,
            color: isPinned ? "#f5c451" : "rgba(255,255,255,0.46)",
            bgcolor: "rgba(0,0,0,0.18)",
            border: "1px solid rgba(255,255,255,0.08)",
            "&:hover": {
              bgcolor: "rgba(255,255,255,0.08)",
            },
          }}
        >
          {isPinned ? (
            <PushPinRoundedIcon sx={{ fontSize: 16 }} />
          ) : (
            <PushPinOutlinedIcon sx={{ fontSize: 16 }} />
          )}
        </IconButton>
      </Tooltip>
    </Stack>
  );

  return (
    <Box
      ref={setNodeRef}
      style={style}
      sx={{
        opacity: isDragging ? 0.28 : 1,
        transformOrigin: "center",
      }}
    >
      <KPIStat
        label={metric.label}
        value={metric.value}
        unavailable={metric.unavailable}
        loading={metric.loading}
        deltaLoading={metric.deltaLoading}
        formatter={metric.formatter}
        delta={metric.delta}
        onSelect={metric.onSelect}
        onSelectionToggle={metric.onSelectionToggle}
        selected={metric.selected}
        selectionIndicatorSelected={metric.selectionIndicatorSelected}
        compareValue={metric.compareValue}
        compareFormatter={metric.compareFormatter}
        activeColor={metric.activeColor}
        invertDeltaColor={metric.invertDeltaColor}
        showSelectionIndicator={metric.showSelectionIndicator}
        action={
          <Stack direction="row" spacing={0.75} alignItems="center">
            {topAction ? (
              <Box sx={{ display: "flex", alignItems: "center" }}>{topAction}</Box>
            ) : null}
            {isEditing && (
              <Tooltip title="Drag to reorder">
                <Box
                  {...attributes}
                  {...listeners}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  sx={{
                    width: 26,
                    height: 26,
                    borderRadius: "9px",
                    display: "grid",
                    placeItems: "center",
                    color: "rgba(255,255,255,0.72)",
                    bgcolor: "rgba(255,255,255,0.06)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    cursor: "grab",
                    touchAction: "none",
                  }}
                >
                  <DragIndicatorRoundedIcon sx={{ fontSize: 16 }} />
                </Box>
              </Tooltip>
            )}
          </Stack>
        }
        bottomRightAccessory={bottomRightAccessory}
        sx={{
          transform: isDragging ? "scale(1.01)" : "scale(1)",
          boxShadow: isDragging
            ? "0 20px 42px rgba(0,0,0,0.34)"
            : undefined,
        }}
      />
    </Box>
  );
}

function SortableDesktopKpiCard(props) {
  const { id } = props;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: !props.isEditing });

  return (
    <DesktopKpiCard
      {...props}
      setNodeRef={setNodeRef}
      isDragging={isDragging}
      listeners={listeners}
      attributes={attributes}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    />
  );
}

function buildDesktopMetrics({
  compareMode,
  data,
  deltaLoading,
  desktopSelectedCardId,
  formatConvertedAmount,
  loading,
  onDesktopCardSelect,
  onSelectMetric,
  onToggleMetric,
  revenueMode,
  onRevenueModeToggle,
  atcMode,
  onAtcModeToggle,
  checkoutMode,
  onCheckoutModeToggle,
  cancellationMode,
  onCancellationModeToggle,
  rtoMode,
  onRtoModeToggle,
  highIntentMode,
  onHighIntentModeToggle,
  mediumIntentMode,
  onMediumIntentModeToggle,
  lowIntentMode,
  onLowIntentModeToggle,
  selectedMetrics,
  activeMetric,
  showCiEvents,
  showRtoKpi,
  showIntentMetrics,
  convertAmount,
}) {
  const selectedMetricSet = new Set(Array.isArray(selectedMetrics) ? selectedMetrics : []);
  const hasSelected = (metricKey) => selectedMetricSet.has(metricKey);

  const createSelectionProps = (cardId, metricKey, unavailable = false) => {
    if (!metricKey) {
      return {
        onSelect: undefined,
        onSelectionToggle: undefined,
        selected: false,
        selectionIndicatorSelected: false,
        showSelectionIndicator: false,
      };
    }

    return {
      onSelect:
        onSelectMetric && !unavailable
          ? () => {
              onDesktopCardSelect?.(cardId);
              onSelectMetric(metricKey);
            }
          : undefined,
      onSelectionToggle:
        onToggleMetric && !unavailable
          ? () => {
              onDesktopCardSelect?.(cardId);
              onToggleMetric(metricKey);
            }
          : undefined,
      selected: activeMetric === metricKey && desktopSelectedCardId === cardId,
      selectionIndicatorSelected: hasSelected(metricKey),
      showSelectionIndicator: undefined,
    };
  };

  const createIntentCard = ({
    id,
    label,
    mode,
    onModeToggle,
    sessions,
    percent,
    sessionsDelta,
    percentDelta,
    prevSessions,
    prevPercent,
    activeColor,
    hidden = false,
    metricKey,
  }) => ({
    id,
    label,
    action: renderToggle({
      leftActive: mode === "S",
      leftLabel: "S",
      rightActive: mode === "%",
      rightLabel: "%",
      leftColor: activeColor,
      rightColor: activeColor,
      onClick: onModeToggle,
    }),
    value: mode === "S" ? sessions : percent,
    formatter: mode === "S" ? (value) => nfInt.format(value) : (value) => nfPct.format(value),
    delta:
      mode === "S"
        ? sessionsDelta
          ? { value: sessionsDelta.diff_pct, direction: sessionsDelta.direction }
          : undefined
        : percentDelta
          ? { value: percentDelta.diff_pct, direction: percentDelta.direction }
          : undefined,
    compareValue: compareMode ? (mode === "S" ? prevSessions : prevPercent) : undefined,
    compareFormatter:
      mode === "S" ? (value) => nfInt.format(value) : (value) => nfPct.format(value),
    activeColor,
    hidden,
    // The trend chart has separate metric ids for the percent vs. session-
    // count series (e.g. "high_intent" vs "high_intent_sessions") — select
    // whichever one matches the card's current S/% toggle.
    ...createSelectionProps(id, mode === "S" ? `${metricKey}_sessions` : metricKey),
  });

  const cards = [
    {
      id: "orders",
      label: "Total Orders",
      value: data.orders?.value ?? 0,
      formatter: (value) => nfInt.format(value),
      delta: data.ordersDelta
        ? { value: data.ordersDelta.diff_pct, direction: data.ordersDelta.direction }
        : undefined,
      compareValue: compareMode && data.prevOrders != null ? data.prevOrders : undefined,
      compareFormatter: (value) => nfInt.format(value),
      activeColor: "#10b981",
      ...createSelectionProps("orders", "orders"),
    },
    {
      id: "revenue",
      label: revenueMode === "G" ? "Gross Revenue" : "Net Revenue",
      action: renderToggle({
        leftActive: revenueMode === "G",
        leftLabel: "G",
        rightActive: revenueMode === "N",
        rightLabel: "N",
        onClick: onRevenueModeToggle,
      }),
      value:
        revenueMode === "G"
          ? convertAmount(data.sales?.value ?? 0)
          : convertAmount(data.sales?.value ?? 0) / 1.18,
      formatter: (value) => formatConvertedAmount(value, { maximumFractionDigits: 0 }),
      delta: data.salesDelta
        ? { value: data.salesDelta.diff_pct, direction: data.salesDelta.direction }
        : undefined,
      compareValue:
        compareMode && data.prevSales != null
          ? revenueMode === "G"
            ? convertAmount(data.prevSales)
            : convertAmount(data.prevSales) / 1.18
          : undefined,
      compareFormatter: (value) =>
        formatConvertedAmount(value, { maximumFractionDigits: 0 }),
      activeColor: "#10b981",
      ...createSelectionProps("revenue", "sales"),
    },
    {
      id: "aov",
      label: "Average Order Value",
      value: convertAmount(data.aov?.aov ?? 0),
      formatter: (value) => formatConvertedAmount(value, { maximumFractionDigits: 0 }),
      delta: data.aovDelta
        ? { value: data.aovDelta.diff_pct, direction: data.aovDelta.direction }
        : undefined,
      compareValue: compareMode && data.prevAov != null ? convertAmount(data.prevAov) : undefined,
      compareFormatter: (value) =>
        formatConvertedAmount(value, { maximumFractionDigits: 0 }),
      activeColor: "#10b981",
      ...createSelectionProps("aov", "aov"),
    },
    {
      id: "returns",
      label: cancellationMode === "C" ? "Cancellation Rate" : "Refund Rate",
      action: renderToggle({
        leftActive: cancellationMode === "C",
        leftLabel: "C",
        rightActive: cancellationMode === "R",
        rightLabel: "R",
        leftColor: "error.main",
        rightColor: "warning.main",
        onClick: onCancellationModeToggle,
      }),
      value:
        cancellationMode === "C"
          ? data.returnsData?.cancelled_rate ?? 0
          : data.returnsData?.refunded_rate ?? 0,
      formatter: (value) => nfPct.format(value),
      delta:
        cancellationMode === "C"
          ? data.cancelledRateDelta
            ? { value: data.cancelledRateDelta.diff_pct, direction: data.cancelledRateDelta.direction }
            : undefined
          : data.refundedRateDelta
            ? { value: data.refundedRateDelta.diff_pct, direction: data.refundedRateDelta.direction }
            : undefined,
      compareValue:
        compareMode
          ? cancellationMode === "C"
            ? data.prevCancelledRate
            : data.prevRefundedRate
          : undefined,
      compareFormatter: (value) => nfPct.format(value),
      activeColor: "#ef4444",
      invertDeltaColor: true,
      unavailable: data.unavailable?.returns,
      loading,
      deltaLoading,
      selected: false,
      selectionIndicatorSelected: false,
      showSelectionIndicator: false,
    },
    {
      id: "sessions",
      label: "Total Sessions",
      value: data.totalSessions ?? 0,
      formatter: (value) => nfInt.format(value),
      delta: data.sessDelta
        ? { value: data.sessDelta.diff_pct, direction: data.sessDelta.direction }
        : undefined,
      compareValue: compareMode && data.prevSessions != null ? data.prevSessions : undefined,
      compareFormatter: (value) => nfInt.format(value),
      activeColor: "#10b981",
      unavailable: data.unavailable?.sessions,
      ...createSelectionProps("sessions", "sessions", data.unavailable?.sessions),
    },
    {
      id: "atc",
      label: atcMode === "R" ? "ATC Rate" : "ATC Sessions",
      action: renderToggle({
        leftActive: atcMode === "R",
        leftLabel: "R",
        rightActive: atcMode === "S",
        rightLabel: "S",
        leftColor: "#f59e0b",
        onClick: onAtcModeToggle,
      }),
      value:
        atcMode === "R"
          ? data.totalSessions > 0
            ? data.totalAtcSessions / data.totalSessions
            : 0
          : data.totalAtcSessions,
      formatter: atcMode === "R" ? (value) => nfPct.format(value) : (value) => nfInt.format(value),
      delta:
        atcMode === "R"
          ? data.atcRateDelta
            ? { value: data.atcRateDelta.diff_pct, direction: data.atcRateDelta.direction }
            : undefined
          : data.atcDelta
            ? { value: data.atcDelta.diff_pct, direction: data.atcDelta.direction }
            : undefined,
      compareValue:
        compareMode
          ? atcMode === "R"
            ? data.prevAtcRate
            : data.prevAtcSessions
          : undefined,
      compareFormatter:
        atcMode === "R" ? (value) => nfPct.format(value) : (value) => nfInt.format(value),
      activeColor: "#f59e0b",
      unavailable: data.unavailable?.atc,
      ...createSelectionProps("atc", atcMode === "R" ? "atc_rate" : "atc", data.unavailable?.atc),
    },
    {
      id: "checkout",
      label: checkoutMode === "R" ? "Checkout Rate" : "Checkout Initiated Events",
      action: renderToggle({
        leftActive: checkoutMode === "C",
        leftLabel: "C",
        rightActive: checkoutMode === "R",
        rightLabel: "R",
        leftColor: "primary.main",
        rightColor: "#10b981",
        onClick: onCheckoutModeToggle,
      }),
      value:
        checkoutMode === "R"
          ? data.totalSessions > 0
            ? (data.totalCiEvents?.value ?? 0) / data.totalSessions
            : 0
          : data.totalCiEvents?.value ?? 0,
      formatter:
        checkoutMode === "R" ? (value) => nfPct.format(value) : (value) => nfInt.format(value),
      delta:
        checkoutMode === "R"
          ? data.checkoutRateDelta
            ? { value: data.checkoutRateDelta.diff_pct, direction: data.checkoutRateDelta.direction }
            : undefined
          : data.ciDelta
            ? { value: data.ciDelta.diff_pct, direction: data.ciDelta.direction }
            : undefined,
      compareValue:
        compareMode
          ? checkoutMode === "R"
            ? data.prevCheckoutRate
            : data.prevCiEvents
          : undefined,
      compareFormatter:
        checkoutMode === "R" ? (value) => nfPct.format(value) : (value) => nfInt.format(value),
      activeColor: "#5ba3e0",
      unavailable: data.unavailable?.ci,
      hidden: !showCiEvents,
      ...createSelectionProps("checkout", checkoutMode === "R" ? "checkout_rate" : "ci_events", data.unavailable?.ci),
    },
    {
      id: "cvr",
      label: "Conversion Rate",
      value: data.cvr?.cvr ?? 0,
      formatter: (value) => nfPct.format(value),
      delta:
        typeof data.cvrDeltaValue === "number" && data.cvrDelta
          ? { value: data.cvrDeltaValue, direction: data.cvrDelta.direction }
          : undefined,
      compareValue: compareMode && data.prevCvr != null ? data.prevCvr / 100 : undefined,
      compareFormatter: (value) => nfPct.format(value),
      activeColor: "#10b981",
      unavailable: data.unavailable?.cvr,
      ...createSelectionProps("cvr", "cvr", data.unavailable?.cvr),
    },
    {
      id: "rto",
      label: rtoMode === "O" ? "RTO Orders (Approx.)" : "RTO % (Approx.)",
      action: renderToggle({
        leftActive: rtoMode === "O",
        leftLabel: "O",
        rightActive: rtoMode === "%",
        rightLabel: "%",
        leftColor: "warning.main",
        rightColor: "error.main",
        onClick: onRtoModeToggle,
      }),
      value: rtoMode === "O" ? data.rtoData?.orders ?? 0 : data.rtoData?.rate ?? 0,
      formatter:
        rtoMode === "O" ? (value) => nfInt.format(value) : (value) => nfPct.format(value),
      delta:
        rtoMode === "O"
          ? data.rtoOrdersDelta
            ? { value: data.rtoOrdersDelta.diff_pct, direction: data.rtoOrdersDelta.direction }
            : undefined
          : data.rtoRateDelta
            ? { value: data.rtoRateDelta.diff_pct, direction: data.rtoRateDelta.direction }
            : undefined,
      compareValue:
        compareMode
          ? rtoMode === "O"
            ? data.prevRtoOrders
            : data.prevRtoRate
          : undefined,
      compareFormatter:
        rtoMode === "O" ? (value) => nfInt.format(value) : (value) => nfPct.format(value),
      activeColor: "#f59e0b",
      hidden: !showRtoKpi,
      unavailable: data.unavailable?.rto ?? data.unavailable?.returns,
      loading,
      deltaLoading,
      selected: false,
      selectionIndicatorSelected: false,
      showSelectionIndicator: false,
    },
    createIntentCard({
      id: "high_intent",
      label: "High Intent",
      mode: highIntentMode,
      onModeToggle: onHighIntentModeToggle,
      sessions: data.intentMetrics?.high?.sessions ?? 0,
      percent: data.intentMetrics?.high?.percent ?? 0,
      sessionsDelta: data.intentMetrics?.high?.sessionsDelta,
      percentDelta: data.intentMetrics?.high?.percentDelta,
      prevSessions: data.intentMetrics?.high?.prevSessions,
      prevPercent: data.intentMetrics?.high?.prevPercent,
      activeColor: "#22c55e",
      hidden: !showIntentMetrics,
      metricKey: "high_intent",
    }),
    createIntentCard({
      id: "medium_intent",
      label: "Medium Intent",
      mode: mediumIntentMode,
      onModeToggle: onMediumIntentModeToggle,
      sessions: data.intentMetrics?.medium?.sessions ?? 0,
      percent: data.intentMetrics?.medium?.percent ?? 0,
      sessionsDelta: data.intentMetrics?.medium?.sessionsDelta,
      percentDelta: data.intentMetrics?.medium?.percentDelta,
      prevSessions: data.intentMetrics?.medium?.prevSessions,
      prevPercent: data.intentMetrics?.medium?.prevPercent,
      activeColor: "#f59e0b",
      hidden: !showIntentMetrics,
      metricKey: "medium_intent",
    }),
    createIntentCard({
      id: "low_intent",
      label: "Low Intent",
      mode: lowIntentMode,
      onModeToggle: onLowIntentModeToggle,
      sessions: data.intentMetrics?.low?.sessions ?? 0,
      percent: data.intentMetrics?.low?.percent ?? 0,
      sessionsDelta: data.intentMetrics?.low?.sessionsDelta,
      percentDelta: data.intentMetrics?.low?.percentDelta,
      prevSessions: data.intentMetrics?.low?.prevSessions,
      prevPercent: data.intentMetrics?.low?.prevPercent,
      activeColor: "#ef4444",
      hidden: !showIntentMetrics,
      metricKey: "low_intent",
    }),
  ];

  return new Map(
    cards
      .filter((metric) => !metric.hidden)
      .map((metric) => [
        metric.id,
        {
          loading,
          deltaLoading,
          invertDeltaColor: false,
          unavailable: false,
          compareFormatter: metric.formatter,
          ...metric,
        },
      ]),
  );
}

function DesktopKpiPages({
  cardsById,
  kpiLayout,
  onKpiLayoutChange,
  canEdit = false,
  dashboardLayoutEditing = false,
}) {
  const [, setActiveId] = useState(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageDirection, setPageDirection] = useState(1);
  const [pinMessage, setPinMessage] = useState("");
  const isEditing = canEdit && dashboardLayoutEditing;
  const normalizedLayout = useMemo(
    () => normalizeDesktopKpiLayout({
      ...kpiLayout,
      order: normalizeDesktopKpiLayout(kpiLayout).order.filter((id) => cardsById.has(id)),
    }),
    [cardsById, kpiLayout],
  );
  const activeLayout = normalizedLayout;
  const renderedOrder = useMemo(
    () => deriveRenderedDesktopKpiOrder(activeLayout).filter((id) => cardsById.has(id)),
    [activeLayout, cardsById],
  );
  const pages = useMemo(() => paginateKpiIds(renderedOrder), [renderedOrder]);
  const pinnedSet = useMemo(() => new Set(activeLayout.pinned), [activeLayout.pinned]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 8 } }),
  );

  useEffect(() => {
    setPageIndex((current) => Math.min(current, pages.length - 1));
  }, [pages.length]);

  useEffect(() => {
    if (!pinMessage) return undefined;
    const timer = window.setTimeout(() => setPinMessage(""), 2200);
    return () => window.clearTimeout(timer);
  }, [pinMessage]);

  const handleTogglePin = (metricId) => {
    if (pinnedSet.has(metricId)) {
      const nextLayout = {
        ...activeLayout,
        pinned: activeLayout.pinned.filter((id) => id !== metricId),
      };
      if (!isEditing) {
        onKpiLayoutChange(nextLayout, { persist: true });
      } else {
        onKpiLayoutChange(normalizeDesktopKpiLayout(nextLayout));
      }
      return;
    }

    if (activeLayout.pinned.length >= MAX_PINNED_KPIS) {
      setPinMessage("You can pin a maximum of 3 KPIs.");
      return;
    }

    const nextLayout = {
      ...activeLayout,
      pinned: [...activeLayout.pinned, metricId],
    };
    if (!isEditing) {
      onKpiLayoutChange(nextLayout, { persist: true });
    } else {
      onKpiLayoutChange(normalizeDesktopKpiLayout(nextLayout));
    }
  };

  const handlePageChange = (nextIndex) => {
    if (nextIndex === pageIndex || nextIndex < 0 || nextIndex >= pages.length) return;
    setPageDirection(nextIndex > pageIndex ? 1 : -1);
    setPageIndex(nextIndex);
  };

  const pageVariants = {
    enter: (direction) => ({
      x: direction > 0 ? "10%" : "-10%",
      opacity: 0.45,
    }),
    center: {
      x: 0,
      opacity: 1,
    },
    exit: (direction) => ({
      x: direction > 0 ? "-10%" : "10%",
      opacity: 0.45,
    }),
  };

  const currentPage = pages[pageIndex] || [];
  const currentPageSlots = Array.from({ length: KPI_PAGE_SLOT_COUNT }, (_, index) => currentPage[index] || null);

  return (
    <>
    <Stack spacing={1.25}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          minHeight: 34,
        }}
      >
        <Stack direction="row" spacing={1} alignItems="center">
          <Box sx={{ minHeight: 24 }}>
            {pinMessage ? (
              <Typography variant="caption" color="warning.main">
                {pinMessage}
              </Typography>
            ) : null}
          </Box>
          {isEditing ? (
            <Typography variant="caption" color="text.secondary" sx={{ px: 0.5 }}>
              KPI edit mode: drag within pinned or unpinned groups. Page placement updates automatically.
            </Typography>
          ) : null}
        </Stack>
        <Stack direction="row" spacing={0.25} alignItems="center">
          {pages.length > 1 ? (
            <>
              <IconButton
                size="small"
                onClick={() => handlePageChange(pageIndex - 1)}
                disabled={pageIndex === 0}
                sx={{
                  color: "text.secondary",
                  bgcolor: "rgba(255,255,255,0.03)",
                }}
              >
                <ChevronLeftRoundedIcon fontSize="small" />
              </IconButton>
              <Typography variant="caption" color="text.secondary" sx={{ minWidth: 32, textAlign: "center" }}>
                {pageIndex + 1}/{pages.length}
              </Typography>
              <IconButton
                size="small"
                onClick={() => handlePageChange(pageIndex + 1)}
                disabled={pageIndex === pages.length - 1}
                sx={{
                  color: "text.secondary",
                  bgcolor: "rgba(255,255,255,0.03)",
                }}
              >
                <ChevronRightRoundedIcon fontSize="small" />
              </IconButton>
            </>
          ) : null}
        </Stack>
      </Box>

      {isEditing ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={({ active }) => setActiveId(active.id)}
          onDragCancel={() => setActiveId(null)}
          onDragEnd={({ active, over }) => {
            setActiveId(null);
            if (!over || active.id === over.id) return;
            onKpiLayoutChange(
              reorderDesktopKpiLayout(activeLayout, active.id, over.id),
            );
          }}
        >
          <SortableContext items={renderedOrder} strategy={rectSortingStrategy}>
            <Stack spacing={1.5}>
              {pages.map((pageItems, pageNumber) => (
                <Box
                  key={`edit-page-${pageNumber}`}
                  sx={{
                    p: 1.2,
                    borderRadius: "20px",
                    border: "1px solid rgba(255,255,255,0.08)",
                    bgcolor: "rgba(255,255,255,0.02)",
                  }}
                >
                  <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: "block" }}>
                    Page {pageNumber + 1}
                  </Typography>
                  <Box
                    sx={{
                      display: "grid",
                      gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                      gap: 2,
                    }}
                  >
                    {pageItems.map((metricId) => (
                      <SortableDesktopKpiCard
                        key={metricId}
                        id={metricId}
                        metric={cardsById.get(metricId)}
                        isEditing
                        isPinned={pinnedSet.has(metricId)}
                        onTogglePin={handleTogglePin}
                      />
                    ))}
                  </Box>
                </Box>
              ))}
            </Stack>
          </SortableContext>
        </DndContext>
      ) : (
        <Box sx={{ overflow: "hidden", position: "relative" }}>
          <AnimatePresence mode="wait" initial={false} custom={pageDirection}>
            <motion.div
              key={`page-${pageIndex}`}
              custom={pageDirection}
              variants={pageVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.24, ease: "easeOut" }}
            >
              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                  gap: 2,
                }}
              >
                {currentPageSlots.map((metricId, index) =>
                  metricId ? (
                    <DesktopKpiCard
                      key={metricId}
                      metric={cardsById.get(metricId)}
                      isPinned={pinnedSet.has(metricId)}
                      isEditing={false}
                      onTogglePin={handleTogglePin}
                    />
                  ) : (
                    <Box
                      key={`empty-kpi-slot-${pageIndex}-${index}`}
                      aria-hidden="true"
                      sx={{
                        minHeight: 110,
                        borderRadius: "12px",
                        visibility: "hidden",
                      }}
                    />
                  ),
                )}
              </Box>
            </motion.div>
          </AnimatePresence>
        </Box>
      )}
    </Stack>
    </>
  );
}

function renderToggle({
  leftActive,
  leftLabel,
  rightActive,
  rightLabel,
  leftColor = "primary.main",
  rightColor = "#3b82f6",
  onClick,
}) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        bgcolor: "background.default",
        borderRadius: 12,
        p: 0.5,
        cursor: "pointer",
        zIndex: 2,
        boxShadow: "inset 0 1px 3px rgba(0,0,0,0.1)",
        border: "1px solid",
        borderColor: "divider",
      }}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <Box
        sx={{
          px: 1,
          py: 0.25,
          borderRadius: 10,
          bgcolor: leftActive ? leftColor : "transparent",
          color: leftActive ? "primary.contrastText" : "text.secondary",
          fontSize: "0.65rem",
          fontWeight: 600,
        }}
      >
        {leftLabel}
      </Box>
      <Box
        sx={{
          px: 1,
          py: 0.25,
          borderRadius: 10,
          bgcolor: rightActive ? rightColor : "transparent",
          color: rightActive ? "#fff" : "text.secondary",
          fontSize: "0.65rem",
          fontWeight: 600,
        }}
      >
        {rightLabel}
      </Box>
    </Box>
  );
}

function buildIntentMetricState(metrics = {}) {
  const buildIntentEntry = (prefix) => ({
    sessions: Number(metrics?.[`${prefix}_intent_sessions`]?.value ?? 0),
    percent: Number(metrics?.[`${prefix}_intent_percent`]?.value ?? 0) / 100,
    sessionsDelta: {
      diff_pct: Number(metrics?.[`${prefix}_intent_sessions`]?.diff_pct ?? 0),
      direction: metrics?.[`${prefix}_intent_sessions`]?.direction ?? "flat",
    },
    percentDelta: {
      diff_pct: Number(metrics?.[`${prefix}_intent_percent`]?.diff_pct ?? 0),
      direction: metrics?.[`${prefix}_intent_percent`]?.direction ?? "flat",
    },
    prevSessions:
      metrics?.[`${prefix}_intent_sessions`]?.previous != null
        ? Number(metrics[`${prefix}_intent_sessions`].previous)
        : null,
    prevPercent:
      metrics?.[`${prefix}_intent_percent`]?.previous != null
        ? Number(metrics[`${prefix}_intent_percent`].previous) / 100
        : null,
  });

  return {
    high: buildIntentEntry("high"),
    medium: buildIntentEntry("medium"),
    low: buildIntentEntry("low"),
  };
}

function KPIs({
  variant = "legacy",
  query,
  selectedMetrics = [],
  activeMetric = null,
  onSelectMetric,
  onToggleMetric,
  onLoaded,
  onFunnelData,
  productId,
  productLabel,
  showRow = null,
  compareMode = false,
  showWebVitals = true,
  showCiEvents = true,
  showRtoKpi = true,
  showIntentMetrics = true,
  desktopKpiLayout,
  onDesktopKpiLayoutChange,
  canEditDesktopKpis = false,
  dashboardLayoutEditing = false,
}) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const [revenueMode, setRevenueMode] = useState("G");
  const [atcMode, setAtcMode] = useState("R");
  const [checkoutMode, setCheckoutMode] = useState("C");
  const [cancellationMode, setCancellationMode] = useState("C");
  const [rtoMode, setRtoMode] = useState("%");
  const [highIntentMode, setHighIntentMode] = useState("%");
  const [mediumIntentMode, setMediumIntentMode] = useState("%");
  const [lowIntentMode, setLowIntentMode] = useState("%");
  const [desktopSelectedCardId, setDesktopSelectedCardId] = useState("orders");
  const start = query?.start;
  const end = query?.end;
  const brandKey = query?.brand_key;
  const refreshKey = query?.refreshKey;
  const scopedProductId = (productId || "").toString().trim();
  const isProductScoped = scopedProductId.length > 0;
  const utmSource = query?.utm_source;
  const utmMedium = query?.utm_medium;
  const utmCampaign = query?.utm_campaign;
  const salesChannel = query?.sales_channel;
  const deviceType = query?.device_type;
  const rawDiscountCode = query?.discount_code;
  const discountCodes = useMemo(
    () =>
      Array.isArray(rawDiscountCode)
        ? rawDiscountCode
        : rawDiscountCode
          ? [rawDiscountCode]
          : [],
    [rawDiscountCode],
  );
  const city = query?.city;
  const { convertAmount, formatConvertedAmount } = useInrCurrency(brandKey, end);
  const { loading, deltaLoading, data, webVitalsData } = useDashboardKpiData({
    query,
    onLoaded,
    productId,
    showWebVitals,
  });

  const scopeLabel = useMemo(() => {
    if (!isProductScoped) return "All products";
    return productLabel || scopedProductId;
  }, [isProductScoped, productLabel, scopedProductId]);

  useEffect(() => {
    if (typeof onFunnelData !== "function" || !data.funnel) return;
    onFunnelData({
      stats: data.funnel,
      deltas: {
        sessions: data.sessDelta || null,
        atc: data.atcDelta || null,
        ci: data.ciDelta || null,
        orders: data.cvrDelta || null,
      },
      loading: loading || deltaLoading,
    });
  }, [data, deltaLoading, loading, onFunnelData]);

  const activeFilters = useMemo(
    () =>
      [
        Array.isArray(utmSource) && utmSource.length > 0
          ? { key: "source", label: `source: ${utmSource}` }
          : null,
        Array.isArray(utmMedium) && utmMedium.length > 0
          ? { key: "medium", label: `medium: ${utmMedium}` }
          : null,
        Array.isArray(utmCampaign) && utmCampaign.length > 0
          ? { key: "campaign", label: `campaign: ${utmCampaign}` }
          : null,
        discountCodes.length > 0
          ? { key: "discount", label: `discount: ${discountCodes.join(", ")}` }
          : null,
      ].filter(Boolean),
    [utmSource, utmMedium, utmCampaign, discountCodes],
  );

  const desktopCardsById = useMemo(
    () =>
      buildDesktopMetrics({
        compareMode,
        data: {
          ...data,
          cvrDeltaValue: data.cvrDelta ? data.cvrDelta.diff_pct ?? data.cvrDelta.diff_pp : undefined,
        },
        deltaLoading,
        desktopSelectedCardId,
        formatConvertedAmount,
        loading,
        onDesktopCardSelect: setDesktopSelectedCardId,
        onSelectMetric,
        onToggleMetric,
        revenueMode,
        onRevenueModeToggle: () => setRevenueMode((prev) => (prev === "G" ? "N" : "G")),
        atcMode,
        onAtcModeToggle: () => setAtcMode((prev) => (prev === "R" ? "S" : "R")),
        checkoutMode,
        onCheckoutModeToggle: () => setCheckoutMode((prev) => (prev === "R" ? "C" : "R")),
        cancellationMode,
        onCancellationModeToggle: () => setCancellationMode((prev) => (prev === "C" ? "R" : "C")),
        rtoMode,
        onRtoModeToggle: () => setRtoMode((prev) => (prev === "O" ? "%" : "O")),
        highIntentMode,
        onHighIntentModeToggle: () =>
          setHighIntentMode((prev) => (prev === "S" ? "%" : "S")),
        mediumIntentMode,
        onMediumIntentModeToggle: () =>
          setMediumIntentMode((prev) => (prev === "S" ? "%" : "S")),
        lowIntentMode,
        onLowIntentModeToggle: () =>
          setLowIntentMode((prev) => (prev === "S" ? "%" : "S")),
        selectedMetrics,
        activeMetric,
        showCiEvents,
        showRtoKpi,
        showIntentMetrics,
        convertAmount,
      }),
    [
      activeMetric,
      compareMode,
      convertAmount,
      data,
      deltaLoading,
      desktopSelectedCardId,
      formatConvertedAmount,
      loading,
      onSelectMetric,
      onToggleMetric,
      revenueMode,
      atcMode,
      checkoutMode,
      cancellationMode,
      rtoMode,
      highIntentMode,
      mediumIntentMode,
      lowIntentMode,
      selectedMetrics,
      showCiEvents,
      showRtoKpi,
      showIntentMetrics,
    ],
  );

  useEffect(() => {
    const fallbackByMetric = {
      orders: "orders",
      sales: "revenue",
      aov: "aov",
      sessions: "sessions",
      atc_rate: "atc",
      atc: "atc",
      checkout_rate: "checkout",
      ci_events: "checkout",
      cvr: "cvr",
    };

    if (!activeMetric) return;
    const nextCardId = fallbackByMetric[activeMetric];
    if (!nextCardId) return;

    const isCurrentMatch = (
      (activeMetric === "sales" && desktopSelectedCardId === "revenue")
      || ((activeMetric === "atc" || activeMetric === "atc_rate") && desktopSelectedCardId === "atc")
      || ((activeMetric === "checkout_rate" || activeMetric === "ci_events") && desktopSelectedCardId === "checkout")
      || desktopSelectedCardId === nextCardId
    );

    if (!isCurrentMatch) {
      setDesktopSelectedCardId(nextCardId);
    }
  }, [activeMetric, desktopSelectedCardId]);

  const pagedCards = useMemo(
    () =>
      Array.from(desktopCardsById.values()).map((metric) => ({
        id: metric.id,
        size: { xs: 6, sm: 6, md: 3 },
        node: (
          <KPIStat
            label={metric.label}
            value={metric.value}
            unavailable={metric.unavailable}
            loading={metric.loading}
            deltaLoading={metric.deltaLoading}
            formatter={metric.formatter}
            delta={metric.delta}
            onSelect={metric.onSelect}
            onSelectionToggle={metric.onSelectionToggle}
            selected={metric.selected}
            selectionIndicatorSelected={metric.selectionIndicatorSelected}
            compareValue={metric.compareValue}
            compareFormatter={metric.compareFormatter}
            activeColor={metric.activeColor}
            invertDeltaColor={metric.invertDeltaColor}
            showSelectionIndicator={metric.showSelectionIndicator}
            action={metric.action}
          />
        ),
      })),
    [desktopCardsById],
  );
  const mobileTopPageCardIds = useMemo(
    () => [
      "orders",
      "revenue",
      "aov",
      "sessions",
      "atc",
      "cvr",
      "high_intent",
      "medium_intent",
      "low_intent",
    ],
    [],
  );
  const mobilePagedCards = useMemo(
    () =>
      mobileTopPageCardIds
        .map((id) => pagedCards.find((card) => card.id === id))
        .filter(Boolean),
    [mobileTopPageCardIds, pagedCards],
  );
  const mobileFooterCards = useMemo(() => {
    const footer = [];
    const pushMetricCard = (metricId) => {
      const metric = desktopCardsById.get(metricId);
      if (!metric) return;
      footer.push({
        id: metric.id,
        size: { xs: 12, sm: 12, md: 3 },
        node: (
          <KPIStat
            label={metric.label}
            value={metric.value}
            unavailable={metric.unavailable}
            loading={metric.loading}
            deltaLoading={metric.deltaLoading}
            formatter={metric.formatter}
            delta={metric.delta}
            onSelect={metric.onSelect}
            onSelectionToggle={metric.onSelectionToggle}
            selected={metric.selected}
            selectionIndicatorSelected={metric.selectionIndicatorSelected}
            compareValue={metric.compareValue}
            compareFormatter={metric.compareFormatter}
            activeColor={metric.activeColor}
            invertDeltaColor={metric.invertDeltaColor}
            showSelectionIndicator={metric.showSelectionIndicator}
            action={metric.action}
            centerOnMobile
          />
        ),
      });
    };

    pushMetricCard("returns");
    pushMetricCard("rto");
    pushMetricCard("checkout");

    if (showWebVitals) {
      footer.push({
        id: "performance",
        size: { xs: 12, sm: 12, md: 3 },
        node: (
          <KPIStat
            label="Web Performance(Avg)"
            value={webVitalsData.performanceAvg ?? 0}
            loading={webVitalsData.loading}
            deltaLoading={webVitalsData.loading}
            formatter={(value) => nfFloat.format(value)}
            delta={
              typeof webVitalsData.performanceChange === "number"
                ? {
                    value: webVitalsData.performanceChange,
                    direction:
                      webVitalsData.performanceChange > 0
                        ? "up"
                        : webVitalsData.performanceChange < 0
                          ? "down"
                          : "flat",
                  }
                : undefined
            }
            centerOnMobile
            activeColor="#06b6d4"
            onSelect={onSelectMetric ? () => onSelectMetric("performance") : undefined}
            onSelectionToggle={
              onToggleMetric ? () => onToggleMetric("performance") : undefined
            }
            selected={activeMetric === "performance"}
            selectionIndicatorSelected={selectedMetrics.includes("performance")}
          />
        ),
      });
    }

    return footer;
  }, [
    activeMetric,
    desktopCardsById,
    onSelectMetric,
    onToggleMetric,
    selectedMetrics,
    showWebVitals,
    webVitalsData.loading,
    webVitalsData.performanceAvg,
    webVitalsData.performanceChange,
  ]);

  if (variant === "desktop_paged") {
    return (
      <>
        <Box sx={{ display: { xs: "none", md: "block" } }}>
          <DesktopKpiPages
            cardsById={desktopCardsById}
            kpiLayout={desktopKpiLayout}
            onKpiLayoutChange={onDesktopKpiLayoutChange}
            canEdit={canEditDesktopKpis}
            dashboardLayoutEditing={dashboardLayoutEditing}
          />
        </Box>
        <MobileKpiPages
          cards={mobilePagedCards}
          footerCards={mobileFooterCards}
          kpiLayout={desktopKpiLayout}
          onKpiLayoutChange={onDesktopKpiLayoutChange}
          canEdit={canEditDesktopKpis}
          dashboardLayoutEditing={dashboardLayoutEditing}
        />
      </>
    );
  }

  const totalSessions = data.totalSessions || 0;
  const totalAtcSessions = data.totalAtcSessions || 0;

  return (
    <>
      {(showRow === null || showRow === 1) && (
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          sx={{ mb: 1.5, display: { xs: "none", md: "flex" } }}
        >
          <Typography variant="subtitle2" color="text.secondary">
            Scope: {scopeLabel}
          </Typography>

          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            {activeFilters.map((filter) => (
              <GlassChip
                key={filter.key}
                label={filter.label}
                size="small"
                isDark={isDark}
                active
                sx={{ maxWidth: 200 }}
              />
            ))}
            {isProductScoped ? (
              <Typography variant="caption" color="text.secondary">
                Using product-level KPIs
              </Typography>
            ) : null}
          </Box>
        </Stack>
      )}
      <Grid container spacing={2} columns={12}>
        {(showRow === null || showRow === 1 || showRow === "mobile_top") && (
          <>
            <Grid
              size={{ xs: 6, sm: 6, md: 3 }}
              sx={{ order: { xs: 1, md: 0 } }}
            >
              <KPIStat
                label="Total Orders"
                value={data.orders?.value ?? 0}
                loading={loading}
                deltaLoading={deltaLoading}
                formatter={(value) => nfInt.format(value)}
                delta={
                  data.ordersDelta
                    ? {
                        value: data.ordersDelta.diff_pct,
                        direction: data.ordersDelta.direction,
                      }
                    : undefined
                }
                onSelect={
                  onSelectMetric ? () => onSelectMetric("orders") : undefined
                }
                onSelectionToggle={
                  onToggleMetric ? () => onToggleMetric("orders") : undefined
                }
                selected={activeMetric === "orders"}
                selectionIndicatorSelected={selectedMetrics.includes("orders")}
                compareValue={
                  compareMode && data.prevOrders != null
                    ? data.prevOrders
                    : undefined
                }
                compareFormatter={(value) => nfInt.format(value)}
              />
            </Grid>
            <Grid
              size={{ xs: 6, sm: 6, md: 3 }}
              sx={{ order: { xs: 2, md: 0 } }}
            >
              <KPIStat
                label={revenueMode === "G" ? "Gross Revenue" : "Net Revenue"}
                action={renderToggle({
                  leftActive: revenueMode === "G",
                  leftLabel: "G",
                  rightActive: revenueMode === "N",
                  rightLabel: "N",
                  onClick: () => setRevenueMode((prev) => (prev === "G" ? "N" : "G")),
                })}
                value={
                  revenueMode === "G"
                    ? convertAmount(data.sales?.value ?? 0)
                    : convertAmount(data.sales?.value ?? 0) / 1.18
                }
                loading={loading}
                deltaLoading={deltaLoading}
                formatter={(value) =>
                  formatConvertedAmount(value, { maximumFractionDigits: 0 })
                }
                delta={
                  data.salesDelta
                    ? {
                        value: data.salesDelta.diff_pct,
                        direction: data.salesDelta.direction,
                      }
                    : undefined
                }
                onSelect={onSelectMetric ? () => onSelectMetric("sales") : undefined}
                onSelectionToggle={
                  onToggleMetric ? () => onToggleMetric("sales") : undefined
                }
                selected={activeMetric === "sales"}
                selectionIndicatorSelected={selectedMetrics.includes("sales")}
                compareValue={
                  compareMode && data.prevSales != null
                    ? revenueMode === "G"
                      ? convertAmount(data.prevSales)
                      : convertAmount(data.prevSales) / 1.18
                    : undefined
                }
                compareFormatter={(value) =>
                  formatConvertedAmount(value, { maximumFractionDigits: 0 })
                }
                activeColor={revenueMode === "G" ? "#10b981" : "#3b82f6"}
              />
            </Grid>
            <Grid
              size={{ xs: 6, sm: 6, md: 3 }}
              sx={{ order: { xs: 3, md: 0 } }}
            >
              <KPIStat
                label="Average order value"
                value={convertAmount(data.aov?.aov ?? 0)}
                loading={loading}
                deltaLoading={deltaLoading}
                formatter={(value) =>
                  formatConvertedAmount(value, { maximumFractionDigits: 0 })
                }
                delta={
                  data.aovDelta
                    ? {
                        value: data.aovDelta.diff_pct,
                        direction: data.aovDelta.direction,
                      }
                    : undefined
                }
                onSelect={onSelectMetric ? () => onSelectMetric("aov") : undefined}
                onSelectionToggle={
                  onToggleMetric ? () => onToggleMetric("aov") : undefined
                }
                selected={activeMetric === "aov"}
                selectionIndicatorSelected={selectedMetrics.includes("aov")}
                compareValue={
                  compareMode && data.prevAov != null
                    ? convertAmount(data.prevAov)
                    : undefined
                }
                compareFormatter={(value) =>
                  formatConvertedAmount(value, { maximumFractionDigits: 0 })
                }
              />
            </Grid>
            <Grid
              size={{ xs: 12, sm: 6, md: 3 }}
              sx={{ order: { xs: 7, md: 0 } }}
            >
              <KPIStat
                label={cancellationMode === "C" ? "Cancellation Rate" : "Refund Rate"}
                action={renderToggle({
                  leftActive: cancellationMode === "C",
                  leftLabel: "C",
                  rightActive: cancellationMode === "R",
                  rightLabel: "R",
                  leftColor: "error.main",
                  rightColor: "warning.main",
                  onClick: () =>
                    setCancellationMode((prev) => (prev === "C" ? "R" : "C")),
                })}
                value={
                  cancellationMode === "C"
                    ? data.returnsData?.cancelled_rate ?? 0
                    : data.returnsData?.refunded_rate ?? 0
                }
                unavailable={data.unavailable?.returns}
                loading={loading}
                deltaLoading={deltaLoading}
                formatter={(value) => nfPct.format(value)}
                delta={
                  cancellationMode === "C"
                    ? data.cancelledRateDelta
                      ? {
                          value: data.cancelledRateDelta.diff_pct,
                          direction: data.cancelledRateDelta.direction,
                        }
                      : undefined
                    : data.refundedRateDelta
                      ? {
                          value: data.refundedRateDelta.diff_pct,
                          direction: data.refundedRateDelta.direction,
                        }
                      : undefined
                }
                selected={false}
                selectionIndicatorSelected={false}
                showSelectionIndicator={false}
                centerOnMobile
                compareValue={
                  compareMode
                    ? cancellationMode === "C"
                      ? data.prevCancelledRate
                      : data.prevRefundedRate
                    : undefined
                }
                compareFormatter={(value) => nfPct.format(value)}
                invertDeltaColor
                activeColor={cancellationMode === "C" ? "#ef4444" : "#f59e0b"}
              />
            </Grid>
            {showRtoKpi && (
              <Grid
                size={{ xs: 12, sm: 6, md: 3 }}
                sx={{ order: { xs: 8, md: 0 } }}
              >
                <KPIStat
                  label={rtoMode === "O" ? "RTO Orders (Approx.)" : "RTO % (Approx.)"}
                  action={renderToggle({
                    leftActive: rtoMode === "O",
                    leftLabel: "O",
                    rightActive: rtoMode === "%",
                    rightLabel: "%",
                    leftColor: "warning.main",
                    rightColor: "error.main",
                    onClick: () => setRtoMode((prev) => (prev === "O" ? "%" : "O")),
                  })}
                  value={rtoMode === "O" ? data.rtoData?.orders ?? 0 : data.rtoData?.rate ?? 0}
                  unavailable={data.unavailable?.rto ?? data.unavailable?.returns}
                  loading={loading}
                  deltaLoading={deltaLoading}
                  formatter={
                    rtoMode === "O"
                      ? (value) => nfInt.format(value)
                      : (value) => nfPct.format(value)
                  }
                  delta={
                    rtoMode === "O"
                      ? data.rtoOrdersDelta
                        ? {
                            value: data.rtoOrdersDelta.diff_pct,
                            direction: data.rtoOrdersDelta.direction,
                          }
                        : undefined
                      : data.rtoRateDelta
                        ? {
                            value: data.rtoRateDelta.diff_pct,
                            direction: data.rtoRateDelta.direction,
                          }
                        : undefined
                  }
                  selected={false}
                  selectionIndicatorSelected={false}
                  showSelectionIndicator={false}
                  centerOnMobile
                  compareValue={
                    compareMode
                      ? rtoMode === "O"
                        ? data.prevRtoOrders
                        : data.prevRtoRate
                      : undefined
                  }
                  compareFormatter={
                    rtoMode === "O"
                      ? (value) => nfInt.format(value)
                      : (value) => nfPct.format(value)
                  }
                  activeColor="#f59e0b"
                />
              </Grid>
            )}
          </>
        )}

        {(showRow === null ||
          showRow === 2 ||
          showRow === "sessions_atc" ||
          showRow === "mobile_top") && (
          <>
            <Grid
              size={{ xs: 6, sm: 6, md: showCiEvents ? 3 : 4 }}
              sx={{ order: { xs: 5, md: 0 } }}
            >
              <KPIStat
                label="Total Sessions"
                value={totalSessions}
                unavailable={data.unavailable?.sessions}
                loading={loading}
                deltaLoading={deltaLoading}
                formatter={(value) => nfInt.format(value)}
                delta={
                  data.sessDelta
                    ? {
                        value: data.sessDelta.diff_pct,
                        direction: data.sessDelta.direction,
                      }
                    : undefined
                }
                onSelect={
                  onSelectMetric ? () => onSelectMetric("sessions") : undefined
                }
                onSelectionToggle={
                  onToggleMetric ? () => onToggleMetric("sessions") : undefined
                }
                selected={activeMetric === "sessions"}
                selectionIndicatorSelected={selectedMetrics.includes("sessions")}
                compareValue={
                  compareMode && data.prevSessions != null
                    ? data.prevSessions
                    : undefined
                }
                compareFormatter={(value) => nfInt.format(value)}
              />
            </Grid>
            <Grid
              size={{ xs: 6, sm: 6, md: showCiEvents ? 3 : 4 }}
              sx={{ order: { xs: 6, md: 0 } }}
            >
              <KPIStat
                label={atcMode === "R" ? "ATC Rate" : "ATC Sessions"}
                action={renderToggle({
                  leftActive: atcMode === "R",
                  leftLabel: "R",
                  rightActive: atcMode === "S",
                  rightLabel: "S",
                  leftColor: "#f59e0b",
                  onClick: () => setAtcMode((prev) => (prev === "R" ? "S" : "R")),
                })}
                value={
                  atcMode === "R"
                    ? totalSessions > 0
                      ? totalAtcSessions / totalSessions
                      : 0
                    : totalAtcSessions
                }
                unavailable={data.unavailable?.atc}
                loading={loading}
                deltaLoading={deltaLoading}
                formatter={
                  atcMode === "R"
                    ? (value) => nfPct.format(value)
                    : (value) => nfInt.format(value)
                }
                delta={
                  atcMode === "R"
                    ? data.atcRateDelta
                      ? {
                          value: data.atcRateDelta.diff_pct,
                          direction: data.atcRateDelta.direction,
                        }
                      : undefined
                    : data.atcDelta
                      ? {
                          value: data.atcDelta.diff_pct,
                          direction: data.atcDelta.direction,
                        }
                      : undefined
                }
                onSelect={
                  onSelectMetric
                    ? () => onSelectMetric(atcMode === "R" ? "atc_rate" : "atc")
                    : undefined
                }
                onSelectionToggle={
                  onToggleMetric
                    ? () => onToggleMetric(atcMode === "R" ? "atc_rate" : "atc")
                    : undefined
                }
                selected={activeMetric === "atc_rate" || activeMetric === "atc"}
                selectionIndicatorSelected={
                  selectedMetrics.includes("atc_rate") ||
                  selectedMetrics.includes("atc")
                }
                compareValue={
                  compareMode
                    ? atcMode === "R"
                      ? data.prevAtcRate
                      : data.prevAtcSessions
                    : undefined
                }
                compareFormatter={
                  atcMode === "R"
                    ? (value) => nfPct.format(value)
                    : (value) => nfInt.format(value)
                }
                activeColor={atcMode === "R" ? "#10b981" : "#f59e0b"}
              />
            </Grid>
            {showCiEvents && (
              <Grid
                size={{ xs: 12, sm: 6, md: 3 }}
                sx={{ order: { xs: 9, md: 0 } }}
              >
                <KPIStat
                  label={
                    checkoutMode === "R"
                      ? "Checkout Rate"
                      : "Checkout Initiated Events"
                  }
                  action={renderToggle({
                    leftActive: checkoutMode === "C",
                    leftLabel: "C",
                    rightActive: checkoutMode === "R",
                    rightLabel: "R",
                    leftColor: "primary.main",
                    rightColor: "#10b981",
                    onClick: () =>
                      setCheckoutMode((prev) => (prev === "R" ? "C" : "R")),
                  })}
                  value={
                    checkoutMode === "R"
                      ? totalSessions > 0
                        ? (data.totalCiEvents?.value ?? 0) / totalSessions
                        : 0
                      : data.totalCiEvents?.value ?? 0
                  }
                  centerOnMobile
                  unavailable={data.unavailable?.ci}
                  loading={loading}
                  deltaLoading={deltaLoading}
                  formatter={
                    checkoutMode === "R"
                      ? (value) => nfPct.format(value)
                      : (value) => nfInt.format(value)
                  }
                  delta={
                    checkoutMode === "R"
                      ? data.checkoutRateDelta
                        ? {
                            value: data.checkoutRateDelta.diff_pct,
                            direction: data.checkoutRateDelta.direction,
                          }
                        : undefined
                      : data.ciDelta
                        ? {
                            value: data.ciDelta.diff_pct,
                            direction: data.ciDelta.direction,
                          }
                        : undefined
                  }
                  onSelect={
                    onSelectMetric
                      ? () =>
                          onSelectMetric(
                            checkoutMode === "R" ? "checkout_rate" : "ci_events",
                          )
                      : undefined
                  }
                  onSelectionToggle={
                    onToggleMetric
                      ? () =>
                          onToggleMetric(
                            checkoutMode === "R" ? "checkout_rate" : "ci_events",
                          )
                      : undefined
                  }
                  selected={
                    activeMetric === "checkout_rate" || activeMetric === "ci_events"
                  }
                  selectionIndicatorSelected={
                    selectedMetrics.includes("checkout_rate") ||
                    selectedMetrics.includes("ci_events")
                  }
                  compareValue={
                    compareMode
                      ? checkoutMode === "R"
                        ? data.prevCheckoutRate
                        : data.prevCiEvents
                      : undefined
                  }
                  compareFormatter={
                    checkoutMode === "R"
                      ? (value) => nfPct.format(value)
                      : (value) => nfInt.format(value)
                  }
                  activeColor={checkoutMode === "R" ? "#10b981" : "#5ba3e0"}
                />
              </Grid>
            )}
          </>
        )}

        {(showRow === null ||
          showRow === 2 ||
          showRow === "web_perf_cvr" ||
          showRow === "mobile_top") && (
          <Grid
            size={{ xs: 6, sm: 6, md: showCiEvents ? 3 : 4 }}
            sx={{ order: { xs: 4, md: 0 } }}
          >
            <KPIStat
              label="Conversion Rate"
              value={data.cvr?.cvr ?? 0}
              unavailable={data.unavailable?.cvr}
              loading={loading}
              deltaLoading={deltaLoading}
              formatter={(value) => nfPct.format(value)}
              delta={
                data.cvrDelta
                  ? {
                      value: data.cvrDelta.diff_pct ?? data.cvrDelta.diff_pp,
                      direction: data.cvrDelta.direction,
                    }
                  : undefined
              }
              onSelect={onSelectMetric ? () => onSelectMetric("cvr") : undefined}
              onSelectionToggle={
                onToggleMetric ? () => onToggleMetric("cvr") : undefined
              }
              selected={activeMetric === "cvr"}
              selectionIndicatorSelected={selectedMetrics.includes("cvr")}
              compareValue={
                compareMode && data.prevCvr != null
                  ? data.prevCvr / 100
                  : undefined
              }
              compareFormatter={(value) => nfPct.format(value)}
            />
          </Grid>
        )}

        {(showRow === null || showRow === 2 || showRow === "mobile_top") &&
          showWebVitals && (
            <Grid
              size={{ xs: 12, sm: 6, md: 3 }}
              sx={{ order: { xs: 10, md: 0 } }}
            >
              <KPIStat
                label="Web Performance(Avg)"
                value={webVitalsData.performanceAvg ?? 0}
                loading={webVitalsData.loading}
                deltaLoading={webVitalsData.loading}
                formatter={(value) => nfFloat.format(value)}
                delta={
                  typeof webVitalsData.performanceChange === "number"
                    ? {
                        value: webVitalsData.performanceChange,
                        direction:
                          webVitalsData.performanceChange > 0
                            ? "up"
                            : webVitalsData.performanceChange < 0
                              ? "down"
                              : "flat",
                      }
                    : undefined
                }
                centerOnMobile
                activeColor="#06b6d4"
                onSelect={
                  onSelectMetric ? () => onSelectMetric("performance") : undefined
                }
                onSelectionToggle={
                  onToggleMetric ? () => onToggleMetric("performance") : undefined
                }
                selected={activeMetric === "performance"}
                selectionIndicatorSelected={selectedMetrics.includes("performance")}
              />
            </Grid>
          )}
      </Grid>
    </>
  );
}

export default memo(KPIs);
