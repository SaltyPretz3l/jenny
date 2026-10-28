'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MCP_CONFIG_SCHEMA_VERSION = 2;
const DEFAULT_CONFIG_FILENAME = 'mcp-servers.json';
const MAX_SERVERS = 64;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const TOP_LEVEL_KEYS = new Set(['mcp_config_schema_version', 'mcp_servers', 'mcp_sse_enabled']);
const SERVER_KEYS = new Set([
  'name', 'transport', 'command', 'args', 'url', 'init_timeout_seconds', 'auth',
  'env', 'memory_limit_mb', 'max_processes', 'inspect_timeout_seconds', 'request_timeout_seconds',
  'read_only_auto_allow', 'enabled', 'trust', 'prompts',
]);
// Schema v2 row extensions. Each is copied only when the input carries it (no
// injected defaults), so a row without them keeps its v1 configuration digest.
const STDIO_ONLY_KEYS = ['env', 'memory_limit_mb', 'max_processes', 'request_timeout_seconds'];
const ROW_BOUNDS = {
  memory_limit_mb: [256, 8192, 'limits_invalid'],
  max_processes: [1, 32, 'limits_invalid'],
  inspect_timeout_seconds: [1, 180, 'timeout_invalid'],
  request_timeout_seconds: [1, 1800, 'timeout_invalid'],
};
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const MAX_ENV_ENTRIES = 16;
const MAX_ENV_VALUE_CHARS = 1024;
// Mirrors sidecar/ai/config_parsing.py: keys the stdio containment sets or passes
// through, and loader/interpreter controls, never come from a row.
const RESERVED_ENV_KEYS = new Set([
  'PATHEXT', 'PYTHONIOENCODING', 'PYTHONUNBUFFERED', 'OPENBLAS_NUM_THREADS', 'TESSDATA_PREFIX',
  'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'NODE_OPTIONS', 'NODE_PATH',
  'WINDIR', 'AUTHORIZATION',
  'PROGRAMDATA', 'ALLUSERSPROFILE', 'SYSTEMDRIVE', 'PROGRAMFILES', 'PROGRAMW6432',
  'COMMONPROGRAMFILES', 'COMMONPROGRAMW6432', 'PUBLIC',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION', 'OS', 'COMPUTERNAME', 'USERNAME', 'USERDOMAIN',
]);
// Runtime option/loader families: npm maps NPM_CONFIG_NODE_OPTIONS to NODE_OPTIONS
// for the processes it starts, so the whole family is reserved, not one name.
const RESERVED_ENV_PREFIXES = ['JENNY_', 'XDG_', 'PYTHON', 'LD_', 'DYLD_', 'NODE_', 'NPM_',
  'YARN_', 'PNPM_', 'COREPACK_', 'JAVA_', '_JAVA_', 'JDK_', 'ELECTRON_', 'PERL', 'RUBY', 'DOTNET_'];
