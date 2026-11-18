'use strict';

// Supervises the one team host this Jenny runs (slice 1f-2): a child started
// with an injected `fork` (Electron's `utilityProcess.fork` in the app, a fake
// or a Node child in tests), the parent channel of server/team/parent-channel.js
// on top of it, and the states
//
//   stopped -> starting -> running -> stopping -> stopped
//                 \            \          \
//                  -> failed    -> failed   -> failed
//
// The host key goes only in `start { host_key }`, sent once the child has
// spawned, and the caller's buffer is zeroed (the encoded string cannot be).
// `ready` means running. `error { reason }` means failed with that reason in
// every state, also after `ready` (a failed --team-init or --team-recover
// mint). A child that exits without `stopped` is failed. There is no
// automatic restart. Stop sends `stop`, waits for the exit within `stopMs`,
// then ends the child through the handle this file holds, exactly once; a
// process is never looked up by name or by a PID from a file. A child whose exit
// is never seen (it may still hold the profile lock) is kept, with its exit
// listener, as failed `team_host_exit_unconfirmed`, and no new host starts until
// that exit arrives. An unrequested `stopped` is reaped the same bounded way. The parent pings
// every `pingMs` so a host on `parentPort` can tell when its parent is gone.
//
// A state snapshot never carries the key or an invite; `owner_invite` goes to
// the start's `onOwnerInvite` once and is not kept. Logs carry event names,
// states and reasons only.
//
// `start` may take the owner's relay token, sent only in `start` beside the
// key. `reach { result, reason }` (server/team/transport/reach.js) is the
// snapshot's `reach` while running and null in every other state; a `reach`
// with a word outside the lists is dropped like any malformed message. A change
// that is only the verdict logs `team.host.reach`, not another state line.
// Listeners hear a verdict-only change at most once per `reachPushMs`, with the
// newest verdict; a state change is told at once and never waits.
//
// The child's stdout goes to the run's log sink (host-log.js, E51) until the run is released.
//
// Slice 6-7: `setModelRelay(n)` posts the owner's relay setting to the running host; the host's
// `model_relay { flowing, passing }` is the snapshot's `relay` while running (null otherwise), told like a
// verdict: at most once per `reachPushMs`, and only when it moved.

const path = require('node:path');

const { MAX_RELAY_FLOWING, isOutbound } = require('../../../server/team/parent-channel');
const { REACH_REASONS, REACH_RESULTS } = require('../../../server/team/transport/reach');
const { isAddressHint, isRelayToken } = require('../../../server/team/invites');
const { invalidRequest, teamFailure } = require('../team-errors');
const { createHostLogSink } = require('./host-log');
const { LOGS_DIR_NAME } = require('./host-layout');

const DEFAULT_BOUNDS = Object.freeze({
  // The host's own stop is ~1 to 3 s (bridge stop, then the hosted sidecar's 5 s graceful
  // and 2 s forced stop at worst); 8 s plus 2 s after the kill stays inside the app's 15 s
  // shutdown budget with room for the member client's stop, which runs alongside.
  stopMs: 8_000,
  killWaitMs: 2_000,
  // Lock, key (the host's own 10 s), store, backend start, bridge: a generous ceiling.
  startMs: 120_000,
  pingMs: 5_000,
  // The least time between two pushes that only carry a new verdict.
  reachPushMs: 1_000,
});
const SYSTEM_CLOCK = Object.freeze({ now: () => Date.now(), setTimeout, clearTimeout });
const REASON = /^[a-z][a-z0-9_]{0,79}$/u;
const CHILD_STDIO = Object.freeze(['ignore', 'pipe', 'ignore']);
const MAX_ADDRESSES = 16;
const MAX_TEXT = 256;
// The router's outside address for the direct port, as the bridge writes it.
const MAPPED_ADDRESS = /^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/u;
// The relay's transfer records (model-manifest.js maxTransferRecords): more cannot be passing.
const MAX_PASSING = 256;
// Row 123 (file-tools-link.js): the worker's reason word and the running turns the host reports.
const FILE_REASON = /^file_access_[a-z_]{1,48}$/u;
const MAX_TURNS = 64;

const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT;

