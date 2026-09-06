const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  MAX_FRAME_BYTES,
  SidecarClient,
} = require('../services/backend/sidecar-client');

const {
  MAX_OUTBOUND_FRAME_BODY_BYTES,
  encodeFrame,
  parseContentLength,
  annotateSidecarError,
} = require('../services/backend/sidecar-client-transport-codec');

const CRLF = '\r\n';
const CRLFCRLF = '\r\n\r\n';

// ---------------------------------------------------------------------------
// MAX_OUTBOUND_FRAME_BODY_BYTES
// ---------------------------------------------------------------------------

test('MAX_OUTBOUND_FRAME_BODY_BYTES is exactly 10 MiB', () => {
  assert.equal(MAX_OUTBOUND_FRAME_BODY_BYTES, 10 * 1024 * 1024);
});

test('SidecarClient accepts a valid body exactly at the 10 MiB frame limit', () => {
  const client = new SidecarClient();
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.stdin.write = () => true;
  const errors = [];
  client.on('error', (error) => errors.push(error.message));
  client.attachProcess(proc);
  const prefix = Buffer.from('{"id":999,"result":{"x":"');
  const suffix = Buffer.from('"}}');
  const body = Buffer.concat([
    prefix,
    Buffer.alloc(MAX_FRAME_BYTES - prefix.length - suffix.length, 97),
    suffix,
  ]);
  const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);

  client._handleStdoutData(frame);

  assert.equal(client.connected, true);
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------------------
// encodeFrame
// ---------------------------------------------------------------------------

test('encodeFrame produces correct bodyLength for ASCII payload', () => {
  const msg = { hello: 'world' };
  const { frame, bodyLength } = encodeFrame(msg);
  const jsonStr = JSON.stringify(msg);
  const expectedByteLen = Buffer.byteLength(jsonStr, 'utf8');
  assert.equal(bodyLength, expectedByteLen);
  // frame must be a Buffer
  assert.ok(Buffer.isBuffer(frame), 'frame must be a Buffer');
});

test('encodeFrame frame starts with Content-Length header then JSON body', () => {
  const msg = { hello: 'world' };
  const { frame, bodyLength } = encodeFrame(msg);
  const frameStr = frame.toString('utf8');
  const expectedHeader = `Content-Length: ${bodyLength}${CRLFCRLF}`;
  assert.ok(
    frameStr.startsWith(expectedHeader),
    `frame should start with "${expectedHeader}" but got "${frameStr.slice(0, 60)}"`
  );
  const body = frameStr.slice(expectedHeader.length);
  assert.deepEqual(JSON.parse(body), msg);
});

test('encodeFrame bodyLength is utf8 BYTE length not JS string char length (non-ASCII)', () => {
  // U+00F6 LATIN SMALL LETTER O WITH DIAERESIS encodes as 2 bytes in utf8
  const msg = { key: 'café' }; // 'café' — é is 2 bytes
  const { frame, bodyLength } = encodeFrame(msg);
  const jsonStr = JSON.stringify(msg);
  const byteLen = Buffer.byteLength(jsonStr, 'utf8');
  // Sanity: the string char length is shorter than the byte length
  assert.ok(byteLen > jsonStr.length, 'utf8 byte length must exceed JS char length for non-ASCII');
  assert.equal(bodyLength, byteLen);
  // Verify the Content-Length header in the frame uses the BYTE length
  const frameStr = frame.toString('utf8');
  const expectedHeader = `Content-Length: ${byteLen}${CRLFCRLF}`;
  assert.ok(frameStr.startsWith(expectedHeader));
});

// ---------------------------------------------------------------------------
// parseContentLength
// ---------------------------------------------------------------------------

test('parseContentLength parses a standard Content-Length header', () => {
  const header = `Content-Length: 42${CRLFCRLF}`;
  assert.equal(parseContentLength(header), 42);
});

test('parseContentLength is case-insensitive', () => {
  const header = `content-length: 7${CRLFCRLF}`;
  assert.equal(parseContentLength(header), 7);
});

test('parseContentLength finds CL line among multiple header lines', () => {
  const header = `X-Request-Id: abc${CRLF}Content-Length: 99${CRLF}Accept: */*${CRLFCRLF}`;
  assert.equal(parseContentLength(header), 99);
});

test('parseContentLength returns 0 when no Content-Length header is present', () => {
  const header = `X-Custom: foo${CRLFCRLF}`;
  assert.equal(parseContentLength(header), 0);
});

test('parseContentLength returns 0 for empty string', () => {
  assert.equal(parseContentLength(''), 0);
});

test('parseContentLength returns 0 for undefined', () => {
  assert.equal(parseContentLength(undefined), 0);
});

// ---------------------------------------------------------------------------
// annotateSidecarError
// ---------------------------------------------------------------------------

test('annotateSidecarError returns the SAME object reference', () => {
  const err = new Error('test');
  const result = annotateSidecarError(err, { errorCode: 'E001', category: 'network' });
  assert.strictEqual(result, err, 'must return same object reference');
});

test('annotateSidecarError sets error_code and category as strings', () => {
  const err = new Error('test');
  annotateSidecarError(err, { errorCode: 404, category: 'not_found' });
  assert.equal(err.error_code, '404');
  assert.equal(err.category, 'not_found');
});

test('annotateSidecarError sets both cancel_reason and cancelReason for cancelReason option', () => {
  const err = new Error('cancelled');
  annotateSidecarError(err, { cancelReason: 'user_stop' });
  assert.equal(err.cancel_reason, 'user_stop');
  assert.equal(err.cancelReason, 'user_stop');
});

test('annotateSidecarError sets terminal_subcode', () => {
  const err = new Error('term');
  annotateSidecarError(err, { terminalSubcode: 'plan_drift' });
  assert.equal(err.terminal_subcode, 'plan_drift');
});

test('annotateSidecarError coerces retryable strictly (truthy string "yes" -> false)', () => {
  const err = new Error('test');
  annotateSidecarError(err, { retryable: 'yes' });
  assert.equal(err.retryable, false);
});

test('annotateSidecarError sets retryable true when retryable:true', () => {
  const err = new Error('test');
  annotateSidecarError(err, { retryable: true });
  assert.equal(err.retryable, true);
});

test('annotateSidecarError defaults retryable to true when omitted', () => {
  const err = new Error('test');
  annotateSidecarError(err, {});
  assert.equal(err.retryable, true);
});

test('annotateSidecarError returns null unchanged', () => {
  const result = annotateSidecarError(null, { errorCode: 'X' });
  assert.equal(result, null);
});

test('annotateSidecarError returns a string primitive unchanged', () => {
  const result = annotateSidecarError('not an object', { errorCode: 'X' });
  assert.equal(result, 'not an object');
});
