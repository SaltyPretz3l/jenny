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
//   - the `team_chat_message` and `team_chat_channel` events, always with an
//     audience, and the ephemeral `team_chat_typing` (2a-3b);
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
const { boundPage, fitOne, overviewChannels, overviewMembers, pageBudget } = require('./team-chat-pages');
const { LIMITS } = require('./team-chat-schema');
const { createTeamChatSearch } = require('./team-chat-search');

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
  'team.chat.follow'];
const DISK_GATED = new Set(['team.chat.post', 'team.chat.edit']);
const PUBLISHING = new Set(['team.chat.post', 'team.chat.edit', 'team.chat.delete', 'team.chat.typing']);
// Operations that read a channel's messages before the store's own write
// waits for its load: the yielding first load runs before them. Post and
// follow wait inside the store; typing, search and the overview load what
// they read themselves.
const LOADS = new Set(['team.chat.history', 'team.chat.sync', 'team.chat.thread', 'team.chat.edit',
  'team.chat.delete']);

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
      channel_rev: report.channel_rev }, { audience: audience(report.channel_id), bucket: chatBucket(report.channel_id) });
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
  };
  const finder = store ? createTeamChatSearch({ store, clock: searchClock, ...searchBounds,
    visible: (channelId, actor) => audience(channelId).has(actor.member_id) }) : null;

  function sendMessage(publish, channelId, channelRev, record) {
    publish('team_chat_message', { channel_id: channelId, channel_rev: channelRev,
      message: fitOne(record, EVENT_MESSAGE_BUDGET) }, { audience: audience(channelId), bucket: chatBucket(channelId) });
  }

  // Prune reports first (a prune is its own revision before the change that
  // needed it), then the changed record; a new reply also sends its root, whose
  // reply count changed. An edit of a reply leaves the root alone.
  function announce(publish, channelId, result, messageId, { withRoot = false } = {}) {
    publishPruned(publish, audience, result.pruned);
    const read = store.getMessage(channelId, messageId);
    if (!read.ok || !read.message) return;
    sendMessage(publish, channelId, result.rev, read.message);
    if (!withRoot || read.message.thread_root_id === null) return;
    const root = store.getMessage(channelId, read.message.thread_root_id);
    if (root.ok && root.message) sendMessage(publish, channelId, result.rev, root.message);
  }

  const page = (kind, read) => boundPage(kind, read, budget);
  const READS = {
    'team.chat.overview': async ({ actor }) => {
      const channels = await overviewChannels(store, actor.member_id,
        (channelId) => audience(channelId).has(actor.member_id));
      return channels.ok ? { ...channels, members: overviewMembers(roster, presence) } : channels;
    },
    'team.chat.search': ({ params, actor }) => finder.search({ params, actor }),
    'team.chat.history': ({ params }) => page('history', store.history(params.channel_id,
      { beforeSeq: params.before_seq, limit: params.limit })),
    'team.chat.sync': ({ params }) => page('sync', store.changedAfter(params.channel_id,
      { afterRev: params.after_rev, limit: params.limit })),
    'team.chat.thread': ({ params }) => page('thread', store.thread(params.channel_id,
      { rootId: params.root_id, afterSeq: params.after_seq, limit: params.limit })),
  };

  const MUTATIONS = {
    'team.chat.post': async ({ params, key, publish }) => {
      const channelId = params.channel_id;
      const posted = await store.post({ ...key, channelId, text: params.text,
        mentions: extractMentions(params.text, audience(channelId)),
        ...(params.refs === undefined ? {} : { refs: params.refs }),
        ...(params.thread_root_id === undefined ? {} : { threadRootId: params.thread_root_id }) });
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
    'team.chat.mark_read': async ({ params, actor }) => {
      const marked = await store.markRead({ channelId: params.channel_id, actorId: actor.member_id, seq: params.seq,
        ...(params.unread === undefined ? {} : { unread: params.unread }) });
      return marked.ok ? { ok: true, last_read_seq: marked.last_read_seq } : marked;
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
    // Ephemeral: never stored or replayed. After the header check (no segment
    // read), an early repeat from the device answers ok, publishes nothing
    // and reads nothing. The thread root is checked like any other id and
    // resolved from the loaded index (`rootIdOf`: no segment read, no copy).
    'team.chat.typing': async ({ params, actor, live, publish }) => {
      const channelId = params.channel_id;
      const header = store.channelHeader(channelId);
      if (!header.ok) return header;
      if (header.archived) return hostFailure('forbidden', 'team_chat_archived');
      if (typing.take(live.device_id) !== true) return { ok: true };
      let rootId = null;
      if (params.thread_root_id !== undefined) {
        await store.ensureLoaded(channelId);
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

  // Limits, the disk gate and a usable publisher, decided before any store call.
  function admission(operation, memberId, canAdmit, publish) {
    const limiter = Object.hasOwn(LIMITED, operation) ? LIMITED[operation] : null;
    if (limiter && limiter.take(memberId) !== true) return hostFailure('limit', 'team_chat_rate_limit');
    if (DISK_GATED.has(operation) && (typeof canAdmit !== 'function' || canAdmit() !== true)) {
      return hostFailure('unavailable', 'disk_pressure', '', true);
    }
    if (PUBLISHING.has(operation) && typeof publish !== 'function') return hostFailure('unavailable', 'team_unavailable');
    return null;
  }

  async function answer(command, context, { canAdmit, publish }) {
    const operation = command.operation;
    const read = Object.hasOwn(READS, operation) ? READS[operation] : null;
    const mutate = Object.hasOwn(MUTATIONS, operation) ? MUTATIONS[operation] : null;
    if (!read && !mutate) return hostFailure('invalid', 'unsupported_operation');
    const live = directory.liveActor(context?.deviceId);
    if (!live || typeof live.member_id !== 'string' || !live.member_id || live.state !== 'active') {
      return hostFailure('forbidden', 'role_forbidden');
    }
    const down = unavailable() || (store ? null : hostFailure('persistence', 'team_chat_store_failed'));
    if (down) return down;
    const actor = { member_id: live.member_id, owner: live.role === 'owner' };
    const refused = admission(operation, live.member_id, canAdmit, publish);
    if (refused) return refused;
    if (LOADS.has(operation)) {
      const loading = store.ensureLoaded(command.params.channel_id);
      // Awaited only while a load is in flight: an await of a settled promise
      // still defers a turn, which would let a later command reach the
      // store's write chain first and break call order when nothing loads.
      if (store.isLoading(command.params.channel_id)) await loading;
    }
    if (read) return read({ params: command.params, actor });
    const key = { actorId: live.member_id, deviceId: live.device_id, requestId: command.request_id };
    return mutate({ params: command.params, actor, live, key, publish });
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