// A frozen copy of a valid host message, or null: the host's own field table, then stricter values.
function parseHostMessage(value) {
  if (!isOutbound(value)) return null;
  switch (value.type) {
    case 'ready':
      if (!text(value.boot_epoch) || !text(value.team_id) || !text(value.public_key)) return null;
      if (!Array.isArray(value.addresses) || value.addresses.length > MAX_ADDRESSES || !value.addresses.every(text)) return null;
      return Object.freeze({ ...value, addresses: Object.freeze([...value.addresses]) });
    case 'owner_invite': return text(value.invite) ? Object.freeze({ ...value }) : null;
    case 'membership_changed': return REASON.test(value.kind) && text(value.member_id) ? Object.freeze({ ...value }) : null;
    case 'error': return typeof value.reason === 'string' && REASON.test(value.reason) ? Object.freeze({ ...value }) : null;
    case 'mapped': return value.external === null || (MAPPED_ADDRESS.test(value.external) && isAddressHint(value.external))
      ? Object.freeze({ ...value }) : null;
    case 'reach': return REACH_RESULTS.includes(value.result) && REACH_REASONS.includes(value.reason) ? Object.freeze({ ...value }) : null;
    case 'model_relay': {
      const count = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max;
      return count(value.flowing, MAX_RELAY_FLOWING) && count(value.passing, MAX_PASSING) ? Object.freeze({ ...value }) : null;
    }
    case 'file_tools': {
      const reasonOk = value.reason === null || (typeof value.reason === 'string' && FILE_REASON.test(value.reason));
      return typeof value.on === 'boolean' && typeof value.available === 'boolean' && reasonOk
        && Number.isSafeInteger(value.turns) && value.turns >= 0 && value.turns <= MAX_TURNS ? Object.freeze({ ...value }) : null;
    }
    default: return Object.freeze({ type: value.type }); // stopped, owner_exists
  }
}

const hostFailure = (reason) => teamFailure('HOST_UNAVAILABLE', reason);
const now = () => Date.now();

// The logs folder beside the config the child was started with, or null when the arguments name none.
function logsDirOf(args) {
  const index = args.indexOf('--config');
  const configPath = index >= 0 ? args[index + 1] : null;
  return typeof configPath === 'string' && path.isAbsolute(configPath) ? path.join(path.dirname(configPath), LOGS_DIR_NAME) : null;
}

