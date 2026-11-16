'use strict';

// The team chat commands on the host (row 123 slices 2a-3a and 2a-3b,
// TEAM_CHAT_SPEC "API and realtime"). The router has already validated the closed params schema
// and run the one authorization function for the command: the role, the
// pending state and whether the channel is visible are decided there, before
// this module runs, and are not checked a second time. What this module adds
// is what the authorizer cannot know:
//
//   - the live member id, read again from the directory for the device; a
//     missing, pending or invite actor is refused, never served as the owner;
//   - the author rules (edit by the author, delete by the author or owner),
//     read with `getMessage` before the store is called;
//   - mention tokens resolved against the channel audience;
//   - per-member limits, the disk gate and the byte bound on read pages;
//   - the `team_chat_message`, `team_chat_channel` and `team_chat_read` events,
//     always with an audience, and the ephemeral `team_chat_typing` (2a-3b);
//   - search (team-chat-search.js) and the presence report (team-presence.js);
//   - the store's yielding first load, awaited before a channel is read.
//
// Chat never uses the shared receipt store or the admin limiter: the chat
// store keeps its own idempotency entries. The team commands stamp the request
// id on a failure. Message text, mention lists and refs never reach a log or an
// error payload: logs carry the operation and a fixed reason only.

const { hostFailure } = require('../../server/api-contract');
const { chatBucket } = require('../../server/team/authorize');
const { createRateLimiter } = require('../../server/team/rate-limit');
const { safeLogger } = require('../../server/team/safe-logger');
const { boundEdits, boundPage, fitOne, overviewChannels, overviewMembers, pageBudget } = require('./team-chat-pages');
const { LIMITS, dmChannelId } = require('./team-chat-schema');
const { createTeamChatSearch } = require('./team-chat-search');
const { followsFor, threadMarkOf } = require('./team-chat-thread-marks');

const MENTION_TOKEN = /<@(member_[A-Za-z0-9_-]{1,64}|jenny|channel)>/gu;
// A message event's record stays well under the stream's 512 KiB frame limit,
// so a heavily edited message never turns into a resync for the whole team.
const EVENT_MESSAGE_BUDGET = 256 * 1024;
// Every limiter table holds at most the member bound of keys.
const KEYS = LIMITS.MEMBERS_MAX;
// Spec "Failure reasons": 30 posts and 60 other mutations per member per minute.
const POST_LIMIT = Object.freeze({ limit: 30, windowMs: 60_000, maxKeys: KEYS });
const MUTATION_LIMIT = Object.freeze({ limit: 60, windowMs: 60_000, maxKeys: KEYS });
// Slice 2a-3b: 10 searches and 20 overviews per 10 s per member (a client
// resyncs at most once a second); one typing event per 3 s and 30 presence
// changes a minute per device.
const SEARCH_LIMIT = Object.freeze({ limit: 10, windowMs: 10_000, maxKeys: KEYS });
const OVERVIEW_LIMIT = Object.freeze({ limit: 20, windowMs: 10_000, maxKeys: KEYS });
const TYPING_LIMIT = Object.freeze({ limit: 1, windowMs: 3_000, maxKeys: KEYS });
const PRESENCE_LIMIT = Object.freeze({ limit: 30, windowMs: 60_000, maxKeys: KEYS });
const OTHER_MUTATIONS = ['team.chat.edit', 'team.chat.delete', 'team.chat.mark_read', 'team.chat.set_notify',
  'team.chat.follow', 'team.chat.dm_open'];
// Reactions and pins are the most frequent writes: their own table, so a burst never blocks a read mark or an edit.
const MARKS = ['team.chat.react', 'team.chat.pin'];
// Post and edit grow a record, and so do adding a reaction and pinning; removing one and delete shrink it and are never gated.
const DISK_GATED = new Set(['team.chat.post', 'team.chat.edit']);
const GATED_WHEN_ADDING = new Set(MARKS);
const PUBLISHING = new Set(['team.chat.post', 'team.chat.edit', 'team.chat.delete', 'team.chat.typing',
  'team.chat.react', 'team.chat.pin', 'team.chat.mark_read', 'team.chat.dm_open']);
