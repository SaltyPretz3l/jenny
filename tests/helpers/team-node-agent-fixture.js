'use strict';

// Shared set-up for the node agent tests (row 123 slice 4c agent): manual timers the
// agent is handed (real sockets keep working), a fake team host behind the agent's
// link (claims with replay by claim_seq, request reads, chunks with sequence numbers
// and cancel), and a scripted SSE engine on a real loopback socket. No team host, no
// GPU, no model, no window.

const http = require('node:http');

const MARKER = 'MARKER_node_secret_text_5c1d';
const sse = (text) => Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
const DONE = Buffer.from('data: [DONE]\n\n');
const requestBody = (extra = '') => Buffer.from(JSON.stringify({ model: 'alpha', stream: true,
  messages: [{ role: 'user', content: `${MARKER}${extra}` }] }));

// Yields to the event loop until `predicate` holds.
async function until(predicate, label, rounds = 4000) {
  for (let i = 0; i < rounds; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => { setImmediate(resolve); });
  }
  throw new Error(`not reached: ${label}`);
}

const flush = async (rounds = 3) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

// Timers under the test's hand: `advance(ms)` runs every timer due, in order, and lets
// the event loop turn after each one.
function createManualTimers(start = 1_000_000) {
  let now = start;
  let counter = 0;
  const pending = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      counter += 1;
      const handle = { id: counter, unref() { return handle; }, ref() { return handle; } };
      pending.set(counter, { at: now + Math.max(0, Math.trunc(Number(ms) || 0)), fn });
      return handle;
    },
    clearTimeout(handle) { if (handle) pending.delete(handle.id); },
    pending: () => pending.size,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, timer] of pending) if (timer.at <= end && (!next || timer.at < next[1].at)) next = [id, timer];
        if (!next) break;
        pending.delete(next[0]);
        now = Math.max(now, next[1].at);
        next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

const failure = (code, reason) => ({ ok: false, error: { code, reason, retryable: false } });
const reset = () => Object.assign(new Error('team_connection_reset'), { reset: true });

