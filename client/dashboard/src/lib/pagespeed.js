// The PageSpeed results behind both the dashboard's "Top 5 Pages" card and the Web Vitals "Page Level
// Breakdown" table. Both call fetchPagespeedResults with the same arguments, so they always show the
// same pages and numbers.

// The name the external PageSpeed service stores results under for a dashboard brand key.
export function pagespeedBrandName(brandKey) {
  const key = (brandKey || "").toString().trim().toUpperCase();
  switch (key) {
    case "TMC":
      return "TMC";
    case "BBB":
      return "BlaBliBluLife";
    case "PTS":
      return "SkincarePersonalTouch";
    default:
      return key || "";
  }
}

// Module-level cache + in-flight dedup for the pagespeed fetch. The dashboard card and the Web Vitals
// table call this with identical (brand, start, end) args for the same load; without this each would fire
// its own raw fetch() (this call bypasses DashboardDataProvider's cache, which only covers calls made
// through useDashboardDataApi).
const pagespeedCache = new Map();
const pagespeedInflight = new Map();

export function fetchPagespeedResults(brandName, start, end) {
  if (!brandName || !start || !end) return Promise.resolve([]);
  const key = `${brandName}|${start}|${end}`;

  if (pagespeedCache.has(key)) return Promise.resolve(pagespeedCache.get(key));
  if (pagespeedInflight.has(key)) return pagespeedInflight.get(key);

  const request = fetch(
    `/api/external-pagespeed/pagespeed?brand_key=${encodeURIComponent(brandName)}&start_date=${start}&end_date=${end}`,
  )
    .then((res) => res.json())
    .then((json) => json.results || [])
    .catch(() => [])
    .then((results) => {
      pagespeedCache.set(key, results);
      pagespeedInflight.delete(key);
      return results;
    });

  pagespeedInflight.set(key, request);
  return request;
}
