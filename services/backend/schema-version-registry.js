'use strict';

const { version: APP_VERSION } = require('../../package.json');
const { API_VERSION } = require('./sidecar-client');
const {
  STORE_SCHEMA_VERSION: SESSION_STORE_SCHEMA_VERSION,
  TURN_EVENT_LOG_VERSION: SESSION_TURN_EVENT_LOG_VERSION,
} = require('./electron-session-store');
const {
  STORE_SCHEMA_VERSION: SESSION_SHADOW_SCHEMA_VERSION,
} = require('./session-shadow-store');
const {
  EXPORT_FORMAT_VERSION,
} = require('./session-export-import');
const {
  JOURNAL_SCHEMA_VERSION,
} = require('./turn-event-journal');
const {
  TERMINAL_REPAIR_SCHEMA_VERSION,
} = require('./terminal-repair-store');
const {
  CONFIG_VERSION,
} = require('../shell-config-state');
const {
  SCHEDULED_TASKS_SCHEMA_VERSION,
} = require('../scheduler-schema-version');
const {
  TURN_DIAGNOSTIC_SCHEMA_VERSION,
} = require('./turn-diagnostic-dump');
const {
  JENNY_STATUS_SCHEMA_VERSION,
} = require('./jenny-status-composer');
const {
  USAGE_HISTORY_SCHEMA_VERSION,
} = require('../usage-history-service');

// Plugin schema versions are literals here on purpose: flag-off startup must
// expose compatibility metadata without importing services/plugins/.
const PLUGIN_CONTRACT_SET_VERSION = 1;
const PLUGIN_GENERATION_STORE_VERSION = 1;
const MCP_SERVERS_SCHEMA_VERSION = 1;
const PLUGIN_CATALOG_SOURCES_SCHEMA_VERSION = 1;

function normalizeVersionValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? Math.trunc(value) : value;
  }
  return String(value ?? '').trim();
}

function normalizeRegistryEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  const id = String(entry.id || '').trim();
  const surface = String(entry.surface || '').trim();
  const owner = String(entry.owner || '').trim();
  const kind = String(entry.kind || '').trim();
  const source = String(entry.source || entry.source_path || entry.sourcePath || '').trim();
  const forwardPolicy = String(
    entry.forward_policy || entry.forwardPolicy || ''
  ).trim();
  if (
    !id
    || !surface
    || !owner
    || !kind
    || !source
    || !forwardPolicy
    || !Object.prototype.hasOwnProperty.call(entry, 'version')
  ) {
    return null;
  }
  return {
    id,
    surface,
    owner,
    kind,
    version: normalizeVersionValue(entry.version),
    forward_policy: forwardPolicy,
    source,
  };
}

function makeEntry(entry) {
  return normalizeRegistryEntry(entry);
}

function normalizeSchemaVersionEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }
  const normalized = [];
  const seen = new Set();
  for (const entry of entries) {
    const next = normalizeRegistryEntry(entry);
    if (!next || seen.has(next.id)) {
      continue;
    }
    seen.add(next.id);
    normalized.push(next);
  }
  return normalized;
}