// The host as the agent's link sees it. `script[operation]` holds answers (or functions
// of params, or 'reset' to throw a lost answer after the effect) used before the
// default behaviour.
function createFakeHost({ timers, heartbeatMs = 10_000, expiresMs = 30_000 }) {
  const calls = [];
  const chunks = [];
  const jobs = new Map();
  const queue = [];
  const claims = new Map();
  const waiting = new Set();
  const script = {};
  let gate = null; // while set, every chunk answer waits for it
  let inflight = 0;
  let counter = 0;
  let node = null;

  const track = async (work) => { inflight += 1; try { return await work(); } finally { inflight -= 1; } };
  const scripted = (operation, params) => {
    const list = script[operation];
    if (!list || list.length === 0) return undefined;
    const entry = list.shift();
    return typeof entry === 'function' ? entry(params) : entry;
  };
  const aborted = (signal) => Object.assign(new Error('aborted'), { reset: true, aborted: signal?.aborted === true });

  function takeJob(seq) {
    if (claims.has(seq)) return jobs.get(claims.get(seq)).descriptor;
    const job = queue.shift();
    if (!job) return null;
    job.state = 'claimed';
    claims.set(seq, job.descriptor.job_id);
    return job.descriptor;
  }

  function claim(params, signal) {
    const job = takeJob(params.claim_seq);
    if (job || params.wait_ms === 0) return Promise.resolve({ ok: true, job });
    return new Promise((resolve, reject) => {
      const waiter = {};
      const done = (value, error) => {
        if (!waiting.delete(waiter)) return;
        timers.clearTimeout(waiter.timer);
        signal?.removeEventListener('abort', waiter.abort);
        if (error) reject(error); else resolve(value);
      };
      waiter.wake = () => done({ ok: true, job: takeJob(params.claim_seq) });
      waiter.abort = () => done(null, aborted(signal));
      waiter.timer = timers.setTimeout(() => done({ ok: true, job: null }), params.wait_ms);
      signal?.addEventListener('abort', waiter.abort, { once: true });
      waiting.add(waiter);
    });
  }

  const link = {
    command(operation, params, { signal = null } = {}) {
      return track(async () => {
        calls.push({ operation, params, at: timers.now() });
        if (signal?.aborted) throw aborted(signal);
        const answer = scripted(operation, params);
        if (answer === 'reset') {
          if (operation === 'team.node.claim') takeJob(params.claim_seq);
          throw reset();
        }
        if (answer !== undefined) return answer;
        switch (operation) {
          case 'team.node.register':
            if (params.protocol_version !== 1) return failure('CMP-HOST-0004', 'node_version_mismatch');
            node = node || `node_${counter += 1}`;
            return { ok: true, node_id: node, heartbeat_ms: heartbeatMs, expires_ms: expiresMs };
          case 'team.node.claim': return claim(params, signal);
          case 'team.node.fail': {
            const job = jobs.get(params.job_id);
            if (!job || !['claimed', 'streaming'].includes(job.state)) return failure('CMP-HOST-0003', 'job_not_found');
            Object.assign(job, { state: 'failed', reason: params.reason });
            return { ok: true };
          }
          case 'team.node.pause': return { ok: true, node: { node_id: node, paused: params.on } };
          case 'team.node.unregister': node = null; return { ok: true };
          default: return failure('CMP-HOST-0001', 'unsupported_operation');
        }
      });
    },
    fetchRequest(jobId, { maxBytes, signal = null } = {}) {
      return track(async () => {
        calls.push({ operation: 'request', jobId, at: timers.now() });
        if (signal?.aborted) throw aborted(signal);
        const answer = scripted('request', { jobId });
        if (answer === 'reset') throw reset();
        if (answer !== undefined) return answer;
        const job = jobs.get(jobId);
        if (!job || job.state !== 'claimed') return failure('CMP-HOST-0003', 'job_not_found');
        if (job.request.length > maxBytes) return failure('CMP-HOST-0001', 'job_request_too_large');
        return { ok: true, bytes: Buffer.from(job.request) };
      });
    },
    postChunk(jobId, { seq, final, bytes, signal = null }) {
      return track(async () => {
        chunks.push({ jobId, seq, final, bytes: Buffer.from(bytes), at: timers.now() });
        if (gate) await gate;
        if (signal?.aborted) throw aborted(signal);
        const answer = scripted('chunk', { jobId, seq, final });
        if (answer === 'reset') throw reset();
        if (answer !== undefined) return answer;
        const job = jobs.get(jobId);
        if (!job || !['claimed', 'streaming', 'cancelled'].includes(job.state)) return failure('CMP-HOST-0003', 'job_not_found');
        if (job.state === 'cancelled') return { ok: true, next_seq: job.nextSeq, cancel: true };
        if (seq !== job.nextSeq) return { ...failure('CMP-HOST-0001', 'node_chunk_seq_invalid'), next_seq: job.nextSeq };
        job.nextSeq += 1;
        if (bytes.length > 0) { job.state = 'streaming'; job.received.push(Buffer.from(bytes)); }
        if (final) job.state = 'done';
        return { ok: true, next_seq: job.nextSeq, cancel: false };
      });
    },
  };

  return {
    link, calls, chunks, jobs, script,
    inflight: () => inflight,
    waiting: () => waiting.size,
    node: () => node,
    of: (operation) => calls.filter((call) => call.operation === operation),
    // A job queued for this node; wakes a waiting claim.
    queueJob(request = requestBody(), overrides = {}) {
      counter += 1;
      const descriptor = { job_id: `job_${counter}`, lease_id: `lease_${counter}`, model: 'alpha',
        request_bytes: request.length, first_byte_ms: 120_000, stall_ms: 60_000, total_ms: 1_800_000, ...overrides };
      const job = { descriptor, request, state: 'queued', nextSeq: 0, received: [] };
      jobs.set(descriptor.job_id, job);
      queue.push(job);
      for (const waiter of [...waiting]) waiter.wake();
      return job;
    },
    cancel(jobId) { jobs.get(jobId).state = 'cancelled'; },
    hold() { let open; gate = new Promise((resolve) => { open = resolve; }); return () => { gate = null; open(); }; },
  };
}

// A scripted engine on 127.0.0.1. `handle(req, res, body)` answers each chat request;
// every request is recorded with its headers, body and whether its socket closed early.
async function startEngine(t, { models = ['alpha'] } = {}) {
  const requests = [];
  const sockets = new Set();
  const engine = { requests, handle: (req, res) => { res.writeHead(200); res.end(Buffer.concat([sse('ok'), DONE])); } };
  const server = http.createServer((req, res) => {
    const parts = [];
    const record = { method: req.method, url: req.url, headers: { ...req.headers }, body: null, closedEarly: false };
    requests.push(record);
    res.on('close', () => { if (!res.writableFinished) record.closedEarly = true; });
    req.on('data', (part) => parts.push(part));
    req.on('end', () => {
      record.body = Buffer.concat(parts);
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model' })) }));
        return;
      }
      engine.handle(req, res, record.body);
    });
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  engine.url = `http://127.0.0.1:${server.address().port}`;
  engine.openSockets = () => sockets.size;
  engine.chats = () => requests.filter((request) => request.url === '/v1/chat/completions');
  t.after(() => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }));
  return engine;
}

function createLogs() {
  const lines = [];
  return { lines, logger: (level, event, fields) => { lines.push({ level, event, fields }); }, text: () => JSON.stringify(lines) };
}

module.exports = { DONE, MARKER, createFakeHost, createLogs, createManualTimers, failure, flush, requestBody, sse, startEngine,
  until };
