'use strict';

// HTTP to the team host through the member bridge's loopback port. Every socket
// starts with the 40-byte member preamble (the per-launch secret), then one plain
// HTTP/1.1 request to the fixed team host name with `Connection: close`. No query
// string, no absolute form, bounded bodies, bounded answers and a timeout. A
// request that was sent and got no readable answer (none at all, too large, not
// JSON) is a reset (`error.reset === true`): the caller cannot know whether a
// mutation it sent happened. The team engine's streamed request (slice 4b) is the one
// answer not read into memory: its body is handed back as bytes, bounded by an idle
// limit instead of a size. Nothing here logs.
//
// Slice 3-9: a caller may ask for a longer timeout, a larger answer or a larger JSON body on one call, each clamped
// to its ceiling (the team host's own caps). PUT is sent only to an upload's part route, with raw bytes of at most one
// part; a download part is read as raw bytes of at most one part. Every other route keeps the old rules.
// Slice 2c renderer: the two team chat attachment routes ride the same path. POST raw bytes (at most 4 MiB, with the
// file's own checked type) only to `/api/v1/team/chat/uploads/<channel>`; GET one attached file from
// `/api/v1/team/chat/attachments/<channel>/<att_id>` as raw bytes of at most 4 MiB, answered with its type (an image's
// own, or octet-stream). Neither route is reachable through `request`, `openStream` or `openRequestStream`.
// Slice 6-5: the model part route (server/team/model-routes.js) takes PUT raw bytes (1 byte to 4 MiB) and GET, through
// `putPart` and `getPart` only; a model GET's 204 (no part yet, ask again) resolves as { status: 204, empty: true }.
// Row 151 T6: one board picture (server/team/boards/board-asset-routes.js), PUT raw bytes (1 byte to 10 MiB) and GET
// (answered as raw bytes only with one of four image types), through `putBoardAsset` and `getBoardAsset` only.
// Row 151 T7: one board copied in whole (server/team/boards/board-import-route.js), POST raw bytes (1 byte to
// 2 MiB, a .jennyboard text), through `postBoardImport` only.

const http = require('node:http');
const net = require('node:net');
const { PassThrough, pipeline } = require('node:stream');

