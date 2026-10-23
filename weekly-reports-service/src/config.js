const os = require("os");

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getConfig(env = process.env) {
  return {
    port: toInt(env.PORT, 4040),
    nodeEnv: env.NODE_ENV || "development",
    corsOrigins: String(env.CORS_ORIGINS || env.CORS_ORIGIN || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),

    // Gateway trust. Without the shared secret every request is rejected, unless
    // ALLOW_INSECURE_AUTH=true (local dev / tests only; server.js refuses it in production).
    gatewaySharedSecret: env.GATEWAY_SHARED_SECRET || "",
    allowInsecureAuth: String(env.ALLOW_INSECURE_AUTH || "").toLowerCase() === "true",

    // Central MySQL. WR_DB_* names avoid clashing with the root .env that compose also loads.
    db: {
      host: env.WR_DB_HOST || "",
      port: toInt(env.WR_DB_PORT, 3306),
      user: env.WR_DB_USER || "",
      password: env.WR_DB_PASSWORD || "",
      database: env.WR_DB_NAME || "",
      connectionLimit: toInt(env.WR_DB_POOL, 10),
    },

    // Dedicated private bucket. Credentials come from the default AWS provider chain
    // (instance profile / env), never from this file.
    bucket: env.WEEKLY_REPORTS_BUCKET || "",
    region: env.AWS_REGION || "ap-south-1",
    s3Endpoint: env.S3_ENDPOINT || "", // MinIO / local testing only

    // Upload limits (PRD assumption A1: 50 MB, 100 slides).
    maxUploadBytes: toInt(env.MAX_UPLOAD_BYTES, 50 * 1024 * 1024),
    maxSlides: toInt(env.MAX_SLIDES, 100),
    maxZipEntries: toInt(env.MAX_ZIP_ENTRIES, 5000),
    maxUncompressedBytes: toInt(env.MAX_UNCOMPRESSED_BYTES, 600 * 1024 * 1024),
    uploadTmpDir: env.UPLOAD_TMP_DIR || os.tmpdir(),

    // Chunked uploads. A chunk must stay well under Vercel's ~4.5 MB request limit (the browser reaches
    // this service through a Vercel function), so the default is 3 MiB.
    uploadChunkBytes: toInt(env.UPLOAD_CHUNK_BYTES, 3 * 1024 * 1024),
    uploadSessionTtlMs: toInt(env.UPLOAD_SESSION_TTL_MS, 30 * 60 * 1000),
    maxUploadSessionsPerUser: toInt(env.MAX_UPLOAD_SESSIONS_PER_USER, 3),
    maxUploadSessions: toInt(env.MAX_UPLOAD_SESSIONS, 20),

    // Worker.
    workerPollMs: toInt(env.WORKER_POLL_MS, 5000),
    cancelPollMs: toInt(env.CANCEL_POLL_MS, 2000), // how often a running job checks it was not cancelled
    convertTimeoutMs: toInt(env.CONVERT_TIMEOUT_MS, 5 * 60 * 1000),
    slideWidth: toInt(env.SLIDE_WIDTH, 1920),
    thumbWidth: toInt(env.THUMB_WIDTH, 320),
    rasterDpi: toInt(env.RASTER_DPI, 150),

    // Slide serving.
    slideCacheMax: toInt(env.SLIDE_CACHE_MAX, 80),
    // Status returned when a user asks for another brand's report: 403 (as specified) or 404
    // (does not reveal that the report exists). Open question Q3 in the PRD.
    crossBrandStatus: String(env.CROSS_BRAND_STATUS || "403") === "404" ? 404 : 403,
  };
}

module.exports = { getConfig };
