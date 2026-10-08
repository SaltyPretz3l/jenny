// Phase 12B / A.B.6: Electron session-store release-gate compatibility test.
//
// Loads pre-canned userData fixtures pinned at every supported legacy
// schema_version and verifies they migrate cleanly to STORE_SCHEMA_VERSION.
// The fixtures are hand-authored from real legacy session shapes; each file
// includes the markers the matching repairSessionForV<N> step is designed
// to detect, so a regression in any cascade step surfaces here.
//
// App-version dimension: every fixture pins the assumption that
// `package.json:version` is `1.2.0`. The lockstep_release policy
// (services/backend/schema-version-registry.js) treats schema versions as
// release-coupled; if the app version bumps without a matching
// userdata-v<N> fixture being added, the release gate fails fast at
// assertion time.

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ElectronSessionStore,
} = require('../../services/backend/electron-session-store');
const { GENERAL_PROJECT_ID } = require('../../services/projects/project-schema');
const { JournaledJsonStore } = require('../../services/backend/journaled-json-store');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('../helpers/resource-cleanup');

const FIXTURE_ROOT = path.join(__dirname, 'fixtures');
const APP_VERSION = require('../../package.json').version;
const EXPECTED_APP_VERSION = '1.4.0';
const EXPECTED_SCHEMA_VERSION = 24;
const FIXTURE_DIRS = [
  'userdata-v3',
  'userdata-v4',
  'userdata-v5',
  'userdata-v6',
  'userdata-v7',
  'userdata-v9-current',
  'userdata-v11',
  'userdata-v12-current',
  'userdata-v13-current',
  'userdata-v14-current',
  'userdata-v15-current',
  'userdata-v16-current',
  'userdata-v17-current',
  'userdata-v18-current',
  'userdata-v19-current',
  'userdata-v20-current',
  'userdata-v21-current',
  'userdata-v22-image-interrupted',
  'userdata-v23-current',
  'userdata-v24-current',
  'userdata-v24-journal-recovery',
];

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createLogCollector() {
  const entries = [];
  return {
    entries,
    logger(level, event, details = {}) {
      entries.push({ level, event, details });
    },
  };
}

function loadFixture(fixtureDir) {
  const tmpRoot = createTrackedTempDir(`jenny-release-compat-${fixtureDir}-`);
  const sourceRoot = path.join(FIXTURE_ROOT, fixtureDir);
  const sourceSessions = path.join(sourceRoot, 'sessions.json');
  const targetSessions = path.join(tmpRoot, 'sessions.json');
  if (fs.existsSync(sourceSessions)) {
    fs.copyFileSync(sourceSessions, targetSessions);
  }
  const sourceSplitSessions = path.join(sourceRoot, 'sessions');
  if (fs.existsSync(sourceSplitSessions)) {
    fs.cpSync(sourceSplitSessions, path.join(tmpRoot, 'sessions'), { recursive: true });
  }
  return { tmpRoot, sessionsPath: targetSessions };
}

function sessionsDirFromPath(sessionsPath) {
  return path.join(path.dirname(sessionsPath), 'sessions');
}

function indexFilePathFromSessionsPath(sessionsPath) {
  return path.join(sessionsDirFromPath(sessionsPath), '_index.json');
}

function sessionFilePathFromSessionsPath(sessionsPath, sessionId) {
  return path.join(sessionsDirFromPath(sessionsPath), `${sessionId}.json`);
}

function readPersistedPayload(sessionsPath) {
  const indexPath = indexFilePathFromSessionsPath(sessionsPath);
  if (fs.existsSync(indexPath)) {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  }
  return JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
}

test('release-compat: app version pin matches the release-gate assumption', () => {
  // The fixture corpus is authored against a specific app version. When the
  // app version bumps, this assertion fires first and forces the implementer
  // to either add a fixture for the new schema dimension or to revisit the
  // lockstep_release policy.
  assert.equal(
    APP_VERSION,
    EXPECTED_APP_VERSION,
    `app version drifted to '${APP_VERSION}'. If the bump is intentional, add or refresh `
      + 'tests/release-compat/fixtures/userdata-v<N>/ for the new schema and update '
      + 'EXPECTED_APP_VERSION in tests/release-compat/test_session_store_compat.js.'
  );
});

test('release-compat: v3 legacy linked_session_ids are deduped and self-references stripped', () => {
  const { sessionsPath } = loadFixture('userdata-v3');
  const logs = createLogCollector();
  const store = new ElectronSessionStore(sessionsPath, { logger: logs.logger });

  const persisted = readPersistedPayload(sessionsPath);
  assert.equal(persisted.schema_version, EXPECTED_SCHEMA_VERSION);

  const session = store.getSession('sess_v3_legacy');
  assert.ok(session, 'v3 fixture session must survive migration');
  assert.deepEqual(
    session.linked_session_ids,
    ['sess_other', 'sess_third'],
    'duplicate + self-reference linked_session_ids must be normalized (dedupe sess_other, drop sess_v3_legacy self-ref)'
  );

  const newerSchemaWarn = logs.entries.find((entry) => entry.event === 'session_store.newer_schema_detected');
  assert.equal(newerSchemaWarn, undefined, 'legacy fixture must not trigger newer-schema warning');
});

test('release-compat: v4 dedupes duplicate message ids and settles stale pending approvals', () => {
  const { sessionsPath } = loadFixture('userdata-v4');
  const logs = createLogCollector();
  const store = new ElectronSessionStore(sessionsPath, { logger: logs.logger });

  assert.equal(readPersistedPayload(sessionsPath).schema_version, EXPECTED_SCHEMA_VERSION);

  const messages = store.getSessionMessages('sess_v4_legacy');
  const idCounts = new Map();
  for (const message of messages) {
    if (message.id) {
      idCounts.set(message.id, (idCounts.get(message.id) || 0) + 1);
    }
  }
  for (const [messageId, count] of idCounts.entries()) {
    assert.equal(count, 1, `message id '${messageId}' should be deduped (count=${count})`);
  }

  const stalePending = messages.find(
    (message) => message.kind === 'tool_use'
      && message.tool_call
      && message.tool_call.status === 'pending_approval'
  );
  assert.equal(
    stalePending,
    undefined,
    'stale pending_approval tool_use rows must be normalized to a terminal state'
  );

  const newerSchemaWarn = logs.entries.find((entry) => entry.event === 'session_store.newer_schema_detected');
  assert.equal(newerSchemaWarn, undefined);
});

