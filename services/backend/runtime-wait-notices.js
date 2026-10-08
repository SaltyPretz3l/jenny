'use strict';

// A reply that pauses by itself behind a resource another chat holds emits no
// stream event of its own, so the chat kept saying "Still at it…" for a reply
// that was not running (dogfood HB-034 F5). This reports the wait on the
// paused stream as one `runtime_waiting` chat-stream event, and again whenever
// what the reply waits behind changes:
//   waiting  a lease is in the way; the eligibility coordinator resumes the
//            reply by itself when it goes
//   stuck    the lease in the way belongs to a stopped operation whose cleanup
//            was never confirmed, so only an engine restart frees it
//   ended    the wait is no longer resumed automatically (shutdown, refused
//            resume, a pause on top of it): the reply stays paused until
//            someone resumes it
// A wait is followed until its reply runs again or is over. Most of what ends
// or changes one raises no event this module could subscribe to (a command that
// times out into an unconfirmed lease, the coordinator dropping its waits, a
// pause landing on a resumed reply that had not started yet), so while any
// wait is open one slow pass re-reads them all.
// Presentation only: nothing here admits, resumes or cancels work.

// A stop quarantines its lease for the moment its cleanup takes; only one that
// stays unconfirmed past this is reported as stuck.
const STUCK_GRACE_MS = 5000;
const HEARTBEAT_MS = 2000;
// A resumed reply normally starts within moments; only one still queued behind
// the model after this long is reported as waiting for other work.
const LANE_NOTICE_MS = 1500;
const MAX_NOTICES = 256;

const { normalizeText: normalizeId } = require('../shared/normalize');

