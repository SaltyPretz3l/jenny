'use strict';

// The node agent's calls to the team host (row 123 slice 4c agent), made over one
// member link: `http` is a team HTTP client (http-client.js `createTeamHttp`, or one
// with its `openRequestStream`) and `client()` answers the registered client
// `{ client_id, client_token, boot_epoch }`. Every call has its own timeout (a claim
// waits 25 s at the host, longer than the client's default request timeout) and an
// abort signal that ends it at once, before or after the answer's head. A call with no
// readable answer throws (`reset: true`): the agent asks again under the same number.
// The request bytes are handed back as received, never parsed. Nothing here logs.

const crypto = require('node:crypto');
const { HOST_ERROR_CODES } = require('../../backend/error-codes');
const { MAX_STREAM_REQUEST_BYTES: MAX_REQUEST_BYTES } = require('../http-client');

const API_VERSION = 1;
const ANSWER_MAX_BYTES = 64 * 1024;
const JOB_ID = /^job_[A-Za-z0-9_-]{1,128}$/u;

// A waiting call's timers never keep the process alive after a quit without dispose().
const UNREF_TIMERS = Object.freeze({
  setTimeout(fn, ms) { const handle = setTimeout(fn, ms); handle.unref?.(); return handle; },
  clearTimeout: (handle) => clearTimeout(handle),
});

function lost(reason) {
  return Object.assign(new Error(reason), { reason, reset: true });
}

// The answer body, at most `max` bytes ({ tooLarge: true } past it); an abort closes it.
function readAnswer(handle, max, signal) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    let done = false;
    const end = (error, value) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      if (error || value?.tooLarge) handle.close();
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => end(lost('team_request_aborted'));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    handle.body.on('data', (part) => {
      size += part.length;
      if (size > max) { end(null, { tooLarge: true }); return; }
      parts.push(part);
    });
    handle.body.on('end', () => end(null, { bytes: Buffer.concat(parts, size) }));
    handle.body.on('error', () => end(lost('team_connection_reset')));
    handle.body.on('close', () => end(lost('team_connection_reset')));
  });
}

function jsonOf(bytes) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch (_error) { value = null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw lost('team_response_invalid');
  return value;
}

const tooLarge = () => ({ ok: false, error: { code: HOST_ERROR_CODES.INVALID, reason: 'job_request_too_large', retryable: false } });

// `hello()` (optional) answers the host's hello; a command refused with
// team_hello_required is sent once more after it, as team-session.js does.
function createNodeLink({ http, client, hello = null }) {
  if (!http || typeof http.openRequestStream !== 'function') throw new TypeError('The node link needs a team HTTP client.');
  if (typeof client !== 'function') throw new TypeError('The node link needs the registered client.');

  function current() {
    const value = client();
    if (!value || typeof value.client_id !== 'string' || typeof value.client_token !== 'string') {
      throw lost('team_client_missing');
    }
    return value;
  }

  async function exchange(method, path, { body, headers, timeoutMs, signal, max = ANSWER_MAX_BYTES }) {
    const handle = await http.openRequestStream(method, path, { body, headers, headTimeoutMs: timeoutMs,
      idleTimeoutMs: timeoutMs, signal, timers: UNREF_TIMERS });
    const read = await readAnswer(handle, max, signal);
    return { status: handle.status, ...read };
  }

  async function commandOnce(operation, params, { timeoutMs, signal }) {
    const used = current();
    const body = Buffer.from(JSON.stringify({ api_version: API_VERSION, operation, request_id: crypto.randomUUID(),
      client_id: used.client_id, boot_epoch: used.boot_epoch, params }));
    const answer = await exchange('POST', '/api/v1/commands', { body, headers: { 'X-Client-Token': used.client_token },
      timeoutMs, signal });
    if (answer.tooLarge) throw lost('team_response_too_large');
    return jsonOf(answer.bytes);
  }

  const routeHeaders = (used, extra = {}) => ({ ...extra, 'X-Client-Id': used.client_id, 'X-Client-Token': used.client_token });

  return {
    async command(operation, params, { timeoutMs = 15_000, signal = null } = {}) {
      const answer = await commandOnce(operation, params, { timeoutMs, signal });
      if (typeof hello !== 'function' || answer?.error?.reason !== 'team_hello_required') return answer;
      const again = await hello();
      return again?.ok === true ? commandOnce(operation, params, { timeoutMs, signal }) : answer;
    },
    // { ok: true, bytes } with the request as the host holds it, or the host's refusal.
    async fetchRequest(jobId, { maxBytes = MAX_REQUEST_BYTES, timeoutMs = 15_000, signal = null } = {}) {
      if (!JOB_ID.test(String(jobId))) throw lost('team_path_invalid');
      const max = Math.min(maxBytes, MAX_REQUEST_BYTES);
      const answer = await exchange('GET', `/api/v1/team/node/jobs/${jobId}/request`,
        { headers: routeHeaders(current()), timeoutMs, signal, max: Math.max(max, ANSWER_MAX_BYTES) });
      if (answer.tooLarge) return tooLarge();
      if (answer.status === 200) return answer.bytes.length > max ? tooLarge() : { ok: true, bytes: answer.bytes };
      return jsonOf(answer.bytes);
    },
    // One chunk: an empty `bytes` is a ping; the answer is the host's { ok, next_seq, cancel } or refusal.
    async postChunk(jobId, { seq, final, bytes, timeoutMs = 15_000, signal = null }) {
      if (!JOB_ID.test(String(jobId))) throw lost('team_path_invalid');
      const headers = routeHeaders(current(), { 'X-Chunk-Seq': String(seq), 'X-Chunk-Final': final ? '1' : '0' });
      const answer = await exchange('POST', `/api/v1/team/node/jobs/${jobId}/chunks`, { body: bytes, headers, timeoutMs, signal });
      if (answer.tooLarge) throw lost('team_response_too_large');
      return jsonOf(answer.bytes);
    },
  };
}

module.exports = { JOB_ID, createNodeLink };
