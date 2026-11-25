'use strict';

// The two raw part routes of model sharing (row 123, slice 6-3; TEAM_MODEL_SHARING_SPEC "The relay", "Host
// operations" and "6-3 as built"), mounted through the team listener's raw-route hook:
//
//   PUT /api/v1/team/models/transfers/<transfer_id>/files/<index>/parts/<n>   the sender's device puts one part
//   GET /api/v1/team/models/transfers/<transfer_id>/files/<index>/parts/<n>   the receiver's device takes one part
//
// - Bounds first, before anything else: at most half the team HTTP layer's concurrent requests are model part
//   requests on the whole host, and at most 8 are one member's (2 per party x the 4 live transfers a member may
//   receive); one more answers `team_model_relay_busy` (retryable). The relay adds its own: 2 waiting requests per
//   party per transfer, 1 for the sender.
// - Then the client binding and the one guard (`model.offer` for a PUT, `model.receive` for a GET), then the switch
//   (`team_model_sharing_off` while the setting is 0, `host_unavailable` once stopped), and again once a second
//   while a request waits, reads or streams, with the relay's own check that the transfer is still live for this
//   party: a revoked or demoted member's request, or one whose transfer ended, ends within that second. The relay
//   checks the party (the offering device puts, the accepting device takes) and its answers pass through unchanged;
//   a malformed transfer id, file index or part number is the relay's one `team_not_found` (a route has no schema
//   step, and a distinct answer would tell a prober which ids are well formed).
// - PUT: `checkPut` before any body byte (a transfer accepted but not yet flowing answers the relay's
//   `team_model_relay_busy` at once). A full window waits for the transfer's next change (the relay's one-shot
//   `onChange`) up to 20 s, then answers the relay's `{ ready: false, wait: 'window_full' }`. When ready, the Content-Length must equal the
//   exact bytes the relay named, and only one body is read per transfer at a time (another answers busy). Every
//   PUT answered before its body (a refusal, the wait's answer, a duplicate) is answered at once and its socket
//   closed after the answer: the body is never read (Windows can lose such an answer to the reset; the sender
//   treats a reset as retryable). The body is read into one exact-size buffer allocated here and never reused,
//   whose ownership passes to the relay; a body silent for 10 s (the stall limit) ends the request.
// - GET: `takePart`; a part not ready waits up to 25 s in all, then answers 204. A ready part streams the relay's
//   buffer (`application/octet-stream`, `no-store`, `nosniff`) in 64 KiB writes as the socket drains, so a client
//   that stops reading shows as no progress in the socket's bytes written: 10 s without progress ends the stream.
//   A retry gets the same bytes (the window rule). The part counts against the transfer's 4-part window until its
//   response has finished or closed, so slow readers never hold part buffers beyond the window (R14-F03).
// - A client that goes away mid-wait, mid-body or mid-stream leaves no listener, timer or buffer.
//
// Logs carry event names and reason words only: never an id, a name, a hash or a size from a manifest.

const { hostFailure } = require('../api-contract');
const { TEAM_MAX_CONCURRENT_REQUESTS } = require('../config');
const { json } = require('../http-server');
const { MODEL_RELAY_ID_PATTERNS, RELAY_FAILURES } = require('./model-relay-core');
const { TEAM_RESOURCE, memberRouteDenial } = require('./engine-routes');
const { LENGTH, createInFlight, createRefuser } = require('./raw-route-body');
const { safeLogger } = require('./safe-logger');

