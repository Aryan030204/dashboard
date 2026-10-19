import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWeeklyReportSlide } from "../../lib/api.js";

const AHEAD = 2; // prefetch this many slides after the current one
const BEHIND = 1; // and this many before it
const KEEP_BEHIND = 3; // full-size images further than this from the current slide are released
const KEEP_AHEAD = 4;

// Loads slide images on demand. Only the current slide and its neighbours are fetched and kept
// (so a long deck never downloads up front), thumbnails load when they scroll into view, and
// every object URL is revoked when it is evicted or the viewer closes.
export default function useSlideImages({ brandKey, reportId, slideCount, current }) {
  const [urls, setUrls] = useState({});
  const store = useRef({});
  const inflight = useRef(new Set());
  const controller = useRef(null);
  const alive = useRef(true);

  const publish = useCallback(() => {
    if (alive.current) setUrls({ ...store.current });
  }, []);

  const request = useCallback(
    (n, thumb = false) => {
      if (!Number.isInteger(n) || n < 1 || n > slideCount) return;
      const key = `${thumb ? "t" : "f"}${n}`;
      if (store.current[key] || inflight.current.has(key)) return;
      inflight.current.add(key);
      fetchWeeklyReportSlide(brandKey, reportId, n, { thumb, signal: controller.current.signal })
        .then((url) => {
          if (!alive.current) {
            URL.revokeObjectURL(url);
            return;
          }
          store.current[key] = url;
          publish();
        })
        .catch((err) => {
          if (err?.name === "AbortError") return;
          store.current[key] = "error";
          publish();
        })
        .finally(() => inflight.current.delete(key));
    },
    [brandKey, reportId, slideCount, publish],
  );

  const retry = useCallback(
    (n, thumb = false) => {
      const key = `${thumb ? "t" : "f"}${n}`;
      if (store.current[key] === "error") delete store.current[key];
      request(n, thumb);
    },
    [request],
  );

  useEffect(() => {
    alive.current = true;
    controller.current = new AbortController();
    const held = store.current;
    const pending = inflight.current;
    return () => {
      alive.current = false;
      controller.current?.abort();
      Object.values(held).forEach((url) => url !== "error" && URL.revokeObjectURL(url));
      store.current = {};
      pending.clear();
    };
  }, [brandKey, reportId]);

  useEffect(() => {
    for (let n = current - BEHIND; n <= current + AHEAD; n += 1) request(n, false);
    let changed = false;
    Object.keys(store.current).forEach((key) => {
      if (key[0] !== "f") return;
      const n = Number(key.slice(1));
      if (n < current - KEEP_BEHIND || n > current + KEEP_AHEAD) {
        const url = store.current[key];
        if (url !== "error") URL.revokeObjectURL(url);
        delete store.current[key];
        changed = true;
      }
    });
    if (changed) publish();
  }, [current, request, publish]);

  return { urls, request, retry };
}
