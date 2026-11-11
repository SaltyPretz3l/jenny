'use strict';

// One connection manager per team (TEAM_MEMBERSHIP_SPEC "Desktop client (M15)").
// States: connecting, online, reconnecting, offline, pending, revoked,
// update_required; every change is pushed as a full snapshot by the caller.
//
// It owns reconnect: exponential backoff with jitter, a new member bridge for
// every attempt (the bridge never retries), the last working addresses first and
// the invite's hints second. The backoff starts over only once a connection has
// held (an active member's event stream is open, or a pending member's poll was
// answered), so a host that greets and then drops is not redialled every second.
// Every address unreachable is `offline` with the time. A refused known device
// key is `revoked` once a second refusal confirms it; a hello version mismatch is
// `update_required`. Both are terminal: no timer, no bridge, no reconnect.
//
// Leave and revoking the device the call came from end this connection on the
// host, so a reset there means "check again", not failure: two refused dials
// with the device key prove the change happened; anything else is unconfirmed.
// The host is the authority on roles: this file never checks or caches a role to
// allow a call. A generation counter makes every await check that its connection
// is still the current one; `stop()` ends a dial in progress and waits for every
// attempt and probe, and nothing is written after it. Logs carry the team id,
// states, reasons, counts and event cursor numbers.
//
// Host events (slice 2a-4a): the event feed (event-feed.js) outlives links; each
// stream resumes from its remembered id and delivers to `onEvent` listeners in
// order, once. An invalid frame drops the link, so the next stream resyncs.

const { STATES_SEEN } = require('./client-file');
const { addressSets, cleanAddresses, openLink } = require('./bridge-link');
const { createEventFeed } = require('./event-feed');
const { REQUEST_ID } = require('./team-session');
const {
  TEAM_ERROR_CODES, TeamError, VERSION_REASONS, failureOf, invalidRequest, isFailureAnswer, teamFailure,
} = require('./team-errors');

const STATES = Object.freeze({
  CONNECTING: 'connecting', ONLINE: 'online', RECONNECTING: 'reconnecting', OFFLINE: 'offline',
  PENDING: 'pending', REVOKED: 'revoked', UPDATE_REQUIRED: 'update_required',
});
const TERMINAL = new Set([STATES.REVOKED, STATES.UPDATE_REQUIRED]);
const CLIENT_REASONS = new Set(['client_unauthorized', 'boot_epoch_mismatch', 'client_required']);
const RATE_LIMIT_MS = 60_000;
const CHAT_PREFIX = 'team.chat.';
// A stream open this long has held: a frame rejected after that starts the rejection backoff over.
const STREAM_STABLE_MS = 60_000;
const DEFAULT_BACKOFF = Object.freeze({ initialMs: 1000, maxMs: 60_000 });
// A delay is shortened by up to this share, so teams that lost one host do not redial in step.
const JITTER = 0.2;

