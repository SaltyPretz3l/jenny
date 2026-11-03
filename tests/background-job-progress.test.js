'use strict';

// Row 96: progress.json reader for background test jobs
// (services/main/background-job-progress.js). The file is workspace-writable,
// so every field is untrusted.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_PROGRESS_FILE_BYTES,
  readBoundedTextFile,
  readJobProgress,
} = require('../services/main/background-job-progress');

const JOB_ID = 'abc123def456';

function read(payload, jobId = JOB_ID) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return readJobProgress('p/progress.json', { jobId, readFileImpl: () => ({ ok: true, text }) });
}

function valid(overrides = {}) {
  return {
    schema_version: 1, job_id: JOB_ID, runner: 'pytest', total_unit: 'tests', percent: 54.5, done: 8677,
    total: 16068, failed: 3, skipped: 65, failure_marks: [0.1, 0.9], failures: ['t1'], updated_at_ms: 1,
    ...overrides,
  };
}

test('reads a valid file and drops unknown keys', () => {
  assert.deepEqual(read(valid({ secret: 'x' })), {
    percent: 54.5, done: 8677, total: 16068, totalUnit: 'tests', failed: 3, failureMarks: [0.1, 0.9],
  });
});

test('null total and percent stay null', () => {
  const out = read(valid({ total: null, percent: null, total_unit: 'files' }));
  assert.equal(out.total, null);
  assert.equal(out.percent, null);
  assert.equal(out.totalUnit, 'files');
});

test('wrong schema_version or mismatched job_id is rejected', () => {
  assert.equal(read(valid({ schema_version: 2 })), null);
  assert.equal(read(valid({ schema_version: '1' })), null);
  assert.equal(read(valid({ job_id: 'ffffffffffff' })), null);
  assert.equal(read(valid({ job_id: undefined })), null);
  assert.equal(read(valid(), 'ffffffffffff'), null);
});

test('malformed, non-object and unreadable files give null', () => {
  assert.equal(read('{nope'), null);
  assert.equal(read('[]'), null);
  assert.equal(read('"x"'), null);
  assert.equal(read('null'), null);
  assert.equal(readJobProgress('p', { jobId: JOB_ID, readFileImpl: () => ({ ok: false, reason: 'not_found' }) }), null);
  assert.equal(readJobProgress('p', { jobId: JOB_ID, readFileImpl: () => { throw new Error('boom'); } }), null);
});

test('hostile values are clamped', () => {
  const out = read(valid({
    percent: 900, done: -4, total: 1e300, failed: 'many', total_unit: '<b>',
    failure_marks: [-1, 0.5, 5, 'x', null, NaN, ...Array.from({ length: 100 }, () => 0.25)],
  }));
  assert.equal(out.percent, 100);
  assert.equal(out.done, 0);
  assert.equal(out.total, Number.MAX_SAFE_INTEGER);
  assert.equal(out.failed, 0);
  assert.equal(out.totalUnit, 'tests');
  assert.equal(out.failureMarks.length, 50);
  assert.deepEqual(out.failureMarks.slice(0, 3), [0, 0.5, 1]);
  assert.equal(read(valid({ percent: -3 })).percent, 0);
  assert.equal(read(valid({ percent: 'half' })).percent, null);
  assert.deepEqual(read(valid({ failure_marks: 'nope' })).failureMarks, []);
});

test('the default reader refuses a file over the 16 KB cap and a missing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-progress-'));
  try {
    const file = path.join(dir, 'progress.json');
    fs.writeFileSync(file, JSON.stringify(valid()));
    assert.equal(readJobProgress(file, { jobId: JOB_ID }).done, 8677);
    fs.writeFileSync(file, JSON.stringify(valid({ pad: 'x'.repeat(MAX_PROGRESS_FILE_BYTES) })));
    assert.equal(readJobProgress(file, { jobId: JOB_ID }), null);
    assert.deepEqual(readBoundedTextFile(file, MAX_PROGRESS_FILE_BYTES), { ok: false, reason: 'too_large' });
    assert.deepEqual(readBoundedTextFile(path.join(dir, 'missing.json'), 16), { ok: false, reason: 'not_found' });
    assert.equal(readJobProgress(path.join(dir, 'missing.json'), { jobId: JOB_ID }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MAX_PROGRESS_FILE_BYTES is 16 KB', () => {
  assert.equal(MAX_PROGRESS_FILE_BYTES, 16384);
});
