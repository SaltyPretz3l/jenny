'use strict';

// new-test-file: a new surface (serving detection for background jobs); the tracker wiring cases live here
// because tests/background-job-tracker.test.js is near its 600-line cap.
// Row 176: a loopback address a background job printed that answers a TCP probe.

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { findLoopbackAddress, createServingWatcher } = require('../services/main/background-job-serving');
const { createBackgroundJobTracker } = require('../services/main/background-job-tracker');

const flush = () => new Promise((resolve) => setImmediate(resolve));
const ESC = '\u001b';

test('findLoopbackAddress reads the dev-server banners people actually see', () => {
  const vite = `  ${ESC}[32m➜${ESC}[39m  ${ESC}[1mLocal${ESC}[22m:   ${ESC}[36mhttp://localhost:${ESC}[1m5173${ESC}[22m/${ESC}[39m`;
  assert.deepEqual(findLoopbackAddress(vite), { url: 'http://localhost:5173', hosts: ['127.0.0.1', '::1'], port: 5173 });
  assert.deepEqual(findLoopbackAddress(`┃ Local    ${ESC}[36mhttp://localhost:4321/${ESC}[39m\n`), { url: 'http://localhost:4321', hosts: ['127.0.0.1', '::1'], port: 4321 });
  assert.deepEqual(findLoopbackAddress('   - Local:        http://localhost:3000\n'), { url: 'http://localhost:3000', hosts: ['127.0.0.1', '::1'], port: 3000 });
  assert.deepEqual(
    findLoopbackAddress('Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...'),
    { url: 'http://localhost:8000', hosts: ['127.0.0.1'], port: 8000 },
  );
  assert.deepEqual(findLoopbackAddress('listening on https://127.0.0.1:8443/app?x=1'), { url: 'https://localhost:8443', hosts: ['127.0.0.1'], port: 8443 });
  assert.deepEqual(findLoopbackAddress('at http://[::1]:5000/'), { url: 'http://[::1]:5000', hosts: ['::1'], port: 5000 });
  assert.deepEqual(findLoopbackAddress('http://LOCALHOST:8080'), { url: 'http://localhost:8080', hosts: ['127.0.0.1', '::1'], port: 8080 });
  assert.equal(findLoopbackAddress('https://localhost'), null, 'no explicit port: nothing (it would mean whatever answers on 443)');
  assert.equal(findLoopbackAddress('see http://localhost:/x'), null, 'a dangling colon is not port 80');
});

test('findLoopbackAddress takes the last valid match and never a non-loopback host', () => {
  assert.equal(findLoopbackAddress('http://localhost:3000\nrestarted http://localhost:3001/\n').port, 3001);
  assert.equal(findLoopbackAddress('http://localhost:3000\nhttp://localhost:0\nhttp://localhost:70000\n').port, 3000, 'invalid ports are skipped');
  assert.equal(findLoopbackAddress('http://localhost:0'), null);
  assert.equal(findLoopbackAddress('http://localhost:70000'), null);
  assert.equal(findLoopbackAddress('Network: http://192.168.1.4:5173/'), null);
  assert.equal(findLoopbackAddress('http://example.com:80 and http://10.0.0.2:3000'), null);
  assert.equal(findLoopbackAddress('http://localhost.evil.com:3000/'), null);
  assert.equal(findLoopbackAddress('http://127.0.0.1.nip.io:3000/'), null);
  assert.equal(findLoopbackAddress('http://localhost:3000@evil.com/'), null);
  assert.equal(findLoopbackAddress('http://localhost:123456'), null);
  assert.equal(findLoopbackAddress('no address here'), null);
  assert.equal(findLoopbackAddress(null), null);
  assert.equal(findLoopbackAddress('Local: http://localhost:3000/ and Network: http://192.168.1.4:3000/').port, 3000, 'a LAN line after it does not hide the loopback one');
});

test('findLoopbackAddress looks only at the last 64 KiB', () => {
  const old = `http://localhost:3000\n${'x'.repeat(70_000)}`;
  assert.equal(findLoopbackAddress(old), null);
  assert.equal(findLoopbackAddress(`${old}\nhttp://localhost:3001`).port, 3001);
});

function makeWatcher(overrides = {}) {
  const state = { now: 10_000, probes: [], changes: [], reads: [], text: 'Local: http://localhost:5173/', answer: true };
  const watcher = createServingWatcher({
    probeImpl: overrides.probeImpl || (async (port, host) => { state.probes.push({ port, host }); return state.answer; }),
    readLiveOutputImpl: overrides.readLiveOutputImpl || ((livePath, options) => {
      state.reads.push({ livePath, jobId: options.jobId });
      return state.text === null ? null : { text: state.text, truncated: false };
    }),
    nowImpl: () => state.now,
    onChange: (job) => state.changes.push({ url: job.serving ? job.serving.url : null }),
    minIntervalMs: 5000,
  });
  const job = { jobId: 'abc123def456', state: 'running', statusPath: path.join('C:', 'ws', '.jenny', 'tool-results', 'abc123def456', 'status.json'), serving: null };
  return { state, watcher, job };
}