test('release-compat: v5 normalizes a partial active_turn snapshot', () => {
  const { sessionsPath } = loadFixture('userdata-v5');
  const logs = createLogCollector();
  const store = new ElectronSessionStore(sessionsPath, { logger: logs.logger });

  assert.equal(readPersistedPayload(sessionsPath).schema_version, EXPECTED_SCHEMA_VERSION);

  const activeTurn = store.getActiveTurn('sess_v5_legacy');
  // After normalization a partial snapshot either upgrades to a full record
  // or coerces to null. Either is acceptable; the contract is "no half-state
  // sneaks through to consumers".
  if (activeTurn !== null) {
    assert.ok('request_id' in activeTurn, 'normalized active_turn must expose request_id');
    assert.ok('status' in activeTurn, 'normalized active_turn must expose status');
  }

  const newerSchemaWarn = logs.entries.find((entry) => entry.event === 'session_store.newer_schema_detected');
  assert.equal(newerSchemaWarn, undefined);
});

test('release-compat: v6 canonicalizes assistant status="error" rows', () => {
  const { sessionsPath } = loadFixture('userdata-v6');
  const logs = createLogCollector();
  const store = new ElectronSessionStore(sessionsPath, { logger: logs.logger });

  assert.equal(readPersistedPayload(sessionsPath).schema_version, EXPECTED_SCHEMA_VERSION);

  const messages = store.getSessionMessages('sess_v6_legacy');
  const errorRows = messages.filter((message) => message.role === 'assistant' && message.status === 'error');
  assert.equal(
    errorRows.length,
    0,
    'legacy assistant status="error" rows must be canonicalized away'
  );

  const deniedRow = messages.find(
    (message) => message.role === 'assistant' && message.status === 'denied'
  );
  assert.ok(deniedRow, 'fixture had category=denied marker; expected status=denied after migration');

  const newerSchemaWarn = logs.entries.find((entry) => entry.event === 'session_store.newer_schema_detected');
  assert.equal(newerSchemaWarn, undefined);
});

test('release-compat: v7 re-runs message normalization with last_model_used fallback', () => {
  const { sessionsPath } = loadFixture('userdata-v7');
  const logs = createLogCollector();
  const store = new ElectronSessionStore(sessionsPath, { logger: logs.logger });

  assert.equal(readPersistedPayload(sessionsPath).schema_version, EXPECTED_SCHEMA_VERSION);

  const session = store.getSession('sess_v7_legacy');
  assert.equal(session.last_model_used, 'qwen3:14b');

  const newerSchemaWarn = logs.entries.find((entry) => entry.event === 'session_store.newer_schema_detected');
  assert.equal(newerSchemaWarn, undefined);
});

test('release-compat: v9 monolithic payload migrates into the current split layout', () => {
  const { sessionsPath } = loadFixture('userdata-v9-current');
  const logs = createLogCollector();
  const store = new ElectronSessionStore(sessionsPath, { logger: logs.logger });

  assert.equal(fs.existsSync(indexFilePathFromSessionsPath(sessionsPath)), true);
  assert.equal(fs.existsSync(sessionFilePathFromSessionsPath(sessionsPath, 'sess_v9_current')), true);

  const persisted = readPersistedPayload(sessionsPath);
  assert.equal(persisted.schema_version, EXPECTED_SCHEMA_VERSION);

  const session = store.getSession('sess_v9_current');
  assert.ok(session, 'current fixture session must load');
  assert.equal(session.branch_origin, null);
  assert.equal(
    logs.entries.find((entry) => entry.event === 'session_store.newer_schema_detected'),
    undefined
  );
  assert.ok(
    logs.entries.find((entry) => entry.event === 'session_store.split_migration_completed'),
    'v9 fixture must run the monolithic-to-split migration'
  );
});

test('release-compat: v11 split payload migrates message reactions into the current layout', async () => {
  const { sessionsPath } = loadFixture('userdata-v11');
  const logs = createLogCollector();
  const store = new ElectronSessionStore(sessionsPath, { logger: logs.logger });

  assert.equal(store.hasPendingMigrations(), true);
  assert.equal(readPersistedPayload(sessionsPath).schema_version, 11);

  const result = await store.runPendingMigrations({ batchSize: 1 });
  assert.equal(result.ran, true);
  assert.equal(result.success, true);
  assert.equal(store.hasPendingMigrations(), false);

  const persisted = readPersistedPayload(sessionsPath);
  const sessionPayload = JSON.parse(
    fs.readFileSync(sessionFilePathFromSessionsPath(sessionsPath, 'sess_v11_reactions'), 'utf8')
  );
  const session = store.getSession('sess_v11_reactions');

  assert.equal(persisted.schema_version, EXPECTED_SCHEMA_VERSION);
  assert.equal(sessionPayload.schema_version, EXPECTED_SCHEMA_VERSION);
  assert.deepEqual(session.messages[0].message_reactions, {});
  assert.deepEqual(session.messages[1].message_reactions, {
    thumbs_up: {
      selected: true,
      updated_at: '2026-05-12T17:00:00.000Z',
    },
    note: {
      selected: true,
      updated_at: '',
    },
  });
  assert.ok(
    logs.entries.find((entry) => entry.event === 'session_store.split_schema_migration_completed'),
    'v11 split fixture must run the split schema migration'
  );
});

