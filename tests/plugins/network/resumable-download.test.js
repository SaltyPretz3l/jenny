'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { parseContentRange, resumableDownload } = require('../../../services/plugins/network/resumable-download');
test('content ranges are exact and resumable downloads append only a matching strong ETag', async () => {
  assert.deepEqual(parseContentRange('bytes 3-5/6'), { start: 3, end: 5, total: 6 });
  let discarded = 0;
  const result = await resumableDownload({ request: async (input) => {
    assert.equal(input.headers.range, 'bytes=3-');
    return { ok: true, status_code: 206, headers: { etag: '"v1"', 'content-range': 'bytes 3-5/6' }, body: Buffer.from('def') };
  }, requestInput: { headers: {} }, sourceIdentityDigest: 'a'.repeat(64),
  readPartial: async () => ({ bytes: Buffer.from('abc'), etag: '"v1"', source_identity_digest: 'a'.repeat(64) }),
  writePartial: async () => {}, discardPartial: async () => { discarded += 1; }, maxBytes: 64 });
  assert.equal(result.bytes.toString(), 'abcdef'); assert.equal(result.resumed, true); assert.equal(discarded, 1);
});
test('weak validators are discarded before a full restart', async () => {
  let discarded = 0; const result = await resumableDownload({ request: async () => ({ ok: true, status_code: 200, headers: {}, body: Buffer.from('fresh') }),
    requestInput: {}, sourceIdentityDigest: 'b'.repeat(64), readPartial: async () => ({ bytes: Buffer.from('old'), etag: 'W/"v"', source_identity_digest: 'b'.repeat(64) }),
    writePartial: async () => {}, discardPartial: async () => { discarded += 1; }, maxBytes: 64 });
  assert.equal(result.bytes.toString(), 'fresh'); assert.equal(discarded, 1);
});

test('fresh stream failure persists bytes guarded by a strong ETag', async () => {
  const writes = []; const sourceIdentityDigest = 'c'.repeat(64);
  const result = await resumableDownload({ request: async () => ({ ok: false,
    reason: 'response_stream_failed', retryable: true, status_code: 200,
    headers: { etag: '"v1"' }, partial_body: Buffer.from('partial') }), requestInput: {},
  sourceIdentityDigest, readPartial: async () => null,
  writePartial: async (partial) => { writes.push(partial); }, discardPartial: async () => {}, maxBytes: 64 });
  assert.deepEqual(result, { ok: false, reason: 'download_incomplete', retryable: true });
  assert.deepEqual(writes, [{ bytes: Buffer.from('partial'), etag: '"v1"',
    source_identity_digest: sourceIdentityDigest }]);
});

test('fresh stream failure with a weak ETag is returned unchanged', async () => {
  let writes = 0; const failure = { ok: false, reason: 'response_stream_failed', retryable: true,
    status_code: 200, headers: { etag: 'W/"v1"' }, partial_body: Buffer.from('partial') };
  const result = await resumableDownload({ request: async () => failure, requestInput: {},
    sourceIdentityDigest: 'd'.repeat(64), readPartial: async () => null,
    writePartial: async () => { writes += 1; }, discardPartial: async () => {}, maxBytes: 64 });
  assert.equal(Object.hasOwn(result, 'partial_body'), false, 'internal bytes never reach the caller');
  assert.deepEqual(result, { ok: false, reason: 'response_stream_failed', retryable: true,
    status_code: 200, headers: { etag: 'W/"v1"' } });
  assert.equal(writes, 0);
});

test('truncated resume rejects a content range starting at the wrong offset', async () => {
  let writes = 0; const sourceIdentityDigest = 'e'.repeat(64);
  const failure = { ok: false, reason: 'response_stream_failed', retryable: true,
    status_code: 206, headers: { etag: '"v1"', 'content-range': 'bytes 2-5/6' },
    partial_body: Buffer.from('de') };
  const result = await resumableDownload({ request: async (input) => {
    assert.equal(input.headers.range, 'bytes=3-'); return failure;
  }, requestInput: { headers: {} }, sourceIdentityDigest,
  readPartial: async () => ({ bytes: Buffer.from('abc'), etag: '"v1"', source_identity_digest: sourceIdentityDigest }),
  writePartial: async () => { writes += 1; }, discardPartial: async () => {}, maxBytes: 64 });
  assert.equal(Object.hasOwn(result, 'partial_body'), false, 'internal bytes never reach the caller');
  assert.deepEqual(result, { ok: false, reason: 'response_stream_failed', retryable: true,
    status_code: 206, headers: { etag: '"v1"', 'content-range': 'bytes 2-5/6' } });
  assert.equal(writes, 0);
  assert.ok(Buffer.isBuffer(failure.partial_body), 'the strip must not mutate the transport result');
});

test('truncated resume appends a matching prefix in order', async () => {
  const writes = []; const sourceIdentityDigest = 'f'.repeat(64);
  const result = await resumableDownload({ request: async (input) => {
    assert.equal(input.headers.range, 'bytes=3-');
    return { ok: false, reason: 'response_stream_failed', retryable: true, status_code: 206,
      headers: { etag: '"v1"', 'content-range': 'bytes 3-5/6' }, partial_body: Buffer.from('de') };
  }, requestInput: { headers: {} }, sourceIdentityDigest,
  readPartial: async () => ({ bytes: Buffer.from('abc'), etag: '"v1"', source_identity_digest: sourceIdentityDigest }),
  writePartial: async (partial) => { writes.push(partial); }, discardPartial: async () => {}, maxBytes: 64 });
  assert.deepEqual(result, { ok: false, reason: 'download_incomplete', retryable: true });
  assert.deepEqual(writes, [{ bytes: Buffer.from('abcde'), etag: '"v1"',
    source_identity_digest: sourceIdentityDigest }]);
});
