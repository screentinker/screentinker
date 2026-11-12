'use strict';

/*
 * What an /api request gets back when a route throws.
 *
 * Routes answer `{ error }` for everything they refuse on purpose. A route that THROWS had nothing
 * behind it, so the framework's default page went out instead: HTML, status 500, and outside
 * production the stack trace. No client of this API can read that, and nearly every request that
 * gets there is a malformed one. This is the last handler in the chain: it keeps the reply JSON,
 * never sends a stack, and recognises the few failures that are plainly the request's fault.
 */

/** A value SQLite cannot bind (array, object, boolean), too many values, or a number out of range. */
function isParameterShapeError(err) {
  const msg = String((err && err.message) || '');
  if (err instanceof TypeError && /SQLite3 can only bind/i.test(msg)) return true;
  if (err instanceof RangeError && /Too many parameter values/i.test(msg)) return true;
  return (err && err.code === 'SQLITE_MISMATCH') || /^datatype mismatch$/i.test(msg);
}

function isUploadFormError(err) {
  if (err && err.name === 'MulterError') return true;
  return /^(Multipart: |Unexpected end of form|Malformed part header|Unexpected field)/i.test(String((err && err.message) || ''));
}

function apiErrorHandler(err, req, res, next) {
  const url = String(req.originalUrl || req.url || '');
  // Pages keep the framework's handling; so does a reply that has already started.
  if (res.headersSent || !(url === '/api' || url.startsWith('/api/'))) return next(err);

  const declared = Number(err && (err.status || err.statusCode));
  if (declared >= 400 && declared < 500) {
    // body-parser and friends, and refusals a middleware tagged itself (see middleware/upload.js).
    return res.status(declared).json({ error: (err.expose !== false && err.message) ? String(err.message) : 'Bad request' });
  }
  if (isUploadFormError(err)) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large.'
      : err.code === 'LIMIT_UNEXPECTED_FILE' ? 'Unexpected file field, or too many files in one upload.'
      : 'The upload could not be read. Send it as multipart/form-data.';
    return res.status(400).json({ error: msg });
  }
  if (isParameterShapeError(err)) {
    // Usually the request's fault, but it can be a route binding its own bad value: keep a line, briefly.
    try { console.warn('[api] parameter refused by the database on %s %s: %s', req.method, url.split('?')[0], err && err.message); } catch { /* */ }
    return res.status(400).json({ error: 'A parameter has the wrong type or is out of range.' });
  }
  try { console.error(`[api] unhandled error on ${req.method} ${url.split('?')[0]}:`, err && err.stack ? err.stack : err); } catch { /* */ }
  return res.status(500).json({ error: 'Internal server error' });
}

/**
 * Refuse a JSON body whose named fields are present but are not text. For the sign-in routes,
 * which anyone can call: every one of them does `.toLowerCase()`, `.trim()` or a hash on these.
 */
function textFields(names) {
  return (req, res, next) => {
    const b = req.body;
    if (b && typeof b === 'object') {
      for (const n of names) {
        if (b[n] !== undefined && b[n] !== null && typeof b[n] !== 'string') {
          return res.status(400).json({ error: `${n} must be text` });
        }
      }
    }
    next();
  };
}

module.exports = { apiErrorHandler, textFields, isParameterShapeError };
