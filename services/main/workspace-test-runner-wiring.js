'use strict';
// Main-process composition for the Workspace IDE Test Runner: builds the service
// the workspaceTestRunner.* IPC handlers call. Responsibilities:
//   - per-workspace-root storage in userData (config + history files), keyed by a
//     STABLE hash of the realpath'd root, each backed by FileJsonStore (whole-file
//     atomic, ENOENT/corrupt -> default). The config file is user-authored (the
//     authoring UI is a later wave) — until it exists, configs read as [].
//   - storage that FOLLOWS the live root: stores are memoized by root-hash and
//     rebuilt when the active root changes, so configs and history are isolated
//     per workspace and never leak across roots (S4 / S5a).
//   - the default-on `workspace_test_runner` flag gate (S8), read live off the
//     backend service's resolved feature flags — mirroring WorkspaceGitService's
//     featureFlagProvider precedent. Flag off => handlers degrade to a structured
//     disabled envelope and never spawn or persist.
// Execution + lock + reconcile live in workspace-test-runner-service; the headless
// spawn lives in backend/workspace-test-runner-runner (real processes are covered
// by the runner's own tests — here the runner is injected).

const path = require('path');
const crypto = require('crypto');

const { FileJsonStore } = require('../backend/file-json-store');
const { resolveRealPathSafe } = require('../backend/path-utils');
const { createTestRunnerHistory } = require('../workspace-test-runner-history');
const { createWorkspaceTestRunnerService, DEFAULT_TIMEOUT_MS } = require('../workspace-test-runner-service');
const { runTestCommand: defaultRunTestCommand } = require('../backend/workspace-test-runner-runner');

const TEST_RUNNER_SUBDIR = 'test-runner';
const ROOT_HASH_LENGTH = 16;

function hashRoot(realRoot) {
  // On Windows the filesystem is case-insensitive, but resolveRealPathSafe's
  // path.resolve fallback (taken when the root does not exist on disk — e.g. a
  // configured folder was deleted/renamed, or the path was persisted with
  // different casing) PRESERVES the input casing, whereas fs.realpathSync.native
  // canonicalizes it. Lowercasing on win32 makes both branches agree, so a single
  // Windows directory always keys to ONE store regardless of how its case was
  // typed or whether it momentarily disappears (per-root isolation, S4).
  const keyed = process.platform === 'win32' ? String(realRoot).toLowerCase() : String(realRoot);
  return crypto.createHash('sha256').update(keyed).digest('hex').slice(0, ROOT_HASH_LENGTH);
}

function resolveUserDataDir({ app, userDataDir }) {
  const explicit = String(userDataDir || '').trim();
  if (explicit) {
    return explicit;
  }
  if (app && typeof app.getPath === 'function') {
    try {
      return String(app.getPath('userData') || '').trim();
    } catch (_error) {
      return '';
    }
  }
  return '';
}

function disabledEnvelope() {
  return { available: false, reason: 'feature_disabled' };
}

function disabledState() {
  return {
    configs: [],
    history: { byConfig: {} },
    activeRun: null,
    activeConfigId: null,
    available: false,
    reason: 'feature_disabled',
  };
}

/**
 * @param {{
 *   app?:object, userDataDir?:string, shellConfigService:object,
 *   runner?:{runTestCommand:Function}, featureFlagProvider?:Function,
 *   now?:Function, defaultTimeoutMs?:number, makeRunId?:Function, log?:Function,
 * }} deps
 * @returns {{ listConfigs:Function, run:Function, abort:Function, abortAndWait:Function, dispose:Function, saveConfigs:Function, getState:Function }}
 */