test('release-compat: v12 split payload migrates diagnostic metadata defaults into v13 layout', async () => {
  const { sessionsPath } = loadFixture('userdata-v12-current');
  const logs = createLogCollector();
  const store = new ElectronSessionStore(sessionsPath, { logger: logs.logger });

  assert.equal(store.hasPendingMigrations(), true);
  assert.equal(readPersistedPayload(sessionsPath).schema_version, 12);
  const result = await store.runPendingMigrations({ batchSize: 1 });
  assert.equal(result.ran, true);
  assert.equal(result.success, true);
  assert.equal(store.hasPendingMigrations(), false);

  const session = store.getSession('sess_v12_current');
  assert.ok(session, 'current split fixture session must load');
  assert.equal(session.branch_origin.source_session_id, 'sess_parent');
  assert.equal(session.diagnostic_mode, '');
  assert.equal(session.diagnostic_run_id, '');
  assert.equal(session.diagnostic_provider, '');
  assert.equal(session.diagnostic_model, '');

  const persisted = readPersistedPayload(sessionsPath);
  const sessionPayload = JSON.parse(
    fs.readFileSync(sessionFilePathFromSessionsPath(sessionsPath, 'sess_v12_current'), 'utf8')
  );
  assert.equal(persisted.schema_version, EXPECTED_SCHEMA_VERSION);
  assert.equal(sessionPayload.schema_version, EXPECTED_SCHEMA_VERSION);
  assert.equal(persisted.sessions.sess_v12_current.branch_origin.source_message_id, 'msg_parent_2');
  assert.equal(persisted.sessions.sess_v12_current.diagnostic_mode, '');
  assert.equal(
    logs.entries.find((entry) => entry.event === 'session_store.newer_schema_detected'),
    undefined
  );
  assert.equal(
    logs.entries.find((entry) => entry.event === 'session_store.split_migration_completed'),
    undefined
  );
  assert.ok(
    logs.entries.find((entry) => entry.event === 'session_store.split_schema_migration_completed'),
    'v12 split fixture must run the split schema migration'
  );
});

test('release-compat: v13 split payload compacts bloated reasoning_phase events into v14 layout', async () => {
  const { sessionsPath } = loadFixture('userdata-v13-current');
  const logs = createLogCollector();
  const store = new ElectronSessionStore(sessionsPath, { logger: logs.logger });

  assert.equal(store.hasPendingMigrations(), true);
  assert.equal(readPersistedPayload(sessionsPath).schema_version, 13);
  const result = await store.runPendingMigrations({ batchSize: 1 });
  assert.equal(result.ran, true);
  assert.equal(result.success, true);
  assert.equal(store.hasPendingMigrations(), false);

  const session = store.getSession('frontier_diag_v13_current');
  assert.ok(session, 'v13 split fixture session must load');
  // Diagnostic metadata authored at v13 must survive the forward migration.
  assert.equal(session.diagnostic_mode, 'frontier');
  assert.equal(session.diagnostic_run_id, 'frontier_v13_current');
  assert.equal(session.diagnostic_provider, 'codex-cli');
  assert.equal(session.diagnostic_model, 'gpt-5');

  // The three per-chunk reasoning_phase events for one phase collapse to a
  // single event; chunk_count sums, the latest entry snapshot wins, and the
  // non-reasoning text-segment event is left in place.
  const reasoningEvents = session.turn_events.filter((event) => event.kind === 'reasoning_phase');
  assert.equal(reasoningEvents.length, 1, 'bloated reasoning_phase events must compact to one');
  assert.equal(reasoningEvents[0].payload.chunk_count, 3);
  assert.equal(reasoningEvents[0].payload.entries.length, 1);
  assert.equal(
    reasoningEvents[0].payload.entries[0].text,
    'Considering the frontier logs, the error trace, and the fix'
  );
  assert.equal(
    session.turn_events.some((event) => event.kind === 'assistant_text_segment'),
    true,
    'non-reasoning turn events must survive v14 compaction'
  );

  const persisted = readPersistedPayload(sessionsPath);
  const sessionPayload = JSON.parse(
    fs.readFileSync(sessionFilePathFromSessionsPath(sessionsPath, 'frontier_diag_v13_current'), 'utf8')
  );
  assert.equal(persisted.schema_version, EXPECTED_SCHEMA_VERSION);
  assert.equal(sessionPayload.schema_version, EXPECTED_SCHEMA_VERSION);
  assert.equal(persisted.sessions.frontier_diag_v13_current.diagnostic_run_id, 'frontier_v13_current');
  assert.equal(
    logs.entries.find((entry) => entry.event === 'session_store.newer_schema_detected'),
    undefined
  );
  assert.ok(
    logs.entries.find((entry) => entry.event === 'session_store.split_schema_migration_completed'),
    'v13 split fixture must run the split schema migration'
  );
});

test('release-compat: v14 split payload migrates durable turn identity defaults into v15 layout', async () => {
  const { sessionsPath } = loadFixture('userdata-v14-current');
  const logs = createLogCollector();
  const store = new ElectronSessionStore(sessionsPath, { logger: logs.logger });

  assert.equal(store.hasPendingMigrations(), true);
  assert.equal(readPersistedPayload(sessionsPath).schema_version, 14);
  const result = await store.runPendingMigrations({ batchSize: 1 });
  assert.equal(result.ran, true);
  assert.equal(result.success, true);
  assert.equal(store.hasPendingMigrations(), false);

  const session = store.getSession('frontier_diag_v14_current');
  assert.ok(session, 'v14 diagnostic split fixture session must load');
  assert.equal(session.diagnostic_mode, 'frontier');
  assert.equal(session.diagnostic_run_id, 'frontier_v14_current');
  assert.equal(session.diagnostic_provider, 'codex-cli');
  assert.equal(session.diagnostic_model, 'gpt-5');
  assert.equal(session.session_incarnation, '');
  assert.equal(session.turn_generation, 0);

  // The already-compacted reasoning_phase event stays singular while v15 adds
  // only the durable actor identity fields.
  const reasoningEvents = session.turn_events.filter((event) => event.kind === 'reasoning_phase');
  assert.equal(reasoningEvents.length, 1);
  assert.equal(reasoningEvents[0].payload.chunk_count, 3);

  const persisted = readPersistedPayload(sessionsPath);
  const sessionPayload = JSON.parse(
    fs.readFileSync(sessionFilePathFromSessionsPath(sessionsPath, 'frontier_diag_v14_current'), 'utf8')
  );
  assert.equal(persisted.schema_version, EXPECTED_SCHEMA_VERSION);
  assert.equal(sessionPayload.schema_version, EXPECTED_SCHEMA_VERSION);
  assert.equal(sessionPayload.session.session_incarnation, '');
  assert.equal(sessionPayload.session.turn_generation, 0);
  assert.equal(persisted.sessions.frontier_diag_v14_current.diagnostic_run_id, 'frontier_v14_current');
  assert.equal(
    logs.entries.find((entry) => entry.event === 'session_store.newer_schema_detected'),
    undefined
  );
  assert.ok(
    logs.entries.find((entry) => entry.event === 'session_store.split_schema_migration_completed'),
    'v14 split fixture must run the split schema migration'
  );
});

