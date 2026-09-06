'use strict';

const fs = require('fs');

const { normalizeWorkspaceRoot } = require('./shell-config-state');
const { isJennyStateDirRoot } = require('./workspace-root-identity');
const { safeEmitLog } = require('./backend/session-store-logging');

const ROOT_STATUS_TTL_MS = 5000;
const ROOT_STATUS_PROBE_TIMEOUT_MS = 2000;

const ROOT_STATUS = {
  missing: {
    state: 'missing',
    message: 'No workspace root is configured. Workspace-dependent proactive behaviors are blocked.',
  },
  checking: { state: 'checking', message: 'Checking workspace root.' },
  stale: { state: 'stale', message: 'Workspace root status is stale while the path is rechecked.' },
  ready: { state: 'ready', message: 'Workspace root is configured.' },
  invalidKind: {
    state: 'invalid',
    message: 'The configured workspace root is not a directory. Workspace-dependent behaviors are blocked.',
  },
  invalid: {
    state: 'invalid',
    message: 'The configured workspace root does not exist. Workspace-dependent behaviors are blocked.',
  },
  // A previously-persisted root that resolves to Jenny's own .jenny state
  // directory (e.g. a config written before the coordinator/picker guard
  // existed). Surface it as invalid rather than silently using it, which
  // would materialize a doubled .jenny/.jenny/... tree.
  invalidStateDir: {
    state: 'invalid',
    message: 'The configured workspace root is Jenny\'s own internal state directory '
      + '(.jenny) and cannot be used. Workspace-dependent behaviors are blocked until '
      + 'a different root is configured.',
  },
};

function cloneStatus(status) {
  return { state: status.state, message: status.message };
}

function getWorkspaceRootStatus(workspaceRoot, { statSync = null } = {}) {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  if (!normalizedRoot) return cloneStatus(ROOT_STATUS.missing);
  if (isJennyStateDirRoot(normalizedRoot)) return cloneStatus(ROOT_STATUS.invalidStateDir);
  if (typeof statSync !== 'function') return cloneStatus(ROOT_STATUS.checking);

  try {
    const stats = statSync(normalizedRoot);
    return cloneStatus(stats.isDirectory() ? ROOT_STATUS.ready : ROOT_STATUS.invalidKind);
  } catch (_error) {
    return cloneStatus(ROOT_STATUS.invalid);
  }
}

