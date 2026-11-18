'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { requireBoundedInteger } = require('./resource-limits');
const { createBrowserAccessPolicy, PRIVATE_HTTPS, LOCALHOST_HTTP } = require('./browser-access-policy');
const { isCleanText } = require('./team/member-schema');
const { parsePublicAddress } = require('./team/invites');
const { isCanonicalRelayUrl } = require('./team/transport/relay-url');
const { MODEL_TRANSFER_LIMITS } = require('./team/model-manifest');

const SETUP_PENDING_FILE = '.setup-pending.json';
const HOST_CONFIG_SCHEMA_VERSION = 3;
const TEAM_MAX_CONCURRENT_REQUESTS = 64;
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
const TEAM_TOP_LEVEL_FIELDS = new Set([...TOP_LEVEL_FIELDS, 'team']);
const TEAM_FIELDS = new Set(['name', 'key_source', 'direct_port']);
const TEAM_OPTIONAL_FIELDS = new Set([...TEAM_FIELDS, 'pool', 'projects_root', 'internet', 'model_relay_flowing',
  'import_dir', 'exchange_dir', 'file_tools']);
// Team host file tools (row 123, the team host file tools plan): whether the Windows file access
// library has passed W14 (the independent review and the race loop). The loader refuses `team.file_tools: true` on
// win32 while this is false, whatever wrote the file. Flipped in that plan's slice 4 when the owner said W14 passed
// (2026-11-17); setting it back to false turns project files off for every Windows host at its next start.
const TEAM_FILE_TOOLS_WINDOWS_REVIEWED = true;
// Model sharing (slice 6-3): transfers the relay lets flow at once, 0 to 4 (absent: 2); 0 turns model sharing off.
// The relay's own ceiling on flowing transfers (one source: model-manifest.js).
const TEAM_MODEL_RELAY_FLOWING_MAX = MODEL_TRANSFER_LIMITS.maxFlowingPerHost;
// The setup service's two mounts (slices 3-13, 3-14): copy-in's read-only source and the export/restore folder.
const TEAM_MOUNT_FIELDS = Object.freeze({ import_dir: 'importDir', exchange_dir: 'exchangeDir' });
// Internet joining; the relay token is never in the config (it lives in the secure store).
const TEAM_INTERNET_FIELDS = Object.freeze(['map_port', 'public_address', 'relay_url']);
// A desktop host (key_source parent_channel) keeps its project folders beside its config.
const DESKTOP_PROJECTS_DIR = 'projects';
const TEAM_POOL_FIELDS = new Set(['context_length']);
// The pool's context length bounds (slice 4a-4): the gateway's context cap.
const TEAM_POOL_CONTEXT_MIN = 2048;
const TEAM_POOL_CONTEXT_MAX = 1048576;
const TEAM_KEY_SOURCES = new Set(['parent_channel', 'secret_file']);
const LEGACY_TOP_LEVEL_FIELDS = new Set([...TOP_LEVEL_FIELDS].filter((field) => (
  field !== 'browser_access_mode' && field !== 'execution'
)));
const MODEL_FIELDS = new Set(['engine', 'model', 'api_url']);
const RESOURCE_FIELDS = new Set(Object.keys(RESOURCE_LIMITS));
const EXECUTION_FIELDS = new Set(['mode']);
// Per-job input copies are staged here (app-writable volume, sandbox mounts it read-only as /inputs).
const EXECUTION_STAGING_ROOT = '/run/jenny-staging';

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

// Windows only: the root shapes the file-access library refuses too, refused here first with the
// spec's reason (a UNC path, a drive root, a `\\?\` or `\\.\` prefix). The volume is the library's call.
// Answers the detail word, or null; off Windows it answers null for every value.
const WINDOWS_ROOT_REASON = 'file_access_root_invalid';
function windowsRootRefusal(value, platform = process.platform) {
  if (platform !== 'win32' || typeof value !== 'string') return null;
  const text = value.trim();
  if (/^[\\/]{2}[?.][\\/]/u.test(text)) return 'device_prefix';
  if (/^[\\/]{2}/u.test(text)) return 'unc_path';
  // A drive-relative form (`C:`, `C:x`) or a rooted one without a drive is left to the
  // absolute-path check, so the answer never depends on the process's current directory.
  if (!/^[A-Za-z]:[\\/]/u.test(text)) return null;
  const resolved = path.win32.resolve(text);
  return path.win32.parse(resolved).root === resolved ? 'drive_root' : null;
}

// The value as written, then the real path it resolved to (a link can name a drive root or share).
function normalizeWindowsSafePath(value, field) {
  const refusal = windowsRootRefusal(value);
  const resolved = refusal ? null : normalizePath(value, field);
  const detail = refusal || windowsRootRefusal(resolved);
  if (detail) throw Object.assign(invalid(WINDOWS_ROOT_REASON), { detail });
  return resolved;
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
  return Object.freeze({ mode: 'offline-copy', stagingRoot: EXECUTION_STAGING_ROOT });
}

