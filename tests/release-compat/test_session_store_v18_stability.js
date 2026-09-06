const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('../helpers/resource-cleanup');

test.afterEach(async () => cleanupTrackedResources());

test('release-compat: v18 plugin-session payload loads without byte churn', () => {
  const tmpRoot = createTrackedTempDir('jenny-release-compat-v18-');
  const fixtureRoot = path.join(__dirname, 'fixtures', 'userdata-v18-current');
  const sessionsPath = path.join(tmpRoot, 'sessions.json');
  const sessionsDir = path.join(tmpRoot, 'sessions');
  fs.cpSync(path.join(fixtureRoot, 'sessions'), sessionsDir, { recursive: true });
  const paths = [
    path.join(sessionsDir, '_index.json'),
    path.join(sessionsDir, 'frontier_diag_v17_current.json'),
    path.join(sessionsDir, 'image_sess_v17_current.json'),
  ];
  const before = paths.map((filePath) => fs.readFileSync(filePath, 'utf8'));
  const logs = [];
  const store = new ElectronSessionStore(sessionsPath, {
    logger: (level, event, details = {}) => logs.push({ level, event, details }),
  });

  // A legacy payload below STORE_SCHEMA_VERSION queues its split-layout
  // migration on load but must not rewrite anything until that migration is
  // explicitly run. Asserting `false` here pinned the fixture to whatever the
  // schema happened to be the day it was written (18) and rotted the moment the
  // store moved to 19; the durable invariant is that queuing costs zero bytes.
  // The v18 -> current upgrade itself is covered by
  // test_session_store_compat.js's runPendingMigrations() case.
  assert.equal(store.hasPendingMigrations(), true);
  assert.equal(store.getSession('frontier_diag_v17_current').session_type, 'chat');
  const plugin = store.getSession('image_sess_v17_current');
  assert.equal(plugin.session_type, 'plugin');
  assert.equal(plugin.plugin_session.plugin_id, 'local-image-generation');
  assert.deepEqual(plugin.plugin_session.state, {
    model_id: 'HiDream-ai/HiDream-O1-Image', resolution: '2048x2048', steps: 50,
  });
  assert.deepEqual(paths.map((filePath) => fs.readFileSync(filePath, 'utf8')), before);
  assert.equal(logs.find((entry) => (
    entry.event === 'session_store.split_schema_migration_completed'
  )), undefined);
});
