'use strict';

// The chat client of one team in the Electron main process (slice 2a-4b,
// TEAM_CHAT_SPEC "Desktop client" and "Resume after a disconnect").
//
// It activates on the renderer's first chat call (or at start when the outbox
// holds entries) and then subscribes to the connection manager's events. A late
// subscriber sees no earlier event, so a snapshot (team.chat.overview) always
// comes first. The listener runs synchronously in the socket's data handler: it
// only queues the event and defers a drain; the drain applies events to the
// in-memory cache (chat-cache.js) and pushes what changed. All network work runs
// in one loop, one step at a time: a resync (on a revision gap, resync_required,
// a new boot epoch, reconnecting or activation: overview, then team.chat.sync
// from the cached revision for each opened channel whose revision moved, paged
// by the last returned message's rev until `more` is false, at most
// SYNC_PAGES_MAX pages before the latest page is loaded instead), a channel
// reload (the floor passed the cached window: the latest page again), a channel
// the renderer opens, then the outbox (chat-outbox.js), which only sends once a
// sync has completed. Events that arrive during a resync are buffered and
// applied after it, so nothing is lost or applied twice.
//
// Resync pacing: a failed resync waits for its backoff timer, and while a
// resync timer is armed nothing but that timer (or a reconnect, which clears
// it) starts one; a resync wanted within a second of a successful one waits on
// a timer for the rest of that second. A failed resync answers every channel
// waiting to open. Direct reads (older history, threads, read, notify, follow)
// need the member online and pass the host's answer through chat-answers.js.
//
// The renderer gets message records, channel counts and its own queued text,
// never a request id, key, token or address. Logs carry the team id, fixed
// reasons and counts; never message text or a draft.
//
// Slice 2a-4c: the overview's members (checked by chat-live.js; a list that
// fails makes the overview `team_chat_answer_invalid`) are cached and pushed
// when a resync changes them; `team_presence` patches a listed member and is
// pushed (one naming an unlisted member asks for a floor-paced resync); `team_chat_typing` is pushed only for a listed channel and another
// listed member, never cached. Search is a checked direct read; typing sends at
// most once per 3 s per channel and thread; presence sends only a change and
// the held state once after each reconnect; reads are coalesced per channel (chat-reads.js). None of them is queued.
// Slice E59: read marks (channel and thread), follows and thread reads live in chat-read-marks.js.

const { LIMITS } = require('../host/team-chat-schema');
const { fieldsAnswer, historyAnswer, searchAnswer } = require('./chat-answers');
const { CHANNELS_MAX, createChatCache } = require('./chat-cache');
const { checkedMembers, checkedPresence, checkedTyping, createPresenceHold, createTypingGate } = require('./chat-live');
const { createChatChannels } = require('./chat-channels');
const { createChatDm } = require('./chat-dm');
const { createChatMarks } = require('./chat-marks');
const { createChatOutbox } = require('./chat-outbox');
const { createChatReadMarks } = require('./chat-read-marks');
const { chatFailure, invalidRequest, teamFailure } = require('./team-errors');

const HISTORY_PAGE = LIMITS.HISTORY_LIMIT_MAX;
const SYNC_LIMIT = LIMITS.SYNC_LIMIT_MAX;
// Past this many sync pages (600 changed messages) the latest page costs less than the rest of the sync.
const SYNC_PAGES_MAX = 3;
// Events waiting for a drain, and events buffered during a resync; past either bound the client resyncs.
const QUEUE_MAX = 2000;
const BUFFER_MAX = 2000;
const RESYNC_BACKOFF = Object.freeze({ initialMs: 1000, maxMs: 60_000 });
const RESYNC_FLOOR_MS = 1000;
const CHAT_EVENTS = new Set(['team_chat_message', 'team_chat_channel', 'resync_required', 'team_presence',
  'team_chat_typing', 'team_chat_read', 'team_project_changed']);
// Slice 2b-3: a project change that can move a project channel's audience asks for one overview resync.
const AUDIENCE_REASONS = new Set(['members', 'deleting', 'deleted']);
// A search page when the renderer names no limit.
const SEARCH_PAGE = 20;

