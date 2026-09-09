'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');

const { createHostedBackend } = require('../../services/host/service-composition');
const { BackendEvents } = require('../../server/backend-events');
const { ClientRegistry } = require('../../server/client-registry');
const { CommandReceipts } = require('../../server/command-receipts');
const { ControlLeases } = require('../../server/control-leases');
const { createCommandRouter } = require('../../server/command-router');

const ROOT = path.resolve(__dirname, '../..');
const PYTHON = process.env.JENNY_TEST_PYTHON || path.resolve('.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const BOOT = 'boot_decisions';

function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      let value = null;
      try { value = predicate(); } catch (_error) { /* retry while sidecar starts */ }
      if (value) return resolve(value);
      if (Date.now() >= deadline) return reject(new Error('stdio decision wait timed out'));
      return setTimeout(poll, 25);
    };
    poll();
  });
}

function createScript(root, name, calls) {
  const scriptPath = path.join(root, `${name}.json`);
  fs.writeFileSync(scriptPath, JSON.stringify({ version: 1, calls }), 'utf8');
  return scriptPath;
}

function withReplayEnvironment(scriptPath, delayMs) {
  const previous = {
    script: process.env.JENNY_REPLAY_SCRIPT,
    delay: process.env.JENNY_REPLAY_DELAY_MS,
  };
  process.env.JENNY_REPLAY_SCRIPT = scriptPath;
  process.env.JENNY_REPLAY_DELAY_MS = String(delayMs);
  return () => {
    if (previous.script === undefined) delete process.env.JENNY_REPLAY_SCRIPT;
    else process.env.JENNY_REPLAY_SCRIPT = previous.script;
    if (previous.delay === undefined) delete process.env.JENNY_REPLAY_DELAY_MS;
    else process.env.JENNY_REPLAY_DELAY_MS = previous.delay;
  };
}

function createFixture(root, scriptPath, delayMs = 20) {
  const options = {
    hostMode: 'server',
    credentialService: { get: () => '', getStatus: () => ({ ready: true }) },
    modelEndpoint: { engine: 'replay', model: 'replay-model' },
    userDataPath: root,
    workspaceRoot: null,
    repoRoot: ROOT,
    pythonExecutable: PYTHON,
  };
  const restoreEnvironment = withReplayEnvironment(scriptPath, delayMs);
  const host = createHostedBackend(options);
  const clients = new ClientRegistry();
  const a = clients.register('device-a');
  const b = clients.register('device-b');
  const leases = new ControlLeases();
  const events = new BackendEvents({ backend: host.backend, bootEpoch: BOOT });
  const receipts = new CommandReceipts({ filePath: path.join(root, 'command-receipts.json') });
  const router = createCommandRouter({ backend: host.backend, clients, leases, receipts,
    bootEpoch: BOOT, eventStream: events });
  let sequence = 0;
  const command = (client, operation, params = {}, extra = {}) => ({
    api_version: 1,
    boot_epoch: BOOT,
    client_id: client.client_id,
    request_id: `decision_request_${++sequence}`,
    operation,
    params,
    ...extra,
  });
  const context = (client, deviceId) => ({
    clientToken: client.client_token,
    deviceId,
    isAuthenticated: () => true,
  });
  return {
    options, host, clients, a, b, leases, events, receipts, router, command,
    contextA: context(a, 'device-a'), contextB: context(b, 'device-b'),
    restoreEnvironment,
  };
}

async function closeFixture(fixture) {
  fixture.router?.dispose();
  fixture.events?.dispose();
  try { await fixture.host?.stop(); } catch (_error) { /* cleanup only */ }
  fixture.host?.dispose();
  fixture.restoreEnvironment?.();
}

