'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readProcessLogHistory } = require('../services/process-log-reader');

test('reads rotated NDJSON oldest-to-newest with CRLF, malformed isolation, and partial-tail exclusion', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-process-log-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'shell.log');
  fs.writeFileSync(`${filePath}.1`, '{"entry_id":"old"}\r\nnot-json\r\n');
  fs.writeFileSync(filePath, '{"entry_id":"new"}\n{"entry_id":"partial"}');
  const result = await readProcessLogHistory({ filePath });
  assert.deepEqual(result.entries.map((entry) => entry.entry_id), ['old', 'new']);
  assert.equal(result.malformed_count, 1);
  assert.equal(result.errors.length, 0);
});

test('missing history degrades to an empty result', async (t) => {
  // A fixed name under os.tmpdir() is absent only by convention: one stray file
  // (or a concurrent run) turns this into a test of the parse path. A child of a
  // directory created this instant cannot exist.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-process-log-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await readProcessLogHistory({ filePath: path.join(root, 'shell.log') });
  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.errors, []);
});

test('an exact byte-budget fit is complete rather than falsely truncated', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-process-log-exact-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'shell.log');
  const prefix = '{"entry_id":"exact"}';
  fs.writeFileSync(filePath, prefix + ' '.repeat(1024 - prefix.length - 1) + '\n');
  const result = await readProcessLogHistory({ filePath, maxBytes: 1024 });
  assert.equal(result.truncated, false);
  assert.equal(result.entries[0].entry_id, 'exact');
});
