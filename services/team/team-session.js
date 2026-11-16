'use strict';

// The team host's API as seen through one member bridge: hello, status, join,
// leave, bootstrap, client registration, commands and the event stream
// (TEAM_MEMBERSHIP_SPEC "Invites and joining", "Version handshake"). Hello is the
// first call on every bridge; a `team_hello_required` answer (the host forgot
// this device's hello) is answered with one more hello and one retry, which is
// safe because the hello gate runs before any route. Host answers are returned
// as they are, with the host's own code and reason; a call with no answer throws
// a TeamError with `reset: true`. Nothing here logs.

const crypto = require('node:crypto');

const { TeamError, invalidRequest, isFailureAnswer } = require('./team-errors');

const PROTOCOL_VERSION = 1;
const API_VERSION = 1;
const APP_VERSION_MAX = 32;
// The host's id shape for a request id (server/api-contract.js `id`) and for Last-Event-ID (server/http-server.js).
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const LAST_EVENT_ID = /^[A-Za-z0-9_-]{1,128}:\d{1,16}$/u;
// 32 random bytes as unpadded base64url (the engine port's affinity value).
const ENGINE_KEY = /^[A-Za-z0-9_-]{43}$/u;
// A non-streamed engine turn answers only at its end: the host's 10 minute queue wait
// plus its 120 s first byte, with margin. A streamed turn's head comes at once.
const ENGINE_HEAD_TIMEOUT_MS = 12 * 60_000;
const MIB = 1024 * 1024;
// Slice 3-9: the commands that need more than the http client's defaults (15 s, a 1 MiB answer, a 64 KiB body), each
// within its ceiling (http-client.js CEILINGS). A begin names up to 2,000 files (the host's body cap is 1 MiB); a
// commit hashes and installs and a manifest hashes a whole project (both bounded by the host's 120 s request timeout);
// a manifest page lists up to 1,000 paths; a snapshot carries up to 20 messages.
const COMMAND_LIMITS = Object.freeze({
  'team.project.upload.begin': Object.freeze({ maxRequestBytes: MIB, timeoutMs: 60_000 }),
  'team.project.upload.commit': Object.freeze({ timeoutMs: 130_000 }),
  'team.project.download.manifest': Object.freeze({ maxResponseBytes: 2 * MIB, timeoutMs: 130_000 }),
  'sessions.snapshot': Object.freeze({ maxResponseBytes: 8 * MIB, timeoutMs: 30_000 }),
  // 2,000 rows of up to about 1.5 KiB each (a 240-character title escaped) need about 3 MiB; 8 MiB is the host's own
  // answer cap, so any list the host can send arrives and the client keeps its first 2,000 rows (fix 11).
  'sessions.list': Object.freeze({ maxResponseBytes: 8 * MIB, timeoutMs: 30_000 }),
  // Row 151: the host takes a board batch of up to 256 KiB of JSON (server/team/boards/board-commands.js
  // BATCH_MAX_BYTES); the envelope around it (ids, request id, boot epoch) is well under 4 KiB. A test pins the fit.
  'team.board.apply': Object.freeze({ maxRequestBytes: 256 * 1024 + 4096 }),
});
const PART_INDEX = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 999_999_999;
// A part waits behind at most four others of the member's on the host; 60 s covers a 4 MiB part on a slow relay.
const PART_TIMEOUT_MS = 60_000;
// Slice 6-5: a model part call's whole time includes the host's own waits (a GET's 25 s long poll, a PUT held up to
// 20 s for room in the window) on top of 4 MiB over a slow relay. The http client's timeout is a total, not an idle
// one, so this is its 130 s ceiling (http-client.js CEILINGS; the host's request timeout is 120 s), not 60 s.
const MODEL_PART_TIMEOUT_MS = 130_000;
// Slice 6-5: a model transfer id (server/team/model-relay-core.js) and a file index of an offer (at most 8 files).
const MODEL_TRANSFER_ID = /^mxfer_[A-Za-z0-9_-]{22}$/u;
const MODEL_FILE_INDEX = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 7;
const modelPartPath = (transferId, index, n) => `/api/v1/team/models/transfers/${transferId}/files/${index}/parts/${n}`;
const modelPartOk = (transferId, index, n) => typeof transferId === 'string' && MODEL_TRANSFER_ID.test(transferId)
  && MODEL_FILE_INDEX(index) && PART_INDEX(n);

function newRequestId() {
  return crypto.randomUUID();
}

// Slice 3-9: a session-scoped command's envelope (server/api-contract.js, the command schema): exactly these three
// fields, each in the host's own shape. The member's project client sends them; every other caller sends none.
const ENVELOPE_CHECKS = Object.freeze({
  session_id: (value) => typeof value === 'string' && REQUEST_ID.test(value),
  control_generation: (value) => Number.isSafeInteger(value) && value >= 1,
  expected_revision: (value) => typeof value === 'string' && value.length <= 160,
});