test('release-compat: v15 split payload migrates into the v16 compaction-snapshot layout', async () => {
  const { sessionsPath } = loadFixture('userdata-v15-current');
  const logs = createLogCollector();
  const store = new ElectronSessionStore(sessionsPath, { logger: logs.logger });

  assert.equal(store.hasPendingMigrations(), true);
  assert.equal(readPersistedPayload(sessionsPath).schema_version, 15);
  const result = await store.runPendingMigrations({ batchSize: 1 });
  assert.equal(result.ran, true);
  assert.equal(result.success, true);
  assert.equal(store.hasPendingMigrations(), false);

  const session = store.getSession('frontier_diag_v15_current');
  assert.ok(session, 'v15 diagnostic split fixture session must load');
  assert.equal(session.diagnostic_mode, 'frontier');
  assert.equal(session.diagnostic_run_id, 'frontier_v15_current');
  assert.equal(session.session_incarnation, 'inc_v15_current');
  assert.equal(session.turn_generation, 7);
  // The fixture carries a malformed (future-version, non-list messages)
  // compaction_snapshot; repairSessionForV16 must fail it closed to null
  // rather than let a half-parsed snapshot rewrite prompt history.
  assert.equal(session.compaction_snapshot, null);

  const reasoningEvents = session.turn_events.filter((event) => event.kind === 'reasoning_phase');
  assert.equal(reasoningEvents.length, 1);
  assert.equal(reasoningEvents[0].payload.chunk_count, 3);

  const persisted = readPersistedPayload(sessionsPath);
  const sessionPayload = JSON.parse(
    fs.readFileSync(sessionFilePathFromSessionsPath(sessionsPath, 'frontier_diag_v15_current'), 'utf8')
  );
  assert.equal(persisted.schema_version, EXPECTED_SCHEMA_VERSION);
  assert.equal(sessionPayload.schema_version, EXPECTED_SCHEMA_VERSION);
  assert.equal(sessionPayload.session.compaction_snapshot, null);
  assert.equal(persisted.sessions.frontier_diag_v15_current.diagnostic_run_id, 'frontier_v15_current');
  assert.equal(
    logs.entries.find((entry) => entry.event === 'session_store.newer_schema_detected'),
    undefined
  );
  assert.ok(
    logs.entries.find((entry) => entry.event === 'session_store.split_schema_migration_completed'),
    'v15 split fixture must run the split schema migration'
  );
});

test('release-compat: v16 split payload migrates into the current plugin-session layout', async () => {
  const { sessionsPath } = loadFixture('userdata-v16-current');
  const logs = createLogCollector();
  const store = new ElectronSessionStore(sessionsPath, { logger: logs.logger });

  assert.equal(store.hasPendingMigrations(), true);
  assert.equal(readPersistedPayload(sessionsPath).schema_version, 16);
  const result = await store.runPendingMigrations({ batchSize: 1 });
  assert.equal(result.ran, true);
  assert.equal(result.success, true);
  assert.equal(store.hasPendingMigrations(), false);

  const session = store.getSession('frontier_diag_v16_current');
  assert.ok(session, 'v16 diagnostic split fixture session must load');
  assert.equal(session.session_type, 'chat');
  assert.equal(Object.hasOwn(session, 'image_config'), false);

  // No data loss: everything v13-v16 established survives the bump.
  assert.equal(session.diagnostic_mode, 'frontier');
  assert.equal(session.diagnostic_run_id, 'frontier_v16_current');
  assert.equal(session.session_incarnation, 'inc_v16_current');
  assert.equal(session.messages.length, 2);
  assert.equal(session.messages[1].id, 'assistant_stream_v16_clean');
  assert.ok(session.compaction_snapshot, 'valid v16 compaction snapshot must survive the schema bumps');
  assert.equal(session.compaction_snapshot.boundary_message_id, 'assistant_stream_v16_clean');
  assert.equal(session.compaction_snapshot.messages.length, 2);
  assert.equal(session.turn_events.filter((event) => event.kind === 'reasoning_phase').length, 1);

  // The hand-authored row with no session_type and a malformed image_config:
  // the type defaults to chat and the config fails closed instead of riding
  // along on a chat record.
  const untyped = store.getSession('sess_v16_untyped');
  assert.ok(untyped, 'untyped v16 row must survive migration');
  assert.equal(untyped.session_type, 'chat');
  assert.equal(Object.hasOwn(untyped, 'image_config'), false);
  assert.equal(untyped.messages[0].content, 'Hello from a pre-session-type row.');

  const persisted = readPersistedPayload(sessionsPath);
  const sessionPayload = JSON.parse(
    fs.readFileSync(sessionFilePathFromSessionsPath(sessionsPath, 'frontier_diag_v16_current'), 'utf8')
  );
  assert.equal(persisted.schema_version, EXPECTED_SCHEMA_VERSION);
  assert.equal(sessionPayload.schema_version, EXPECTED_SCHEMA_VERSION);
  assert.equal(sessionPayload.session.session_type, 'chat');
  assert.equal(Object.hasOwn(sessionPayload.session, 'image_config'), false);
  assert.equal(persisted.sessions.frontier_diag_v16_current.session_type, 'chat');
  assert.equal(persisted.sessions.frontier_diag_v16_current.diagnostic_run_id, 'frontier_v16_current');
  assert.equal(
    logs.entries.find((entry) => entry.event === 'session_store.newer_schema_detected'),
    undefined
  );
  assert.ok(
    logs.entries.find((entry) => entry.event === 'session_store.split_schema_migration_completed'),
    'v16 split fixture must run the split schema migration'
  );
});

