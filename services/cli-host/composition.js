'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { BackendService } = require('../backend/backend-service');
const { openAiCompatibleUrlFromService } = require('../backend/session-lockdown-gate');
const { ShellConfigService } = require('../shell-config-service');
const { ToolPermissionStore } = require('../tools/tool-permission-store');
const { createCuratedToolExecutor } = require('./curated-tool-executor');
const { createCeilingPermissionStore, createRunPermissionPolicy } = require('./run-permission-policy');
const {
  CLI_ERROR_CODES,
  assertLocalOnlyEngine,
  assertLocalOnlyModel,
  cliError,
  createInertCodexHooks,
  createRefusingSafeStorage,
} = require('./local-only-providers');

const DEFAULT_FEATURE_FLAGS = Object.freeze({
  session_runtime: true, multiplexer: true, chat_cancel: true,
  canonical_turn_events: false, canonical_bridge: false, phase_events: true,
});
const SIDECAR_EXIT_TIMEOUT_MS = 10_000;
const SIDECAR_EXIT_POLL_MS = 50;

function invalid(reason, message) {
  return cliError(TypeError, CLI_ERROR_CODES.INVALID_OPTION, reason, message);
}

function absolutePath(value, reason) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 2048 || /[\0\r\n]/u.test(text) || !path.isAbsolute(text)) {
    throw invalid(reason, `${reason}: an absolute path is required.`);
  }
  return path.resolve(text);
}

function existingDirectory(value, reason) {
  const resolved = absolutePath(value, reason);
  try {
    const real = fs.realpathSync.native(resolved);
    if (fs.statSync(real).isDirectory()) return real;
  } catch (_error) { /* reported below */ }
  throw invalid(reason, `${reason}: the directory does not exist.`);
}

// The profile may not exist yet, so its nearest existing ancestor is resolved
// to compare it with the workspace through the same links.
function realProfilePath(profilePath) {
  let existing = profilePath;
  const missing = [];
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    missing.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(fs.realpathSync.native(existing), ...missing);
}

function contains(parent, child) {
  const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const relative = path.relative(fold(parent), fold(child));
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw invalid('invalid_options', 'CLI composition options must be an object.');
  }
  const profilePath = realProfilePath(absolutePath(options.profilePath, 'invalid_profile_path'));
  const workspaceRoot = existingDirectory(options.workspaceRoot, 'invalid_workspace_root');
  // Tools bound to the workspace must never reach profile data, and the
  // profile must never sit under a root the model can read.
  if (contains(workspaceRoot, profilePath) || contains(profilePath, workspaceRoot)) {
    throw invalid('invalid_workspace_root', 'The workspace and the profile must not overlap.');
  }
  // The source route spawns `python -m sidecar` in repoRoot; the installed
  // route resolves the packaged binary through `resolvePackagedLaunch` and
  // spawns it in repoRoot (the real resources directory), with no interpreter.
  const repoRoot = existingDirectory(options.repoRoot, 'invalid_repo_root');
  if (options.resolvePackagedLaunch !== undefined && options.resolvePackagedLaunch !== null
    && typeof options.resolvePackagedLaunch !== 'function') {
    throw invalid('invalid_packaged_launch', 'resolvePackagedLaunch must be a function.');
  }
  const resolvePackagedLaunch = options.resolvePackagedLaunch || null;
  const pythonExecutable = resolvePackagedLaunch && !options.pythonExecutable ? undefined
    : absolutePath(options.pythonExecutable, 'invalid_python_executable');
  const pythonRuntimeBundleRoot = options.pythonRuntimeBundleRoot === undefined ? undefined
    : existingDirectory(options.pythonRuntimeBundleRoot, 'invalid_python_runtime_bundle_root');
  const engine = options.engine;
  // The model may be empty: the backend then resolves the engine's active (or
  // first listed) model on the first turn, as the desktop does.
  const model = typeof engine?.model === 'string' ? engine.model.trim() : '';
  if (!engine || typeof engine !== 'object' || (engine.model !== undefined && typeof engine.model !== 'string') || model.length > 240) {
    throw invalid('invalid_engine', 'engine.type is required and engine.model must be a string.');
  }
  if (options.featureFlags !== undefined && (!options.featureFlags || typeof options.featureFlags !== 'object')) {
    throw invalid('invalid_feature_flags', 'featureFlags must be an object.');
  }
  if (options.logger !== undefined && typeof options.logger !== 'function') {
    throw invalid('invalid_logger', 'logger must be a function.');
  }
  if (options.permissions !== undefined && (!options.permissions || typeof options.permissions !== 'object')) {
    throw invalid('invalid_permissions', 'permissions must be an object.');
  }
  // The run's ceiling is fixed before anything reads policy; a bad selector
  // refuses the composition rather than widening it.
  const runPolicy = createRunPermissionPolicy(options.permissions || {});
  return { profilePath, workspaceRoot, repoRoot, pythonExecutable, resolvePackagedLaunch, pythonRuntimeBundleRoot, engineType: engine.type, model,
    featureFlags: { ...DEFAULT_FEATURE_FLAGS, ...options.featureFlags },
    logger: options.logger || (() => {}), runPolicy };
}