// Operations that read a channel's messages before the store's own write
// waits for its load: the yielding first load runs before them. Post waits
// inside the store (the recorded limit: it lands); typing, search and the
// overview load what they read themselves and check again after (review round two, R07-F04).
const LOADS = new Set(['team.chat.history', 'team.chat.sync', 'team.chat.thread', 'team.chat.edit',
  'team.chat.delete', 'team.chat.react', 'team.chat.pin', 'team.chat.edits', 'team.chat.pins']);
// Writes whose store call waits for the channel's load before it writes read.json: follow always, a read mark when
// the store says it will (a thread's mark, or a channel mark that moves). Their load runs here first, so the
// check after it comes before the write.
const waitsForLoad = (store, operation, params, memberId) => LOADS.has(operation) || operation === 'team.chat.follow'
  || (operation === 'team.chat.mark_read' && store.markReadLoads({ channelId: params.channel_id, actorId: memberId,
    seq: params.seq, unread: params.unread, threadRootId: params.thread_root_id }));

// Mention tokens in the wire text, in order and unique: member ids only when
// they are in the channel audience, `jenny` and `channel` always, at most 16.
function extractMentions(text, audience) {
  const mentions = [];
  if (typeof text !== 'string') return mentions;
  for (const match of text.matchAll(MENTION_TOKEN)) {
    if (mentions.length >= LIMITS.MENTIONS_MAX) break;
    const token = match[1];
    if (mentions.includes(token) || (token.startsWith('member_') && !audience.has(token))) continue;
    mentions.push(token);
  }
  return mentions;
}

// One `team_chat_channel` event per prune report, each to its own channel's audience.
function publishPruned(publish, audience, reports) {
  for (const report of Array.isArray(reports) ? reports : []) {
    publish('team_chat_channel', { channel_id: report.channel_id, reason: 'pruned', floor_seq: report.floor_seq,
      channel_rev: report.channel_rev, pin_count: report.pin_count }, { audience: audience(report.channel_id), bucket: chatBucket(report.channel_id) });
  }
}

// A failure that still carries the store's prune reports (a prune committed
// before the mutation failed) announces them, and answers without them.
function failedWithPrunes(publish, audience, failure) {
  if (!Array.isArray(failure.pruned)) return failure;
  const { pruned, ...answer } = failure;
  publishPruned(publish, audience, pruned);
  return answer;
}

// The operations the team commands hand to chat: every `team.chat.*` and the
// presence report.
function handles(operation) {
  return typeof operation === 'string' && (operation.startsWith('team.chat.') || operation === 'team.presence.set');
}