// `teamHost`: "local engines only" (review sweeps, second run, X5b-F02): a team host never names a model Ollama sends
// to its hosted service, on either engine (an OpenAI-compatible URL may be Ollama's own /v1), by the node side's rule.
function normalizeModelEndpoint(value, teamHost = false) {
  assertClosed(value, MODEL_FIELDS, 'model_endpoint_invalid');
  const engine = normalizeString(value.engine, 'model_engine', { max: 32 }).toLowerCase();
  if (!['ollama', 'openai-compatible'].includes(engine)) {
    throw invalid(engine === 'replay' ? 'replay_engine_forbidden' : 'model_engine_unsupported');
  }
  const model = normalizeString(value.model, 'model_name', { max: 240 });
  if (teamHost && require('../services/cli-host/local-only-providers').isCloudModelName(model)) throw invalid('team_model_not_local');
  const apiUrl = normalizeString(value.api_url, 'model_api_url', { max: 2048 });
  let parsed;
  try { parsed = new URL(apiUrl); } catch (_error) { throw invalid('model_api_url_invalid'); }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw invalid('model_api_url_invalid');
  }
  return Object.freeze({ engine, model, apiUrl });
}

// The optional `team.pool` block (slice 4a-4): absent means no pool; present, a closed record
// whose one field is the pool's context length. A null value is refused (absent, not null).
function normalizeTeamPool(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => !TEAM_POOL_FIELDS.has(key))) throw invalid('team_pool_invalid');
  const contextLength = value.context_length;
  if (!Number.isSafeInteger(contextLength) || contextLength < TEAM_POOL_CONTEXT_MIN || contextLength > TEAM_POOL_CONTEXT_MAX) {
    throw invalid('team_pool_invalid');
  }
  return Object.freeze({ contextLength });
}

// The optional `team.internet` record: absent is off; present, exactly its three fields, each checked with the
// invite and relay validators, and a direct port to map and to default an address's port to.
function normalizeTeamInternet(value, directPort) {
  const refuse = () => invalid('team_internet_invalid');
  if (!isRecord(value) || Object.keys(value).length !== TEAM_INTERNET_FIELDS.length
    || TEAM_INTERNET_FIELDS.some((key) => !Object.hasOwn(value, key))) throw refuse();
  const { map_port: mapPort, public_address: publicAddress, relay_url: relayUrl } = value;
  if (directPort === null || typeof mapPort !== 'boolean') throw refuse();
  if (publicAddress !== null && parsePublicAddress(publicAddress, directPort).ok !== true) throw refuse();
  if (relayUrl !== null && !isCanonicalRelayUrl(relayUrl)) throw refuse();
  return Object.freeze({ mapPort, publicAddress, relayUrl });
}

// The schema 3 `team` block: a closed record of three required fields and the optional `pool` and `internet`;
// the optional `projects_root` is checked in normalizeHostConfig once the other paths are known.
function normalizeTeam(value) {
  assertClosed(value, TEAM_OPTIONAL_FIELDS, 'team_block_invalid');
  if ([...TEAM_FIELDS].some((field) => !Object.hasOwn(value, field))) throw invalid('team_block_invalid');
  if (!isCleanText(value.name)) throw invalid('team_name_invalid');
  if (!TEAM_KEY_SOURCES.has(value.key_source)) throw invalid('team_key_source_invalid');
  const port = value.direct_port;
  if (port !== null && !(Number.isSafeInteger(port) && port >= 1 && port <= 65535)) {
    throw invalid('team_direct_port_invalid');
  }
  const pool = Object.hasOwn(value, 'pool') ? normalizeTeamPool(value.pool) : null;
  const internet = Object.hasOwn(value, 'internet') ? normalizeTeamInternet(value.internet, port) : null;
  // Absent: the default (model-sharing.js); the normalized block carries the field only when the file does.
  const hasFlowing = Object.hasOwn(value, 'model_relay_flowing');
  const flowing = value.model_relay_flowing;
  if (hasFlowing && !(Number.isSafeInteger(flowing) && flowing >= 0 && flowing <= TEAM_MODEL_RELAY_FLOWING_MAX)) {
    throw invalid('team_model_relay_flowing_invalid');
  }
  // Absent is off; the normalized block carries the field only when the file does.
  const hasFileTools = Object.hasOwn(value, 'file_tools');
  if (hasFileTools && typeof value.file_tools !== 'boolean') throw invalid('team_file_tools_invalid');
  return Object.freeze({ name: value.name, keySource: value.key_source, directPort: port, ...(pool ? { pool } : {}),
    ...(internet ? { internet } : {}), ...(hasFlowing ? { modelRelayFlowing: flowing } : {}),
    ...(hasFileTools ? { fileTools: value.file_tools } : {}) });
}

