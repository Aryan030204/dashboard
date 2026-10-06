require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const mongoose = require("mongoose");

const logger = require("./utils/logger");
const {
  initObservability,
  sentryErrorMiddleware,
  captureError,
  recordInventoryCacheRefreshSuccess,
  recordInventoryCacheRefreshFailure,
  recordInventoryEventIngest,
  recordMongoConnectionError,
} = require("./observability");
const { getBrands } = require("./config/brands");
const { buildAlertsRouter } = require("./routes/alerts");
const { requireAuthor } = require("./middlewares/auth");
const { getNextSeq } = require("./utils/counters");
const {
  buildAlertConfigEventPublisher,
} = require("./services/alertConfigEventPublisher");
const Alert = require("./models/alert");
const AlertChannel = require("./models/alertChannel");
const BrandAlertChannel = require("./models/brandAlertChannel");
const OtpVerified = require("./models/otpVerified");
const AjrsPurchase = require("./models/ajrsPurchase");
const ItemQtyPush = require("./models/itemQtyPush");
const { sendToAll } = require("./utils/fcm");
const PipelineCreds = require("./models/pipelineCreds");
const { getPool } = require("./utils/db");
const {
  collectRoutes,
  createHealthMonitorReporter,
  registerWithHealthMonitor,
} = require("./healthMonitor");


const app = express();
app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
initObservability(app);
app.use(createHealthMonitorReporter({
  serviceName: "alerts-service",
  baseUrl: "http://alerts-service:5005",
  logger,
}));

// --- Mongo Connection --------------------------------------------------------
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017";
const MONGO_DB = process.env.MONGO_DB || "alerts";

mongoose.set("strictQuery", true);

// ---- Routes -----------------------------------------------------------------
const alertConfigEventPublisher = buildAlertConfigEventPublisher();
const alertsRouter = buildAlertsRouter({
  Alert,
  AlertChannel,
  BrandAlertChannel,
  getNextSeq,
  alertConfigEventPublisher,
});

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/health/monitor", (_req, res) =>
  res.json({ ok: true, service: "alerts-service", message: "probe_ok" }));

const redis = require("./utils/redis");

const INVENTORY_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const INVENTORY_EVENT_CACHE_TTL_SECONDS = 30 * 60;
const INVENTORY_CACHE_REFRESH_MS = 30 * 60 * 1000;

function toIstParts(dateValue) {
  const date = dateValue ? new Date(dateValue) : new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    time: `${map.hour}:${map.minute}:${map.second}`,
  };
}

function buildInventoryCachePayload(row) {
  const updatedParts = toIstParts(row.updated_at);
  const numericProductId = row.product_id != null ? String(row.product_id) : "";
  const numericVariantId = row.variant_id != null ? String(row.variant_id) : "";

  return {
    sold7: Number(row.sold_units_7d || 0),
    sold30: Number(row.sold_units_30d || 0),
    sold90: Number(row.sold_units_90d || 0),
    drr7: Number(row.drr_7d || 0),
    drr30: Number(row.drr_30d || 0),
    drr90: Number(row.drr_90d || 0),
    doh7: Number(row.doh_7d || 0),
    doh30: Number(row.doh_30d || 0),
    doh90: Number(row.doh_90d || 0),
    liveQty: Number(row.inventory_available || 0),
    productId: numericProductId ? `gid://shopify/Product/${numericProductId}` : null,
    productTitle: row.product_title || "",
    sku: row.sku || "",
    variantId: numericVariantId ? `gid://shopify/ProductVariant/${numericVariantId}` : null,
    updatedAt: `${updatedParts.date} ${updatedParts.time}`,
    date: updatedParts.date,
  };
}

function requirePipelineKey(req, res, next) {
  const pipelineKey = req.headers["x-pipeline-key"];
  const expectedKey = process.env.X_PIPELINE_KEY;

  if (!expectedKey || pipelineKey !== expectedKey) {
    return res.status(401).json({ error: "unauthorized_pipeline_key" });
  }

  return next();
}

