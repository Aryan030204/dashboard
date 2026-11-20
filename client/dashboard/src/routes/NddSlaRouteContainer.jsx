import { Suspense, lazy } from "react";
import { EmptyStateCard, SectionFallback } from "./shared/RouteUi.jsx";

const NddSlaPage = lazy(() => import("../pages/NddSla/NddSlaPage.jsx"));

// Visibility is decided in App.jsx (ndd_sla_panel permission); the service enforces it again on every request.
export default function NddSlaRouteContainer({ hasBrand, activeBrandKey, isManager, canUpload }) {
  if (!hasBrand) {
    return <EmptyStateCard message="Select a brand to view NDD / SLA reports." />;
  }

  return (
    <Suspense fallback={<SectionFallback count={2} height={220} />}>
      <NddSlaPage brandKey={activeBrandKey} isManager={isManager} canUpload={canUpload} />
    </Suspense>
  );
}
