'use strict';

const crypto = require('node:crypto');

const STRONG_ETAG = /^"[\x21\x23-\x7e]+"$/;
function parseContentRange(value) {
  const match = typeof value === 'string' && value.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!match) return null;
  const start = Number(match[1]); const end = Number(match[2]); const total = Number(match[3]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && Number.isSafeInteger(total)
    && start <= end && end < total ? { start, end, total } : null;
}
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

async function resumableDownload({ request, requestInput, sourceIdentityDigest, readPartial, writePartial, discardPartial, maxBytes }) {
  let partial = await readPartial();
  const usable = partial && Buffer.isBuffer(partial.bytes) && partial.bytes.length > 0
    && partial.source_identity_digest === sourceIdentityDigest && STRONG_ETAG.test(partial.etag || '');
  if (partial && !usable) { await discardPartial(); partial = null; }
  const execute = async (resume) => request({
    ...requestInput,
    headers: resume ? { ...(requestInput.headers || {}), range: `bytes=${partial.bytes.length}-`, 'if-range': partial.etag } : requestInput.headers,
    limits: { ...(requestInput.limits || {}), max_response_bytes: maxBytes },
  });
  // A truncated transport failure carries the bytes it did receive (bounded-http-client
  // adds partial_body on response_stream_failed). Only a STRONG ETag makes them worth
  // keeping: a weak/absent validator cannot be revalidated by if-range, so a saved
  // partial would only be discarded on the next attempt.
  const truncatedBytes = (res) => (res.reason === 'response_stream_failed'
    && Buffer.isBuffer(res.partial_body) && res.partial_body.length > 0
    && STRONG_ETAG.test(res.headers?.etag || '') ? res.partial_body : null);
  // Persist a from-zero prefix. Shared by the first attempt and the post-discard restart
  // so the size/status guard cannot drift between them.
  const persistFresh = async (res, bytes) => {
    if (res.status_code !== 200 || bytes.length > maxBytes) return null;
    await writePartial({ bytes, etag: res.headers.etag, source_identity_digest: sourceIdentityDigest });
    return { ok: false, reason: 'download_incomplete', retryable: true };
  };
  // partial_body is an internal transport detail; a caller that gets the failure back
  // must not receive raw bytes. Copy rather than delete — `response` belongs to the caller.
  const withoutPartial = (res) => {
    if (!Object.hasOwn(res, 'partial_body')) return res;
    const { partial_body: _dropped, ...rest } = res;
    return rest;
  };
  let response = await execute(usable);
  if (!response.ok) {
    const etag = response.headers?.etag;
    const truncated = truncatedBytes(response);
    if (truncated && !usable) {
      const settled = await persistFresh(response, truncated);
      if (settled) return settled;
    }
    if (truncated && usable && response.status_code === 206) {
      const range = parseContentRange(response.headers?.['content-range']);
      if (range && range.start === partial.bytes.length
        && truncated.length <= range.end - range.start + 1 && etag === partial.etag
        && range.total <= maxBytes && partial.bytes.length + truncated.length <= maxBytes) {
        await writePartial({ bytes: Buffer.concat([partial.bytes, truncated]), etag,
          source_identity_digest: sourceIdentityDigest });
        return { ok: false, reason: 'download_incomplete', retryable: true };
      }
    }
    return withoutPartial(response);
  }
  if (usable) {
    const range = parseContentRange(response.headers?.['content-range']);
    const etag = response.headers?.etag;
    if (response.status_code !== 206 || !range || range.start !== partial.bytes.length
      || range.end - range.start + 1 !== response.body.length || etag !== partial.etag
      || range.total > maxBytes) {
      await discardPartial(); partial = null; response = await execute(false);
      if (!response.ok) {
        const truncated = truncatedBytes(response);
        if (truncated) {
          const settled = await persistFresh(response, truncated);
          if (settled) return settled;
        }
        return withoutPartial(response);
      }
    } else {
      const bytes = Buffer.concat([partial.bytes, response.body]);
      if (bytes.length !== range.total || bytes.length > maxBytes) { await discardPartial(); return { ok: false, reason: 'resume_content_range_mismatch', retryable: false }; }
      await discardPartial(); return { ...response, status_code: 200, bytes, digest: sha256(bytes), resumed: true };
    }
  }
  if (response.status_code !== 200 || response.body.length > maxBytes) return { ok: false, reason: 'download_response_invalid', retryable: false };
  const etag = response.headers?.etag;
  if (STRONG_ETAG.test(etag || '') && response.body.length < Number(response.headers?.['content-length'] || response.body.length)) {
    await writePartial({ bytes: response.body, etag, source_identity_digest: sourceIdentityDigest });
    return { ok: false, reason: 'download_incomplete', retryable: true };
  }
  return { ...response, bytes: response.body, digest: sha256(response.body), resumed: false };
}

module.exports = { STRONG_ETAG, parseContentRange, resumableDownload };