function createWorkspaceRootStatusController({
  stat = fs.promises.stat,
  now = Date.now,
  ttlMs = ROOT_STATUS_TTL_MS,
  probeTimeoutMs = ROOT_STATUS_PROBE_TIMEOUT_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  logger = null,
  onChange = null,
} = {}) {
  const safeTtlMs = Math.max(1, Math.trunc(Number(ttlMs)) || ROOT_STATUS_TTL_MS);
  const safeTimeoutMs = Math.max(1, Math.trunc(Number(probeTimeoutMs)) || ROOT_STATUS_PROBE_TIMEOUT_MS);
  let generation = 0;
  let entry = null;

  function logTimeout() {
    try { logger?.('WARN', 'workspace_root.probe_timeout', { timeout_ms: safeTimeoutMs }); } catch (_error) { /* noop */ }
  }

  function logStateDirRejected() {
    try { logger?.('WARN', 'workspace_root.state_dir_root_rejected', {}); } catch (_error) { /* noop */ }
  }

  function publish(token, status) {
    if (!entry || entry.generation !== token) return cloneStatus(status);
    entry.status = cloneStatus(status);
    entry.updatedAt = now();
    entry.promise = null;
    try { onChange?.(cloneStatus(entry.status)); } catch (_error) { /* listener isolation */ }
    return cloneStatus(entry.status);
  }

  function startProbe(root, initialStatus) {
    const token = ++generation;
    entry = {
      root,
      generation: token,
      status: cloneStatus(initialStatus),
      updatedAt: now(),
      promise: null,
    };
    let timer = null;
    const probe = Promise.resolve().then(() => stat(root)).then(
      (stats) => ({ kind: 'result', stats }),
      () => ({ kind: 'error' })
    );
    const timeout = new Promise((resolve) => {
      timer = setTimeoutImpl(() => resolve({ kind: 'timeout' }), safeTimeoutMs);
      timer?.unref?.();
    });
    entry.promise = Promise.race([probe, timeout]).then((outcome) => {
      if (timer !== null) clearTimeoutImpl(timer);
      if (!entry || entry.generation !== token) return cloneStatus(ROOT_STATUS.stale);
      if (outcome.kind === 'timeout') {
        logTimeout();
        return publish(token, ROOT_STATUS.stale);
      }
      if (outcome.kind === 'error') return publish(token, ROOT_STATUS.invalid);
      return publish(token, outcome.stats?.isDirectory?.() ? ROOT_STATUS.ready : ROOT_STATUS.invalidKind);
    });
    return entry.promise;
  }

  function ensure(workspaceRoot, { force = false } = {}) {
    const root = normalizeWorkspaceRoot(workspaceRoot);
    if (!root) {
      generation += 1;
      entry = {
        root: '', generation, status: cloneStatus(ROOT_STATUS.missing), updatedAt: now(), promise: null,
      };
      return entry;
    }
    // An already-persisted root can resolve to .jenny (e.g. a config written
    // before the coordinator/picker guard existed, or seeded directly from
    // JENNY_TOOLS_WORKSPACE_ROOT). Surface it as invalid without a stat probe
    // rather than silently using it.
    if (isJennyStateDirRoot(root)) {
      generation += 1;
      entry = {
        root, generation, status: cloneStatus(ROOT_STATUS.invalidStateDir), updatedAt: now(), promise: null,
      };
      logStateDirRejected();
      return entry;
    }
    if (!entry || entry.root !== root || force) {
      startProbe(root, ROOT_STATUS.checking);
      return entry;
    }
    if (entry.promise) return entry;
    if (entry.status.state === 'checking') {
      startProbe(root, ROOT_STATUS.checking);
      return entry;
    }
    if ((now() - entry.updatedAt) > safeTtlMs) startProbe(root, ROOT_STATUS.stale);
    return entry;
  }

  function get(workspaceRoot) {
    return cloneStatus(ensure(workspaceRoot).status);
  }

  function refresh(workspaceRoot, options = {}) {
    const current = ensure(workspaceRoot, options);
    return current.promise || Promise.resolve(cloneStatus(current.status));
  }

  function invalidate(workspaceRoot) {
    const root = normalizeWorkspaceRoot(workspaceRoot);
    generation += 1;
    entry = {
      root: root || '',
      generation,
      status: cloneStatus(root ? ROOT_STATUS.checking : ROOT_STATUS.missing),
      updatedAt: now(),
      promise: null,
    };
    return cloneStatus(entry.status);
  }

  return { get, refresh, invalidate };
}

const workspaceRootMethods = {
  _seedWorkspaceRootFromEnvOnce() {
    if (this.state.toolsWorkspaceRoot) return;
    const envWorkspaceRoot = normalizeWorkspaceRoot(this.env.JENNY_TOOLS_WORKSPACE_ROOT);
    if (!envWorkspaceRoot) return;
    if (isJennyStateDirRoot(envWorkspaceRoot)) {
      safeEmitLog(this._logger, 'WARN', 'shell_config.workspace_root_env_seed_rejected', {
        reason: 'state_dir_root',
      });
      return;
    }
    this._writeState(
      { ...this.state, toolsWorkspaceRoot: envWorkspaceRoot },
      'workspace_root_seeded_from_env'
    );
  },

  getToolsWorkspaceRoot() {
    return this.state.toolsWorkspaceRoot;
  },

  setToolsWorkspaceRoot(workspaceRoot, { reason = 'workspace_root_updated' } = {}) {
    const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
    if (normalizedRoot === this.state.toolsWorkspaceRoot) return this.getState();
    this._workspaceRootStatusController?.invalidate(normalizedRoot);
    return this._writeState(
      { ...this.state, toolsWorkspaceRoot: normalizedRoot },
      reason
    );
  },

  clearToolsWorkspaceRoot({ reason = 'workspace_root_cleared' } = {}) {
    if (!this.state.toolsWorkspaceRoot) return this.getState();
    this._workspaceRootStatusController?.invalidate(null);
    return this._writeState(
      { ...this.state, toolsWorkspaceRoot: null },
      reason
    );
  },

  getWorkspaceRootStatus() {
    return this._workspaceRootStatusController?.get(this.state.toolsWorkspaceRoot)
      || getWorkspaceRootStatus(this.state.toolsWorkspaceRoot);
  },
};

module.exports = {
  createWorkspaceRootStatusController,
  getWorkspaceRootStatus,
  workspaceRootMethods,
};