function normalizeBrandScope(shopDomain) {
  return String(shopDomain || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-");
}

async function refreshInventoryCacheForBrand(credsDoc) {
  const dbPassword = PipelineCreds.decrypt(credsDoc.db_password);
  const pool = getPool({
    host: credsDoc.db_host,
    port: credsDoc.port,
    user: credsDoc.db_user,
    password: dbPassword,
    database: credsDoc.db_database
  });

  const [rows] = await pool.query(
    `
      SELECT
        product_id,
        product_title,
        variant_id,
        sku,
        sold_units_7d,
        sold_units_30d,
        sold_units_90d,
        drr_7d,
        drr_30d,
        drr_90d,
        doh_7d,
        doh_30d,
        doh_90d,
        inventory_available,
        updated_at
      FROM top_products_inventory
      WHERE variant_id IS NOT NULL
    `,
  );

  let cachedCount = 0;
  for (const row of rows) {
    const variantId = row.variant_id != null ? String(row.variant_id) : "";
    if (!variantId) continue;

    const cacheKey = `inventory:cache:${credsDoc.shop_name}:${variantId}`;
    const payload = buildInventoryCachePayload(row);
    await redis.set(cacheKey, JSON.stringify(payload), "EX", INVENTORY_CACHE_TTL_SECONDS);
    cachedCount += 1;
  }

  logger.info(`[inventory-cache] Refreshed ${cachedCount} cache entries for ${credsDoc.shop_name}`);
}

async function refreshInventoryCacheForAllBrands() {
  const archAuthDb = mongoose.connection.useDb("arch-auth", { useCache: true });
  const creds = await archAuthDb
    .model("PipelineCreds", PipelineCreds.schema)
    .find({})
    .lean();

  for (const credsDoc of creds) {
    try {
      await refreshInventoryCacheForBrand(credsDoc);
      recordInventoryCacheRefreshSuccess(credsDoc.shop_name);
    } catch (err) {
      recordInventoryCacheRefreshFailure(credsDoc.shop_name);
      captureError(err, null, {
        type: "inventory_cache_refresh",
        brand: credsDoc.shop_name,
      });
      logger.error(`[inventory-cache] Failed to refresh cache for ${credsDoc.shop_name}: ${err.message}`);
    }
  }
}

let inventoryCacheRefreshInFlight = false;

async function runInventoryCacheRefresh() {
  if (inventoryCacheRefreshInFlight) {
    logger.info("[inventory-cache] Refresh already running, skipping this schedule tick");
    return;
  }

  inventoryCacheRefreshInFlight = true;
  try {
    logger.info("[inventory-cache] Refresh started");
    await refreshInventoryCacheForAllBrands();
    logger.info("[inventory-cache] Refresh completed");
  } catch (err) {
    captureError(err, null, { type: "inventory_cache_refresh_global" });
    logger.error("[inventory-cache] Refresh failed:", err);
  } finally {
    inventoryCacheRefreshInFlight = false;
  }
}

app.use(
  "/alerts",
  requireAuthor,
  alertsRouter,
);
const Session = require("./models/session");

app.post("/inventory", requirePipelineKey, async (req, res) => {
  try {
    const payload = req.body || {};
    const requiredFields = [
      "shop_domain",
      "product_id",
      "product_title",
      "variant_id",
      "variant_title",
      "sku",
      "inventory_quantity",
    ];

    const missingFields = requiredFields.filter((field) => {
      const value = payload[field];
      return value == null || String(value).trim() === "";
    });

    if (missingFields.length > 0) {
      return res.status(400).json({
        error: "missing_required_fields",
        fields: missingFields,
      });
    }

    const cachePayload = {
      ...payload,
      inventory_changed: true,
    };
    const brandScope = normalizeBrandScope(payload.shop_domain);
    const productScope = String(payload.product_id).trim();
    const cacheKey = `product_inventory:${brandScope}`;
    const cacheType = await redis.type(cacheKey);

    if (cacheType === "string") {
      const existingValue = await redis.get(cacheKey);

      if (existingValue) {
        try {
          const parsed = JSON.parse(existingValue);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const entries = Object.entries(parsed).map(([productId, eventPayload]) => [
              productId,
              JSON.stringify(eventPayload),
            ]);

            if (entries.length > 0) {
              await redis.del(cacheKey);
              await redis.hset(cacheKey, ...entries.flat());
            } else {
              await redis.del(cacheKey);
            }
          } else {
            await redis.del(cacheKey);
          }
        } catch (parseError) {
          logger.warn(
            `[inventory] Failed to migrate existing cache for ${cacheKey}, resetting bucket`,
            parseError,
          );
          await redis.del(cacheKey);
        }
      }
    } else if (cacheType !== "none" && cacheType !== "hash") {
      await redis.del(cacheKey);
    }

    await redis.hset(cacheKey, productScope, JSON.stringify(cachePayload));
    await redis.expire(cacheKey, INVENTORY_EVENT_CACHE_TTL_SECONDS);
    recordInventoryEventIngest("success");

    return res.status(202).json({
      ok: true,
      cacheKey,
      productId: productScope,
      ttlSeconds: INVENTORY_EVENT_CACHE_TTL_SECONDS,
    });
  } catch (err) {
    recordInventoryEventIngest("error");
    captureError(err, req, { type: "inventory_event_ingest" });
    logger.error("[inventory] Failed to cache inventory event:", err);
    return res.status(500).json({ error: "failed_to_cache_inventory_event" });
  }
});

