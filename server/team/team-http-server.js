'use strict';

// The team host's HTTP layer (TEAM_MEMBERSHIP_SPEC "Preamble and the team
// listener"). The Node `http.Server` here never listens: the preamble listener
// hands it sockets that carry the authenticated remote key. Every request
// resolves its actor from that key, builds one guard, and passes the hello gate
// before any route runs. There is no cookie, CSRF, Origin, static file, login or
// session route: the transport key is the identity. A key that is no longer on
// the list destroys its socket without a byte. Logs carry request ids only.
//
// Node starts its header and request timers, and the connection list behind
// `closeAllConnections()`, only when a server listens. This one never does, so
// it keeps its own: an idle limit on every socket, a deadline for receiving
// each request, and the set of sockets it closes on stop.

const http = require('node:http');
const { randomUUID } = require('node:crypto');

const { DEFAULT_RESOURCE_LIMITS } = require('../config');
const { hostFailure } = require('../api-contract');
const {
  STATUS_BY_CODE, failure, headers, json, openEventStream, readJson, requireBodyless, retainResponseAdmission,
} = require('../http-server');
const { requireBoundedInteger } = require('../resource-limits');
const { streamIdentity } = require('./authorize');
const { REVOKE_EVENT_KINDS } = require('./membership-events');
const { createPreambleListener } = require('./preamble-listener');
const { actionForRoute } = require('./operation-registry');
const { createRouteGuard } = require('./route-guard');
const { safeLogger } = require('./safe-logger');
const { createTeamRoutes, jsonReader, permit } = require('./team-routes');

const TEAM_HOST = 'jenny-team.invalid';
const HELLO_ROUTE = 'POST /api/v1/team/hello';
const HELLO_STATE_MAX = 128;
const RESPONSE_WRITE_TIMEOUT_MS = 60_000;
const IDLE_TIMEOUT_MS = 15_000;
const SESSION_RESOURCE = Object.freeze({ kind: 'session', id: '' });

function guardAllows(guard, action, resource) {
  try { return guard(action, resource)?.ok === true; } catch { return false; }
}

