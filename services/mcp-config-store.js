'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MCP_CONFIG_SCHEMA_VERSION = 1;
const DEFAULT_CONFIG_FILENAME = 'mcp-servers.json';
const MAX_SERVERS = 64;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const TOP_LEVEL_KEYS = new Set(['mcp_config_schema_version', 'mcp_servers', 'mcp_sse_enabled']);
const SERVER_KEYS = new Set([
  'name', 'transport', 'command', 'args', 'url', 'init_timeout_seconds', 'auth',
  'enabled', 'trust',
]);
const AUTH_KEYS = new Set(['kind', 'secret_ref', 'token_url', 'client_id', 'scope']);
const TRUST_KEYS = new Set([
  'status', 'configuration_digest', 'advertised_tools_digest', 'reviewed_at',
]);
const PLAINTEXT_SECRET_KEYS = new Set(['token', 'access_token', 'client_secret', 'password', 'api_key']);

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function hasUnknownKeys(value, allowed) {
  return Object.keys(value).some((key) => !allowed.has(key));
}

function containsPlaintextSecret(value, seen = new Set()) {
  if (Array.isArray(value)) return value.some((item) => containsPlaintextSecret(item, seen));
  if (!plainObject(value) || seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, item]) => (
    PLAINTEXT_SECRET_KEYS.has(key.toLowerCase()) || containsPlaintextSecret(item, seen)
  ));
}

function normalizeAuth(value) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!plainObject(value) || hasUnknownKeys(value, AUTH_KEYS) || containsPlaintextSecret(value)) {
    return { ok: false, reason: containsPlaintextSecret(value) ? 'plaintext_secret' : 'unknown_auth_fields' };
  }
  const limits = { kind: 32, secret_ref: 256, token_url: 4096, client_id: 512, scope: 1024 };
  const auth = {};
  for (const key of AUTH_KEYS) {
    if (value[key] === undefined || value[key] === null || value[key] === '') continue;
    if (typeof value[key] !== 'string') return { ok: false, reason: 'auth_field_invalid' };
    const token = value[key].trim();
    if (!token || token.length > limits[key]) return { ok: false, reason: 'auth_field_invalid' };
    auth[key] = token;
  }
  if (auth.kind && !['bearer', 'oauth_client_credentials'].includes(auth.kind)) {
    return { ok: false, reason: 'auth_kind_invalid' };
  }
  if (!auth.kind && Object.keys(auth).length) return { ok: false, reason: 'auth_kind_invalid' };
  return Object.keys(auth).length ? { ok: true, value: auth } : { ok: true, value: null };
}

function normalizedServerConfig(value) {
  if (!plainObject(value) || hasUnknownKeys(value, SERVER_KEYS) || containsPlaintextSecret(value)) {
    return { ok: false, reason: containsPlaintextSecret(value) ? 'plaintext_secret' : 'unknown_server_fields' };
  }
  if (typeof value.name !== 'string'
    || (value.transport !== undefined && typeof value.transport !== 'string')) {
    return { ok: false, reason: 'server_identity_invalid' };
  }
  const name = value.name.trim();
  const transport = (value.transport || 'stdio').trim().toLowerCase();
  if (!NAME_RE.test(name) || name === 'jenny_local_tools' || !['stdio', 'sse'].includes(transport)) {
    return { ok: false, reason: 'server_identity_invalid' };
  }
  const row = { name, transport };
  if (transport === 'stdio') {
    if (typeof value.command !== 'string') return { ok: false, reason: 'stdio_command_invalid' };
    const command = value.command.trim();
    if (!command || command.length > 2048) return { ok: false, reason: 'stdio_command_invalid' };
    row.command = command;
    if (!Array.isArray(value.args) || value.args.length > 64) {
      if (value.args !== undefined) return { ok: false, reason: 'stdio_args_invalid' };
      row.args = [];
    } else {
      if (value.args.some((entry) => typeof entry !== 'string' || entry.length > 2048)) {
        return { ok: false, reason: 'stdio_args_invalid' };
      }
      row.args = [...value.args];
    }
  } else {
    if (typeof value.url !== 'string') return { ok: false, reason: 'sse_url_invalid' };
    const url = value.url.trim();
    let parsed;
    try { parsed = new URL(url); } catch (_error) { return { ok: false, reason: 'sse_url_invalid' }; }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.hash || url.length > 4096) return { ok: false, reason: 'sse_url_invalid' };
    row.url = url;
    if (value.init_timeout_seconds !== undefined) {
      const timeout = value.init_timeout_seconds;
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120) {
        return { ok: false, reason: 'init_timeout_invalid' };
      }
      row.init_timeout_seconds = timeout;
    }
    const auth = normalizeAuth(value.auth);
    if (!auth.ok) return auth;
    if (auth.value) row.auth = auth.value;
  }
  return { ok: true, value: row };
}

function configurationDigest(server) {
  const normalized = normalizedServerConfig(server);
  return normalized.ok ? sha256(normalized.value) : '';
}