async function createSession(fixture, title) {
  const result = await fixture.router.dispatch(
    fixture.command(fixture.a, 'sessions.create', { title }), fixture.contextA,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.session.session_id;
}

async function acquire(fixture, sessionId, client, context, takeover = false) {
  const result = await fixture.router.dispatch(
    fixture.command(client, 'control.acquire', { takeover }, { session_id: sessionId }), context,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.lease;
}

test('framed hosted stdio ask_user survives a takeover and accepts one exact answer', { timeout: 45_000 }, async (t) => {
  assert.equal(fs.existsSync(PYTHON), true, 'Test Python runtime must be provisioned.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-host-stdio-decisions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scriptPath = createScript(root, 'questions', [{
    text: 'I need one choice before continuing.',
    tool_calls: [{
      tool_id: 'ask_user',
      arguments: { questions: [{ id: 'choice', prompt: 'Choose a path', options: ['A', 'B'] }] },
    }],
  }, { text: 'Thanks for choosing a path.' }]);
  const fixture = createFixture(root, scriptPath, 20);
  try {
    assert.equal(fixture.host.backend._buildManagedSidecarConfig().replay_script_path, scriptPath);
    assert.equal(fixture.host.backend._buildManagedSidecarConfig().replay_delay_ms, 20);
    await fixture.host.start();
    const sessionId = await createSession(fixture, 'Question takeover');
    const aLease = await acquire(fixture, sessionId, fixture.a, fixture.contextA);
    const before = fixture.router.snapshot(sessionId);
    let terminalResolve;
    const terminal = new Promise((resolve) => { terminalResolve = resolve; });
    fixture.host.backend.on('chat-stream', (event) => {
      if (['complete', 'error', 'cancelled'].includes(event?.type)) terminalResolve(event);
    });
    const send = fixture.command(fixture.a, 'chat.send', { prompt: 'Please ask me.' }, {
      session_id: sessionId,
      control_generation: aLease.generation,
      expected_revision: before.session.revision,
    });
    const admitted = await fixture.router.dispatch(send, fixture.contextA);
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    const pending = await waitFor(() => fixture.router.snapshot(sessionId).pending_questions?.[0]);
    assert.equal(pending.questions[0].id, 'choice');
    const bLease = await acquire(fixture, sessionId, fixture.b, fixture.contextB, true);
    const afterTakeover = fixture.router.snapshot(sessionId);
    const staleA = await fixture.router.dispatch(fixture.command(fixture.a, 'questions.answer', {
      stream_id: pending.stream_id,
      question_ref: pending.question_ref,
      answers: [{ question_id: 'choice', answer: 'A' }],
    }, {
      session_id: sessionId,
      control_generation: aLease.generation,
      expected_revision: afterTakeover.session.revision,
    }), fixture.contextA);
    assert.equal(staleA.ok, false);
    assert.equal(staleA.error.reason, 'control_lease_required');
    const answered = await fixture.router.dispatch(fixture.command(fixture.b, 'questions.answer', {
      stream_id: pending.stream_id,
      question_ref: pending.question_ref,
      answers: [{ question_id: 'choice', answer: 'A' }],
    }, {
      session_id: sessionId,
      control_generation: bLease.generation,
      expected_revision: afterTakeover.session.revision,
    }), fixture.contextB);
    assert.equal(answered.ok, true, JSON.stringify(answered));
    const final = await Promise.race([terminal, new Promise((_, reject) => setTimeout(
      () => reject(new Error('question turn did not settle')), 15_000))]);
    assert.equal(final.type, 'complete', JSON.stringify(final));
    const session = fixture.host.backend.sessionStore.getSession(sessionId);
    assert.ok(session.messages.some((message) => message.role === 'tool'
      && /Choose a path/.test(message.tool_result?.output_text || '')), JSON.stringify(session.messages));
    assert.ok(session.messages.some((message) => message.role === 'assistant' && /Thanks for choosing/.test(message.content)), JSON.stringify(session.messages));
    assert.equal(fixture.router.snapshot(sessionId).pending_questions.length, 0);
  } finally {
    await closeFixture(fixture);
  }
});

test('framed hosted stdio cancellation during paced replay persists cancelled without late mutation', { timeout: 45_000 }, async (t) => {
  assert.equal(fs.existsSync(PYTHON), true, 'Test Python runtime must be provisioned.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-host-stdio-cancel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scriptPath = createScript(root, 'cancellation', [{
    text: Array.from({ length: 180 }, (_, index) => `paced${index}`).join(' '),
  }]);
  const fixture = createFixture(root, scriptPath, 80);
  try {
    await fixture.host.start();
    const sessionId = await createSession(fixture, 'Cancellation');
    const lease = await acquire(fixture, sessionId, fixture.a, fixture.contextA);
    const before = fixture.router.snapshot(sessionId);
    let startedResolve;
    let terminalResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    const terminal = new Promise((resolve) => { terminalResolve = resolve; });
    fixture.host.backend.on('chat-stream', (event) => {
      if (event?.type === 'delta') startedResolve(event);
      if (['complete', 'error', 'cancelled'].includes(event?.type)) terminalResolve(event);
    });
    const admitted = await fixture.router.dispatch(fixture.command(fixture.a, 'chat.send', { prompt: 'Stream slowly.' }, {
      session_id: sessionId,
      control_generation: lease.generation,
      expected_revision: before.session.revision,
    }), fixture.contextA);
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    await Promise.race([started, new Promise((_, reject) => setTimeout(
      () => reject(new Error('paced replay did not emit a delta')), 10_000))]);
    const current = fixture.router.snapshot(sessionId);
    const cancelled = await fixture.router.dispatch(fixture.command(fixture.a, 'chat.cancel', {
      stream_id: admitted.stream_id,
    }, {
      session_id: sessionId,
      control_generation: lease.generation,
      expected_revision: current.session.revision,
    }), fixture.contextA);
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    const final = await Promise.race([terminal, new Promise((_, reject) => setTimeout(
      () => reject(new Error('cancelled replay did not settle')), 15_000))]);
    assert.ok(final.type === 'cancelled' || final.terminalStatus === 'cancelled' || final.status === 'cancelled', JSON.stringify(final));
    const session = fixture.host.backend.sessionStore.getSession(sessionId);
    const cancelledRow = session.messages.find((message) => message.parent_stream_id === admitted.stream_id);
    assert.ok(cancelledRow, `cancelled assistant turn must be persisted: ${JSON.stringify(session.messages)}`);
    assert.equal(cancelledRow.status || cancelledRow.terminal_status, 'cancelled');
    const frozen = JSON.stringify(session);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(JSON.stringify(fixture.host.backend.sessionStore.getSession(sessionId)), frozen);
  } finally {
    await closeFixture(fixture);
  }
});
