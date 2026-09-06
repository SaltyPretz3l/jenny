'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { version: APP_VERSION } = require('../package.json');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const { API_VERSION } = require('../services/backend/sidecar-client');
const { CONFIG_VERSION } = require('../services/shell-config-state');
const {
  STORE_SCHEMA_VERSION: SESSION_STORE_SCHEMA_VERSION,
  TURN_EVENT_LOG_VERSION: SESSION_TURN_EVENT_LOG_VERSION,
} = require('../services/backend/electron-session-store');
const {
  STORE_SCHEMA_VERSION: SESSION_SHADOW_SCHEMA_VERSION,
} = require('../services/backend/session-shadow-store');
const {
  EXPORT_FORMAT_VERSION,
} = require('../services/backend/session-export-import');
const {
  JOURNAL_SCHEMA_VERSION,
} = require('../services/backend/turn-event-journal');
const {
  TERMINAL_REPAIR_SCHEMA_VERSION,
} = require('../services/backend/terminal-repair-store');
const {
  SCHEDULED_TASKS_SCHEMA_VERSION,
} = require('../services/scheduler-schema-version');
const {
  TURN_DIAGNOSTIC_SCHEMA_VERSION,
} = require('../services/backend/turn-diagnostic-dump');
const {
  JENNY_STATUS_SCHEMA_VERSION,
} = require('../services/backend/jenny-status-composer');
const {
  USAGE_HISTORY_SCHEMA_VERSION,
} = require('../services/usage-history-service');

const REGISTRY_PATH = '../services/backend/schema-version-registry';
const SCHEDULER_SERVICE_PATH = '../services/scheduler-service';

function createRegistrySafeStorage() {
  return {
    ...createFakeSafeStorage(),
    getSelectedStorageBackend: () => 'dpapi',
  };
}

test('schema registry loads without importing the scheduler runtime service', () => {
  const registryPath = require.resolve(REGISTRY_PATH);
  const schedulerServicePath = require.resolve(SCHEDULER_SERVICE_PATH);
  delete require.cache[registryPath];
  delete require.cache[schedulerServicePath];

  const { getElectronSchemaVersions } = require(REGISTRY_PATH);
  const versions = getElectronSchemaVersions();

  assert.equal(Boolean(require.cache[schedulerServicePath]), false);
  assert.equal(
    versions.some((entry) => entry.id === 'electron.scheduled_tasks'),
    true
  );
  assert.equal(
    Object.keys(require.cache).some((loaded) => loaded.includes(`${path.sep}services${path.sep}plugins${path.sep}`)),
    false,
    'literal plugin registry rows must not import the flag-gated plugin runtime',
  );
});