app.post("/track", async (req, res) => {
  try {
    const sessionData = req.body;
    const isRSEvent = sessionData.tags === "RS_Cinema_KP" || sessionData.orderId;

    // Check for idempotency key to prevent duplicates (bypass for custom RS events)
    if (!sessionData.idempotency_key && !isRSEvent) {
      return res.status(400).json({ error: "idempotency_key is required" });
    }

    let existingSession = null;
    if (sessionData.idempotency_key) {
      existingSession = await Session.findOne({
        idempotency_key: sessionData.idempotency_key,
      });
    }

    if (existingSession) {
      return res
        .status(200)
        .json({ message: "Event already processed", session: existingSession });
    }

    // ---- RS Specific Event Handling ----
    if (isRSEvent) {
      if (sessionData.tags === "RS_Cinema_KP" && sessionData.customer_id) {
        const exists = await OtpVerified.findOne({ customer_id: sessionData.customer_id });
        if (!exists) {
          const otpVerify = new OtpVerified({ customer_id: sessionData.customer_id });
          await otpVerify.save();
          logger.info(`[track] OTP Verified saved for customer: ${sessionData.customer_id}`);
        }
      }

      if (sessionData.orderId) {
        const exists = await AjrsPurchase.findOne({ order_id: sessionData.orderId });
        if (!exists) {
          const purchase = new AjrsPurchase({ order_id: sessionData.orderId });
          await purchase.save();
          logger.info(`[track] AJRS Purchase saved for order: ${sessionData.orderId}`);
        }
      }

      return res.status(201).json({ message: "Session tracked successfully" });
    }

    // Save new session document
    const session = new Session(sessionData);
    await session.save();

  } catch (err) {

    logger.error("Error tracking session:", err);
    res.status(500).json({ error: "Failed to track alert" });
  }
});

// Fully public — no auth, no gateway trust headers, no nginx-level gating.
// Returns a count of session events matching { event, shop } from either the
// request body or query string, e.g. { shop: "tmc", event: "add_to_cart" }.
app.get("/events", async (req, res) => {
  try {
    const shop = (req.body?.shop || req.query?.shop || "").toString().trim();
    const event = (req.body?.event || req.query?.event || "").toString().trim();
    const date = (req.body?.date || req.query?.date || "").toString().trim();

    if (!shop || !event) {
      return res.status(400).json({ error: "shop and event are required" });
    }

    const filter = {
      event_type: event,
      shop_name: shop,
    };

    if (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: "date must be in yyyy-mm-dd format" });
      }
      const dayStart = new Date(`${date}T00:00:00.000Z`);
      if (Number.isNaN(dayStart.getTime())) {
        return res.status(400).json({ error: "date must be in yyyy-mm-dd format" });
      }
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
      filter.createdAt = { $gte: dayStart, $lt: dayEnd };
    }

    const count = await Session.countDocuments(filter);

    return res.status(200).json({ count });
  } catch (err) {
    logger.error("Error counting events:", err);
    return res.status(500).json({ error: "Failed to count events" });
  }
});

