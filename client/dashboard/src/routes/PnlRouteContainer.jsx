import { Suspense, lazy } from "react";
import { EmptyStateCard, SectionFallback } from "./shared/RouteUi.jsx";

const PnlPage = lazy(() => import("../pages/Pnl/PnlPage.jsx"));

export default function PnlRouteContainer({ hasBrand, activeBrandKey }) {
  if (!hasBrand) {
    return <EmptyStateCard message="Select a brand to view P&L." />;
  }

  return (
    <Suspense fallback={<SectionFallback count={3} height={220} />}>
      <PnlPage brandKey={activeBrandKey} />
    </Suspense>
  );
}
