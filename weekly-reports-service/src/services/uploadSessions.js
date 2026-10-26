const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { httpError } = require("../errors");
const { extensionOf, UNSUPPORTED_TYPE_MESSAGE } = require("./uploadValidator");

const DIR_PREFIX = "wr-upload-";

// Chunked uploads. Vercel's function proxy rejects any request body over about 4.5 MB, so the browser
// sends a deck in small chunks (default 3 MiB) and asks for it to be assembled at the end. A session
// holds the partly written file on this server's disk; it is bound to one brand and one user, and it
// is thrown away on completion, on cancel, or when it sits idle past the TTL.
//
// Sessions live in this process's memory: if the API restarts, an upload in flight fails and the
// admin simply starts it again. (One API instance, as in docker-compose.)
function buildUploadSessions({ config, now = () => Date.now(), logger = console } = {}) {
  const sessions = new Map();
  const chunkSize = config.uploadChunkBytes;
  const ttlMs = config.uploadSessionTtlMs;

  const totalChunksFor = (size) => Math.ceil(size / chunkSize);

  async function removeDir(dir) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch (err) {
      logger.error("[weekly-reports] could not remove upload dir", dir, err && err.message);
    }
  }

  async function discard(id) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    // Wait for any chunk still being written so its file handle is closed before removal.
    await session.queue.catch(() => {});
    await removeDir(session.dir);
  }

  async function sweep() {
    const cutoff = now() - ttlMs;
    const expired = [...sessions.values()].filter((s) => s.touchedAt < cutoff).map((s) => s.id);
    for (const id of expired) await discard(id);
    return expired.length;
  }

  // After a restart nothing in memory refers to old upload folders; remove the ones that are stale.
  async function cleanupOrphans() {
    let removed = 0;
    const base = config.uploadTmpDir;
    let names = [];
    try {
      names = await fs.promises.readdir(base);
    } catch (_) {
      return 0;
    }
    for (const name of names) {
      if (!name.startsWith(DIR_PREFIX)) continue;
      const dir = path.join(base, name);
      try {
        const stat = await fs.promises.stat(dir);
        if (now() - stat.mtimeMs > ttlMs) {
          await removeDir(dir);
          removed += 1;
        }
      } catch (_) {
        /* gone already */
      }
    }
    return removed;
  }

  async function create({ brandKey, userId, filename, size, title, reportingWeek }) {
    await sweep();
    if (!extensionOf(filename)) throw httpError(415, "UNSUPPORTED_FILE_TYPE", UNSUPPORTED_TYPE_MESSAGE);
    if (!Number.isInteger(size) || size <= 0) throw httpError(422, "CORRUPT_FILE", "The file is empty.");
    if (size > config.maxUploadBytes) {
      const mb = Math.round(config.maxUploadBytes / (1024 * 1024));
      throw httpError(413, "FILE_TOO_LARGE", `File is larger than ${mb} MB.`);
    }
    const mine = [...sessions.values()].filter((s) => s.userId === userId).length;
    if (mine >= config.maxUploadSessionsPerUser || sessions.size >= config.maxUploadSessions) {
      throw httpError(429, "TOO_MANY_UPLOADS", "Too many uploads in progress. Finish or cancel one and try again.");
    }

    const id = crypto.randomBytes(16).toString("hex");
    const dir = await fs.promises.mkdtemp(path.join(config.uploadTmpDir, DIR_PREFIX));
    const filePath = path.join(dir, "data");
    await fs.promises.writeFile(filePath, "");
    const session = {
      id, dir, filePath, brandKey, userId, filename, size, title, reportingWeek,
      received: 0, nextIndex: 0, last: null, touchedAt: now(), queue: Promise.resolve(),
    };
    sessions.set(id, session);
    return { session, chunkSize, totalChunks: totalChunksFor(size) };
  }

  // A session is only visible to the brand and user that created it. Anyone else gets the same
  // "not found" as for an unknown id, so ids cannot be probed.
  function get(id, { brandKey, userId }) {
    const session = sessions.get(String(id));
    if (!session || session.brandKey !== brandKey || session.userId !== userId) {
      throw httpError(404, "UPLOAD_NOT_FOUND", "This upload was not found or has expired. Start it again.");
    }
    session.touchedAt = now();
    return session;
  }

  // Chunks must arrive in order. Re-sending the chunk that was just accepted (the answer got lost on
  // the way back) is harmless and is acknowledged without writing it twice.
  function appendChunk(session, index, buffer) {
    const run = async () => {
      const total = totalChunksFor(session.size);
      const hash = crypto.createHash("sha256").update(buffer).digest("hex");

      if (session.last && index === session.last.index) {
        if (session.last.hash === hash) return state(session);
        throw httpError(409, "CHUNK_CONFLICT", "That chunk was already received with different content.");
      }
      if (index !== session.nextIndex) {
        throw Object.assign(httpError(409, "CHUNK_OUT_OF_ORDER", `Expected chunk ${session.nextIndex}.`), {
          expected: session.nextIndex,
        });
      }
      const expectedLength = index < total - 1 ? chunkSize : session.size - chunkSize * (total - 1);
      if (buffer.length !== expectedLength) {
        throw httpError(400, "BAD_CHUNK_SIZE", `Chunk ${index} must be ${expectedLength} bytes.`);
      }

      await fs.promises.appendFile(session.filePath, buffer);
      session.received += buffer.length;
      session.nextIndex += 1;
      session.last = { index, hash };
      session.touchedAt = now();
      return state(session);
    };
    // One chunk at a time per session, even if the client misbehaves and sends several at once.
    const result = session.queue.then(run, run);
    session.queue = result.catch(() => {});
    return result;
  }

  const state = (s) => ({ received: s.received, next_index: s.nextIndex, total_chunks: totalChunksFor(s.size) });

  function assertComplete(session) {
    if (session.received !== session.size) {
      throw httpError(409, "INCOMPLETE_UPLOAD", `Only ${session.received} of ${session.size} bytes were received.`);
    }
  }

  return { create, get, appendChunk, assertComplete, discard, sweep, cleanupOrphans, size: () => sessions.size, chunkSize };
}

module.exports = { buildUploadSessions };
