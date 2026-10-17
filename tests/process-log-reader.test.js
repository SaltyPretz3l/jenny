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

test('excludes the current run before entry and byte budgets across rotated files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-process-log-exclude-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'shell.log');
  const prior = Array.from({ length: 50 }, (_, index) => ({ run_id: 'prior', entry_id: `prior.${index}` }));
  fs.writeFileSync(`${filePath}.1`, prior.map((entry) => JSON.stringify(entry) + '\r\n').join(''));
  fs.writeFileSync(filePath, (JSON.stringify({ run_id: 'current', message: 'x'.repeat(2000) }) + '\n').repeat(2500));
  const result = await readProcessLogHistory({ filePath, excludeRunId: 'current' });
  assert.deepEqual(result.entries, prior);
  assert.equal(result.truncated, false);
});

test('excluded history still bounds retained rows, isolates malformed lines, and skips partial tails', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-process-log-filtered-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'shell.log');
  fs.writeFileSync(filePath, '{"run_id":"prior","entry_id":"old"}\nnot-json\r\n'
    + '{"run_id":"current"}\n{"entry_id":"legacy"}\n{"entry_id":"partial"}');
  const result = await readProcessLogHistory({ filePath, excludeRunId: 'current', maxEntries: 1 });
  assert.deepEqual(result.entries, [{ entry_id: 'legacy' }]);
  assert.equal(result.truncated, true);
  assert.equal(result.malformed_count, 1);
});

test('excluded history enforces byte budgets and accepts exact fits', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-process-log-filtered-bytes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'shell.log');
  const prefix = '{"run_id":"prior","entry_id":"exact"}';
  const exactLine = prefix + ' '.repeat(1024 - prefix.length - 1) + '\n';
  const current = '{"run_id":"current","entry_id":"excluded"}\n';
  fs.writeFileSync(filePath, exactLine + current);
  const exact = await readProcessLogHistory({ filePath, excludeRunId: 'current', maxBytes: 1024 });
  assert.deepEqual(exact.entries.map((entry) => entry.entry_id), ['exact']);
  assert.equal(exact.truncated, false);
  fs.writeFileSync(filePath, '{"entry_id":"older"}\n' + exactLine + current);
  const bounded = await readProcessLogHistory({ filePath, excludeRunId: 'current', maxBytes: 1024 });
  assert.deepEqual(bounded.entries.map((entry) => entry.entry_id), ['exact']);
  assert.equal(bounded.truncated, true);
});

test('an oversized or newline-free line is skipped without being buffered whole', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-process-log-oversized-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'shell.log');
  const huge = 'x'.repeat(6 * 1024 * 1024);
  fs.writeFileSync(filePath, `{"entry_id":"a"}\n${huge}\n{"entry_id":"b"}\n${huge}`);
  const concat = Buffer.concat;
  let largest = 0;
  Buffer.concat = function (list, length) {
    const result = concat.call(Buffer, list, length);
    largest = Math.max(largest, result.length);
    return result;
  };
  let result;
  try {
    // excludeRunId selects the newest-first reader (the prior-launch history path).
    result = await readProcessLogHistory({ filePath, maxBytes: 64 * 1024 * 1024, excludeRunId: 'current' });
  } finally {
    Buffer.concat = concat;
  }
  assert.deepEqual(result.entries.map((entry) => entry.entry_id), ['a', 'b']);
  assert.equal(result.malformed_count, 1, 'the terminated oversized line counts once; the unterminated tail is skipped');
  assert.ok(largest < 2 * 1024 * 1024, `held ${largest} bytes of one line`);
});