// `team.file_tools: true` needs the projects root it binds and, on win32, the reviewed library (W14).
function assertTeamFileTools(team, projectsRoot, { platform, windowsFileToolsReviewed }) {
  if (team?.fileTools !== true) return;
  if (!projectsRoot) throw invalid('team_file_tools_no_projects_root');
  if (platform === 'win32' && windowsFileToolsReviewed !== true) throw invalid('team_file_tools_windows_unreviewed');
}

// A team host is loopback-only with no command execution, no workspace and no browser surface.
function assertTeamHostSource(source) {
  const carries = (field) => source[field] !== undefined && source[field] !== null;
  if (source.listen_host !== '127.0.0.1') throw invalid('team_listen_host_loopback_required');
  if (carries('execution')) throw invalid('team_execution_forbidden');
  if (carries('browser_access_mode')) throw invalid('browser_access_mode_invalid');
  if (carries('canonical_origin')) throw invalid('canonical_origin_invalid');
  if (source.workspace_root !== null) throw invalid('team_workspace_forbidden');
}

// The optional `team.projects_root`: a plain directory or absent, never a link; not the home
// directory or an ancestor of it (inside home is allowed: this replaces the workspace rule for this
// one field); no overlap either way with the profile, the secrets or the runtime home.
function normalizeProjectsRoot(value, sensitivePaths) {
  const field = 'team_projects_root';
  const root = normalizeWindowsSafePath(value, field);
  // normalizePath has already followed a link the value names, so the named entry is checked as given.
  assertDirectoryLike(path.resolve(value.trim()), field);
  assertDirectoryLike(root, field);
  if (sameOrWithin(root, resolveExistingRealPath(os.homedir()))) throw invalid(`${field}_home_overlap`);
  if (sensitivePaths.some((candidate) => sameOrWithin(candidate, root) || sameOrWithin(root, candidate))) {
    throw invalid(`${field}_profile_overlap`);
  }
  return root;
}

// The optional mount paths: absolute, never existence-checked (only the setup service mounts them), apart from
// each other and from the profile, the secrets, the runtime home and the projects root's volume.
function normalizeTeamMounts(team, sensitivePaths) {
  const mounts = {};
  for (const [field, key] of Object.entries(TEAM_MOUNT_FIELDS)) {
    if (!Object.hasOwn(team, field)) continue;
    const value = normalizeString(team[field], `team_${field}`, { max: 2048 });
    if (!path.isAbsolute(value)) throw invalid(`team_${field}_must_be_absolute`);
    const resolved = path.resolve(value);
    if ([...sensitivePaths, ...Object.values(mounts)].some((other) => sameOrWithin(other, resolved) || sameOrWithin(resolved, other))) {
      throw invalid('team_mount_overlap');
    }
    mounts[key] = resolved;
  }
  return mounts;
}

function normalizeResourceLimits(value, team = false) {
  const defaults = team
    ? { ...DEFAULT_RESOURCE_LIMITS, maxConcurrentRequests: TEAM_MAX_CONCURRENT_REQUESTS }
    : { ...DEFAULT_RESOURCE_LIMITS };
  if (value === undefined) return defaults;
  assertClosed(value, RESOURCE_FIELDS, 'resource_limits_invalid');
  const result = defaults;
  for (const [field, spec] of Object.entries(RESOURCE_LIMITS)) {
    if (value[field] === undefined) continue;
    result[spec.output] = boundedInteger(value[field], spec.max);
  }
  return result;
}

// Schema 1 has the legacy fields, schema 2 the current ones, schema 3 and above also `team`.
function topLevelFields(schemaVersion) {
  if (schemaVersion === 1) return LEGACY_TOP_LEVEL_FIELDS;
  return schemaVersion >= 3 ? TEAM_TOP_LEVEL_FIELDS : TOP_LEVEL_FIELDS;
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
  assertClosed(source, topLevelFields(source?.schema_version), 'config_unknown_field');
  return source;
}

function loadHostConfig(filePath, { allowPendingSetup = false, platform = process.platform,
  windowsFileToolsReviewed = TEAM_FILE_TOOLS_WINDOWS_REVIEWED } = {}) {
  if (!allowPendingSetup && typeof filePath === 'string'
    && fs.existsSync(path.join(path.dirname(filePath), SETUP_PENDING_FILE))) {
    throw invalid('setup_incomplete');
  }
  const config = normalizeHostConfig(readConfig(filePath), { platform, windowsFileToolsReviewed });
  // The desktop rule, which only a config file can carry: a parent_channel host's projects root is
  // exactly `<directory of the config file>/projects`.
  if (config.team?.keySource === 'parent_channel' && config.team.projectsRoot) {
    const named = path.join(path.dirname(filePath), DESKTOP_PROJECTS_DIR);
    // A link standing at that name is refused, though its target would compare equal.
    assertDirectoryLike(named, 'team_projects_root');
    const expected = resolveExistingRealPath(named);
    if (comparable(expected) !== comparable(config.team.projectsRoot)) throw invalid('team_projects_root_layout_invalid');
  }
  return config;
}

