'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { requireBoundedInteger } = require('./resource-limits');
const { createBrowserAccessPolicy, PRIVATE_HTTPS, LOCALHOST_HTTP } = require('./browser-access-policy');

const SETUP_PENDING_FILE = '.setup-pending.json';
const HOST_CONFIG_SCHEMA_VERSION = 2;
const HOST_EXECUTION_POLICY_VERSION = 2;
const MAX_CONFIG_BYTES = 128 * 1024;
const DEFAULT_RUNTIME_HOME = path.join(os.tmpdir(), 'jenny-host-runtime');
const LISTEN_HOSTS = new Set(['0.0.0.0', '127.0.0.1', '::1']);

const DEFAULT_RESOURCE_LIMITS = Object.freeze({
  maxBodyBytes: 1024 * 1024,
  maxHeaderBytes: 32 * 1024,
  maxResponseBytes: 8 * 1024 * 1024,
  maxConcurrentRequests: 32,
  requestTimeoutMs: 120 * 1000,
});

const RESOURCE_LIMITS = Object.freeze({
  max_body_bytes: { max: 4 * 1024 * 1024, output: 'maxBodyBytes' },
  max_header_bytes: { max: 128 * 1024, output: 'maxHeaderBytes' },
  max_response_bytes: { max: 32 * 1024 * 1024, output: 'maxResponseBytes' },
  max_concurrent_requests: { max: 64, output: 'maxConcurrentRequests' },
  request_timeout_ms: { max: 10 * 60 * 1000, output: 'requestTimeoutMs' },
});

const TOP_LEVEL_FIELDS = new Set([
  'schema_version',
  'host_mode',
  'host_execution_policy_version',
  'canonical_origin',
  'listen_host',
  'port',
  'user_data_path',
  'workspace_root',
  'secrets_dir',
  'memory_path',
  'log_path',
  'runtime_home',
  'model_endpoint',
  'resource_limits',
  'python_executable',
  'browser_access_mode',
  'execution',
]);
const LEGACY_TOP_LEVEL_FIELDS = new Set([...TOP_LEVEL_FIELDS].filter((field) => (
  field !== 'browser_access_mode' && field !== 'execution'
)));
const MODEL_FIELDS = new Set(['engine', 'model', 'api_url']);
const RESOURCE_FIELDS = new Set(Object.keys(RESOURCE_LIMITS));
const EXECUTION_FIELDS = new Set(['mode']);

function invalid(reason, message = 'Invalid hosted configuration.') {
  return Object.assign(new TypeError(message), {
    code: 'CMP-HOST-0001',
    reason,
  });
}