function createTeamHttpServer(context) {
  const { directory, authorize, clients, events, router, assetRoutes } = context;
  const log = safeLogger(context.logger);
  const limits = { ...DEFAULT_RESOURCE_LIMITS, ...context.resourceLimits };
  const writeTimeoutMs = requireBoundedInteger(limits.responseWriteTimeoutMs ?? RESPONSE_WRITE_TIMEOUT_MS,
    RESPONSE_WRITE_TIMEOUT_MS);
  const commandBody = jsonReader(limits.maxBodyBytes);
  const routes = createTeamRoutes(context);
  const streams = new Map();
  const sockets = new Set();
  // The request a socket is serving, so an idle socket is told apart from a handler at work.
  const inFlight = new WeakMap();
  // Hello is kept per device (a loopback socket is one stream, so per connection is not visible here).
  const hello = new Map();
  let active = 0;
  let disposed = false;

  function markHello(deviceId) {
    hello.delete(deviceId);
    hello.set(deviceId, true);
    if (hello.size > HELLO_STATE_MAX) hello.delete(hello.keys().next().value);
  }

  const unsubscribeMembership = context.store.onMembershipChange((event) => {
    if (REVOKE_EVENT_KINDS.has(event.kind)) for (const deviceId of event.device_ids) hello.delete(deviceId);
  });

  function openEvents(ctx, resource) {
    const { request, response, requestId, deviceId, guard, isAuthenticated } = ctx;
    const clientId = request.headers['x-client-id'];
    const clientToken = request.headers['x-client-token'];
    const authorized = () => isAuthenticated() && directory.isDeviceActive(deviceId)
      && guardAllows(guard, ctx.action, resource) && clients.authorize(clientId, clientToken, deviceId);
    if (!authorized()) { failure(response, 'forbidden', 'client_required', requestId); return; }
    // A member's stream carries its identity, so audience-scoped events (team chat) can reach it.
    openEventStream({ request, response, requestId, deviceId, clientId, clientToken, authorized,
      clients, events, streams, identity: streamIdentity(directory, ctx.actor) });
    // Presence (slice 2a-3b): an admitted member stream reports its open and its close, once each.
    const memberId = ctx.actor?.member_id;
    if (typeof context.onMemberStream !== 'function' || typeof memberId !== 'string' || !memberId
      || streams.get(clientId)?.response !== response) return;
    const report = (change) => { try { context.onMemberStream(memberId, deviceId, change); } catch { /* best effort */ } };
    report('open');
    response.once('close', () => report('close'));
  }

  async function runCommand(ctx) {
    const { request, response, requestId, deviceId, actor, guard, isAuthenticated } = ctx;
    // A principal that may not hold a client cannot send a command: the guard says why.
    if (!permit({ ...ctx, action: 'client.register' })) return;
    const { value } = await readJson(request, commandBody);
    const result = await router.dispatch(value, { deviceId,
      clientToken: request.headers['x-client-token'], isAuthenticated, actor, guard });
    if (!isAuthenticated()) { failure(response, 'forbidden', 'member_revoked', requestId); return; }
    if (Buffer.byteLength(JSON.stringify(result)) > limits.maxResponseBytes) {
      failure(response, 'limit', 'response_limit', requestId); return;
    }
    json(response, result.ok ? 200 : STATUS_BY_CODE[result.error?.code] || 503, result);
  }

  async function route(ctx, name, url) {
    const { request, response, requestId, deviceId, isAuthenticated } = ctx;
    switch (name) {
      case HELLO_ROUTE: await routes.hello(ctx); return;
      case 'POST /api/v1/team/status': routes.status(ctx); return;
      case 'POST /api/v1/team/join': await routes.join(ctx); return;
      case 'POST /api/v1/team/leave': await routes.leave(ctx); return;
      case 'GET /api/v1/team/bootstrap': routes.bootstrap(ctx); return;
      case 'POST /api/v1/clients': {
        requireBodyless(request);
        if (!permit(ctx)) return;
        const client = clients.register(deviceId);
        if (!client) { failure(response, 'limit', 'client_capacity', requestId); return; }
        json(response, 200, { ok: true, ...client }); return;
      }
      case 'POST /api/v1/commands': await runCommand(ctx); return;
      case 'GET /api/v1/events':
        if (permit(ctx, SESSION_RESOURCE)) openEvents(ctx, SESSION_RESOURCE);
        return;
      default: {
        const clientId = request.headers['x-client-id'];
        const clientToken = request.headers['x-client-token'];
        const authorized = () => isAuthenticated() && clients.authorize(clientId, clientToken, deviceId);
        // The asset and artifact routes check `authorized` and the guard themselves and decline other paths.
        if (assetRoutes && await assetRoutes({ request, response, pathname: url.pathname, deviceId, clientId,
          authorized, requestId, actor: ctx.actor, guard: ctx.guard })) return;
        json(response, 404, hostFailure('invalid', 'route_not_found', requestId));
      }
    }
  }

  async function dispatch(request, response) {
    const requestId = randomUUID();
    headers(response, requestId);
    if (disposed || active >= limits.maxConcurrentRequests) { failure(response, 'limit', 'request_capacity', requestId); return; }
    active += 1;
    const dispatchReturned = retainResponseAdmission(response, () => { active -= 1; }, writeTimeoutMs);
    const { socket } = request;
    inFlight.set(socket, request);
    // The whole request must arrive within the request timeout, however slowly it trickles.
    const receiveDeadline = setTimeout(() => { if (!request.complete) socket.destroy(); }, limits.requestTimeoutMs);
    receiveDeadline.unref();
    response.once('close', () => {
      clearTimeout(receiveDeadline);
      if (inFlight.get(socket) === request) inFlight.delete(socket);
    });
    try {
      // A key that is no longer on the list gets no answer at all.
      const actor = directory.resolveActor(request.socket.teamKey);
      if (!actor) { request.socket.destroy(); return; }
      if (request.headers.host !== TEAM_HOST) { failure(response, 'forbidden', 'authentication_failed', requestId); return; }
      if (!request.url.startsWith('/') || request.url.startsWith('//') || request.url.length > 2048) {
        failure(response, 'invalid', 'invalid_route', requestId); return;
      }
      const url = new URL(request.url, `http://${TEAM_HOST}`);
      if (url.search) { failure(response, 'invalid', 'query_not_supported', requestId); return; }
      const deviceId = actor.device_id;
      const name = `${request.method} ${url.pathname}`;
      if (name !== HELLO_ROUTE && !hello.has(deviceId)) {
        failure(response, 'forbidden', 'team_hello_required', requestId); return;
      }
      const ctx = { request, response, requestId, actor, deviceId, action: actionForRoute(name),
        guard: createRouteGuard({ authorize, actor, requestId }), markHello: () => markHello(deviceId),
        forgetHello: () => hello.delete(deviceId),
        isAuthenticated: () => !disposed && directory.liveActor(deviceId) !== null };
      await route(ctx, name, url);
    } catch (error) {
      log('WARN', 'host.request_rejected', { request_id: requestId });
      if (response.headersSent) response.destroy();
      else failure(response, ['json_required', 'invalid_json', 'body_limit', 'unexpected_body'].includes(error.message)
        ? 'invalid' : 'unavailable', 'request_failed', requestId);
    } finally { dispatchReturned(); }
  }

  const server = http.createServer({ maxHeaderSize: limits.maxHeaderBytes, requestTimeout: limits.requestTimeoutMs,
    headersTimeout: Math.min(15_000, limits.requestTimeoutMs), keepAliveTimeout: 5_000 },
  (request, response) => { void dispatch(request, response); });
  server.maxRequestsPerSocket = 1000;
  // A socket that is silent this long is closed unless a handler is still working on a request
  // that arrived in full (an event stream stays: the request is complete and heartbeats flow).
  server.timeout = Math.min(IDLE_TIMEOUT_MS, limits.requestTimeoutMs);
  server.on('timeout', (socket) => {
    const request = inFlight.get(socket);
    if (!request || !request.complete) socket.destroy();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const heartbeat = setInterval(() => events.heartbeat(), 5000);
  heartbeat.unref();
  const close = async () => {
    if (disposed) return;
    disposed = true;
    clearInterval(heartbeat);
    unsubscribeMembership();
    for (const { response, unsubscribe, detachClient } of streams.values()) {
      unsubscribe(); detachClient(); response.destroy();
    }
    streams.clear();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise((resolve, reject) => server.close((error) => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve();
    }));
  };
  return { server, close };
}

// The default listener of `startTeamHost`: the preamble listener in front of the HTTP layer.
async function createTeamListener(context) {
  const httpLayer = createTeamHttpServer(context);
  let preamble;
  try {
    preamble = await createPreambleListener({ port: context.config.port, bootSecret: context.bootSecret,
      logger: context.logger, onSocket: (socket) => httpLayer.server.emit('connection', socket) });
  } catch (error) {
    await httpLayer.close();
    throw error;
  }
  let closing = null;
  return {
    port: preamble.port,
    // The HTTP layer ends its sockets first, so the listener has none left to wait for.
    close: () => { closing ||= (async () => { await httpLayer.close(); await preamble.close(); })(); return closing; },
  };
}

module.exports = { TEAM_HOST, createTeamHttpServer, createTeamListener };