test('release-compat: v17 image sessions migrate to the official plugin binding', async () => {
  const { sessionsPath } = loadFixture('userdata-v17-current');
  const logs = createLogCollector();
  const store = new ElectronSessionStore(sessionsPath, { logger: logs.logger });

  assert.equal(store.hasPendingMigrations(), true);
  const result = await store.runPendingMigrations({ batchSize: 2 });
  assert.equal(result.ran, true);
  assert.equal(result.success, true);
  assert.equal(store.hasPendingMigrations(), false);

  const session = store.getSession('frontier_diag_v17_current');
  assert.ok(session, 'v17 diagnostic split fixture session must load');
  assert.equal(session.session_type, 'chat');
  assert.equal(session.plugin_session, null);
  assert.equal(Object.hasOwn(session, 'image_config'), false);
  assert.equal(session.diagnostic_run_id, 'frontier_v17_current');
  assert.ok(session.compaction_snapshot, 'valid compaction snapshot must survive load');
  assert.equal(session.compaction_snapshot.boundary_message_id, 'assistant_stream_v17_clean');
  assert.equal(session.compaction_snapshot.messages.length, 2);
  assert.equal(session.turn_events.filter((event) => event.kind === 'reasoning_phase').length, 1);

  const imageSession = store.getSession('image_sess_v17_current');
  assert.ok(imageSession, 'v17 image split fixture session must load');
  assert.equal(imageSession.session_type, 'plugin');
  assert.equal(imageSession.plugin_session.publisher_id, 'jenny-official');
  assert.equal(imageSession.plugin_session.plugin_id, 'local-image-generation');
  assert.equal(imageSession.plugin_session.provider_contribution_id, 'local_image_generation');
  assert.equal(imageSession.plugin_session.view_contribution_id, 'image_workspace');
  assert.deepEqual(imageSession.plugin_session.state, {
    model_id: 'HiDream-ai/HiDream-O1-Image',
    resolution: '2048x2048',
    steps: 50,
  });
  assert.equal(Object.hasOwn(imageSession, 'image_config'), false);

  const summaryById = new Map(store.listSessions().map((entry) => [entry.id, entry]));
  assert.equal(summaryById.get('frontier_diag_v17_current').session_type, 'chat');
  assert.equal(summaryById.get('image_sess_v17_current').session_type, 'plugin');
  assert.equal(summaryById.get('image_sess_v17_current').plugin_session.provider_name,
    'Local image generation');

  const persisted = readPersistedPayload(sessionsPath);
  assert.equal(persisted.schema_version, EXPECTED_SCHEMA_VERSION);
  assert.equal(persisted.sessions.frontier_diag_v17_current.diagnostic_run_id, 'frontier_v17_current');
  assert.equal(
    logs.entries.find((entry) => entry.event === 'session_store.newer_schema_detected'),
    undefined
  );
  assert.ok(logs.entries.find(
    (entry) => entry.event === 'session_store.split_schema_migration_completed'
  ));
});

test('release-compat: v18 sessions retire research context and upgrade snapshots', async () => {
  const { sessionsPath } = loadFixture('userdata-v18-current');
  const logs = createLogCollector();
  const store = new ElectronSessionStore(sessionsPath, { logger: logs.logger });

  assert.equal(store.hasPendingMigrations(), true);
  const result = await store.runPendingMigrations({ batchSize: 2 });
  assert.equal(result.success, true);
  const session = store.getSession('frontier_diag_v17_current');
  assert.equal(Object.hasOwn(session.context_preferences, 'include_research_mode'), false);
  assert.equal(session.context_preferences.history_scope, 'recent');
  assert.equal(session.compaction_snapshot.version, 2);
  assert.equal(session.compaction_snapshot.origin, 'manual');
  assert.equal(readPersistedPayload(sessionsPath).schema_version, EXPECTED_SCHEMA_VERSION);
  assert.equal(
    logs.entries.find((entry) => entry.event === 'session_store.newer_schema_detected'),
    undefined
  );
});

test('release-compat: v19 split payload adds empty tool overrides during migration', () => {
  const { sessionsPath } = loadFixture('userdata-v19-current');
  const logs = createLogCollector();
  const store = new ElectronSessionStore(sessionsPath, { logger: logs.logger });

  assert.equal(store.hasPendingMigrations(), true);
  const session = store.getSession('session_v19_current');
  assert.equal(session.context_preferences.history_scope, 'session');
  assert.equal(session.compaction_snapshot.origin, 'automatic');
  assert.equal(session.compaction_snapshot.version, 2);
  assert.deepEqual(session.tool_category_overrides, {});
  assert.equal(logs.entries.some((entry) => entry.level === 'ERROR'), false);
});

test('release-compat: v20 split payload gains General attribution and keeps tool overrides', () => {
  const { sessionsPath } = loadFixture('userdata-v20-current');
  const store = new ElectronSessionStore(sessionsPath);
  assert.equal(store.hasPendingMigrations(), true);
  const session = store.getSession('session_v20_current');
  assert.equal(session.project_id, GENERAL_PROJECT_ID);
  assert.deepEqual(session.tool_category_overrides, {
    files: false,
    web: true,
    local_browser: false,
    python: false,
    terminal: true,
  });
});

