'use strict';

/*
 * ⚠️ THE ONLY SHAPE A STORAGE FAILURE LEAVES THIS DIRECTORY IN.
 *
 * An SDK error is a liability the moment it is logged or returned: the AWS one carries the request
 * it failed on (a presigned query string, an Authorization header), the Azure one carries the
 * request URL — which for a SAS credential IS the credential. So nothing outside lib/storage ever
 * sees one. Every backend catches and rethrows as a StorageError holding only:
 *
 *   code        a short machine word (auth, not_found, no_bucket, network, refused, read_only, ...)
 *   message     a sentence safe to show an operator — written here, never copied from the SDK
 *   sdkCode     the SDK's own error NAME (e.g. "NoSuchBucket", "AuthorizationFailure"), which is a
 *               fixed vocabulary and the single most useful thing in a log line
 *   status      the HTTP status the store answered, when there was one
 *
 * The original error is NOT attached, not even as `cause`, because `cause` is printed by
 * console.error and util.inspect.
 */
class StorageError extends Error {
  constructor(code, message, { sdkCode = null, status = null, profileId = null, key = null } = {}) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.sdkCode = sdkCode ? String(sdkCode).slice(0, 80) : null;
    this.status = status;
    this.profileId = profileId;
    this.key = key;
  }

  /** The one log line format: profile id, key, SDK code. Never a body, never a URL. */
  logLine() {
    return `[storage] profile=${this.profileId || 'local'} key=${this.key || '-'} code=${this.code}`
      + (this.sdkCode ? ` sdk=${this.sdkCode}` : '') + (this.status ? ` status=${this.status}` : '');
  }

  /** What an API body may say. */
  toJSON() { return { code: this.code, error: this.message }; }
}

/** Refused before any network traffic: bad key, read-only profile, outside the managed prefix. */
class StorageRefusedError extends StorageError {
  constructor(message, extra) { super('refused', message, extra); this.name = 'StorageRefusedError'; }
}

const MESSAGES = {
  auth: 'The storage credentials were rejected.',
  not_found: 'The object does not exist.',
  no_bucket: 'The bucket or container does not exist.',
  network: 'The storage endpoint could not be reached.',
  ssrf: 'That storage endpoint is not allowed from this server.',
  timeout: 'The storage endpoint did not answer in time.',
  precondition: 'The object changed while it was being read.',
  unavailable: 'The storage SDK for this provider is not installed on this server.',
  unknown: 'The storage request failed.',
};

/*
 * Classify a thrown SDK/network error. Works on both SDKs because both put the HTTP status where
 * the first two probes look, and both use stable error names.
 */
function classify(err, { profileId = null, key = null } = {}) {
  if (err instanceof StorageError) return err;
  const status = (err && err.$metadata && err.$metadata.httpStatusCode) || (err && err.statusCode) || null;
  const name = (err && (err.name || err.code)) || null;
  const n = String(name || '');
  let code = 'unknown';
  if (err && err.name === 'SsrfError') code = 'ssrf';
  else if (/NoSuchKey|NotFound|BlobNotFound/i.test(n) || (status === 404 && !/Bucket|Container/i.test(n))) code = 'not_found';
  else if (/NoSuchBucket|ContainerNotFound/i.test(n)) code = 'no_bucket';
  else if (/AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|Authoriz|Authentication|Forbidden|InvalidToken|ExpiredToken/i.test(n) || status === 401 || status === 403) code = 'auth';
  else if (/PreconditionFailed|ConditionNotMet/i.test(n) || status === 412) code = 'precondition';
  else if (/Timeout|TimedOut|ETIMEDOUT|AbortError/i.test(n)) code = 'timeout';
  else if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|socket|NetworkingError|RequestError/i.test(n)) code = 'network';
  return new StorageError(code, MESSAGES[code], { sdkCode: name, status, profileId, key });
}

/** Is this failure about the LOCATION (counts toward the breaker) rather than the one object? */
function isLocationFailure(err) {
  return !!err && ['network', 'timeout', 'auth', 'no_bucket', 'unknown', 'ssrf'].includes(err.code);
}

module.exports = { StorageError, StorageRefusedError, classify, isLocationFailure, MESSAGES };
