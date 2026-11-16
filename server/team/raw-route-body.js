'use strict';

// What the team host's raw-body routes share (the project part routes, slice 3-8b, and the chat attachment
// routes, slice 2c host): the client check, reading exactly a declared body, the refusal that drains or stops
// that body, the drain rule, and the per-member in-flight slots.
//
// A refusal made before a body is read either drains it (while the declared length is at most twice the route's
// cap: answering while the client still sends makes Node close on unread data, which on Windows resets the
// connection and loses the answer) and answers at its end, or answers at once and closes without reading it.

const { sendHostFailure } = require('../http-server');

const LENGTH = /^(0|[1-9][0-9]{0,15})$/u;

function authorized(ctx) {
  return typeof ctx.authorized === 'function' ? ctx.authorized() === true : ctx.authorized === true;
}

// Exactly `declared` bytes in one buffer allocated once, or null: more than declared, fewer at the end, or an
// aborted request.
function readExactly(request, declared) {
  return new Promise((resolve) => {
    const body = Buffer.allocUnsafe(declared);
    let total = 0;
    let settled = false;
    const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
    request.on('data', (chunk) => {
      if (settled) return;
      if (total + chunk.length > declared) { settle(null); request.destroy(); return; }
      chunk.copy(body, total);
      total += chunk.length;
    });
    request.on('end', () => settle(total === declared ? body : null));
    request.on('error', () => settle(null));
    request.on('close', () => settle(null));
  });
}

// How a refusal before the body treats it: drained while its declared length is at most twice `cap`, else not read.
function bodyRule(ctx, cap) {
  const text = ctx.request?.headers?.['content-length'];
  return typeof text === 'string' && LENGTH.test(text) && Number(text) <= 2 * cap ? 'drain' : 'stop';
}

// refuse(ctx, failure, { close, body }): `body` 'drain' reads and drops what the client sends and answers at its
// end, 'stop' answers at once and reads none of it (the socket closes after the answer), 'none' answers at once
// (no body left to wait for). Logs `refusedEvent` with the reason only.
function createRefuser(log, refusedEvent) {
  return function refuse(ctx, failure, { close = false, body = 'none' } = {}) {
    const { request, response } = ctx;
    if (close && !response.headersSent) response.setHeader?.('Connection', 'close');
    log('INFO', refusedEvent, { reason: failure.error?.reason ?? 'host_unavailable' });
    let sent = false;
    const send = () => {
      if (sent) return;
      sent = true;
      // Registered before the answer, so a response that finishes at once still closes.
      if (body === 'stop') response.once?.('finish', () => request?.socket?.destroy?.());
      sendHostFailure(response, failure, ctx.requestId);
    };
    if (body === 'drain' && request && !request.readableEnded && !request.destroyed && typeof request.once === 'function') {
      for (const event of ['end', 'close', 'error']) request.once(event, send);
      request.resume();
      return true;
    }
    if (body !== 'stop') request?.resume?.();
    send();
    return true;
  };
}

// hold(key, full, work): runs `work` holding one of `limit` slots for `key`, or answers `full()` when all are held.
function createInFlight(limit) {
  const held = new Map();
  return async function hold(key, full, work) {
    const count = held.get(key) ?? 0;
    if (count >= limit) return full();
    held.set(key, count + 1);
    try {
      return await work();
    } finally {
      const left = (held.get(key) ?? 1) - 1;
      if (left > 0) held.set(key, left);
      else held.delete(key);
    }
  };
}

module.exports = { LENGTH, authorized, bodyRule, createInFlight, createRefuser, readExactly };