test('release-compat: v21 split payload normalizes bounded failure-retry reasoning snapshots', async () => {
  const { sessionsPath } = loadFixture('userdata-v21-current');
  const logs = createLogCollector();
  const store = new ElectronSessionStore(sessionsPath, { logger: logs.logger });
  assert.equal(store.hasPendingMigrations(), true);

  const result = await store.runPendingMigrations({ batchSize: 1 });
  assert.equal(result.ran, true);
  assert.equal(result.success, true);
  const session = store.getSession('session_v21_current');
  assert.deepEqual(Object.keys(session.failure_retry_reasoning_snapshots).sort(), [
    'user_capped',
    'user_valid',
  ]);
  assert.equal(
    session.failure_retry_reasoning_snapshots.user_capped.reasoning_entries[0].text,
    '456789ab'
  );
  assert.equal(session.failure_retry_reasoning_snapshots.user_capped.char_count, 8);
  assert.equal(session.failure_retry_reasoning_snapshots.user_capped.truncated, true);
  assert.deepEqual(session.messages.map((message) => message.id), ['user_valid', 'assistant_failed']);
  assert.deepEqual(session.turn_events.map((event) => event.event_id), ['turn_v21:user_bubble:0']);
  assert.equal(readPersistedPayload(sessionsPath).schema_version, EXPECTED_SCHEMA_VERSION);
  assert.equal(
    logs.entries.find((entry) => entry.event === 'session_store.newer_schema_detected'),
    undefined
  );
});

test('release-compat: v22 migrates to the journal layout and settles an interrupted plugin operation', async () => {
  const { sessionsPath } = loadFixture('userdata-v22-image-interrupted');
  const chatId = 'image_sess_v22_interrupted';
  const chatPath = sessionFilePathFromSessionsPath(sessionsPath, chatId);
  const rawBefore = JSON.parse(fs.readFileSync(chatPath, 'utf8'));
  assert.equal(rawBefore.schema_version, 22);
  assert.equal(Object.hasOwn(rawBefore, 'journal_epoch'), false);
  const logs = createLogCollector();
  const store = new ElectronSessionStore(sessionsPath, { logger: logs.logger, sessionJournal: true });
  assert.equal(store.hasPendingMigrations(), true, 'a v22 fixture queues the v22 -> current migration');
  assert.deepEqual(JSON.parse(fs.readFileSync(chatPath, 'utf8')), rawBefore, 'queueing writes nothing');

  // Not getSession before this: a record loaded first would win over the migrated one.
  const result = await store.runPendingMigrations({ batchSize: 1 });
  assert.equal(result.ran, true);
  assert.equal(result.success, true);
  assert.equal(store.hasPendingMigrations(), false);
  assert.ok(logs.entries.find((entry) => entry.event === 'session_store.split_schema_migration_completed'));
  assert.equal(readPersistedPayload(sessionsPath).schema_version, EXPECTED_SCHEMA_VERSION);
  const migratedBase = JSON.parse(fs.readFileSync(chatPath, 'utf8'));
  assert.equal(migratedBase.schema_version, EXPECTED_SCHEMA_VERSION);
  assert.ok(Number.isInteger(migratedBase.journal_epoch) && migratedBase.journal_epoch >= 1);
  // The hand-authored v22 rows are sparse; earlier steps normalize them on load.
  const summarize = (messages) => messages.map(({ id, role, content, status }) => ({ id, role, content, status }));
  assert.deepEqual(
    summarize(JournaledJsonStore.readFile(chatPath, { payloadKey: 'session' }).value.session.messages),
    summarize(rawBefore.session.messages),
    'the migration leaves the chat content unchanged'
  );

  const session = store.getSession(chatId);
  assert.equal(session.session_type, 'plugin');
  assert.equal(session.plugin_session.active_operation, null);
  assert.equal(session.messages[0].content, 'Draw a lighthouse at dusk');
  const assistant = session.messages.find((message) => message.id === 'assistant_v22_working');
  assert.equal(assistant.content, 'The plugin operation was interrupted before it finished.');
  assert.equal(assistant.status, 'runtime_error');
  assert.deepEqual(assistant.plugin_operation, {
    operation_id: 'op_v22_interrupted',
    attempt: 1,
    action_id: 'generate',
    status: 'interrupted',
    reason_code: 'app_restarted',
  });
  store.flush();
  store.dispose();

  // A restart reads the base plus its journals; the raw base alone may be stale.
  const persisted = JournaledJsonStore.readFile(chatPath, { payloadKey: 'session' }).value.session;
  assert.equal(persisted.plugin_session.active_operation, null);
  assert.equal(
    persisted.messages.find((message) => message.id === 'assistant_v22_working').status,
    'runtime_error'
  );
  assert.equal(readPersistedPayload(sessionsPath).schema_version, EXPECTED_SCHEMA_VERSION);
  assert.equal(
    logs.entries.find((entry) => entry.event === 'session_store.plugin_operation_settlement_failed'),
    undefined
  );
});

// ---- v24 current: chat = base + append-only journal, index = base + journal ----
// userdata-v24-current is userdata-v23-current at schema 24 (same chat ids) plus one
// journal delta that sets `suggested_changes`; v23-current is now the migration source.

const JOURNAL_CHAT = 'sess_v23_journaled';
const SECOND_CHAT = 'sess_v23_second';
const RECOVERY_CHAT = 'sess_v23_lost_rename';
const JOURNAL_DAMAGE_EVENT = /session_journal_damaged|journal_corrupt|journal_ignored|session_journal_quarantine/;
const JOURNAL_CHAT_MESSAGE_IDS = [
  'a_user_1', 'a_assistant_1', 'a_user_2', 'a_assistant_2', 'a_user_late', 'a_assistant_late',
];

function snapshotFiles(rootDir) {
  const files = new Map();
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else files.set(path.relative(rootDir, full), fs.readFileSync(full));
    }
  };
  visit(rootDir);
  return files;
}

function readChat(sessionsPath, sessionId) {
  return JournaledJsonStore.readFile(sessionFilePathFromSessionsPath(sessionsPath, sessionId), {
    payloadKey: 'session',
  });
}

function rawChatBase(sessionsPath, sessionId) {
  return JSON.parse(fs.readFileSync(sessionFilePathFromSessionsPath(sessionsPath, sessionId), 'utf8'));
}

function assertCleanJournalLogs(logs) {
  assert.deepEqual(
    logs.entries.filter((entry) => JOURNAL_DAMAGE_EVENT.test(entry.event) || entry.level === 'ERROR'),
    []
  );
}

