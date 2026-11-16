'use strict';

// Slice 4a-4 (T7): a real `python -m sidecar` whose model endpoint is a real pool
// gateway. No model daemon, no GPU, no window: the test registers a node on the
// scheduler and answers each claimed job itself with a scripted reply, as slice
// 4c's node agent will. Pattern of tests/server/stdio-persistence.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createHostedBackend } = require('../../services/host/service-composition');
const { createPoolComposition } = require('../../server/team/pool-composition');
const { terminalFor, waitFor } = require('./helpers/team-pool-fixture');

const MEMBER = Object.freeze({ kind: 'member', member_id: 'member_alice' });
const REPLY = 'Hello from the pool node.';

function sseReply(text) {
  const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'chatcmpl-pool', object: 'chat.completion.chunk',
    created: 0, model: 'alpha', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return Buffer.from(`${chunk({ role: 'assistant', content: text }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`);
}

function jsonReply(text) {
  return Buffer.from(JSON.stringify({ id: 'chatcmpl-pool', object: 'chat.completion', created: 0, model: 'alpha',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
}

// Stands in for a node: polls its claim, answers each job with the scripted reply, keeps in contact.
function startNode(scheduler, nodeId) {
  const jobs = [];
  let seq = 0;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    scheduler.touchNode(nodeId);
    seq += 1;
    const claimed = scheduler.claim(nodeId, seq);
    if (!claimed.ok || !claimed.job) return;
    const { job_id: jobId, lease_id: leaseId } = claimed.job;
    const request = JSON.parse(scheduler.jobRequest(jobId, nodeId).request.toString('utf8'));
    jobs.push({ jobId, leaseId, model: request.model, stream: request.stream === true });
    const accepted = scheduler.acceptChunk(jobId, nodeId, 0, request.stream === true ? sseReply(REPLY) : jsonReply(REPLY), true);
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
  }, 20);
  return { jobs, stop() { stopped = true; clearInterval(timer); } };
}

test('a real sidecar streams a member turn through the pool gateway and fails cleanly with no eligible node',
  { timeout: 120_000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-pool-sidecar-'));
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-pool-runtime-'));
    const pythonExecutable = process.env.JENNY_TEST_PYTHON || path.resolve('.venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    assert.equal(fs.existsSync(pythonExecutable), true, 'Test Python runtime must be provisioned.');
    const logs = [];
    const pool = createPoolComposition({ contextLength: 32768, randomBytes: crypto.randomBytes,
      logger: (...args) => logs.push(args), mayUsePool: () => true });
    let host;
    let node;
    try {
      const { modelEndpoint } = await pool.start();
      host = createHostedBackend({ hostMode: 'server', userDataPath: root, runtimeHome, workspaceRoot: null,
        repoRoot: path.resolve(__dirname, '../..'), pythonExecutable, modelEndpoint, turnRoute: pool.turnRoute,
        credentialService: { get: (key) => (key === 'openai_compatible_api_key' ? pool.modelCredential() : null),
          getStatus: () => ({ ready: true }) } });
      await host.start();
      const { backend } = host;
      assert.equal(backend._hostedPolicyProcess, backend.sidecarManager.process, 'the sidecar initialized');
      assert.equal(backend.currentEngineType, 'openai-compatible');
      assert.equal(backend.turnRoute, pool.turnRoute);
      pool.bindRuntime({ lanes: backend.sessionRuntime.lanes });

      const registered = pool.scheduler.registerNode({ deviceId: 'device_node', memberId: 'member_node', slots: 1,
        models: [{ id: 'alpha', context_length: 32768, vision: false, thinking: false }] });
      assert.equal(registered.ok, true, JSON.stringify(registered));
      node = startNode(pool.scheduler, registered.node_id);

      const sessionId = (await backend.createSession({ title: 'Pool turn' })).data.id;
      const finished = terminalFor(backend, sessionId);
      const submitted = await backend.runtimeApplicationService.submit({ session_id: sessionId,
        idempotency_key: 'pool_turn_one', prompt: 'Say hello.', preferred_model: modelEndpoint.model }, { author: MEMBER });
      assert.equal(submitted.ok, true, JSON.stringify(submitted));
      const { event, deltas } = await finished;
      assert.equal(event.type, 'complete', JSON.stringify(event));
      assert.ok(node.jobs.length >= 1, 'the gateway accepted the key and the route token and made a job');
      assert.ok(node.jobs.every((job) => job.model === 'alpha'), 'the gateway set the lease model');
      // The complete event can go out before the send returns; the release follows the send.
      await waitFor(() => pool.scheduler.listLeases()[0]?.state === 'released');
      const leases = pool.scheduler.listLeases();
      assert.equal(leases.length, 1);
      assert.equal(leases[0].member_id, 'member_alice');
      assert.ok(node.jobs.every((job) => job.leaseId === leases[0].lease_id));
      const messages = backend.sessionStore.getSessionMessages(sessionId);
      const assistant = messages.find((row) => row.role === 'assistant');
      assert.ok(assistant?.content.includes(REPLY) || deltas.join('').includes(REPLY), JSON.stringify(messages));

      // No eligible node: the turn fails with the pool's reason and keeps the user message.
      node.stop();
      pool.scheduler.unregisterNode(registered.node_id);
      // A paused node still advertises the model but serves nothing (a context length no longer bars a node).
      const paused = pool.scheduler.registerNode({ deviceId: 'device_paused', memberId: 'member_node', slots: 1,
        models: [{ id: 'alpha', context_length: 32768, vision: false, thinking: false }] });
      assert.equal(pool.scheduler.setNodePaused(paused.node_id, { on: true }).ok, true);
      const second = (await backend.createSession({ title: 'No node' })).data.id;
      const failed = terminalFor(backend, second);
      const refused = await backend.runtimeApplicationService.submit({ session_id: second,
        idempotency_key: 'pool_turn_two', prompt: 'Anyone there?', preferred_model: modelEndpoint.model }, { author: MEMBER });
      assert.equal(refused.ok, true, JSON.stringify(refused));
      const outcome = await failed;
      assert.equal(outcome.event.type, 'error', JSON.stringify(outcome.event));
      assert.equal(outcome.event.error_code, 'no_eligible_node', JSON.stringify(outcome.event));
      assert.equal(backend.sessionStore.getSessionMessages(second).filter((row) => row.role === 'user').length, 1);

      const key = pool.modelCredential();
      assert.equal(JSON.stringify(logs).includes(key), false);
      const shellLog = path.join(root, 'logs', 'shell.log');
      if (fs.existsSync(shellLog)) assert.equal(fs.readFileSync(shellLog, 'utf8').includes(key), false);
    } finally {
      node?.stop();
      if (host) { await host.stop(); host.dispose(); }
      await pool.stop();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });
