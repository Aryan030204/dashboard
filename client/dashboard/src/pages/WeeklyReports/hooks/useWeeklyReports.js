import { useCallback, useEffect, useRef, useState } from "react";
import { listWeeklyReports, weeklyReportErrorMessage } from "../../../lib/api.js";

const POLL_INTERVAL_MS = 4000;

// Loads the brand's reports and keeps polling quietly while any report is still
// being converted, so the table moves from Processing to Ready on its own.
export default function useWeeklyReports(brandKey) {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const brandRef = useRef(brandKey);
  brandRef.current = brandKey;

  const fetchReports = useCallback(
    async (signal, silent) => {
      if (!brandKey) return;
      if (!silent) setLoading(true);
      const res = await listWeeklyReports({ brandKey, signal });
      if (res.aborted || signal?.aborted || brandRef.current !== brandKey) return;
      if (res.error) {
        if (!silent) {
          setReports([]);
          setError(weeklyReportErrorMessage(res, "Failed to load presentations."));
        }
      } else {
        setReports(res.data);
        setError("");
      }
      if (!silent) setLoading(false);
    },
    [brandKey],
  );

  useEffect(() => {
    setReports([]);
    setError("");
    const controller = new AbortController();
    fetchReports(controller.signal, false);
    return () => controller.abort();
  }, [fetchReports]);

  const hasProcessing = reports.some((report) => report.status === "PROCESSING");
  useEffect(() => {
    if (!hasProcessing) return undefined;
    const controller = new AbortController();
    const timer = setInterval(
      () => fetchReports(controller.signal, true),
      POLL_INTERVAL_MS,
    );
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [hasProcessing, fetchReports]);

  const refresh = useCallback(() => fetchReports(undefined, true), [fetchReports]);
  const reload = useCallback(() => fetchReports(undefined, false), [fetchReports]);

  return { reports, loading, error, refresh, reload };
}
