/* eslint-env jest */

const {
  ADD_INTENT_COLUMNS_SQL,
  BEHAVIOR_LEVEL_SQL,
  CREATE_TABLE_SQL,
  PAGE_PATH_SQL,
  addDays,
  attachIntent,
  buildDayQuery,
  buildSessionLevelsQuery,
  buildSessionPagesQuery,
  chunk,
  datesBetween,
  isValidDate,
  mergeIntent,
  mergeRows,
  parseArgs,
  todayInIndia,
  toInsertValues,
} = require("../../../scripts/heatmap-pages-rollup.cjs");

// 2026-10-30 08:00 IST is 02:30 UTC the same day.
const NOW = new Date("2026-10-30T02:30:00Z");

describe("dates", () => {
  test("todayInIndia uses the stores' timezone, not UTC", () => {
    // 2026-10-29 20:00 UTC is already 2026-10-30 01:30 in India
    expect(todayInIndia(new Date("2026-10-29T20:00:00Z"))).toBe("2026-10-30");
    expect(todayInIndia(new Date("2026-10-29T10:00:00Z"))).toBe("2026-10-29");
  });

  test("addDays and datesBetween work across month ends", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(datesBetween("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(datesBetween("2026-10-30", "2026-10-30")).toEqual(["2026-10-30"]);
  });

  test("isValidDate rejects impossible dates and other formats", () => {
    expect(isValidDate("2026-10-29")).toBe(true);
    expect(isValidDate("2026-02-30")).toBe(false);
    expect(isValidDate("29-10-2026")).toBe(false);
    expect(isValidDate("")).toBe(false);
    expect(isValidDate(undefined)).toBe(false);
  });
});

describe("parseArgs", () => {
  test("defaults to yesterday and a dry run", () => {
    expect(parseArgs(["--brand", "bbb"], NOW)).toEqual({
      brand: "BBB", from: "2026-10-29", to: "2026-10-29", write: false, readHost: "",
    });
  });

  test("reads a range, the write flag and a read host", () => {
    expect(
      parseArgs(["--brand", "BBB", "--from", "2026-10-01", "--to", "2026-10-05", "--write", "--read-host", "replica.example"], NOW),
    ).toEqual({ brand: "BBB", from: "2026-10-01", to: "2026-10-05", write: true, readHost: "replica.example" });
  });

  test("a single date serves as both ends of the range", () => {
    expect(parseArgs(["--brand", "BBB", "--from", "2026-10-01"], NOW)).toMatchObject({ from: "2026-10-01", to: "2026-10-01" });
    expect(parseArgs(["--brand", "BBB", "--to", "2026-10-02"], NOW)).toMatchObject({ from: "2026-10-02", to: "2026-10-02" });
  });

  test.each([
    [[], /--brand is required/],
    [["--brand"], /needs a value/],
    [["--brand", "BBB", "--from", "nope"], /dates like/],
    [["--brand", "BBB", "--from", "2026-10-05", "--to", "2026-10-01"], /before/],
    [["--brand", "BBB", "--from", "2024-01-01", "--to", "2026-10-01"], /At most 400/],
    [["--brand", "BBB", "--drop"], /Unknown option/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseArgs(argv, NOW)).toThrow(message);
  });
});

describe("buildDayQuery", () => {
  test("counts one day of page_viewed events, with the dates bound and never in the SQL", () => {
    const { sql, params } = buildDayQuery("2026-10-29");
    expect(params).toEqual(["2026-10-29 00:00:00", "2026-10-30 00:00:00"]);
    expect(sql).toContain("event_name = 'page_viewed'");
    expect(sql).toContain("FROM behavioral_events");
    expect(sql).toContain("GROUP BY page_path, device_type");
    expect(sql).toContain("COUNT(DISTINCT session_id)");
    expect(sql).not.toContain("2026-10");
  });

  test("the day after the last day of a month is the first of the next", () => {
    expect(buildDayQuery("2026-10-31").params).toEqual(["2026-10-31 00:00:00", "2026-11-01 00:00:00"]);
  });

  test("the only question marks are the two date parameters (a literal one would be read as a parameter slot)", () => {
    const { sql, params } = buildDayQuery("2026-10-29");
    expect((sql.match(/\?/g) || []).length).toBe(params.length);
    expect(sql).toContain("CHAR(63)");
  });

  test("the page path is cleaned in SQL the same way the API cleans it", () => {
    expect(PAGE_PATH_SQL).toContain("SUBSTRING_INDEX(SUBSTRING_INDEX(url, CHAR(63), 1), '#', 1)");
    expect(PAGE_PATH_SQL).toContain("TRIM(TRAILING '/'");
    expect(PAGE_PATH_SQL).toContain("LOWER(");
    expect(buildDayQuery("2026-10-29").sql).toContain("'tablet'");
  });
});

describe("mergeRows", () => {
  test("re-normalises paths and merges spellings of the same page on the same device", () => {
    const merged = mergeRows([
      { page_path: "/collections/all", device_type: "mobile", page_views: "10", sessions: "8" },
      { page_path: "//collections//all", device_type: "mobile", page_views: "5", sessions: "4" },
      { page_path: "/collections/all", device_type: "desktop", page_views: "7", sessions: "6" },
      { page_path: "/", device_type: "mobile", page_views: "30", sessions: "20" },
    ]);
    expect(merged).toEqual([
      { pagePath: "/", device: "mobile", views: 30, sessions: 20 },
      { pagePath: "/collections/all", device: "mobile", views: 15, sessions: 12 },
      { pagePath: "/collections/all", device: "desktop", views: 7, sessions: 6 },
    ]);
  });

  test("skips rows with no usable path and tolerates empty input", () => {
    expect(mergeRows([{ page_path: "", device_type: "mobile", page_views: "5", sessions: "5" }])).toEqual([]);
    expect(mergeRows(null)).toEqual([]);
    expect(mergeRows([])).toEqual([]);
  });

  test("ties are ordered by path then device, so the output is stable", () => {
    const merged = mergeRows([
      { page_path: "/b", device_type: "mobile", page_views: "5", sessions: "1" },
      { page_path: "/a", device_type: "mobile", page_views: "5", sessions: "1" },
      { page_path: "/a", device_type: "desktop", page_views: "5", sessions: "1" },
    ]);
    expect(merged.map((row) => `${row.pagePath}:${row.device}`)).toEqual(["/a:desktop", "/a:mobile", "/b:mobile"]);
  });
});

describe("writing", () => {
  test("rows become [date, path, device, views, sessions, high, medium, low] tuples, in chunks", () => {
    const merged = [
      { pagePath: "/", device: "mobile", views: 3, sessions: 2, high: 1, medium: 1, low: 0 },
      { pagePath: "/a", device: "desktop", views: 1, sessions: 1 },
    ];
    expect(toInsertValues("2026-10-29", merged)).toEqual([
      ["2026-10-29", "/", "mobile", 3, 2, 1, 1, 0],
      ["2026-10-29", "/a", "desktop", 1, 1, 0, 0, 0],
    ]);
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });

  test("the table is keyed by day, page and device so re-running a day replaces rows", () => {
    expect(CREATE_TABLE_SQL).toContain("CREATE TABLE IF NOT EXISTS heatmap_page_daily");
    expect(CREATE_TABLE_SQL).toContain("PRIMARY KEY (summary_date, page_path, device_type)");
    expect(CREATE_TABLE_SQL).toContain("VARCHAR(255)");
  });
});

describe("intent per page", () => {
  test("the session queries bind their dates; the level query reaches back a day for sessions that started the evening before", () => {
    const pages = buildSessionPagesQuery("2026-10-29");
    expect(pages.params).toEqual(["2026-10-29 00:00:00", "2026-10-30 00:00:00"]);
    expect(pages.sql).toContain("GROUP BY page_path, device_type, session_id");
    expect((pages.sql.match(/\?/g) || []).length).toBe(pages.params.length);

    const levels = buildSessionLevelsQuery("2026-10-29");
    expect(levels.params).toEqual(["2026-10-28 00:00:00", "2026-10-30 00:00:00"]);
    expect(levels.sql).toContain("FROM intent_sessions");
    expect(levels.sql).toContain("session_time_spent_ms IS NOT NULL");
    expect((levels.sql.match(/\?/g) || []).length).toBe(levels.params.length);
  });

  test("the level rule is the same as the one the Intent page uses", () => {
    const { _internal } = require("../../../services/intentFunnelService");
    const squash = (text) => text.replace(/\s+/g, " ").trim();
    expect(squash(BEHAVIOR_LEVEL_SQL)).toBe(squash(_internal.BEHAVIOR_LEVEL_SQL));
  });

  test("sessions are counted once per page and level; bots and unclassified sessions are left out", () => {
    const counts = mergeIntent(
      [
        { page_path: "/a", device_type: "mobile", session_id: "s1" },
        { page_path: "//a", device_type: "mobile", session_id: "s1" }, // the same page, spelled differently
        { page_path: "/a", device_type: "mobile", session_id: "s2" },
        { page_path: "/a", device_type: "mobile", session_id: "s3" },
        { page_path: "/a", device_type: "mobile", session_id: "bot1" },
        { page_path: "/a", device_type: "mobile", session_id: "open1" }, // no intent_sessions row yet
        { page_path: "/b", device_type: "desktop", session_id: "s1" },
      ],
      [
        { session_id: "s1", level: "high" },
        { session_id: "s2", level: "low" },
        { session_id: "s3", level: "low" },
        { session_id: "bot1", level: "bot" },
      ],
    );
    expect(counts.get("mobile|/a")).toEqual({ high: 1, medium: 0, low: 2 });
    expect(counts.get("desktop|/b")).toEqual({ high: 1, medium: 0, low: 0 });
    expect(mergeIntent(null, null).size).toBe(0);
  });

  test("attachIntent adds the counts to the page rows, zero when a page has none", () => {
    const merged = [
      { pagePath: "/a", device: "mobile", views: 5, sessions: 3 },
      { pagePath: "/b", device: "mobile", views: 2, sessions: 1 },
    ];
    const withIntent = attachIntent(merged, new Map([["mobile|/a", { high: 1, medium: 0, low: 2 }]]));
    expect(withIntent[0]).toMatchObject({ high: 1, medium: 0, low: 2 });
    expect(withIntent[1]).toMatchObject({ high: 0, medium: 0, low: 0 });
  });

  test("the table has the intent columns, and older tables are altered to get them", () => {
    ["high_sessions", "medium_sessions", "low_sessions"].forEach((name) => {
      expect(CREATE_TABLE_SQL).toContain(name);
      expect(ADD_INTENT_COLUMNS_SQL).toContain(`ADD COLUMN ${name} INT UNSIGNED NOT NULL DEFAULT 0`);
    });
  });
});