const PUT_ACTION = 'model.offer';
const GET_ACTION = 'model.receive';
const PART_PATH = /^\/api\/v1\/team\/models\/transfers\/([^/]{1,64})\/files\/([^/]{1,24})\/parts\/([^/]{1,24})$/u;
const NUMBER = /^(0|[1-9][0-9]{0,8})$/u;
const RECHECK_MS = 1000;
const STALL_MS = 10_000;
const STREAM_CHUNK = 64 * 1024;
// Model part requests the whole host serves at once: half the team HTTP layer's, so model traffic never takes
// every request slot from chat and commands.
const HOST_PART_REQUESTS = Math.floor(TEAM_MAX_CONCURRENT_REQUESTS / 2);
const PART_HEADERS = Object.freeze({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff' });
const { busy, notFound } = RELAY_FAILURES;

/**
 * sharing: model-sharing.js's `{ state(), relay() }`. limits: the relay's limits (part size, waits, request bounds).
 * timers: `{ setInterval, clearInterval }` (the builder's). hostRequests: the host-wide bound (tests lower it).
 */
function createModelRoutes({ sharing, limits, logger = null, clock = Date.now, timers,
  hostRequests = HOST_PART_REQUESTS } = {}) {
  if (typeof sharing?.state !== 'function' || typeof sharing.relay !== 'function') {
    throw new TypeError('Model routes need the model sharing state.');
  }
  const log = safeLogger(logger);
  const refuse = createRefuser(log, 'team_model.route_refused');
  const hostHold = createInFlight(hostRequests);
  const memberHold = createInFlight(limits.partRequestsPerParty * limits.maxLiveTransfersPerMember);
  // Transfers whose part body is being read now: one at a time each.
  const reading = new Set();
  // What this module holds now: requests in a handler, waits, timers, and body bytes not yet handed to the relay.
  const held = { requests: 0, waits: 0, timers: 0, bodyBytes: 0 };

  // null while the caller may still act and sharing is on, else the refusal.
  const gate = (ctx, action) => memberRouteDenial(ctx, action, TEAM_RESOURCE) || sharing.state();
  // The gate, then the relay's check that the transfer is still live for this party (the once-a-second check).
  const stillOk = (ctx, action, actor, transferId) => {
    const denied = gate(ctx, action);
    if (denied) return denied;
    const live = sharing.relay().partyLive(actor, transferId);
    return live.ok ? null : live;
  };

  function every(fn) {
    held.timers += 1;
    const handle = timers.setInterval(fn, RECHECK_MS);
    handle?.unref?.();
    return () => { timers.clearInterval(handle); held.timers -= 1; };
  }

  // A PUT answered before its body: answered at once, the socket closed after the answer, nothing read.
  const answerUnread = (ctx, status, payload) => {
    if (!ctx.response.headersSent) ctx.response.setHeader?.('Connection', 'close');
    ctx.response.once?.('finish', () => ctx.request?.socket?.destroy?.());
    json(ctx.response, status, payload);
    return true;
  };
  const refuseUnread = (ctx, failure) => refuse(ctx, failure, { close: true, body: 'stop' });

  // Waits for the transfer's next change until `deadline`, re-running the gate once a second. Answers 'changed',
  // 'timeout', 'closed', or a refusal. The listener, the timer and the close hook are gone on every exit.
  function waitChange(ctx, actor, transferId, deadline, action) {
    const relay = sharing.relay();
    if (!relay) return Promise.resolve(sharing.state());
    return new Promise((resolve) => {
      let settled = false;
      let off = null;
      let stop = null;
      held.waits += 1;
      const onClose = () => done('closed');
      function done(value) {
        if (settled) return;
        settled = true;
        off?.();
        stop?.();
        ctx.response.off?.('close', onClose);
        held.waits -= 1;
        resolve(value);
      }
      const listening = relay.onChange(actor, transferId, () => done('changed'));
      if (!listening.ok) { done(listening); return; }
      off = listening.off;
      if (ctx.response.destroyed) { done('closed'); return; }
      ctx.response.once('close', onClose);
      const socket = ctx.request?.socket;
      stop = every(() => {
        // The HTTP layer closes a silent socket whose request has not fully arrived; a waiting PUT is at work.
        if (action === PUT_ACTION && Number.isSafeInteger(socket?.timeout) && socket.timeout > 0) socket.setTimeout(socket.timeout);
        // A client gone before its close hook was registered is caught here, within the second.
        if (ctx.response.destroyed) { done('closed'); return; }
        const denied = gate(ctx, action);
        if (denied) done(denied);
        else if (clock() >= deadline) done('timeout');
      });
    });
  }

  // Exactly `bytes` into one buffer allocated here, re-running the checks once a second. Answers { body } or
  // { failure } (the gate, or the transfer ended) or { ended } (stalled, cut short or gone).
  function readBody(ctx, actor, transferId, bytes) {
    const { request } = ctx;
    return new Promise((resolve) => {
      let body = Buffer.allocUnsafeSlow(bytes);
      let total = 0;
      let lastAt = clock();
      let settled = false;
      held.bodyBytes += bytes;
      const onData = (chunk) => {
        // More than declared: the HTTP parser holds a request to its Content-Length, so only a broken peer gets here.
        if (total + chunk.length > bytes) { settle({ ended: 'over' }); return; }
        chunk.copy(body, total);
        total += chunk.length;
        lastAt = clock();
      };
      const onEnd = () => settle(total === bytes ? { body } : { ended: 'short' });
      const onGone = () => settle({ ended: 'gone' });
      const stop = every(() => {
        if (request.destroyed) { settle({ ended: 'gone' }); return; }
        const denied = stillOk(ctx, PUT_ACTION, actor, transferId);
        if (denied) settle({ failure: denied });
        else if (clock() - lastAt >= STALL_MS) settle({ ended: 'stalled' });
      });
      function settle(result) {
        if (settled) return;
        settled = true;
        stop();
        request.off('data', onData);
        request.off('end', onEnd);
        request.off('error', onGone);
        request.off('close', onGone);
        held.bodyBytes -= bytes;
        if (!result.body) body = null;
        resolve(result);
      }
      request.on('data', onData);
      request.once('end', onEnd);
      request.once('error', onGone);
      request.once('close', onGone);
      request.resume();
    });
  }

  async function putPart(ctx, actor, transferId, index, n) {
    const deadline = clock() + limits.putWaitMs;
    let checked;
    for (;;) {
      checked = sharing.relay().checkPut(actor, transferId, index, n);
      if (!checked.ok) return refuseUnread(ctx, checked);
      if (checked.ready) break;
      const waited = await waitChange(ctx, actor, transferId, deadline, PUT_ACTION);
      if (waited === 'closed') return true;
      if (waited === 'timeout') return answerUnread(ctx, 200, checked);
      if (waited !== 'changed') return refuseUnread(ctx, waited);
      const denied = gate(ctx, PUT_ACTION);
      if (denied) return refuseUnread(ctx, denied);
    }
    if (checked.duplicate) return answerUnread(ctx, 200, checked);
    const text = ctx.request.headers?.['content-length'];
    if (typeof text !== 'string' || !LENGTH.test(text)) return refuseUnread(ctx, hostFailure('invalid', 'team_model_request_invalid'));
    const declared = Number(text);
    if (declared > checked.bytes) return refuseUnread(ctx, hostFailure('limit', 'team_model_size_limit'));
    if (declared < checked.bytes) return refuseUnread(ctx, hostFailure('conflict', 'team_model_transfer_stale'));
    if (reading.has(transferId)) return refuseUnread(ctx, busy());
    reading.add(transferId);
    let read;
    try {
      read = await readBody(ctx, actor, transferId, checked.bytes);
    } finally {
      reading.delete(transferId);
    }
    if (read.failure) return refuseUnread(ctx, read.failure);
    if (!read.body) {
      log('INFO', 'team_model.part_ended', { reason: read.ended });
      ctx.request.socket?.destroy?.();
      return true;
    }
    const denied = gate(ctx, PUT_ACTION);
    if (denied) return refuse(ctx, denied);
    const put = sharing.relay().putPart(actor, transferId, index, n, read.body);
    if (!put.ok) return refuse(ctx, put);
    json(ctx.response, 200, put);
    return true;
  }

  // Streams the relay's buffer in chunks as the socket drains, re-running the checks once a second, until it has
  // gone out, the client went away, or the socket made no progress for the stall limit. The part keeps its place in
  // the transfer's window until then: `release()` hands it back on every exit (R14-F03). A response already gone, or
  // one that throws on its headers or a write, ends the same way: nothing armed is left behind.
  function streamPart(ctx, actor, transferId, bytes, release) {
    const { response } = ctx;
    return new Promise((resolve) => {
      if (response.destroyed) {
        release?.();
        resolve(true);
        return;
      }
      let offset = 0;
      let seen = 0;
      let lastAt = clock();
      let stop = null;
      function write() {
        while (offset < bytes.length) {
          const chunk = bytes.subarray(offset, offset + STREAM_CHUNK);
          offset += chunk.length;
          if (offset >= bytes.length) { response.end(chunk); return; }
          if (response.write(chunk) === false) return;
        }
      }
      const pump = () => {
        try { write(); } catch { cut('write_failed'); }
      };
      const finish = () => {
        stop?.();
        stop = null;
        response.off('finish', finish);
        response.off('close', finish);
        response.off('drain', pump);
        release?.();
        resolve(true);
      };
      const cut = (reason) => {
        log('INFO', 'team_model.part_ended', { reason });
        response.destroy();
        finish();
      };
      response.once('finish', finish);
      response.once('close', finish);
      response.on('drain', pump);
      stop = every(() => {
        if (response.destroyed) { finish(); return; }
        if (stillOk(ctx, GET_ACTION, actor, transferId)) { cut('denied'); return; }
        const written = response.socket?.bytesWritten ?? offset;
        if (written !== seen) { seen = written; lastAt = clock(); }
        else if (clock() - lastAt >= STALL_MS) cut('stalled');
      });
      try {
        response.writeHead(200, { ...PART_HEADERS, 'Content-Length': bytes.length });
        write();
      } catch {
        cut('write_failed');
        return;
      }
      seen = response.socket?.bytesWritten ?? offset;
    });
  }

  async function getPart(ctx, actor, transferId, index, n) {
    const deadline = clock() + limits.getPollMs;
    for (;;) {
      const taken = sharing.relay().takePart(actor, transferId, index, n, { hold: true });
      if (!taken.ok) return refuse(ctx, taken);
      if (taken.ready) return streamPart(ctx, actor, transferId, taken.bytes, taken.release);
      const waited = await waitChange(ctx, actor, transferId, deadline, GET_ACTION);
      if (waited === 'closed') return true;
      if (waited === 'timeout') {
        ctx.response.writeHead(204, { 'Cache-Control': 'no-store' });
        ctx.response.end();
        return true;
      }
      if (waited !== 'changed') return refuse(ctx, waited);
      const denied = gate(ctx, GET_ACTION);
      if (denied) return refuse(ctx, denied);
    }
  }

  async function handle(ctx, put, match) {
    const early = (failure) => (put ? refuseUnread(ctx, failure) : refuse(ctx, failure));
    const denied = gate(ctx, put ? PUT_ACTION : GET_ACTION);
    if (denied) return early(denied);
    const [, transferId, indexText, partText] = match;
    if (!MODEL_RELAY_ID_PATTERNS.transfer.test(transferId) || !NUMBER.test(indexText) || !NUMBER.test(partText)) {
      return early(notFound());
    }
    const actor = { memberId: ctx.actor.member_id, deviceId: ctx.deviceId };
    const index = Number(indexText);
    const n = Number(partText);
    return put ? putPart(ctx, actor, transferId, index, n) : getPart(ctx, actor, transferId, index, n);
  }

  async function modelRoutes(ctx = {}) {
    const match = PART_PATH.exec(String(ctx.pathname || ''));
    const method = String(ctx.request?.method || '').toUpperCase();
    if (!match || (method !== 'PUT' && method !== 'GET')) return false;
    const put = method === 'PUT';
    const early = (failure) => (put ? refuseUnread(ctx, failure) : refuse(ctx, failure));
    const full = () => early(busy());
    held.requests += 1;
    try {
      return await hostHold('host', full, () => memberHold(String(ctx.actor?.member_id ?? ''), full,
        () => handle(ctx, put, match)));
    } catch {
      log('WARN', 'team_model.route_failed', {});
      if (ctx.response?.headersSent) ctx.response.destroy();
      else early(hostFailure('unavailable', 'host_unavailable'));
      return true;
    } finally {
      held.requests -= 1;
    }
  }

  return Object.assign(modelRoutes, { resources: () => ({ ...held, reading: reading.size }) });
}

module.exports = { HOST_PART_REQUESTS, createModelRoutes };