test('watcher: a successful probe sets serving and notifies once; a repeat success is silent', async () => {
  const { state, watcher, job } = makeWatcher();
  watcher.check(job);
  await flush();
  assert.equal(job.serving.url, 'http://localhost:5173');
  assert.equal(job.serving.port, 5173);
  assert.equal(job.serving.host, '127.0.0.1');
  assert.equal(job.serving.sinceMs, 10_000);
  assert.deepEqual(state.probes, [{ port: 5173, host: '127.0.0.1' }]);
  assert.deepEqual(state.reads, [{ livePath: path.join(path.dirname(job.statusPath), 'live-output.json'), jobId: job.jobId }]);
  assert.equal(state.changes.length, 1);

  state.now += 5000;
  watcher.check(job);
  await flush();
  assert.equal(state.probes.length, 2);
  assert.equal(state.changes.length, 1, 'same url again: no second notification');
  assert.equal(job.serving.sinceMs, 10_000, 'sinceMs survives later successes');
});

test('watcher: one miss keeps serving, two in a row clear it', async () => {
  const { state, watcher, job } = makeWatcher();
  watcher.check(job);
  await flush();
  state.answer = false;
  state.now += 5000;
  watcher.check(job);
  await flush();
  assert.ok(job.serving, 'one miss keeps it');
  state.answer = true;
  state.now += 5000;
  watcher.check(job);
  await flush();
  state.answer = false;
  state.now += 5000;
  watcher.check(job);
  await flush();
  assert.ok(job.serving, 'a success between misses resets the count');
  state.now += 5000;
  watcher.check(job);
  await flush();
  assert.equal(job.serving, null);
  assert.deepEqual(state.changes, [{ url: 'http://localhost:5173' }, { url: null }]);
});

test('watcher: once the address scrolls out of the output, the known address is probed again', async () => {
  const { state, watcher, job } = makeWatcher();
  watcher.check(job);
  await flush();
  state.text = 'GET /settings 200 18ms';
  state.now += 5000;
  watcher.check(job);
  await flush();
  assert.equal(job.serving.url, 'http://localhost:5173', 'still answering: kept');
  assert.deepEqual(state.probes.at(-1), { port: 5173, host: '127.0.0.1' }, 'probed on the host that answered');
  state.answer = false;
  for (let i = 0; i < 2; i += 1) {
    state.now += 5000;
    watcher.check(job);
    await flush();
  }
  assert.equal(job.serving, null, 'two failed probes clear it');
  const before = state.probes.length;
  state.now += 5000;
  watcher.check(job);
  await flush();
  assert.equal(state.probes.length, before, 'nothing to probe once no address is known');
});

test('watcher: a newer address that does not answer leaves the server it already found', async () => {
  const { state, watcher, job } = makeWatcher({
    probeImpl: async (port, host) => { state.probes.push({ port, host }); return port === 5173; },
  });
  watcher.check(job);
  await flush();
  assert.equal(job.serving.url, 'http://localhost:5173');
  state.text += '\nproxying /api to http://localhost:4000';
  for (let i = 0; i < 3; i += 1) {
    state.now += 5000;
    watcher.check(job);
    await flush();
  }
  assert.equal(job.serving.url, 'http://localhost:5173', 'still answering on 5173: kept');
  assert.equal(state.changes.length, 1);
});

test('watcher: localhost bound on IPv6 only is found on ::1', async () => {
  const { state, watcher, job } = makeWatcher({
    probeImpl: async (port, host) => { state.probes.push({ port, host }); return host === '::1'; },
  });
  watcher.check(job);
  await flush();
  assert.deepEqual(state.probes, [{ port: 5173, host: '127.0.0.1' }, { port: 5173, host: '::1' }]);
  assert.equal(job.serving.host, '::1');
  assert.equal(job.serving.url, 'http://localhost:5173');
});

test('watcher: no probe sooner than minIntervalMs and never two in flight', async () => {
  let release;
  let calls = 0;
  const { state, watcher, job } = makeWatcher({ probeImpl: () => { calls += 1; return new Promise((resolve) => { release = resolve; }); } });
  watcher.check(job);
  watcher.check(job);
  state.now += 1000;
  watcher.check(job);
  assert.equal(calls, 1, 'a probe still in flight blocks another');
  release(true);
  await flush();
  assert.equal(job.serving.url, 'http://localhost:5173');
  watcher.check(job);
  await flush();
  assert.equal(calls, 1, 'inside the interval');
  state.now += 4000;
  watcher.check(job);
  await flush();
  assert.equal(calls, 2);
});

