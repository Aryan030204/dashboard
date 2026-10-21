// Errors carry an HTTP status and a stable machine code. Response shape matches the rest of
// Datum: { error: "<message>" }, plus { code } so the UI can branch without parsing text.
class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const httpError = (status, code, message) => new HttpError(status, code, message);

module.exports = { HttpError, httpError };
