'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  runPackagedAttachmentRehydration,
} = require('../scripts/tests/packaged-attachment-rehydration');

test('service attachment evidence rehydrates the managed copy after store reopen', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-w1a-rehydrate-test-'));
  const outputPath = path.join(tempRoot, 'evidence.json');
  try {
    const evidence = runPackagedAttachmentRehydration({ outputPath, tempRoot });
    assert.equal(evidence.status, 'passed');
    assert.equal(evidence.gate, 'service_attachment_rehydration');
    assert.equal(evidence.composer_import, undefined);
    assert.equal(evidence.image_decoder, 'fixture');
    assert.equal(evidence.same_process_store_reopen, true);
    assert.equal(evidence.managed_attachment_storage, true);
    assert.equal(evidence.attachment_exists_after_reopen, true);

    const serialized = fs.readFileSync(outputPath, 'utf8');
    assert.doesNotMatch(serialized, /jenny-w1a-rehydrate-test/i);
    assert.doesNotMatch(serialized, /fixture\.png/i);
    assert.doesNotMatch(serialized, /assetPath|content/i);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