function pendingTrust(server, advertisedToolsDigest = '') {
  return {
    status: 'pending',
    configuration_digest: configurationDigest(server),
    advertised_tools_digest: DIGEST_RE.test(advertisedToolsDigest) ? advertisedToolsDigest : '',
    reviewed_at: '',
  };
}

function normalizeTrust(value, server) {
  if (!plainObject(value) || hasUnknownKeys(value, TRUST_KEYS)) {
    return { ok: false, reason: 'trust_record_invalid' };
  }
  const status = String(value.status || '').trim();
  const configDigest = String(value.configuration_digest || '').trim();
  const toolsDigest = String(value.advertised_tools_digest || '').trim();
  const reviewedAt = String(value.reviewed_at || '').trim();
  if (!['pending', 'approved'].includes(status)
    || !DIGEST_RE.test(configDigest)
    || (toolsDigest && !DIGEST_RE.test(toolsDigest))
    || (reviewedAt && !Number.isFinite(Date.parse(reviewedAt)))) {
    return { ok: false, reason: 'trust_record_invalid' };
  }
  const currentDigest = configurationDigest(server);
  if (configDigest !== currentDigest) return { ok: false, reason: 'trust_configuration_drift' };
  if (status === 'approved' && (!toolsDigest || !reviewedAt)) {
    return { ok: false, reason: 'approved_trust_incomplete' };
  }
  return { ok: true, value: {
    status, configuration_digest: configDigest,
    advertised_tools_digest: toolsDigest, reviewed_at: reviewedAt,
  } };
}

function normalizeCurrentServer(value) {
  const config = normalizedServerConfig(value);
  if (!config.ok) return config;
  if (typeof value.enabled !== 'boolean') return { ok: false, reason: 'enabled_invalid' };
  const trust = normalizeTrust(value.trust, config.value);
  if (!trust.ok) return trust;
  return { ok: true, value: { ...config.value, enabled: value.enabled, trust: trust.value } };
}

function validateDocument(value, { legacy = false } = {}) {
  if (!plainObject(value) || hasUnknownKeys(value, TOP_LEVEL_KEYS)) {
    return { ok: false, reason: 'unknown_top_level_fields' };
  }
  if (!Array.isArray(value.mcp_servers) || value.mcp_servers.length > MAX_SERVERS
    || typeof value.mcp_sse_enabled !== 'boolean') {
    return { ok: false, reason: 'document_shape_invalid' };
  }
  const rows = [];
  const names = new Set();
  for (const raw of value.mcp_servers) {
    const normalized = legacy ? normalizedServerConfig(raw) : normalizeCurrentServer(raw);
    if (!normalized.ok || names.has(normalized.value?.name)) {
      return { ok: false, reason: normalized.reason || 'duplicate_server_identity' };
    }
    names.add(normalized.value.name);
    rows.push(normalized.value);
  }
  return { ok: true, value: {
    mcp_config_schema_version: MCP_CONFIG_SCHEMA_VERSION,
    mcp_sse_enabled: value.mcp_sse_enabled,
    mcp_servers: rows,
  } };
}

function defaultDocument() {
  return { mcp_config_schema_version: MCP_CONFIG_SCHEMA_VERSION, mcp_sse_enabled: false, mcp_servers: [] };
}

class McpConfigStore {
  constructor({ userDataPath, fsImpl = fs, now = () => new Date().toISOString(), log = () => {} } = {}) {
    if (!userDataPath) throw new Error('userDataPath is required for McpConfigStore.');
    this.fs = fsImpl;
    this.now = now;
    this.log = log;
    this.configPath = path.join(userDataPath, DEFAULT_CONFIG_FILENAME);
    this._effective = defaultDocument();
    this._status = { schemaVersion: MCP_CONFIG_SCHEMA_VERSION, readOnly: false, reason: '', migrated: false };
    this._load();
  }

  _load() {
    if (!this.fs.existsSync(this.configPath)) return;
    let rawBytes;
    let parsed;
    try {
      rawBytes = this.fs.readFileSync(this.configPath, 'utf8');
      parsed = JSON.parse(rawBytes);
    } catch (_error) {
      this._status = { ...this._status, readOnly: true, reason: 'malformed_json' };
      return;
    }
    const version = parsed?.mcp_config_schema_version;
    if (version === undefined) {
      const legacy = validateDocument(parsed, { legacy: true });
      if (!legacy.ok) {
        this._status = { ...this._status, readOnly: true, reason: legacy.reason };
        return;
      }
      const migrated = { ...legacy.value, mcp_servers: legacy.value.mcp_servers.map((server) => ({
        ...server, enabled: false, trust: pendingTrust(server),
      })) };
      try {
        this._atomicReplace(migrated, rawBytes);
        this._effective = migrated;
        this._status = { ...this._status, migrated: true };
      } catch (error) {
        const recoveryFailed = error?.code === 'mcp_config_recovery_failed';
        this._status = { ...this._status, readOnly: true,
          reason: recoveryFailed ? 'write_recovery_failed' : 'migration_write_failed' };
        this.log('WARN', recoveryFailed ? 'mcp.config.write_recovery_failed'
          : 'mcp.config.migration_failed', { error_name: error?.name || 'Error' });
      }
      return;
    }
    if (!Number.isInteger(version) || version > MCP_CONFIG_SCHEMA_VERSION) {
      this._status = { schemaVersion: version, readOnly: true, reason: 'future_schema', migrated: false };
      return;
    }
    if (version !== MCP_CONFIG_SCHEMA_VERSION) {
      this._status = { schemaVersion: version, readOnly: true, reason: 'unsupported_schema', migrated: false };
      return;
    }
    const current = validateDocument(parsed);
    if (!current.ok) {
      this._status = { ...this._status, readOnly: true, reason: current.reason };
      return;
    }
    this._effective = current.value;
  }

