'use strict';

// The project files state on the parent channel (row 123, the team host file tools plan, slice 3). The
// host child tells the desktop `file_tools { on, available, reason, turns }`: whether this host started with the root
// boundary (team.file_tools), whether the sidecar's worker reported its file tools started, the worker's reason word
// when not, and how many turns run now (the desktop refuses a change that would restart the host mid-turn). Sent when
// the host is ready unless it is the idle state, and whenever any field moved since, read on one unref'd timer every
// `periodMs`. Counts and
// closed words only: no path, member, conversation or file name.

const PERIOD_MS = 1000;
const TIMERS = Object.freeze({ setInterval, clearInterval });
const REASON = /^file_access_[a-z_]{1,48}$/u;
const MAX_TURNS = 64;

/** The state as the desktop receives it, from the hosted backend. */
function fileToolsState(backend) {
  const on = typeof backend?.hostRootBoundary === 'string' && backend.hostRootBoundary.length > 0;
  const report = backend?.currentStatus?.hosted_files;
  const reason = report && typeof report.reason === 'string' && REASON.test(report.reason) ? report.reason : null;
  const available = on && report?.available === true && reason === null;
  const size = Number(backend?.activeStreams?.size);
  const turns = Number.isSafeInteger(size) && size > 0 ? Math.min(size, MAX_TURNS) : 0;
  return { on, available, reason: on && !available ? reason : null, turns };
}

/** backend(): the hosted backend, or null before it exists. send(message): the parent channel's send. */
function createFileToolsLink({ backend, send, periodMs = PERIOD_MS, timers = TIMERS } = {}) {
  if (typeof backend !== 'function') throw new TypeError('The file tools link needs a backend reader.');
  if (typeof send !== 'function') throw new TypeError('The file tools link needs a send function.');
  // The desktop reads no report as off with no turn, so the idle state is never sent: a host with project files off
  // says nothing until a turn starts.
  let told = 'false:false:null:0';
  let timer = null;
  let disposed = false;

  function report() {
    if (disposed) return;
    let now;
    try { now = fileToolsState(backend()); } catch { return; }
    const key = `${now.on}:${now.available}:${now.reason}:${now.turns}`;
    if (key === told) return;
    told = key;
    try { send({ type: 'file_tools', ...now }); } catch { /* the channel's own */ }
  }

  report();
  timer = timers.setInterval(report, periodMs);
  timer?.unref?.();

  return Object.freeze({
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== null) timers.clearInterval(timer);
      timer = null;
    },
    resources: () => ({ timers: timer === null ? 0 : 1, disposed }),
  });
}

module.exports = { MAX_TURNS, createFileToolsLink, fileToolsState };