function getElectronSchemaVersions() {
  return [
    makeEntry({
      id: 'app.version',
      surface: 'Jenny app version',
      owner: 'electron',
      kind: 'app_version',
      version: APP_VERSION,
      forward_policy: 'lockstep_release',
      source: 'package.json',
    }),
    makeEntry({
      id: 'protocol.api',
      surface: 'Electron to sidecar API handshake',
      owner: 'electron-sidecar',
      kind: 'api_version',
      version: API_VERSION,
      forward_policy: 'lockstep_api_version',
      source: 'services/backend/sidecar-client.js',
    }),
    makeEntry({
      id: 'electron.session_store',
      surface: 'Electron session store',
      owner: 'electron',
      kind: 'json_schema',
      version: SESSION_STORE_SCHEMA_VERSION,
      forward_policy: 'migrate_forward_block_future_write',
      source: 'services/backend/electron-session-store.js',
    }),
    makeEntry({
      id: 'electron.session_turn_events',
      surface: 'Electron persisted turn-event log',
      owner: 'electron',
      kind: 'event_log_schema',
      version: SESSION_TURN_EVENT_LOG_VERSION,
      forward_policy: 'migrate_forward_block_future_write',
      source: 'services/backend/electron-session-store.js',
    }),
    makeEntry({
      id: 'electron.session_shadow_store',
      surface: 'Electron session shadow store',
      owner: 'electron',
      kind: 'json_schema',
      version: SESSION_SHADOW_SCHEMA_VERSION,
      forward_policy: 'normalize_forward_block_future_write',
      source: 'services/backend/session-shadow-store.js',
    }),
    makeEntry({
      id: 'electron.shell_config',
      surface: 'Electron shell config',
      owner: 'electron',
      kind: 'json_schema',
      version: CONFIG_VERSION,
      forward_policy: 'migrate_forward_block_future_write',
      source: 'services/shell-config-state.js',
    }),
    makeEntry({
      id: 'electron.session_export',
      surface: 'Portable session export',
      owner: 'electron',
      kind: 'export_format',
      version: EXPORT_FORMAT_VERSION,
      forward_policy: 'reject_future_format',
      source: 'services/backend/session-export-import.js',
    }),
    makeEntry({
      id: 'electron.turn_event_journal',
      surface: 'Turn-event recovery journal',
      owner: 'electron',
      kind: 'partitioned_ndjson_log',
      version: JOURNAL_SCHEMA_VERSION,
      forward_policy: 'migrate_forward_preserve_future_block_write',
      source: 'services/backend/turn-event-journal.js',
    }),
    makeEntry({
      id: 'electron.terminal_repair_store',
      surface: 'Terminal reply repair store',
      owner: 'electron',
      kind: 'json_schema',
      version: TERMINAL_REPAIR_SCHEMA_VERSION,
      forward_policy: 'preserve_future_block_write',
      source: 'services/backend/terminal-repair-store.js',
    }),
    makeEntry({
      id: 'electron.scheduled_tasks',
      surface: 'Scheduled task store',
      owner: 'electron',
      kind: 'json_schema',
      version: SCHEDULED_TASKS_SCHEMA_VERSION,
      forward_policy: 'preserve_future_block_write',
      source: 'services/scheduler-service.js',
    }),
    makeEntry({
      id: 'electron.turn_diagnostics',
      surface: 'Turn diagnostic dump',
      owner: 'electron',
      kind: 'diagnostic_schema',
      version: TURN_DIAGNOSTIC_SCHEMA_VERSION,
      forward_policy: 'integer_schema_only',
      source: 'services/backend/turn-diagnostic-dump.js',
    }),
    makeEntry({
      id: 'electron.usage_history',
      surface: 'Electron usage history store',
      owner: 'electron',
      kind: 'json_schema',
      version: USAGE_HISTORY_SCHEMA_VERSION,
      forward_policy: 'preserve_future_block_write',
      source: 'services/usage-history-service.js',
    }),
    makeEntry({
      id: 'electron.jenny_status',
      surface: 'Jenny status payload envelope',
      owner: 'electron',
      kind: 'diagnostic_schema',
      version: JENNY_STATUS_SCHEMA_VERSION,
      forward_policy: 'additive_only',
      source: 'services/backend/jenny-status-composer.js',
    }),
    makeEntry({
      id: 'electron.plugin_contract_set',
      surface: 'Electron plugin V1 contract set',
      owner: 'electron',
      kind: 'contract_set',
      version: PLUGIN_CONTRACT_SET_VERSION,
      forward_policy: 'frozen_v1_add_new_version',
      source: 'config/plugins/v1/',
    }),
    makeEntry({
      id: 'electron.plugin_generation_store',
      surface: 'Electron plugin generation store',
      owner: 'electron',
      kind: 'json_schema',
      version: PLUGIN_GENERATION_STORE_VERSION,
      forward_policy: 'preserve_future_block_write',
      source: 'config/plugins/v1/plugin-generation.schema.json',
    }),
    makeEntry({
      id: 'electron.mcp_servers',
      surface: 'Standalone MCP server configuration and trust records',
      owner: 'electron',
      kind: 'json_schema',
      version: MCP_SERVERS_SCHEMA_VERSION,
      forward_policy: 'migrate_legacy_preserve_future_block_write',
      source: 'services/mcp-config-store.js',
    }),
    makeEntry({
      id: 'electron.plugin_catalog_sources',
      surface: 'Pinned plugin catalog source store',
      owner: 'electron',
      kind: 'json_schema',
      version: PLUGIN_CATALOG_SOURCES_SCHEMA_VERSION,
      forward_policy: 'preserve_future_block_write',
      source: 'services/plugins/store/catalog-source-store.js',
    }),
  ].filter(Boolean);
}

function getAllSchemaVersions({ sidecarSchemaVersions = [] } = {}) {
  const sidecarEntries = Array.isArray(sidecarSchemaVersions)
    ? sidecarSchemaVersions
    : [];
  return normalizeSchemaVersionEntries([
    ...getElectronSchemaVersions(),
    ...sidecarEntries,
  ]);
}

module.exports = {
  getAllSchemaVersions,
  getElectronSchemaVersions,
  normalizeSchemaVersionEntries,
};
