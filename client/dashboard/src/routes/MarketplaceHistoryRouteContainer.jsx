import { Suspense, lazy } from "react";
import { EmptyStateCard, SectionFallback } from "./shared/RouteUi.jsx";

const MarketplaceHistoryPage = lazy(() => import("../pages/MarketplaceHistory/MarketplaceHistoryPage.jsx"));

// Visibility is decided in App.jsx (marketplace_panel permission); the service enforces it again on every request.
export default function MarketplaceHistoryRouteContainer({ hasBrand, activeBrandKey }) {
  if (!hasBrand) {
    return <EmptyStateCard message="Select a brand to view marketplace history." />;
  }

  return (
    <Suspense fallback={<SectionFallback count={3} height={220} />}>
      <MarketplaceHistoryPage brandKey={activeBrandKey} />
    </Suspense>
  );
}
