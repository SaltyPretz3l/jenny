'use strict';

// Shared set-up for the team node tests (slice 4c host). Two harnesses:
//
// - `createNodeCommandsFixture`: the real command router over a real member store
//   (team-commands-fixture.js) with the team.node.* module handed a real pool
//   scheduler, a spied admin limiter and the real receipt store. Seats: the owner,
//   Alice (member), Rae (read-only) and Pat (pending).
// - `startNodeHost`: a real team host with a pool (team-engine-mount-fixture.js);
//   commands and the raw node routes go through the preamble client.
//
// No sidecar, no model, no engine, no window.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');

const { command } = require('../../helpers/command-router-fixture');
const { createNodeRates, createTeamNodeCommands } = require('../../../server/team/node-commands');
const { createPoolScheduler } = require('../../../server/team/scheduler');
const { TEAM_HOST } = require('../../../server/team/team-http-server');
const { createTeamCommandsFixture } = require('./team-commands-fixture');
const { startMountedHost } = require('./team-engine-mount-fixture');
const { randomKey } = require('./team-host-fixture');

// Placed in every request and chunk; it must never reach a log line.
const MARKER = 'MARKER_prompt_text_7f3a';

const model = (name, extra = {}) => ({ name, context_length: 32768, vision: false, thinking: false, ...extra });
const registerParams = (overrides = {}) => ({ protocol_version: 1, engine: { kind: 'llama-server', version: 'b5000' },
  slots: 1, models: [model('alpha')], ...overrides });
const requestBody = (extra = '') => Buffer.from(JSON.stringify({ model: 'alpha', stream: true,
  messages: [{ role: 'user', content: `${MARKER}${extra}` }] }));

// A turn of `memberId` leased on a node with `alpha` and one queued job in it.
function queueJobOn(scheduler, memberId, bytes = requestBody()) {
  const lease = scheduler.requestLease({ conversationKey: `conv:-:${crypto.randomUUID()}`, memberId, model: 'alpha',
    wantsVision: false });
  assert.equal(lease.ok, true, JSON.stringify(lease));
  const created = scheduler.createJob(lease.lease.lease_id, { requestBytes: bytes, stream: true });
  assert.equal(created.ok, true, JSON.stringify(created));
  return { lease: lease.lease, job: created.job };
}

// A request's close hook as team-http-server.js hands it over, fired by the test.
function closeHook() {
  const listeners = new Set();
  return {
    onClose(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() { for (const listener of [...listeners]) listener(); },
    count: () => listeners.size,
  };
}

// Real node rates that count the tokens asked for, so a test can tell a route reached its body read.
function countedRates(rates = createNodeRates()) {
  const taken = { claim: 0, chunk: 0 };
  return { taken, take(kind, ...rest) { taken[kind] += 1; return rates.take(kind, ...rest); },
    forget: (nodeId) => rates.forget(nodeId), size: () => rates.size() };
}

// `usage` answers the usage log (slice 4e); `nodeOptions(store)` adds options to the team.node.* module.
async function createNodeCommandsFixture(t, { rates = null, maxWaiting, withPool = true, usage = null, nodeOptions = () => ({}) } = {}) {
  const schedulerLogs = [];
  const scheduler = createPoolScheduler({ clock: () => Math.round(performance.now()), randomBytes: crypto.randomBytes,
    logger: (level, event, fields) => { schedulerLogs.push({ level, event, fields }); } });
  const holder = { pool: withPool ? { scheduler } : null, reads: 0 };
  const limiterKeys = [];
  const limiter = { take: (key) => { limiterKeys.push(key); return true; } };
  let nodes = null;
  const f = await createTeamCommandsFixture(t, { limiter, usage, nodes: ({ store, authorize, logger }) => {
    nodes = createTeamNodeCommands({ pool: () => { holder.reads += 1; return holder.pool; }, directory: store.directory,
      authorize, logger, rates: rates || createNodeRates(), ...(maxWaiting ? { maxWaiting } : {}), ...nodeOptions(store) });
    return nodes;
  } });
  t.after(() => nodes.dispose());

  // One command with a fixed request id when asked, so two refusals can be compared byte for byte.
  const send = (seat, operation, params = {}, requestId = null) => f.dispatch(seat,
    command(seat.auth, operation, params, requestId ? { request_id: requestId } : {}));
  // The module itself, past the router: `context` is what the router would hand it.
  const direct = (operation, params, context) => nodes.dispatch({ operation, params }, context);
  const register = async (seat, overrides = {}) => {
    const answer = await send(seat, 'team.node.register', registerParams(overrides));
    assert.equal(answer.ok, true, JSON.stringify(answer));
    return answer.node_id;
  };
  const queueJob = (extra = '') => queueJobOn(scheduler, f.seats.owner.member_id, requestBody(extra));
  const logText = () => JSON.stringify([f.fx.logs, schedulerLogs]);
  return { ...f, scheduler, holder, nodes: () => nodes, limiterKeys, send, direct, register, queueJob, logText };
}

// Yields to the event loop until `predicate` holds (setImmediate is never a mocked timer).
async function until(predicate, label, rounds = 2000) {
  for (let i = 0; i < rounds; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => { setImmediate(resolve); });
  }
  throw new Error(`not reached: ${label}`);
}