function normalizeHostConfig(source, { platform = process.platform,
  windowsFileToolsReviewed = TEAM_FILE_TOOLS_WINDOWS_REVIEWED } = {}) {
  const schemaVersion = source?.schema_version;
  assertClosed(source, topLevelFields(schemaVersion), 'config_unknown_field');
  if (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== HOST_CONFIG_SCHEMA_VERSION) {
    throw invalid(schemaVersion > HOST_CONFIG_SCHEMA_VERSION
      ? 'config_schema_future' : 'config_schema_unsupported');
  }
  if (source.host_mode !== 'server') throw invalid('server_host_mode_required');
  const team = source.team === undefined ? null : normalizeTeam(source.team);
  if (team) assertTeamHostSource(source);
  // A pool host's model endpoint is the pool gateway, built at start; the config names none.
  if (team?.pool && Object.hasOwn(source, 'model_endpoint')) throw invalid('team_pool_endpoint_conflict');
  const declaredPolicyVersion = source.host_execution_policy_version;
  if (schemaVersion === 1 && declaredPolicyVersion !== 1) {
    throw invalid(declaredPolicyVersion > 1 ? 'host_execution_policy_future' : 'host_execution_policy_unsupported');
  }
  if (schemaVersion >= 2
    && (!Number.isInteger(declaredPolicyVersion) || declaredPolicyVersion < 1 || declaredPolicyVersion > HOST_EXECUTION_POLICY_VERSION)) {
    throw invalid(declaredPolicyVersion > HOST_EXECUTION_POLICY_VERSION
      ? 'host_execution_policy_future' : 'host_execution_policy_unsupported');
  }
  // A team host serves no browser: a team config that carries either browser field was refused above.
  const browserAccessMode = team ? null : schemaVersion === 1 ? PRIVATE_HTTPS : source.browser_access_mode;
  if (!team && schemaVersion >= 2
    && ![PRIVATE_HTTPS, LOCALHOST_HTTP].includes(browserAccessMode)) {
    throw invalid('browser_access_mode_invalid');
  }
  const listenHost = normalizeString(source.listen_host, 'listen_host', { max: 64 });
  if (!LISTEN_HOSTS.has(listenHost)) throw invalid('listen_host_invalid');
  const port = team && source.port === 0 ? 0 : boundedInteger(source.port, 65535);
  const canonicalOrigin = team ? null : normalizeBrowserOrigin(source.canonical_origin, browserAccessMode, port);
  const userDataPath = normalizePath(source.user_data_path, 'user_data_path');
  const secretsDir = normalizePath(source.secrets_dir, 'secrets_dir');
  const workspaceRoot = source.workspace_root === null
    ? null : normalizeWindowsSafePath(source.workspace_root, 'workspace_root');
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
  const projectsRoot = team && Object.hasOwn(source.team, 'projects_root')
    ? normalizeProjectsRoot(source.team.projects_root, [userDataPath, secretsDir, runtimeHome]) : null;
  assertTeamFileTools(team, projectsRoot, { platform, windowsFileToolsReviewed });
  const mounts = team ? normalizeTeamMounts(source.team,
    [userDataPath, secretsDir, runtimeHome, ...(projectsRoot ? [path.dirname(projectsRoot)] : [])]) : {};
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
    // Owner decision E19: a team host has no model until Phase 4, so its config may leave the
    // endpoint out (absent, not null). Every other host still requires one.
    modelEndpoint: team && !Object.hasOwn(source, 'model_endpoint') ? null : normalizeModelEndpoint(source.model_endpoint, team !== null),
    resourceLimits: Object.freeze(normalizeResourceLimits(source.resource_limits, team !== null)),
    ...(pythonExecutable ? { pythonExecutable } : {}),
    ...(team ? { team: projectsRoot || Object.keys(mounts).length
      ? Object.freeze({ ...team, ...(projectsRoot ? { projectsRoot } : {}), ...mounts }) : team } : {}),
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
  TEAM_FILE_TOOLS_WINDOWS_REVIEWED,
  TEAM_MAX_CONCURRENT_REQUESTS,
  TEAM_POOL_CONTEXT_MAX,
  TEAM_POOL_CONTEXT_MIN,
  sameOrWithin,
  resolveExistingRealPath,
  assertWorkspaceSafe,
  windowsRootRefusal,
};
