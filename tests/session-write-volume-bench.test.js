'use strict';

const assert = require('node:assert/strict');
const { buildFeatureFlagDefaults } = require('../services/feature-flags');
const fs = require('node:fs');
const test = require('node:test');

const { formatMarkdownTable, runBench } = require('../scripts/perf/session-write-volume');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('runBench reports both turns with write volume and a smaller content delta, and cleans up', async () => {
  const tmpRoot = createTrackedTempDir('jenny-write-volume-bench-');
  const rows = await runBench({ sizesMb: [0.02], toolPairs: 2, otherSessions: 3, tmpRoot });

  assert.deepEqual(rows.map((row) => row.turn), ['short', 'tool_heavy']);
  for (const row of rows) {
    assert.ok(row.session_size_bytes > 0);
    assert.ok(row.session_bytes > 0);
    assert.ok(row.session_writes >= 2);
    assert.equal(row.session_sync_writes + row.session_debounced_writes, row.session_writes);
    assert.ok(row.index_writes > 0);
    assert.ok(row.serialize_ms_total > 0);
    assert.ok(row.content_delta_bytes > 0);
    assert.ok(row.content_delta_max_bytes > 0);
    assert.ok(row.content_delta_max_bytes <= row.content_delta_bytes);
  }
  assert.ok(rows[1].mutations > rows[0].mutations);
  // With the kill switch (JENNY_ENABLE_SESSION_JOURNAL=0) every write is the whole chat.
  if (buildFeatureFlagDefaults().session_journal) {
    assert.ok(rows[0].session_bytes < rows[0].session_size_bytes, 'a short turn appends instead of rewriting the chat');
  }
  assert.ok(rows[1].session_debounced_writes >= 2, 'each tool pair lands in its own debounced write');

  assert.deepEqual(fs.readdirSync(tmpRoot), [], 'the bench removes its temp directory');
  assert.match(formatMarkdownTable(rows), /\| 0\.02 \|/);
});