function processGone(pid) {
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}

async function waitForExit(pid, timeoutMs = SIDECAR_EXIT_TIMEOUT_MS) {
  const until = Date.now() + timeoutMs;
  while (!processGone(pid)) {
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, SIDECAR_EXIT_POLL_MS));
  }
  return true;
}

/**
 * Compose the desktop-mode backend for a CLI process: its own profile, local
 * engines only, the curated Electron-side tools, no credential storage and an
 * inert Codex integration. The sidecar stays the stateless inference engine.
 */
function composeCliBackend(options) {
  const settings = validateOptions(options);
  const engineType = assertLocalOnlyEngine(settings.engineType);
  assertLocalOnlyModel(engineType, settings.model);
  fs.mkdirSync(settings.profilePath, { recursive: true });
  // An ambient JENNY_TOOLS_WORKSPACE_ROOT must not seed a CLI profile; the
  // root comes from the caller only.
  const configService = new ShellConfigService({ userDataPath: settings.profilePath,
    env: { ...process.env, JENNY_TOOLS_WORKSPACE_ROOT: '' } });
  // openai-compatible is local only when the profile's configured URL is loopback.
  assertLocalOnlyEngine(engineType, { apiUrl: openAiCompatibleUrlFromService({ configService }) });
  configService.setToolsWorkspaceRoot(settings.workspaceRoot, { reason: 'cli_workspace_root_configured' });
  // Every policy read (sidecar snapshot, session authority, tool executor,
  // runtime-operation admission) goes through the run ceiling.
  const storedPermissionStore = new ToolPermissionStore(path.join(settings.profilePath, 'tool-permissions.json'));
  const permissionStore = createCeilingPermissionStore(storedPermissionStore, settings.runPolicy);
  const toolExecutor = createCuratedToolExecutor({ configService, permissionStore, logger: settings.logger });
  const backend = new BackendService({
    userDataPath: settings.profilePath,
    repoRoot: settings.repoRoot,
    pythonExecutable: settings.pythonExecutable,
    // The option names BackendService forwards to SidecarManager
    // (resolvePackagedLaunch) and managed-sidecar-config reads off
    // service.options (pythonRuntimeBundleRoot), as the desktop wiring passes them.
    ...(settings.resolvePackagedLaunch ? { resolvePackagedLaunch: settings.resolvePackagedLaunch } : {}),
    ...(settings.pythonRuntimeBundleRoot ? { pythonRuntimeBundleRoot: settings.pythonRuntimeBundleRoot } : {}),
    defaultModel: settings.model,
    preferredEngineType: engineType,
    configService,
    safeStorage: createRefusingSafeStorage(),
    // Ready means the store reports "encryption unavailable" rather than a
    // transient "not ready" that tells the user to restart the app.
    isSafeStorageReady: () => true,
    toolPermissionStore: permissionStore,
    toolExecutor,
    featureFlags: settings.featureFlags,
    ...createInertCodexHooks(),
  });
  const onServiceLog = (entry) => settings.logger(entry?.level || 'INFO', entry?.event || 'backend.service',
    entry?.details || entry?.data || {});
  backend.on('service-log', onServiceLog);
  backend.drainEarlyServiceLogs().forEach(onServiceLog);

  let closing = null;
  const close = () => {
    closing ||= (async () => {
      const pid = Number(backend.sidecarManager?.getStatus?.().pid || backend.sidecarManager?.process?.pid || 0);
      try { await backend.stop(); } finally {
        backend.dispose();
        backend.off('service-log', onServiceLog);
        configService.flushPendingWorkspaceWrite?.();
      }
      const exited = pid > 0 ? await waitForExit(pid) : true;
      return exited ? { ok: true, sidecar_exited: true } : { ok: false, sidecar_exited: false, pid };
    })();
    return closing;
  };

  return { backend, configService, permissionStore, storedPermissionStore, runPolicy: settings.runPolicy, toolExecutor, close };
}

module.exports = { DEFAULT_FEATURE_FLAGS, composeCliBackend };
