'use strict';

// Dark-path coverage for services/main/ipc-handler-registration.js
// Targets the specific uncovered regions:
//   158-160, 163-165, 185, 188-189, 228-233, 236-242, 245-254,
//   257-258, 261-262, 265-266, 269-273, 276-277, 280-281,
//   284-285, 288-289, 307-312, 378-382, 392-394

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { getBridgeChannel } = require('../services/ipc-contract');
const {
  registerMainIpcHandlers,
} = require('../services/main/ipc-handler-registration');

// ---------------------------------------------------------------------------
// Infrastructure helpers
// ---------------------------------------------------------------------------

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

// Minimal shellConfigService that SessionTemplateStore
// calls via .get()/.set() plus the config methods used by WorkspaceIdeService etc.
function createFakeShellConfigService(data = {}) {
  const store = { ...data };
  let toolsWorkspaceRoot = String(data.toolsWorkspaceRoot || '');
  return {
    // For SessionTemplateStore
    get: (key) => store[key],
    set: (key, value) => { store[key] = value; },
    // For WorkspaceIdeService / WorkspacePtyService
    getWorkspaceState: () => ({}),
    updateWorkspaceState: () => ({}),
    getWorkspaceIdeState: () => ({}),
    updateWorkspaceIdeState: () => ({}),
    getToolsWorkspaceRoot: () => toolsWorkspaceRoot,
    setToolsWorkspaceRoot: (value) => { toolsWorkspaceRoot = String(value || ''); },
    getState: () => ({ toolsWorkspaceRoot }),
    // For workspace-root-ipc.getWorkspaceRootStatePayload
    getWorkspaceRootStatus: () => 'none',
    // For workspace-root-ipc.clearWorkspaceRoot
    clearToolsWorkspaceRoot: () => { toolsWorkspaceRoot = ''; },
    // Expose backing store for test assertions
    _store: store,
  };
}

// Minimal recorder for backendService — records method calls in an array.
function createBackendRecorder() {
  const calls = [];
  const service = new Proxy(
    {
      sessionStore: {},
      attachmentAssetStore: null,
      shadowStore: {},
    },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        return (...args) => {
          calls.push([prop, args]);
          return { __method: prop, args };
        };
      },
    }
  );
  return { service, calls };
}

// Build a complete minimal deps object for registerMainIpcHandlers.
// Caller can override individual keys.
function buildDeps(overrides = {}) {
  const ipcMain = createFakeIpcMain();
  const shellConfigService = createFakeShellConfigService();
  const { service: backendService, calls: backendCalls } = createBackendRecorder();

  const chooseWorkspaceRootCalls = [];
  const clearWorkspaceRootCalls = [];
  const syncRootCalls = [];
  const mergeClientTimingCalls = [];

  const deps = {
    app: { getPath: () => '/tmp/userData' },
    ipcMain,
    backendService,
    logStore: { list: () => ['log-entry'] },
    updateService: {
      getState: () => ({}),
      check: () => ({}),
      download: () => ({}),
      install: () => ({}),
      skip: (v) => ({ skipped: v }),
    },
    personalityWorkspace: {
      getState: (opts) => ({ agentName: opts?.agentName, compiled: { text: '' } }),
      save: (payload) => ({ ok: true, agentName: payload?.agentName }),
      clear: (opts) => ({ ok: true, agentName: opts?.agentName }),
      openWorkspaceFolder: () => ({ opened: true }),
      getNotesState: () => ({ body: '', chars: 0 }),
      writeNotes: (payload) => ({ ok: true, body: payload?.body }), resetNotes: () => ({ ok: true }),
    },
    artifactService: {},
    getProactiveStatePayload: () => ({}),
    shellConfigService,
    companionService: {},
    skillsService: {
      getState: () => ({}),
      updateSettings: () => ({}),
      openScopeFolder: () => ({}),
    },
    suggestionCache: {},
    offlineIntelligenceService: {},
    applyFeatureSettingsPatch: () => ({}),
    dialog: {
      showSaveDialog: async () => ({ canceled: true }),
      showOpenDialog: async () => ({ canceled: true }),
    },
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
    linkStatusService: {},
    calendarService: {},
    getStartupAuditConfig: () => ({ enabled: false }),
    createStartupAuditMarkHandler: () => () => ({ recorded: true }),
    createStartupAuditMarksBatchHandler: () => () => ({ recorded: true }),
    refreshGpuMemorySample: async () => null,
    getCurrentSystemStatsPayload: () => ({ cpu: 0 }),
    buildFeatureStatePayload: () => ({ flags: {} }),
    getProcessLogWriter: () => null,
    getLogRedactionPrefixes: () => [],
    trashItemImpl: null,
    showItemInFolderImpl: null,
    openPathImpl: null,
    sendBridgeEvent: () => {},
    workspaceSnapshotStore: null,
    authorizeWorkspaceSender: () => true,
    ...overrides,
  };

  return {
    deps,
    ipcMain,
    shellConfigService,
    backendCalls,
    chooseWorkspaceRootCalls,
    clearWorkspaceRootCalls,
    syncRootCalls,
    mergeClientTimingCalls,
  };
}

