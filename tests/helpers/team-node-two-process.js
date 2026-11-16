'use strict';

// Parent side of tests/team-two-process.test.js: a real team host with a `pool` block
// (team-engine-mount-fixture.js, seeded members), a bridge stand-in, the agent's child
// process and a turn through the pool gateway as the host's sidecar would send it.
//
// The bridge stand-in stands for the member's native bridge: it checks the member
// preamble (the per-launch secret) on each local socket and dials the host's listener
// with the host preamble (boot secret and the member's device key), then copies bytes
// both ways. The device key and the boot secret stay in this process.

const { fork } = require('node:child_process');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const { ROUTE_TOKEN_HEADER } = require('../../server/team/pool-gateway');
const {
  MEMBER_PREAMBLE_BYTES, encodeHostPreamble, verifyMemberPreamble,
} = require('../../server/team/transport/preamble');
const { startMountedHost } = require('../server/helpers/team-engine-mount-fixture');

const CHILD = path.join(__dirname, 'team-node-agent-child.js');

async function startBridgeStandIn(t, { port, bootSecret, key }) {
  const launchSecret = crypto.randomBytes(32);
  const keyBytes = Buffer.from(key, 'base64url');
  const sockets = new Set();
  const track = (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); };
  const server = net.createServer((local) => {
    track(local);
    let head = Buffer.alloc(0);
    const onData = (part) => {
      head = Buffer.concat([head, part]);
      if (head.length < MEMBER_PREAMBLE_BYTES) return;
      local.off('data', onData);
      local.pause();
      if (!verifyMemberPreamble(head.subarray(0, MEMBER_PREAMBLE_BYTES), launchSecret)) { local.destroy(); return; }
      const remote = net.connect({ host: '127.0.0.1', port });
      track(remote);
      remote.write(encodeHostPreamble(bootSecret, keyBytes));
      if (head.length > MEMBER_PREAMBLE_BYTES) remote.write(head.subarray(MEMBER_PREAMBLE_BYTES));
      local.pipe(remote);
      remote.pipe(local);
      local.on('close', () => remote.destroy());
      remote.on('close', () => local.destroy());
      local.resume();
    };
    local.on('data', onData);
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }));
  return { port: server.address().port, launchSecret };
}

// The agent's process: answers each { id, type } message; stopped by message, then by its own handle.
function startChild(t) {
  const child = fork(CHILD, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', (part) => { stderr += part.toString(); });
  const waiting = new Map();
  let counter = 0;
  child.on('message', (message) => {
    const entry = waiting.get(message.id);
    if (entry) { waiting.delete(message.id); entry.resolve(message); }
  });
  const exited = new Promise((resolve) => { child.once('exit', resolve); });
  child.once('exit', () => { for (const entry of waiting.values()) entry.reject(new Error(`child exited: ${stderr}`)); });
  const send = (type, fields = {}, timeoutMs = 20_000) => new Promise((resolve, reject) => {
    counter += 1;
    const id = counter;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`no answer to ${type}`)); }, timeoutMs);
    waiting.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    child.send({ id, type, ...fields });
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      await send('stop', {}, 10_000).catch(() => {});
      child.kill();
    }
    await exited;
  });
  // The agent's process ends at once, as a crash would: no stop, no unregister, no answer.
  const die = () => { child.send({ id: 0, type: 'die' }); return exited; };
  return { child, send, die, pid: child.pid };
}

// A host with a pool, its seeded members, the bridge stand-in for `member` and the agent's child.
// `poolClock` replaces the pool scheduler's clock (the node-failure gate tests).
async function startTwoProcess(t, { protocolVersion, script = {}, poolClock = null } = {}) {
  const m = await startMountedHost(t, { poolClock });
  const seats = await m.seed();
  const bridge = await startBridgeStandIn(t, { port: m.host.port, bootSecret: m.context.bootSecret, key: seats.member.key });
  const agent = startChild(t);
  await agent.send('script', { script });
  const started = await agent.send('start', { bridgePort: bridge.port, launchSecret: bridge.launchSecret.toString('hex'),
    ...(protocolVersion === undefined ? {} : { protocolVersion }) });
  return { m, seats, agent, started };
}

// A streamed chat request to the pool gateway with the turn's route token, as the host's sidecar sends it.
function gatewayChat(m, token, body) {
  const endpoint = new URL(m.fx.backends[0].options.modelEndpoint.apiUrl);
  const payload = Buffer.from(JSON.stringify(body));
  const state = { status: 0, text: '', ended: false, closed: false };
  const request = http.request({ host: '127.0.0.1', port: Number(endpoint.port), method: 'POST', path: '/v1/chat/completions',
    headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length,
      authorization: `Bearer ${m.pool.modelCredential()}`, [ROUTE_TOKEN_HEADER]: token } }, (response) => {
    state.status = response.statusCode;
    response.on('data', (part) => { state.text += part.toString(); });
    response.on('end', () => { state.ended = true; });
    response.on('error', () => {});
    response.on('close', () => { state.closed = true; });
  });
  request.on('error', () => { state.closed = true; });
  request.end(payload);
  return { state, request };
}

const chatTurn = (principal, sessionId) => ({ sessionId, projectId: null, memberId: principal.member_id, model: 'alpha',
  wantsVision: false });

// Waits in real time (the agent paces its chunks by the real clock) until `predicate` holds.
async function until(predicate, label, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  throw new Error(`not reached: ${label}`);
}

// A streamed chat body for the team pool model.
const message = (content) => ({ model: 'team-pool', stream: true, messages: [{ role: 'user', content }] });

module.exports = { chatTurn, gatewayChat, message, startTwoProcess, until };
