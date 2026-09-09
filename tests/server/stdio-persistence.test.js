'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHostedBackend } = require('../../services/host/service-composition');
const { BackendEvents } = require('../../server/backend-events');
const { ClientRegistry } = require('../../server/client-registry');
const { ControlLeases } = require('../../server/control-leases');
const { CommandReceipts } = require('../../server/command-receipts');
const { createCommandRouter } = require('../../server/command-router');

// Real framed stdio and the real canonical stores; no Electron, model daemon,
// GUI harness, or owner's profile. Container/profile-flock gates are separate.
test('two clients share a framed replay turn and canonical history survives host reconstruction', { timeout: 30_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-host-stdio-'));
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-host-runtime-'));
  const pythonExecutable = process.env.JENNY_TEST_PYTHON || path.resolve('.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  assert.equal(fs.existsSync(pythonExecutable), true, 'Test Python runtime must be provisioned.');
  const options = { hostMode: 'server', userDataPath: root, runtimeHome, workspaceRoot: null,
    repoRoot: path.resolve(__dirname, '../..'), pythonExecutable,
    modelEndpoint: { engine: 'replay', model: 'replay-model' },
    credentialService: { get: () => '', getStatus: () => ({ ready: true }) } };
  let host;
  let events;
  let router;
  try {
    host = createHostedBackend(options);
    await host.start();
    assert.equal(host.backend._hostedPolicyProcess, host.backend.sidecarManager.process);
    assert.equal(host.backend.currentEngineType, 'replay');
    const clients = new ClientRegistry();
    const a = clients.register('owner-login-a');
    const b = clients.register('owner-login-b');
    const leases = new ControlLeases();
    events = new BackendEvents({ backend: host.backend, bootEpoch: 'boot_one' });
    const receiptsPath = path.join(root, 'command-receipts.json');
    const receipts = new CommandReceipts({ filePath: receiptsPath });
    router = createCommandRouter({ backend: host.backend, clients, leases, receipts,
      bootEpoch: 'boot_one', eventStream: events });
    let sequence = 0;
    const command = (client, operation, params, extra = {}) => ({ api_version: 1,
      boot_epoch: 'boot_one', client_id: client.client_id, request_id: `request_${++sequence}`,
      operation, params, ...extra });
    const context = (client, deviceId) => ({ clientToken: client.client_token, deviceId, isAuthenticated: true });
    const aContext = context(a, 'owner-login-a');
    const bContext = context(b, 'owner-login-b');
    const created = await router.dispatch(command(a, 'sessions.create', { title: 'Durable replay' }), aContext);
    assert.equal(created.ok, true, JSON.stringify(created));
    const sessionId = created.session.session_id;
    const acquired = await router.dispatch(command(a, 'control.acquire', {}, { session_id: sessionId }), aContext);
    assert.equal(acquired.ok, true);
    const seen = [];
    let finish;
    const terminal = new Promise((resolve) => { finish = resolve; });
    host.backend.on('chat-stream', (event) => {
      seen.push(event.type);
      if (['complete', 'error', 'cancelled'].includes(event.type)) finish(event);
    });
    const before = router.snapshot(sessionId);
    const send = command(a, 'chat.send', { prompt: 'Show the replay flow.' }, {
      session_id: sessionId, control_generation: acquired.lease.generation,
      expected_revision: before.session.revision,
    });
    const admitted = await router.dispatch(send, aContext);
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    const duplicate = await router.dispatch(send, aContext);
    assert.deepEqual(duplicate, admitted);
    const final = await terminal;
    assert.equal(final.type, 'complete', final.error || final.reason);
    assert.ok(seen.includes('started'));
    assert.ok(seen.includes('delta'));
    const observed = await router.dispatch(command(b, 'sessions.snapshot', {}, { session_id: sessionId }), bContext);
    assert.equal(observed.ok, true);
    assert.equal(observed.snapshot.messages.filter((row) => row.role === 'user').length, 1);
    assert.ok(observed.snapshot.messages.some((row) => row.role === 'assistant' && row.content));
    const savedMessages = observed.snapshot.messages;
    router.dispose(); events.dispose();
    const stopped = await host.stop();
    assert.equal(stopped.exitConfirmed, true);
    host.dispose();
    host = createHostedBackend(options);
    events = new BackendEvents({ backend: host.backend, bootEpoch: 'boot_two' });
    const recoveredReceipts = new CommandReceipts({ filePath: receiptsPath });
    assert.deepEqual(recoveredReceipts.status(send.request_id, 'owner-login-a').result, admitted);
    router = createCommandRouter({ backend: host.backend, clients: new ClientRegistry(),
      leases: new ControlLeases(), receipts: recoveredReceipts, bootEpoch: 'boot_two', eventStream: events });
    const recovered = router.snapshot(sessionId);
    assert.deepEqual(recovered.messages, savedMessages);
    assert.equal(recovered.boot_epoch, 'boot_two');
    assert.equal(recovered.control, null);
    assert.equal(fs.existsSync(runtimeHome), true);
    assert.equal(fs.existsSync(path.join(root, 'runtime-home')), false);
  } finally {
    router?.dispose(); events?.dispose();
    if (host) { await host.stop(); host.dispose(); }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});