const { isPort } = require('../../server/team/transport/bridge-util');
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
// The team engine (slice 4b): the route's body cap, and an idle limit above the host's
// 60 s stall between chunks and its 15 s queue-wait comments (TEAM_NODE_PROTOCOL_SPEC limits).
const MAX_STREAM_REQUEST_BYTES = 8 * 1024 * 1024;
const DEFAULT_STREAM_REQUEST_IDLE_MS = 75_000;
// Upper case too: the node job routes carry a base64url job id (slice 4c agent).
const PATH = /^\/api\/v1\/[A-Za-z0-9/._-]{1,128}$/u;
// Slice 3-9: the per-call ceilings. The host's command body cap is 1 MiB and its answer cap 8 MiB (server/config.js
// defaults); its request timeout is 120 s, so a wait past 130 s could only end in a host that already gave up.
const CEILINGS = Object.freeze({ timeoutMs: 130_000, maxResponseBytes: 8 * 1024 * 1024, maxRequestBytes: 1024 * 1024 });
// The two part routes of a project's files (server/team/project-file-routes.js), ids in the host's own shapes.
const PART_PATH = /^\/api\/v1\/projects\/project_[A-Za-z0-9_-]{1,128}\/(uploads|downloads)\/[A-Za-z0-9_-]{1,128}\/files\/(?:0|[1-9][0-9]{0,8})\/parts\/(?:0|[1-9][0-9]{0,8})$/u;
// One part (the host's TRANSFER_LIMITS.maxPartBytes); a part route's JSON answer is a few fields.
const MAX_PART_BYTES = 4 * 1024 * 1024;
const MAX_PART_ANSWER_BYTES = 64 * 1024;
// Slice 2c renderer: the chat attachment routes (server/team/chat-attachment-routes.js), channel and id in the host's
// own shapes (services/host/team-chat-schema.js CHANNEL_PATTERNS, PATTERNS.attachment); a file is at most 4 MiB.
const CHANNEL = '(?:chan_team|chan_project_[A-Za-z0-9_-]{1,128}|chan_dm_[a-f0-9]{64}|chan_c_[a-z2-7]{16})';
const CHAT_UPLOAD_PATH = new RegExp(`^/api/v1/team/chat/uploads/${CHANNEL}$`, 'u');
const CHAT_FILE_PATH = new RegExp(`^/api/v1/team/chat/attachments/${CHANNEL}/att_[0-9A-HJKMNP-TV-Z]{26}$`, 'u');
// Slice 6-5: one model part, ids in the relay's shapes (server/team/model-relay-core.js), at most 8 files per offer.
const MODEL_PART_PATH = /^\/api\/v1\/team\/models\/transfers\/mxfer_[A-Za-z0-9_-]{22}\/files\/[0-7]\/parts\/(?:0|[1-9][0-9]{0,8})$/u;
// Row 151 T6: one board picture, named by its project, its board and the SHA-256 of its bytes; at most 10 MiB.
const BOARD_ASSET_PATH = /^\/api\/v1\/projects\/project_[A-Za-z0-9_-]{1,128}\/boards\/board_[0-9a-f-]{36}\/assets\/[0-9a-f]{64}$/u;
const MAX_BOARD_ASSET_BYTES = 10 * 1024 * 1024;
const PICTURE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
// Row 151 T7: a board copied into a project, at most a board document's 2 MiB.
const BOARD_IMPORT_PATH = /^\/api\/v1\/projects\/project_[A-Za-z0-9_-]{1,128}\/boards\/import$/u;
const MAX_BOARD_IMPORT_BYTES = 2 * 1024 * 1024;
// The most raw bytes a route takes when it is not one part's 4 MiB.
const RAW_MOST = Object.freeze({ board_asset: MAX_BOARD_ASSET_BYTES, board_import: MAX_BOARD_IMPORT_BYTES });
const RAW_TYPE = /^[a-z0-9][a-z0-9.+-]{0,62}\/[a-z0-9][a-z0-9.+-]{0,62}$/u;
// The answer types a chat file may come back as: the host sends an image's own type, octet-stream for anything else.
const FILE_TYPES = new Set(['application/octet-stream', 'image/png', 'image/jpeg', 'image/webp']);
// Slice 6-6: the model part routes above, PUT and GET, are the only requests that use the bridge's bulk port.

// True for a request that carries a model part's bytes: its body (PUT) or its answer (GET).
function isModelPart(method, path) {
  return (method === 'PUT' || method === 'GET') && typeof path === 'string' && MODEL_PART_PATH.test(path);
}

function fail(reason, reset = false) {
  return new TeamError('CONNECTION_FAILED', reason, { reset });
}

function validPath(path) {
  return typeof path === 'string' && PATH.test(path) && !path.includes('//');
}

// 'uploads' or 'downloads' for a part route, 'chat_upload' or 'chat_file' for a chat attachment route, 'model' for a
// model part route, 'board_asset' for a board picture route, 'board_import' for the board import route, else null.
function partRoute(path) {
  if (typeof path !== 'string') return null;
  if (MODEL_PART_PATH.test(path)) return 'model';
  if (BOARD_ASSET_PATH.test(path)) return 'board_asset';
  if (BOARD_IMPORT_PATH.test(path)) return 'board_import';
  if (CHAT_UPLOAD_PATH.test(path)) return 'chat_upload';
  if (CHAT_FILE_PATH.test(path)) return 'chat_file';
  const match = PART_PATH.exec(path);
  return match ? match[1] : null;
}

// A caller's per-call limit, clamped to its ceiling; anything that is not a positive integer is the default.
function clamped(value, fallback, ceiling) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, ceiling) : fallback;
}