function createChatClient({
  teamId, manager, store, push = () => {}, log = () => {}, timers = { setTimeout, clearTimeout }, defer = setImmediate,
  now = Date.now, randomId,
}) {
  const memberId = manager.snapshot().member_id;
  const cache = createChatCache({ memberId });
  const queue = [];
  const buffer = [];
  const reloads = new Set();
  let reloading = null;
  const opening = new Map();
  let active = false;
  let stopped = false;
  let unsubscribe = null;
  let drainQueued = false;
  let syncing = false;
  let needResync = false;
  let forceResync = false;
  let pumping = null;
  let lastEpoch = null;
  let connected = false;
  let resyncFailures = 0;
  let resyncTimer = null;
  let lastResyncAt = null;
  let lastFailure = null;
  const snapshotWaiters = [];

  const say = (level, event, fields = {}) => { try { log(level, event, { team_id: teamId, ...fields }); } catch { /* best effort */ } };
  const send = (type, fields) => { if (!stopped) { try { push({ team_id: teamId, type, ...fields }); } catch { /* best effort */ } } };
  const online = () => !stopped && manager.snapshot().state === 'online';
  const command = (operation, params, options) => manager.command(operation, params, options);
  const pushChannels = () => send('channels', { channels: cache.channelList() });
  // Only the channels an event batch or a read touched; the full list goes with a resync and the overview.
  const pushTouched = (ids) => { if (ids.size > 0) send('channels', { channels: cache.channelsOf(ids), partial: true }); };
  const pushMessages = (channelId, messages, reset = false) => {
    if (reset || messages.length > 0) send('messages', { channel_id: channelId, messages, reset });
  };
  const notConnected = () => (lastFailure ? chatFailure(lastFailure) : teamFailure('CONNECTION_FAILED', 'team_not_connected'));
  const notFound = () => teamFailure('CHAT_NOT_FOUND', 'team_chat_not_found');
  const stoppedFailure = () => teamFailure('HOST_STOPPED', 'team_connection_stopped');
  const typingGate = createTypingGate({ now, max: CHANNELS_MAX });
  const presence = createPresenceHold();
  const readMarks = createChatReadMarks({ cache, ready, direct, pushTouched, timers,
    failure: teamFailure('CONNECTION_FAILED', 'team_unavailable') });
  const marks = createChatMarks({ cache, ready, direct, syncChannel });
  const resyncHook = { ask: () => { if (!syncing) needResync = true; pump(); },
    pending: () => active && !stopped && online() && (needResync || syncing || resyncTimer !== null), next: () => new Promise((resolve) => { snapshotWaiters.push(resolve); }) };
  const channelOps = createChatChannels({ cache, ready, direct, resync: resyncHook });
  const dms = createChatDm({ memberId, cache, ready, direct, resync: resyncHook });

  const outbox = createChatOutbox({
    store, timers, now, ...(randomId ? { randomId } : {}), recordOf: cache.record, reconcile: marks.reconcile,
    send: (operation, params, requestId) => command(operation, params, { requestId }),
    onChange: (list, settled) => send('outbox', { outbox: list, settled }),
    onWake: () => pump(),
  });

  // ---------------------------------------------------------------- events

  function listener(event) {
    // Other host events matter only when they carry a new boot epoch.
    if (stopped || (!CHAT_EVENTS.has(event?.event_type) && event?.boot_epoch === lastEpoch)) return;
    if (queue.length >= QUEUE_MAX) { queue.length = 0; needResync = true; } else queue.push(event);
    if (!drainQueued) { drainQueued = true; defer(drain); }
  }

  function drain() {
    drainQueued = false;
    if (stopped) return;
    const events = queue.splice(0, queue.length);
    if (syncing) {
      // Typing shown after the fact is wrong: it is dropped during a resync, never buffered (presence is buffered).
      const kept = events.filter((event) => event.event_type !== 'team_chat_typing');
      if (buffer.length + kept.length > BUFFER_MAX) { buffer.length = 0; needResync = true; } else buffer.push(...kept);
      return;
    }
    applySafely(events);
    pump();
  }

  // Applies events to the cache (no I/O but the pushes at the end).
  function apply(events) {
    const changed = new Map();
    const touched = new Set();
    let listChanged = false;
    for (const event of events) {
      if (typeof event.boot_epoch === 'string') {
        if (lastEpoch !== null && event.boot_epoch !== lastEpoch) needResync = true;
        lastEpoch = event.boot_epoch;
      }
      if (event.event_type === 'resync_required') needResync = true;
      if (event.event_type === 'team_project_changed' && AUDIENCE_REASONS.has(event.reason)) needResync = true;
      if (needResync || !cache.loaded) continue;
      if (event.event_type === 'team_chat_message') {
        const result = cache.applyMessage(event);
        if (result.status === 'gap') { needResync = true; continue; }
        touched.add(event.channel_id);
        if (!result.changed) continue;
        const list = changed.get(event.channel_id);
        if (list) list.push(result.changed);
        else changed.set(event.channel_id, [result.changed]);
      } else if (event.event_type === 'team_chat_channel') {
        const result = cache.applyChannel(event);
        if (result.status === 'gap') { needResync = true; continue; }
        touched.add(event.channel_id);
        if (result.removed) listChanged = true;
        if (result.reload) reloads.add(event.channel_id);
      } else if (event.event_type === 'team_presence') {
        const changed = checkedPresence(event);
        if (changed && !cache.hasMember(changed.member_id)) needResync = true;
        else if (changed && cache.patchPresence(changed)) send('presence', changed);
      } else if (event.event_type === 'team_chat_typing') {
        // Never cached: only another listed member typing in a listed channel reaches the renderer.
        const typing = checkedTyping(event);
        if (typing && typing.member_id !== memberId && cache.channel(typing.channel_id) && cache.hasMember(typing.member_id)) {
          send('typing', typing);
        }
      } else if (event.event_type === 'team_chat_read') {
        // No channel_rev: never a revision gap, never a resync.
        const readChannel = cache.applyRead(event);
        if (readChannel) touched.add(readChannel);
      }
    }
    // A removed channel is no longer in the cache to be touched: the whole list goes.
    if (listChanged) pushChannels(); else pushTouched(touched);
    for (const [channelId, messages] of changed) pushMessages(channelId, messages);
  }

  // A throw while applying (a fault, never an expected answer) is logged with a fixed reason and resyncs.
  function applySafely(events) {
    try {
      apply(events);
    } catch {
      needResync = true;
      say('WARN', 'team.chat.drain_failed');
    }
  }

  // ---------------------------------------------------------------- network steps

  // Pages team.chat.sync from `fromRev` until `more` is false; false when the channel must be reloaded instead.
  async function syncChannel(channelId, fromRev) {
    let after = fromRev;
    for (let pages = 0; pages < SYNC_PAGES_MAX; pages += 1) {
      const page = await command('team.chat.sync', { channel_id: channelId, after_rev: after, limit: SYNC_LIMIT });
      if (stopped || !page.ok) return false;
      const applied = cache.applySync(channelId, page);
      if (!applied.ok) return false;
      pushMessages(channelId, applied.changed);
      if (cache.floorPassed(channelId)) return false;
      const last = page.messages[page.messages.length - 1];
      if (page.more !== true || !last) { cache.settle(channelId, page.channel_rev); return true; }
      if (!(last.rev > after)) return false;
      after = last.rev;
    }
    return false;
  }

  // Loads a channel's latest page into the cache, then syncs anything committed since that page.
  async function loadLatest(channelId) {
    const page = await command('team.chat.history', { channel_id: channelId, limit: HISTORY_PAGE });
    if (stopped) return page;
    if (!page.ok || !cache.openChannel(channelId, page)) {
      cache.dropOpen(channelId);
      pushMessages(channelId, [], true);
      return page.ok ? invalidRequest('team_chat_answer_invalid') : page;
    }
    const channel = cache.channel(channelId);
    const held = cache.cached(channelId);
    if (channel && held.rev < channel.rev && !(await syncChannel(channelId, held.rev))) {
      // The page is older than the channel and its catch-up failed: a resync brings the rest.
      needResync = true;
      say('INFO', 'team.chat.reload_resync');
    }
    pushMessages(channelId, cache.cached(channelId)?.messages || [], true);
    return { ok: true };
  }

  async function resync() {
    syncing = true;
    try {
      const overview = await command('team.chat.overview', {});
      if (stopped) return false;
      const members = overview.ok ? checkedMembers(overview.members) : null;
      if (!overview.ok || !members || !cache.setOverview(overview.channels)) {
        lastFailure = overview.ok ? invalidRequest('team_chat_answer_invalid') : overview;
        return false;
      }
      // Pushed at once: a channel sync below may still fail, and the retry would see the list unchanged.
      if (cache.setMembers(members)) send('members', { members: cache.memberList() });
      for (const channelId of cache.openIds()) {
        const held = cache.cached(channelId);
        if (cache.floorPassed(channelId)) { await loadLatest(channelId); continue; }
        if (held.rev === cache.channel(channelId).rev) continue;
        if (!(await syncChannel(channelId, held.rev))) await loadLatest(channelId);
      }
      pushChannels();
      outbox.connectionResumed();
      lastFailure = null;
      return true;
    } finally {
      syncing = false;
      applySafely(buffer.splice(0, buffer.length));
    }
  }

  // Arms the one resync timer; its firing is the only thing that starts a resync while it is armed.
  function armResync(delay) {
    if (resyncTimer !== null || stopped) return;
    resyncTimer = timers.setTimeout(() => { resyncTimer = null; forceResync = true; pump(); }, delay);
    if (resyncTimer && typeof resyncTimer.unref === 'function') resyncTimer.unref();
  }

  function retryResyncLater() {
    const delay = Math.min(RESYNC_BACKOFF.maxMs, RESYNC_BACKOFF.initialMs * (2 ** Math.min(resyncFailures, 30)));
    resyncFailures += 1;
    armResync(delay);
  }

  // Answers every parked open; a resync failure answers with its own reason, going offline with the plain one.
  function failOpens(answer = notConnected()) {
    if (opening.size === 0) return;
    for (const waiters of opening.values()) for (const resolve of waiters) resolve(answer);
    opening.clear();
  }

  // Wakes the calls that wait for the snapshot (overview and a first history) once a sync is done or the loop ends.
  function releaseSnapshot() {
    for (const resolve of snapshotWaiters.splice(0, snapshotWaiters.length)) resolve();
  }

  async function loop() {
    while (active && !stopped && online()) {
      if (needResync || !cache.loaded) {
        if (resyncTimer !== null) { if (resyncFailures > 0) failOpens(); return; }
        const wait = forceResync || lastResyncAt === null ? 0 : lastResyncAt + RESYNC_FLOOR_MS - now();
        if (wait > 0) { armResync(wait); return; }
        needResync = false;
        forceResync = false;
        if (await resync()) { resyncFailures = 0; lastResyncAt = now(); continue; }
        needResync = true;
        say('INFO', 'team.chat.resync_failed', { reason: lastFailure ? chatFailure(lastFailure).error.reason : 'invalid_answer' });
        retryResyncLater();
        failOpens();
        return;
      }
      releaseSnapshot();
      const owed = presence.take();
      // The held presence, once after a reconnect, sent without holding the loop; a failure leaves it to the next
      // change or reconnect.
      if (owed !== null) {
        void Promise.resolve().then(() => command('team.presence.set', { state: owed }))
          .then((sent) => { if (!sent?.ok) presence.failed(owed); }, () => presence.failed(owed));
      }
      if (reloads.size > 0) {
        const channelId = reloads.values().next().value;
        reloads.delete(channelId);
        // A channel that left the open set has nothing to reload: its waiters stay for the opening step below.
        if (!cache.isOpen(channelId)) continue;
        reloading = channelId;
        let reloaded;
        try { reloaded = await loadLatest(channelId); } finally { reloading = null; }
        // A first-page read of this channel waits on the reload (history() parks it with the opens).
        const parked = opening.get(channelId);
        if (parked) { opening.delete(channelId); for (const resolve of parked) resolve(reloaded); }
        continue;
      }
      if (opening.size > 0) {
        const [channelId, waiters] = opening.entries().next().value;
        opening.delete(channelId);
        // A throw (a fault) still answers the waiters; the loop's catch then logs it.
        let answer = teamFailure('CONNECTION_FAILED', 'team_chat_open_failed');
        try {
          answer = cache.channel(channelId) ? await loadLatest(channelId) : notFound();
        } finally {
          for (const resolve of waiters) resolve(answer);
        }
        continue;
      }
      const sent = await outbox.sendNext();
      if (sent !== 'sent' && sent !== 'failed') return;
    }
  }

  function pump() {
    if (!active || stopped) return pumping || Promise.resolve();
    if (!pumping) {
      pumping = loop().catch(() => {
        say('WARN', 'team.chat.loop_failed');
        needResync = true;
        retryResyncLater();
        failOpens();
      }).finally(() => {
        pumping = null;
        releaseSnapshot();
        // Work that arrived as the loop ended starts a new pass, unless a resync timer holds it.
        if (!stopped && online() && resyncTimer === null && (needResync || reloads.size > 0 || opening.size > 0)) pump();
      });
    }
    return pumping;
  }

  async function settle() {
    for (let round = 0; round < 1000 && pumping; round += 1) await pumping;
  }

  // Waits for the snapshot (the sync that loads or refreshes the cache) and not for the outbox sends behind it.
  async function snapshotReady() {
    if (!pumping || (cache.loaded && !needResync && !syncing)) return;
    await new Promise((resolve) => { snapshotWaiters.push(resolve); });
  }

  function activate() {
    if (active || stopped) return;
    active = true;
    connected = online();
    unsubscribe = manager.onEvent(listener);
    needResync = true;
    pump();
  }

  // ---------------------------------------------------------------- renderer operations

  async function overview() {
    activate();
    await snapshotReady();
    if (!cache.loaded) return notConnected();
    return { ok: true, channels: cache.channelList(), outbox: outbox.list(), members: cache.memberList(), reaction_emoji: marks.emoji };
  }

  // A command answered straight to the renderer: only when online, and only through its check.
  async function direct(operation, params, check) {
    if (!online()) return notConnected();
    return check(await command(operation, params));
  }

  async function history({ channel_id: channelId, before_seq: beforeSeq, limit = HISTORY_PAGE }) {
    activate();
    if (beforeSeq !== undefined) {
      return direct('team.chat.history', { channel_id: channelId, before_seq: beforeSeq, limit },
        (page) => historyAnswer(page, channelId, limit));
    }
    await snapshotReady();
    if (!cache.loaded) return notConnected();
    // Only a channel the overview listed is opened, so waiting opens stay within CHANNELS_MAX.
    if (!cache.channel(channelId)) return notFound();
    if (!cache.isOpen(channelId) || reloads.has(channelId) || reloading === channelId) {
      if (!online()) return notConnected();
      const answer = await new Promise((resolve) => {
        const waiters = opening.get(channelId);
        if (waiters) waiters.push(resolve);
        else opening.set(channelId, [resolve]);
        pump();
      });
      if (!answer.ok) return chatFailure(answer);
    }
    cache.touch(channelId);
    const held = cache.cached(channelId);
    if (!held) return notConnected();
    return { ok: true, messages: held.messages, has_more: held.has_more };
  }

  // Activates and waits for the cache; then the member must be online and the channel listed (else nothing is sent).
  async function ready(channelId) {
    activate();
    // Only a first load is waited for, and only its snapshot: a loaded cache answers at once, even while the outbox sends.
    if (!cache.loaded) await snapshotReady();
    if (!online() || !cache.loaded) return notConnected();
    if (channelId !== undefined && !cache.channel(channelId)) return notFound();
    return null;
  }

  async function search(value) {
    const refused = await ready(value.channel_id);
    if (refused) return refused;
    const limit = value.limit || SEARCH_PAGE;
    const scope = value.channel_id;
    const isListed = (channelId) => Boolean(cache.channel(channelId)) && (scope === undefined || channelId === scope);
    return direct('team.chat.search', { ...value, limit }, (page) => searchAnswer(page, isListed, limit));
  }

  async function typing(value) {
    const refused = await ready(value.channel_id);
    if (refused) return refused;
    const rootId = value.thread_root_id || null;
    if (!typingGate.allow(value.channel_id, rootId)) return { ok: true };
    // Only a send the host never answered (not connected, stopped, lost) releases the window; a refusal keeps it.
    let fromHost = false;
    const answer = await direct('team.chat.typing', value, (reply) => {
      fromHost = typeof reply?.error?.code === 'string' && reply.error.code.startsWith('CMP-HOST-');
      return fieldsAnswer(reply, []);
    });
    if (!answer.ok && !fromHost) typingGate.forget(value.channel_id, rootId);
    return answer;
  }

  // Offline the state is held (the reconnect sends it) and nothing is sent.
  async function presenceSet({ state }) {
    activate();
    const isOnline = online();
    const due = presence.want(state, isOnline);
    if (!isOnline) return notConnected();
    if (!due) return { ok: true };
    const answer = await direct('team.presence.set', { state }, (reply) => fieldsAnswer(reply, []));
    if (!answer.ok) presence.failed(state);
    return answer;
  }

  async function setNotify(value) {
    const answer = await direct('team.chat.set_notify', value, (reply) => fieldsAnswer(reply, ['level']));
    if (answer.ok) { cache.setNotify(value.channel_id, answer.level); pushTouched(new Set([value.channel_id])); }
    return answer;
  }

  function queued(operation, params) {
    activate();
    const answer = outbox.enqueue(operation, params);
    pump();
    return answer;
  }

  // Each takes the checked payload without its team id (team-chat.js strips it).
  const METHODS = {
    chatOverview: () => overview(),
    chatHistory: (value) => history(value),
    chatPost: (value) => queued('team.chat.post', value),
    chatEdit: (value) => queued('team.chat.edit', value),
    chatDelete: (value) => queued('team.chat.delete', value),
    chatSetNotify: (value) => setNotify(value),
    chatDraftGet: (value) => ({ ok: true, text: store.getDraft(value.channel_id, value.thread_root_id || null) }),
    chatDraftSet: (value) => {
      const set = store.setDraft(value.channel_id, value.thread_root_id || null, value.text);
      return set.ok ? { ok: true } : invalidRequest(set.reason);
    },
    chatOutboxDiscard: (value) => outbox.discard(value.entry_id),
    chatSearch: (value) => search(value),
    chatTyping: (value) => typing(value),
    presenceSet: (value) => presenceSet(value),
    ...marks.methods, ...dms.methods, ...channelOps.methods, ...readMarks.methods,
  };

  return {
    activate,
    handle: (method, value) => (stopped ? Promise.resolve(stoppedFailure())
      : Promise.resolve().then(() => METHODS[method](value))),

    /** The manager's state changed: reconnecting online clears any resync timer and resyncs (then sends the outbox). */
    connectionChanged(state) {
      if (!active || stopped) return;
      if (state === 'online' && !connected) {
        connected = true;
        presence.reconnected();
        if (resyncTimer !== null) timers.clearTimeout(resyncTimer);
        resyncTimer = null;
        forceResync = true;
        needResync = true;
        pump();
        return;
      }
      if (state !== 'online') {
        connected = false;
        failOpens(teamFailure('CONNECTION_FAILED', 'team_not_connected'));
      }
    },

    flushDrafts: () => store.flush(),

    /** Test only (and stop): waits until no drain is queued and no loop runs. */
    async idle() {
      for (let round = 0; round < 1000; round += 1) {
        await settle();
        await new Promise((resolve) => { setImmediate(resolve); });
        if (!pumping && !drainQueued) return;
      }
    },

    /** Test only: the channel list and each opened channel's cached messages. */
    snapshot() {
      const open = {};
      for (const channelId of cache.openIds()) open[channelId] = cache.cached(channelId);
      return { channels: cache.channelList(), open, members: cache.memberList() };
    },
    messageCount: () => cache.messageCount(),

    // Stops at once: no listener, no timer, no further write; the cache is dropped.
    dispose({ flush = true } = {}) {
      if (stopped) return;
      failOpens();
      stopped = true;
      releaseSnapshot();
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      if (resyncTimer !== null) timers.clearTimeout(resyncTimer);
      resyncTimer = null;
      outbox.stop();
      readMarks.clear(stoppedFailure());
      marks.clear(stoppedFailure());
      typingGate.clear();
      presence.clear();
      queue.length = 0;
      buffer.length = 0;
      cache.clear();
      if (flush) store.close();
      else store.kill();
    },

    /** Revoked: drafts and outbox are emptied on disk and the cache dropped, at once. */
    purge() {
      store.purge();
      this.dispose({ flush: false });
    },

    async stop({ flush = true } = {}) {
      this.dispose({ flush });
      await settle();
    },
  };
}

module.exports = { HISTORY_PAGE, SYNC_LIMIT, createChatClient };
