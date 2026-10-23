const crypto = require("crypto");
const { getConfig } = require("../src/config");
const { buildApp } = require("../src/app");
const { httpError } = require("../src/errors");
const { ACTIONS } = require("../src/services/audit");
const { uniqueTitle } = require("../src/services/uniqueTitle");

const SECRET = "test-gateway-secret";

function baseConfig(extra = {}) {
  return { ...getConfig({ GATEWAY_SHARED_SECRET: SECRET, WEEKLY_REPORTS_BUCKET: "test" }), ...extra };
}

// Builds the headers the real gateway would inject, including the HMAC signature.
function gatewayHeaders({ userId = "u1", brand = "BBB", role = "viewer", permissions = [], email = "user@example.com", ts, sig, secret = SECRET } = {}) {
  const stamp = String(ts || Math.floor(Date.now() / 1000));
  const signature =
    sig || crypto.createHmac("sha256", secret).update([userId, brand, role, stamp].join("|")).digest("hex");
  return {
    "x-user-id": userId,
    "x-brand-id": brand,
    "x-role": role,
    "x-email": email,
    "x-permissions": permissions.join(","),
    "x-gw-ts": stamp,
    "x-gw-sig": signature,
  };
}

const client = (brand = "BBB", extra = {}) => gatewayHeaders({ brand, role: "viewer", permissions: ["weekly_report_preview"], ...extra });
const author = (brand = "BBB", extra = {}) => gatewayHeaders({ brand, role: "author", userId: "author1", email: "author@datum.test", ...extra });

// In-memory stand-in for reportsRepo with the same contract (same method names, same brand
// predicates, same state rules). The real SQL is exercised in repo.mysql.test.js.
function fakeRepo() {
  const reports = [];
  const slides = [];
  let seq = 0;
  const live = (r) => r && !r.deleted_at;
  const repo = {
    _reports: reports,
    async createReport({ brandKey, title, reportingWeek, sourceType, uploadedBy }) {
      const taken = (t) => reports.some((r) => r.brand_key === brandKey && live(r) && r.title.toLowerCase() === t.toLowerCase());
      const requested = title;
      title = await uniqueTitle(async (t) => taken(t), requested);
      const same = reports.filter((r) => r.brand_key === brandKey && r.reporting_week === reportingWeek);
      const version = same.reduce((m, r) => Math.max(m, r.version), 0) + 1;
      const row = {
        id: ++seq, brand_key: brandKey, title, reporting_week: reportingWeek, version, source_type: sourceType,
        source_storage_key: "", source_size_bytes: null, status: "PROCESSING", stage: null, slide_count: null,
        slides_total: null, slides_done: null, error_code: null,
        error_detail: null, locked_at: new Date(), uploaded_by: uploadedBy, published_by: null,
        uploaded_at: new Date(), published_at: null, created_at: new Date(), updated_at: new Date(), deleted_at: null,
        storage_purged_at: null,
      };
      reports.push(row);
      return { id: row.id, version, title };
    },
    async releaseForProcessing(id, brandKey, { sourceKey, sizeBytes }) {
      const r = reports.find((x) => x.id === id && x.brand_key === brandKey);
      Object.assign(r, { source_storage_key: sourceKey, source_size_bytes: sizeBytes, locked_at: null, stage: "QUEUED", slides_done: 0 });
    },
    async markFailed(id, code, detail) {
      const r = reports.find((x) => x.id === id && x.status === "PROCESSING");
      if (r) Object.assign(r, { status: "FAILED", error_code: code, error_detail: detail });
    },
    async findById(id) {
      const r = reports.find((x) => x.id === id);
      return live(r) ? { ...r } : null;
    },
    async findDuplicates(brandKey, { title, reportingWeek }) {
      const taken = (t) => reports.some((r) => r.brand_key === brandKey && live(r) && r.title.toLowerCase() === t.toLowerCase());
      const titleExists = taken(title);
      const suggestedTitle = titleExists ? await uniqueTitle(async (t) => taken(t), title) : title;
      const weekCount = reports.filter((r) => r.brand_key === brandKey && live(r) && r.reporting_week.toLowerCase() === reportingWeek.toLowerCase()).length;
      return { titleExists, suggestedTitle, weekCount };
    },
    async listByBrand(brandKey, { publishedOnly = false } = {}) {
      let rows = reports.filter((r) => r.brand_key === brandKey && live(r));
      if (publishedOnly) {
        rows = rows.filter((r) => r.status === "PUBLISHED");
        rows.sort((a, b) => b.published_at - a.published_at || b.id - a.id);
        return rows.map((r) => ({ ...r }));
      }
      return rows.map((r) => ({ ...r })).reverse();
    },
    async getSlide(reportId, n) {
      return slides.find((s) => s.report_id === reportId && s.slide_number === n) || null;
    },
    async publish(id, brandKey, userId) {
      const r = reports.find((x) => x.id === id && x.brand_key === brandKey && live(x));
      if (!r) throw httpError(404, "NOT_FOUND", "Report not found.");
      if (!["READY", "UNPUBLISHED"].includes(r.status)) throw httpError(409, "INVALID_STATE", `A ${r.status} report cannot be published.`);
      Object.assign(r, { status: "PUBLISHED", published_at: new Date(Date.now() + seq), published_by: userId });
    },
    async unpublish(id, brandKey) {
      const r = reports.find((x) => x.id === id && x.brand_key === brandKey && x.status === "PUBLISHED" && live(x));
      if (!r) throw httpError(409, "INVALID_STATE", "Only a published report can be unpublished.");
      r.status = "UNPUBLISHED";
    },
    async setProgress(id, { stage, slidesTotal = null, slidesDone = null }) {
      const r = reports.find((x) => x.id === id && x.status === "PROCESSING");
      if (r) Object.assign(r, { stage, slides_total: slidesTotal, slides_done: slidesDone });
    },
    async softDelete(id, brandKey) {
      const r = reports.find((x) => x.id === id && x.brand_key === brandKey && live(x) && ["READY", "UNPUBLISHED", "FAILED"].includes(x.status));
      if (!r) throw httpError(409, "INVALID_STATE", "Unpublish the report before deleting it. A report that is processing cannot be deleted.");
      r.deleted_at = new Date();
    },
    async cancel(id, brandKey) {
      const r = reports.find((x) => x.id === id && x.brand_key === brandKey && live(x));
      if (!r) throw httpError(404, "NOT_FOUND", "Report not found.");
      if (r.status !== "PROCESSING") throw httpError(409, "INVALID_STATE", "Only a report that is still processing can be cancelled.");
      r.deleted_at = new Date();
      return { purgeNow: r.locked_at === null };
    },
    async markPurged(id) {
      reports.find((x) => x.id === id).storage_purged_at = new Date();
    },
    async claimPurgeBatch(limit = 5) {
      return reports
        .filter((r) => r.deleted_at && !r.storage_purged_at && r.locked_at === null)
        .slice(0, limit)
        .map((r) => ({ id: r.id, brandKey: r.brand_key }));
    },
    async releaseLock(id) {
      const r = reports.find((x) => x.id === id);
      if (r) { r.locked_at = null; r.locked_by = null; }
    },
    async isDeleted(id) {
      const r = reports.find((x) => x.id === id);
      return !r || r.deleted_at !== null;
    },
    // test helpers
    seed({ brand = "BBB", week = "Week 42", status = "READY", slideCount = 3, title = "Weekly Review", version } = {}) {
      const same = reports.filter((r) => r.brand_key === brand && r.reporting_week === week);
      const row = {
        id: ++seq, brand_key: brand, title, reporting_week: week, version: version || same.length + 1, source_type: "pptx",
        source_storage_key: `${brand}/${seq}/source/presentation.pptx`, source_size_bytes: 1000, status, stage: null,
        slide_count: slideCount, slides_total: slideCount, slides_done: slideCount, error_code: null, error_detail: null, locked_at: null, uploaded_by: "author1", published_by: null,
        uploaded_at: new Date(), published_at: status === "PUBLISHED" ? new Date(Date.now() + seq) : null,
        created_at: new Date(), updated_at: new Date(), deleted_at: null, storage_purged_at: null,
      };
      reports.push(row);
      for (let n = 1; n <= slideCount; n += 1) {
        slides.push({ report_id: row.id, slide_number: n, image_storage_key: `${brand}/${row.id}/slides/${n}.webp`, thumbnail_storage_key: `${brand}/${row.id}/thumbnails/${n}.webp` });
      }
      return row;
    },
  };
  return repo;
}

