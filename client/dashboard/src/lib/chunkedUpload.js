// Chunked upload for Weekly Reports.
//
// In production every /api call goes through a Vercel function, and Vercel rejects any request body
// larger than about 4.5 MB (FUNCTION_PAYLOAD_TOO_LARGE). A deck is often 10-50 MB, so it is sent in
// small chunks instead and assembled by the service:
//
//   POST   /uploads                      {filename, size, title, reporting_week} -> {upload_id, chunk_size, total_chunks}
//   PUT    /uploads/:id/chunks/:index    raw bytes, in order, one at a time
//   POST   /uploads/:id/complete         the service checks the real file and creates the report
//   DELETE /uploads/:id                  cancel: the service discards what it received
//
// `send` is the transport (XHR in the browser, anything in tests). It resolves to one of:
//   { status, data }  |  { networkError: true }  |  { aborted: true }
// and receives { method, path, json?, body?, signal?, onProgress?(loadedBytes) }.

export const RETRY_DELAYS_MS = [500, 1500, 3500];

const isOk = (status) => status >= 200 && status < 300;
const isRetryable = (res) => Boolean(res.networkError) || res.status === 408 || res.status === 429 || res.status >= 500;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function failure(res) {
  if (res.networkError) return { error: true };
  return { error: true, status: res.status, data: res.data };
}

// Resolves to the same shapes the single-request upload used to:
//   { error: false, status, data }          the report was created (HTTP 202)
//   { error: true, aborted: true }          cancelled by the user
//   { error: true, status, data }           refused by the service (data.error is a readable message)
//   { error: true }                         network failure
export async function chunkedUpload({
  file,
  title,
  reportingWeek,
  send,
  onProgress,
  signal,
  delays = RETRY_DELAYS_MS,
  sleep = defaultSleep,
}) {
  const report = (fraction) => onProgress?.(Math.max(0, Math.min(1, fraction)));
  const wasAborted = (res) => Boolean(res?.aborted) || Boolean(signal?.aborted);
  const cancelled = { error: true, aborted: true };
  let uploadId = null;

  // Best effort: tell the service to throw away what it already received. Never throws.
  const discard = async () => {
    if (!uploadId) return;
    try {
      await send({ method: "DELETE", path: `/uploads/${uploadId}` });
    } catch {
      // the service also drops idle uploads on its own
    }
  };

  const start = await send({
    method: "POST",
    path: "/uploads",
    json: { filename: file.name, size: file.size, title, reporting_week: reportingWeek },
    signal,
  });
  if (wasAborted(start)) return cancelled;
  if (start.networkError || !isOk(start.status)) return failure(start);

  const chunkSize = Number(start.data?.chunk_size);
  const totalChunks = Number(start.data?.total_chunks);
  uploadId = start.data?.upload_id;
  if (!uploadId || !(chunkSize > 0) || !(totalChunks > 0)) {
    return { error: true, status: start.status, data: { error: "The upload could not be started. Please try again." } };
  }

  let sent = 0;
  for (let index = 0; index < totalChunks; index += 1) {
    const blob = file.slice(index * chunkSize, Math.min(file.size, (index + 1) * chunkSize));
    let attempt = 0;
    for (;;) {
      // Re-sending the same chunk is safe: the service acknowledges a repeat without writing it twice.
      const res = await send({
        method: "PUT",
        path: `/uploads/${uploadId}/chunks/${index}`,
        body: blob,
        signal,
        onProgress: (loaded) => report((sent + loaded) / file.size),
      });
      if (wasAborted(res)) {
        await discard();
        return cancelled;
      }
      if (!res.networkError && isOk(res.status)) break;
      if (isRetryable(res) && attempt < delays.length) {
        await sleep(delays[attempt]);
        attempt += 1;
        if (signal?.aborted) {
          await discard();
          return cancelled;
        }
        continue;
      }
      await discard();
      return failure(res);
    }
    sent += blob.size;
    report(sent / file.size);
  }

  // Not retried on purpose: a lost answer here could hide a report that WAS created, and a second
  // attempt must never create another one. The presentations list shows the real outcome.
  const done = await send({ method: "POST", path: `/uploads/${uploadId}/complete`, signal });
  if (wasAborted(done)) return cancelled;
  if (done.networkError || !isOk(done.status)) return failure(done);
  report(1);
  return { error: false, status: done.status, data: done.data };
}
