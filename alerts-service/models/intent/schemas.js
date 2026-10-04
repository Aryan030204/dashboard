const mongoose = require("mongoose");

// Schemas for the intent_sessions database. Ported from the Sessions Pipeline
// with identical field names, types, collection names and indexes.
// TTL indexes are intentionally NOT declared here (managed manually), and
// syncIndexes() is never called on these models, so manual TTL indexes survive.

const eventSchema = new mongoose.Schema(
  {
    brand_id: { type: String, required: true, index: true },
    event_id: { type: String, required: true },
    session_id: { type: String, index: true },
    actor_id: { type: String, default: null, index: true },
    event_name: { type: String, required: true, index: true },
    occurred_at: { type: Date, required: true },
    url: { type: String },
    referrer: { type: String },
    user_agent: { type: String },
    client_id: { type: String, index: true },
    visitor_id: { type: String, index: true },
    session_start: { type: Date, default: null },
    session_end: { type: Date, default: null },
    session_time_spent: { type: Number, default: null }, // milliseconds
    raw: { type: mongoose.Schema.Types.Mixed },
  },
  { versionKey: false, collection: "events", timestamps: true },
);

eventSchema.index({ session_id: 1, occurred_at: 1 });
eventSchema.index(
  { event_id: 1 },
  { unique: true, partialFilterExpression: { event_id: { $type: "string" } } },
);
eventSchema.index(
  { brand_id: 1, session_id: 1, event_name: 1, "raw.product_id": 1 },
  {
    unique: true,
    partialFilterExpression: {
      event_name: "product_added_to_cart",
      session_id: { $type: "string" },
      "raw.product_id": { $type: "string" },
    },
  },
);
eventSchema.index({ brand_id: 1, event_name: 1, occurred_at: 1 });
eventSchema.index({ brand_id: 1, session_id: 1, occurred_at: 1 });
eventSchema.index({ brand_id: 1, actor_id: 1, occurred_at: 1 });

const clickSchema = new mongoose.Schema(
  {
    x: { type: Number, default: null },
    y: { type: Number, default: null },
    tag_name: { type: String, default: null },
    element_id: { type: String, default: null },
    element_name: { type: String, default: null },
    element_type: { type: String, default: null },
    element_value: { type: String, default: null },
    href: { type: String, default: null },
  },
  { _id: false },
);

const signalsSchema = new mongoose.Schema(
  {
    url_changed: { type: Boolean, required: true, default: false },
    cart_changed: { type: Boolean, required: true, default: false },
    ui_changed: { type: Boolean, required: true, default: false },
    meaningful_scroll: { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

const clickEventSchema = new mongoose.Schema(
  {
    brand_id: { type: String, required: true, index: true },
    event_id: { type: String, required: true },
    event_name: { type: String, required: true, default: "click" },

    occurred_at: { type: Date, required: true },
    ingested_at: { type: Date, required: true, default: Date.now },

    client_id: { type: String, default: null, index: true },
    visitor_id: { type: String, default: null, index: true },
    session_id: { type: String, default: null, index: true },
    actor_id: { type: String, default: null, index: true },

    url: { type: String, default: null },
    referrer: { type: String, default: null },
    user_agent: { type: String, default: null },

    click: { type: clickSchema, required: true },
    signals: { type: signalsSchema, required: true },

    click_bucket: {
      type: String,
      required: true,
      enum: ["useful_click", "dead_click"],
      index: true,
    },

    session_start: { type: Date, default: null },
    session_end: { type: Date, default: null },
    session_time_spent: { type: Number, default: null }, // milliseconds

    raw: { type: mongoose.Schema.Types.Mixed },
  },
  { versionKey: false, collection: "click_events", timestamps: true },
);

clickEventSchema.index(
  { event_id: 1 },
  { unique: true, partialFilterExpression: { event_id: { $type: "string" } } },
);
clickEventSchema.index({ brand_id: 1, occurred_at: 1 });
clickEventSchema.index({ session_id: 1, occurred_at: 1 });
clickEventSchema.index({ client_id: 1, occurred_at: 1 });
clickEventSchema.index({ brand_id: 1, actor_id: 1, occurred_at: 1 });
clickEventSchema.index({ click_bucket: 1, occurred_at: 1 });

const actorCursorSchema = new mongoose.Schema(
  {
    brand_id: { type: String, required: true },
    actor_id: { type: String, required: true },
    session_id: { type: String, required: true, index: true },
    session_start: { type: Date, required: true },
    last_event_at: { type: Date, required: true },
    last_ref: {
      collection: { type: String, required: true, enum: ["events", "click_events"] },
      event_id: { type: String, required: true },
    },
    events_seq: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { versionKey: false, collection: "actor_cursors", timestamps: true },
);

actorCursorSchema.index({ brand_id: 1, actor_id: 1 }, { unique: true });

const sessionHistorySchema = new mongoose.Schema(
  {
    brand_id: { type: String, required: true, index: true },
    actor_id: { type: String, required: true, index: true },
    session_id: { type: String, required: true, index: true },
    session_start: { type: Date, required: true },
    session_end: { type: Date, required: true },
    session_time_spent: { type: Number, required: true }, // milliseconds
    occurred_at: { type: Date, required: true },
    events_seq: { type: mongoose.Schema.Types.Mixed, default: {} },
    last_ref: {
      collection: { type: String, required: true, enum: ["events", "click_events"] },
      event_id: { type: String, required: true },
    },
  },
  { versionKey: false, collection: "session_history", timestamps: true },
);

sessionHistorySchema.index({ brand_id: 1, actor_id: 1, session_start: -1 });

// Read-only in this service: populated by the external slug-resolution worker.
const slugCacheSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // <brand>:<type>:<slug>
    brand: { type: String, required: true, index: true },
    type: { type: String, required: true, enum: ["product", "collection"], index: true },
    slug: { type: String, required: true, index: true },
    shopify_id: { type: String, default: null },
    resolved_at: { type: Date, default: null },
  },
  { versionKey: false, collection: "slug_cache" },
);

slugCacheSchema.index({ brand: 1, type: 1, slug: 1 }, { unique: true });

module.exports = {
  eventSchema,
  clickEventSchema,
  actorCursorSchema,
  sessionHistorySchema,
  slugCacheSchema,
};
