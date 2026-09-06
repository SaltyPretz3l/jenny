'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  TERMINAL_REPAIR_SCHEMA_VERSION,
  TerminalRepairStore,
} = require('../../services/backend/terminal-repair-store');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('../helpers/resource-cleanup');

const FIXTURE_ROOT = path.join(__dirname, 'fixtures');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function loadFixture(fixtureDir) {
  const tmpRoot = createTrackedTempDir(`jenny-terminal-repair-compat-${fixtureDir}-`);
  const sourcePath = path.join(FIXTURE_ROOT, fixtureDir, 'terminal-repairs.json');
  const targetPath = path.join(tmpRoot, 'terminal-repairs.json');
  fs.copyFileSync(sourcePath, targetPath);
  return targetPath;
}

function currentArtifact() {
  return {
    artifact_id: 'repair_attempted_by_current_app',
    session_id: 'session_current_app',
    session_incarnation: 'inc_current_app',
    turn_generation: 1,
    turn_id: 'turn_current_app',
    stream_id: 'stream_current_app',
    message: {
      id: 'assistant_current_app',
      role: 'assistant',
      content: 'Current app retry payload.',
      status: 'complete',
    },
    terminal_snapshot: {
      kind: 'complete',
      terminal: { kind: 'complete' },
      messages: [],
      tool_repairs: [],
      turn_events: [],
      preference_patch: {},
      title: null,
    },
  };
}

test('release-compat: terminal repair v1 loads without rewriting current-schema bytes', () => {
  const filePath = loadFixture('terminal-repair-v1-current');
  const beforeBytes = fs.readFileSync(filePath, 'utf8');
  const store = new TerminalRepairStore(filePath);

  assert.equal(TERMINAL_REPAIR_SCHEMA_VERSION, 1);
  assert.equal(store.hasNewerSchema(), false);
  const [repair] = store.listPending('session_release_v1');
  assert.equal(repair.artifact_id, 'repair_release_v1');
  assert.equal(repair.message.id, 'assistant_release_v1');
  assert.equal(repair.message.content, 'Visible reply awaiting a durable retry.');
  assert.equal(repair.terminal_snapshot.kind, 'complete');
  assert.equal(store.flush(), true);
  store.dispose();

  assert.equal(fs.readFileSync(filePath, 'utf8'), beforeBytes);
});

test('release-compat: future terminal repair schema is preserved byte-for-byte and blocks writes', () => {
  const filePath = loadFixture('terminal-repair-v2-future');
  const beforeBytes = fs.readFileSync(filePath, 'utf8');
  const store = new TerminalRepairStore(filePath);

  assert.equal(store.hasNewerSchema(), true);
  assert.deepEqual(store.listPending(), []);
  assert.equal(store.savePending(currentArtifact()).reason, 'newer_schema');
  assert.equal(store.deleteSession('session_release_v2').reason, 'newer_schema');
  const futureIdentity = {
    session_id: 'session_release_v2',
    session_incarnation: 'inc_release_v2',
    turn_generation: 8,
  };
  assert.equal(
    store.markDiscarded('repair_release_v2', futureIdentity).reason,
    'artifact_not_found'
  );
  assert.equal(
    store.clearResolved('repair_release_v2', futureIdentity).reason,
    'already_cleared'
  );
  assert.equal(store.flush(), true);
  store.dispose();

  assert.equal(fs.readFileSync(filePath, 'utf8'), beforeBytes);
});
