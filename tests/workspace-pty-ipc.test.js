'use strict';

// Coverage for the workspacePty.* IPC surface: the six ipc-contract descriptors
// (four invoke + two subscribe/event) and the registerWorkspacePtyIpcHandlers
// wiring helper in services/main/ipc-handler-registration.js, mirroring the
// registerWorkspaceGitIpcHandlers test model (tests/ipc-handler-registration.test.js)
// and the workspaceTerminal descriptor block in services/ipc-contract.js.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { getBridgeChannel } = require('../services/ipc-contract');
const {
  registerWorkspacePtyIpcHandlers,
} = require('../services/main/ipc-handler-registration');

function createFakeIpcMain() {
  const invoke = new Map();
  return {
    handle(channel, handler) {
      invoke.set(channel, handler);
    },
    invoke,
  };
}

const invokeChannel = (methodPath) => getBridgeChannel(methodPath, 'invoke');
const subscribeChannel = (methodPath) => getBridgeChannel(methodPath, 'subscribe');

// A recording service double: every property access yields a function that logs
// its name + args and echoes them back, so handler forwarding is assertable
// without enumerating each method (same shape as ipc-handler-registration.test.js).
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

describe('ipc-contract workspacePty descriptors', () => {
  test('invoke descriptors resolve to the exact workspace-pty:* channels', () => {
    assert.equal(invokeChannel('workspacePty.spawn'), 'workspace-pty:spawn');
    assert.equal(invokeChannel('workspacePty.write'), 'workspace-pty:write');
    assert.equal(invokeChannel('workspacePty.resize'), 'workspace-pty:resize');
    assert.equal(invokeChannel('workspacePty.kill'), 'workspace-pty:kill');
  });

  test('subscribe (event) descriptors resolve to the exact workspace-pty:* channels', () => {
    assert.equal(subscribeChannel('workspacePty.onData'), 'workspace-pty:data');
    assert.equal(subscribeChannel('workspacePty.onExit'), 'workspace-pty:exit');
  });

  test('onData/onExit are NOT invoke-kind (they are event/subscribe descriptors)', () => {
    assert.throws(
      () => getBridgeChannel('workspacePty.onData', 'invoke'),
      /must be "invoke"/
    );
    assert.throws(
      () => getBridgeChannel('workspacePty.onExit', 'invoke'),
      /must be "invoke"/
    );
  });

  test('spawn/write/resize/kill are NOT subscribe-kind', () => {
    for (const methodPath of [
      'workspacePty.spawn',
      'workspacePty.write',
      'workspacePty.resize',
      'workspacePty.kill',
    ]) {
      assert.throws(
        () => getBridgeChannel(methodPath, 'subscribe'),
        /must be "subscribe"/
      );
    }
  });
});

describe('registerWorkspacePtyIpcHandlers', () => {
  test('wires all 4 workspacePty invoke channels and forwards the payload', async () => {
    const ipc = createFakeIpcMain();
    const { proxy } = createRecorder();
    registerWorkspacePtyIpcHandlers(ipc, proxy);

    const paths = [
      'workspacePty.spawn',
      'workspacePty.write',
      'workspacePty.resize',
      'workspacePty.kill',
    ];
    assert.equal(ipc.invoke.size, 4);
    for (const methodPath of paths) {
      assert.equal(ipc.invoke.has(invokeChannel(methodPath)), true, `expected ${methodPath}`);
    }

    // Payload forwarding (the second arg) reaches the service method.
    assert.deepEqual(
      await ipc.invoke.get(invokeChannel('workspacePty.write'))({}, { sessionId: 'x', data: 'y' }),
      { __from: 'write', args: [{ sessionId: 'x', data: 'y' }] }
    );
    assert.deepEqual(
      await ipc.invoke.get(invokeChannel('workspacePty.spawn'))({}, { cols: 80, rows: 24 }),
      { __from: 'spawn', args: [{ cols: 80, rows: 24 }] }
    );
    assert.deepEqual(
      await ipc.invoke.get(invokeChannel('workspacePty.resize'))({}, { sessionId: 'x', cols: 100, rows: 30 }),
      { __from: 'resize', args: [{ sessionId: 'x', cols: 100, rows: 30 }] }
    );
    assert.deepEqual(
      await ipc.invoke.get(invokeChannel('workspacePty.kill'))({}, { sessionId: 'x' }),
      { __from: 'kill', args: [{ sessionId: 'x' }] }
    );
  });
});

describe('workspacePty dispose contract (awaited shutdown-path teardown)', () => {
  // The old app.once('will-quit', …) hook that disposed the terminal services was
  // removed: WorkspaceTerminalService.dispose() is async and will-quit cannot
  // delay quit for async work, so the dropped kill promise could orphan the piped
  // shell tree. Disposal now runs inside the awaited stopRuntimeBeforeQuit
  // sequence (services/main/runtime-shutdown.js → disposeWorkspaceTerminals), and
  // registerMainIpcHandlers RETURNS the services so main.js can thread them in.
  //   - awaited ordering + failure isolation: tests/runtime-shutdown-drain.test.js
  //   - the return-value wiring contract: tests/ipc-handler-registration-dark-paths.test.js
  // Here we pin the pty service's own dispose contract that the shutdown path
  // relies on: awaited, structured, no-throw, and idempotent. Active teardown may
  // wait for the native exit event; an idle service resolves immediately.
  const { WorkspacePtyService } = require('../services/workspace-pty-service');

  function createService() {
    return new WorkspacePtyService({
      configService: { getToolsWorkspaceRoot: () => '', getState: () => ({}) },
      featureFlagProvider: () => ({}),
      sendBridgeEvent: () => {},
      // Pinned invariant: native pty module must never load on a dispose path.
      ptyModuleLoader: () => { throw new Error('native pty module must not load in this test'); },
      env: {},
    });
  }

  test('dispose() with no active session resolves a confirmed structured no-op', async () => {
    const service = createService();
    const result = await service.dispose();
    assert.deepEqual(result, { disposed: true, terminationConfirmed: true });
    assert.equal(service.hasSession(), false, 'no session must remain after dispose');
  });

  test('dispose() is idempotent: a repeated idle call stays confirmed', async () => {
    const service = createService();
    await service.dispose();
    const secondResult = await service.dispose();
    assert.deepEqual(secondResult, { disposed: true, terminationConfirmed: true });
    assert.equal(service.hasSession(), false, 'the service must hold no session after repeated dispose');
  });
});
