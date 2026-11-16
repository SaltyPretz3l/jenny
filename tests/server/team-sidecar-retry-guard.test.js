'use strict';

// The sidecar retry guard (N7, N15). A real `python -m sidecar` (run from this checkout:
// the spawn's working directory is the repo root, which `-m sidecar` resolves first) whose
// model endpoint is a real pool gateway. The scripted node fails the turn's first job,
// once before any byte and once after one chunk. Proven for each: one lease, one job, the
// node asked once, and the sidecar sent nothing again (no second relayed request and no
// request refused `lease_not_active`, counted after the turn's terminal event, which the
// sidecar reports only once every attempt it makes has ended). No model, no GPU, no window.

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
const PROMPT = 'PROMPT_retry_guard_0d4f';
const REPLY = 'REPLY_retry_guard_e217';
const REPO_ROOT = path.resolve(__dirname, '../..');

const sse = (content) => `data: ${JSON.stringify({ id: 'chatcmpl-pool', object: 'chat.completion.chunk', created: 0,
  model: 'alpha', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`;

// A node that fails every job it claims: `before` fails with no byte, `after` sends one chunk first.
// claim_seq keeps rising across the scripted runs, as the agent's does: a repeated number is a replay.
let claimSeq = 0;
function startFailingNode(scheduler, nodeId, mode) {
  const jobs = [];
  const timer = setInterval(() => {
    scheduler.touchNode(nodeId);
    claimSeq += 1;
    const claimed = scheduler.claim(nodeId, claimSeq);
    if (!claimed.ok || !claimed.job) return;
    const { job_id: jobId, lease_id: leaseId } = claimed.job;
    jobs.push({ jobId, leaseId });
    const chunk = mode === 'after' ? scheduler.acceptChunk(jobId, nodeId, 0, Buffer.from(sse(REPLY)), false) : null;
    const failed = scheduler.failJob(jobId, nodeId, 'engine_error');
    jobs.at(-1).outcome = { mode, chunk, failed, job: scheduler.getJob(jobId) };
  }, 20);
  return { jobs, stop() { clearInterval(timer); } };
}

test('a node that fails the first job: the sidecar\'s retry never makes a second job for that turn',
  { timeout: 180_000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-retry-guard-'));
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-retry-guard-runtime-'));
    const pythonExecutable = process.env.JENNY_TEST_PYTHON || path.resolve('.venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    assert.equal(fs.existsSync(pythonExecutable), true, 'Test Python runtime must be provisioned.');
    const logs = [];
    const pool = createPoolComposition({ contextLength: 32768, randomBytes: crypto.randomBytes,
      logger: (...args) => logs.push(args), mayUsePool: () => true });
    const events = [];
    let host;
    let node;
    try {
      const { modelEndpoint } = await pool.start();
      pool.scheduler.onChange((event) => events.push(event));
      host = createHostedBackend({ hostMode: 'server', userDataPath: root, runtimeHome, workspaceRoot: null,
        repoRoot: REPO_ROOT, pythonExecutable, modelEndpoint, turnRoute: pool.turnRoute,
        credentialService: { get: (key) => (key === 'openai_compatible_api_key' ? pool.modelCredential() : null),
          getStatus: () => ({ ready: true }) } });
      await host.start();
      const { backend } = host;
      assert.equal(backend.sidecarManager.repoRoot, REPO_ROOT, 'the sidecar runs from this checkout');
      assert.equal(backend.currentEngineType, 'openai-compatible');
      pool.bindRuntime({ lanes: backend.sessionRuntime.lanes });
      const registered = pool.scheduler.registerNode({ deviceId: 'device_node', memberId: 'member_node', slots: 1,
        models: [{ id: 'alpha', context_length: 32768, vision: false, thinking: false }] });
      assert.equal(registered.ok, true, JSON.stringify(registered));

      const gatewayLog = (event, reason) => logs.filter(([, name, fields]) => name === event
        && (reason === undefined || fields?.reason === reason)).length;
      for (const mode of ['before', 'after']) {
        node = startFailingNode(pool.scheduler, registered.node_id, mode);
        const sessionId = (await backend.createSession({ title: `Retry guard ${mode}` })).data.id;
        const finished = terminalFor(backend, sessionId);
        const leasesBefore = pool.scheduler.listLeases().length;
        const relayedBefore = gatewayLog('team.pool.gateway.request');
        const submitted = await backend.runtimeApplicationService.submit({ session_id: sessionId,
          idempotency_key: `retry_guard_${mode}`, prompt: PROMPT, preferred_model: modelEndpoint.model }, { author: MEMBER });
        assert.equal(submitted.ok, true, JSON.stringify(submitted));
        const { event: outcome } = await finished;
        assert.notEqual(outcome.type, 'complete', `${mode}: a failed node answer never completes the turn`);
        // The terminal event comes after the sidecar's last attempt; the gateway logs a relayed request when it ends.
        await waitFor(() => gatewayLog('team.pool.gateway.request') > relayedBefore
          && pool.scheduler.listLeases().slice(leasesBefore).every((lease) => lease.state !== 'active'), 30_000);
        assert.equal(gatewayLog('team.pool.gateway.request') - relayedBefore, 1, `${mode}: one relayed request`);
        assert.equal(gatewayLog('team.pool.gateway.refused', 'lease_not_active'), 0, `${mode}: nothing sent again`);
        const leases = pool.scheduler.listLeases().slice(leasesBefore);
        assert.equal(leases.length, 1, `${mode}: one lease for the turn`);
        assert.deepEqual([leases[0].state, leases[0].reason], ['failed', 'engine_error']);
        const jobs = pool.scheduler.listJobs().filter((job) => job.lease_id === leases[0].lease_id);
        assert.equal(jobs.length, 1, `${mode}: the scheduler holds one job for the turn`);
        assert.equal(node.jobs.length, 1, `${mode}: the node was asked once`);
        assert.equal(node.jobs[0].outcome.failed.ok, true, JSON.stringify(node.jobs[0].outcome));
        node.stop();
        node = null;
        // A new lease would be a new turn; the guard is about this one. Clear the exclusion for the next mode.
        pool.scheduler.clearExclusion(leases[0].conversation_key);
      }

      const key = pool.modelCredential();
      const text = `${JSON.stringify(logs)}\n${JSON.stringify(events)}`;
      for (const secret of [key, PROMPT, REPLY]) assert.equal(text.includes(secret), false, 'no prompt, reply or key in logs or events');
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
