'use strict';

// Shared steps of the two node-failure gate tests
// (tests/team-node-drop-midstream.test.js and tests/team-node-silent-stall.test.js).
// A real team host with a pool on an injected scheduler clock, the member's node
// agent in a child process with a scripted engine, a turn through the pool gateway
// as the host's sidecar sends it. No bridge binary, no GPU, no model, no window.

const assert = require('node:assert/strict');

const { nodeIdFor } = require('../../server/team/scheduler/state');
const { createClock } = require('../server/helpers/clock');
const { model } = require('../server/helpers/team-engine-fixture');
const { chatTurn, gatewayChat, message, startTwoProcess, until } = require('./team-node-two-process');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const SESSION = 'session_general_1';

// The host, the member's node online, and a turn whose answer has two chunks at the gateway: the engine
// sends `first`, then `reply`, and holds the answer open.
async function twoChunks(t, { prompt, reply }) {
  const clock = createClock();
  const h = await startTwoProcess(t, { script: { mode: 'hold' }, poolClock: clock });
  const events = [];
  h.m.scheduler.onChange((event) => { events.push(event); });
  await until(() => h.m.scheduler.listNodes().some((node) => node.online), 'the agent\'s node is online');
  const [node] = h.m.scheduler.listNodes();
  assert.equal(node.node_id, nodeIdFor(h.seats.member.device_id), 'the node id is the fixed function of its device');
  const turn = await h.m.pool.turnRoute.acquire(chatTurn(h.seats.owner, SESSION));
  const chat = gatewayChat(h.m, turn.token, message(prompt));
  await until(() => chat.state.text.includes('first'), 'the first chunk reaches the gateway');
  await h.agent.send('write', { text: reply });
  await until(() => chat.state.text.includes(reply), 'the second chunk reaches the gateway');
  const [lease] = h.m.scheduler.listLeases();
  assert.equal(h.m.scheduler.listJobs()[0].state, 'streaming');
  return { h, clock, events, node: node.node_id, turn, chat, leaseId: lease.lease_id };
}

const sweep = (g) => g.h.m.scheduler.sweep(g.clock());

// The common outcome: the lease and its one job failed with `reason`, the answer ended without [DONE],
// the conversation is excluded from the failed node for 10 minutes (shown with that node back), a new
// send goes to another node, nothing was replayed, and no prompt, reply, token or key reached a log
// line, a usage row or a pool event.
async function assertFailedAndRetriedElsewhere(g, { reason, prompt, reply }) {
  const { h, clock } = g;
  const scheduler = h.m.scheduler;
  await until(() => g.chat.state.closed, 'the gateway answer ends');
  const lease = scheduler.getLease(g.leaseId);
  assert.deepEqual([lease.state, lease.reason, lease.node_id], ['failed', reason, g.node]);
  const jobs = scheduler.listJobs().filter((job) => job.lease_id === g.leaseId);
  assert.deepEqual(jobs.map((job) => [job.state, job.reason]), [['failed', reason]], 'one job for the turn, never replayed');
  assert.equal(g.chat.state.text.includes('[DONE]'), false, 'the turn ends incomplete');
  assert.equal(g.chat.state.ended, false, 'the answer was cut, not finished');
  g.turn.release({ ok: false });

  // The failed node is back (a lost node's device registers again, so the same node id): still excluded.
  if (!scheduler.listNodes().some((node) => node.node_id === g.node && node.online)) {
    scheduler.unregisterNode(g.node);
    const back = scheduler.registerNode({ deviceId: h.seats.member.device_id, memberId: h.seats.member.member_id,
      slots: 1, models: [model('alpha')] });
    assert.equal(back.node_id, g.node);
  }
  await assert.rejects(h.m.pool.turnRoute.acquire(chatTurn(h.seats.owner, SESSION)), { reason: 'no_eligible_node' });

  // Another node: the new send goes there and completes.
  const other = h.m.node({ models: [model('alpha')] });
  const retry = await h.m.pool.turnRoute.acquire(chatTurn(h.seats.owner, SESSION));
  const retryLease = scheduler.listLeases().find((entry) => entry.state === 'active');
  assert.equal(retryLease.node_id, other.nodeId, 'the new send goes to the other node');
  const chat = gatewayChat(h.m, retry.token, message(prompt));
  const job = await other.claimNext();
  job.send(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\ndata: [DONE]\n\n`, true);
  await until(() => chat.state.ended, 'the retried answer ends');
  retry.release({ ok: true });
  assert.ok(chat.state.text.includes('[DONE]'));
  assert.equal(scheduler.listJobs().filter((entry) => entry.lease_id === g.leaseId).length, 1, 'still one job for the failed turn');

  // Ten minutes on, the exclusion is over: with the other node paused, the failed node serves the conversation.
  clock.advance(10 * MINUTE);
  for (const node of scheduler.listNodes()) scheduler.touchNode(node.node_id);
  sweep(g);
  scheduler.setNodePaused(other.nodeId, { on: true });
  const later = await h.m.pool.turnRoute.acquire(chatTurn(h.seats.owner, SESSION));
  assert.equal(scheduler.listLeases().find((entry) => entry.state === 'active').node_id, g.node);
  later.release({ ok: false });

  const secrets = [prompt, reply, h.m.pool.modelCredential(), g.turn.token, retry.token, later.token];
  const surfaces = { logs: h.m.fx.logText(), usage: JSON.stringify(h.m.usageRows()), events: JSON.stringify(g.events) };
  for (const [name, text] of Object.entries(surfaces)) {
    for (const secret of secrets) assert.equal(text.includes(secret), false, `${name} carries no prompt, reply, token or key`);
  }
  return { reason };
}

module.exports = { SECOND, assertFailedAndRetriedElsewhere, sweep, twoChunks };
