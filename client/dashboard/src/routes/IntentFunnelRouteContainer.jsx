import { Suspense, lazy } from "react";
import { EmptyStateCard, SectionFallback } from "./shared/RouteUi.jsx";

const IntentFunnelPanel = lazy(() => import("../components/IntentFunnelPanel.jsx"));

export default function IntentFunnelRouteContainer({
  hasBrand,
  activeBrandKey,
  start,
  end,
}) {
  if (!hasBrand) {
    return (
      <EmptyStateCard message="Select a brand to view intent funnel metrics." />
    );
  }

  return (
    <Suspense fallback={<SectionFallback count={2} height={240} />}>
      <IntentFunnelPanel brandKey={activeBrandKey} start={start} end={end} />
    </Suspense>
  );
}