// ---------------------------------------------------------------------------
// workspaceRoot.prepareChoose handler body
// The real chooseWorkspaceRoot + workspaceIdeWatcher.syncRoot are called.
// We inject fakes by providing a deps.chooseWorkspaceRoot override that the
// code at line 158 calls via the closed-over `chooseWorkspaceRoot` import.
// NOTE: Because chooseWorkspaceRoot is imported at module load-time, we cannot
// override it via deps. Instead we test the observable effects: the handler
// returns the result from chooseWorkspaceRoot (null means no dialog open) and
// does NOT throw. We use the canonical prepare channel through
// registerWorkspaceRootIpcHandlers.
// ---------------------------------------------------------------------------

describe('workspaceRoot two-phase choose + clear handlers', () => {
  test('workspaceRoot.prepareChoose returns chooser cancellation without mutating', async () => {
    // STRENGTHENED: the old oracle `result === null || result === undefined ||
    // typeof result === 'object'` is disjunctive/always-true. We now pin the
    // concrete shape chooseWorkspaceRoot returns for a canceled dialog AND prove
    // the choose handler is the one wired (canceled:true distinguishes it from clear).
    const showOpenCalls = [];
    const { deps, ipcMain } = buildDeps({
      dialog: {
        showSaveDialog: async () => ({ canceled: true }),
        showOpenDialog: async (...args) => {
          showOpenCalls.push(args);
          return { canceled: true };
        },
      },
    });
    registerMainIpcHandlers(deps);
    const handler = ipcMain.invoke.get(invokeChannel('workspaceRoot.prepareChoose'));
    assert.ok(typeof handler === 'function', 'choose handler must be registered');
    const result = await handler({});
    // The choose handler MUST open the directory dialog (line 158 delegates to
    // chooseWorkspaceRoot which calls showOpenDialog). A swap with clear would skip this.
    assert.equal(showOpenCalls.length, 1, 'choose must invoke showOpenDialog exactly once');
    // Canceled dialog → no root set; concrete payload from chooseWorkspaceRoot.
    assert.equal(result.canceled, true, 'choose returns canceled:true for a canceled dialog');
    assert.equal(result.changed, false, 'no change when the dialog is canceled');
    assert.equal(result.prepared, false);
    assert.equal(result.context.phase, 'ready');
  });

  test('workspaceRoot.prepareClear requires explicit commit to mutate', async () => {
    const clearCalls = [];
    const scs = createFakeShellConfigService({ toolsWorkspaceRoot: 'G:/old' });
    const realClear = scs.clearToolsWorkspaceRoot;
    scs.clearToolsWorkspaceRoot = (...args) => {
      clearCalls.push(args);
      return realClear(...args);
    };
    const { deps, ipcMain } = buildDeps({ shellConfigService: scs });
    registerMainIpcHandlers(deps);
    const handler = ipcMain.invoke.get(invokeChannel('workspaceRoot.prepareClear'));
    assert.ok(typeof handler === 'function', 'clear handler must be registered');
    const result = await handler({});
    assert.equal(result.prepared, true);
    assert.equal(result.canceled, false, 'clear returns canceled:false');
    assert.equal(clearCalls.length, 0, 'prepare must not clear config');

    const commit = ipcMain.invoke.get(invokeChannel('workspaceRoot.commit'));
    const committed = await commit({}, { transitionId: result.transitionId });
    assert.equal(committed.committed, true);
    assert.equal(clearCalls.length, 1, 'commit owns the single config mutation');
    assert.equal(scs.getToolsWorkspaceRoot(), '');
  });
});