test('watcher: a probe that resolves after forget, dispose or the job settling changes nothing', async () => {
  for (const how of ['forget', 'dispose', 'settled']) {
    let release;
    const { state, watcher, job } = makeWatcher({ probeImpl: () => new Promise((resolve) => { release = resolve; }) });
    watcher.check(job);
    if (how === 'forget') watcher.forget(job.jobId);
    else if (how === 'dispose') watcher.dispose();
    else job.state = 'completed';
    release(true);
    await flush();
    assert.equal(job.serving, null, how);
    assert.equal(state.changes.length, 0, how);
  }
});

test('watcher: check never throws and ignores an unreadable live file', async () => {
  const throwing = makeWatcher({ readLiveOutputImpl: () => { throw new Error('boom'); } });
  assert.doesNotThrow(() => throwing.watcher.check(throwing.job));
  assert.doesNotThrow(() => throwing.watcher.check(null));
  const missing = makeWatcher();
  missing.state.text = null;
  missing.watcher.check(missing.job);
  await flush();
  assert.equal(missing.state.probes.length, 0);
});

function makeTrackerHarness(t, { text, answer = true }) {
  const events = [];
  const changed = [];
  const probes = [];
  const statuses = new Map();
  let now = 1_000_000;
  const statusPath = 'C:\\ws\\.jenny\\tool-results\\abc123def456\\status.json';
  statuses.set(statusPath, { job_id: 'abc123def456', state: 'running' });
  const tracker = createBackgroundJobTracker({
    getWorkspaceRoot: () => 'C:\\ws',
    sendBridgeEvent: (name, payload) => events.push({ name, payload }),
    readStatusFileImpl: (p) => (statuses.has(p) ? { ok: true, text: JSON.stringify(statuses.get(p)) } : { ok: false, reason: 'not_found' }),
    readProgressFileImpl: () => null,
    readLiveOutputImpl: () => ({ text, truncated: false }),
    probePortImpl: async (port, host) => { probes.push({ port, host }); return answer; },
    isPidAliveImpl: () => true,
    getProcessStartTimeImpl: () => 'gen-1',
    nowImpl: () => now,
    pollIntervalMs: 3_600_000,
  });
  t.after(() => tracker.dispose());
  tracker.onChanged((ids) => changed.push(ids));
  return { tracker, events, changed, probes, statuses, statusPath, advance: (ms) => { now += ms; } };
}

test('tracker: a live job that printed a loopback address and answers a probe is serving in getState', async (t) => {
  const h = makeTrackerHarness(t, { text: '  Local: http://localhost:5173/\n' });
  assert.equal(h.tracker.registerJob({ jobId: 'abc123def456', sessionId: 's1', command: 'npm run dev', pid: 4242 }), true);
  assert.equal(h.tracker.getState().jobs[0].serving, null);
  h.changed.length = 0;
  h.tracker.pollNow();
  await flush();
  const serving = h.tracker.getState().jobs[0].serving;
  assert.deepEqual({ url: serving.url, host: serving.host, port: serving.port }, { url: 'http://localhost:5173', host: '127.0.0.1', port: 5173 });
  assert.equal(serving.sinceMs, 1_000_000);
  assert.deepEqual(h.changed, [['s1']], 'one onChanged push for the serving change');
  assert.equal(h.events.at(-1).name, 'backgroundJobs.onChanged');
  assert.equal(h.events.at(-1).payload.jobs[0].serving.port, 5173);
  assert.notEqual(h.tracker.getState().jobs[0].serving, h.tracker.getState().jobs[0].serving, 'snapshots copy the serving record');

  h.statuses.set(h.statusPath, { job_id: 'abc123def456', state: 'completed', exit_code: 0 });
  h.advance(5000);
  h.tracker.pollNow();
  await flush();
  const settled = h.tracker.getState().jobs[0];
  assert.equal(settled.state, 'completed');
  assert.equal(settled.serving, null);
});

test('tracker: a probe that is refused leaves the job not serving', async (t) => {
  const h = makeTrackerHarness(t, { text: 'http://localhost:5173/', answer: false });
  h.tracker.registerJob({ jobId: 'abc123def456', sessionId: 's1', command: 'x', pid: 4242 });
  h.tracker.pollNow();
  await flush();
  assert.equal(h.probes.length, 2, 'localhost is tried on 127.0.0.1 and ::1');
  assert.equal(h.tracker.getState().jobs[0].serving, null);
});
