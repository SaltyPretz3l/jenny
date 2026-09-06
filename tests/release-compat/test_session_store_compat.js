// Phase 12B / A.B.6: Electron session-store release-gate compatibility test.
//
// Loads pre-canned userData fixtures pinned at every supported legacy
// schema_version and verifies they migrate cleanly to STORE_SCHEMA_VERSION.
// The fixtures are hand-authored from real legacy session shapes; each file
// includes the markers the matching repairSessionForV<N> step is designed
// to detect, so a regression in any cascade step surfaces here.
//
// App-version dimension: every fixture pins the assumption that
// `package.json:version` is `0.9.1`. The lockstep_release policy
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
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('../helpers/resource-cleanup');

const FIXTURE_ROOT = path.join(__dirname, 'fixtures');
const APP_VERSION = require('../../package.json').version;
const EXPECTED_APP_VERSION = '1.0.0';
const EXPECTED_SCHEMA_VERSION = 20;
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

test('release-compat: v20 current split payload loads exact bounded tool overrides', () => {
  const { sessionsPath } = loadFixture('userdata-v20-current');
  const store = new ElectronSessionStore(sessionsPath);
  assert.equal(store.hasPendingMigrations(), false);
  assert.deepEqual(store.getSession('session_v20_current').tool_category_overrides, {
    files: false,
    web: true,
    local_browser: false,
    python: false,
    terminal: true,
  });
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
