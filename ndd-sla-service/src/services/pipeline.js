// Orchestrates one report run end to end. All I/O is injected (repo, gmail, easycom, clock), so the same code runs in
// production and in tests against in-memory fakes. The business rules live in processor.js and stay pure.
//
// TWO WAYS IN, ONE CORE.  Both end in the same ingest() below, so a report is identical whichever way it arrived:
//   AUTO    processRun(run)         worker: find the GoKwik email, download it, page through the EasyCom API
//   MANUAL  processUpload(run, ..)  API: an author uploaded the GoKwik CSV and the EasyCom export; both are streamed from disk
//
// Stages (run.status):  SCHEDULED -> WAITING_FOR_GOKWIK -> GOKWIK_RECEIVED -> EASYCOM_FETCHING -> PROCESSING -> COMPLETED
//   source   (auto) find the email + download; (manual) hash the uploaded files
//   csv      stream the GoKwik file through parseCsv -> filterOrders (pass 1: only the kept set F is retained)
//   easycom  stream shipments (API pages or the uploaded export), keeping a pickup only for codes in F (pass 2)
//   persist  join lazily, insert in batches under a NEW generation, then activate it atomically
// Memory is bounded by |F| plus one CSV chunk, one shipment page and one DB batch. Nothing reads a whole dataset.
const fs = require("fs");
const path = require("path");
const { PipelineError } = require("../errors");
const { ensureLogger, describeError } = require("../logger");
const { parseCsv, sniffHeaderRows, hasColumns } = require("../lib/csvStream");
const { openCsvStream, hashFile } = require("../lib/openFile");
const { toWall, wallToEpochMs, addHoursWall, addDaysDate } = require("../lib/wall");
const { selectGokwikMessage } = require("../integrations/gokwikMatcher");
const {
  computeWindows, createPickedIndex, createSummaryAggregator, filterOrders, joinOrders,
} = require("./processor");

const maxWall = (a, b) => (a > b ? a : b);
const minWall = (a, b) => (a < b ? a : b);
const utcSql = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const SHIPMENT_PAGE = 1000;

function windowsOf(run) {
  return {
    ndd: { start: run.ndd_window_start, end: run.ndd_window_end },
    other: { start: run.other_window_start, end: run.other_window_end },
  };
}

// Yields the rows unchanged, calling `beat` every `every` rows so a long file keeps the run lock fresh.
async function* withHeartbeat(rows, every, beat) {
  let n = 0;
  for await (const row of rows) {
    n += 1;
    if (n % every === 0) await beat();
    yield row;
  }
}

// An uploaded EasyCom export (CSV) presented as the same pages the API client yields: { rawCount, items }.
// parseCsv keys aliases by the preferred header name; config keys them by logical field.
const aliasesByName = (columns, aliases = {}) => Object.fromEntries(Object.keys(columns).map((k) => [columns[k], aliases[k] || []]));