function isRecord(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertClosed(value, fields, reason) {
  if (!isRecord(value) || [...Object.keys(value)].some((key) => !fields.has(key))) {
    throw invalid(reason);
  }
}

function normalizeString(value, field, { max = 512 } = {}) {
  if (typeof value !== 'string') throw invalid(`${field}_invalid`);
  const result = value.trim();
  if (!result || result.length > max || /[\0\r\n]/.test(result)) {
    throw invalid(`${field}_invalid`);
  }
  return result;
}

function boundedInteger(value, maximum, reason = 'invalid_host_limit') {
  try { return requireBoundedInteger(value, maximum); }
  catch (_error) { throw invalid(reason); }
}

function resolveExistingRealPath(targetPath) {
  let current = path.resolve(targetPath);
  const suffix = [];
  while (true) {
    try {
      let resolved = fs.realpathSync.native(current);
      for (let index = suffix.length - 1; index >= 0; index -= 1) {
        resolved = path.join(resolved, suffix[index]);
      }
      return path.resolve(resolved);
    } catch (_error) {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(targetPath);
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function comparable(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sameOrWithin(parent, child) {
  const parentValue = comparable(parent);
  const childValue = comparable(child);
  const relative = path.relative(parentValue, childValue);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizePath(value, field) {
  const normalized = normalizeString(value, field, { max: 2048 });
  if (!path.isAbsolute(normalized)) throw invalid(`${field}_must_be_absolute`);
  return resolveExistingRealPath(normalized);
}

function normalizePythonExecutable(value) {
  const executable = normalizeString(value, 'python_executable', { max: 2048 });
  if (!path.isAbsolute(executable)) throw invalid('python_executable_must_be_absolute');
  // A venv interpreter is usually a symlink. Dereferencing it selects system
  // Python and loses the venv dependency set; this is an operator-owned launch
  // path, not a workspace containment boundary.
  return path.resolve(executable);
}

function assertDirectoryLike(targetPath, field) {
  try {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink()) throw invalid(`${field}_symlink_invalid`);
    if (!stat.isDirectory()) throw invalid(`${field}_not_directory`);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    if (error?.code === 'CMP-HOST-0001') throw error;
    throw invalid(`${field}_unreadable`);
  }
}

function assertWorkspaceSafe(workspaceRoot, sensitivePaths) {
  if (workspaceRoot === null) return;
  const home = resolveExistingRealPath(os.homedir());
  if (sameOrWithin(home, workspaceRoot) || sameOrWithin(workspaceRoot, home)) {
    throw invalid('workspace_root_home_overlap');
  }
  assertDirectoryLike(workspaceRoot, 'workspace_root');
  try {
    const stat = fs.statSync(workspaceRoot);
    if (!stat.isDirectory()) throw invalid('workspace_root_not_directory');
  } catch (error) {
    if (error?.code === 'CMP-HOST-0001') throw error;
    if (error?.code !== 'ENOENT') throw invalid('workspace_root_unreadable');
  }
  if (sensitivePaths.some((candidate) => sameOrWithin(candidate, workspaceRoot)
    || sameOrWithin(workspaceRoot, candidate))) {
    throw invalid('workspace_root_profile_overlap');
  }
}

function normalizeOrigin(value) {
  const raw = normalizeString(value, 'canonical_origin', { max: 512 });
  let parsed;
  try { parsed = new URL(raw); } catch (_error) { throw invalid('canonical_origin_invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw invalid('canonical_origin_invalid');
  }
  return parsed.origin;
}

function normalizeBrowserOrigin(value, browserAccessMode, port) {
  if (browserAccessMode === PRIVATE_HTTPS) return normalizeOrigin(value);
  try {
    return createBrowserAccessPolicy({ browserAccessMode: LOCALHOST_HTTP, canonicalOrigin: value, port }).canonicalOrigin;
  } catch (_error) {
    throw invalid('canonical_origin_invalid');
  }
}

function normalizeExecution(value, workspaceRoot, schemaVersion, declaredPolicyVersion) {
  if (schemaVersion === 1) return null;
  if (value === undefined || value === null) {
    if (declaredPolicyVersion !== 1) {
      throw invalid(declaredPolicyVersion > 2 ? 'host_execution_policy_future' : 'host_execution_policy_unsupported');
    }
    return null;
  }
  assertClosed(value, EXECUTION_FIELDS, 'execution_invalid');
  if (value.mode !== 'offline-copy') throw invalid('execution_mode_invalid');
  if (workspaceRoot === null) throw invalid('execution_workspace_required');
  if (typeof workspaceRoot !== 'string' || workspaceRoot !== '/workspaces/default') {
    throw invalid('execution_workspace_root_fixed');
  }
  if (declaredPolicyVersion !== 2) {
    throw invalid(declaredPolicyVersion > 2 ? 'host_execution_policy_future' : 'host_execution_policy_unsupported');
  }
  return Object.freeze({ mode: 'offline-copy' });
}

function normalizeModelEndpoint(value) {
  assertClosed(value, MODEL_FIELDS, 'model_endpoint_invalid');
  const engine = normalizeString(value.engine, 'model_engine', { max: 32 }).toLowerCase();
  if (!['ollama', 'openai-compatible'].includes(engine)) {
    throw invalid(engine === 'replay' ? 'replay_engine_forbidden' : 'model_engine_unsupported');
  }
  const model = normalizeString(value.model, 'model_name', { max: 240 });
  const apiUrl = normalizeString(value.api_url, 'model_api_url', { max: 2048 });
  let parsed;
  try { parsed = new URL(apiUrl); } catch (_error) { throw invalid('model_api_url_invalid'); }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw invalid('model_api_url_invalid');
  }
  return Object.freeze({ engine, model, apiUrl });
}

function normalizeResourceLimits(value) {
  if (value === undefined) return { ...DEFAULT_RESOURCE_LIMITS };
  assertClosed(value, RESOURCE_FIELDS, 'resource_limits_invalid');
  const result = { ...DEFAULT_RESOURCE_LIMITS };
  for (const [field, spec] of Object.entries(RESOURCE_LIMITS)) {
    if (value[field] === undefined) continue;
    result[spec.output] = boundedInteger(value[field], spec.max);
  }
  return result;
}

function readConfig(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw invalid('config_path_must_be_absolute');
  }
  let stat;
  try { stat = fs.statSync(filePath); } catch (_error) { throw invalid('config_unreadable'); }
  if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw invalid('config_size_invalid');
  let source;
  try { source = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_error) {
    throw invalid('config_json_invalid');
  }
  assertClosed(source, TOP_LEVEL_FIELDS, 'config_unknown_field');
  return source;
}

function loadHostConfig(filePath, { allowPendingSetup = false } = {}) {
  if (!allowPendingSetup && typeof filePath === 'string'
    && fs.existsSync(path.join(path.dirname(filePath), SETUP_PENDING_FILE))) {
    throw invalid('setup_incomplete');
  }
  return normalizeHostConfig(readConfig(filePath));
}

function normalizeHostConfig(source) {
  const schemaVersion = source?.schema_version;
  assertClosed(source, schemaVersion === 1 ? LEGACY_TOP_LEVEL_FIELDS : TOP_LEVEL_FIELDS, 'config_unknown_field');
  if (schemaVersion !== 1 && schemaVersion !== HOST_CONFIG_SCHEMA_VERSION) {
    throw invalid(schemaVersion > HOST_CONFIG_SCHEMA_VERSION
      ? 'config_schema_future' : 'config_schema_unsupported');
  }
  if (source.host_mode !== 'server') throw invalid('server_host_mode_required');
  const declaredPolicyVersion = source.host_execution_policy_version;
  if (schemaVersion === 1 && declaredPolicyVersion !== 1) {
    throw invalid(declaredPolicyVersion > 1 ? 'host_execution_policy_future' : 'host_execution_policy_unsupported');
  }
  if (schemaVersion === HOST_CONFIG_SCHEMA_VERSION
    && (!Number.isInteger(declaredPolicyVersion) || declaredPolicyVersion < 1 || declaredPolicyVersion > HOST_EXECUTION_POLICY_VERSION)) {
    throw invalid(declaredPolicyVersion > HOST_EXECUTION_POLICY_VERSION
      ? 'host_execution_policy_future' : 'host_execution_policy_unsupported');
  }
  const browserAccessMode = schemaVersion === 1 ? PRIVATE_HTTPS : source.browser_access_mode;
  if (schemaVersion === HOST_CONFIG_SCHEMA_VERSION
    && ![PRIVATE_HTTPS, LOCALHOST_HTTP].includes(browserAccessMode)) {
    throw invalid('browser_access_mode_invalid');
  }
  const listenHost = normalizeString(source.listen_host, 'listen_host', { max: 64 });
  if (!LISTEN_HOSTS.has(listenHost)) throw invalid('listen_host_invalid');
  const port = boundedInteger(source.port, 65535);
  const canonicalOrigin = normalizeBrowserOrigin(source.canonical_origin, browserAccessMode, port);
  const userDataPath = normalizePath(source.user_data_path, 'user_data_path');
  const secretsDir = normalizePath(source.secrets_dir, 'secrets_dir');
  const workspaceRoot = source.workspace_root === null
    ? null : normalizePath(source.workspace_root, 'workspace_root');
  const execution = normalizeExecution(source.execution, source.workspace_root, schemaVersion, declaredPolicyVersion);
  const memoryPath = source.memory_path === undefined
    ? normalizePath(path.join(userDataPath, 'sidecar-memory.db'), 'memory_path') : normalizePath(source.memory_path, 'memory_path');
  const logPath = source.log_path === undefined
    ? path.join(userDataPath, 'logs') : normalizePath(source.log_path, 'log_path');
  const runtimeHome = source.runtime_home === undefined
    ? normalizePath(DEFAULT_RUNTIME_HOME, 'runtime_home') : normalizePath(source.runtime_home, 'runtime_home');
  if (comparable(logPath) !== comparable(path.join(userDataPath, 'logs'))) {
    throw invalid('log_path_fixed_to_profile');
  }
  assertDirectoryLike(userDataPath, 'user_data_path');
  assertDirectoryLike(secretsDir, 'secrets_dir');
  assertDirectoryLike(logPath, 'log_path');
  assertDirectoryLike(runtimeHome, 'runtime_home');
  try {
    const memoryStat = fs.lstatSync(memoryPath);
    if (!memoryStat.isFile() || memoryStat.isSymbolicLink() || memoryStat.nlink !== 1) throw invalid('memory_path_invalid');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!sameOrWithin(userDataPath, memoryPath) || !sameOrWithin(userDataPath, logPath)) {
    throw invalid('user_data_path_child_required');
  }
  if (sameOrWithin(userDataPath, secretsDir) || sameOrWithin(secretsDir, userDataPath)) {
    throw invalid('profile_secrets_overlap');
  }
  assertWorkspaceSafe(workspaceRoot, [userDataPath, secretsDir]);
  if ([userDataPath, secretsDir, workspaceRoot].filter(Boolean).some((candidate) => (
    sameOrWithin(candidate, runtimeHome) || sameOrWithin(runtimeHome, candidate)
  ))) {
    throw invalid('runtime_home_overlap');
  }
  const pythonExecutable = source.python_executable === undefined
    ? null : normalizePythonExecutable(source.python_executable);
  return Object.freeze({
    schemaVersion,
    hostMode: 'server',
    hostExecutionPolicyVersion: declaredPolicyVersion,
    browserAccessMode,
    canonicalOrigin,
    listenHost,
    port,
    userDataPath,
    workspaceRoot,
    execution,
    secretsDir,
    memoryPath,
    logPath,
    runtimeHome,
    modelEndpoint: normalizeModelEndpoint(source.model_endpoint),
    resourceLimits: Object.freeze(normalizeResourceLimits(source.resource_limits)),
    ...(pythonExecutable ? { pythonExecutable } : {}),
  });
}

module.exports = {
  DEFAULT_RUNTIME_HOME,
  DEFAULT_RESOURCE_LIMITS,
  HOST_CONFIG_SCHEMA_VERSION,
  HOST_EXECUTION_POLICY_VERSION,
  loadHostConfig,
  normalizeHostConfig,
  SETUP_PENDING_FILE,
  sameOrWithin,
};