function createConnectionManager({
  record: initialRecord, deviceKeys, saveRecord, onChange = () => {}, log = () => {}, spawnChild, appVersion,
  protocolVersion, requestTimeoutMs, timers = { setTimeout, clearTimeout }, backoff = DEFAULT_BACKOFF,
  pendingPollMs = 5000, now = Date.now, random = Math.random, createBridge, eventIdleMs, eventTimers,
}) {
  const record = { ...initialRecord };
  const teamId = record.team_id;
  const hostKey = Buffer.from(record.host_public_key, 'base64url');
  const stopping = new Set();
  const dialing = new Set();
  const tasks = new Set();
  const probes = new Set();
  let current = { state: STATES.CONNECTING, reason: null, code: null, since: now() };
  let facts = { team_name: null, role: null, member_state: record.state_seen };
  let pushedFacts = JSON.stringify(facts);
  let link = null;
  let client = null;
  let generation = 0;
  let timer = null;
  let failures = 0;
  // Streams in a row that ended on a rejected frame; while above zero an opened stream does not reset `failures`.
  let frameRejections = 0;
  let refusalsUnconfirmed = 0;
  let stopped = false;
  let busy = false;
  let lossDuringBusy = null;
  let limitedUntil = 0;
  let limitedAnswer = null;

  const say = (event, fields = {}) => { try { log('INFO', event, { team_id: teamId, ...fields }); } catch { /* logging is best effort */ } };
  // Host events across reconnects (event-feed.js); its remembered id is cleared on stop, revoke and identity loss.
  const feed = createEventFeed({ log: (level, event, fields) => say(event, fields) });

  function notify() {
    pushedFacts = JSON.stringify(facts);
    try { onChange(); } catch { /* a listener never breaks the manager */ }
  }

  // Pushes and logs only a real change; the facts alone changing (name, role) still pushes.
  function setState(state, { reason = null, code = null } = {}) {
    if (stopped) return;
    if (state === current.state && reason === current.reason && code === current.code) {
      if (JSON.stringify(facts) !== pushedFacts) notify();
      return;
    }
    current = { state, reason, code, since: now() };
    say('team.connection.state', { state, reason: reason || 'none' });
    notify();
  }

  function snapshot() {
    return { team_id: teamId, team_name: facts.team_name, state: current.state, reason: current.reason,
      code: current.code, since: current.since, member_id: record.member_id, device_id: record.device_id,
      display_name: record.display_name, role: facts.role, member_state: facts.member_state };
  }

  function persist(changes) {
    if (stopped) return;
    const next = { ...record, ...changes };
    if (Object.keys(changes).every((key) => JSON.stringify(next[key]) === JSON.stringify(record[key]))) return;
    Object.assign(record, changes);
    const saved = saveRecord(record);
    if (!saved || saved.ok !== true) say('team.client_file.write_failed');
  }

  // Keeps a promise in `tasks` until it settles; `stop()` waits for all of them.
  function track(promise) {
    tasks.add(promise);
    void promise.finally(() => tasks.delete(promise)).catch(() => {});
    return promise;
  }

  // Runs `fn` as a tracked task. An unexpected throw drops the connection it belonged to and retries later.
  function run(fn, gen = null) {
    return track(Promise.resolve().then(fn).catch(() => {
      say('team.connection.task_failed');
      if (stopped || TERMINAL.has(current.state) || (gen !== null && gen !== generation)) return;
      dropLink();
      retryLater(STATES.RECONNECTING, 'closed');
    }));
  }

  function cancelTimer() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  }

  function schedule(fn, ms, gen = null) {
    cancelTimer();
    timer = timers.setTimeout(() => { timer = null; run(fn, gen); }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function nextDelay() {
    const initial = Math.max(1, backoff.initialMs);
    const base = Math.min(backoff.maxMs, initial * (2 ** Math.min(failures, 30)));
    failures += 1;
    return Math.max(1, Math.round(base * (1 - JITTER * random())));
  }

  function closeLink(target) {
    if (!target) return;
    if (typeof target.unsubscribe === 'function') target.unsubscribe();
    if (target.stream) target.stream.close();
    const closing = target.close().catch(() => {});
    stopping.add(closing);
    void closing.finally(() => stopping.delete(closing));
  }

  // Ends the current connection (if any) and invalidates every await that belongs to it.
  function dropLink() {
    generation += 1;
    const old = link;
    link = null;
    closeLink(old);
  }

  function terminal(state, reason, code = null) {
    if (stopped) return;
    dropLink();
    cancelTimer();
    feed.clear();
    if (state === STATES.REVOKED) persist({ state_seen: 'revoked' });
    setState(state, { reason, code });
  }

  function retryLater(state, reason, code = TEAM_ERROR_CODES.CONNECTION_FAILED) {
    if (stopped || TERMINAL.has(current.state)) return;
    setState(state, { reason, code });
    schedule(attempt, nextDelay());
  }

  // A refusal of a key the host had already greeted on this connection is a revoke (the host
  // drops a key only on a revoke). A refusal before or during hello is confirmed by one more
  // attempt first: the host also closes a connection right after refusing a hello, and that
  // answer is only delivered best effort.
  function refused() {
    if (refusalsUnconfirmed >= 1) { terminal(STATES.REVOKED, 'member_revoked'); return; }
    refusalsUnconfirmed += 1;
    retryLater(STATES.RECONNECTING, 'host_refused');
  }

  function onLinkLost(gen, reason) {
    if (gen !== generation || stopped) return;
    if (busy) { lossDuringBusy = reason; return; }
    const greeted = link?.greeted === true;
    dropLink();
    if (reason === 'host_refused') {
      if (greeted) terminal(STATES.REVOKED, 'member_revoked');
      else refused();
      return;
    }
    retryLater(STATES.RECONNECTING, reason || 'closed');
  }

  // A call got no answer: the bridge says whether the host refused this key or the connection just ended.
  async function lostAfterReset(gen, target) {
    const reason = await target.offlineReason();
    onLinkLost(gen, reason || 'closed');
  }

  function loadSeed() {
    try {
      const seed = deviceKeys.load(teamId);
      return seed ? { seed } : { reason: 'team_device_key_missing' };
    } catch (error) {
      return { reason: error instanceof TeamError ? error.reason : 'team_device_key_unavailable', retry: true };
    }
  }

  // True once this manager stopped, or (for an attempt) once a newer attempt or a drop replaced it.
  const stale = (gen) => stopped || (gen !== null && gen !== generation);

  // Dials the address sets in order. `gen` is the attempt's generation, or null for a probe.
  async function connect(gen) {
    const key = loadSeed();
    if (!key.seed) return { ok: false, keyReason: key.reason, retry: key.retry === true };
    let reason = 'host_unreachable';
    try {
      for (const addresses of addressSets(record)) {
        if (stale(gen)) return { ok: false, reason: 'closed' };
        let bridge = null;
        const opened = await openLink({ secretKey: key.seed, hostPublicKey: hostKey, addresses, spawnChild, appVersion,
          protocolVersion, requestTimeoutMs, createBridge, log: (event, fields) => say(event, fields),
          onBridge: (started) => { bridge = started; dialing.add(started); } });
        if (bridge) dialing.delete(bridge);
        if (stale(gen)) {
          if (opened.ok) closeLink(opened.link);
          return { ok: false, reason: 'closed' };
        }
        if (opened.ok) return { ok: true, link: opened.link };
        reason = opened.reason;
        if (reason === 'host_refused') break;
      }
    } finally {
      key.seed.fill(0);
    }
    return { ok: false, reason };
  }

  async function attempt() {
    if (stopped || TERMINAL.has(current.state)) return;
    dropLink();
    const gen = generation;
    try {
      const result = await connect(gen);
      if (gen !== generation || stopped) { closeLink(result.link); return; }
      if (!result.ok) {
        if (result.keyReason) {
          const code = TEAM_ERROR_CODES.DEVICE_KEY_UNAVAILABLE;
          if (result.retry) retryLater(STATES.OFFLINE, result.keyReason, code);
          else setState(STATES.OFFLINE, { reason: result.keyReason, code });
          return;
        }
        if (result.reason === 'host_refused') { refused(); return; }
        retryLater(result.reason === 'host_unreachable' ? STATES.OFFLINE : STATES.RECONNECTING, result.reason);
        return;
      }
      link = result.link;
      const target = link;
      target.unsubscribe = target.bridge.onState((state) => {
        if (state.state !== 'offline') return;
        // The host closes the connection right after refusing a hello: the answer decides, not the close.
        if (target.greeting) target.lossDuringHello = state.reason;
        else onLinkLost(gen, state.reason);
      });
      await greet(gen);
    } catch {
      // A bridge or session that threw: close what this attempt opened and try again later.
      say('team.connection.attempt_failed');
      if (gen !== generation || stopped) return;
      dropLink();
      retryLater(STATES.RECONNECTING, 'closed');
    }
  }

  async function greet(gen) {
    const target = link;
    let hello;
    target.greeting = true;
    try {
      hello = await target.session.hello();
    } catch {
      target.greeting = false;
      await lostAfterReset(gen, target);
      return;
    }
    target.greeting = false;
    if (gen !== generation) return;
    if (!hello.ok) {
      if (VERSION_REASONS.has(hello.error.reason)) {
        terminal(STATES.UPDATE_REQUIRED, hello.error.reason, TEAM_ERROR_CODES.VERSION_MISMATCH);
      } else {
        onLinkLost(gen, 'closed');
      }
      return;
    }
    if (hello.team_id !== teamId) {
      dropLink();
      feed.clear();
      setState(STATES.OFFLINE, { reason: 'team_identity_mismatch', code: TEAM_ERROR_CODES.CONNECTION_FAILED });
      return;
    }
    if (target.lossDuringHello) { onLinkLost(gen, target.lossDuringHello); return; }
    refusalsUnconfirmed = 0;
    target.greeted = true;
    persist({ last_addresses: cleanAddresses([...target.workingAddresses(), ...(hello.addresses || [])]) });
    await refresh(gen, false);
  }

  // Reads team.status. `polled` is true for the pending poll: an answered poll means the connection has held.
  async function refresh(gen, polled) {
    const target = link;
    let status;
    try { status = await target.session.status(); } catch { await lostAfterReset(gen, target); return; }
    if (gen !== generation) return;
    if (!status.ok) {
      if (status.error.reason === 'member_revoked') terminal(STATES.REVOKED, 'member_revoked');
      else onLinkLost(gen, 'closed');
      return;
    }
    facts = { team_name: typeof status.team_name === 'string' ? status.team_name : null,
      role: typeof status.role === 'string' ? status.role : null, member_state: status.state };
    if (STATES_SEEN.includes(status.state)) persist({ state_seen: status.state });
    if (status.state === 'pending') {
      if (polled) failures = 0;
      setState(STATES.PENDING);
      schedule(() => (gen === generation ? refresh(gen, true) : undefined), pendingPollMs, gen);
      return;
    }
    if (status.state !== 'active') { terminal(STATES.REVOKED, 'member_revoked'); return; }
    await openEvents(gen);
  }

  async function registerClient(target) {
    const boot = await target.session.bootstrap();
    if (!boot.ok) return boot;
    if (client && client.bootEpoch === boot.boot_epoch) { target.client = client; return null; }
    const registered = await target.session.registerClient();
    if (!registered.ok) return registered;
    client = { client_id: registered.client_id, client_token: registered.client_token, bootEpoch: boot.boot_epoch };
    target.client = client;
    return null;
  }

  // Registers a client (reused while the host's boot epoch is the same; concurrent callers share one
  // registration) and resolves null, or the host's failure.
  function ensureClient(target) {
    if (target.client) return Promise.resolve(null);
    if (!target.registering) {
      target.registering = registerClient(target).finally(() => { target.registering = null; });
    }
    return target.registering;
  }

  // A frame from the stream of connection `gen`; one from an older connection is ignored.
  function onFrame(gen, target, frame) {
    if (gen !== generation || stopped || target.eventsBroken) return;
    const accepted = feed.accept(frame);
    if (!accepted.ok) { onFrameError(gen, target, accepted.reason); return; }
    // A delivered event, other than the resync_required a new stream opens with, proves the stream works.
    if (accepted.delivered && accepted.eventType !== 'resync_required') { frameRejections = 0; failures = 0; }
  }

  // An invalid frame or a protocol error: the feed forgets its id (accept already did for a frame), this
  // stream delivers nothing more and the connection is dropped, so the next stream asks the host to resync.
  function onFrameError(gen, target, reason) {
    if (gen !== generation || stopped || target.eventsBroken) return;
    target.eventsBroken = true;
    feed.clear();
    // Rejections in a row back off like failed dials (a host that keeps sending a refused frame is not
    // redialled every second); the retry below doubles from here.
    if (target.openedAt !== undefined && now() - target.openedAt >= STREAM_STABLE_MS) { frameRejections = 0; failures = 0; }
    frameRejections += 1;
    failures = Math.max(failures, frameRejections);
    say('team.events.frame_rejected', { reason, rejections: frameRejections });
    if (target.stream) target.stream.close();
    onLinkLost(gen, 'closed');
  }

  // Online means the event stream is open. A refused registration or a stream the host does not
  // open is a lost connection: it is retried with the backoff, which a rate-limited host also gets.
  async function openEvents(gen) {
    const target = link;
    let stream;
    try {
      const blocked = await ensureClient(target);
      if (gen !== generation) return;
      if (blocked) { onLinkLost(gen, 'events_unavailable'); return; }
      stream = await target.session.openEvents(target.client, { lastEventId: feed.lastEventId(),
        onFrame: (frame) => onFrame(gen, target, frame),
        onProtocolError: (reason) => onFrameError(gen, target, reason), idleTimeoutMs: eventIdleMs, timers: eventTimers });
    } catch {
      onLinkLost(gen, 'closed');
      return;
    }
    // A frame already refused before this point has dropped (or will drop) the connection.
    if (gen !== generation || target.eventsBroken) { stream.close(); return; }
    if (stream.status !== 200) { stream.close(); onLinkLost(gen, 'events_unavailable'); return; }
    target.stream = stream;
    target.openedAt = now();
    if (frameRejections === 0) failures = 0;
    say('team.events.opened', { cursor: feed.cursor() ?? 'none' });
    setState(STATES.ONLINE);
    void stream.closed.then(() => { if (target.stream === stream) { target.stream = null; onLinkLost(gen, 'closed'); } });
  }

  // Sends one command and returns the host's answer; throws a TeamError when there is no answer.
  // `requestId` (optional) is the caller's id for this mutation (see the retry below for what it guarantees).
  async function send(operation, params, { requestId } = {}) {
    if (stopped) return teamFailure('HOST_STOPPED', 'team_connection_stopped');
    if (requestId !== undefined && !(typeof requestId === 'string' && REQUEST_ID.test(requestId))) {
      return invalidRequest('team_request_id_invalid');
    }
    // The host limits chat on its own counter (team_chat_rate_limit, passed through): the admin hold never covers it.
    const chat = typeof operation === 'string' && operation.startsWith(CHAT_PREFIX);
    if (!chat && now() < limitedUntil && limitedAnswer) return limitedAnswer;
    const target = link;
    if (!target || (current.state !== STATES.ONLINE && current.state !== STATES.PENDING)) {
      return teamFailure('CONNECTION_FAILED', 'team_not_connected');
    }
    const blocked = await ensureClient(target);
    if (blocked) return blocked;
    const used = target.client;
    let answer = await target.session.command(operation, params, { client: used, bootEpoch: used.bootEpoch, requestId });
    if (isFailureAnswer(answer) && CLIENT_REASONS.has(answer.error.reason)) {
      // Only the client this call used is dropped: a concurrent call may already have a new one.
      if (target.client === used) target.client = null;
      if (client === used) client = null;
      const again = await ensureClient(target);
      if (again) return again;
      // The first attempt was refused at identity, before dispatch, so resending under the caller's id is safe;
      // without one the retry carries a new id. A later resend under the same id replays the stored answer
      // only for chat (the chat store keys member, device and id). An admin mutation's receipt also digests
      // client_id and boot_epoch, so after a new registration it answers request_payload_changed.
      answer = await target.session.command(operation, params, { client: target.client,
        bootEpoch: target.client.bootEpoch, requestId });
    }
    // The host's admin limit is one counter per member over every team command, so the hold covers every
    // admin command (a chat operation's own limit answers team_chat_rate_limit and starts no hold).
    if (isFailureAnswer(answer) && answer.error.reason === 'team_rate_limit') {
      limitedUntil = now() + RATE_LIMIT_MS;
      limitedAnswer = { ok: false, error: { code: answer.error.code, reason: answer.error.reason,
        retryable: answer.error.retryable === true } };
    }
    return answer;
  }

  async function command(operation, params, options) {
    try {
      return await send(operation, params, options);
    } catch (error) {
      return failureOf(error);
    }
  }

  // One dial with the device key: 'admitted' (status answered), 'revoked' (status says so),
  // 'refused' (the key was refused) or 'unknown'.
  async function probeOnce() {
    const result = await connect(null);
    if (!result.ok) return result.reason === 'host_refused' ? 'refused' : 'unknown';
    const probe = result.link;
    probes.add(probe);
    try {
      const hello = await probe.session.hello();
      if (!hello.ok) return 'unknown';
      const status = await probe.session.status();
      if (status.ok) return 'admitted';
      return status.error.reason === 'member_revoked' ? 'revoked' : 'unknown';
    } catch {
      return (await probe.offlineReason()) === 'host_refused' ? 'refused' : 'unknown';
    } finally {
      probes.delete(probe);
      await probe.close();
    }
  }

  // After a reset during a change that ends this device's access: did it happen? A refusal is
  // confirmed by a second one (the same rule as a reconnect); one refusal alone proves nothing.
  async function changeHappened() {
    const first = await probeOnce();
    if (first === 'revoked') return true;
    if (first !== 'refused' || stopped) return false;
    const second = await probeOnce();
    return second === 'refused' || second === 'revoked';
  }

  // Runs a call that ends this device's access when it succeeds (leave, own-device revoke).
  async function endingCall(runCall) {
    if (stopped) return { outcome: 'failed', answer: teamFailure('HOST_STOPPED', 'team_connection_stopped') };
    if (busy) return { outcome: 'failed', answer: teamFailure('CONNECTION_FAILED', 'team_busy') };
    busy = true;
    lossDuringBusy = null;
    let outcome;
    let answer;
    try {
      answer = await runCall();
      outcome = answer.ok === true ? 'done' : 'failed';
    } catch (error) {
      answer = failureOf(error);
      outcome = 'failed';
      if (error instanceof TeamError && error.reset) {
        const happened = await track(changeHappened());
        outcome = happened ? 'done' : 'failed';
        answer = happened ? { ok: true } : teamFailure('CONNECTION_FAILED', 'team_change_unconfirmed');
      }
    } finally {
      busy = false;
    }
    if (outcome === 'failed' && lossDuringBusy && !stopped) {
      const reason = lossDuringBusy;
      lossDuringBusy = null;
      onLinkLost(generation, reason);
    }
    return { outcome, answer };
  }

  async function leave() {
    const { outcome, answer } = await endingCall(async () => {
      if (!link) return teamFailure('CONNECTION_FAILED', 'team_not_connected');
      return link.session.leave();
    });
    if (outcome === 'done') await stop();
    return answer;
  }

  async function revokeOwnDevice(params) {
    const { outcome, answer } = await endingCall(() => send('team.device.revoke', params));
    if (outcome === 'done') terminal(STATES.REVOKED, 'device_revoked');
    return answer;
  }

  async function stop() {
    stopped = true;
    cancelTimer();
    dropLink();
    feed.close();
    for (const bridge of dialing) {
      const closing = bridge.stop().catch(() => {});
      stopping.add(closing);
      void closing.finally(() => stopping.delete(closing));
    }
    for (const probe of probes) closeLink(probe);
    await Promise.all([...tasks].map((task) => task.catch(() => {})));
    await Promise.all([...stopping]);
  }

  return {
    teamId,
    start() { if (!stopped) run(attempt); },
    stop,
    snapshot,
    command,
    // Every host event in order, exactly once, across reconnects; returns the unsubscribe function.
    onEvent: (listener) => (stopped ? () => {} : feed.onEvent(listener)),
    // The cursor of the last delivered event (the number only), or null.
    eventCursor: () => feed.cursor(),
    leave,
    revokeOwnDevice,
    isOwnDevice: (deviceId) => deviceId === record.device_id,
    resources: () => ({ bridges: (link ? 1 : 0) + stopping.size + dialing.size, timers: timer === null ? 0 : 1,
      sockets: link ? link.http.openSockets() : 0, streams: link && link.stream ? 1 : 0 }),
  };
}

module.exports = { createConnectionManager };