test('getAllSchemaVersions returns Electron registry entries and normalized sidecar entries', () => {
  const { getAllSchemaVersions } = require(REGISTRY_PATH);
  const sidecarEntry = {
    id: 'sidecar.memory_store',
    surface: 'Memory store',
    owner: 'sidecar',
    kind: 'sqlite_schema',
    version: 5,
    forward_policy: 'reject_future',
    source: 'sidecar/ai/memory/store_migrations.py',
  };
  const versions = getAllSchemaVersions({ sidecarSchemaVersions: [sidecarEntry] });
  const byId = new Map(versions.map((entry) => [entry.id, entry]));
  const expectedVersionsById = new Map([
    ['app.version', APP_VERSION],
    ['protocol.api', API_VERSION],
    ['electron.session_store', SESSION_STORE_SCHEMA_VERSION],
    ['electron.session_turn_events', SESSION_TURN_EVENT_LOG_VERSION],
    ['electron.session_shadow_store', SESSION_SHADOW_SCHEMA_VERSION],
    ['electron.shell_config', CONFIG_VERSION],
    ['electron.session_export', EXPORT_FORMAT_VERSION],
    ['electron.turn_event_journal', JOURNAL_SCHEMA_VERSION],
    ['electron.terminal_repair_store', TERMINAL_REPAIR_SCHEMA_VERSION],
    ['electron.scheduled_tasks', SCHEDULED_TASKS_SCHEMA_VERSION],
    ['electron.turn_diagnostics', TURN_DIAGNOSTIC_SCHEMA_VERSION],
    ['electron.usage_history', USAGE_HISTORY_SCHEMA_VERSION],
    ['electron.jenny_status', JENNY_STATUS_SCHEMA_VERSION],
    ['electron.plugin_contract_set', 1],
    ['electron.plugin_generation_store', 1],
    ['electron.mcp_servers', 1],
    ['electron.plugin_catalog_sources', 1],
    ['sidecar.memory_store', 5],
  ]);

  assert.deepEqual([...byId.keys()].sort(), [...expectedVersionsById.keys()].sort());
  for (const [id, version] of expectedVersionsById) {
    assert.equal(byId.get(id).version, version);
  }
  assert.equal(byId.get('sidecar.memory_store').forward_policy, 'reject_future');

  for (const entry of versions) {
    assert.equal(typeof entry.id, 'string');
    assert.equal(typeof entry.surface, 'string');
    assert.equal(typeof entry.owner, 'string');
    assert.equal(typeof entry.kind, 'string');
    assert.equal(typeof entry.forward_policy, 'string');
    assert.equal(typeof entry.source, 'string');
    assert.notEqual(entry.version, undefined);
  }
});

test('getAllSchemaVersions drops malformed sidecar rows and keeps Electron rows authoritative', () => {
  const { getAllSchemaVersions } = require(REGISTRY_PATH);
  const versions = getAllSchemaVersions({
    sidecarSchemaVersions: [
      {
        id: 'electron.shell_config',
        surface: 'Spoofed shell config',
        owner: 'sidecar',
        kind: 'json_schema',
        version: 999,
        forward_policy: 'spoof',
        source: 'sidecar/spoof.py',
      },
      {
        id: 'sidecar.valid',
        surface: 'Valid sidecar schema',
        owner: 'sidecar',
        kind: 'json_schema',
        version: ' 2 ',
        forwardPolicy: 'reject_future',
        sourcePath: 'sidecar/valid.py',
      },
      {
        id: 'sidecar.missing_source',
        surface: 'Missing source',
        owner: 'sidecar',
        kind: 'json_schema',
        version: 1,
        forward_policy: 'reject_future',
      },
      null,
    ],
  });
  const byId = new Map(versions.map((entry) => [entry.id, entry]));

  assert.equal(byId.get('electron.shell_config').version, CONFIG_VERSION);
  assert.equal(byId.get('sidecar.valid').version, '2');
  assert.equal(byId.get('sidecar.valid').forward_policy, 'reject_future');
  assert.equal(byId.has('sidecar.missing_source'), false);
});

test('backend status exposes schema versions without requiring sidecar readiness', () => {
  const { BackendService } = require('../services/backend/backend-service');
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-schema-status-'));
  const service = new BackendService({
    userDataPath,
    safeStorage: createRegistrySafeStorage(),
    isSafeStorageReady: () => true,
  });
  service.currentStatus = {
    schema_versions: [
      {
        id: 'sidecar.diagnostics_log',
        surface: 'Sidecar diagnostics log',
        owner: 'sidecar',
        kind: 'log_schema',
        version: 1,
        forward_policy: 'integer_schema_only',
        source: 'sidecar/runtime/diagnostics.py',
      },
    ],
  };

  try {
    const status = service.getBackendStatus();
    const byId = new Map(status.schemaVersions.map((entry) => [entry.id, entry]));

    assert.equal(byId.get('electron.shell_config').version, CONFIG_VERSION);
    assert.equal(byId.get('sidecar.diagnostics_log').version, 1);
    assert.equal(status.schemaVersions.some((entry) => entry.id === 'electron.session_store'), true);
  } finally {
    service.dispose();
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});