// ---------------------------------------------------------------------------
// registerMainIpcHandlers return contract + full registration
//
// Terminal teardown used to be an app.once('will-quit', …) hook inside this
// function; it was removed because terminal dispose() is async and a will-quit
// listener cannot delay quit for async work — the dropped kill promise could
// orphan the shell tree. registerMainIpcHandlers now RETURNS the ConPTY pty
// service so main.js can thread it into the awaited stopRuntimeBeforeQuit sequence
// (services/main/runtime-shutdown.js). The awaited-ordering behavior itself is
// covered in tests/runtime-shutdown-drain.test.js; here we pin the return shape
// plus the load-bearing invoke/send registration (proven RED elsewhere via the
// diagnostics extraction mutations).
// ---------------------------------------------------------------------------

describe('registerMainIpcHandlers return contract + full registration', () => {
  test('returns the ConPTY pty service exposing dispose(); the retired line terminal is gone', () => {
    const { deps } = buildDeps();
    const result = registerMainIpcHandlers(deps);
    assert.ok(result && typeof result === 'object', 'registerMainIpcHandlers must return a services object');
    assert.equal(
      Object.hasOwn(result, 'workspaceTerminalService'),
      false,
      'the piped line-terminal service was retired in sweep S8'
    );
    assert.equal(
      typeof result.workspacePtyService?.dispose,
      'function',
      'must return the ConPTY pty service exposing dispose() for the awaited shutdown path'
    );
  });

  test('registerMainIpcHandlers completes and registers the full invoke channel set', () => {
    const { deps, ipcMain } = buildDeps();
    registerMainIpcHandlers(deps);
    // Concrete, load-bearing assertions (NOT a bare doesNotThrow): the core
    // session/template/diagnostics invoke channels must all be wired.
    for (const method of [
      'sessions.exportSession',
      'sessions.forkSession',
      'templates.list',
      'diagnostics.reportClientStreamMetrics',
      'workspaceRoot.prepareChoose',
      'workspaceRoot.prepareClear',
    ]) {
      assert.ok(
        typeof ipcMain.invoke.get(invokeChannel(method)) === 'function',
        `invoke channel ${method} must be registered`
      );
    }
  });

  test('exactly the two compatible renderer-log send channels are registered', () => {
    const { deps, ipcMain } = buildDeps();
    registerMainIpcHandlers(deps);
    assert.ok(ipcMain.send.has(sendChannel('diagnostics.logs.appendRendererBatch')), 'canonical diagnostics ingestion must be registered');
    assert.ok(ipcMain.send.has(sendChannel('logs.clientAppend')), 'deprecated client-log alias must remain registered');
    assert.equal(ipcMain.send.size, 2, 'exactly 2 send channels: canonical diagnostics + compatibility alias (comet relay removed in S9)');
  });
});

// ---------------------------------------------------------------------------
// Lines 228-233: sessions.exportSession handler body
// Calls exportSession(backendService.sessionStore, sessionId, backendService.attachmentAssetStore)
// ---------------------------------------------------------------------------

