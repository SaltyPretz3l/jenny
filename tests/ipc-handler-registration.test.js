'use strict';

// Coverage for services/main/ipc-handler-registration.js — the registry that
// wires every main<->renderer IPC endpoint. Before this file it had zero direct
// tests despite being actively modified. The registration functions are pure
// `register*(ipcMainLike, deps)` shapes, so a Map-backed fake ipcMain (the same
// pattern as tests/auxiliary-ipc-handlers.test.js) exercises them end to end
// without Electron. getBridgeChannel resolves the wire channel for each method
// path, so a handler registered under an unknown/invalid path throws at
// registration — calling registerMainIpcHandlers without throwing is itself an
// assertion that every path is a valid 'invoke'/'send' bridge descriptor.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { getBridgeChannel } = require('../services/ipc-contract');
const {
  registerFeatureIpcHandlers,
  registerGuidanceIpcHandlers,
  registerMainIpcHandlers,
  registerWorkspaceFsIpcHandlers,
  registerWorkspaceGitIpcHandlers,
  registerWorkspaceIpcHandlers,
  registerWorkspaceTerminalShutdownTask,
  registerWorkspaceRootIpcHandlers,
} = require('../services/main/ipc-handler-registration');

function createFakeIpcMain() {
  const invoke = new Map();
  const send = new Map();
  return {
    handle(channel, handler) {
      invoke.set(channel, handler);
    },
    on(channel, handler) {
      send.set(channel, handler);
    },
    invoke,
    send,
  };
}

const invokeChannel = (methodPath) => getBridgeChannel(methodPath, 'invoke');
const sendChannel = (methodPath) => getBridgeChannel(methodPath, 'send');

// A recording service double: every property access yields a function that logs
// its name + args and echoes them back, so handler forwarding is assertable
// without enumerating each method.
function createRecorder() {
  const calls = [];
  const proxy = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === '__calls') return calls;
        return (...args) => {
          calls.push([prop, args]);
          return { __from: prop, args };
        };
      },
    }
  );
  return { proxy, calls };
}

describe('registerWorkspaceIpcHandlers', () => {
  test('wires workspace + IDE state channels to configService', async () => {
    const ipc = createFakeIpcMain();
    const calls = [];
    const configService = {
      getWorkspaceState: () => ({ kind: 'ws' }),
      updateWorkspaceState: (patch) => {
        calls.push(['update', patch]);
        return { ok: true };
      },
      getWorkspaceIdeState: () => ({ kind: 'ide' }),
      getWorkspaceIdeStore: () => ({ preferences: {} }),
      updateWorkspaceIdePreferences: (patch) => {
        calls.push(['ide', patch]);
        return { ok: true };
      },
    };

    registerWorkspaceIpcHandlers(ipc, configService);

    assert.deepEqual(await ipc.invoke.get(invokeChannel('workspace.getState'))(), { kind: 'ws' });
    await ipc.invoke.get(invokeChannel('workspace.updateState'))({}, { a: 1 });
    assert.deepEqual(calls[0], ['update', { a: 1 }]);
    const ide = await ipc.invoke.get(invokeChannel('workspaceIde.getState'))();
    assert.equal(ide.ok, true);
    assert.equal(ide.kind, 'ide');
    assert.equal(ide.context.rootId, null);
    await ipc.invoke.get(invokeChannel('workspaceIde.updateSettings'))({}, { fontSize: 16, openTabs: ['x'] });
    assert.deepEqual(calls[1], ['ide', { fontSize: 16 }]);
  });
});

