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
  // sent by the Click Signal V2 pixel next to the viewport coordinates
  page_x: z.number().nullable().default(null),
  page_y: z.number().nullable().default(null),
});

// The four booleans stay required, as before. `response_signals` is accepted in any shape (missing, null, empty,
// a list with odd entries): classifyClickSignals() below cleans it, so a bad entry never rejects a click.
// `useful_click` and `dead_click` sent by the pixel are not declared here on purpose: zod drops them, the
// classification is always recomputed on the server.
const ClickSignalsSchema = z.object({
  url_changed: z.boolean(),
  cart_changed: z.boolean(),
  ui_changed: z.boolean(),
  meaningful_scroll: z.boolean(),
  response_signals: z.unknown().optional(),
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

// ---- click classification: ONE place -----------------------------------------------------------------------
// A click is "useful" if it produced any observable effect:
//   url_changed OR cart_changed OR ui_changed OR meaningful_scroll OR at least one response signal.
// Dead is the opposite. This is the only place that decides it: the Kafka message carries the result as
// `click_bucket`, and the intent pipeline only counts that bucket. The pixel's own useful_click / dead_click are
// never trusted. The pixel owns the 3 s response window; nothing here waits for later events.

const MAX_RESPONSE_SIGNALS = 30;
const MAX_RESPONSE_EVENT_NAME = 64;

// event name -> category. Unknown names are still a response (category "other").
const RESPONSE_CATEGORY_BY_EVENT = Object.freeze({
  page_viewed: "navigation",
  product_viewed: "product",
  product_added_to_cart: "cart",
  product_removed_from_cart: "cart",
  cart_viewed: "cart",
  collection_viewed: "collection",
  search_submitted: "search",
  checkout_started: "checkout",
  checkout_contact_info_submitted: "checkout",
  checkout_address_info_submitted: "checkout",
  checkout_shipping_info_submitted: "checkout",
  payment_info_submitted: "checkout",
  checkout_completed: "checkout",
  Started_Checkout_GK: "checkout",
  input_focused: "form",
  input_changed: "form",
  form_submitted: "form",
  alert_displayed: "alert",
  scroll_depth: "scroll",
});
const RESPONSE_CATEGORY_BY_LOWER_EVENT = Object.freeze(
  Object.fromEntries(Object.entries(RESPONSE_CATEGORY_BY_EVENT).map(([name, category]) => [name.toLowerCase(), category])),
);

function responseCategory(eventName) {
  return RESPONSE_CATEGORY_BY_EVENT[eventName] || RESPONSE_CATEGORY_BY_LOWER_EVENT[eventName.toLowerCase()] || "other";
}

function isIsoTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

// Keeps the entries that are objects with a non-empty string event_name, one per event name (the first), at most
// MAX_RESPONSE_SIGNALS. The category is derived from the name, not taken from the pixel.
function normalizeResponseSignals(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const name = typeof entry.event_name === "string" ? entry.event_name.trim().slice(0, MAX_RESPONSE_EVENT_NAME) : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      event_name: name,
      category: responseCategory(name),
      occurred_at: isIsoTimestamp(entry.occurred_at) ? entry.occurred_at : null,
    });
    if (out.length >= MAX_RESPONSE_SIGNALS) break;
  }
  return out;
}

// contract_version: 2 when the pixel sent a response_signals list (even an empty one), 1 when it sent none (older
// pixel). Only used by the diagnostics to tell the two apart; it does not change the classification.
function classifyClickSignals(signals) {
  const s = signals || {};
  const responseSignals = normalizeResponseSignals(s.response_signals);
  const responseCategories = [...new Set(responseSignals.map((r) => r.category))];
  const url_changed = s.url_changed === true;
  const cart_changed = s.cart_changed === true;
  const ui_changed = s.ui_changed === true;
  const meaningful_scroll = s.meaningful_scroll === true;
  const useful_click = url_changed || cart_changed || ui_changed || meaningful_scroll || responseSignals.length > 0;
  return {
    url_changed,
    cart_changed,
    ui_changed,
    meaningful_scroll,
    response_signals: responseSignals,
    response_categories: responseCategories,
    useful_click,
    dead_click: !useful_click,
    contract_version: Array.isArray(s.response_signals) ? 2 : 1,
  };
}

// The bucket name the Kafka message and the pipeline use.
function classifyClick(signals) {
  return classifyClickSignals(signals).useful_click ? "useful_click" : "dead_click";
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
  classifyClickSignals,
  normalizeResponseSignals,
  RESPONSE_CATEGORY_BY_EVENT,
};