describe('sessions.exportSession handler (lines 228-233)', () => {
  test('exportSession returns null when session is not found in the store', async () => {
    const { deps, ipcMain } = buildDeps({
      backendService: new Proxy(
        {
          sessionStore: { getSession: (_id) => null },
          attachmentAssetStore: null,
          shadowStore: {},
        },
        {
          get(target, prop) {
            if (prop in target) return target[prop];
            return (...args) => ({ __method: prop, args });
          },
        }
      ),
    });
    registerMainIpcHandlers(deps);
    const handler = ipcMain.invoke.get(invokeChannel('sessions.exportSession'));
    const result = await handler({}, 'session-does-not-exist-example');
    // exportSession returns null when getSession returns null
    assert.equal(result, null);
  });

  test('exportSession passes sessionId and assetStore to the underlying function', async () => {
    const exportedResults = [];
    const fakeSessionStore = {
      getSession: (id) => {
        exportedResults.push(id);
        return null;
      },
    };
    const { deps, ipcMain } = buildDeps({
      backendService: new Proxy(
        {
          sessionStore: fakeSessionStore,
          attachmentAssetStore: null,
          shadowStore: {},
        },
        {
          get(target, prop) {
            if (prop in target) return target[prop];
            return () => null;
          },
        }
      ),
    });
    registerMainIpcHandlers(deps);
    const handler = ipcMain.invoke.get(invokeChannel('sessions.exportSession'));
    await handler({}, 'sid-example-001');
    // getSession must have been called with the exact sessionId
    assert.deepEqual(exportedResults, ['sid-example-001']);
  });
});

// ---------------------------------------------------------------------------
// sessions.forkSession handler: calls forkSessionWithArtifacts with a
// whitelisted { title, shadowStore, artifactService } — renderer options must
// never inject the internal fork seams (branchSessionId, artifactRewrite).
// ---------------------------------------------------------------------------