app.post("/push/receive", async (req, res) => {
  try {
    logger.info("[push/receive] Received push notification:", req.body);
    if (
      !req.headers["x-push-token"] ||
      req.headers["x-push-token"] !== process.env.PUSH_TOKEN
    ) {
      return res
        .status(401)
        .json({ error: "Unauthorized", message: "push token is required" });
    }

    const payload = { ...req.body };

    // --- Detect Item Quantity Push ---
    
      const toNum = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const calcDropPct = (oldValue, currentValue) => {
        const oldN = toNum(oldValue);
        const curN = toNum(currentValue);
        if (!oldN || oldN <= 0 || curN === null) return 0;
        return Number((((oldN - curN) / oldN) * 100).toFixed(2));
      };

      const isInventoryPayload =
        payload &&
        payload.product_id &&
        payload.product_title &&
        payload.variant_id &&
        (payload.drr7 !== undefined || payload.doh7 !== undefined || payload.inventoryQty !== undefined);

      // Special handling for inventory threshold events coming as flat payloads.
      if (isInventoryPayload) {
        const drrThreshold = toNum(process.env.DRR_THRESHOLD) ?? 0;
        const dohThreshold = toNum(process.env.DOH_THRESHOLD) ?? 0;
        const qtyThreshold = toNum(process.env.INVENTORY_QTY_THRESHOLD) ?? 0;

        const drr7 = toNum(payload.drr7);
        const doh7 = toNum(payload.doh7);
        const inventoryQty = toNum(payload.inventoryQty);

        const inventoryAlerts = [];

        if (drr7 !== null && drr7 < drrThreshold) {
          const delta = calcDropPct(payload.old_drr7, drr7);
          const productIdShort = String(payload.product_id || "").split("/").pop();
          inventoryAlerts.push({
            metric_type: "DRR",
            current_value: drr7,
            old_value: toNum(payload.old_drr7),
            delta_percent: delta,
            subject: `LOW DRR | ${payload.product_title} | current value: ${drr7}`,
            description: `${productIdShort} | ${payload.product_title} | DRR dropped by ${delta}%`,
          });
        }

        if (doh7 !== null && doh7 < dohThreshold) {
          const delta = calcDropPct(payload.old_doh7, doh7);
          const productIdShort = String(payload.product_id || "").split("/").pop();
          inventoryAlerts.push({
            metric_type: "DOH",
            current_value: doh7,
            old_value: toNum(payload.old_doh7),
            delta_percent: delta,
            subject: `LOW DOH | ${payload.product_title} | current value: ${doh7}`,
            description: `${productIdShort} | ${payload.product_title} | DOH dropped by ${delta}%`,
          });
        }

        if (inventoryQty !== null && inventoryQty < qtyThreshold) {
          const delta = calcDropPct(payload.old_inventoryQty, inventoryQty);
          const productIdShort = String(payload.product_id || "").split("/").pop();
          inventoryAlerts.push({
            metric_type: "INVENTORY_QTY",
            current_value: inventoryQty,
            old_value: toNum(payload.old_inventoryQty),
            delta_percent: delta,
            subject: `LOW INVENTORY | ${payload.product_title} | current value: ${inventoryQty}`,
            description: `${productIdShort} | ${payload.product_title} | INVENTORY_QTY dropped by ${delta}%`,
          });
        }

        if (inventoryAlerts.length === 0) {
          return res.json({
            message: "Inventory payload received, no thresholds breached",
            alerts_triggered: 0,
          });
        }

        await Promise.all(
          inventoryAlerts.map(async (alert) => {
            const doc = {
              read: false,
              stored_at: new Date(),
              shop_domain: payload.shop_domain || "system",
              product_id: payload.product_id,
              product_title: payload.product_title,
              variant_id: payload.variant_id,
              date: payload.date,
              metric_type: alert.metric_type,
              subject: alert.subject,
              description: alert.description,
              current_value: alert.current_value,
              old_value: alert.old_value,
              delta_percentage: alert.delta_percent,
              event: {
                metric: alert.metric_type,
                delta_percent: alert.delta_percent,
                threshold_type: "less_than",
                direction: "drop",
                condition: alert.description,
                current_state: "ALERT",
                brand: payload.product_title,
                current_value: alert.current_value,
              },
            };

            await mongoose.connection.collection("inventory_notifications").insertOne(doc);
            sendToAll(mongoose.connection, alert.subject, alert.description, {
              severity: "critical",
              brand: payload.shop_domain || "system",
              metric_type: alert.metric_type,
            }).catch((err) =>
              logger.error("[push/receive] Inventory FCM sendToAll error:", err.message),
            );
          }),
        );

        return res.json({
          message: "Inventory notifications stored successfully",
          alerts_triggered: inventoryAlerts.length,
        });
      }
    if (payload.product_id && payload.current_quantity !== undefined) {
      const itemQtyEvent = new ItemQtyPush(payload);
      await itemQtyEvent.save();

      const subject = `🚨Inventory update: **${payload.product_title}** | ${payload.previous_quantity} -> ${payload.current_quantity}`;
      const description = `**${payload.product_title} (${payload.variant_title})** stock dropped from ${payload.previous_quantity} to ${payload.current_quantity} units`;

      sendToAll(mongoose.connection, subject, description, {
        brand: payload.brand || "System",
      }).catch((err) =>
        logger.error("[push/receive] FCM sendToAll error (ItemQtyPush):", err.message)
      );

      return res.json({
        message: "Item quantity push notification received and stored successfully",
        data: payload,
      });
    }

    const evt = payload.event || {};

    // Store in pushnotifications collection
    await mongoose.connection.collection("pushnotifications").insertOne({
      ...payload,
      read: false,
      stored_at: new Date(),
    });

    // Extract hour range from email body (e.g., "0-17h")
    const emailContent =
      typeof payload.email_body === "string"
        ? payload.email_body
        : payload.email_body?.html || "";
    const hourMatch = emailContent.match(/(\d+-\d+h)/);
    const hourRange = hourMatch ? hourMatch[1] : "";

    // Build FCM notification headline
    const delta = Math.abs(evt.delta_percent || 0).toFixed(2);
    const thresholdType = String(evt.threshold_type || "").toLowerCase();
    const eventDirection = String(evt.direction || "").toLowerCase();
    const conditionText = String(evt.condition || "").toLowerCase();

    const direction =
      eventDirection.includes("below") ||
      eventDirection.includes("drop") ||
      eventDirection.includes("down") ||
      eventDirection.includes("decrease") ||
      conditionText.includes("drop") ||
      conditionText.includes("below") ||
      thresholdType.includes("drop") ||
      thresholdType.includes("less_than")
        ? "Drop"
        : eventDirection.includes("above") ||
          eventDirection.includes("rise") ||
          eventDirection.includes("up") ||
          eventDirection.includes("increase") ||
          conditionText.includes("rise") ||
          conditionText.includes("above") ||
          thresholdType.includes("rise") ||
          thresholdType.includes("greater_than")
        ? "Rise"
        : (evt.delta_percent || 0) < 0
        ? "Drop"
        : "Rise";
    const rawMetric = evt.metric || "metric";
    const formattedMetric = rawMetric
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

    const brand = evt.brand || "System";
    const currentValue =
      evt.current_value !== undefined ? evt.current_value.toFixed(2) : "0.00";

    // New Title Format: NEULIFE | Low Speed Alert | 50.00 | 3.85% Drop | 0-17h
    const titleParts = [
      brand,
      formattedMetric,
      currentValue,
      `${delta}% ${direction}`,
    ];
    if (hourRange) titleParts.push(hourRange);
    const title = titleParts.join(" | ");

    // Updated body to show current value if available
    let body;
    if (evt.current_value !== undefined) {
      body = `current value: ${evt.current_value.toFixed(2)}`;
      evt.condition = body;
    } else {
      body = evt.condition || `${formattedMetric} ${direction.toLowerCase()} by ${delta}%`;
      evt.condition = `${formattedMetric} ${direction.toLowerCase()} by ${delta}%`;
    }

    // Send FCM push to all registered devices (fire-and-forget)
    sendToAll(mongoose.connection, title, body, {
      event_id: evt.event_id || "",
      severity: evt.severity || "info",
      brand: brand,
    }).catch((err) =>
      logger.error("[push/receive] FCM sendToAll error:", err.message),
    );

    res.json({
      message: "Push notification received and stored successfully",
      data: payload,
    });
  } catch (err) {
    logger.error("Error logging push notification:", err);
    res.status(500).json({ error: "Failed to log push notification" });
  }
});