/** The envelope's fields to send ({} for none), or null when it holds a bad value or an unknown field. */
function envelopeFields(envelope) {
  if (envelope === undefined || envelope === null) return {};
  if (typeof envelope !== 'object' || Array.isArray(envelope)) return null;
  const proto = Object.getPrototypeOf(envelope);
  if (proto !== Object.prototype && proto !== null) return null;
  const out = {};
  for (const [name, value] of Object.entries(envelope)) {
    if (!Object.hasOwn(ENVELOPE_CHECKS, name) || !ENVELOPE_CHECKS[name](value)) return null;
    out[name] = value;
  }
  return out;
}

function createTeamSession({ http, appVersion, protocolVersion = PROTOCOL_VERSION }) {
  const app = String(appVersion || '0.0.0').slice(0, APP_VERSION_MAX);
  // Slice 6-6: what the host's latest hello said about bulk streams; a hello that fails says nothing.
  let bulkStreams = false;

  async function raw(method, path, options) {
    const { json } = await http.request(method, path, options);
    if (json.ok === true || isFailureAnswer(json)) return json;
    throw new TeamError('CONNECTION_FAILED', 'team_response_invalid');
  }

  async function hello() {
    bulkStreams = false;
    const answer = await raw('POST', '/api/v1/team/hello', { body: { protocol_version: protocolVersion, app_version: app } });
    bulkStreams = answer.ok === true && answer.bulk_streams === 1;
    return answer;
  }

  // Every route other than hello: one more hello and one retry when the host asks for it.
  async function call(method, path, options) {
    const first = await raw(method, path, options);
    if (!isFailureAnswer(first) || first.error.reason !== 'team_hello_required') return first;
    const again = await hello();
    if (again.ok !== true) return again;
    return raw(method, path, options);
  }

  async function partCall(send, signal) {
    const answer = async () => {
      const got = await send();
      if (got.bytes) return { ok: true, bytes: got.bytes, ...(got.type ? { type: got.type } : {}) };
      if (got.json.ok === true || isFailureAnswer(got.json)) return got.json;
      throw new TeamError('CONNECTION_FAILED', 'team_response_invalid');
    };
    const first = await answer();
    if (!isFailureAnswer(first) || first.error.reason !== 'team_hello_required' || signal?.aborted) return first;
    const again = await hello();
    return again.ok === true ? answer() : again;
  }

  function clientHeaders(client) {
    return { 'X-Client-Id': client.client_id, 'X-Client-Token': client.client_token };
  }

  function engineHeaders(client, engineKey) {
    const headers = clientHeaders(client);
    if (typeof engineKey === 'string' && ENGINE_KEY.test(engineKey)) headers['X-Engine-Key'] = engineKey;
    return headers;
  }

  return {
    hello,
    /** True when the host's latest hello said its bridge reads bulk streams. */
    bulk: () => bulkStreams,
    status: () => call('POST', '/api/v1/team/status'),
    redeem: ({ devicePublicKey, displayName, label }) => call('POST', '/api/v1/team/join',
      { body: { device_public_key: devicePublicKey, display_name: displayName, label } }),
    leave: () => call('POST', '/api/v1/team/leave'),
    bootstrap: () => call('GET', '/api/v1/team/bootstrap'),
    registerClient: () => call('POST', '/api/v1/clients'),
    // Row 151 T3: a team board's snapshot route (a board document is at most 4 MiB on the host).
    boardSnapshot: (client, projectId, boardId) => call('GET', `/api/v1/projects/${projectId}/boards/${boardId}`,
      { headers: clientHeaders(client), maxResponseBytes: 6 * MIB, timeoutMs: 30_000 }),
    // Row 151 T6: one board picture up (named by the SHA-256 of its bytes) and down (`{ ok: true, bytes, type }`),
    // with the client headers and one hello retry.
    boardAssetPut(client, { projectId, boardId, hash, bytes, signal = null }) {
      return partCall(() => http.putBoardAsset(`/api/v1/projects/${projectId}/boards/${boardId}/assets/${hash}`, bytes,
        { headers: clientHeaders(client), timeoutMs: PART_TIMEOUT_MS, signal }), signal);
    },
    boardAssetGet(client, { projectId, boardId, hash, signal = null }) {
      return partCall(() => http.getBoardAsset(`/api/v1/projects/${projectId}/boards/${boardId}/assets/${hash}`,
        { headers: clientHeaders(client), timeoutMs: PART_TIMEOUT_MS, signal }), signal);
    },
    // Row 151 T7: one board copied into a project as a new board (a .jennyboard text with no pictures).
    boardImport(client, { projectId, bytes, signal = null }) {
      return partCall(() => http.postBoardImport(`/api/v1/projects/${projectId}/boards/import`, bytes,
        { headers: clientHeaders(client), timeoutMs: PART_TIMEOUT_MS, signal }), signal);
    },
    // A fresh request id unless the caller passes one; the host keeps a mutation's answer under its id.
    // `envelope` (slice 3-9): a conversation's session id, control generation and expected revision.
    // A bad envelope is refused here and nothing is sent (connection-manager.js refuses it before any request too).
    async command(operation, params, { client, bootEpoch, requestId = newRequestId(), envelope = null }) {
      const fields = envelopeFields(envelope);
      if (fields === null) return invalidRequest('team_envelope_invalid');
      return call('POST', '/api/v1/commands', {
        body: { api_version: API_VERSION, operation, request_id: requestId, client_id: client.client_id,
          boot_epoch: bootEpoch, ...fields, params },
        headers: { 'X-Client-Token': client.client_token },
        ...(Object.hasOwn(COMMAND_LIMITS, operation) ? COMMAND_LIMITS[operation] : {}),
      });
    },
    // Slice 3-9: one part of an upload (PUT) or of a listed download (GET), with the event stream's client headers and
    // one hello retry. Answers the host's JSON answer, or `{ ok: true, bytes }` for a download part.
    // `signal` ends the part at once (cancel, leave, revoke: fix 18).
    putPart(client, { projectId, uploadId, index, n, bytes, signal = null }) {
      if (!PART_INDEX(index) || !PART_INDEX(n)) return Promise.resolve(invalidRequest());
      return partCall(() => http.putPart(`/api/v1/projects/${projectId}/uploads/${uploadId}/files/${index}/parts/${n}`,
        bytes, { headers: clientHeaders(client), timeoutMs: PART_TIMEOUT_MS, signal }), signal);
    },
    getPart(client, { projectId, manifestId, index, n, maxBytes, signal = null }) {
      if (!PART_INDEX(index) || !PART_INDEX(n)) return Promise.resolve(invalidRequest());
      return partCall(() => http.getPart(`/api/v1/projects/${projectId}/downloads/${manifestId}/files/${index}/parts/${n}`,
        { headers: clientHeaders(client), timeoutMs: PART_TIMEOUT_MS, maxBytes, signal }), signal);
    },
    // Slice 2c renderer: one chat attachment up (the name percent-encoded in X-File-Name, the type checked by the
    // http client) and one attached file down (`{ ok: true, bytes, type }`), with the same headers and hello retry.
    chatUpload(client, { channelId, name, type, bytes, signal = null }) {
      return partCall(() => http.postChatUpload(`/api/v1/team/chat/uploads/${channelId}`, bytes,
        { type, headers: { ...clientHeaders(client), 'X-File-Name': encodeURIComponent(name) }, timeoutMs: PART_TIMEOUT_MS, signal }), signal);
    },
    chatFile(client, { channelId, attachmentId, signal = null }) {
      return partCall(() => http.getChatFile(`/api/v1/team/chat/attachments/${channelId}/${attachmentId}`,
        { headers: clientHeaders(client), timeoutMs: PART_TIMEOUT_MS, signal }), signal);
    },
    // Slice 6-5: one model part up (the sender's device) or down (the accepting device), with the same headers and
    // hello retry. A GET's 204 (no part yet after the host's wait) answers `{ ok: true, ready: false, wait: 'not_ready' }`.
    putModelPart(client, { transferId, index, n, bytes, signal = null }) {
      if (!modelPartOk(transferId, index, n)) return Promise.resolve(invalidRequest());
      return partCall(() => http.putPart(modelPartPath(transferId, index, n), bytes,
        { headers: clientHeaders(client), timeoutMs: MODEL_PART_TIMEOUT_MS, signal }), signal);
    },
    getModelPart(client, { transferId, index, n, signal = null }) {
      if (!modelPartOk(transferId, index, n)) return Promise.resolve(invalidRequest());
      return partCall(async () => {
        const got = await http.getPart(modelPartPath(transferId, index, n), { headers: clientHeaders(client),
          timeoutMs: MODEL_PART_TIMEOUT_MS, signal });
        return got.empty ? { json: { ok: true, ready: false, wait: 'not_ready' } } : got;
      }, signal);
    },
    // Last-Event-ID goes out only for a well-formed `<boot_epoch>:<cursor>`, the shape the host reads.
    openEvents(client, { lastEventId = null, ...streamOptions } = {}) {
      const headers = clientHeaders(client);
      if (typeof lastEventId === 'string' && LAST_EVENT_ID.test(lastEventId)) headers['Last-Event-ID'] = lastEventId;
      // onFrame, onProtocolError, idleTimeoutMs and timers go to the stream as they are.
      return http.openStream('/api/v1/events', headers, streamOptions);
    },
    // The team engine (slice 4b): raw streamed calls with the event stream's client
    // headers, the answer passed back as bytes. X-Engine-Key (the per-port affinity
    // value) goes out only in its 43-character shape. No hello retry: a refusal
    // reaches the caller as the host's own answer.
    engineChat(client, body, { engineKey, ...streamOptions } = {}) {
      return http.openRequestStream('POST', '/api/v1/team/engine/v1/chat/completions',
        { headTimeoutMs: ENGINE_HEAD_TIMEOUT_MS, ...streamOptions, body, headers: engineHeaders(client, engineKey) });
    },
    engineModels(client, { engineKey, ...streamOptions } = {}) {
      return http.openRequestStream('GET', '/api/v1/team/engine/v1/models',
        { ...streamOptions, headers: engineHeaders(client, engineKey) });
    },
  };
}

module.exports = { COMMAND_LIMITS, REQUEST_ID, createTeamSession, envelopeFields };