const RESERVED_ENV_MARKERS = ['PATH', 'OPTIONS', 'OPTS'];
const SECRET_ENV_MARKERS = ['TOKEN', 'SECRET', 'PASSWORD', 'API_KEY', 'PRIVATE'];
const AUTH_KEYS = new Set(['kind', 'secret_ref', 'token_url', 'client_id', 'scope']);
const TRUST_KEYS = new Set([
  'status', 'configuration_digest', 'advertised_tools_digest', 'advertised_prompts_digest', 'reviewed_at',
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

function envKeyRejection(key) {
  if (SECRET_ENV_MARKERS.some((marker) => key.toUpperCase().includes(marker))) return 'plaintext_secret';
  if (!ENV_KEY_RE.test(key)) return 'env_invalid';
  if (RESERVED_ENV_MARKERS.some((marker) => key.includes(marker)) || RESERVED_ENV_KEYS.has(key)
    || RESERVED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) return 'reserved_env_key';
  return '';
}

function normalizeEnv(value) {
  if (!plainObject(value) || Object.keys(value).length > MAX_ENV_ENTRIES) {
    return { ok: false, reason: 'env_invalid' };
  }
  const env = {};
  for (const key of Object.keys(value).sort()) {
    const rejection = envKeyRejection(key);
    if (rejection) return { ok: false, reason: rejection };
    const item = value[key];
    if (typeof item !== 'string' || item.length > MAX_ENV_VALUE_CHARS || /\p{Cc}/u.test(item)) {
      return { ok: false, reason: 'env_invalid' };
    }
    env[key] = item;
  }
  return { ok: true, value: env };
}

function normalizeRowExtensions(value, row) {
  for (const [key, [min, max, reason]] of Object.entries(ROW_BOUNDS)) {
    if (value[key] === undefined) continue;
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) return { ok: false, reason };
    row[key] = value[key];
  }
  if (value.env !== undefined) {
    const env = normalizeEnv(value.env);
    if (!env.ok) return env;
    if (Object.keys(env.value).length) row.env = env.value;
  }
  // Owner decision 9 (row 53): opt-in, both transports, off unless the row says true.
  if (value.read_only_auto_allow !== undefined) {
    if (typeof value.read_only_auto_allow !== 'boolean') return { ok: false, reason: 'read_only_auto_allow_invalid' };
    row.read_only_auto_allow = value.read_only_auto_allow;
  }
  return { ok: true, value: row };
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
  if (transport === 'sse' && STDIO_ONLY_KEYS.some((key) => value[key] !== undefined)) {
    return { ok: false, reason: 'unknown_server_fields' };
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
  return normalizeRowExtensions(value, row);
}

// Project validated store rows without exposing trust state or literal credentials.
function projectServerConfig(server) {
  const config = Object.fromEntries(Object.entries(server).filter(([key]) => (
    SERVER_KEYS.has(key) && key !== 'enabled' && key !== 'trust' && key !== 'prompts'
  )));
  if (Array.isArray(config.args)) config.args = [...config.args];
  if (plainObject(config.env)) config.env = { ...config.env };
  if (plainObject(config.auth)) {
    config.auth = Object.fromEntries(Object.entries(config.auth).filter(([key]) => AUTH_KEYS.has(key)));
    if (!Object.keys(config.auth).length) delete config.auth;
  }
  return config;
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
    advertised_prompts_digest: '',
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
  const promptsDigest = value.advertised_prompts_digest === undefined ? '' : value.advertised_prompts_digest;
  const reviewedAt = String(value.reviewed_at || '').trim();
  if (!['pending', 'approved'].includes(status)
    || !DIGEST_RE.test(configDigest)
    || (toolsDigest && !DIGEST_RE.test(toolsDigest))
    || (typeof promptsDigest !== 'string' || (promptsDigest !== '' && !DIGEST_RE.test(promptsDigest)))
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
    advertised_tools_digest: toolsDigest, advertised_prompts_digest: promptsDigest, reviewed_at: reviewedAt,
  } };
}

function normalizePrompts(value) {
  const invalid = { ok: false, reason: 'prompts_invalid' };
  const nameRe = /^[a-z][a-z0-9_-]{0,63}$/;
  function entries(items, max, argument = false) {
    if (!Array.isArray(items) || items.length > max) return null;
    const names = new Set();
    const normalized = [];
    for (const item of items) {
      if (!plainObject(item) || ![Object.prototype, null].includes(Object.getPrototypeOf(item))
        || Object.keys(item).some((key) => !['name', 'description', argument ? 'required' : 'arguments'].includes(key))
        || typeof item.name !== 'string' || !nameRe.test(item.name) || names.has(item.name)
        || (item.description !== undefined && typeof item.description !== 'string')
        || (argument && item.required !== undefined && typeof item.required !== 'boolean')) return null;
      names.add(item.name);
      const row = { name: item.name, description: (item.description || '').slice(0, 2048) };
      if (argument) row.required = item.required === true;
      else {
        row.arguments = entries(item.arguments === undefined ? [] : item.arguments, 16, true);
        if (!row.arguments) return null;
      }
      normalized.push(row);
    }
    return normalized;
  }
  const prompts = entries(value, 32);
  // Code-point order, as the sidecar sorts them (names are ASCII by the regex).
  return prompts ? { ok: true, value: prompts.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) } : invalid;
}

function approvedPrompts(server) {
  return server?.trust?.status === 'approved' && Array.isArray(server.prompts) ? server.prompts : [];
}

function normalizeCurrentServer(value, includePrompts = true) {
  const config = normalizedServerConfig(value);
  if (!config.ok) return config;
  if (typeof value.enabled !== 'boolean') return { ok: false, reason: 'enabled_invalid' };
  const trust = normalizeTrust(value.trust, config.value);
  if (!trust.ok) return trust;
  const row = { ...config.value, enabled: value.enabled, trust: trust.value };
  // A v1 document never carries prompts, so it never carries their digest either.
  if (!includePrompts) return { ok: true, value: { ...row, trust: { ...trust.value, advertised_prompts_digest: '' } } };
  // Prompts are an approve-time record: a pending row drops them instead of failing.
  if (trust.value.status !== 'approved' || value.prompts === undefined) return { ok: true, value: row };
  const prompts = normalizePrompts(value.prompts);
  return prompts.ok ? { ok: true, value: { ...row, prompts: prompts.value } } : prompts;
}

function validateDocument(value, { legacy = false, includePrompts = true } = {}) {
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
    const normalized = legacy ? normalizedServerConfig(raw) : normalizeCurrentServer(raw, includePrompts);
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
    if (version !== MCP_CONFIG_SCHEMA_VERSION && version !== 1) {
      this._status = { schemaVersion: version, readOnly: true, reason: 'unsupported_schema', migrated: false };
      return;
    }
    const current = validateDocument(parsed, { includePrompts: version !== 1 });
    if (!current.ok) {
      this._status = { ...this._status, readOnly: true, reason: current.reason };
      return;
    }
    this._effective = current.value;
    // v2 only adds optional row keys: a v1 document loads in place with its
    // enabled state and trust records, and the next write persists it as v2.
    if (version === 1) this._status = { ...this._status, schemaVersion: 1, migrated: true };
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
      this._status = { ...this._status, schemaVersion: MCP_CONFIG_SCHEMA_VERSION };
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
  normalizePrompts,
  approvedPrompts,
  projectServerConfig,
  pendingTrust,
  validateDocument,
};