app.post("/push/register-token", requireAuthor, async (req, res) => {
  try {
    const { token, user_info } = req.body;
    if (!token) return res.status(400).json({ error: "FCM token is required" });

    await mongoose.connection
      .collection("fcm_tokens")
      .updateOne(
        { token },
        { $set: { token, user_info, updated_at: new Date() } },
        { upsert: true },
      );

    res.json({ message: "Token registered successfully" });
  } catch (err) {
    logger.error("Error registering FCM token:", err);
    res.status(500).json({ error: "Failed to register token" });
  }
});

app.post("/push/unregister-token", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "FCM token is required" });

    await mongoose.connection.collection("fcm_tokens").deleteOne({ token });

    res.json({ message: "Token unregistered successfully" });
  } catch (err) {
    logger.error("Error unregistering FCM token:", err);
    res.status(500).json({ error: "Failed to unregister token" });
  }
});

app.get("/push/notifications", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const skip = parseInt(req.query.skip, 10) || 0;

    const pushNotifs = await mongoose.connection
      .collection("pushnotifications")
      .find({})
      .sort({ stored_at: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const itemQtyNotifs = await mongoose.connection
      .collection("item_qty_push")
      .find({})
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const inventoryNotifs = await mongoose.connection
      .collection("inventory_notifications")
      .find({})
      .sort({ stored_at: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const formattedItemQty = itemQtyNotifs.map((reqPush) => {
      const diff = (reqPush.previous_quantity || 0) - (reqPush.current_quantity || 0);
      const pct = reqPush.previous_quantity ? (diff / reqPush.previous_quantity) * 100 : 0;
      return {
        _id: reqPush._id,
        stored_at: reqPush.createdAt,
        read: reqPush.read || false,
        is_item_qty_push: true,
        event: {
          metric: reqPush.variant_title || "Quantity",
          delta_percent: -pct, // negative for drop
          threshold_type: "drop",
          direction: "drop",
          condition: `Stock dropped to ${reqPush.current_quantity}`,
          current_state: "CRITICAL",
          brand: reqPush.product_title || "Inventory",
          current_value: reqPush.current_quantity,
          previous_quantity: reqPush.previous_quantity,
        },
      };
    });

    const formattedInventory = inventoryNotifs.map((inv) => ({
      _id: inv._id,
      stored_at: inv.stored_at || inv.createdAt || new Date(),
      read: inv.read || false,
      is_inventory_notification: true,
      subject: inv.subject,
      description: inv.description,
      event: inv.event || {
        metric: inv.metric_type || "inventory",
        delta_percent: inv.delta_percentage || 0,
        threshold_type: "less_than",
        direction: "drop",
        condition: inv.description,
        current_state: "ALERT",
        brand: inv.product_title || "Inventory",
        current_value: inv.current_value,
      },
    }));

    let combined = [...pushNotifs, ...formattedItemQty, ...formattedInventory];
    combined.sort((a, b) => new Date(b.stored_at) - new Date(a.stored_at));
    const notifications = combined.slice(0, limit);

    // Also get unread count
    const unreadPushNotifs = await mongoose.connection
      .collection("pushnotifications")
      .countDocuments({ read: false });

    const unreadItemQty = await mongoose.connection
      .collection("item_qty_push")
      .countDocuments({ read: false });

    const unreadInventory = await mongoose.connection
      .collection("inventory_notifications")
      .countDocuments({ read: false });

    const unreadCount = unreadPushNotifs + unreadItemQty + unreadInventory;

    res.json({ notifications, unreadCount });
  } catch (err) {
    logger.error("Error fetching notifications:", err);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

app.put("/push/notifications/read", async (req, res) => {
  try {
    const { message_ids } = req.body;

    let query = { read: false };
    if (message_ids && Array.isArray(message_ids) && message_ids.length > 0) {
      const objectIds = message_ids.map((id) => {
        try {
          return new mongoose.Types.ObjectId(id);
        } catch (e) {
          return id;
        }
      });
      query = { _id: { $in: objectIds } };
    }

    await Promise.all([
      mongoose.connection
        .collection("pushnotifications")
        .updateMany(query, { $set: { read: true } }),
      mongoose.connection
        .collection("item_qty_push")
        .updateMany(query, { $set: { read: true } }),
      mongoose.connection
        .collection("inventory_notifications")
        .updateMany(query, { $set: { read: true } }),
    ]);
    res.json({ message: "Notifications marked as read" });
  } catch (err) {
    logger.error("Error marking notifications as read:", err);
    res.status(500).json({ error: "Failed to update notifications" });
  }
});

app.use(sentryErrorMiddleware);

// ---- Start ------------------------------------------------------------------
async function start() {
  try {
    await mongoose.connect(MONGO_URI, { dbName: MONGO_DB });
    mongoose.connection.on("error", (err) => {
      recordMongoConnectionError();
      captureError(err, null, { type: "mongo_connection" });
    });
    logger.info("[alerts-service] Mongo connected");
    const port = Number(process.env.PORT || 5005);
    app.listen(port, () => {
      logger.info(`[alerts-service] listening on :${port}`);
      logger.info(
        "[alerts-service] brands loaded:",
        Object.keys(getBrands()).join(", ") || "(none)",
      );
      registerWithHealthMonitor({
        serviceName: "alerts-service",
        baseUrl: "http://alerts-service:5005",
        healthEndpoint: "/health",
        dependencies: ["mongo", "redis"],
        endpoints: [
          { path: "/health", method: "GET", critical: true, intervalSeconds: 3600, successStatusFamily: "2xx" },
          { path: "/health/monitor", method: "GET", critical: true, intervalSeconds: 3600, successStatusFamily: "2xx" },
        ],
        discoveredRoutes: [
          ...collectRoutes(app, { sourceModule: "app.js" }),
          ...collectRoutes(alertsRouter, {
            mountPath: "/alerts",
            sourceModule: "routes/alerts.js",
            mountMiddlewareNames: ["requireAuthor"],
          }),
        ],
      }, logger);

      // Warm inventory cache in the background so service health is not blocked
      // on cross-brand DB/Redis work during container startup.
      runInventoryCacheRefresh().catch((err) => {
        logger.error("[inventory-cache] Initial refresh error:", err);
      });

      setInterval(() => {
        runInventoryCacheRefresh().catch((err) => {
          logger.error("[inventory-cache] Scheduled refresh error:", err);
        });
      }, INVENTORY_CACHE_REFRESH_MS);
    });
  } catch (err) {
    recordMongoConnectionError();
    captureError(err, null, { type: "startup" });
    console.error("Failed to start alerts-service", err);
    process.exit(1);
  }
}

if (require.main === module) {
  start();
}

module.exports = { app, start, mongoose, Alert, AlertChannel, BrandAlertChannel };