function assertJournalFixtureContent(store) {
  const journaled = store.getSession(JOURNAL_CHAT);
  assert.equal(journaled.title, 'Journal chat (renamed)');
  assert.deepEqual(journaled.messages.map((message) => message.id), JOURNAL_CHAT_MESSAGE_IDS);
  assert.equal(journaled.messages[1].content, 'Answer 1: edited after the fact');
  assert.equal(journaled.message_count, 6);
  assert.equal(journaled.last_message_preview, 'A late answer');
  assert.deepEqual(journaled.turn_events.map((event) => event.event_id), [
    'turn_v23_a:user_prompt:0', 'turn_v23_a:chat_token:1',
  ]);
  const second = store.getSession(SECOND_CHAT);
  assert.equal(second.title, 'Second chat');
  assert.deepEqual(second.messages.map((message) => message.id), ['b_user_1', 'b_assistant_1']);
  assert.deepEqual(
    store.listSessions().map((entry) => [entry.id, entry.title, entry.message_count]).sort(),
    [[JOURNAL_CHAT, 'Journal chat (renamed)', 6], [SECOND_CHAT, 'Second chat', 2]]
  );
}

test('release-compat: v24 current fixture holds un-compacted base + journal state on disk', () => {
  const { sessionsPath } = loadFixture('userdata-v24-current');
  const base = rawChatBase(sessionsPath, JOURNAL_CHAT);
  assert.equal(base.schema_version, EXPECTED_SCHEMA_VERSION);
  assert.ok(base.journal_epoch >= 2, 'the fixture chat base is at epoch 2 or later');
  assert.ok(base.session.messages.length < 6, 'the base alone is stale: journals hold later messages');
  const sessionsDir = sessionsDirFromPath(sessionsPath);
  assert.deepEqual(fs.readdirSync(sessionsDir).sort(), [
    '_index.1.journal', '_index.json',
    `${JOURNAL_CHAT}.1.journal`, `${JOURNAL_CHAT}.2.journal`, `${JOURNAL_CHAT}.json`,
    `${SECOND_CHAT}.1.journal`, `${SECOND_CHAT}.json`,
  ]);
  assert.equal(rawChatBase(sessionsPath, SECOND_CHAT).journal_epoch, 1);
  assert.equal(readPersistedPayload(sessionsPath).journal_epoch, 1);
  assert.ok(fs.statSync(path.join(sessionsDir, '_index.1.journal')).size > 0);
});

test('release-compat: v24 current profile loads every journaled message, title and turn event', () => {
  const { sessionsPath } = loadFixture('userdata-v24-current');
  const logs = createLogCollector();
  const store = new ElectronSessionStore(sessionsPath, { logger: logs.logger, sessionJournal: true });
  assert.equal(store.hasPendingMigrations(), false);
  assert.equal(store.hasNewerSchema(), false);
  assertJournalFixtureContent(store);
  assert.equal(readChat(sessionsPath, JOURNAL_CHAT).journalStatus, 'ok');
  assert.equal(fs.existsSync(path.join(sessionsDirFromPath(sessionsPath), 'corrupt')), false);
  assertCleanJournalLogs(logs);
});

test('release-compat: v24 current profile loads without writing a byte', () => {
  const { tmpRoot, sessionsPath } = loadFixture('userdata-v24-current');
  const before = snapshotFiles(tmpRoot);
  const logs = createLogCollector();
  const store = new ElectronSessionStore(sessionsPath, { logger: logs.logger, sessionJournal: true });
  assertJournalFixtureContent(store);
  for (const id of store.getSessionIds()) store.getSession(id);
  store.listSessions();
  // Not disposed or flushed: dispose compacts, which rewrites the base by design.
  const after = snapshotFiles(tmpRoot);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file is added or removed');
  for (const [name, bytes] of before) {
    assert.equal(after.get(name).equals(bytes), true, `${name} is byte-identical after a read-only load`);
  }
  assertCleanJournalLogs(logs);
});

test('release-compat: v24 current profile keeps earlier content after one more write', () => {
  const { sessionsPath } = loadFixture('userdata-v24-current');
  const logs = createLogCollector();
  const store = new ElectronSessionStore(sessionsPath, { logger: logs.logger, sessionJournal: true });
  assert.ok(store.appendMessage(JOURNAL_CHAT, {
    id: 'a_user_next', role: 'user', content: 'One more question', timestamp: '2026-10-05T13:00:00.000Z',
  }));
  assert.equal(store.flushSession(JOURNAL_CHAT), true);

  const reopened = new ElectronSessionStore(sessionsPath, { logger: logs.logger, sessionJournal: true });
  const reopenedChat = reopened.getSession(JOURNAL_CHAT);
  assert.deepEqual(reopenedChat.messages.map((message) => message.id), [...JOURNAL_CHAT_MESSAGE_IDS, 'a_user_next']);
  assert.equal(reopenedChat.title, 'Journal chat (renamed)');
  assert.equal(reopenedChat.turn_events.length, 2);
  assert.deepEqual(
    reopened.getSession(SECOND_CHAT).messages.map((message) => message.id),
    ['b_user_1', 'b_assistant_1']
  );
  assert.equal(reopened.listSessions().find((entry) => entry.id === JOURNAL_CHAT).message_count, 7);
  assertCleanJournalLogs(logs);
  store.dispose();
  reopened.dispose();
});