describe('registerWorkspaceFsIpcHandlers', () => {
  test('forwards payloads and gates watch start/stop on watcher presence', async () => {
    const { proxy } = createRecorder();

    const noWatcher = createFakeIpcMain();
    registerWorkspaceFsIpcHandlers(noWatcher, proxy, { watcher: null });
    // 15 legacy service channels + 3 versioned channels + watchStart/Stop.
    assert.equal(noWatcher.invoke.size, 20);
    assert.deepEqual(await noWatcher.invoke.get(invokeChannel('workspaceFs.watchStart'))(), {
      watching: false,
    });
    assert.deepEqual(await noWatcher.invoke.get(invokeChannel('workspaceFs.watchStop'))(), {
      watching: false,
    });
    assert.deepEqual(
      await noWatcher.invoke.get(invokeChannel('workspaceFs.readFile'))({}, { path: 'a.txt' }),
      { __from: 'readFile', args: [{ path: 'a.txt' }] }
    );
    assert.deepEqual(
      await noWatcher.invoke.get(invokeChannel('workspaceFs.listAllFiles'))({}, {
        maxDirectories: 12,
        maxDurationMs: 250,
      }),
      { __from: 'listAllFiles', args: [{ maxDirectories: 12, maxDurationMs: 250 }] }
    );
    // Spot-checking three channels left the other mappings free to be wrong --
    // `readFileBase64` could forward to `readFile` and nothing would notice.
    for (const method of ['readFileBase64', 'stat', 'writeFile', 'listDirectory', 'createFile',
      'createDirectory', 'rename', 'delete', 'searchInFiles', 'revealInFolder',
      'openInDefaultApp', 'readPreChange']) {
      const payload = { probe: `fs-${method}` };
      assert.deepEqual(
        await noWatcher.invoke.get(invokeChannel(`workspaceFs.${method}`))({}, payload),
        { __from: method, args: [payload] },
        `workspaceFs.${method} must forward to ${method}`
      );
    }
    assert.deepEqual(
      await noWatcher.invoke.get(invokeChannel('workspaceFs.getRootState'))({}, { ignored: true }),
      { __from: 'getRootState', args: [] }
    );

    const withWatcher = createFakeIpcMain();
    const watcher = { start: () => ({ watching: true }), stop: () => ({ watching: false }) };
    registerWorkspaceFsIpcHandlers(withWatcher, proxy, { watcher });
    assert.deepEqual(await withWatcher.invoke.get(invokeChannel('workspaceFs.watchStart'))(), {
      watching: true,
    });
    assert.deepEqual(await withWatcher.invoke.get(invokeChannel('workspaceFs.watchStop'))(), {
      watching: false,
    });
  });

  test('defaults to no watcher when options omitted', async () => {
    const ipc = createFakeIpcMain();
    const { proxy } = createRecorder();
    registerWorkspaceFsIpcHandlers(ipc, proxy);
    assert.deepEqual(await ipc.invoke.get(invokeChannel('workspaceFs.watchStart'))(), {
      watching: false,
    });
  });
});

describe('registerWorkspaceGitIpcHandlers', () => {
  test('wires all 14 workspaceGit channels and forwards the payload', async () => {
    const ipc = createFakeIpcMain();
    const { proxy } = createRecorder();
    registerWorkspaceGitIpcHandlers(ipc, proxy);

    const paths = [
      'workspaceGit.getStatus', 'workspaceGit.getDiff', 'workspaceGit.getCommitDiff',
      'workspaceGit.getFileAtHead',
      'workspaceGit.getLog', 'workspaceGit.getBranches', 'workspaceGit.blameRange',
      'workspaceGit.stage', 'workspaceGit.unstage', 'workspaceGit.commit',
      'workspaceGit.discardFile', 'workspaceGit.checkout', 'workspaceGit.stash',
      'workspaceGit.undoLastCommit',
    ];
    assert.equal(ipc.invoke.size, 14);
    for (const methodPath of paths) {
      assert.equal(ipc.invoke.has(invokeChannel(methodPath)), true, `expected ${methodPath}`);
    }
    // Every mapping, not two: the channel name IS the expected service method, so
    // a swapped arm (getLog -> getBranches) reds here instead of shipping.
    for (const methodPath of paths) {
      const method = methodPath.slice('workspaceGit.'.length);
      const payload = { probe: `git-${method}` };
      assert.deepEqual(
        await ipc.invoke.get(invokeChannel(methodPath))({}, payload),
        { __from: method, args: [payload] },
        `${methodPath} must forward to ${method}`
      );
    }
  });
});