function createTeamChatCommands({
  store, directory, audience, logger = null, limits = {}, clock = Date.now, unavailable = () => null,
  presence = null, roster = null, search: { clock: searchClock = clock, ...searchBounds } = {},
} = {}) {
  if (!directory || typeof directory.liveActor !== 'function') throw new TypeError('Team chat commands need a directory.');
  if (typeof audience !== 'function') throw new TypeError('Team chat commands need a channel audience.');
  if (typeof unavailable !== 'function') throw new TypeError('Team chat commands need an availability check.');
  const log = safeLogger(logger);
  const budget = pageBudget(limits.maxResponseBytes);
  const mutations = createRateLimiter({ ...MUTATION_LIMIT, clock });
  const marks = createRateLimiter({ ...MUTATION_LIMIT, clock });
  const typing = createRateLimiter({ ...TYPING_LIMIT, clock });
  const presenceReports = createRateLimiter({ ...PRESENCE_LIMIT, clock });
  // The member-keyed limit each operation spends before anything runs.
  // Typing and the presence report are limited per device in their
  // handlers: typing answers an early repeat ok and silently, and a presence
  // report that changes nothing spends nothing.
  const LIMITED = {
    'team.chat.post': createRateLimiter({ ...POST_LIMIT, clock }),
    'team.chat.search': createRateLimiter({ ...SEARCH_LIMIT, clock }),
    'team.chat.overview': createRateLimiter({ ...OVERVIEW_LIMIT, clock }),
    ...Object.fromEntries(OTHER_MUTATIONS.map((operation) => [operation, mutations])),
    ...Object.fromEntries(MARKS.map((operation) => [operation, marks])),
  };
  const finder = store ? createTeamChatSearch({ store, clock: searchClock, ...searchBounds,
    visible: (channelId, actor) => audience(channelId).has(actor.member_id) }) : null;

  function sendMessage(publish, channelId, channelRev, record) {
    const header = store.channelHeader(channelId);
    publish('team_chat_message', { channel_id: channelId, channel_rev: channelRev, pin_count: header.ok ? header.pin_count : 0,
      message: fitOne(record, EVENT_MESSAGE_BUDGET) }, { audience: audience(channelId), bucket: chatBucket(channelId) });
  }

  // Prune reports first (a prune is its own revision before the change that
  // needed it), then the changed record; a new reply also sends its root, whose
  // reply count changed. An edit of a reply leaves the root alone.
  // `lean` (a reaction or pin) sends the record without its earlier versions: they did not change, the
  // client fetches them with `team.chat.edits`, and a toggle must not cost a frame the size of the history.
  function announce(publish, channelId, result, messageId, { withRoot = false, lean = false } = {}) {
    publishPruned(publish, audience, result.pruned);
    const read = store.getMessage(channelId, messageId);
    if (!read.ok || !read.message) return;
    sendMessage(publish, channelId, result.rev, lean ? { ...read.message, edits: [] } : read.message);
    if (!withRoot || read.message.thread_root_id === null) return;
    const root = store.getMessage(channelId, read.message.thread_root_id);
    if (root.ok && root.message) sendMessage(publish, channelId, result.rev, root.message);
  }

  const page = (kind, read) => boundPage(kind, read, budget);

  // The thread page with whether the asking member follows it: the unread rule (`followsFor`) over the member's
  // own follow list and the thread's members, read in the same synchronous step as the page (no await between
  // them), and (E59) the member's own mark for the thread. Only this member's answer is used. When either read
  // fails the page still answers, without the fields.
  function threadPage(params, actor) {
    const read = store.thread(params.channel_id, { rootId: params.root_id, afterSeq: params.after_seq, limit: params.limit });
    if (read.ok !== true) return read;
    const state = store.readState(params.channel_id, actor.member_id);
    const thread = state.ok ? store.threadMembers(params.channel_id, read.root.id) : null;
    if (!thread?.ok) return page('thread', read);
    return page('thread', { ...read, following: followsFor(actor.member_id, state.followed)(read.root.id, thread.members),
      read_seq: threadMarkOf(state, read.root.id, thread.members) });
  }

  const READS = {
    'team.chat.overview': async ({ actor }) => {
      const channels = await overviewChannels(store, actor.member_id,
        (channelId) => audience(channelId).has(actor.member_id), audience);
      return channels.ok ? { ...channels, members: overviewMembers(roster, presence) } : channels;
    },
    'team.chat.search': ({ params, actor }) => finder.search({ params, actor }),
    'team.chat.history': ({ params }) => page('history', store.history(params.channel_id,
      { beforeSeq: params.before_seq, limit: params.limit })),
    'team.chat.sync': ({ params }) => page('sync', store.changedAfter(params.channel_id,
      { afterRev: params.after_rev, limit: params.limit })),
    'team.chat.thread': ({ params, actor }) => threadPage(params, actor),
    'team.chat.edits': ({ params }) => boundEdits(store.edits(params.channel_id, params.message_id), budget),
    'team.chat.pins': ({ params }) => page('pins', store.pinned(params.channel_id)),
  };

  // Reacting and pinning are idempotent by state: a change that would leave the record as it is (a repeat
  // included) answers the current revision and announces nothing.
  const markHandler = (call) => async ({ params, key, publish }) => {
    const channelId = params.channel_id;
    const marked = await call({ ...key, channelId, messageId: params.message_id, emoji: params.emoji, on: params.on });
    if (!marked.ok) return failedWithPrunes(publish, audience, marked);
    if (marked.unchanged !== true) announce(publish, channelId, marked, params.message_id, { lean: true });
    return { ok: true, rev: marked.rev };
  };

  const MUTATIONS = {
    'team.chat.post': async ({ params, key, publish }) => {
      const channelId = params.channel_id;
      const posted = await store.post({ ...key, channelId, text: params.text,
        mentions: extractMentions(params.text, audience(channelId)),
        ...(params.refs === undefined ? {} : { refs: params.refs }),
        ...(params.thread_root_id === undefined ? {} : { threadRootId: params.thread_root_id }),
        ...(params.attachment_ids === undefined ? {} : { attachmentIds: params.attachment_ids }) });
      if (!posted.ok) return failedWithPrunes(publish, audience, posted);
      if (posted.replayed !== true) announce(publish, channelId, posted, posted.message_id, { withRoot: true });
      return { ok: true, message_id: posted.message_id, seq: posted.seq, rev: posted.rev };
    },
    // Only the author edits, and only a member's own message (not a Jenny reply).
    'team.chat.edit': async ({ params, actor, key, publish }) => {
      const channelId = params.channel_id;
      const current = store.getMessage(channelId, params.message_id);
      if (!current.ok) return current;
      const message = current.message;
      if (message && message.deleted === null
        && !(message.author.kind === 'member' && message.author.member_id === actor.member_id)) {
        return hostFailure('forbidden', 'role_forbidden');
      }
      const edited = await store.edit({ ...key, channelId, messageId: params.message_id, text: params.text,
        expectedRev: params.expected_rev, mentions: extractMentions(params.text, audience(channelId)) });
      if (!edited.ok) return failedWithPrunes(publish, audience, edited);
      if (edited.replayed !== true) announce(publish, channelId, edited, params.message_id);
      return { ok: true, rev: edited.rev };
    },
    // The author (the member id on the record) or the owner deletes.
    'team.chat.delete': async ({ params, actor, key, publish }) => {
      const channelId = params.channel_id;
      const current = store.getMessage(channelId, params.message_id);
      if (!current.ok) return current;
      const message = current.message;
      const live = Boolean(message) && message.deleted === null;
      if (live && message.author.member_id !== actor.member_id && !actor.owner) {
        return hostFailure('forbidden', 'role_forbidden');
      }
      const deleted = await store.delete({ ...key, channelId, messageId: params.message_id });
      if (!deleted.ok) return failedWithPrunes(publish, audience, deleted);
      // An already-deleted message answers its tombstone's revision and announces
      // nothing, decided by the store inside its write chain (two concurrent
      // deletes announce once).
      if (deleted.replayed !== true && deleted.already_deleted !== true) {
        announce(publish, channelId, deleted, params.message_id);
      }
      return { ok: true, rev: deleted.rev };
    },
    'team.chat.react': markHandler((input) => store.react(input)),
    'team.chat.pin': markHandler((input) => store.pin(input)),
    // The position is stored for replay and sent to the channel audience only when it really moved. A thread's own
    // mark (E59, `thread_root_id`) is this member's alone: it is never published (their other devices learn it at
    // their next overview).
    'team.chat.mark_read': async ({ params, actor, publish }) => {
      const marked = await store.markRead({ channelId: params.channel_id, actorId: actor.member_id, seq: params.seq,
        ...(params.unread === undefined ? {} : { unread: params.unread }),
        ...(params.thread_root_id === undefined ? {} : { threadRootId: params.thread_root_id }) });
      if (!marked.ok) return marked;
      if (params.thread_root_id !== undefined) {
        return { ok: true, last_read_seq: marked.last_read_seq, thread_read_seq: marked.thread_read_seq };
      }
      if (marked.changed) {
        publish('team_chat_read', { channel_id: params.channel_id, member_id: actor.member_id, seq: marked.last_read_seq },
          { audience: audience(params.channel_id), bucket: chatBucket(params.channel_id) });
      }
      return { ok: true, last_read_seq: marked.last_read_seq };
    },
    'team.chat.set_notify': async ({ params, actor }) => {
      const set = await store.setNotify({ channelId: params.channel_id, actorId: actor.member_id, level: params.level });
      return set.ok ? { ok: true, level: set.level } : set;
    },
    'team.chat.follow': async ({ params, actor }) => {
      const followed = await store.follow({ channelId: params.channel_id, actorId: actor.member_id,
        rootId: params.root_id, on: params.on });
      return followed.ok ? { ok: true, root_id: followed.root_id, on: followed.on } : followed;
    },
    // A direct conversation (2d). Every named member must be active now and none the caller; any other case is
    // one refusal that says nothing of which id was wrong. Only a new conversation is announced.
    'team.chat.dm_open': async ({ params, actor, publish }) => {
      const active = new Set(directory.activeMemberIds());
      if (params.member_ids.includes(actor.member_id) || !params.member_ids.every((memberId) => active.has(memberId))) {
        return hostFailure('invalid', 'team_chat_dm_members_invalid');
      }
      const opened = await store.openDirect({ memberIds: [actor.member_id, ...params.member_ids] });
      if (!opened.ok) return opened;
      if (opened.created) {
        publish('team_chat_channel', { channel_id: opened.channel_id, reason: 'created', floor_seq: 1,
          channel_rev: opened.rev, pin_count: 0 }, { audience: audience(opened.channel_id), bucket: chatBucket(opened.channel_id) });
      }
      return { ok: true, channel_id: opened.channel_id };
    },
    // Ephemeral: never stored or replayed. After the header check (no segment
    // read), an early repeat from the device answers ok, publishes nothing
    // and reads nothing. The thread root is checked like any other id and
    // resolved from the loaded index (`rootIdOf`: no segment read, no copy).
    'team.chat.typing': async ({ params, actor, live, publish, loaded }) => {
      const channelId = params.channel_id;
      const header = store.channelHeader(channelId);
      if (!header.ok) return header;
      if (header.archived) return hostFailure('forbidden', 'team_chat_archived');
      if (typing.take(live.device_id) !== true) return { ok: true };
      let rootId = null;
      if (params.thread_root_id !== undefined) {
        const checked = await (loaded(channelId) ?? { live });
        if (checked.denied) return checked.denied;
        const found = store.rootIdOf(channelId, params.thread_root_id);
        if (!found.ok) return found;
        rootId = found.root_id;
      }
      publish('team_chat_typing', { channel_id: channelId, thread_root_id: rootId, member_id: actor.member_id },
        { audience: audience(channelId), bucket: chatBucket(channelId), ephemeral: true });
      return { ok: true };
    },
    // A report that changes nothing (the same state, or a device with no
    // stream) answers ok and spends nothing; a change spends one of the
    // device's 30 a minute, never the shared mutation budget.
    'team.presence.set': async ({ params, actor, live }) => {
      if (!presence) return hostFailure('unavailable', 'team_unavailable');
      const idle = params.state === 'idle';
      if (!presence.wouldChange(actor.member_id, live.device_id, idle)) return { ok: true };
      if (presenceReports.take(live.device_id) !== true) return hostFailure('limit', 'team_chat_rate_limit');
      presence.setIdle(actor.member_id, live.device_id, idle);
      return { ok: true };
    },
  };

  // Opening a conversation that is already stored writes nothing, so a full disk does not refuse it. The id comes
  // from the asker and the named members alone, and the asker is one of its participants.
  function directExists(memberId, params) {
    return Array.isArray(params?.member_ids) && store.participantsOf(dmChannelId([memberId, ...params.member_ids])) !== null;
  }

  // Limits, the disk gate and a usable publisher, decided before any store call.
  function admission(operation, params, memberId, canAdmit, publish) {
    const limiter = Object.hasOwn(LIMITED, operation) ? LIMITED[operation] : null;
    if (limiter && limiter.take(memberId) !== true) return hostFailure('limit', 'team_chat_rate_limit');
    const gated = DISK_GATED.has(operation) || (GATED_WHEN_ADDING.has(operation) && params?.on === true)
      || (operation === 'team.chat.dm_open' && !directExists(memberId, params));
    if (gated && (typeof canAdmit !== 'function' || canAdmit() !== true)) {
      return hostFailure('unavailable', 'disk_pressure', '', true);
    }
    if (PUBLISHING.has(operation) && typeof publish !== 'function') return hostFailure('unavailable', 'team_unavailable');
    return null;
  }

  // A command that awaited its channel's load is checked again before it reads or
  // writes: `recheck` is the router's check (server/team/team-commands.js), and the
  // actor must still be the same active member. Without `recheck` it is refused.
  function stillAllowed(live, context, recheck) {
    const denied = typeof recheck === 'function' ? recheck() : hostFailure('forbidden', 'role_forbidden');
    if (denied) return { denied };
    const fresh = directory.liveActor(context?.deviceId);
    if (!fresh || fresh.member_id !== live.member_id || fresh.state !== 'active') {
      return { denied: hostFailure('forbidden', 'role_forbidden') };
    }
    return { live: fresh };
  }

  // Starts the channel's load; while one is in flight, a promise of the check after it, else null (an await of a
  // settled promise still defers a turn, which would let a later command reach the store's write chain first).
  function loadChecked(channelId, live, context, recheck) {
    const loading = store.ensureLoaded(channelId);
    if (!store.isLoading(channelId)) return null;
    return loading.then(() => stillAllowed(live, context, recheck));
  }

  async function answer(command, context, { canAdmit, publish, recheck }) {
    const operation = command.operation;
    const read = Object.hasOwn(READS, operation) ? READS[operation] : null;
    const mutate = Object.hasOwn(MUTATIONS, operation) ? MUTATIONS[operation] : null;
    if (!read && !mutate) return hostFailure('invalid', 'unsupported_operation');
    let live = directory.liveActor(context?.deviceId);
    if (!live || typeof live.member_id !== 'string' || !live.member_id || live.state !== 'active') {
      return hostFailure('forbidden', 'role_forbidden');
    }
    const down = unavailable() || (store ? null : hostFailure('persistence', 'team_chat_store_failed'));
    if (down) return down;
    const refused = admission(operation, command.params, live.member_id, canAdmit, publish);
    if (refused) return refused;
    const held = waitsForLoad(store, operation, command.params, live.member_id)
      ? loadChecked(command.params.channel_id, live, context, recheck) : null;
    if (held) {
      const checked = await held;
      if (checked.denied) return checked.denied;
      live = checked.live;
    }
    const actor = { member_id: live.member_id, owner: live.role === 'owner' };
    if (read) return read({ params: command.params, actor });
    const key = { actorId: live.member_id, deviceId: live.device_id, requestId: command.request_id };
    return mutate({ params: command.params, actor, live, key, publish,
      loaded: (channelId) => loadChecked(channelId, live, context, recheck) });
  }

  // Commands admitted and not yet answered (bounded by the host's request
  // capacity), so the host's dispose can wait for one that awaits a load.
  const inFlight = new Set();

  async function run(command, context, options) {
    let result;
    try {
      result = await answer(command, context, options || {});
    } catch (_error) {
      result = hostFailure('unavailable', 'team_unavailable', '', true);
    }
    if (result?.ok !== true) log('INFO', 'team_chat.refused', { operation: command.operation, reason: result?.error?.reason });
    return result;
  }

  function dispatch(command, context, options = {}) {
    const answered = run(command, context, options);
    inFlight.add(answered);
    answered.finally(() => { inFlight.delete(answered); });
    return answered;
  }

  // Resolves once every command already dispatched has answered.
  async function drain() {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  }

  return Object.freeze({ dispatch, drain, handles });
}

module.exports = { createTeamChatCommands, extractMentions, publishPruned };
