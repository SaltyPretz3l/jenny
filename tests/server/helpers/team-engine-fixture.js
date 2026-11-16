'use strict';

// Shared pieces for the team engine route tests (slice 4b host core): a real
// pool composition with an injected clock, a real loopback HTTP server that
// builds the raw-route context the host's `assetRoutes` hook passes (actor and
// guard from the real authorizer over a team directory fixture, the host's own
// `retainResponseAdmission`), raw HTTP clients and a scripted node that claims
// and answers jobs in process. No sidecar, no model, no window.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { retainResponseAdmission } = require('../../../server/http-server');
const { createAuthorizer } = require('../../../server/team/authorize');
const { createEngineRoutes } = require('../../../server/team/engine-routes');
const { createPoolComposition } = require('../../../server/team/pool-composition');
const { createRouteGuard } = require('../../../server/team/route-guard');
const { USAGE_LOG_FILE, UsageLog } = require('../../../server/team/usage-log');
const { createClock, createLoggerSpy, model } = require('./team-pool-fixture');
const { createTeamDirectoryFixture } = require('./team-directory-fixture');

const CHAT_PATH = '/api/v1/team/engine/v1/chat/completions';
const MODELS_PATH = '/api/v1/team/engine/v1/models';
const DEVICES = Object.freeze({ owner: 'device_owner', member: 'device_a1', other: 'device_b1', read_only: 'device_ro',
  pending: 'device_pending', invite: 'invite_1', revoked: 'device_revoked' });

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(2);
  }
}

