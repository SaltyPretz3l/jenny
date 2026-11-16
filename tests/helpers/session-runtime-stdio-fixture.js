'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BackendService } = require('../../services/backend/backend-service');
const { ShellConfigService } = require('../../services/shell-config-service');
const { ToolPermissionStore } = require('../../services/tools/tool-permission-store');
const { createConversationToolExecutor } = require('../../services/host/conversation-tool-executor');
const { createFakeSafeStorage } = require('./fake-safe-storage');
const { filesystemResource } = require('../../services/session-runtime/resource-broker');
const protocol = require('../../services/session-runtime/inference-protocol');
const ROOT = path.resolve(__dirname, '../..');
// The suites that use this fixture make their temp directories under <repo>/artifacts, which git
// ignores and a fresh checkout or worktree does not have.
fs.mkdirSync(path.join(ROOT, 'artifacts'), { recursive: true });
// These fixtures drive real child waits; the child tools are no longer offered by default (row 129).
process.env.JENNY_ENABLE_RUNTIME_CHILD_TOOLS = '1';
const PYTHON = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
async function waitFor(predicate, timeout = 15_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Desktop decision fixture timed out');
}
function createBackend(profile, workspace, seen, logs, kind, launchArgs) {
  const configService = new ShellConfigService({ userDataPath: profile });
  configService.setToolsWorkspaceRoot(workspace);
  const permissions = new ToolPermissionStore(path.join(profile, 'tool-permissions.json'));
  if (kind === 'approval') permissions.setPolicy('read_file', 'ask');
  const backend = new BackendService({ userDataPath: profile, repoRoot: ROOT, pythonExecutable: PYTHON, launchArgs,
    defaultModel: 'replay-model', preferredEngineType: 'replay', configService,
    safeStorage: createFakeSafeStorage(), toolPermissionStore: permissions,
    toolExecutor: createConversationToolExecutor({ configService, permissionStore: permissions,
      logger: (level, event, data) => logs.push({ level, event, data }) }),
    featureFlags: { session_runtime: true, multiplexer: true, chat_cancel: true,
      canonical_turn_events: false, canonical_bridge: false, phase_events: true } });
  if (launchArgs) backend.toolExecutor.registry = require('../../services/tools').createDefaultRegistry();
  // Inspect the real initialize result without injecting protocol support.
  const initialize = backend._initializeManagedSidecar.bind(backend);
  backend._initializeManagedSidecar = async (...args) => {
    const result = await initialize(...args);
    assert.ok(result.mcp_servers_connected?.includes('jenny_local_tools'), JSON.stringify(result.mcp_servers_failed));
    assert.ok(['list_dir', 'read_file', 'ask_user'].every(name => result.tools_available?.includes(name)), JSON.stringify(result.tools_available));
    assert.equal(result.runtime_continuation_version, 1);
    assert.equal(protocol.assertRuntimeContinuationProtocol(backend.sidecarClient), true);
    assert.equal(protocol.supportsSessionMessageContext(backend.sidecarClient), true);
    return result;
  };
  backend.on('chat-stream', event => seen.push(event));
  backend.on('service-log', event => logs.push(event));
  return backend;
}

function holdAtAdmission(runtime, workspace, target) {
  const acquire = runtime.resourceBroker.tryAcquire.bind(runtime.resourceBroker);
  let admissions = 0; let held;
  runtime.resourceBroker.tryAcquire = request => {
    if (++admissions === target) {
      const result = acquire({ ownerId: 'fixture-held-file', resources: [
        filesystemResource(runtime.pathResolver.resolve(path.join(workspace, 'blocked.txt')))] });
      assert.equal(result.status, 'granted'); held = result.lease;
    }
    return acquire(request);
  };
  return () => runtime.resourceBroker.release(held, { producerSettled: true });
}

// Stops the backend, releasing fixture-held leases only once stop has begun:
// shutdown has already closed admission and cleared live resource waits, so the
// release cannot resume paused work, and the runtime confirms cleanup instead of
// waiting out its drain timeout (session_runtime.shutdown_unconfirmed).
async function stopReleasingHolds(backend, ...releases) {
  const stopping = backend.stop();
  for (const release of releases) release?.();
  await stopping;
}