function createRuntimeWaitNotices({ emit, broker, isTracked, getWork, incarnation, log = () => {},
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, stuckGraceMs = STUCK_GRACE_MS,
  heartbeatMs = HEARTBEAT_MS } = {}) {
  if ([emit, isTracked, getWork].some(port => typeof port !== 'function')
    || typeof broker?.describeWait !== 'function' || typeof incarnation !== 'string' || !incarnation) {
    throw new TypeError('runtime_wait_notices_dependencies_invalid');
  }
  // work_id -> { revision, resources, sessionId, streamId, turnId, key, pendingSince }
  const notices = new Map();
  let pass = null;
  let recheck = null;
  let disposed = false;

  function arm(callback, delayMs) {
    const timer = setTimer(callback, delayMs);
    // A presentation timer must never keep the process (or a test run) alive.
    if (typeof timer?.unref === 'function') timer.unref();
    return timer;
  }

  function send(workId, notice, waitState, details = {}) {
    const resourceClass = normalizeId(details.resourceClass);
    const blockingSessionId = normalizeId(details.blockingSessionId);
    const key = [waitState, resourceClass, blockingSessionId].join('|');
    if (notice.key === key) return false;
    notice.key = key;
    emit({
      type: 'runtime_waiting',
      streamId: notice.streamId, sessionId: notice.sessionId, requestId: notice.streamId,
      turnId: notice.turnId, traceId: notice.streamId, trace_id: notice.streamId,
      workId, waitState, resourceClass, blockingSessionId,
    });
    return true;
  }

  function describe(notice, timestamp) {
    const wait = broker.describeWait(notice.resources);
    // Free again, or lease-record pressure with no holder to name: the
    // coordinator's own pump decides what happens next.
    if (!wait.resource_class) return null;
    const ages = wait.holders.filter(holder => holder.status === 'quarantined')
      .map(holder => timestamp - Number(holder.quarantined_at));
    const unconfirmed = ages.filter(age => age >= stuckGraceMs).length;
    // One unconfirmed lease on the folder blocks it outright. A capacity class
    // is stuck only when nothing that holds it can still finish.
    const stuck = wait.resource_class === 'filesystem' ? unconfirmed > 0
      : wait.holders.length > 0 && unconfirmed === wait.holders.length;
    const sessions = [...new Set(wait.holders.map(holder => normalizeId(holder.session_id))
      .filter(id => id && id !== notice.sessionId))];
    const settling = ages.filter(age => age < stuckGraceMs);
    return {
      waitState: stuck ? 'stuck' : 'waiting',
      resourceClass: wait.resource_class,
      // Named only when exactly one other chat holds the folder.
      blockingSessionId: !stuck && wait.resource_class === 'filesystem' && sessions.length === 1 ? sessions[0] : '',
      recheckInMs: settling.length ? stuckGraceMs - Math.max(...settling) : null,
    };
  }

  function run() {
    pass = null;
    if (disposed) return;
    const timestamp = Number(now());
    let recheckInMs = null;
    for (const [workId, notice] of [...notices]) {
      try {
        const work = getWork(workId);
        const status = work?.status;
        if (status === 'pending') {
          // Resumed and queued for the model: the line stays until the reply's
          // new stream starts, and stops naming a folder that is free again.
          notice.pendingSince ??= timestamp;
          if (notice.key && timestamp - notice.pendingSince >= LANE_NOTICE_MS) {
            send(workId, notice, 'waiting', { resourceClass: 'inference' });
          }
          continue;
        }
        if (status !== 'paused' && status !== 'needs_attention') {
          // Running again (its `started` replaced the line) or over (its
          // terminal did): nothing left to say.
          notices.delete(workId);
          continue;
        }
        // Paused, but not as the wait that was announced, or no longer one the
        // coordinator will end: a pause, a shutdown, a refused resume.
        if (status !== 'paused' || work.revision !== notice.revision || isTracked(workId) !== true) {
          send(workId, notice, 'ended');
          notices.delete(workId);
          continue;
        }
        notice.pendingSince = null;
        const described = describe(notice, timestamp);
        if (!described) continue;
        send(workId, notice, described.waitState, described);
        if (described.recheckInMs != null) {
          recheckInMs = recheckInMs == null ? described.recheckInMs : Math.min(recheckInMs, described.recheckInMs);
        }
      } catch (error) {
        notices.delete(workId);
        try {
          log('WARN', 'session_runtime.wait_notice_failed', { work_id: workId,
            message: String(error?.message || error).slice(0, 200) });
        } catch (_error) { /* Diagnostics cannot fail a presentation pass. */ }
      }
    }
    if (recheck) { clearTimer(recheck); recheck = null; }
    if (notices.size) {
      const dueInMs = recheckInMs == null ? heartbeatMs : Math.min(heartbeatMs, Math.max(0, recheckInMs) + 25);
      recheck = arm(() => { recheck = null; run(); }, dueInMs);
    }
  }

  // Coalesced, and after the coordinator's pump (a microtask): a wait that was
  // resumed on the same change is gone before it could be announced.
  function refresh() {
    if (disposed || pass || !notices.size) return;
    pass = arm(run, 0);
  }

  function note(work, waitResources) {
    const workId = normalizeId(work?.work_id);
    const sessionId = normalizeId(work?.session_id);
    const streamId = normalizeId(work?.attempt?.stream_id);
    // Only this process's attempts have a live stream to report on, and a
    // dependency wait (a reply waiting for its own child) is not a resource wait.
    if (disposed || !workId || !sessionId || !streamId || work.attempt?.incarnation !== incarnation
      || !Array.isArray(waitResources) || !waitResources.length
      || waitResources.some(resource => resource?.type === 'dependency')) return false;
    notices.delete(workId);
    notices.set(workId, { revision: getWork(workId)?.revision, resources: waitResources, sessionId, streamId,
      turnId: normalizeId(work.turn_id), key: '', pendingSince: null });
    while (notices.size > MAX_NOTICES) notices.delete(notices.keys().next().value);
    refresh();
    return true;
  }

  function dispose() {
    disposed = true;
    notices.clear();
    if (pass) clearTimer(pass);
    if (recheck) clearTimer(recheck);
    pass = null;
    recheck = null;
  }

  return Object.freeze({ note, refresh, dispose, size: () => notices.size });
}

module.exports = { HEARTBEAT_MS, STUCK_GRACE_MS, createRuntimeWaitNotices };
