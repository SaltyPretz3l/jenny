'use strict';

const { HOST_ERROR_CODES } = require('../backend/error-codes');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAttachmentContentStore } = require('./attachment-content-store');
const { AttachmentAssetStore } = require('../attachment-asset-store');
const { BackendService } = require('../backend/backend-service');
const { ShellConfigService } = require('../shell-config-service');
const { createConversationToolExecutor } = require('./conversation-tool-executor');
const {
  HOST_MODE_SERVER,
  createHostPorts,
} = require('./host-ports');

const HOST_MODEL_ENGINES = Object.freeze(['ollama', 'openai-compatible', 'replay']);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidHostOption(code, message) {
  const error = new TypeError(message);
  error.code = HOST_ERROR_CODES.INVALID;
  error.reason = code;
  return error;
}

function normalizeModelEndpoint(value) {
  if (!isRecord(value)) {
    throw invalidHostOption('model_endpoint_required', 'Server host mode requires modelEndpoint.');
  }
  const engine = String(value.engine || '').trim().toLowerCase();
  if (!HOST_MODEL_ENGINES.includes(engine)) {
    throw invalidHostOption(
      'unsupported_model_engine',
      'Hosted model engine must be ollama, openai-compatible, or replay.'
    );
  }
  const model = String(value.model || '').trim();
  if (!model || model.length > 240) {
    throw invalidHostOption('invalid_model_endpoint_model', 'Hosted modelEndpoint.model is required.');
  }
  const apiUrl = String(value.apiUrl || '').trim();
  if (engine !== 'replay') {
    let parsed;
    try {
      parsed = new URL(apiUrl);
    } catch (_error) {
      throw invalidHostOption(
        'invalid_model_endpoint_url',
        'Hosted modelEndpoint.apiUrl must be an http:// or https:// URL.'
      );
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw invalidHostOption(
        'invalid_model_endpoint_url',
        'Hosted modelEndpoint.apiUrl must be an http:// or https:// URL without credentials.'
      );
    }
  }
  return {
    engine,
    model,
    ...(apiUrl ? { apiUrl } : {}),
  };
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
  const relative = path.relative(comparable(parent), comparable(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeWorkspaceRoot(value, options) {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw invalidHostOption('invalid_workspace_root', 'workspaceRoot must be null or an absolute path.');
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048 || /[\0\r\n]/u.test(trimmed) || !path.isAbsolute(trimmed)) {
    throw invalidHostOption('invalid_workspace_root', 'workspaceRoot must be null or an absolute path.');
  }
  const workspaceRoot = resolveExistingRealPath(trimmed);
  try {
    const stat = fs.statSync(workspaceRoot);
    if (!stat.isDirectory()) throw invalidHostOption('workspace_root_not_directory', 'workspaceRoot must be a directory.');
  } catch (error) {
    if (error?.code === HOST_ERROR_CODES.INVALID) throw error;
    if (error?.code !== 'ENOENT') {
      throw invalidHostOption('workspace_root_unreadable', 'workspaceRoot could not be inspected.');
    }
  }
  const sensitivePaths = [options.userDataPath, options.secretsDir]
    .filter((candidate) => typeof candidate === 'string' && candidate.trim())
    .map((candidate) => resolveExistingRealPath(candidate));
  const home = resolveExistingRealPath(os.homedir());
  if (sameOrWithin(home, workspaceRoot) || sameOrWithin(workspaceRoot, home)) {
    throw invalidHostOption('workspace_root_home_overlap', 'workspaceRoot must be separate from the runtime home.');
  }
  if (sensitivePaths.some((candidate) => sameOrWithin(candidate, workspaceRoot)
    || sameOrWithin(workspaceRoot, candidate))) {
    throw invalidHostOption('workspace_root_profile_overlap', 'workspaceRoot must be separate from profile data.');
  }
  return workspaceRoot;
}

function configureWorkspaceRoot(configService, options) {
  if (!Object.prototype.hasOwnProperty.call(options, 'workspaceRoot')) return;
  const value = normalizeWorkspaceRoot(options.workspaceRoot, options);
  configService.setToolsWorkspaceRoot(value, { reason: 'host_workspace_root_configured' });
}

/**
 * Compose a server-mode backend with its real shell config, attachment store,
 * credential port, and externally owned model endpoint.
 *
 * `modelEndpoint` is transient runtime input. It selects the sidecar engine
 * for this backend instance and is never written into shell config.
 */
function createHostedBackend(options = {}) {
  if (!isRecord(options)) {
    throw invalidHostOption('invalid_host_options', 'Hosted backend options must be an object.');
  }
  const userDataPath = String(options.userDataPath || '').trim();
  if (!userDataPath) {
    throw invalidHostOption('user_data_path_required', 'userDataPath is required for hosted backend.');
  }
  if (options.hostMode !== HOST_MODE_SERVER) {
    throw invalidHostOption('server_host_mode_required', 'Hosted backend requires hostMode: server.');
  }
  const policyVersion = options.hostExecutionPolicyVersion ?? 1;
  if (![1, 2].includes(policyVersion) || (policyVersion === 2
    && (!options.executionBroker || ['execute', 'status', 'drainStream', 'close']
      .some((method) => typeof options.executionBroker[method] !== 'function')))) {
    throw invalidHostOption('execution_broker_required', 'Hosted policy 2 requires the command broker.');
  }
  const hostPorts = createHostPorts({
    hostMode: options.hostMode,
    credentialService: options.credentialService,
  });
  const modelEndpoint = normalizeModelEndpoint(options.modelEndpoint);
  const configService = new ShellConfigService({
    userDataPath,
    // A hosted profile receives its root explicitly. Do not let an ambient
    // developer JENNY_TOOLS_WORKSPACE_ROOT seed a server profile by accident.
    env: { ...(options.env || process.env), JENNY_TOOLS_WORKSPACE_ROOT: '' },
  });
  configureWorkspaceRoot(configService, options);

  const attachmentAssetStore = new AttachmentAssetStore({
    rootDir: path.join(userDataPath, 'attachments'),
    nativeImage: null,
  });
  let backend;
  const toolExecutor = createConversationToolExecutor({ configService,
    logger: (level, event, fields) => backend?._emitServiceLog(level, event, fields) });
  backend = new BackendService({
    appVersion: String(options.appVersion || 'hosted').trim() || 'hosted',
    userDataPath,
    repoRoot: options.repoRoot,
    runtimeHome: options.runtimeHome,
    pythonExecutable: options.pythonExecutable,
    defaultModel: modelEndpoint?.model || options.defaultModel || '',
    preferredEngineType: modelEndpoint?.engine || options.preferredEngineType || '',
    modelEndpoint,
    memoryPath: options.memoryPath,
    hostExecutionPolicyVersion: policyVersion,
    hostMode: hostPorts.mode,
    credentialService: hostPorts.credentialService,
    configService,
    attachmentAssetStore,
    historyAttachmentHydrator: createAttachmentContentStore(userDataPath).hydrateHistory,
    toolExecutor,
    // Streaming and cancellation are required host transport contracts. The
    // desktop feature service is absent in this composition; pin these here.
    featureFlags: { ...options.featureFlags, multiplexer: true, chat_cancel: true },
    ...(options.sidecarManager ? { sidecarManager: options.sidecarManager } : {}),
    ...(options.ollamaManager ? { ollamaManager: options.ollamaManager } : {}),
    ...(options.vllmManager ? { vllmManager: options.vllmManager } : {}),
  });

  backend.hostExecutionBroker = options.executionBroker || null;

  let disposed = false;
  let stopPromise = null;
  const start = (startOptions = {}) => {
    if (disposed || stopPromise) return Promise.reject(new Error('Hosted backend lifecycle has ended.'));
    return backend.start(startOptions);
  };
  const stop = (stopOptions = {}) => {
    if (disposed) return Promise.resolve(null);
    stopPromise ||= backend.stop(stopOptions);
    return stopPromise;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    backend.dispose();
  };

  return {
    backend,
    configService,
    start,
    stop,
    dispose,
  };
}

module.exports = {
  createHostedBackend,
};