describe('sessions.forkSession handler', () => {
  function buildBackendWithSessionStore(sessionStore) {
    return new Proxy(
      {
        sessionStore,
        attachmentAssetStore: null,
        shadowStore: {},
      },
      {
        get(target, prop) {
          if (prop in target) return target[prop];
          return () => null;
        },
      }
    );
  }

  test('forkSession returns null when source session does not exist', async () => {
    const { deps, ipcMain } = buildDeps({
      backendService: buildBackendWithSessionStore({
        getSession: () => null,
      }),
    });
    registerMainIpcHandlers(deps);
    const handler = ipcMain.invoke.get(invokeChannel('sessions.forkSession'));
    const result = await handler({}, 'nonexistent-example', 'msg-001', { title: 'Branch' });
    // forkSession returns null when source session is missing
    assert.equal(result, null);
  });

  // The missing-session test above returns null before the fork reads
  // `options`, so it pins nothing about the whitelist. To pin it we intercept
  // forkSessionWithArtifacts via the require cache (hermetic) and capture the
  // exact 4th-arg options object.
  const branchingModulePath = require.resolve('../services/backend/session-branching');

  function withCapturedFork(run) {
    require('../services/backend/session-branching');
    const cached = require.cache[branchingModulePath];
    const original = cached.exports.forkSessionWithArtifacts;
    const captured = [];
    cached.exports.forkSessionWithArtifacts = (...args) => {
      captured.push(args);
      return Promise.resolve({ __forked: true });
    };
    try {
      run();
      return captured;
    } finally {
      cached.exports.forkSessionWithArtifacts = original;
    }
  }

  const EXPECTED_FORK_OPTION_KEYS = ['artifactService', 'shadowStore', 'title'];

  test('forkSession options whitelist: array options forwards only the internal seams', async () => {
    const shadow = { id: 'shadow-marker' };
    const { deps, ipcMain } = buildDeps({
      backendService: new Proxy(
        { sessionStore: { getSession: () => null }, attachmentAssetStore: null, shadowStore: shadow },
        { get(t, p) { return p in t ? t[p] : () => null; } }
      ),
    });
    registerMainIpcHandlers(deps);
    const handler = ipcMain.invoke.get(invokeChannel('sessions.forkSession'));
    const captured = withCapturedFork(() => {
      handler({}, 'src-example', 'msg-002', ['bad-option-array']);
    });
    assert.equal(captured.length, 1, 'forkSessionWithArtifacts must be called once');
    const optionsArg = captured[0][3];
    // Array options are rejected wholesale: title degrades to ''.
    assert.deepEqual(Object.keys(optionsArg).sort(), EXPECTED_FORK_OPTION_KEYS);
    assert.equal(optionsArg.title, '');
    assert.equal(optionsArg.shadowStore, shadow, 'shadowStore must be forwarded');
    assert.equal('0' in optionsArg, false, 'array index 0 must NOT leak into options');
  });

  test('forkSession options whitelist: only title survives from renderer options', async () => {
    const shadow = { id: 'shadow-marker-2' };
    const { deps, ipcMain } = buildDeps({
      backendService: new Proxy(
        { sessionStore: { getSession: () => null }, attachmentAssetStore: null, shadowStore: shadow },
        { get(t, p) { return p in t ? t[p] : () => null; } }
      ),
    });
    registerMainIpcHandlers(deps);
    const handler = ipcMain.invoke.get(invokeChannel('sessions.forkSession'));
    const captured = withCapturedFork(() => {
      handler({}, 'src-example', 'msg-002', {
        title: 'Branch', mode: 'chat', branchSessionId: 'sess_injected', artifactRewrite: 'nope',
      });
    });
    assert.equal(captured.length, 1);
    const optionsArg = captured[0][3];
    // Only `title` is renderer-authored; a renderer must never be able to
    // inject branchSessionId (session-id collision) or artifactRewrite.
    assert.deepEqual(Object.keys(optionsArg).sort(), EXPECTED_FORK_OPTION_KEYS);
    assert.equal(optionsArg.title, 'Branch');
    assert.equal(optionsArg.shadowStore, shadow);
    assert.equal('mode' in optionsArg, false);
    assert.equal('branchSessionId' in optionsArg, false);
    assert.equal('artifactRewrite' in optionsArg, false);
    assert.equal(captured[0][1], 'src-example');
    assert.equal(captured[0][2], 'msg-002');
  });

  test('forkSession options whitelist: null options does not throw', async () => {
    const shadow = { id: 'shadow-marker-3' };
    const { deps, ipcMain } = buildDeps({
      backendService: new Proxy(
        { sessionStore: { getSession: () => null }, attachmentAssetStore: null, shadowStore: shadow },
        { get(t, p) { return p in t ? t[p] : () => null; } }
      ),
    });
    registerMainIpcHandlers(deps);
    const handler = ipcMain.invoke.get(invokeChannel('sessions.forkSession'));
    const captured = withCapturedFork(() => {
      handler({}, 'src-example', 'msg-003', null);
    });
    assert.equal(captured.length, 1);
    const optionsArg = captured[0][3];
    assert.deepEqual(Object.keys(optionsArg).sort(), EXPECTED_FORK_OPTION_KEYS);
    assert.equal(optionsArg.title, '');
    assert.equal(optionsArg.shadowStore, shadow);
  });
});

// ---------------------------------------------------------------------------
// Lines 257-258: templates.list handler body
// Lines 261-262: templates.save handler body
// Lines 265-266: templates.delete handler body
// Lines 269-273: templates.apply handler body
// ---------------------------------------------------------------------------