function createWorkspaceTestRunnerWiring(deps = {}) {
  const shellConfigService = deps.shellConfigService || null;
  const userDataDir = resolveUserDataDir(deps);
  const runTestCommand = deps.runner && typeof deps.runner.runTestCommand === 'function'
    ? deps.runner.runTestCommand
    : defaultRunTestCommand;
  const featureFlagProvider = typeof deps.featureFlagProvider === 'function' ? deps.featureFlagProvider : null;
  // S13: the bridge-event sender for the workspaceTestRunner.onStateChanged push.
  const sendBridgeEvent = typeof deps.sendBridgeEvent === 'function' ? deps.sendBridgeEvent : null;
  const now = typeof deps.now === 'function' ? deps.now : () => new Date();
  const defaultTimeoutMs = Number.isFinite(Number(deps.defaultTimeoutMs)) && Number(deps.defaultTimeoutMs) > 0
    ? Number(deps.defaultTimeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const log = typeof deps.log === 'function' ? deps.log : null;

  function currentRoot() {
    if (!shellConfigService || typeof shellConfigService.getToolsWorkspaceRoot !== 'function') {
      return '';
    }
    return String(shellConfigService.getToolsWorkspaceRoot() || '').trim();
  }

  // Single-slot memo: only one workspace root is active at a time. When the root
  // changes, rebuild the stores (and reconcile crash-orphaned 'running' records
  // for the new root). FileJsonStore writes are synchronous (no debounce), so
  // there is never a pending write to lose on a rebuild.
  let cachedHash = null;
  let cachedBundle = null;

  function bundleForCurrentRoot() {
    const root = currentRoot();
    if (!root || !userDataDir) {
      cachedHash = null;
      cachedBundle = null;
      return null;
    }
    const hash = hashRoot(resolveRealPathSafe(root) || root);
    if (cachedBundle && cachedHash === hash) {
      return cachedBundle;
    }
    const dir = path.join(userDataDir, TEST_RUNNER_SUBDIR);
    const configStore = new FileJsonStore(path.join(dir, `${hash}.config.json`), { logger: log });
    const historyStore = new FileJsonStore(path.join(dir, `${hash}.history.json`), { logger: log });
    const history = createTestRunnerHistory({ store: historyStore, now });
    // S5b for THIS root: a 'running' orphaned by a prior crash/reload becomes
    // 'interrupted' the first time we touch the root's history, so a phantom
    // 'running' never reaches trend math.
    try {
      history.reconcileRunning();
    } catch (_error) {
      /* best-effort reconcile */
    }
    cachedHash = hash;
    cachedBundle = { hash, configStore, historyStore, history };
    return cachedBundle;
  }

  // A single run's recordStart and recordFinish straddle the `await
  // runner.runTestCommand(...)` inside the service. Read-path proxy methods (read
  // / getHistory / reconcileRunning) follow the LIVE root, but the start/finish
  // pair must stay PINNED to the root the run started under: otherwise a
  // workspace-root switch mid-run would land the start on root A and the finish
  // on root B, leaving a permanent phantom 'running' in A and a spurious orphan
  // in B (per-root isolation + S5b violation). The service's single-run lock
  // guarantees at most one in-flight run, so one pinned slot suffices.
  let pinnedRun = null;

  // History proxy: the long-lived service holds one `history` reference, but it
  // must always resolve to the CURRENT root's history instance.
  const historyProxy = {
    read: () => {
      const bundle = bundleForCurrentRoot();
      return bundle ? bundle.history.read() : { byConfig: {} };
    },
    getHistory: (configId) => {
      const bundle = bundleForCurrentRoot();
      return bundle ? bundle.history.getHistory(configId) : [];
    },
    recordStart: (configId, record) => {
      const bundle = bundleForCurrentRoot();
      if (bundle) {
        pinnedRun = { runId: String((record && record.runId) || ''), bundle };
        bundle.history.recordStart(configId, record);
      }
    },
    // A skip is terminal on arrival and never pairs with a finish, so it goes to
    // the LIVE root like the read path (nothing to pin).
    recordSkip: (configId, record) => {
      const bundle = bundleForCurrentRoot();
      if (bundle) {
        bundle.history.recordSkip(configId, record);
      }
    },
    recordFinish: (configId, runId, patch) => {
      // Route the finish to the SAME root the run started under (pinned at
      // recordStart), not the live root, so a mid-run root switch can't split it.
      let bundle;
      if (pinnedRun && pinnedRun.runId === String(runId || '')) {
        bundle = pinnedRun.bundle;
        pinnedRun = null;
      } else {
        bundle = bundleForCurrentRoot();
      }
      if (bundle) {
        bundle.history.recordFinish(configId, runId, patch);
      }
    },
    reconcileRunning: () => {
      const bundle = bundleForCurrentRoot();
      return bundle ? bundle.history.reconcileRunning() : 0;
    },
  };

  function configProvider() {
    const bundle = bundleForCurrentRoot();
    if (!bundle) {
      return [];
    }
    const raw = bundle.configStore.read({ configs: [] });
    return raw && Array.isArray(raw.configs) ? raw.configs : [];
  }

  // S18: persist the authored, normalized config set to the live root's config
  // store. No bundle (no root/userData) -> nothing is written (the service has
  // already returned ROOT_MISSING in that case, but guard defensively).
  function configWriter(configs) {
    const bundle = bundleForCurrentRoot();
    if (bundle) {
      bundle.configStore.write({ configs });
    }
  }

  const service = createWorkspaceTestRunnerService({
    runner: { runTestCommand },
    history: historyProxy,
    rootProvider: currentRoot,
    configProvider,
    configWriter,
    now,
    defaultTimeoutMs,
    makeRunId: deps.makeRunId,
    log,
    // S13: forward the service's run lifecycle to the renderer as a bridge push.
    // Flag-gated (belt-and-braces: run/abort are already gated, so the service
    // only emits under an enabled run) so a disabled feature never pushes.
    onStateChange: (payload) => {
      if (sendBridgeEvent && flagEnabled()) {
        sendBridgeEvent('workspaceTestRunner.onStateChanged', payload);
      }
    },
  });

  // Fail-closed: with no provider the gate reads disabled even though the
  // INTERNAL flag is default-on. Production always passes a provider.
  function flagEnabled() {
    const flags = featureFlagProvider ? featureFlagProvider() : null;
    return Boolean(flags && flags.workspace_test_runner === true);
  }

  return {
    listConfigs: () => (flagEnabled() ? service.listConfigs() : disabledEnvelope()),
    run: (payload) => (flagEnabled() ? service.run(payload) : disabledEnvelope()),
    // S14: abort is flag-gated like run — off => inert disabled envelope (no signal),
    // never reaching the service's controller.
    abort: () => (flagEnabled() || service.getState().activeRun ? service.abort() : disabledEnvelope()),
    abortAndWait: () => service.abortAndWait(),
    dispose: () => service.dispose(),
    // S18: flag-gated config write — off => inert disabled envelope (no persist).
    saveConfigs: (configs) => (flagEnabled() ? service.saveConfigs(configs) : disabledEnvelope()),
    getState: () => {
      if (flagEnabled()) return service.getState();
      const state = service.getState();
      return state.activeRun
        ? { ...disabledState(), activeRun: state.activeRun, activeConfigId: state.activeConfigId }
        : disabledState();
    },
  };
}

module.exports = {
  createWorkspaceTestRunnerWiring,
};
