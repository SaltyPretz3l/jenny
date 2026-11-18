'use strict';

// Row 176: serving detection for background jobs. A live job that printed a
// loopback address (http://localhost:5173/) which also answers a TCP connect
// is "serving"; the session rail lists it under Servers. The tracker calls
// `check(job)` from its existing poll, so there is no timer of its own.
// The job's live output is untrusted data: it only ever yields a loopback
// host and a port number, never a path, and nothing but loopback is probed.

const path = require('path');
const { isPortOpen } = require('../backend/process-utils');
const { readLiveOutput } = require('./background-job-output');

const MAX_SCAN_CHARS = 64 * 1024;
const MISSES_TO_CLEAR = 2;
// Loopback only, with an explicit port (a bare "http://localhost" would mean whatever answers on 80). The
// lookahead refuses a longer host (localhost.evil.com), userinfo (@) and a port with trailing digits.
const ADDRESS_PATTERN = /https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d{1,6})(?![\w@-]|\.\w|:\d)/gi;
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g; // eslint-disable-line no-control-regex

// The last loopback address in `text`, or null. Pure.
function findLoopbackAddress(text) {
  if (typeof text !== 'string' || !text) return null;
  const scan = text.slice(-MAX_SCAN_CHARS).replace(ANSI_PATTERN, '');
  let found = null;
  for (const match of scan.matchAll(ADDRESS_PATTERN)) {
    const scheme = match[0].slice(0, match[0].indexOf(':')).toLowerCase();
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const name = match[1].toLowerCase();
    const ipv6 = name === '[::1]';
    // "localhost" may be bound on IPv6 only (Node 17+ resolves it to ::1 first), so it is probed on both.
    const hosts = ipv6 ? ['::1'] : (name === 'localhost' ? ['127.0.0.1', '::1'] : ['127.0.0.1']);
    found = { url: `${scheme}://${ipv6 ? '[::1]' : 'localhost'}:${port}`, hosts, port };
  }
  return found;
}

const isLiveJob = (job) => job.state === 'running' || job.state === 'killing';

function createServingWatcher({
  probeImpl = isPortOpen,
  readLiveOutputImpl = readLiveOutput,
  nowImpl = Date.now,
  onChange = () => {},
  minIntervalMs = 5000,
  log = () => {},
} = {}) {
  /** @type {Map<string, {inFlight: boolean, lastStartMs: number|null, misses: number}>} */
  const states = new Map();
  let disposed = false;

  function notify(job) {
    try {
      onChange(job);
    } catch (error) {
      log('WARN', 'background_jobs.serving_change_failed', { message: String((error && error.message) || error) });
    }
  }

  function miss(job, state) {
    if (!job.serving) return;
    state.misses += 1;
    if (state.misses >= MISSES_TO_CLEAR) {
      job.serving = null;
      state.misses = 0;
      notify(job);
    }
  }

  // `hit` is { address, host } for the first candidate that answered, or null.
  function settle(job, state, hit) {
    if (disposed || states.get(job.jobId) !== state || !isLiveJob(job)) return;
    state.inFlight = false;
    if (!hit) {
      miss(job, state);
      return;
    }
    state.misses = 0;
    if (job.serving && job.serving.url === hit.address.url) {
      job.serving.host = hit.host;
      return;
    }
    job.serving = { url: hit.address.url, host: hit.host, port: hit.address.port, sinceMs: nowImpl() };
    notify(job);
  }

  // The first candidate address and host that answers, in order; null when none does.
  async function probeAny(candidates) {
    for (const address of candidates) {
      for (const host of address.hosts) {
        try {
          if ((await probeImpl(address.port, host)) === true) return { address, host };
        } catch (_error) { /* the next host */ }
      }
    }
    return null;
  }

  function check(job) {
    try {
      if (disposed || !job || typeof job.jobId !== 'string' || !job.statusPath || !isLiveJob(job)) return;
      let state = states.get(job.jobId);
      if (!state) {
        state = { inFlight: false, lastStartMs: null, misses: 0 };
        states.set(job.jobId, state);
      }
      const now = nowImpl();
      if (state.inFlight || (state.lastStartMs !== null && now - state.lastStartMs < minIntervalMs)) return;
      state.lastStartMs = now;
      const live = readLiveOutputImpl(path.join(path.dirname(job.statusPath), 'live-output.json'), { jobId: job.jobId });
      // No readable live file this time (not written yet, or mid-replace): neither a hit nor a miss.
      if (!live || typeof live.text !== 'string') return;
      // The newest printed address first, then the one it already answered on: a busy server's log pushes its
      // startup line out of the capped tail, and a later line can name another port that is not this job's
      // server. Only two failed rounds in a row clear it.
      const known = job.serving && typeof job.serving.url === 'string'
        ? { url: job.serving.url, hosts: [job.serving.host], port: job.serving.port } : null;
      const newest = findLoopbackAddress(live.text);
      const candidates = [newest, known && known.url !== newest?.url ? known : null].filter(Boolean);
      if (!candidates.length) return;
      state.inFlight = true;
      probeAny(candidates)
        .then((hit) => settle(job, state, hit))
        .catch(() => {});
    } catch (error) {
      log('WARN', 'background_jobs.serving_check_failed', { message: String((error && error.message) || error) });
    }
  }

  return {
    check,
    forget: (jobId) => { states.delete(jobId); },
    dispose: () => { disposed = true; states.clear(); },
  };
}

module.exports = {
  findLoopbackAddress,
  createServingWatcher,
};