function fakeStorage({ failPut = false, failRemove = false } = {}) {
  const objects = new Map();
  const state = { failRemove, removedPrefixes: [] };
  return {
    objects,
    state,
    reportPrefix: (brand, id) => `${brand}/${id}/`,
    async removePrefix(prefix) {
      if (state.failRemove) throw new Error("s3 delete failed");
      state.removedPrefixes.push(prefix);
      for (const key of [...objects.keys()]) if (key.startsWith(prefix)) objects.delete(key);
    },
    sourceKey: (brand, id, ext) => `${brand}/${id}/source/presentation.${ext}`,
    async putFile(key) {
      if (failPut) throw new Error("s3 down");
      objects.set(key, Buffer.from("src"));
    },
    async getBuffer(key) {
      if (key.includes("missing")) {
        const e = new Error("nope");
        e.name = "NoSuchKey";
        throw e;
      }
      return Buffer.from(`image:${key}`);
    },
  };
}

function fakeAudit() {
  const events = [];
  return { ACTIONS, events, async record(e) { events.push(e); } };
}

function makeApp(opts = {}) {
  const repo = opts.repo || fakeRepo();
  const storage = opts.storage || fakeStorage();
  const audit = opts.audit || fakeAudit();
  const config = baseConfig(opts.config || {});
  const app = buildApp({ config, repo, storage, audit, sessions: opts.sessions });
  return { app, repo, storage, audit, config };
}

// ---- minimal ZIP writer (stored, no compression) so tests can build .pptx files without a zip lib
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const CT_PLAIN = '<?xml version="1.0"?><Types><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>';
const CT_MACRO = '<?xml version="1.0"?><Types><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml"/></Types>';
const validPptx = () => makeZip({ "[Content_Types].xml": CT_PLAIN, "ppt/presentation.xml": "<p/>", "ppt/slides/slide1.xml": "<s/>" });
const macroPptx = () => makeZip({ "[Content_Types].xml": CT_MACRO, "ppt/presentation.xml": "<p/>", "ppt/vbaProject.bin": "x" });
const notAPresentationZip = () => makeZip({ "hello.txt": "hi" });

module.exports = {
  SECRET, baseConfig, gatewayHeaders, client, author, fakeRepo, fakeStorage, fakeAudit, makeApp,
  makeZip, validPptx, macroPptx, notAPresentationZip,
};
