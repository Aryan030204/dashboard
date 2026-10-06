const crypto = require("crypto");
const { z } = require("zod");

// Pure normalization and validation of the raw pixel payload: no I/O.

class IntentValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "IntentValidationError";
    this.status = 400;
  }
}

// The pixel supplies event_id and it is the downstream idempotency key. It is never
// generated, changed or defaulted here: missing, null, blank or over-long ids are
// rejected. 100 is the intent worker's VARCHAR(100) limit for ids.
const MAX_ID_LENGTH = 100;
const EventIdSchema = z
  .string()
  .max(MAX_ID_LENGTH)
  .refine((v) => v.trim() !== "", { message: "event_id must not be blank" });

const EventSchema = z.object({
  event_id: EventIdSchema,
  event_name: z.string().min(1),
  occurred_at: z.string(),
  session_id: z.string().nullable().optional(),
  actor_id: z.string().nullable().optional(),
  client_id: z.string().nullable(),
  visitor_id: z.string().nullable(),
  url: z.string().url().nullable(),
  referrer: z.string().nullable(),
  user_agent: z.string().nullable(),
  data: z.any().optional(),
  slug_info: z.any().optional(),
});

const ClickDataSchema = z.object({
  x: z.number().nullable().default(null),
  y: z.number().nullable().default(null),
  tag_name: z.string().nullable().default(null),
  element_id: z.string().nullable().default(null),
  element_name: z.string().nullable().default(null),
  element_type: z.string().nullable().default(null),
  element_value: z.string().nullable().default(null),
  href: z.string().nullable().default(null),
});

const ClickSignalsSchema = z.object({
  url_changed: z.boolean(),
  cart_changed: z.boolean(),
  ui_changed: z.boolean(),
  meaningful_scroll: z.boolean(),
});

const ClickEventSchema = z.object({
  event_id: EventIdSchema,
  event_name: z.literal("click"),
  occurred_at: z.string(),
  client_id: z.string().nullable(),
  visitor_id: z.string().nullable(),
  session_id: z.string().nullable(),
  actor_id: z.string().nullable().optional(),
  url: z.string().url().nullable(),
  referrer: z.string().nullable(),
  user_agent: z.string().nullable(),
  data: z.object({
    click: ClickDataSchema,
    signals: ClickSignalsSchema,
  }),
});

const safe = (v) => (v === undefined ? null : v);

function parseShopifySlug(url) {
  if (!url) return null;
  try {
    const u = new URL(url, "http://x");
    const p = u.pathname || "";
    const prod = p.match(/\/products\/([a-zA-Z0-9\-_.]+)/);
    if (prod) return { type: "product", slug: prod[1] };
    const coll = p.match(/\/collections\/([a-zA-Z0-9\-_.]+)/);
    if (coll) return { type: "collection", slug: coll[1] };
    const handle = u.searchParams.get("handle");
    if (handle) return { type: "product", slug: handle };
    return null;
  } catch {
    return null;
  }
}

// Shopify gid → "ProductVariant:123"
function normalizeShopifyId(id) {
  if (!id) return null;
  const s = String(id);
  if (s.includes("/")) {
    const parts = s.split("/");
    return `${parts.at(-2)}:${parts.at(-1)}`;
  }
  return s;
}

const isFallbackId = (id) => typeof id === "string" && id.startsWith("FALLBACK:");

// Deterministic product id when none was resolved. Seeded with the
// server-generated session id, so it must be called after session timing.
function synthPid(brand, sessionId, e) {
  const src = `${brand}|${sessionId || "nosid"}|${e.event_id}|${e.url || ""}`;
  return "SYNTH:" + crypto.createHash("sha1").update(src).digest("hex").slice(0, 16);
}

// A click is "useful" if it produced any observable effect
function classifyClick(signals) {
  const s = signals || {};
  const useful = !!(s.url_changed || s.cart_changed || s.ui_changed || s.meaningful_scroll);
  return useful ? "useful_click" : "dead_click";
}

// Validates and normalizes a raw intent payload. Throws IntentValidationError
// (status 400) for any invalid input, matching the Sessions Pipeline, where
// every validation failure returned 400.
function normalizeIntentBody(body) {
  const payload = body || {};
  try {
    if (payload.event_name === "click") {
      const e = ClickEventSchema.parse(payload);
      const when = new Date(e.occurred_at);
      if (isNaN(when.getTime())) throw new IntentValidationError("invalid occurred_at");
      return { kind: "click", e, when, actorId: e.actor_id || e.client_id || null };
    }

    const normalized = {
      ...payload,
      client_id: safe(payload.client_id),
      visitor_id: safe(payload.visitor_id),
      session_id: payload.session_id ?? null,
      actor_id: safe(payload.actor_id),
      url: safe(payload.url),
      referrer: safe(payload.referrer),
      user_agent: safe(payload.user_agent),
    };
    normalized.slug_info = parseShopifySlug(payload.url);

    const e = EventSchema.parse(normalized);
    const when = new Date(e.occurred_at);
    if (isNaN(when.getTime())) throw new IntentValidationError("invalid occurred_at");
    return { kind: "event", e, when, actorId: e.actor_id || e.client_id || null };
  } catch (err) {
    if (err instanceof IntentValidationError) throw err;
    throw new IntentValidationError(err.message);
  }
}

module.exports = {
  IntentValidationError,
  EventSchema,
  ClickEventSchema,
  normalizeIntentBody,
  parseShopifySlug,
  normalizeShopifyId,
  isFallbackId,
  synthPid,
  classifyClick,
};