async function* shipmentPagesFromCsv(rows, columns) {
  let items = [];
  for await (const row of rows) {
    items.push({ reference: row[columns.reference], pickedAtRaw: row[columns.pickedAt] });
    if (items.length >= SHIPMENT_PAGE) {
      yield { rawCount: items.length, items };
      items = [];
    }
  }
  if (items.length) yield { rawCount: items.length, items };
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PAUSE_POLL_MS = 2000;

function buildPipeline({ config, repo, gmail, easycom, logger, now = () => Date.now(), workerId = "worker", sleep = realSleep }) {
  const log = ensureLogger(logger, "pipeline");
  const tz = config.timezone;

  // Ensures a run row exists for every report date whose windows have closed (today and `lookbackDays` earlier).
  async function scheduleRuns() {
    const nowWall = toWall(now(), tz);
    const today = nowWall.slice(0, 10);
    let created = 0;
    for (let back = 0; back <= config.worker.lookbackDays; back += 1) {
      const reportDate = addDaysDate(today, -back);
      const windows = computeWindows(reportDate, config.window);
      if (nowWall < maxWall(windows.ndd.end, windows.other.end)) continue; // window still open
      const res = await repo.ensureRun({ brandKey: config.brandKey, reportDate, windows });
      if (res.created) created += 1;
    }
    return created;
  }

  async function findSource(windows) {
    // The email for report D arrives after D's windows close and before the next report's windows close, so the search
    // range is [earliest window end, + lookahead (default 24h = one window length)). Consecutive reports get disjoint
    // ranges, which keeps one email from ever being claimed by two runs.
    const fromWall = minWall(windows.ndd.end, windows.other.end);
    const range = { fromWall, toWall: addHoursWall(fromWall, config.gmail.searchLookaheadHours) };
    const senders = String(config.gmail.sender).split(",").map((s) => s.trim()).filter(Boolean);
    const candidates = await gmail.listCandidates({
      sender: senders.length > 1 ? `(${senders.join(" OR ")})` : senders[0],
      afterEpochSec: Math.floor(wallToEpochMs(range.fromWall, tz) / 1000),
      beforeEpochSec: Math.ceil(wallToEpochMs(range.toWall, tz) / 1000),
    });
    const withWall = candidates.map((m) => ({ ...m, receivedWall: toWall(m.receivedMs, tz) }));
    return selectGokwikMessage(withWall, config.gmail, range);
  }

  // Heartbeat + obey the user: CANCEL stops the run, PAUSE holds it here (the lock stays fresh) until resumed or
  // config.worker.pauseMaxMs passes. `beat` runs at every stage change and every few thousand rows / pages / batches.
  function makeControl(run, wid, state) {
    const beat = async () => {
      let control = await repo.heartbeat(run.id, wid);
      if (control === "PAUSE") {
        const since = now();
        while (control === "PAUSE") {
          if (now() - since >= config.worker.pauseMaxMs) throw new PipelineError("PAUSE_TIMEOUT", "The report stayed paused too long and was cancelled.");
          await sleep(PAUSE_POLL_MS);
          control = await repo.heartbeat(run.id, wid);
        }
      }
      if (control === "CANCEL") throw new PipelineError("CANCELLED", "Cancelled by a user.");
    };
    const moveTo = async (next, fields, metadata) => {
      await beat();
      if (state.status === next && !fields) return;
      await repo.transition(run.id, wid, next, fields || {}, metadata);
      state.status = next;
    };
    return { beat, moveTo };
  }

  // The shared core. `acquire` produces the GoKwik file path (or ends the attempt early); `shipmentPages` yields the
  // EasyCom data. `manual` runs never retry: their temp files are not kept, so the author uploads again.
  async function execute(run, { acquire, shipmentPages, manual = false, maxKeptRows }) {
    const started = now();
    const wid = run.locked_by || workerId;
    const windows = windowsOf(run);
    const state = { stage: manual ? "csv" : "gmail", generation: null, status: run.status };
    const { beat, moveTo } = makeControl(run, wid, state);
    const tmpFile = path.join(config.tmpDir, `ndd-sla-${run.id}-${process.pid}-${started}.csv`);

    try {
      const acquired = await acquire({ run, windows, wid, tmpFile, moveTo, beat, state });
      if (acquired.result) return acquired.result;

      // ---- csv (pass 1) ------------------------------------------------------------------------------------------
      state.stage = "csv";
      const required = Object.values(config.columns);
      const csvStream = await openCsvStream(acquired.csvPath, { maxExpandedBytes: config.upload.maxExpandedBytes });
      const mp = config.optionalColumns?.marketplace || null;
      const aliases = { ...aliasesByName(config.columns, config.columnAliases), ...(mp ? { [mp]: config.optionalColumnAliases?.marketplace || [] } : {}) };
      const rows = withHeartbeat(parseCsv(csvStream, { required, optional: mp ? [mp] : [], project: true, aliases }), 5000, beat);
      const { kept, counts } = await filterOrders(rows, {
        windows, columns: config.columns, maxKeptRows: maxKeptRows ?? config.limits.maxKeptRows,
        marketplaceColumn: mp, marketplaces: config.marketplaces || [],
      });
      log.info("csv filtered", { run: run.id, ...counts });

      // ---- easycom / shipments (pass 2) --------------------------------------------------------------------------
      state.stage = "easycom";
      await moveTo("EASYCOM_FETCHING", counts);
      const index = createPickedIndex(kept);
      const ecStart = now();
      let pages = 0;
      let fetched = 0;
      if (kept.size > 0) {
        const range = {
          from: minWall(windows.ndd.start, windows.other.start),
          to: maxWall(windows.ndd.end, windows.other.end),
        };
        for await (const page of shipmentPages(range, { beat })) {
          pages += 1;
          fetched += page.rawCount;
          for (const item of page.items) index.offer(item.reference, item.pickedAtRaw);
          await beat();
        }
      }
      const easycomMs = now() - ecStart;
      if (index.stats.shipments_invalid_picked_at) {
        log.warn("shipment pickup values that could not be parsed (treated as no pickup)", { run: run.id, count: index.stats.shipments_invalid_picked_at });
      }

      // ---- persist -----------------------------------------------------------------------------------------------
      state.stage = "persist";
      const procStart = now();
      await moveTo("PROCESSING", { easycom_pages: pages, easycom_fetched: fetched, easycom_ms: easycomMs });
      state.generation = await repo.beginGeneration(run.id, wid);
      const generation = state.generation;
      const aggregator = createSummaryAggregator();
      const joinStats = {};
      let batch = [];
      for (const order of joinOrders(kept, index.picked, joinStats)) {
        aggregator.add(order);
        batch.push(order);
        if (batch.length >= config.limits.dbBatchRows) {
          await repo.insertOrders(run.id, generation, batch);
          batch = [];
          await beat();
        }
      }
      if (batch.length) await repo.insertOrders(run.id, generation, batch);
      const totals = aggregator.totals();
      if (totals.total !== kept.size) {
        throw new PipelineError("PROCESSING_INCONSISTENT", `Summary counted ${totals.total} orders but ${kept.size} were kept`);
      }
      await repo.insertSummary(run.id, generation, aggregator.rows());
      await repo.activate(run.id, wid, generation, {
        rows_unmatched: joinStats.unmatched, sla_met: totals.met, sla_breached: totals.breached,
        process_ms: now() - procStart,
      });
      log.info("run completed", { run: run.id, reportDate: run.report_date, mode: manual ? "manual" : "auto", generation, kept: kept.size, ...totals, ms: now() - started });
      return { outcome: "completed", runId: run.id, generation, totals, counts };
    } catch (err) {
      return handleFailure(run, wid, err, state.stage, state.generation, manual);
    } finally {
      fs.promises.unlink(tmpFile).catch(() => {});
    }
  }

  // ---- AUTO: Gmail + EasyCom API ----------------------------------------------------------------------------------
  async function acquireFromGmail({ run, windows, wid, tmpFile, moveTo, beat }) {
    let messageId = run.gmail_message_id;
    let attachmentId = run.gmail_attachment_id;
    let attachmentSize = 0;
    const gmailStart = now();

    if (!messageId) {
      await moveTo("WAITING_FOR_GOKWIK");
      const found = await findSource(windows);
      if (!found) {
        const deadline = addHoursWall(maxWall(windows.ndd.end, windows.other.end), config.worker.gokwikDeadlineHours);
        if (toWall(now(), tz) >= deadline) {
          await repo.failAttempt(run.id, wid, {
            status: "GOKWIK_TIMEOUT", code: "GOKWIK_NOT_RECEIVED",
            detail: `No matching GoKwik email arrived before ${deadline} (${tz})`, delayMs: null,
          });
          log.warn("GoKwik report never arrived", { run: run.id, reportDate: run.report_date, deadline });
          return { result: { outcome: "timeout", runId: run.id } };
        }
        await repo.scheduleWait(run.id, wid, config.pollMs);
        log.info("GoKwik report not there yet", { run: run.id, reportDate: run.report_date });
        return { result: { outcome: "waiting", runId: run.id } };
      }
      messageId = found.message.id;
      attachmentId = found.attachment.id;
      attachmentSize = found.attachment.size;
      await repo.update(run.id, wid, {
        gmail_message_id: messageId, gmail_attachment_id: attachmentId, source_filename: found.attachment.filename,
        source_received_at: utcSql(found.message.receivedMs), duplicate_messages: found.duplicates,
      });
      if (found.duplicates) log.warn("several GoKwik emails matched; using one", { run: run.id, pick: config.gmail.pick, ignored: found.duplicates });
      await moveTo("GOKWIK_RECEIVED", null, { messageId, duplicates: found.duplicates });
    }
    await moveTo("GOKWIK_RECEIVED");
    const dl = await gmail.downloadAttachment({
      messageId, attachmentId, destPath: tmpFile, maxBytes: config.limits.maxAttachmentBytes, expectedSize: attachmentSize,
    });
    await repo.update(run.id, wid, { source_bytes: dl.bytes, source_sha256: dl.sha256, gmail_ms: now() - gmailStart });
    await beat();
    return { csvPath: tmpFile };
  }

  async function processRun(run) {
    return execute(run, {
      acquire: acquireFromGmail,
      shipmentPages: (range) => easycom.fetchShipments(range),
    });
  }

  // ---- MANUAL: two uploaded files ---------------------------------------------------------------------------------
  // `files` = { gokwik: { path, name }, easycom: { path, name } }; the caller deletes them afterwards.
  // Reads the start of an uploaded file and returns its first header rows (the file may be gzipped).
  async function peekHeaders(file, maxRows) {
    const stream = await openCsvStream(file.path, { maxExpandedBytes: config.upload.maxExpandedBytes });
    let text = "";
    try {
      for await (const chunk of stream) {
        text += chunk.toString("utf8");
        if (text.length >= 64 * 1024) break;
      }
    } finally {
      stream.destroy();
    }
    return sniffHeaderRows(text, maxRows);
  }

  // The two files are easy to put in the wrong slot (their names are alike and both carry a Reference/Order code). If the
  // file in the GoKwik slot is a shipment/pickup export and the one in the EasyCom slot is the orders export, use them
  // the other way round instead of failing; anything else is left as it is and fails with the usual clear message.
  async function orientUpload(files) {
    const orderCols = Object.keys(config.columns).map((k) => [config.columns[k], ...(config.columnAliases[k] || [])]);
    const ec = config.upload.easycomColumns;
    const ecAl = config.upload.easycomColumnAliases;
    const pickupCols = [[ec.reference, ...(ecAl.reference || [])], [ec.pickedAt, ...(ecAl.pickedAt || [])]];
    try {
      const [first, second] = await Promise.all([peekHeaders(files.gokwik), peekHeaders(files.easycom)]);
      const swapped = !hasColumns(first, orderCols) && hasColumns(first, pickupCols) && hasColumns(second, orderCols);
      if (swapped) log.warn("uploaded files were in the wrong slots; swapping them", { gokwik: files.gokwik.name, easycom: files.easycom.name });
      return swapped ? { files: { gokwik: files.easycom, easycom: files.gokwik }, swapped } : { files, swapped };
    } catch (err) {
      log.warn("could not inspect the uploaded files; using them as given", { error: err });
      return { files, swapped: false };
    }
  }

  async function processUpload(run, uploaded) {
    const { files, swapped } = await orientUpload(uploaded);
    const columns = config.upload.easycomColumns;
    return execute(run, {
      manual: true,
      maxKeptRows: config.upload.maxKeptRows,
      acquire: async ({ run: r, wid, moveTo, beat }) => {
        const { sha256, bytes } = await hashFile(files.gokwik.path);
        await repo.update(r.id, wid, {
          source_filename: String(files.gokwik.name).slice(0, 255), source_bytes: bytes, source_sha256: sha256,
          easycom_source_filename: String(files.easycom.name).slice(0, 255),
        });
        await moveTo("GOKWIK_RECEIVED", null, { manualUpload: true, ...(swapped ? { filesSwapped: true } : {}) });
        await beat();
        return { csvPath: files.gokwik.path };
      },
      shipmentPages: async function* shipments(_range, { beat }) {
        const stream = await openCsvStream(files.easycom.path, { maxExpandedBytes: config.upload.maxExpandedBytes });
        const rows = withHeartbeat(parseCsv(stream, { required: [columns.reference, columns.pickedAt], project: true, aliases: aliasesByName(columns, config.upload.easycomColumnAliases) }), 5000, beat);
        try {
          yield* shipmentPagesFromCsv(rows, columns);
        } catch (err) {
          if (err instanceof PipelineError && /^CSV_/.test(err.code)) {
            throw new PipelineError(err.code, `EasyCom file: ${err.message}`);
          }
          throw err;
        }
      },
    });
  }

  async function handleFailure(run, wid, err, stage, generation, manual) {
    if (err && err.code === "LOCK_LOST") {
      log.warn("lost the run lock; another worker owns it now, stopping without writing", { run: run.id });
      return { outcome: "lock_lost", runId: run.id };
    }
    const cancelled = err && (err.code === "CANCELLED" || err.code === "PAUSE_TIMEOUT");
    if (generation !== null) await repo.discardGeneration(run.id, generation).catch((e) => log.error("discarding the partial generation failed", { run: run.id, error: e }));

    if (cancelled) {
      try {
        await repo.markCancelled(run.id, wid, { code: err.code, detail: err.message });
      } catch (writeErr) {
        if (!(writeErr && writeErr.code === "LOCK_LOST")) log.error("could not record the cancellation", { run: run.id, error: writeErr });
      }
      log.warn("run cancelled", { run: run.id, stage, code: err.code });
      return { outcome: "cancelled", runId: run.id, stage, code: err.code };
    }

    const code = (err && err.code && typeof err.code === "string" && /^[A-Z_0-9]+$/.test(err.code)) ? err.code : "UNEXPECTED_ERROR";
    // Unknown errors (DB blips, I/O) are treated as transient; PipelineErrors say so themselves. A manual upload has
    // nothing to retry with (its files are removed), so it always fails for good.
    const retryable = !manual && (err instanceof PipelineError ? err.retryable : true);
    const attemptsLeft = run.attempts + 1 < config.worker.maxAttempts;
    const retry = retryable && attemptsLeft;
    const backoff = Math.min(config.worker.backoffMaxMs, config.worker.backoffBaseMs * 2 ** run.attempts);
    const failStatus = stage === "easycom" ? "EASYCOM_FAILED" : "PROCESSING_FAILED";
    const status = retry && stage === "gmail" ? "WAITING_FOR_GOKWIK" : failStatus;
    log.error("run attempt failed", { run: run.id, stage, retry, mode: manual ? "manual" : "auto", error: err });
    try {
      await repo.failAttempt(run.id, wid, {
        status, code, detail: describeError(err).message, delayMs: retry ? backoff : null,
      });
    } catch (writeErr) {
      if (!(writeErr && writeErr.code === "LOCK_LOST")) log.error("could not record the failure", { run: run.id, error: writeErr });
    }
    return { outcome: retry ? "retry_scheduled" : "failed", runId: run.id, stage, code };
  }

  // One unit of worker work: free dead locks, make sure due runs exist, process at most one run.
  async function tick() {
    await repo.releaseStaleLocks(config.worker.lockStaleMs, config.worker.pauseMaxMs);
    await scheduleRuns();
    const run = await repo.claimNext(config.brandKey, workerId);
    if (!run) return { outcome: "idle" };
    return processRun(run);
  }

  return { tick, scheduleRuns, processRun, processUpload };
}

module.exports = { buildPipeline, windowsOf };