describe('registerWorkspaceRootIpcHandlers', () => {
  test('wires the transactional root transition callbacks and prepare-only aliases', async () => {
    const ipc = createFakeIpcMain();
    registerWorkspaceRootIpcHandlers(ipc, {
      getState: () => 'root-state',
      captureContext: () => 'root-context',
      prepareChoose: async () => 'choose-prepared',
      prepareClear: () => 'clear-prepared',
      commit: (payload) => ['committed', payload],
      cancel: (payload) => ['canceled', payload],
      respondExternalTransition: (payload) => ['external-response', payload],
    });
    assert.equal(await ipc.invoke.get(invokeChannel('workspaceRoot.getState'))(), 'root-state');
    assert.equal(await ipc.invoke.get(invokeChannel('workspaceRoot.captureContext'))(), 'root-context');
    assert.equal(await ipc.invoke.get(invokeChannel('workspaceRoot.prepareChoose'))(), 'choose-prepared');
    assert.equal(await ipc.invoke.get(invokeChannel('workspaceRoot.prepareClear'))(), 'clear-prepared');
    assert.deepEqual(
      await ipc.invoke.get(invokeChannel('workspaceRoot.commit'))({}, { transitionId: 'one' }),
      ['committed', { transitionId: 'one' }]
    );
    assert.deepEqual(
      await ipc.invoke.get(invokeChannel('workspaceRoot.cancel'))({}, { transitionId: 'two' }),
      ['canceled', { transitionId: 'two' }]
    );
    assert.deepEqual(
      await ipc.invoke.get(invokeChannel('workspaceRoot.respondExternalTransition'))({}, {
        request_id: 'external-1', transition_id: 'transition-1', outcome: { committed: true },
      }),
      ['external-response', {
        request_id: 'external-1', transition_id: 'transition-1', outcome: { committed: true },
      }]
    );
  });

  test('versioned text handlers return serializable success and refusal envelopes', async () => {
    const ipc = createFakeIpcMain();
    const { proxy } = createRecorder();
    const calls = [];
    const versionedFileService = {
      async readText(payload) {
        calls.push(['readText', payload]);
        return { path: payload.path, fileVersion: 'vf2_open', editable: true };
      },
      async readImage(payload) {
        calls.push(['readImage', payload]);
        return {
          path: payload.path,
          fileVersion: 'vf2_image',
          kind: 'image',
          representation: 'base64',
        };
      },
      async writeText(payload) {
        calls.push(['writeText', payload]);
        const error = new Error('File changed on disk since it was loaded.');
        error.code = 'CMP-WORKSPACEFS-0020';
        error.error_code = error.code;
        error.details = { path_hash: 'abc123', current_file_version: 'vf2_new' };
        throw error;
      },
    };
    registerWorkspaceFsIpcHandlers(ipc, proxy, { versionedFileService });

    assert.deepEqual(
      await ipc.invoke.get(invokeChannel('workspaceFs.readText'))({}, { path: 'note.txt' }),
      { ok: true, path: 'note.txt', fileVersion: 'vf2_open', editable: true }
    );
    assert.deepEqual(
      await ipc.invoke.get(invokeChannel('workspaceFs.readImage'))({}, { path: 'logo.png' }),
      {
        ok: true,
        path: 'logo.png',
        fileVersion: 'vf2_image',
        kind: 'image',
        representation: 'base64',
      }
    );
    assert.deepEqual(
      await ipc.invoke.get(invokeChannel('workspaceFs.writeText'))({}, {
        path: 'note.txt', content: 'new', expectedGeneration: 1, expectedFileVersion: 'vf2_open',
      }),
      {
        ok: false,
        code: 'CMP-WORKSPACEFS-0020',
        error_code: 'CMP-WORKSPACEFS-0020',
        message: 'File changed on disk since it was loaded.',
        details: { path_hash: 'abc123', current_file_version: 'vf2_new' },
      }
    );
    assert.deepEqual(calls.map(([name]) => name), ['readText', 'readImage', 'writeText']);
  });
});

describe('registerWorkspaceTerminalShutdownTask', () => {
  test('prefers the awaited main lifecycle task hook and disposes both terminal services', async () => {
    const calls = [];
    const lifecycle = {
      registerShutdownTask(task) {
        calls.push(['registered', task]);
      },
    };
    const mode = registerWorkspaceTerminalShutdownTask({
      getMainLifecycle: () => lifecycle,
      app: {
        once() {
          calls.push(['app-once']);
        },
      },
      workspaceTerminalService: {
        async dispose() {
          calls.push(['terminal']);
        },
      },
      workspacePtyService: {
        dispose() {
          calls.push(['pty']);
        },
      },
    });

    assert.equal(mode, 'lifecycle');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'registered');
    await calls[0][1]();
    assert.deepEqual(calls.map(([kind]) => kind), ['registered', 'terminal', 'pty']);
  });

  test('falls back to injected app will-quit when no lifecycle task hook exists', async () => {
    const calls = [];
    let willQuit = null;
    const mode = registerWorkspaceTerminalShutdownTask({
      getMainLifecycle: () => null,
      app: {
        once(eventName, handler) {
          calls.push(['once', eventName]);
          willQuit = handler;
        },
      },
      workspaceTerminalService: {
        dispose() {
          calls.push(['terminal']);
        },
      },
      workspacePtyService: {
        dispose() {
          calls.push(['pty']);
        },
      },
    });

    assert.equal(mode, 'will-quit');
    assert.deepEqual(calls, [['once', 'will-quit']]);
    await willQuit();
    assert.deepEqual(calls.map(([kind]) => kind), ['once', 'terminal', 'pty']);
  });
});