function createHostSupervisor({ fork, entryPath, env = {}, bounds = {}, log = () => {}, clock = SYSTEM_CLOCK }) {
  if (typeof fork !== 'function') throw new TypeError('createHostSupervisor requires fork.');
  const limits = { ...DEFAULT_BOUNDS, ...bounds };
  const listeners = new Set();
  const say = (level, event, fields) => { try { log(level, event, fields); } catch { /* best effort */ } };
  let state = { state: 'stopped', team_id: null, team_name: null, addresses: [], reason: null, reach: null, relay: null, files: null, since: now() };
  let run = null;
  // The running host's mapped address (`mapped`), for the reconnect code; null in every other state.
  let mappedAddress = null;
  // The last released run's sink while it reads the exited child's last lines (at most one second).
  let logClosing = Promise.resolve();
  // The verdict listeners were last told, when a verdict-only push last went out, and the one waiting.
  let toldReach = null;
  let lastReachPush = -Infinity;
  let reachTimer = null;

  function snapshot() {
    return { ...state, addresses: [...state.addresses], reach: state.reach ? { ...state.reach } : null, relay: state.relay ? { ...state.relay } : null,
      files: state.files ? { ...state.files } : null };
  }

  // One word for a verdict, so two verdicts compare once; null stays null.
  const reachWord = (reach) => (reach ? `${reach.result}/${reach.reason}` : null);
  // The verdict and the relay's numbers together: what a quiet push tells.
  const quietWord = (s) => `${reachWord(s.reach)}|${s.relay ? `${s.relay.flowing}/${s.relay.passing}` : ''}|${s.files ? `${s.files.available}/${s.files.reason}/${s.files.turns}` : ''}`;

  function tell() {
    toldReach = quietWord(state);
    for (const listener of [...listeners]) {
      try { listener(snapshot()); } catch { /* a listener's failure is its own */ }
    }
  }

  function dropReachPush() {
    if (reachTimer !== null) clock.clearTimeout(reachTimer);
    reachTimer = null;
  }

  // A verdict-only push: now, or at the end of the interval since the last one; nothing when the verdict
  // listeners last heard is the newest one again.
  function pushReach() {
    reachTimer = null;
    if (quietWord(state) === toldReach) return;
    lastReachPush = clock.now();
    const verdictMoved = String(toldReach).split('|')[0] !== String(reachWord(state.reach));
    if (state.reach && verdictMoved) say('INFO', 'team.host.reach', { result: state.reach.result, reason: state.reach.reason });
    tell();
  }

  function setState(patch) {
    // `since` is when the state word last moved; a new verdict alone keeps it.
    const next = { ...state, ...patch, since: Object.hasOwn(patch, 'state') ? now() : state.since };
    // A verdict belongs to one running host.
    if (next.state !== 'running') { next.reach = null; next.relay = null; next.files = null; mappedAddress = null; }
    const moved = next.state !== state.state || next.reason !== state.reason || next.team_id !== state.team_id;
    const reachMoved = quietWord(next) !== quietWord(state);
    state = next;
    if (moved) {
      dropReachPush();
      say('INFO', 'team.host.state', { state: state.state, ...(state.reason ? { reason: state.reason } : {}) });
      tell();
      return;
    }
    if (!reachMoved || reachTimer !== null) return;
    const wait = lastReachPush + limits.reachPushMs - clock.now();
    if (wait <= 0) {
      pushReach();
      return;
    }
    reachTimer = clock.setTimeout(pushReach, wait);
    reachTimer?.unref?.();
  }

  // Everything one child holds: its handle, its timers and its listeners.
  function createRun(child, options) {
    const current = {
      child, options, timers: new Set(), detach: [], exited: false, stoppedSeen: false, stopRequested: false,
      killed: false, inviteTaken: false, settleStart: null, exitWaiters: [], failure: null, reaping: false,
      unconfirmed: false,
    };
    current.timer = (fn, ms, kind = 'timeout') => {
      const handle = kind === 'interval' ? setInterval(fn, ms) : setTimeout(() => { current.timers.delete(handle); fn(); }, ms);
      // Not unref'd: every timer is bounded or cleared on release, and a stop wait must hold the process.
      current.timers.add(handle);
      return handle;
    };
    current.clear = (handle) => { clearTimeout(handle); clearInterval(handle); current.timers.delete(handle); };
    current.post = (message) => {
      if (current.exited) return false;
      try { child.postMessage(message); return true; } catch { say('WARN', 'team.host.post_failed', { type: message.type }); return false; }
    };
    return current;
  }

  function settleStart(current, answer) {
    const settle = current.settleStart;
    current.settleStart = null;
    settle?.(answer);
  }

  function clearTimers(current) {
    for (const handle of [...current.timers]) current.clear(handle);
  }

  function release(current) {
    clearTimers(current);
    const sink = current.logSink;
    current.logSink = null;
    // A sink's failure never keeps the run held.
    try { if (sink) logClosing = sink.drain(); } catch { /* the sink's own timer still closes it */ }
    for (const detach of current.detach.splice(0)) { try { detach(); } catch { /* already gone */ } }
    if (run === current) run = null;
  }

  // Ends the child through the held handle, once; resolves when it exited or the wait ran out.
  function waitForExit(current, ms) {
    if (current.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = current.timer(() => resolve(false), ms);
      current.exitWaiters.push(() => { current.clear(timer); resolve(true); });
    });
  }

  async function reap(current) {
    if (await waitForExit(current, limits.stopMs)) return true;
    if (!current.killed) {
      current.killed = true;
      try { current.child.kill(); } catch { /* the wait below decides */ }
    }
    return waitForExit(current, limits.killWaitMs);
  }

  // The exit was not seen: keep the handle and its exit listener (onExit releases), stop the timers.
  function holdUnconfirmed(current) {
    current.unconfirmed = true;
    clearTimers(current);
    say('WARN', 'team.host.exit_unconfirmed');
    settleStart(current, hostFailure('team_host_exit_unconfirmed'));
    setState({ state: 'failed', reason: 'team_host_exit_unconfirmed', addresses: [] });
  }

  // A host that is done on its own (failed, or said `stopped`) exits; one that does not is ended through the handle.
  function reapUnrequested(current) {
    if (current.exited || current.stopRequested || current.reaping) return;
    current.reaping = true;
    void reap(current).then((exited) => {
      if (!exited && !current.stopRequested) holdUnconfirmed(current);
    });
  }

  function fail(current, reason) {
    if (current.failure) return;
    current.failure = reason;
    say('WARN', 'team.host.failed', { reason });
    settleStart(current, hostFailure(reason));
    setState({ state: 'failed', reason, addresses: [] });
    reapUnrequested(current);
  }

  function onMessage(current, raw) {
    const message = parseHostMessage(raw);
    if (!message) { say('WARN', 'team.host.message_dropped'); return; }
    switch (message.type) {
      case 'ready':
        if (current.failure || current.stopRequested || state.state !== 'starting') return;
        setState({ state: 'running', team_id: message.team_id, addresses: [...message.addresses], reason: null });
        settleStart(current, { ok: true, host: snapshot() });
        return;
      case 'owner_invite':
      case 'owner_exists':
        if (current.inviteTaken) return;
        current.inviteTaken = true;
        try {
          if (message.type === 'owner_invite') current.options.onOwnerInvite?.(message.invite);
          else current.options.onOwnerExists?.();
        } catch { say('WARN', 'team.host.owner_invite_failed'); }
        return;
      case 'membership_changed':
        try { current.options.onMembershipChanged?.({ kind: message.kind, member_id: message.member_id }); } catch { /* own */ }
        return;
      case 'stopped':
        current.stoppedSeen = true;
        reapUnrequested(current);
        return;
      case 'mapped':
        if (current.failure || current.stopRequested || run !== current || state.state !== 'running') return;
        mappedAddress = message.external;
        return;
      case 'reach':
        // setState keeps a verdict only while running and tells listeners only when it moved.
        if (current.failure || current.stopRequested || run !== current) return;
        setState({ reach: { result: message.result, reason: message.reason } });
        return;
      case 'model_relay':
        if (current.failure || current.stopRequested || run !== current) return;
        setState({ relay: { flowing: message.flowing, passing: message.passing } });
        return;
      case 'file_tools': // row 123: the project files state and the running turns, while running
        if (current.failure || current.stopRequested || run !== current) return;
        setState({ files: { on: message.on, available: message.available, reason: message.reason, turns: message.turns } });
        return;
      default:
        fail(current, message.reason);
    }
  }

  function onExit(current) {
    if (current.exited) return;
    current.exited = true;
    for (const waiter of current.exitWaiters.splice(0)) waiter();
    release(current);
    if (current.unconfirmed) {
      // The late exit of a held child: the host can start again.
      if (current.failure) setState({ state: 'failed', reason: current.failure, addresses: [] });
      else if (current.stopRequested) setState({ state: 'stopped', reason: 'team_host_stop_timeout', addresses: [] });
      else setState({ state: 'stopped', reason: 'team_host_stopped_itself', addresses: [] });
      return;
    }
    if (current.failure) return;
    if (current.stopRequested) return; // stop() decides the final state
    if (current.stoppedSeen) {
      settleStart(current, hostFailure('team_host_stopped_itself'));
      setState({ state: 'stopped', reason: 'team_host_stopped_itself', addresses: [] });
      return;
    }
    fail(current, 'team_host_exited');
  }

  async function start({ args, hostKey, relayToken = null, teamName = null, onOwnerInvite, onOwnerExists, onMembershipChanged }) {
    if (run || state.state === 'starting' || state.state === 'running' || state.state === 'stopping') {
      hostKey?.fill?.(0);
      return invalidRequest(run?.unconfirmed ? 'team_host_exit_unconfirmed' : 'team_host_busy');
    }
    if (relayToken !== null && !isRelayToken(relayToken)) {
      hostKey?.fill?.(0);
      return invalidRequest('team_relay_token_invalid');
    }
    let encoded;
    try {
      // A view over the caller's bytes, not a copy, so zeroing the caller's buffer leaves no other.
      encoded = Buffer.from(hostKey.buffer, hostKey.byteOffset, hostKey.byteLength).toString('base64url');
    } finally {
      hostKey?.fill?.(0);
    }
    // Held only until the `start` message is posted.
    let token = relayToken;
    setState({ state: 'starting', team_id: null, team_name: teamName, addresses: [], reason: null });
    let child;
    try {
      child = fork(entryPath, [...args], { env: { ...env }, stdio: [...CHILD_STDIO], serviceName: 'Jenny team host' });
    } catch {
      setState({ state: 'failed', reason: 'team_host_spawn_failed' });
      return hostFailure('team_host_spawn_failed');
    }
    const current = createRun(child, { onOwnerInvite, onOwnerExists, onMembershipChanged });
    const stream = child.stdout;
    current.logSink = stream ? createHostLogSink({ stream, logsDir: logsDirOf(args), say }) : null;
    run = current;
    const answer = new Promise((resolve) => { current.settleStart = resolve; });
    const on = (event, handler) => {
      child.on(event, handler);
      current.detach.push(() => child.removeListener(event, handler));
    };
    on('message', (message) => onMessage(current, message));
    on('exit', () => onExit(current));
    on('spawn', () => {
      // A stop or a failure before the spawn: the child gets no key and no ping.
      if (current.stopRequested || current.failure) { encoded = null; token = null; return; }
      current.post({ type: 'start', host_key: encoded, ...(token === null ? {} : { relay_token: token }) });
      encoded = null;
      token = null;
      current.timer(() => current.post({ type: 'ping' }), limits.pingMs, 'interval');
    });
    current.timer(() => {
      if (state.state !== 'starting' || run !== current) return;
      settleStart(current, hostFailure('team_host_start_timeout'));
      void stop({ reason: 'team_host_start_timeout' });
    }, limits.startMs);
    return answer;
  }

  let stopping = null;
  function stop({ reason = null } = {}) {
    const current = run;
    // A held child was already asked and killed: nothing more to send; its exit releases it.
    if (!current || current.unconfirmed) return logClosing.then(snapshot);
    if (stopping) return stopping;
    const promise = (async () => {
      current.stopRequested = true;
      settleStart(current, hostFailure(reason || 'team_host_stopped'));
      setState({ state: 'stopping', reason: current.failure || null });
      current.post({ type: 'stop' });
      const exited = await reap(current);
      if (!exited) {
        if (!current.unconfirmed) holdUnconfirmed(current);
        return snapshot();
      }
      release(current);
      await logClosing;
      if (current.failure) setState({ state: 'failed', reason: current.failure, addresses: [] });
      else if (reason) setState({ state: 'failed', reason, addresses: [] });
      else setState({ state: 'stopped', reason: current.killed ? 'team_host_stop_timeout' : null, addresses: [] });
      return snapshot();
    })();
    stopping = promise;
    promise.finally(() => { if (stopping === promise) stopping = null; });
    return promise;
  }

  function onState(listener) {
    if (typeof listener !== 'function') throw new TypeError('onState requires a function.');
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  function resources() {
    // The held-back reach push counts as a timer, so a leak check sees it.
    const timers = (run ? run.timers.size : 0) + (reachTimer !== null ? 1 : 0);
    return { child: Boolean(run), timers, childListeners: run ? run.detach.length : 0 };
  }

  // Slice 5-6: tells the running host that its team is being deleted, so it can tell connected members first.
  function notifyDeleting() {
    if (!run || run.exited || state.state !== 'running') return false;
    run.post({ type: 'team_deleting' });
    return true;
  }

  // Slice 6-7: the owner's relay setting for the running host, applied without a restart. False while not running.
  function setModelRelay(flowing) {
    if (!Number.isSafeInteger(flowing) || flowing < 0 || flowing > MAX_RELAY_FLOWING) return false;
    if (!run || run.exited || state.state !== 'running') return false;
    return run.post({ type: 'model_relay', flowing }) === true; // the log's `applied`: true only when it was sent
  }

  return { start, stop, snapshot, mapped: () => mappedAddress, onState, resources, notifyDeleting, setModelRelay };
}

module.exports = { createHostSupervisor };