// `withPool: false` starts the host with no `pool` block.
async function startNodeHost(t, { rates = null, withPool = true, before = null } = {}) {
  const m = await startMountedHost(t, { ...(rates ? { extra: { createNodeRates: () => rates } } : {}),
    ...(withPool ? {} : { pool: null }), before });
  const seats = await m.seed();
  const sessions = new Map();
  // A principal with a hello and a registered client, then commands and raw routes as that device.
  async function as(principal) {
    if (!sessions.has(principal.device_id)) sessions.set(principal.device_id, await m.ready(principal));
    const { client, auth } = sessions.get(principal.device_id);
    const clientAuth = { client_id: auth['X-Client-Id'], client_token: auth['X-Client-Token'] };
    const chunkHeaders = ({ seq, final = false, length, headers = {} }) => ({ ...auth,
      'Content-Type': 'application/octet-stream', 'Content-Length': length,
      ...(seq === undefined ? {} : { 'X-Chunk-Seq': String(seq) }), 'X-Chunk-Final': final ? '1' : '0', ...headers });
    return {
      client, auth,
      async send(operation, params = {}, requestId = null) {
        const body = { ...command(clientAuth, operation, params, requestId ? { request_id: requestId } : {}),
          boot_epoch: m.context.bootEpoch };
        return (await client.request('POST', '/api/v1/commands', { body, headers: auth })).json;
      },
      fetchRequest: (jobId) => client.request('GET', `/api/v1/team/node/jobs/${jobId}/request`, { headers: auth }),
      chunk: (jobId, { body = Buffer.alloc(0), ...rest }) => client.request('POST',
        `/api/v1/team/node/jobs/${jobId}/chunks`, { rawBody: body, headers: chunkHeaders({ ...rest, length: body.length }) }),
      // A chunk whose body arrives in two parts: `first` now, the rest when the test calls `finish`.
      chunkInParts(jobId, { seq, first, rest }) {
        let answered;
        const answer = new Promise((resolve) => { answered = resolve; });
        const request = http.request({ agent: client.agent, host: '127.0.0.1', port: 1, method: 'POST',
          path: `/api/v1/team/node/jobs/${jobId}/chunks`,
          headers: { Host: TEAM_HOST, ...chunkHeaders({ seq, length: first.length + rest.length }) } }, (response) => {
          const parts = [];
          response.on('data', (part) => parts.push(part));
          response.on('end', () => {
            const text = Buffer.concat(parts).toString('utf8');
            answered({ status: response.statusCode, json: JSON.parse(text) });
          });
        });
        request.on('error', (error) => answered({ status: 0, error }));
        request.write(first);
        return { answer, finish: () => { request.end(rest); return answer; } };
      },
    };
  }
  async function register(principal, overrides = {}) {
    const answer = await (await as(principal)).send('team.node.register', registerParams(overrides));
    assert.equal(answer.ok, true, JSON.stringify(answer));
    return answer.node_id;
  }
  async function claimed(principal, seq = 1) {
    const answer = await (await as(principal)).send('team.node.claim', { claim_seq: seq, wait_ms: 0 });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.ok(answer.job, 'a job was claimed');
    return answer.job;
  }
  // A second device of an active member, as a principal `as` accepts.
  async function spareDevice(principal) {
    const created = await m.store.createInvite({ kind: 'add_device', actorMemberId: principal.member_id,
      invitePublicKey: randomKey() });
    assert.equal(created.ok, true, JSON.stringify(created));
    const key = randomKey();
    const redeemed = await m.store.redeem({ inviteId: created.invite_id, devicePublicKey: key, displayName: 'ignored',
      label: 'Phone' });
    assert.equal(redeemed.ok, true, JSON.stringify(redeemed));
    return { member_id: principal.member_id, device_id: redeemed.device_id, key };
  }
  const owner = seats.owner.member_id;
  return { m, seats, as, register, claimed, spareDevice, queueJob: (bytes) => queueJobOn(m.scheduler, owner, bytes),
    logText: () => JSON.stringify(m.fx.logs) };
}

module.exports = {
  MARKER, closeHook, countedRates, createNodeCommandsFixture, model, registerParams, requestBody, startNodeHost, until,
};
