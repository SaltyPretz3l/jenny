'use strict';

// HTTP to the team host through the member bridge's loopback port. Every socket
// starts with the 40-byte member preamble (the per-launch secret), then one plain
// HTTP/1.1 request to the fixed team host name with `Connection: close`. No query
// string, no absolute form, bounded bodies, bounded answers and a timeout. A
// request that was sent and got no readable answer (none at all, too large, not
// JSON) is a reset (`error.reset === true`): the caller cannot know whether a
// mutation it sent happened. Nothing here logs.

const http = require('node:http');
const net = require('node:net');

const { encodeMemberPreamble } = require('../../server/team/transport/preamble');
const { createFrameParser } = require('./event-frames');
const { TeamError } = require('./team-errors');

// Must equal the host listener's constant (server/team/team-http-server.js TEAM_HOST); a test pins it.
const TEAM_HOST = 'jenny-team.invalid';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
// Four host heartbeats (one every 5 s) may go missing before a parsed event stream counts as stalled.
const DEFAULT_STREAM_IDLE_MS = 20_000;
const PATH = /^\/api\/v1\/[a-z0-9/._-]{1,128}$/u;

function fail(reason, reset = false) {
  return new TeamError('CONNECTION_FAILED', reason, { reset });
}

function createTeamHttp({
  port, launchSecret, timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  connect = net.connect,
}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('port must be a TCP port');
  const preamble = encodeMemberPreamble(launchSecret);
  const sockets = new Set();

  function openSocket() {
    const socket = connect({ host: '127.0.0.1', port });
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    // Written before the HTTP layer writes anything, so it is the first bytes on the wire.
    socket.write(preamble);
    return socket;
  }

  function send(method, path, { body, headers = {} } = {}) {
    if (typeof path !== 'string' || !PATH.test(path) || path.includes('//')) {
      return { error: fail('team_path_invalid') };
    }
    const payload = body === undefined ? '' : JSON.stringify(body);
    if (Buffer.byteLength(payload) > MAX_REQUEST_BYTES) return { error: fail('team_request_too_large') };
    // The caller's headers go first so they can never replace the fixed ones.
    const requestHeaders = { ...headers, Host: TEAM_HOST, Connection: 'close',
      'Content-Length': String(Buffer.byteLength(payload)),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) };
    try {
      // No `agent`: with one (even `agent: false`) Node ignores `createConnection` and the preamble would be skipped.
      const request = http.request({ host: '127.0.0.1', port, method, path, headers: requestHeaders,
        createConnection: openSocket, setHost: false });
      return { request, payload };
    } catch {
      // A header value Node refuses (a host-supplied token with a bad character): nothing was sent.
      return { error: fail('team_request_invalid') };
    }
  }

  /** One request; resolves { status, json } for any JSON object answer. */
  function request(method, path, options = {}) {
    const prepared = send(method, path, options);
    if (prepared.error) return Promise.reject(prepared.error);
    const { request: req, payload } = prepared;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          // The socket is released now, not when its close event arrives later.
          if (req.socket) { sockets.delete(req.socket); req.socket.destroy(); }
          req.destroy();
          reject(error);
        } else resolve(value);
      };
      const timer = setTimeout(() => settle(fail('team_request_timeout', true)), timeoutMs);
      req.on('error', () => settle(fail('team_connection_reset', true)));
      req.on('response', (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxResponseBytes) { settle(fail('team_response_too_large', true)); return; }
          chunks.push(chunk);
        });
        response.on('aborted', () => settle(fail('team_connection_reset', true)));
        response.on('error', () => settle(fail('team_connection_reset', true)));
        response.on('end', () => {
          let json;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; }
          if (!json || typeof json !== 'object' || Array.isArray(json)) { settle(fail('team_response_invalid', true)); return; }
          settle(null, { status: response.statusCode, json });
        });
        response.on('close', () => { if (!response.complete) settle(fail('team_connection_reset', true)); });
      });
      req.end(payload);
    });
  }

  /**
   * A long-lived GET (the event stream). Resolves { status, close(), closed } once
   * the answer's head arrives; `closed` resolves when the stream ends for any
   * reason. Without `onFrame` the body is read and dropped. With it, a 200 answer's
   * body goes through the frame parser and each complete frame is passed to
   * `onFrame` in order; a protocol error (an oversized frame, bytes that are not
   * UTF-8, an `onFrame` that throws) calls `onProtocolError(reason)` once, closes
   * the stream and delivers nothing more. A parsed stream also has an idle timer
   * (`idleTimeoutMs`, reset by any received bytes, heartbeats included): a stream
   * silent that long is closed, so a stalled host or bridge reads as a lost link.
   * The timer never keeps the process alive and ends with the stream.
   */
  function openStream(path, headers = {}, {
    onFrame, onProtocolError = () => {}, idleTimeoutMs = DEFAULT_STREAM_IDLE_MS, timers = { setTimeout, clearTimeout },
  } = {}) {
    const prepared = send('GET', path, { headers });
    if (prepared.error) return Promise.reject(prepared.error);
    const { request: req } = prepared;
    return new Promise((resolve, reject) => {
      let markClosed;
      const closed = new Promise((done) => { markClosed = done; });
      const timer = setTimeout(() => { req.destroy(); reject(fail('team_request_timeout', true)); }, timeoutMs);
      req.on('error', () => { clearTimeout(timer); markClosed(); reject(fail('team_connection_reset', true)); });
      req.on('response', (response) => {
        clearTimeout(timer);
        const parser = typeof onFrame === 'function' && response.statusCode === 200 ? createFrameParser() : null;
        let idle = null;
        let ended = false;
        const disarm = () => { if (idle !== null) timers.clearTimeout(idle); idle = null; };
        const close = () => { disarm(); req.destroy(); response.destroy(); };
        const arm = () => {
          disarm();
          if (!parser || ended) return;
          idle = timers.setTimeout(() => { idle = null; close(); }, idleTimeoutMs);
          if (idle && typeof idle.unref === 'function') idle.unref();
        };
        let failed = false;
        const protocolError = (reason) => {
          failed = true;
          close();
          try { onProtocolError(reason); } catch { /* the stream is already closed */ }
        };
        arm();
        response.on('data', (chunk) => {
          if (!parser || failed) return;
          arm();
          const { frames, error } = parser.push(chunk);
          for (const frame of frames) {
            if (failed) return;
            try { onFrame(frame); } catch { protocolError('event_frame_rejected'); return; }
          }
          if (error && !failed) protocolError(error);
        });
        response.on('error', () => {});
        response.on('close', () => { ended = true; disarm(); markClosed(); });
        resolve({ status: response.statusCode, closed, close });
      });
      req.end();
    });
  }

  return {
    request,
    openStream,
    openSockets: () => sockets.size,
    // Ends every socket and wipes the preamble copy; the client is not used after this.
    dispose() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      preamble.fill(0);
    },
  };
}

module.exports = { TEAM_HOST, createTeamHttp };