test('release-compat: v24 current profile opens with the journal kill switch and writes whole files', () => {
  const { sessionsPath } = loadFixture('userdata-v24-current');
  const logs = createLogCollector();
  const store = new ElectronSessionStore(sessionsPath, { logger: logs.logger, sessionJournal: false });
  assert.equal(store.hasPendingMigrations(), false);
  assertJournalFixtureContent(store);
  assert.ok(store.appendMessage(JOURNAL_CHAT, {
    id: 'a_user_next', role: 'user', content: 'Written with the kill switch', timestamp: '2026-10-05T13:00:00.000Z',
  }));
  assert.equal(store.flushSession(JOURNAL_CHAT), true);

  const base = rawChatBase(sessionsPath, JOURNAL_CHAT);
  assert.equal(Object.hasOwn(base, 'journal_epoch'), false, 'a kill-switch base has no journal epoch');
  assert.equal(base.schema_version, EXPECTED_SCHEMA_VERSION);
  assert.deepEqual(base.session.messages.map((message) => message.id), [...JOURNAL_CHAT_MESSAGE_IDS, 'a_user_next']);
  assert.equal(base.session.title, 'Journal chat (renamed)');
  assert.equal(base.session.turn_events.length, 2);
  assert.equal(Object.hasOwn(readPersistedPayload(sessionsPath), 'journal_epoch'), false);
  assert.equal(readPersistedPayload(sessionsPath).sessions[JOURNAL_CHAT].message_count, 7);

  const reopened = new ElectronSessionStore(sessionsPath, { logger: logs.logger, sessionJournal: false });
  assert.equal(reopened.getSession(JOURNAL_CHAT).messages.length, 7);
  assert.equal(reopened.getSession(SECOND_CHAT).messages.length, 2);
  assertCleanJournalLogs(logs);
  store.dispose();
  reopened.dispose();
});

test('release-compat: v24 lost base rename recovers the state at the end of the next journal', () => {
  const { sessionsPath } = loadFixture('userdata-v24-journal-recovery');
  assert.equal(rawChatBase(sessionsPath, RECOVERY_CHAT).journal_epoch, 1, 'the surviving base is the older one');
  const journalText = (epoch) => fs.readFileSync(
    path.join(sessionsDirFromPath(sessionsPath), `${RECOVERY_CHAT}.${epoch}.journal`), 'utf8'
  );
  assert.doesNotMatch(journalText(1), /"continues"/);
  assert.match(journalText(2), /"epoch":2,"continues":true/);

  const logs = createLogCollector();
  const store = new ElectronSessionStore(sessionsPath, { logger: logs.logger, sessionJournal: true });
  assert.equal(store.hasPendingMigrations(), false);
  const expectedIds = ['r_user_1', 'r_user_2', 'r_user_3', 'r_after_1', 'r_after_2', 'r_after_3'];
  const session = store.getSession(RECOVERY_CHAT);
  assert.equal(session.title, 'Lost rename (final)');
  assert.deepEqual(session.messages.map((message) => message.id), expectedIds);
  assert.equal(readChat(sessionsPath, RECOVERY_CHAT).journalStatus, 'ok');
  assert.equal(store.listSessions()[0].message_count, 6);
  assertCleanJournalLogs(logs);

  // The next write replaces the base above every journal on disk, and nothing is lost.
  assert.ok(store.appendMessage(RECOVERY_CHAT, {
    id: 'r_next', role: 'user', content: 'After recovery', timestamp: '2026-10-05T13:00:00.000Z',
  }));
  assert.equal(store.flushSession(RECOVERY_CHAT), true);
  assert.ok(rawChatBase(sessionsPath, RECOVERY_CHAT).journal_epoch >= 3);
  const reopened = new ElectronSessionStore(sessionsPath, { logger: logs.logger, sessionJournal: true });
  assert.deepEqual(
    reopened.getSession(RECOVERY_CHAT).messages.map((message) => message.id),
    [...expectedIds, 'r_next']
  );
  assert.equal(reopened.getSession(RECOVERY_CHAT).title, 'Lost rename (final)');
  assertCleanJournalLogs(logs);
  store.dispose();
  reopened.dispose();
});

test('release-compat: v24 current profile loads journaled suggested changes', () => {
  const { sessionsPath } = loadFixture('userdata-v24-current');
  const store = new ElectronSessionStore(sessionsPath, { sessionJournal: true });
  const record = store.getSession(JOURNAL_CHAT).suggested_changes;
  assert.equal(record.schema_version, 1);
  assert.deepEqual(record.entries.map((entry) => [entry.id, entry.status, entry.kind]), [
    ['sc_v24_fixture_review', 'to_review', 'replace'],
    ['sc_v24_fixture_later', 'later', 'create'],
  ]);
  assert.equal(record.entries[0].comments[0].text, 'Make it friendlier');
  assert.deepEqual(store.getSession(SECOND_CHAT).suggested_changes, {
    schema_version: 1, seq: 0, entries: [], file_heads: {},
  });
  store.dispose();
});

test('release-compat: v23 migrates to v24 with an empty suggested-changes record and keeps its journals', async () => {
  const { sessionsPath } = loadFixture('userdata-v23-current');
  const logs = createLogCollector();
  const store = new ElectronSessionStore(sessionsPath, { logger: logs.logger, sessionJournal: true });
  assert.equal(store.hasPendingMigrations(), true, 'a v23 fixture queues the v23 -> v24 migration');
  // Not getSession before this: a record loaded first would win over the migrated one.
  const result = await store.runPendingMigrations({ batchSize: 1 });
  assert.equal(result.ran, true);
  assert.equal(result.success, true);
  assert.equal(store.hasPendingMigrations(), false);
  assert.ok(logs.entries.find((entry) => entry.event === 'session_store.split_schema_migration_completed'));
  assert.equal(readPersistedPayload(sessionsPath).schema_version, EXPECTED_SCHEMA_VERSION);
  assert.equal(readChat(sessionsPath, JOURNAL_CHAT).value.schema_version, EXPECTED_SCHEMA_VERSION);
  assertJournalFixtureContent(store);
  assert.deepEqual(store.getSession(JOURNAL_CHAT).suggested_changes, {
    schema_version: 1, seq: 0, entries: [], file_heads: {},
  });
  assertCleanJournalLogs(logs);
  store.dispose();
});

test('release-compat: every fixture round-trips through the store without warnings', () => {
  // A backstop assertion: regardless of per-version repair invariants, no
  // fixture should produce ERROR-level log entries.
  for (const fixtureDir of FIXTURE_DIRS) {
    const { sessionsPath } = loadFixture(fixtureDir);
    const logs = createLogCollector();
    new ElectronSessionStore(sessionsPath, { logger: logs.logger });
    const errors = logs.entries.filter((entry) => entry.level === 'ERROR');
    assert.equal(
      errors.length,
      0,
      `fixture '${fixtureDir}' produced ${errors.length} ERROR log entries: ${JSON.stringify(errors)}`
    );
  }
});