// One backend (profile and sidecar) for the cases of a file that never restart, crash or kill the
// sidecar. Each case still gets its own directory, replay script, workspace and session. The
// sidecar is re-initialized with the case's replay script (refreshManagedConfig) instead of being
// started again; process.env.JENNY_REPLAY_SCRIPT stays set for the case and is restored after it.
// Only cases that run to completion belong here: a case that abandons a decision wait or patches
// the runtime leaves the shared runtime dirty for the next case.
function createSharedHost({ prefix, ledger = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const profile = path.join(root, 'profile');
  const base = path.join(root, 'base-workspace');
  fs.mkdirSync(profile); fs.mkdirSync(base);
  const seen = []; const logs = [];
  const priorLedger = process.env.JENNY_OPERATION_LEDGER_ROOT;
  if (ledger) process.env.JENNY_OPERATION_LEDGER_ROOT = path.join(profile, 'operation-ledger');
  let backend = null; let cases = 0;
  const host = {
    async beginCase(t, { calls, files = {}, readFilePolicy = null }) {
      const dir = path.join(root, `case-${++cases}`);
      const workspace = path.join(dir, 'workspace');
      fs.mkdirSync(workspace, { recursive: true });
      for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(workspace, name), content);
      const script = path.join(dir, 'replay.json');
      fs.writeFileSync(script, JSON.stringify({ version: 1, calls }));
      const prior = process.env.JENNY_REPLAY_SCRIPT; process.env.JENNY_REPLAY_SCRIPT = script;
      t.after(() => { if (prior === undefined) delete process.env.JENNY_REPLAY_SCRIPT; else process.env.JENNY_REPLAY_SCRIPT = prior; });
      seen.length = 0; logs.length = 0;
      if (!backend) {
        backend = createBackend(profile, base, seen, logs);
        await backend.start();
      } else {
        // A skipped refresh (null) would leave the sidecar on the previous case's replay script.
        assert.ok(await backend.refreshManagedConfig('shared_host_case'), 'the shared sidecar took this case\'s replay script');
      }
      if (readFilePolicy) backend.toolPermissionStore.setPolicy('read_file', readFilePolicy);
      else backend.toolPermissionStore.clearPolicy('read_file');
      return { backend, seen, logs, profile, workspace, root: dir, key: name => `${name}-${cases}` };
    },
    async close() {
      try { if (backend) await backend.stop(); } finally {
        backend?.dispose();
        if (ledger) { if (priorLedger === undefined) delete process.env.JENNY_OPERATION_LEDGER_ROOT; else process.env.JENNY_OPERATION_LEDGER_ROOT = priorLedger; }
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    },
  };
  return host;
}

async function withReplayScript(script, run) {
  const prior = process.env.JENNY_REPLAY_SCRIPT; process.env.JENNY_REPLAY_SCRIPT = script;
  try { return await run(); } finally {
    if (prior === undefined) delete process.env.JENNY_REPLAY_SCRIPT; else process.env.JENNY_REPLAY_SCRIPT = prior;
  }
}

// The first phase of several cases is identical (start, submit, run to the first pause, stop). A
// group builds it once in `<root>/<key>/live`, freezes a copy of the stopped directory, and every
// case that opens the group gets that directory back at the same path (the profile records the
// workspace path) plus a structured clone of the state the builder returned. Each top-level
// directory of `live` (profile, workspace) is emptied and refilled in place, not replaced: the
// project authority pins the workspace directory's identity. Cases run one after another, so
// `live` has one user at a time; no process may hold it between cases.
function createPhaseCache(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const groups = new Map();
  const remove = target => fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return {
    async open(key, build) {
      if (!groups.has(key)) {
        const live = path.join(root, key, 'live'); const frozen = path.join(root, key, 'frozen');
        groups.set(key, (async () => {
          fs.mkdirSync(live, { recursive: true });
          const state = await build(live);
          fs.cpSync(live, frozen, { recursive: true });
          return { live, frozen, state };
        })());
      }
      const group = await groups.get(key);
      for (const name of fs.readdirSync(group.live)) {
        if (!fs.statSync(path.join(group.frozen, name), { throwIfNoEntry: false })?.isDirectory()) remove(path.join(group.live, name));
        else for (const inner of fs.readdirSync(path.join(group.live, name))) remove(path.join(group.live, name, inner));
      }
      for (const name of fs.readdirSync(group.frozen)) {
        const from = path.join(group.frozen, name); const to = path.join(group.live, name);
        if (!fs.statSync(from).isDirectory()) fs.cpSync(from, to);
        else {
          fs.mkdirSync(to, { recursive: true });
          for (const inner of fs.readdirSync(from)) fs.cpSync(path.join(from, inner), path.join(to, inner), { recursive: true });
        }
      }
      return { dir: group.live, state: structuredClone(group.state) };
    },
    cleanup() { remove(root); },
  };
}

module.exports = { ROOT, waitFor, createBackend, createSharedHost, createPhaseCache, withReplayScript, holdAtAdmission, stopReleasingHolds };