describe('registerGuidanceIpcHandlers', () => {
  test('wires skills + tips channels', async () => {
    const ipc = createFakeIpcMain();
    const skillService = {
      getState: () => 'skills-state',
      updateSettings: (patch) => ({ updated: patch }),
      openScopeFolder: (scope) => ({ opened: scope }),
    };
    const tipService = {
      getState: () => 'tips-state',
      updateSettings: (patch) => ({ tip: patch }),
    };
    registerGuidanceIpcHandlers(ipc, skillService, tipService);

    assert.equal(await ipc.invoke.get(invokeChannel('skills.getState'))(), 'skills-state');
    assert.deepEqual(await ipc.invoke.get(invokeChannel('skills.updateSettings'))({}, { x: 1 }), {
      updated: { x: 1 },
    });
    assert.deepEqual(await ipc.invoke.get(invokeChannel('skills.openScopeFolder'))({}, 'user'), {
      opened: 'user',
    });
    assert.equal(await ipc.invoke.get(invokeChannel('tips.getState'))(), 'tips-state');
    assert.deepEqual(await ipc.invoke.get(invokeChannel('tips.updateSettings'))({}, { y: 2 }), {
      tip: { y: 2 },
    });
  });
});

describe('registerFeatureIpcHandlers', () => {
  test('wires feature state channels to injected callbacks', async () => {
    const ipc = createFakeIpcMain();
    const updates = [];
    registerFeatureIpcHandlers(ipc, {
      getState: () => ({ flags: {} }),
      updateSettings: (patch) => {
        updates.push(patch);
        return { ok: true };
      },
    });
    assert.deepEqual(await ipc.invoke.get(invokeChannel('features.getState'))(), { flags: {} });
    await ipc.invoke.get(invokeChannel('features.updateSettings'))({}, { f: true });
    assert.deepEqual(updates[0], { f: true });
  });

  test('falls back to no-op defaults when deps omitted', async () => {
    const ipc = createFakeIpcMain();
    registerFeatureIpcHandlers(ipc);
    assert.deepEqual(await ipc.invoke.get(invokeChannel('features.getState'))(), {});
    assert.deepEqual(await ipc.invoke.get(invokeChannel('features.updateSettings'))({}, { f: 1 }), {});
  });
});

