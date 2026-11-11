'use strict';

// The team host's chat composition (row 123 slices 2a-3a and 2a-3b): one TeamChatStore on
// the team profile with the member store's logger and path guard, the team
// channel, retention once at start and every six hours on an unref'd timer,
// the channel audience, and the chat command dispatcher the team commands hand
// `team.chat.*` to. A chat store that fails to open never stops the host:
// membership keeps working and every chat command answers the store's failure.
// `dispose()` drains: it refuses new commands, then waits for a retention run
// and every queued store write, so the profile lock is released only after.
// Slice 2a-3b adds presence (team-presence.js, fed by the team HTTP layer's
// stream callback), the overview roster, search options, and a bounded retry
// with backoff when opening the store or creating the team channel fails
// transiently at start (a latched store is not retried).
// Logs carry fixed reasons and counts only.

const { DEFAULT_RESOURCE_LIMITS } = require('../../server/config');
const { hostFailure } = require('../../server/api-contract');
const { channelMembers } = require('../../server/team/authorize');
const { safeLogger } = require('../../server/team/safe-logger');
const { assertSafeFile } = require('./path-guard');
const { createTeamChatCommands, publishPruned } = require('./team-chat-commands');
const { TeamChatStore } = require('./team-chat-store');
const { createTeamPresence } = require('./team-presence');

const TEAM_CHANNEL = 'chan_team';
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Start retries: 1, 2, 4, 8, then 16 s, five at most.
const START_RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000, 8_000, 16_000]);
const DEFAULT_TIMERS = Object.freeze({ setInterval, clearInterval, setTimeout, clearTimeout });

// The overview roster from a member store: each active member's id, display
// name and role, read fresh from the store's snapshot; nothing else.
function chatRoster(memberStore) {
  return () => (memberStore.snapshot()?.members || []).filter((member) => member.state === 'active')
    .map((member) => ({ member_id: member.member_id, display_name: member.display_name, role: member.role }));
}

function createTeamChatHost({
  profileDir, directory, logger = null, clock = Date.now, randomBytes, assertSafePath = assertSafeFile,
  maxResponseBytes = DEFAULT_RESOURCE_LIMITS.maxResponseBytes, publish = null, storeLimits,
  retentionIntervalMs = RETENTION_INTERVAL_MS, timers: timerOptions = {}, roster = null, searchOptions = {},
  storeYield, startRetryDelaysMs = START_RETRY_DELAYS_MS,
} = {}) {
  const timers = { ...DEFAULT_TIMERS, ...timerOptions };
  if (!directory || typeof directory.liveActor !== 'function' || typeof directory.activeMemberIds !== 'function') {
    throw new TypeError('The team chat host needs a member directory that lists active members.');
  }
  const log = safeLogger(logger);
  let failure = null;
  let store = null;
  try {
    store = new TeamChatStore({ profileDir, clock, logger, assertSafePath,
      ...(randomBytes ? { randomBytes } : {}), ...(storeLimits ? { limits: storeLimits } : {}),
      ...(storeYield ? { yieldTo: storeYield } : {}) });
  } catch (_error) {
    failure = hostFailure('persistence', 'team_chat_store_failed');
  }
  let timer = null;
  let retryTimer = null;
  let retries = 0;
  let disposed = false;
  let retention = null;
  // The one audience rule (server/team/authorize.js), for every chat event.
  const channelAudience = (channelId) => channelMembers(directory, channelId);
  // Retention and presence run outside any command; their events go straight to the host stream.
  const emit = (type, payload, options) => {
    try { publish?.(type, payload, options); } catch (_error) { /* transport is best effort */ }
  };
  const presence = createTeamPresence({ activeMemberIds: () => directory.activeMemberIds(), publish: emit, clock,
    timers: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout } });
  const commands = createTeamChatCommands({ store, directory, audience: channelAudience, logger, clock,
    limits: { maxResponseBytes }, presence, roster, search: searchOptions,
    unavailable: () => (disposed ? hostFailure('unavailable', 'team_unavailable', '', true) : failure) });

  async function sweep() {
    try {
      const swept = await store.applyRetention();
      if (swept.ok) publishPruned(emit, channelAudience, swept.pruned);
      else log('WARN', 'team_chat.retention_failed', { reason: swept.error.reason });
    } catch (_error) {
      log('WARN', 'team_chat.retention_failed', { reason: 'team_chat_store_failed' });
    }
  }

  // One run at a time; dispose waits for the one in flight.
  function runRetention() {
    if (failure || !store || disposed) return Promise.resolve();
    if (!retention) retention = sweep().finally(() => { retention = null; });
    return retention;
  }

  // Opens the store and creates the team channel (an existing one is not an error).
  async function openTeamChannel() {
    try {
      const opened = store.open();
      const created = opened.ok ? await store.createChannel({ channelId: TEAM_CHANNEL }) : opened;
      return created.ok ? null : created;
    } catch (_error) {
      return hostFailure('persistence', 'team_chat_store_failed');
    }
  }

  // Retried only for a transient store failure: a latched store, a schema
  // refusal or a store that could not be built answers until restart.
  const retryable = () => Boolean(store) && failure?.error?.reason === 'team_chat_store_failed'
    && store.brokenReason() === null;

  function scheduleRetry() {
    if (disposed || retries >= startRetryDelaysMs.length || !retryable()) return;
    const delay = startRetryDelaysMs[retries];
    retries += 1;
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      void attemptStart(true);
    }, delay);
    retryTimer?.unref?.();
  }

  async function attemptStart(isRetry) {
    if (disposed) return { ok: false };
    const failed = await openTeamChannel();
    if (disposed) return { ok: false };
    if (failed) {
      failure = failed;
      log(isRetry ? 'WARN' : 'ERROR', isRetry ? 'team_chat.start_retry_failed' : 'team_chat.unavailable',
        { reason: failed.error.reason, attempt: retries });
      scheduleRetry();
      return { ok: false };
    }
    failure = null;
    if (isRetry) log('INFO', 'team_chat.available', { attempt: retries });
    await runRetention();
    if (!disposed && retentionIntervalMs > 0) {
      timer = timers.setInterval(() => { void runRetention(); }, retentionIntervalMs);
      timer?.unref?.();
    }
    return { ok: true };
  }

  // Never throws: a failure is kept and answered by every chat command; a
  // transient one is retried in the background (five times, with backoff).
  async function start() {
    if (failure) {
      log('ERROR', 'team_chat.unavailable', { reason: failure.error.reason });
      return { ok: false };
    }
    return attemptStart(false);
  }

  // Refuses new commands, stops the timer, then waits for a retention run in
  // flight and every store write already queued.
  async function dispose() {
    disposed = true;
    if (timer) timers.clearInterval(timer);
    timer = null;
    if (retryTimer) timers.clearTimeout(retryTimer);
    retryTimer = null;
    presence.dispose();
    await commands.drain();
    if (retention) await retention;
    if (store) await store.settled();
  }

  // From the team HTTP layer: a member's authenticated event stream opened or closed.
  const onMemberStream = (memberId, deviceId, change) => presence.streamChanged(memberId, deviceId, change);

  return Object.freeze({
    commands, channelAudience, start, dispose, runRetention, presence, onMemberStream,
    failure: () => failure,
    get store() { return store; },
  });
}

module.exports = { chatRoster, createTeamChatHost };