describe('templates handlers (lines 257-273)', () => {
  test('templates.list returns empty array when no templates exist', async () => {
    const scs = createFakeShellConfigService({});
    const { deps, ipcMain } = buildDeps({ shellConfigService: scs });
    registerMainIpcHandlers(deps);
    const handler = ipcMain.invoke.get(invokeChannel('templates.list'));
    const result = await handler({});
    // shellConfigService.get('session_templates') returns undefined → []
    assert.deepEqual(result, []);
  });

  test('templates.save normalizes and persists a valid template', async () => {
    const scs = createFakeShellConfigService({});
    const { deps, ipcMain } = buildDeps({ shellConfigService: scs });
    registerMainIpcHandlers(deps);
    const saveHandler = ipcMain.invoke.get(invokeChannel('templates.save'));
    const template = {
      id: 'tpl-example-001',
      name: 'Example Template',
      description: 'A test template',
    };
    const result = await saveHandler({}, template);
    assert.equal(result.id, 'tpl-example-001');
    assert.equal(result.name, 'Example Template');
    // Verify it was persisted via shellConfigService.set
    const stored = scs._store['session_templates'];
    assert.ok(Array.isArray(stored), 'session_templates must be stored as an array');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, 'tpl-example-001');
  });

  test('templates.delete removes a previously saved template', async () => {
    const scs = createFakeShellConfigService({
      session_templates: [
        {
          id: 'tpl-del-example',
          name: 'To Delete',
          description: '',
          context_preferences: {},
          preferred_model: '',
          reasoning_effort: 'default',
          conversation_mode: 'chat',
          linked_session_ids: [],
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const { deps, ipcMain } = buildDeps({ shellConfigService: scs });
    registerMainIpcHandlers(deps);
    const handler = ipcMain.invoke.get(invokeChannel('templates.delete'));
    const result = await handler({}, 'tpl-del-example');
    assert.equal(result, true, 'delete must return true for an existing template');
    assert.equal(scs._store['session_templates'].length, 0, 'template must be removed from store');
  });

  test('templates.apply returns null when template is not found', async () => {
    const scs = createFakeShellConfigService({});
    const backendSvc = new Proxy(
      {
        sessionStore: { getSession: () => null },
        attachmentAssetStore: null,
        shadowStore: {},
      },
      {
        get(target, prop) {
          if (prop in target) return target[prop];
          return () => null;
        },
      }
    );
    const { deps, ipcMain } = buildDeps({ shellConfigService: scs, backendService: backendSvc });
    registerMainIpcHandlers(deps);
    const handler = ipcMain.invoke.get(invokeChannel('templates.apply'));
    const result = await handler({}, 'nonexistent-tpl-example');
    // apply with a missing template returns null
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// Lines 307-312: diagnostics.reportClientStreamMetrics handler body
// Calls mergeClientTimingIntoTurnDiagnostic with service + extracted fields
// ---------------------------------------------------------------------------

describe('diagnostics.reportClientStreamMetrics handler (lines 307-312)', () => {
  // STRENGTHENED: mergeClientTimingIntoTurnDiagnostic returns null whenever
  // service.options.userDataPath is absent (which it always is for the fake
  // backendService). Asserting `result === null` alone is therefore CLAMP-BLIND —
  // it pins nothing about the snake_case/camelCase extraction the handler performs
  // at lines 310-311. To pin the real forwarding we intercept the merge function
  // via the require cache (hermetic — no fs, no subprocess) and capture the exact
  // { streamId, clientTiming } the handler forwards.

  const mergeModulePath = require.resolve('../services/backend/turn-diagnostic-dump');

  function withCapturedMerge(run) {
    const real = require('../services/backend/turn-diagnostic-dump');
    const cached = require.cache[mergeModulePath];
    const originalMerge = cached.exports.mergeClientTimingIntoTurnDiagnostic;
    const captured = [];
    cached.exports.mergeClientTimingIntoTurnDiagnostic = (args) => {
      captured.push(args);
      // Return a sentinel so the test can prove the handler returns the
      // delegate's value (not a hardcoded null).
      return { __merged: true, forwarded: args };
    };
    try {
      return { result: run(), captured, real };
    } finally {
      cached.exports.mergeClientTimingIntoTurnDiagnostic = originalMerge;
    }
  }

  test('forwards snake_case stream_id and client_timing to mergeClientTimingIntoTurnDiagnostic', async () => {
    const { deps, ipcMain } = buildDeps();
    registerMainIpcHandlers(deps);
    const handler = ipcMain.invoke.get(invokeChannel('diagnostics.reportClientStreamMetrics'));
    let resultPromise;
    const { captured } = withCapturedMerge(() => {
      resultPromise = handler({}, {
        stream_id: 'stream-example-001',
        client_timing: { markers: [{ name: 'first_paint' }] },
      });
      return resultPromise;
    });
    const result = await resultPromise;
    assert.equal(captured.length, 1, 'merge must be called exactly once');
    // The exact extracted streamId must be forwarded — a hardcoded/wrong constant
    // or dropping the snake_case alias would fail here.
    assert.equal(captured[0].streamId, 'stream-example-001');
    assert.deepEqual(captured[0].clientTiming, { markers: [{ name: 'first_paint' }] });
    // service must be the backendService instance (the delegation target).
    assert.equal(captured[0].service, deps.backendService);
    // Handler must return the delegate's value, not a hardcoded null.
    assert.deepEqual(result, { __merged: true, forwarded: captured[0] });
  });

  test('forwards camelCase streamId and clientTiming when snake_case absent', async () => {
    const { deps, ipcMain } = buildDeps();
    registerMainIpcHandlers(deps);
    const handler = ipcMain.invoke.get(invokeChannel('diagnostics.reportClientStreamMetrics'));
    let resultPromise;
    const { captured } = withCapturedMerge(() => {
      resultPromise = handler({}, {
        streamId: 'stream-example-002',
        clientTiming: { markers: [{ name: 'ttfb' }] },
      });
      return resultPromise;
    });
    await resultPromise;
    assert.equal(captured.length, 1);
    // camelCase alias must be picked up (stream_id||streamId, client_timing||clientTiming).
    assert.equal(captured[0].streamId, 'stream-example-002');
    assert.deepEqual(captured[0].clientTiming, { markers: [{ name: 'ttfb' }] });
  });

  test('snake_case wins over camelCase when both supplied (precedence of || alias)', async () => {
    const { deps, ipcMain } = buildDeps();
    registerMainIpcHandlers(deps);
    const handler = ipcMain.invoke.get(invokeChannel('diagnostics.reportClientStreamMetrics'));
    let resultPromise;
    const { captured } = withCapturedMerge(() => {
      resultPromise = handler({}, {
        stream_id: 'snake-wins',
        streamId: 'camel-loses',
        client_timing: { source: 'snake' },
        clientTiming: { source: 'camel' },
      });
      return resultPromise;
    });
    await resultPromise;
    assert.equal(captured.length, 1);
    // `payload?.stream_id || payload?.streamId` — snake_case is the left operand.
    assert.equal(captured[0].streamId, 'snake-wins');
    assert.deepEqual(captured[0].clientTiming, { source: 'snake' });
  });

  test('null payload forwards undefined streamId/clientTiming via optional-chaining guard', async () => {
    const { deps, ipcMain } = buildDeps();
    registerMainIpcHandlers(deps);
    const handler = ipcMain.invoke.get(invokeChannel('diagnostics.reportClientStreamMetrics'));
    let resultPromise;
    const { captured } = withCapturedMerge(() => {
      resultPromise = handler({}, null);
      return resultPromise;
    });
    await resultPromise;
    // payload?.stream_id is undefined when payload is null; the handler must not
    // throw and must still delegate with undefined fields (the guard at lines 310-311).
    assert.equal(captured.length, 1);
    assert.equal(captured[0].streamId, undefined);
    assert.equal(captured[0].clientTiming, undefined);
  });

  test('real mergeClientTimingIntoTurnDiagnostic returns null when userDataPath absent (delegate contract)', async () => {
    // Sanity-check the unmocked contract relied upon above: with no userDataPath
    // the real delegate returns null. This keeps the strengthened tests honest
    // about WHY result is null in production for the fake backendService.
    const { deps, ipcMain } = buildDeps();
    registerMainIpcHandlers(deps);
    const handler = ipcMain.invoke.get(invokeChannel('diagnostics.reportClientStreamMetrics'));
    const result = await handler({}, { stream_id: 'x', client_timing: {} });
    assert.equal(result, null);
  });
});


describe('personality preview scope validation', () => {
  test('personality clear accepts the existing renderer name payload and keeps the stored identity', async () => {
    const { deps } = buildDeps();
    deps.shellConfigService.getAssistantIdentity = () => ({ agentName: 'Stored' });
    const calls = [];
    deps.personalityWorkspace.clear = (options) => { calls.push(options); return { ok: true }; };
    registerMainIpcHandlers(deps);
    await deps.ipcMain.invoke.get(invokeChannel('personality.clear'))({}, { agentName: 'Draft' });
    assert.equal(calls[0].agentName, 'Stored');
    assert.equal(calls[0].projectId, 'project_general');
  });

  test('personality IPC uses canonical chat scope and configured reply language for every preview', async () => {
    const { deps } = buildDeps();
    const captures = [];
    const projectAuthority = {
      captureSession(id) {
        captures.push(['session', id]);
        if (id === 'draft') throw Object.assign(new Error('missing'), { reason: 'session_not_found' });
        if (id === 'broken') throw new Error('unreadable');
        return { project_id: id === 'general' ? 'project_general' : 'project_bound', root_path: null };
      },
      captureProject(id) {
        captures.push(['project', id]);
        return { project_id: id, root_path: null };
      },
    };
    deps.backendService = new Proxy(deps.backendService, {
      get: (target, key) => key === 'projectAuthority' ? projectAuthority : target[key],
    });
    deps.shellConfigService.getUiLanguage = () => 'fr';
    const calls = [];
    for (const method of ['getState', 'save', 'clear']) {
      deps.personalityWorkspace[method] = (options) => { calls.push(options); return { ok: true }; };
    }
    registerMainIpcHandlers(deps);
    for (const method of ['getState', 'save', 'clear']) {
      const handler = deps.ipcMain.invoke.get(invokeChannel(`personality.${method}`));
      for (const [payload, expected] of [
        [{ session_id: 'bound', project_id: 'project_stale' }, 'project_bound'],
        [{ session_id: 'general', project_id: 'project_stale' }, 'project_general'],
        [{ session_id: 'draft', project_id: 'project_draft' }, 'project_draft'],
        [{ session_id: 'broken', project_id: 'project_stale' }, 'project_general'],
        [undefined, 'project_general'],
        [null, 'project_general'],
      ]) {
        await handler({}, payload);
        assert.equal(calls.at(-1).projectId, expected, `${method} must use canonical project scope`);
        assert.equal(calls.at(-1).uiLanguage, 'fr', `${method} must use the configured language`);
      }
    }
    assert.ok(captures.some(([kind, id]) => kind === 'project' && id === 'project_draft'));
    assert.equal(captures.some(([kind, id]) => kind === 'project' && id === 'project_stale'), false);
  });

  test('personality IPC rejects malformed scope before reading or writing state', async () => {
    const { deps } = buildDeps();
    const effects = [];
    deps.shellConfigService.updateAssistantIdentity = () => effects.push('rename');
    for (const method of ['getState', 'save', 'clear']) {
      deps.personalityWorkspace[method] = () => effects.push(method);
    }
    registerMainIpcHandlers(deps);
    for (const method of ['getState', 'save', 'clear']) {
      const handler = deps.ipcMain.invoke.get(invokeChannel(`personality.${method}`));
      for (const payload of [[], 'bad', { session_id: 42 }, { project_id: 'x'.repeat(257) },
        { projectId: 'project_spoofed' }, { uiLanguage: 'es' }, { unexpected: true }]) {
        await assert.rejects(async () => handler({}, payload), TypeError);
      }
    }
    await assert.rejects(async () => deps.ipcMain.invoke.get(invokeChannel('personality.save'))(
      {}, { agentName: 'Ada', session_id: false }
    ), TypeError);
    assert.deepEqual(effects, [], 'validation must precede all persistence');
  });

});
