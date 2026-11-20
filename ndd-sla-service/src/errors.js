// HTTP errors for the API: { error, code } like the rest of Datum.
class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const httpError = (status, code, message) => new HttpError(status, code, message);

// Errors raised by the ingestion pipeline. `retryable` decides whether the worker schedules another attempt
// (transient: network, 5xx, 429, lock lost) or fails the run for good (bad credentials, missing CSV column).
class PipelineError extends Error {
  constructor(code, message, { retryable = false, cause } = {}) {
    super(message);
    this.name = "PipelineError";
    this.code = code;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

module.exports = { HttpError, httpError, PipelineError };