async function setupEngine(t, {
  nodes = [{ models: [model('alpha')] }], limits = {}, schedulerLimits, usageLog: makeUsage, sweepIntervalMs = 20,
  nullPool = false, mayUsePool = () => true,
} = {}) {
  const clock = createClock();
  const logger = createLoggerSpy();
  const pool = createPoolComposition({ contextLength: 32768, clock, logger, randomBytes: crypto.randomBytes, mayUsePool,
    limits: { sweepIntervalMs, ...(schedulerLimits ? { scheduler: schedulerLimits } : {}) } });
  await pool.start();
  const { scheduler } = pool;
  const nodeIds = nodes.map((spec, i) => {
    const result = scheduler.registerNode({ deviceId: `device_node${i}`, memberId: 'member_b',
      slots: spec.slots || 1, models: spec.models });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.node_id;
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-engine-'));
  const usageFile = path.join(dir, USAGE_LOG_FILE);
  const usageLog = makeUsage ? makeUsage({ usageFile, clock, logger }) : new UsageLog({ filePath: usageFile, clock, logger });
  const directory = createTeamDirectoryFixture();
  const { authorize } = createAuthorizer({ directory: directory.directory });
  const routes = createEngineRoutes({ pool: nullPool ? null : pool, usageLog, clock, logger,
    limits: { commentIntervalMs: 15, ...limits } });
  const responses = []; // every server-side response, in arrival order
  const events = [];
  scheduler.onChange((event) => { events.push(event); });
  const admission = { active: 0 };
  const guardCalls = [];
  const actorFor = (deviceId) => Object.values(directory.actors).find((actor) => actor.device_id === deviceId);
  const server = http.createServer((request, response) => {
    admission.active += 1;
    responses.push(response);
    const returned = retainResponseAdmission(response, () => { admission.active -= 1; }, 60_000);
    const actor = request.headers['x-test-actor'] === 'none' ? undefined : actorFor(request.headers['x-test-device']);
    const guardMode = request.headers['x-test-guard'];
    const real = createRouteGuard({ authorize, actor, requestId: 'req_1' });
    let guard = (action, resource) => { guardCalls.push({ action, resource }); return real(action, resource); };
    if (guardMode === 'none') guard = undefined;
    if (guardMode === 'throw') guard = () => { throw new Error('guard broke'); };
    const authorized = { false: () => false, throw: () => { throw new Error('binding broke'); }, absent: undefined,
      literal: true }[request.headers['x-test-authorized']];
    const context = { request, response, pathname: request.url, deviceId: actor?.device_id || '', clientId: 'client_1',
      authorized: request.headers['x-test-authorized'] ? authorized : () => true, security: {}, requestId: 'req_1',
      actor, guard };
    Promise.resolve(routes(context)).then((handled) => {
      if (!handled) { response.writeHead(404, { 'content-length': 0 }); response.end(); }
    }, () => response.destroy()).finally(returned);
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  t.after(async () => {
    await routes.stop();
    server.closeAllConnections();
    await new Promise((resolve) => { server.close(resolve); });
    await pool.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const usageRows = () => (fs.existsSync(usageFile) ? JSON.parse(fs.readFileSync(usageFile, 'utf8')).entries : []);
  return { clock, logger, pool, scheduler, nodeIds, routes, admission, guardCalls, directory, port, usageFile, usageRows,
    events, responses };
}

function headersFor(who, extra = {}) {
  return { 'x-test-device': DEVICES[who] || who, ...extra };
}

// One request; resolves with status, headers and text once the answer ends or is cut.
function send(port, { method = 'POST', path: urlPath = CHAT_PATH, headers = {}, body, declaredLength, holdBody = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(
      typeof body === 'string' ? body : JSON.stringify(body));
    const length = declaredLength ?? payload?.length;
    const request = http.request({ host: '127.0.0.1', port, method, path: urlPath, agent: false,
      headers: { ...(length !== undefined ? { 'content-type': 'application/json', 'content-length': length } : {}), ...headers },
    }, (response) => {
      const chunks = [];
      const done = (aborted) => resolve({ status: response.statusCode, headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8'), aborted });
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => done(false));
      response.on('aborted', () => done(true));
      response.on('error', () => done(true));
    });
    request.on('error', (error) => (holdBody ? resolve({ status: 0, error }) : reject(error)));
    if (holdBody) {
      // A route that waits to read the never-sent body gets no answer: fail fast instead of hanging.
      const bound = setTimeout(() => { resolve({ status: 0, text: '{"no_answer":true}', aborted: true }); request.destroy(); }, 3000);
      request.on('close', () => clearTimeout(bound));
      request.flushHeaders();
    }
    else if (payload) request.end(payload);
    else request.end();
  });
}

// A request whose body is sent in two parts: `finish()` sends the rest.
function openHeld(port, { headers = {}, body }) {
  const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  let request;
  const answer = new Promise((resolve) => {
    request = http.request({ host: '127.0.0.1', port, method: 'POST', path: CHAT_PATH, agent: false,
      headers: { 'content-type': 'application/json', 'content-length': payload.length, ...headers },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', () => resolve({ status: response.statusCode, text: '', aborted: true }));
    });
    request.on('error', () => resolve({ status: 0, text: '', aborted: true }));
  });
  const half = Math.floor(payload.length / 2);
  request.write(payload.subarray(0, half));
  return { answer, finish: () => request.end(payload.subarray(half)) };
}

// A streamed request whose answer is readable as it arrives; `paused` never reads the body.
function openStream(port, { headers = {}, body, paused = false }) {
  const payload = Buffer.from(JSON.stringify(body));
  const state = { status: 0, text: '', ended: false, aborted: false };
  const request = http.request({ host: '127.0.0.1', port, method: 'POST', path: CHAT_PATH, agent: false,
    headers: { 'content-type': 'application/json', 'content-length': payload.length, ...headers },
  }, (response) => {
    state.status = response.statusCode;
    state.headers = response.headers;
    response.on('close', () => { state.closed = true; });
    if (paused) { response.pause(); return; }
    response.on('data', (chunk) => { state.text += chunk.toString(); });
    response.on('end', () => { state.ended = true; });
    response.on('aborted', () => { state.aborted = true; });
    response.on('error', () => { state.aborted = true; });
  });
  request.on('error', () => { state.aborted = true; });
  request.end(payload);
  const until = (predicate, label) => waitFor(() => predicate(state), `${label}: ${JSON.stringify(state)}`);
  return { state, request, until };
}

// The scripted node: claims the queued job of the lease that matches, answers it chunk by chunk.
function createNode(scheduler, nodeId) {
  let claimSeq = 0;
  return {
    async claimNext(match = () => true) {
      let job = null;
      await waitFor(() => {
        job = scheduler.listJobs().find((j) => j.state === 'queued' && j.node_id === nodeId && match(j)) || null;
        return job !== null;
      }, 'a queued job');
      claimSeq += 1;
      const claim = scheduler.claim(nodeId, claimSeq);
      assert.equal(claim.job.job_id, job.job_id);
      const request = JSON.parse(scheduler.jobRequest(job.job_id, nodeId).request.toString('utf8'));
      let seq = 0;
      return {
        job: claim.job,
        fail(reason) { return scheduler.failJob(job.job_id, nodeId, reason); },
        request,
        send(bytes, final = false) {
          const result = scheduler.acceptChunk(job.job_id, nodeId, seq, Buffer.from(bytes), final);
          seq += 1;
          return result;
        },
      };
    },
  };
}

const sse = (value) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const delta = (content) => sse({ choices: [{ index: 0, delta: { content } }] });
const usageChunk = (prompt, completion) => sse({ choices: [],
  usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: 0 } } });
const chatBody = (extra = {}) => ({ model: 'alpha', stream: true, stream_options: { include_usage: true },
  messages: [{ role: 'user', content: 'hello' }], ...extra });

function engineError(text) {
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed), ['error']);
  assert.deepEqual(Object.keys(parsed.error).sort(), ['code', 'message', 'type']);
  assert.equal(parsed.error.type, 'team_engine_error');
  assert.equal(parsed.error.message, parsed.error.code);
  return parsed.error.code;
}

// The error frame an SSE answer carries after its head, if any.
function sseErrorCode(text) {
  const line = text.split('\n').find((l) => l.startsWith('data: {"error"'));
  return line ? engineError(line.slice(6)) : null;
}

module.exports = {
  CHAT_PATH, DEVICES, DONE, MODELS_PATH, chatBody, createNode, delta, engineError, headersFor, model, openHeld, openStream,
  send, setupEngine, sleep, sse, sseErrorCode, usageChunk, waitFor,
};
