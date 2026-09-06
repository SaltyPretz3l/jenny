'use strict';

// knowledge.addFolder bridge -> handler -> service seam coverage (Wave-R R2).
//
// The 2026-07-05 queue drive reported knowledge.addFolder returning
// {ok:false, reason:'invalid_path'} for every valid absolute directory. That
// turned out to be a FORENSIC-TOOL artifact (the CDP driver eval()'d raw shell
// text, so 'C:\\dev\\jenny' was mangled to 'C:devjenny' before it
// ever reached the bridge -- path.isAbsolute correctly rejects that). The
// application chain is correct.
//
// But the seam had NO integration coverage: tests/knowledge-service.test.js
// calls the service directly with a pre-built payload (vacuous for the bridge),
// and tests/renderer-knowledge-folders.test.js stubs window.jennyShell.knowledge
// entirely. This test wires the REAL preload bridge (createJennyShellBridge)
// through a fake ipcRenderer into the REAL registered IPC handler
// (registerKnowledgeIpcHandlers) and a REAL KnowledgeService, so a future
// regression that drops or reshapes the {path} payload across that seam fails
// here. It is green today; it guards the seam this RCA cleared.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createJennyShellBridge } = require('../services/ipc-contract');
const { registerKnowledgeIpcHandlers } = require('../services/main/ipc-handler-registration');
const { KnowledgeService } = require('../services/knowledge-service');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// Fake ipcMain that records handlers, and a fake ipcRenderer whose invoke()
// routes to the recorded handler exactly as Electron would (handler receives
// (event, ...args); the renderer passes ...args after the channel).
function wireBridgeToHandlers(knowledgeService) {
  const handlers = new Map();
  const ipcMainLike = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  };
  registerKnowledgeIpcHandlers(ipcMainLike, knowledgeService, { enabled: true });

  const ipcRenderer = {
    invoke(channel, ...args) {
      const handler = handlers.get(channel);
      if (!handler) {
        return Promise.reject(new Error(`No handler registered for '${channel}'`));
      }
      return Promise.resolve(handler({ sender: {} }, ...args));
    },
    on() {},
    removeListener() {},
  };
  return createJennyShellBridge({ ipcRenderer });
}

function makeService(featureEnabled) {
  return new KnowledgeService({
    // Tracked: makeService runs once per test and its seed root was never
    // removed, leaving four kb-seed-* directories in TEMP per run.
    userDataPath: createTrackedTempDir('kb-seed-'),
    featureFlagProvider: () => ({ knowledge_layer: featureEnabled }),
  });
}

test('knowledge.addFolder carries {path} across the real bridge->handler->service seam', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-real-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* ignore */ } });

  const bridge = wireBridgeToHandlers(makeService(true));
  const result = await bridge.knowledge.addFolder({ path: dir });

  assert.equal(result.ok, true, `expected ok:true through the seam, got ${JSON.stringify(result)}`);
  assert.ok(result.root && typeof result.root.path === 'string', 'result carries the registered root');
  // Real realpath of a temp dir may differ by symlink normalization; assert the
  // basename survived the round-trip rather than an exact string match.
  assert.equal(path.basename(result.root.path), path.basename(fs.realpathSync(dir)));
});

test('knowledge.getState round-trips through the seam and reflects the added root', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-real2-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* ignore */ } });

  const bridge = wireBridgeToHandlers(makeService(true));
  await bridge.knowledge.addFolder({ path: dir });
  const snapshot = await bridge.knowledge.getState();

  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.roots.length, 1, 'the added root is visible via getState across the seam');
});

test('knowledge.addFolder rejects a non-absolute path with invalid_path (documents the forensic-tool symptom)', async () => {
  const bridge = wireBridgeToHandlers(makeService(true));
  // 'C:devjenny' is exactly what the CDP driver produced after eval()
  // ate the backslashes -- a non-empty, non-absolute string.
  const result = await bridge.knowledge.addFolder({ path: 'C:devjenny' });
  assert.deepEqual(result, { ok: false, reason: 'invalid_path' });
});

test('knowledge.addFolder with the flag off fails closed via the real handler gate', async () => {
  // Flag off => registerKnowledgeIpcHandlers registers nothing, so the invoke
  // rejects as an unknown channel (the intended byte-identical -off posture).
  const handlers = new Map();
  registerKnowledgeIpcHandlers({ handle: (c, h) => handlers.set(c, h) }, makeService(false), { enabled: false });
  assert.equal(handlers.size, 0, 'no knowledge channels are registered when the flag is off');
});
