'use strict';

// new-test-file: background-job-output.js is a new module
// Row 138: the background-job output view. tailOutput caps a finished job's
// status.json output; readLiveOutput validates the sidecar's live-output.json.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_LIVE_OUTPUT_FILE_BYTES,
  MAX_OUTPUT_CHARS,
  MAX_OUTPUT_LINES,
  readLiveOutput,
  tailOutput,
} = require('../services/main/background-job-output');

const JOB_ID = 'abc123def456';

test('tailOutput keeps the last two hundred lines and sixteen thousand characters', () => {
  assert.deepEqual([MAX_OUTPUT_LINES, MAX_OUTPUT_CHARS], [200, 16_000]);
  const lines = Array.from({ length: 250 }, (_, index) => `line ${index}`);
  const byLines = tailOutput({ stdout: `${lines.join('\n')}\n` });
  assert.equal(byLines.truncated, true);
  assert.equal(byLines.text.split('\n').length, MAX_OUTPUT_LINES);
  assert.ok(byLines.text.startsWith('line 50') && byLines.text.endsWith('line 249'));

  const byChars = tailOutput({ stdout: `${'x'.repeat(20_000)}END` });
  assert.equal(byChars.text.length, MAX_OUTPUT_CHARS);
  assert.ok(byChars.text.endsWith('END'));
  assert.equal(byChars.truncated, true);

  assert.deepEqual(tailOutput({ stdout: 'out\n', stderr: 'err\n' }), { text: 'out\n\nerr', truncated: false });
  assert.deepEqual(tailOutput({ stdout: 'out', output_truncated: true }), { text: 'out', truncated: true });
  assert.deepEqual(tailOutput({ stdout: 7, stderr: null }), { text: '', truncated: false });
});

test('tailOutput never starts on the low half of a surrogate pair', () => {
  // U+1F600 is two UTF-16 units; slicing the last 16,000 units lands between them.
  const stdout = `${String.fromCodePoint(0x1f600)}${'a'.repeat(MAX_OUTPUT_CHARS - 1)}`;
  const { text, truncated } = tailOutput({ stdout });
  assert.equal(truncated, true);
  assert.equal(text, 'a'.repeat(MAX_OUTPUT_CHARS - 1));
});

function liveFile(t, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-live-output-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'live-output.json');
  if (contents !== undefined) fs.writeFileSync(filePath, contents);
  return filePath;
}

const body = (overrides = {}) => JSON.stringify({
  schema_version: 1, job_id: JOB_ID, text: 'compiling\nlinking\n', truncated: false, updated_at_ms: 1, ...overrides,
});

test('readLiveOutput accepts a valid file and caps its text', (t) => {
  assert.deepEqual(readLiveOutput(liveFile(t, body()), { jobId: JOB_ID }), { text: 'compiling\nlinking', truncated: false });
  assert.deepEqual(readLiveOutput(liveFile(t, body({ truncated: true })), { jobId: JOB_ID }).truncated, true,
    'the sidecar truncated flag carries through');
  const many = Array.from({ length: 300 }, (_, index) => `row ${index}`).join('\n');
  const capped = readLiveOutput(liveFile(t, body({ text: many })), { jobId: JOB_ID });
  assert.equal(capped.text.split('\n').length, MAX_OUTPUT_LINES);
  assert.equal(capped.truncated, true);
});

test('readLiveOutput rejects every invalid file with null and never throws', (t) => {
  const reject = (label, filePath, jobId = JOB_ID) => assert.equal(readLiveOutput(filePath, { jobId }), null, label);
  reject('wrong job_id', liveFile(t, body({ job_id: 'ffffffffffff' })));
  reject('missing job id option', liveFile(t, body()), '');
  reject('wrong schema', liveFile(t, body({ schema_version: 2 })));
  reject('non-string text', liveFile(t, body({ text: ['a'] })));
  reject('array payload', liveFile(t, '[1,2]'));
  reject('unparsable', liveFile(t, 'not json {{'));
  reject('missing file', liveFile(t));
  reject('oversized', liveFile(t, body({ text: 'x'.repeat(MAX_LIVE_OUTPUT_FILE_BYTES) })));
  assert.equal(readLiveOutput('ignored', { jobId: JOB_ID, readFileImpl: () => { throw new Error('boom'); } }), null,
    'a throwing reader is null');
});