  _atomicReplace(document, previousBytes = null) {
    const dir = path.dirname(this.configPath);
    this.fs.mkdirSync(dir, { recursive: true });
    const tempPath = `${this.configPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const bytes = `${JSON.stringify(document, null, 2)}\n`;
    let handle;
    let replaced = false;
    try {
      handle = this.fs.openSync(tempPath, 'wx');
      this.fs.writeFileSync(handle, bytes, 'utf8');
      this.fs.fsyncSync(handle);
      this.fs.closeSync(handle);
      handle = null;
      this.fs.renameSync(tempPath, this.configPath);
      replaced = true;
      const verified = validateDocument(JSON.parse(this.fs.readFileSync(this.configPath, 'utf8')));
      if (!verified.ok || JSON.stringify(verified.value) !== JSON.stringify(document)) {
        throw new Error('MCP config post-write verification failed.');
      }
    } catch (error) {
      if (handle !== null && handle !== undefined) {
        try { this.fs.closeSync(handle); } catch (_closeError) { void _closeError; }
      }
      try { if (this.fs.existsSync(tempPath)) this.fs.unlinkSync(tempPath); } catch (_cleanupError) { void _cleanupError; }
      if (replaced) {
        try { this._restorePrevious(previousBytes); }
        catch (restoreError) {
          const recoveryError = new Error('MCP config recovery failed.', { cause: error });
          recoveryError.code = 'mcp_config_recovery_failed';
          recoveryError.restoreErrorName = restoreError?.name || 'Error';
          throw recoveryError;
        }
      }
      throw error;
    }
  }

  _restorePrevious(previousBytes) {
    if (previousBytes === null) {
      if (this.fs.existsSync(this.configPath)) this.fs.unlinkSync(this.configPath);
      if (this.fs.existsSync(this.configPath)) throw new Error('MCP config removal verification failed.');
      return;
    }
    const rollbackPath = `${this.configPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.rollback`;
    let rollbackHandle;
    try {
      rollbackHandle = this.fs.openSync(rollbackPath, 'wx');
      this.fs.writeFileSync(rollbackHandle, previousBytes, 'utf8');
      this.fs.fsyncSync(rollbackHandle);
      this.fs.closeSync(rollbackHandle);
      rollbackHandle = null;
      this.fs.renameSync(rollbackPath, this.configPath);
      if (this.fs.readFileSync(this.configPath, 'utf8') !== previousBytes) {
        throw new Error('MCP config rollback verification failed.');
      }
    } finally {
      if (rollbackHandle !== null && rollbackHandle !== undefined) {
        try { this.fs.closeSync(rollbackHandle); } catch (_closeError) { void _closeError; }
      }
      try { if (this.fs.existsSync(rollbackPath)) this.fs.unlinkSync(rollbackPath); }
      catch (_cleanupError) { void _cleanupError; }
    }
  }

  getState() {
    return {
      document: structuredClone(this._effective),
      schemaVersion: this._status.schemaVersion,
      readOnly: this._status.readOnly,
      reason: this._status.reason,
      migrated: this._status.migrated,
    };
  }

  update(mutator) {
    if (this._status.readOnly) return { ok: false, reason: this._status.reason, read_only: true };
    const candidate = mutator(structuredClone(this._effective));
    const checked = validateDocument(candidate);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    const previousBytes = this.fs.existsSync(this.configPath)
      ? this.fs.readFileSync(this.configPath, 'utf8') : null;
    try {
      this._atomicReplace(checked.value, previousBytes);
      this._effective = checked.value;
      return { ok: true, document: structuredClone(this._effective) };
    } catch (error) {
      if (error?.code === 'mcp_config_recovery_failed') {
        this._status = { ...this._status, readOnly: true, reason: 'write_recovery_failed' };
        this.log('WARN', 'mcp.config.write_recovery_failed', {
          error_name: error?.name || 'Error', restore_error_name: error?.restoreErrorName || 'Error',
        });
        return { ok: false, reason: 'write_recovery_failed', read_only: true,
          recovery_required: true };
      }
      this.log('WARN', 'mcp.config.write_failed', { error_name: error?.name || 'Error' });
      return { ok: false, reason: 'write_failed' };
    }
  }
}

module.exports = {
  MCP_CONFIG_SCHEMA_VERSION,
  DEFAULT_CONFIG_FILENAME,
  McpConfigStore,
  configurationDigest,
  defaultDocument,
  normalizedServerConfig,
  pendingTrust,
  validateDocument,
};