describe('registerMainIpcHandlers', () => {
  function buildDeps(overrides = {}) {
    const backend = createRecorder();
    const backendService = new Proxy(backend.proxy, {
      get(target, prop) {
        if (prop === 'sessionStore' || prop === 'attachmentAssetStore' || prop === 'shadowStore') {
          return {};
        }
        return target[prop];
      },
    });
    const setOverlayCalls = [];
    const cometToggleCalls = [];
    const deps = {
      app: { getPath: () => '/tmp/userData' },
      ipcMain: createFakeIpcMain(),
      backendService,
      logStore: { list: () => ['log-line'] },
      updateService: {
        getState: () => 'update-state',
        check: () => 'checked',
        download: () => 'downloaded',
        install: () => 'installed',
        skip: (v) => ({ skipped: v }),
      },
      personalityWorkspace: {
        getState: (options) => ({ agentName: options?.agentName, compiled: { text: '' } }),
        save: (payload) => ({ ok: true, agentName: payload?.agentName }),
        clear: (options) => ({ ok: true, agentName: options?.agentName }),
        openWorkspaceFolder: () => ({ opened: true }),
        getNotesState: () => ({ body: '', chars: 0 }),
        writeNotes: (payload) => ({ ok: true, body: payload?.body }),
        resetNotes: () => ({ ok: true }),
      },
      artifactService: {},
      getProactiveStatePayload: () => ({}),
      shellConfigService: {
        getWorkspaceState: () => ({}),
        updateWorkspaceState: () => ({}),
        getWorkspaceIdeState: () => ({}),
        updateWorkspaceIdeState: () => ({}),
        getToolsWorkspaceRoot: () => '',
        getState: () => ({}),
      },
      companionService: {},
      skillsService: { getState: () => ({}), updateSettings: () => ({}), openScopeFolder: () => ({}) },
      tipsService: { getState: () => ({}), updateSettings: () => ({}) },
      suggestionCache: {},
      offlineIntelligenceService: {},
      applyFeatureSettingsPatch: (patch) => ({ patched: patch }),
      dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true }) },
      getMainWindow: () => null,
      processRef: process,
      clipboard: { writeText() {} },
      log: () => null,
      getMainLifecycle: () => null,
      getWindowState: () => null,
      startDeferredServices: () => {},
      toolExecutor: { registry: { getAllTools: () => [] } },
      toolPermissionStore: {},
      usageHistory: {},
      setupService: {},
      ollamaInstallService: {},
      mcpDiscoveryService: {},
      schedulerService: {},
      weatherService: {},
      linkStatusService: {},
      calendarService: {},
      chatStreamBridge: {},
      getStartupAuditConfig: () => ({ enabled: false }),
      createStartupAuditMarkHandler: () => () => ({ recorded: true }),
      createStartupAuditMarksBatchHandler: () => () => ({ recorded: true }),
      refreshGpuMemorySample: async () => null,
      getCurrentSystemStatsPayload: () => ({ cpu: 0 }),
      buildFeatureStatePayload: () => ({ flags: {} }),
      getOverlayRef: () => null,
      setOverlayRef: (ref) => {
        setOverlayCalls.push(ref);
      },
      isCometOverlayEnabled: () => false,
      createCometOverlay: () => null,
      handleCometOverlayToggle: (args) => {
        cometToggleCalls.push(args);
        return { overlay: 'next' };
      },
      normalizeCometOverlayPresencePayload: (payload) => payload,
      getProcessLogWriter: () => null,
      getLogRedactionPrefixes: () => [],
      sendBridgeEvent: () => {},
      workspaceSnapshotStore: null,
      authorizeWorkspaceSender: () => true,
      ...overrides,
    };
    return { deps, backendCalls: backend.calls, setOverlayCalls, cometToggleCalls };
  }

  test('registers the full IPC surface without throwing (every path is a valid bridge descriptor)', () => {
    const { deps } = buildDeps();
    assert.doesNotThrow(() => registerMainIpcHandlers(deps));
    // A representative span across each registration group must be present.
    for (const methodPath of [
      'workspace.getState',
      'workspaceFs.readFile',
      'workspaceGit.getStatus',
      'workspaceRoot.getState',
      'workspaceRoot.respondExternalTransition',
      'workspaceTerminal.start',
      'skills.getState',
      'features.getState',
      'backend.getStatus',
      'sessions.create',
      'models.load',
      'status.get',
      'system.getStats',
      'system.refreshStats',
      'logs.list',
      'updates.getState',
      'personality.getState',
      'memory.contextFiles.getState',
    ]) {
      assert.equal(
        deps.ipcMain.invoke.has(invokeChannel(methodPath)),
        true,
        `expected channel for ${methodPath}`
      );
    }
    // The comet overlay relay uses send-channel `.on` handlers.
    assert.equal(deps.ipcMain.send.has(sendChannel('comet.sendOverlayState')), true);
    assert.equal(deps.ipcMain.send.has(sendChannel('comet.toggleOverlay')), true);
  });

  test('applies the session spellcheck controller and registers its shutdown teardown', () => {
    const { deps } = buildDeps();
    const shellConfigService = Object.assign(new EventEmitter(), deps.shellConfigService, {
      getState: () => ({ featureOverrides: { text_spellcheck: false } }),
    });
    const calls = [];
    let enabled = true;
    const shutdownTasks = [];
    deps.shellConfigService = shellConfigService;
    deps.spellcheckSessionRef = {
      isSpellCheckerEnabled: () => enabled,
      setSpellCheckerEnabled(value) {
        calls.push(value);
        enabled = value;
      },
    };
    deps.getMainLifecycle = () => ({
      registerShutdownTask(task) {
        shutdownTasks.push(task);
      },
    });

    registerMainIpcHandlers(deps);

    assert.deepEqual(calls, [false]);
    assert.equal(shellConfigService.listenerCount('changed'), 1);
    shutdownTasks.push(() => calls.push('unrelated trailing shutdown task'));
    const foundSpellcheckTeardown = shutdownTasks.some((task) => {
      const listenersBefore = shellConfigService.listenerCount('changed');
      task();
      return listenersBefore === 1 && shellConfigService.listenerCount('changed') === 0;
    });
    assert.equal(foundSpellcheckTeardown, true, 'a registered shutdown task must dispose spellcheck by effect');
    assert.equal(shellConfigService.listenerCount('changed'), 0);
  });

  test('registers llamaServer handlers with the sibling manager unavailable', async () => {
    const { deps } = buildDeps();
    registerMainIpcHandlers(deps);
    const result = await deps.ipcMain.invoke.get(invokeChannel('llamaServer.getStatus'))();
    assert.deepEqual(result, { ok: false, reason: 'manager_unavailable', state: 'stopped' });
  });

  test('registers llamaServer handlers against the injected manager getter', async () => {
    const { deps } = buildDeps();
    const manager = { getStatus: () => ({ state: 'ready', alias: 'gemma4:12b', port: 8033 }) };
    registerMainIpcHandlers({ ...deps, getLlamaServerManager: () => manager });
    const result = await deps.ipcMain.invoke.get(invokeChannel('llamaServer.getStatus'))();
    assert.deepEqual(result, { ok: true, state: 'ready', alias: 'gemma4:12b', port: 8033 });
  });

  // Personality v3 splits one user-visible section across two owners: the agent
  // NAME is shell-config state, the note/about bodies are workspace files. The
  // handler is the seam that joins them, so it gets its own coverage.
  test('personality IPC joins the shell-config agent name to the workspace bodies', async () => {
    const identityPatches = [];
    let agentName = 'Jenny';
    const { deps } = buildDeps();
    deps.shellConfigService.getAssistantIdentity = () => ({ agentName });
    deps.shellConfigService.updateAssistantIdentity = (patch) => {
      identityPatches.push(patch);
      agentName = patch.agentName;
      return { agentName };
    };
    registerMainIpcHandlers(deps);

    const read = await deps.ipcMain.invoke.get(invokeChannel('personality.getState'))({});
    assert.equal(read.agentName, 'Jenny');

    const saved = await deps.ipcMain.invoke.get(invokeChannel('personality.save'))(
      {},
      { agentName: 'Ada', personality: 'warm', user: 'brendan' }
    );
    assert.deepEqual(identityPatches, [{ agentName: 'Ada' }]);
    assert.equal(saved.agentName, 'Ada');

    // A payload with no agentName key must not touch shell-config at all.
    await deps.ipcMain.invoke.get(invokeChannel('personality.save'))({}, { personality: 'warmer' });
    assert.equal(identityPatches.length, 1);
    const cleared = await deps.ipcMain.invoke.get(invokeChannel('personality.clear'))({});
    assert.equal(cleared.agentName, 'Ada');
  });

  // Adversarial review, SHOULD-FIX 8: the files still save (a rejected rename
  // must not discard the note the user just typed) but the result has to SAY
  // the name failed -- ok:true with the old name is how a rename is lost.
  test('a failed agent-name write saves the files and reports agentName as failed', async () => {
    const warnings = [];
    const saves = [];
    const { deps } = buildDeps();
    deps.log = (level, event) => warnings.push({ level, event });
    deps.shellConfigService.getAssistantIdentity = () => ({ agentName: 'Jenny' });
    deps.shellConfigService.updateAssistantIdentity = () => {
      throw Object.assign(new Error('locked'), { code: 'assistant_identity_write_failed' });
    };
    deps.personalityWorkspace.save = (payload) => {
      saves.push(payload);
      return { ok: true, agentName: payload?.agentName, compiled: { text: 'compiled' } };
    };
    registerMainIpcHandlers(deps);

    const saved = await deps.ipcMain.invoke.get(invokeChannel('personality.save'))(
      {},
      { agentName: 'Ada', personality: 'warm' }
    );
    assert.equal(saved.ok, false);
    assert.equal(saved.code, 'CMP-PERS-0001');
    assert.deepEqual(saved.failed, ['agentName']);
    assert.equal(saved.agentName, 'Jenny');
    assert.deepEqual(saved.compiled, { text: 'compiled' });
    assert.equal(saves.length, 1, 'the note must still have been written');
    assert.equal(saves[0].personality, 'warm');
    assert.ok(warnings.some((entry) => entry.event === 'personality.agent_name_write_failed'));
  });

  test('a file failure and a name failure are reported together', async () => {
    const { deps } = buildDeps();
    deps.log = () => {};
    deps.shellConfigService.getAssistantIdentity = () => ({ agentName: 'Jenny' });
    deps.shellConfigService.updateAssistantIdentity = () => { throw new Error('locked'); };
    deps.personalityWorkspace.save = () => ({
      ok: false, code: 'CMP-PERS-0002', failed: ['personality'], compiled: { text: '' },
    });
    registerMainIpcHandlers(deps);

    const saved = await deps.ipcMain.invoke.get(invokeChannel('personality.save'))(
      {},
      { agentName: 'Ada', personality: 'warm' }
    );
    assert.equal(saved.ok, false);
    assert.equal(saved.code, 'CMP-PERS-0002', 'the file code wins over the name code');
    assert.deepEqual(saved.failed, ['personality', 'agentName']);
  });

  test('main lifecycle disposal fences later model-tuning mutations', async () => {
    const shutdownTasks = [];
    const { deps } = buildDeps({
      getMainLifecycle: () => ({
        registerShutdownTask(task) { shutdownTasks.push(task); },
      }),
    });
    registerMainIpcHandlers(deps);
    assert.ok(shutdownTasks.length >= 2);
    shutdownTasks[0]();
    const result = await deps.ipcMain.invoke.get(invokeChannel('modelTuning.update'))({}, {
      modelId: 'gemma3:latest', streamInactivitySeconds: 60,
    });
    assert.equal(result.reason, 'disposed');
  });

  test('handlers forward to the backend service with the right arguments', async () => {
    const { deps, backendCalls } = buildDeps();
    registerMainIpcHandlers(deps);

    await deps.ipcMain.invoke.get(invokeChannel('backend.getStatus'))();
    await deps.ipcMain.invoke.get(invokeChannel('sessions.create'))({}, { title: 'New' });
    await deps.ipcMain.invoke.get(invokeChannel('sessions.rename'))({}, 's1', 'Renamed');
    await deps.ipcMain.invoke.get(invokeChannel('models.load'))({}, {
      model: 'gemma',
      engine_type: 'ollama',
    });

    assert.deepEqual(
      backendCalls.find(([name]) => name === 'getBackendStatus'),
      ['getBackendStatus', []]
    );
    assert.deepEqual(
      backendCalls.find(([name]) => name === 'createSession'),
      ['createSession', [{ title: 'New' }]]
    );
    assert.deepEqual(
      backendCalls.find(([name]) => name === 'renameSession'),
      ['renameSession', ['s1', 'Renamed']]
    );
    assert.deepEqual(
      backendCalls.find(([name]) => name === 'loadModel'),
      ['loadModel', [{ model: 'gemma', engine_type: 'ollama' }]]
    );
  });

  test('composition keeps root and versioned-file owners lazy but authoritative', () => {
    const recoveryCalls = [];
    const { deps } = buildDeps({
      versionedTempRecoveryStarter: (options) => {
        recoveryCalls.push(options);
        return Promise.resolve({ status: 'complete' });
      },
    });
    const result = registerMainIpcHandlers(deps);

    assert.equal(
      result.workspaceIdeService._rootOperations._rootContextProvider(),
      result.workspaceRootCoordinator,
      'legacy workspaceFs methods acquire coordinator-owned generation leases'
    );
    assert.equal(
      result.workspaceFileMapService._versionedFileServiceProvider(),
      result.versionedWorkspaceFileService,
      'File Map reads through the versioned file authority constructed later in composition'
    );
    assert.equal(recoveryCalls.length, 1, 'startup schedules one bounded orphan-temp recovery');
    assert.equal(recoveryCalls[0].rootContext, result.workspaceRootCoordinator);
    assert.equal(recoveryCalls[0].logger, deps.log);
  });

  test('models.delete calls through to setupService.deleteOllamaModel for a non-loaded model', async () => {
    const deleteCalls = [];
    const { deps } = buildDeps({
      backendService: { currentModel: 'llama3.2:latest' },
      setupService: {
        deleteOllamaModel: async (payload) => {
          deleteCalls.push(payload);
          return { status: 'deleted', model: payload.model };
        },
      },
    });
    registerMainIpcHandlers(deps);

    const result = await deps.ipcMain.invoke.get(invokeChannel('models.delete'))({}, { model: 'qwen3:latest' });

    assert.deepEqual(result, { status: 'deleted', model: 'qwen3:latest' });
    assert.deepEqual(deleteCalls, [{ model: 'qwen3:latest' }]);
  });

  test('models.delete guards the currently-loaded model without calling setupService', async () => {
    let called = false;
    const { deps } = buildDeps({
      backendService: { currentModel: 'llama3.2:latest' },
      setupService: {
        deleteOllamaModel: async () => {
          called = true;
          return { status: 'deleted' };
        },
      },
    });
    registerMainIpcHandlers(deps);

    const result = await deps.ipcMain.invoke.get(invokeChannel('models.delete'))({}, { model: 'llama3.2:latest' });

    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'model_in_use');
    assert.equal(called, false);
  });

  test('models.delete guard canonicalizes :latest suffix and case (gemma3 loaded vs gemma3:latest row)', async () => {
    let called = false;
    const { deps } = buildDeps({
      backendService: { currentModel: 'Gemma3' },
      setupService: {
        deleteOllamaModel: async () => {
          called = true;
          return { status: 'deleted' };
        },
      },
    });
    registerMainIpcHandlers(deps);
    const handler = deps.ipcMain.invoke.get(invokeChannel('models.delete'));

    const suffixDivergent = await handler({}, { model: 'gemma3:latest' });
    assert.equal(suffixDivergent.status, 'failed');
    assert.equal(suffixDivergent.code, 'model_in_use');

    const caseDivergent = await handler({}, { model: 'GEMMA3' });
    assert.equal(caseDivergent.status, 'failed');
    assert.equal(caseDivergent.code, 'model_in_use');

    assert.equal(called, false);

    // A genuinely different tag of the same family still deletes.
    const different = await handler({}, { model: 'gemma3:27b' });
    assert.notEqual(different.code, 'model_in_use');
  });

  test('models.delete returns a structured unavailable result when setupService is missing', async () => {
    const { deps } = buildDeps({
      backendService: { currentModel: '' },
      setupService: null,
    });
    registerMainIpcHandlers(deps);

    const result = await deps.ipcMain.invoke.get(invokeChannel('models.delete'))({}, { model: 'qwen3:latest' });

    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'setup_unavailable');
  });

  test('system.getStats triggers a throttled GPU sample and returns the stats payload', async () => {
    let refreshed = 0;
    const refreshArgs = [];
    const { deps } = buildDeps({
      refreshGpuMemorySample: async (...args) => {
        refreshed += 1;
        refreshArgs.push(args);
      },
      getCurrentSystemStatsPayload: () => ({ cpu: 42 }),
    });
    registerMainIpcHandlers(deps);
    const result = await deps.ipcMain.invoke.get(invokeChannel('system.getStats'))();
    assert.deepEqual(result, { cpu: 42 });
    assert.equal(refreshed, 1);
    assert.deepEqual(refreshArgs, [[]]);
  });

  test('system.refreshStats awaits a forced manual refresh and returns a fresh payload', async () => {
    const events = [];
    const refreshArgs = [];
    const payloadArgs = [];
    const { deps } = buildDeps({
      refreshGpuMemorySample: async (...args) => {
        refreshArgs.push(args);
        await Promise.resolve();
        events.push('refresh-complete');
      },
      getCurrentSystemStatsPayload: (...args) => {
        payloadArgs.push(args);
        events.push('payload-built');
        return { cpu: 84 };
      },
    });
    registerMainIpcHandlers(deps);

    const result = await deps.ipcMain.invoke.get(invokeChannel('system.refreshStats'))();

    assert.deepEqual(result, { cpu: 84 });
    assert.deepEqual(refreshArgs, [[{ force: true, manual: true }]]);
    assert.deepEqual(payloadArgs, [[null, { fresh: true }]]);
    assert.deepEqual(events, ['refresh-complete', 'payload-built']);

    const rejected = buildDeps({
      refreshGpuMemorySample: async () => {
        throw new Error('probe failed');
      },
      getCurrentSystemStatsPayload: (_baseStats, options) => ({ cpu: 21, fresh: options.fresh }),
    });
    registerMainIpcHandlers(rejected.deps);
    assert.deepEqual(
      await rejected.deps.ipcMain.invoke.get(invokeChannel('system.refreshStats'))(),
      { cpu: 21, fresh: true }
    );
  });

  test('backend.retryStart starts deferred services only when the backend reaches ready', async () => {
    let started = 0;
    const readyDeps = buildDeps({
      startDeferredServices: () => {
        started += 1;
      },
    });
    // The recorder's retryStart returns a non-ready descriptor, so deferred
    // services must NOT start.
    registerMainIpcHandlers(readyDeps.deps);
    await readyDeps.deps.ipcMain.invoke.get(invokeChannel('backend.retryStart'))();
    assert.equal(started, 0);

    let started2 = 0;
    const okDeps = buildDeps({
      backendService: {
        retryStart: async () => ({ phase: 'ready' }),
      },
      startDeferredServices: () => {
        started2 += 1;
      },
    });
    registerMainIpcHandlers(okDeps.deps);
    await okDeps.deps.ipcMain.invoke.get(invokeChannel('backend.retryStart'))();
    assert.equal(started2, 1);
  });

  test('comet.toggleOverlay relays through the toggle handler and stores the next overlay ref', () => {
    const { deps, cometToggleCalls, setOverlayCalls } = buildDeps();
    registerMainIpcHandlers(deps);
    const handler = deps.ipcMain.send.get(sendChannel('comet.toggleOverlay'));
    handler({}, { enabled: true });
    assert.equal(cometToggleCalls.length, 1);
    assert.deepEqual(setOverlayCalls[setOverlayCalls.length - 1], { overlay: 'next' });
  });
});

test('legacy image-generation IPC paths are absent from the generic main registry', () => {
  for (const methodPath of ['imageGen.start', 'imageGen.cancel', 'imageGen.getState',
    'imageGen.probe', 'image.generate']) {
    assert.throws(() => getBridgeChannel(methodPath), /Unknown Jenny IPC bridge path/);
  }
});