function createTeamHttp({
  port, launchSecret, timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  connect = net.connect, bulkPort = () => null,
}) {
  if (!isPort(port)) throw new TypeError('port must be a TCP port');
  const preamble = encodeMemberPreamble(launchSecret);
  const sockets = new Set();

  // The loopback port for one request: the bulk port for a model part while the caller has one, else the ordinary port.
  function portFor(method, path) {
    if (!isModelPart(method, path)) return port;
    const bulk = bulkPort();
    return isPort(bulk) ? bulk : port;
  }

  function openSocket(target = port) {
    const socket = connect({ host: '127.0.0.1', port: target });
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    // Written before the HTTP layer writes anything, so it is the first bytes on the wire.
    socket.write(preamble);
    return socket;
  }

  // `raw` (a Buffer, PUT to an upload part route only) is sent as it is; `body` is JSON. A PUT anywhere else, a GET
  // with a body or a raw body on another method is refused before any socket opens.
  // `rawType` (the chat upload only) is the file's own type, in the host's pattern.
  function send(method, path, { body, raw, rawType, headers = {}, maxRequestBytes } = {}) {
    const part = partRoute(path);
    const bothWays = part === 'model' || part === 'board_asset'; // one path takes PUT raw bytes and GET
    const rawPost = part === 'chat_upload' || part === 'board_import';
    const rawMethod = part === 'uploads' || (bothWays && method === 'PUT') ? 'PUT' : rawPost ? 'POST' : null;
    if (method === 'PUT' && !((part === 'uploads' || bothWays) && raw !== undefined)) return { error: fail('team_request_invalid') };
    if (raw !== undefined && method !== rawMethod) return { error: fail('team_request_invalid') };
    if (rawMethod && raw === undefined) return { error: fail('team_request_invalid') };
    if (method === 'GET' && part && body !== undefined) return { error: fail('team_request_invalid') };
    if (!part && !validPath(path)) return { error: fail('team_path_invalid') };
    if (part && method !== (rawMethod || 'GET')) return { error: fail('team_request_invalid') };
    if (part === 'chat_upload' && !(typeof rawType === 'string' && RAW_TYPE.test(rawType))) return { error: fail('team_request_invalid') };
    let payload;
    let type = null;
    if (raw !== undefined) {
      const most = Object.hasOwn(RAW_MOST, part) ? RAW_MOST[part] : MAX_PART_BYTES;
      if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > most) return { error: fail('team_request_too_large') };
      payload = raw;
      type = part === 'chat_upload' ? rawType : part === 'board_import' ? 'application/json' : 'application/octet-stream';
    } else {
      payload = body === undefined ? '' : JSON.stringify(body);
      if (Buffer.byteLength(payload) > clamped(maxRequestBytes, MAX_REQUEST_BYTES, CEILINGS.maxRequestBytes)) {
        return { error: fail('team_request_too_large') };
      }
      if (body !== undefined) type = 'application/json';
    }
    // The caller's headers go first so they can never replace the fixed ones.
    const requestHeaders = { ...headers, Host: TEAM_HOST, Connection: 'close',
      'Content-Length': String(Buffer.byteLength(payload)), ...(type ? { 'Content-Type': type } : {}) };
    try {
      // No `agent`: with one (even `agent: false`) Node ignores `createConnection` and the preamble would be skipped.
      const target = portFor(method, path);
      const request = http.request({ host: '127.0.0.1', port: target, method, path, headers: requestHeaders,
        createConnection: () => openSocket(target), setHost: false });
      return { request, payload };
    } catch {
      // A header value Node refuses (a host-supplied token with a bad character): nothing was sent.
      return { error: fail('team_request_invalid') };
    }
  }

  // One prepared request read whole: resolves { status, json } for a JSON object answer, or, with `binary`, a 200
  // octet-stream answer as { status, bytes } (any other answer is read as JSON).
  // `signal` (a part call's): an abort ends the request at once (`team_request_aborted`), the socket released.
  // `types` (a chat file's): the 200 answer types read as raw bytes, resolved as { status, bytes, type }.
  // `empty` (a model part's GET): a 204 with no body resolves as { status: 204, empty: true }.
  function exchange(prepared, { timeout, maxBytes, binary = false, signal = null, types = null, empty = false }) {
    if (prepared.error) return Promise.reject(prepared.error);
    const { request: req, payload } = prepared;
    // An already-aborted call: the request never connects; its destroy error is caught (uncaught it ends the process).
    if (signal?.aborted) { req.on('error', () => {}); req.destroy(); return Promise.reject(fail('team_request_aborted')); }
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => settle(fail('team_request_aborted'));
      const settle = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) {
          // The socket is released now, not when its close event arrives later.
          if (req.socket) { sockets.delete(req.socket); req.socket.destroy(); }
          req.destroy();
          reject(error);
        } else resolve(value);
      };
      const timer = setTimeout(() => settle(fail('team_request_timeout', true)), timeout);
      signal?.addEventListener('abort', onAbort, { once: true });
      req.on('error', () => settle(fail('team_connection_reset', true)));
      req.on('response', (response) => {
        const chunks = [];
        let size = 0;
        const answerType = String(response.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
        const raw = binary && response.statusCode === 200
          && (types ? types.has(answerType) : String(response.headers['content-type'] || '').startsWith('application/octet-stream'));
        const cap = raw ? maxBytes : Math.min(maxBytes, binary ? MAX_PART_ANSWER_BYTES : maxBytes);
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > cap) { settle(fail('team_response_too_large', true)); return; }
          chunks.push(chunk);
        });
        response.on('aborted', () => settle(fail('team_connection_reset', true)));
        response.on('error', () => settle(fail('team_connection_reset', true)));
        response.on('end', () => {
          if (raw) { settle(null, { status: response.statusCode, bytes: Buffer.concat(chunks), ...(types ? { type: answerType } : {}) }); return; }
          if (empty && response.statusCode === 204 && size === 0) { settle(null, { status: 204, empty: true }); return; }
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
   * One request; resolves { status, json } for any JSON object answer. `timeoutMs`, `maxResponseBytes` and
   * `maxRequestBytes` (slice 3-9) raise this call's limits up to their ceilings. Never a part route.
   */
  function request(method, path, options = {}) {
    if (partRoute(path)) return Promise.reject(fail('team_request_invalid'));
    return exchange(send(method, path, options), {
      timeout: clamped(options.timeoutMs, timeoutMs, CEILINGS.timeoutMs),
      maxBytes: clamped(options.maxResponseBytes, maxResponseBytes, CEILINGS.maxResponseBytes),
    });
  }

  /** Slice 3-9: PUT one upload part (raw bytes, at most one part); resolves { status, json }. Slice 6-5: or one model part. */
  function putPart(path, bytes, { headers = {}, timeoutMs: callTimeout, signal = null } = {}) {
    if (!['uploads', 'model'].includes(partRoute(path))) return Promise.reject(fail('team_request_invalid'));
    return exchange(send('PUT', path, { raw: bytes, headers }),
      { timeout: clamped(callTimeout, timeoutMs, CEILINGS.timeoutMs), maxBytes: MAX_PART_ANSWER_BYTES, signal });
  }

  /** Slice 3-9: GET one download part; resolves { status, bytes } (at most `maxBytes`, one part) or { status, json }. */
  // Slice 6-5: or one model part, whose 204 resolves { status: 204, empty: true }.
  function getPart(path, { headers = {}, timeoutMs: callTimeout, maxBytes = MAX_PART_BYTES, signal = null } = {}) {
    const route = partRoute(path);
    if (route !== 'downloads' && route !== 'model') return Promise.reject(fail('team_request_invalid'));
    return exchange(send('GET', path, { headers }), { timeout: clamped(callTimeout, timeoutMs, CEILINGS.timeoutMs),
      maxBytes: clamped(maxBytes, MAX_PART_BYTES, MAX_PART_BYTES), binary: true, signal, empty: route === 'model' });
  }

  /** Slice 2c renderer: POST one chat attachment (raw bytes, 1 byte to 4 MiB, its type); resolves { status, json }. */
  function postChatUpload(path, bytes, { type, headers = {}, timeoutMs: callTimeout, signal = null } = {}) {
    if (partRoute(path) !== 'chat_upload') return Promise.reject(fail('team_request_invalid'));
    return exchange(send('POST', path, { raw: bytes, rawType: type, headers }),
      { timeout: clamped(callTimeout, timeoutMs, CEILINGS.timeoutMs), maxBytes: MAX_PART_ANSWER_BYTES, signal });
  }

  /** Slice 2c renderer: GET one attached chat file; resolves { status, bytes, type } (at most 4 MiB) or { status, json }. */
  function getChatFile(path, { headers = {}, timeoutMs: callTimeout, signal = null } = {}) {
    if (partRoute(path) !== 'chat_file') return Promise.reject(fail('team_request_invalid'));
    return exchange(send('GET', path, { headers }), { timeout: clamped(callTimeout, timeoutMs, CEILINGS.timeoutMs),
      maxBytes: MAX_PART_BYTES, binary: true, signal, types: FILE_TYPES });
  }

  /** Row 151 T6: PUT one board picture (raw bytes, 1 byte to 10 MiB); resolves { status, json }. */
  function putBoardAsset(path, bytes, { headers = {}, timeoutMs: callTimeout, signal = null } = {}) {
    if (partRoute(path) !== 'board_asset') return Promise.reject(fail('team_request_invalid'));
    return exchange(send('PUT', path, { raw: bytes, headers }),
      { timeout: clamped(callTimeout, timeoutMs, CEILINGS.timeoutMs), maxBytes: MAX_PART_ANSWER_BYTES, signal });
  }

  /** Row 151 T6: GET one board picture; resolves { status, bytes, type } (at most 10 MiB, an image type) or { status, json }. */
  function getBoardAsset(path, { headers = {}, timeoutMs: callTimeout, signal = null } = {}) {
    if (partRoute(path) !== 'board_asset') return Promise.reject(fail('team_request_invalid'));
    return exchange(send('GET', path, { headers }), { timeout: clamped(callTimeout, timeoutMs, CEILINGS.timeoutMs),
      maxBytes: MAX_BOARD_ASSET_BYTES, binary: true, signal, types: PICTURE_TYPES });
  }

  /** Row 151 T7: POST one board as a .jennyboard text (raw bytes, 1 byte to 2 MiB); resolves { status, json }. */
  function postBoardImport(path, bytes, { headers = {}, timeoutMs: callTimeout, signal = null } = {}) {
    if (partRoute(path) !== 'board_import') return Promise.reject(fail('team_request_invalid'));
    return exchange(send('POST', path, { raw: bytes, headers }),
      { timeout: clamped(callTimeout, timeoutMs, CEILINGS.timeoutMs), maxBytes: MAX_PART_ANSWER_BYTES, signal });
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
    if (partRoute(path)) return Promise.reject(fail('team_request_invalid'));
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

  /**
   * One streamed request (the team engine, slice 4b): `POST` with a bounded raw
   * body (bytes or a string, at most `maxBodyBytes`, sent as JSON) or a bodyless
   * `GET`. Resolves { status, headers, body, close(), closed } once the answer's
   * head arrives; `body` is a byte stream of the answer body as received (transfer
   * framing removed, nothing parsed) with backpressure. A body that goes silent
   * for `idleTimeoutMs` (counted while bytes are expected and the consumer is not
   * holding the stream back), a cut connection or `close()` ends the stream with an
   * error, so a truncated answer never reads as a clean end. A head that does not
   * come within `headTimeoutMs`, or an aborted `signal`, rejects as a reset.
   */
  function openRequestStream(method, path, {
    body, headers = {}, maxBodyBytes = MAX_STREAM_REQUEST_BYTES, headTimeoutMs = timeoutMs,
    idleTimeoutMs = DEFAULT_STREAM_REQUEST_IDLE_MS, signal = null, timers = { setTimeout, clearTimeout },
  } = {}) {
    if (!(method === 'POST' || (method === 'GET' && body === undefined))) return Promise.reject(fail('team_request_invalid'));
    // A Buffer is sent as it is: copying would hold up to 8 MiB twice.
    const bytes = body === undefined ? null : (Buffer.isBuffer(body) ? body : Buffer.from(body));
    if (bytes && bytes.length > Math.min(maxBodyBytes, MAX_STREAM_REQUEST_BYTES)) return Promise.reject(fail('team_request_too_large'));
    if (signal?.aborted) return Promise.reject(fail('team_request_aborted', true));
    return streamRequest(method, path, bytes, headers, { headTimeoutMs, idleTimeoutMs, signal, timers });
  }

  function streamRequest(method, path, bytes, headers, { headTimeoutMs, idleTimeoutMs, signal, timers }) {
    if (!validPath(path) || partRoute(path)) return Promise.reject(fail('team_path_invalid'));
    let req;
    try {
      const target = portFor(method, path);
      req = http.request({ host: '127.0.0.1', port: target, method, path, createConnection: () => openSocket(target), setHost: false,
        headers: { ...headers, Host: TEAM_HOST, Connection: 'close', 'Content-Length': String(bytes ? bytes.length : 0),
          ...(bytes ? { 'Content-Type': 'application/json' } : {}) } });
    } catch {
      return Promise.reject(fail('team_request_invalid'));
    }
    return new Promise((resolve, reject) => {
      let headed = false;
      const release = () => { if (req.socket) { sockets.delete(req.socket); req.socket.destroy(); } req.destroy(); };
      const refuse = (reason) => {
        if (headed) return;
        headed = true;
        timers.clearTimeout(headTimer);
        signal?.removeEventListener('abort', onAbort);
        release();
        reject(fail(reason, true));
      };
      const onAbort = () => refuse('team_request_aborted');
      const headTimer = timers.setTimeout(() => refuse('team_request_timeout'), headTimeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      req.on('error', () => refuse('team_connection_reset'));
      req.on('response', (response) => {
        if (headed) { response.destroy(); return; }
        headed = true;
        timers.clearTimeout(headTimer);
        signal?.removeEventListener('abort', onAbort);
        resolve(passThrough(response, release, { idleTimeoutMs, timers }));
      });
      req.end(bytes || undefined);
    });
  }

  // Hands the answer body out through a PassThrough so the idle timer can watch
  // it without taking the stream out of the consumer's hands.
  function passThrough(response, release, { idleTimeoutMs, timers }) {
    const out = new PassThrough();
    // close() or the idle timer may destroy `out` with an error after the internal
    // pipeline finished and dropped its listener: that must never be an uncaught error.
    out.on('error', () => {});
    let idle = null;
    let markClosed;
    const closed = new Promise((done) => { markClosed = done; });
    const disarm = () => { if (idle !== null) timers.clearTimeout(idle); idle = null; };
    const arm = () => {
      disarm();
      idle = timers.setTimeout(() => { idle = null; out.destroy(fail('team_stream_idle', true)); }, idleTimeoutMs);
      if (idle && typeof idle.unref === 'function') idle.unref();
    };
    response.on('data', arm);
    response.on('end', disarm);
    // The consumer holding the stream back is not silence: no idle timer while paused.
    response.on('pause', disarm);
    response.on('resume', arm);
    out.on('close', () => { disarm(); release(); markClosed(); });
    pipeline(response, out, () => {});
    arm();
    const headers = {};
    for (const [name, value] of Object.entries(response.headers)) if (typeof value === 'string') headers[name] = value;
    return {
      status: response.statusCode,
      headers,
      body: out,
      closed,
      close: () => { if (!out.destroyed) out.destroy(fail('team_stream_closed', true)); },
    };
  }

  return {
    request,
    putPart,
    getPart,
    postChatUpload,
    getChatFile,
    putBoardAsset,
    getBoardAsset,
    postBoardImport,
    openStream,
    openRequestStream,
    openSockets: () => sockets.size,
    // Ends every socket and wipes the preamble copy; the client is not used after this.
    dispose() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      preamble.fill(0);
    },
  };
}

module.exports = { CEILINGS, MAX_STREAM_REQUEST_BYTES, TEAM_HOST, createTeamHttp };
