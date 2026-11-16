'use strict';

// Shared by the model sharing host tests (slice 6-3): fake intervals on a test clock, the sharing wiring over the
// directory fixture and the real authorizer, a command caller in the shape team-commands.js hands a family, fake
// part requests and responses for the routes, the "nothing held" check, and marker texts for the redaction checks.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { createAuthorizer } = require('../../../server/team/authorize');
const { createMembershipEvents } = require('../../../server/team/membership-events');
const { createRouteGuard } = require('../../../server/team/route-guard');
const { createTeamModelSharing } = require('../../../server/team/model-sharing');
const { createClock } = require('./clock');
const { SMALL } = require('./model-relay-fixture');
const { createTeamDirectoryFixture } = require('./team-directory-fixture');

// Marker texts that must never reach a log line or a failure payload.
const MARK = Object.freeze({ display: 'Zebra Marker Model', file: 'Zebramark-Q4_K_M.gguf', licence: 'Zebra licence text',
  url: 'https://zebra.example/model', hash: crypto.createHash('sha256').update('zebra').digest('hex') });
// The seeded devices that keep a member event stream open (an offering device without one is gone at once).
const STREAMED = Object.freeze(['owner', 'member', 'otherMember', 'memberSecondDevice']);

// Intervals on the test clock (the only timers sharing uses); `advance(ms)` runs what falls due, earliest first.
function fakeTimers(clock) {
  const live = new Map();
  let next = 0;
  return {
    setInterval(fn, ms) {
      next += 1;
      const handle = { id: next, ms, at: clock() + ms, fn, unref() { this.unrefed = true; } };
      live.set(handle.id, handle);
      return handle;
    },
    clearInterval: (handle) => { if (handle) live.delete(handle.id); },
    count: () => live.size,
    handles: () => [...live.values()],
    advance(ms) {
      const target = clock() + ms;
      for (;;) {
        const due = [...live.values()].filter((handle) => handle.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        clock.set(Math.max(clock(), due.at));
        due.at += due.ms;
        due.fn();
      }
      clock.set(target);
    },
  };
}

/** Nothing held: no request, wait, timer, body byte or relay listener; only the sweep timer runs. */
function idle(env) {
  const held = env.sharing.resources();
  assert.deepEqual(held.routes, { requests: 0, waits: 0, timers: 0, bodyBytes: 0, reading: 0 }, 'routes hold nothing');
  assert.equal(held.relay ? held.relay.listeners : 0, 0, 'no relay listener');
  assert.equal(env.timers.count(), held.sweepTimers, 'only the sweep timer');
}

// t: the test (its after-hook checks idle). streams: open one member stream per seeded device.
// attach: false leaves the builder unattached (team-main attaches once the host core exists).
function makeSharing({ t = null, flowing = 2, limits = SMALL, failPublish = false, streams = true, createRelay,
  hostPartRequests, attach = true } = {}) {
  const clock = createClock(1_000_000);
  const timers = fakeTimers(clock);
  const dir = createTeamDirectoryFixture();
  const { authorize } = createAuthorizer({ directory: dir.directory });
  const logs = [];
  const published = [];
  const membership = createMembershipEvents();
  let counter = 0;
  const randomBytes = (n) => {
    counter += 1;
    const bytes = Buffer.alloc(n);
    bytes.writeUInt32BE(counter, 0);
    return bytes;
  };
  const publish = (type, payload, options) => {
    if (failPublish) throw new Error('publish_failed');
    published.push({ type, payload, options });
  };
  const store = { directory: dir.directory, onMembershipChange: membership.onMembershipChange };
  const sharing = createTeamModelSharing({ flowing, store, authorize, publish, clock, timers, randomBytes, limits,
    logger: (...args) => logs.push(args), ...(createRelay ? { createRelay } : {}),
    ...(hostPartRequests ? { hostPartRequests } : {}) });
  const unsubscribes = attach ? sharing.attach() : [];
  if (streams) for (const name of STREAMED) sharing.onMemberStream(dir.actors[name].member_id, dir.actors[name].device_id, 'open');
  let seq = 0;
  // A command as team-commands.js hands it to a family: the live actor from the connection.
  const send = (who, operation, params = {}) => {
    seq += 1;
    const live = dir.directory.liveActor(who.device_id);
    return sharing.commands.dispatch({ operation, params, request_id: `req_${seq}` },
      { params, actor: { member_id: live.member_id, owner: live.role === 'owner', device_id: who.device_id } });
  };
  const env = { sharing, clock, timers, dir, actors: dir.actors, logs, published, membership, send, unsubscribes };
  t?.after(() => idle(env));
  return env;
}

// A valid manifest (6-1 rules) with the marker texts; `to` is an actor for a direct offer, null for the team.
function manifest({ requestId = 'req_offer_1', to = null, sizes = [10] } = {}) {
  return {
    request_id: requestId,
    audience: to ? { kind: 'member', member_id: to.member_id } : { kind: 'team' },
    display_name: MARK.display,
    files: sizes.map((size) => ({ name: MARK.file, size, sha256: MARK.hash, segments: [MARK.hash] })),
    provenance: { licence: MARK.licence, source_url: MARK.url, note: '' },
  };
}

const reasonOf = (answer) => (answer?.ok ? 'ok' : answer?.error?.reason);

// True when no marker text appears in `value` (logs, payloads).
function clean(value) {
  const text = JSON.stringify(value);
  return Object.values(MARK).every((marker) => !text.includes(marker));
}

// ---- Part routes on fakes ------------------------------------------------------------------------------------

const PATH = (transferId, index, n) => `/api/v1/team/models/transfers/${transferId}/files/${index}/parts/${n}`;

// A request whose body flows once the route resumes it or adds a 'data' listener (as a Node stream does);
// `bytesRead` counts what reached a 'data' listener.
function fakeRequest(method, length) {
  const request = new EventEmitter();
  Object.assign(request, { method, headers: length === undefined ? {} : { 'content-length': String(length) },
    bytesRead: 0, flowing: false, queued: [], destroyed: false,
    socket: { destroyed: false, timeout: 15_000, refreshed: 0,
      setTimeout(ms) { this.timeout = ms; this.refreshed += 1; }, destroy() { this.destroyed = true; } },
    resume() { request.flowing = true; for (const chunk of request.queued.splice(0)) request.feed(chunk); },
    feed(chunk) {
      if (!request.flowing) { request.queued.push(chunk); return; }
      request.bytesRead += chunk.length;
      request.emit('data', chunk);
    },
    finish() { request.emit('end'); request.emit('close'); } });
  request.on('newListener', (event) => { if (event === 'data') process.nextTick(() => request.resume()); });
  return request;
}

// A response that records what it was sent. `holdFinish` keeps a streamed body "in flight"; `pace` makes every
// write fill the buffer (the route then waits for a 'drain' the test emits). `socket.bytesWritten` counts what the
// route handed over.
function fakeResponse({ holdFinish = false, pace = false } = {}) {
  const response = new EventEmitter();
  const chunks = [];
  Object.assign(response, { headersSent: false, destroyed: false, writableEnded: false, status: null, headers: {},
    socket: { bytesWritten: 0 },
    setHeader(name, value) { response.headers[name.toLowerCase()] = value; },
    writeHead(status, headers = {}) {
      response.status = status;
      response.headersSent = true;
      for (const [name, value] of Object.entries(headers)) response.headers[name.toLowerCase()] = value;
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      response.socket.bytesWritten += chunk.length;
      return !pace;
    },
    end(body) {
      if (body) response.write(body);
      response.writableEnded = true;
      response.body = body === undefined && chunks.length === 0 ? null : Buffer.concat(chunks);
      if (!holdFinish) { response.emit('finish'); response.emit('close'); }
    },
    destroy() { response.destroyed = true; response.emit('close'); },
    json() { return response.body ? JSON.parse(String(response.body)) : null; } });
  return response;
}

function routeCtx(env, who, method, path, { length, holdFinish, pace } = {}) {
  const request = fakeRequest(method, length);
  const response = fakeResponse({ holdFinish, pace });
  const { authorize } = createAuthorizer({ directory: env.dir.directory });
  const ctx = { request, response, pathname: path, deviceId: who.device_id, requestId: 'req_route',
    actor: { member_id: who.member_id, device_id: who.device_id }, authorized: () => true,
    guard: createRouteGuard({ authorize, actor: { member_id: who.member_id, device_id: who.device_id } }) };
  return { ctx, request, response, done: env.sharing.routes(ctx) };
}

const settle = () => new Promise((resolve) => { setImmediate(resolve); });

// A direct offer from `from` (the owner) to `to` (member a), accepted on `to`'s device: the transfer id.
function transfer(env, { sizes = [10], requestId = 'req_offer_1', from = env.actors.owner, to = env.actors.member } = {}) {
  const offered = env.send(from, 'team.model.offer', manifest({ to, sizes, requestId }));
  assert.equal(reasonOf(offered), 'ok');
  const accepted = env.send(to, 'team.model.accept', { offer_id: offered.offer.offer_id });
  assert.equal(reasonOf(accepted), 'ok');
  return accepted.transfer.transfer_id;
}

async function put(env, transferId, n, bytes, { index = 0, who = env.actors.owner } = {}) {
  const call = routeCtx(env, who, 'PUT', PATH(transferId, index, n), { length: bytes.length });
  call.request.feed(bytes);
  call.request.finish();
  await call.done;
  return call;
}

module.exports = {
  MARK, PATH, clean, fakeRequest, fakeResponse, fakeTimers, idle, makeSharing, manifest, put, reasonOf, routeCtx,
  settle, transfer,
};
