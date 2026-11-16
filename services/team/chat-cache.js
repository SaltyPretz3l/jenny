'use strict';

// The chat cache of one team (slice 2a-4b), in memory only: nothing from a
// team's history is ever written to disk (owner decision C6). Pure state and
// pure transitions; no I/O, no timers, no logging, so the event listener's
// deferred drain can apply events without touching anything else.
//
// Bounds: the host's own channel bound (LIMITS.CHANNELS_MAX, so every channel
// the overview lists is held), OPEN_MAX opened channels (least recently used
// dropped first) and CACHE_MESSAGES timeline messages per opened channel (the
// newest kept; replies stay out, the thread view reads them from the host).
// Every record from the host is checked with the host's own validator first;
// one that fails is treated as a gap, never cached. An opened channel's
// revision only moves past revisions it holds: a live event advances it only
// when it was level with the channel, so revisions owed a sync stay owed.
//
// A channel row also holds `reads` (another listed member's read position, at most one each, by member id) and
// `pin_count` (null while unknown). An overview replaces both; `team_chat_read` moves one position up, or this
// member's own back and forth like an answered read; a message or channel event not older than the channel's
// revision sets `pin_count` when it carries an integer 0 to 50 (a sync or an open may have raised the revision to the
// event's own first, and history pages carry no count).
//
// Slice 2a-4c: the team's members (already checked by chat-live.js, at most
// the team's member limit) are held with the channel list; an overview replaces
// them, a presence event patches one listed member, and `clear` drops them.
//
// Slice 2d: a direct conversation's row (`kind` dm) also holds `participants`, the overview's sorted member ids,
// this member's own among them, hashing to the row's id; a dm row without them is not listed. They never change
// after creation, so only an overview sets them. Team and project rows carry no `participants`.
//
// Slice 2b-3: a project row also holds `audience`, the member ids who can read the channel now (this member among
// them, ascending, so no duplicate, at most the team's eight). A row whose audience fails that check is kept without
// one, which the renderer reads as "say names"; a team or dm row never holds one. Only an overview sets it.
//
// Slice E59: a row also holds each followed thread's own unread count from a host that sends one, raised by a live
// reply in a thread known to be followed and cleared by a thread mark's answer (chat-thread-counts.js, which also
// says what the cache knows of who follows a thread). A channel read to the end keeps the threads' counts.

const { LIMITS, channelKind, dmChannelId, isCount, isMemberId, isParticipantList, isPositive, validateMessage } = require('../host/team-chat-schema');
const { byMemberId, checkedRead, checkedReads, isPinCount } = require('./chat-live');
const { isNotify } = require('./chat-shapes');
const counts = require('./chat-thread-counts');

const CHANNELS_MAX = LIMITS.CHANNELS_MAX;
const OPEN_MAX = 8;
const CACHE_MESSAGES = 200;

// A dm row's participants: the host's shape, this member among them, hashing to the row's own id.
const isOwnParticipants = (value, memberId) => isParticipantList(value.participants) && value.participants.includes(memberId)
  && dmChannelId(value.participants) === value.channel_id;

const AUDIENCE_MAX = 8;

// A project row's audience as this member keeps it, or undefined: ascending member ids, this member among them.
function checkedAudience(value, memberId) {
  const list = value.audience;
  const ok = value.kind === 'project' && Array.isArray(list) && list.length >= 1 && list.length <= AUDIENCE_MAX
    && list.every((id, at) => isMemberId(id) && (at === 0 || list[at - 1] < id)) && list.includes(memberId);
  return ok ? list : undefined;
}

function isOverviewChannel(value, memberId) {
  return Boolean(value) && typeof value === 'object' && channelKind(value.channel_id) === value.kind
    && typeof value.archived === 'boolean' && isCount(value.rev) && isCount(value.last_seq)
    && isCount(value.floor_seq) && isCount(value.last_read_seq) && isNotify(value.notify) && isCount(value.unread)
    && typeof value.unread_capped === 'boolean' && typeof value.mention === 'boolean'
    && (value.kind !== 'dm' || isOwnParticipants(value, memberId));
}

// A row from its known fields only, holding the given `reads` list and `pin_count` (and a dm's own copy of
// `participants`, a project's of an `audience` already checked).
const channelRow = (value, reads, pinCount) => ({ channel_id: value.channel_id, kind: value.kind, archived: value.archived,
  rev: value.rev, last_seq: value.last_seq, floor_seq: value.floor_seq, last_read_seq: value.last_read_seq, notify: value.notify,
  unread: value.unread, unread_capped: value.unread_capped, mention: value.mention, reads, pin_count: pinCount,
  ...(value.kind === 'dm' ? { participants: [...value.participants] } : {}),
  ...(value.kind === 'project' && Array.isArray(value.audience) ? { audience: [...value.audience] } : {}) });

// The row as the renderer gets it: its own copy, with the threads' counts from a host that sends them.
function channelCopy(channel) {
  const threads = counts.publicThreads(channel);
  return { ...channelRow(channel, channel.reads.map((read) => ({ ...read })), channel.pin_count), ...(threads ? { threads } : {}) };
}

/**
 * A valid host message record for `channelId` as the client keeps it, or null. The earlier versions (`edits`) are
 * dropped: nothing on this side reads them (`edited_at` says a message was edited; the history view asks the host
 * with team.chat.edits), and a record may carry up to 256 KiB of them.
 */
function checkedMessage(message, channelId) {
  try {
    if (!validateMessage(message, channelId)) return null;
    const { edits, ...record } = message;
    return record;
  } catch {
    return null;
  }
}

function createChatCache({ memberId }) {
  let channels = new Map();
  let members = [];
  const open = new Map();
  const known = counts.createFollowKnowledge();
  let loaded = false;

  function touch(channelId) {
    const entry = open.get(channelId);
    if (!entry) return null;
    open.delete(channelId);
    open.set(channelId, entry);
    return entry;
  }

  // Inserts or replaces timeline records by id, newest CACHE_MESSAGES kept, ordered by seq; returns the records kept.
  function upsertTimeline(entry, records) {
    const kept = [];
    for (const record of records) {
      if (record.thread_root_id !== null) continue;
      const at = entry.messages.findIndex((message) => message.id === record.id);
      if (at >= 0) {
        if (entry.messages[at].rev > record.rev) continue;
        entry.messages[at] = record;
        kept.push(record);
        continue;
      }
      // Older than the cached window and the window is full: it belongs to a page not held here.
      if (entry.messages.length >= CACHE_MESSAGES && record.seq < entry.messages[0].seq) continue;
      entry.messages.push(record);
      kept.push(record);
    }
    if (kept.length === 0) return kept;
    entry.messages.sort((a, b) => a.seq - b.seq);
    if (entry.messages.length > CACHE_MESSAGES) {
      entry.messages.splice(0, entry.messages.length - CACHE_MESSAGES);
      entry.hasMore = true;
    }
    const held = new Set(entry.messages);
    return kept.filter((record) => held.has(record));
  }

  // True when the floor has passed the oldest cached message of an opened channel.
  function floorPassed(channelId) {
    const entry = open.get(channelId);
    const channel = channels.get(channelId);
    return Boolean(entry && channel && entry.messages.length > 0 && entry.messages[0].seq < channel.floor_seq);
  }

  const listed = (id) => members.some((member) => member.member_id === id);

  function setRead(channelId, lastReadSeq) {
    const channel = channels.get(channelId);
    if (!channel || !isCount(lastReadSeq)) return;
    channel.last_read_seq = lastReadSeq;
    if (lastReadSeq < channel.last_seq) return;
    if (channel.threads) counts.readToEnd(channel);
    else { channel.unread = 0; channel.unread_capped = false; channel.mention = false; }
  }

  // A new timeline message from someone else raises the unread count (the host recounts on the next overview); a
  // new reply raises its thread's when the thread is followed (chat-thread-counts.js).
  function countNew(channel, record) {
    if (record.seq <= channel.last_seq) return;
    channel.last_seq = record.seq;
    if (record.thread_root_id !== null) { counts.countReply(channel, record, memberId, known); return; }
    if (record.deleted !== null || record.seq <= channel.last_read_seq || counts.isOwn(record, memberId)) return;
    counts.countTimeline(channel, record, memberId);
  }

  // Root records teach the implicit follow rule (and count replies held back for them).
  function sawRoots(channelId, records) {
    const channel = channels.get(channelId);
    if (channel) for (const record of records) if (record.thread_root_id === null) counts.sawRoot(channel, record, memberId, known);
  }

  return {
    get loaded() { return loaded; },
    channel: (channelId) => channels.get(channelId) || null,
    isOpen: (channelId) => open.has(channelId),
    openIds: () => [...open.keys()],
    touch,

    /** Replaces the channel list; opened channels no longer listed are dropped. Returns false for a bad answer. */
    setOverview(list) {
      if (!Array.isArray(list)) return false;
      const next = new Map();
      for (const value of list) {
        if (next.size >= CHANNELS_MAX) break;
        if (!isOverviewChannel(value, memberId) || next.has(value.channel_id)) continue;
        const threads = counts.heldThreads(value);
        next.set(value.channel_id, { ...channelRow({ ...value, audience: checkedAudience(value, memberId) }, checkedReads(value.reads, memberId),
          isPinCount(value.pin_count) ? value.pin_count : null), threads, own_mention: counts.ownMentionOf(value, threads) });
        for (const rootId of threads ? threads.keys() : []) known.learn(value.channel_id, rootId, true, false);
      }
      channels = next;
      for (const channelId of [...open.keys()]) if (!channels.has(channelId)) open.delete(channelId);
      loaded = true;
      return true;
    },

    /** Caches a channel's latest history page; the least recently opened channel goes past OPEN_MAX. */
    openChannel(channelId, page) {
      const records = Array.isArray(page?.messages) ? page.messages : [];
      const valid = records.map((message) => checkedMessage(message, channelId));
      if (valid.includes(null) || !isCount(page.channel_rev)) return false;
      const entry = { messages: [], rev: page.channel_rev, hasMore: page.has_more === true };
      upsertTimeline(entry, valid);
      sawRoots(channelId, valid);
      open.delete(channelId);
      open.set(channelId, entry);
      while (open.size > OPEN_MAX) open.delete(open.keys().next().value);
      const channel = channels.get(channelId);
      if (channel && page.channel_rev > channel.rev) channel.rev = page.channel_rev;
      if (channel && isCount(page.floor_seq)) channel.floor_seq = Math.max(channel.floor_seq, page.floor_seq);
      return true;
    },

    dropOpen(channelId) { open.delete(channelId); },

    /**
     * Replaces the members with a checked list; true when it changed. Every row's `reads` then keep listed members
     * only: the resync calls this right after setOverview (chat-client.js), the one place whole `reads` arrive.
     */
    setMembers(list) {
      const changed = JSON.stringify(list) !== JSON.stringify(members);
      members = list.map((member) => ({ ...member }));
      for (const channel of channels.values()) channel.reads = channel.reads.filter((read) => listed(read.member_id));
      return changed;
    },

    /** Patches one listed member's presence; false when the member is not listed or nothing changed. */
    patchPresence({ member_id: id, state, last_seen_at: seen }) {
      const member = members.find((entry) => entry.member_id === id);
      if (!member || (member.state === state && member.last_seen_at === seen)) return false;
      member.state = state;
      member.last_seen_at = seen;
      return true;
    },

    hasMember: listed,
    memberList: () => members.map((member) => ({ ...member })),

    cached(channelId) {
      const entry = open.get(channelId);
      return entry ? { messages: [...entry.messages], has_more: entry.hasMore, rev: entry.rev } : null;
    },

    floorPassed,

    /**
     * One `team_chat_message` event: { status: 'applied' | 'gap', changed } where `changed` is the
     * record when the renderer should hear of it. A revision already held (a reply and its root share
     * one) is applied only if the record is newer; a jump past the next revision is a gap.
     */
    applyMessage(event) {
      const channel = channels.get(event.channel_id);
      const record = channel ? checkedMessage(event.message, event.channel_id) : null;
      if (!channel || !record || !isPositive(event.channel_rev) || record.rev > event.channel_rev) return { status: 'gap' };
      const before = channel.rev;
      if (event.channel_rev > before + 1) return { status: 'gap' };
      const fresh = event.channel_rev === before + 1;
      if (event.channel_rev >= before && isPinCount(event.pin_count)) channel.pin_count = event.pin_count;
      if (fresh) {
        channel.rev = event.channel_rev;
        countNew(channel, record);
      }
      if (record.thread_root_id === null) counts.sawRoot(channel, record, memberId, known);
      const entry = open.get(event.channel_id);
      if (entry && fresh && entry.rev === before) entry.rev = event.channel_rev;
      const cachedChange = entry ? upsertTimeline(entry, [record]).length > 0 : false;
      return { status: 'applied', changed: fresh || cachedChange ? record : null };
    },

    /** One `team_chat_channel` event: { status, reload } (reload: the floor passed the cached window). */
    applyChannel(event) {
      const channel = channels.get(event.channel_id);
      // A conversation's `created` is news only when its row is not cached yet (chatDmOpen's resync may be first).
      if (channel && event.reason === 'created') return { status: 'applied', reload: false };
      if (!channel || !isPositive(event.channel_rev) || (event.reason !== 'pruned' && event.reason !== 'archived')) {
        return { status: 'gap' };
      }
      const before = channel.rev;
      if (event.channel_rev > before + 1) return { status: 'gap' };
      if (event.channel_rev >= before && isPinCount(event.pin_count)) channel.pin_count = event.pin_count;
      if (event.channel_rev === before + 1) {
        channel.rev = event.channel_rev;
        const entry = open.get(event.channel_id);
        if (entry && entry.rev === before) entry.rev = event.channel_rev;
      }
      if (event.reason === 'archived') channel.archived = true;
      if (isCount(event.floor_seq) && event.floor_seq > channel.floor_seq) {
        channel.floor_seq = event.floor_seq;
        // Pruned messages no longer count: at most one unread per seq still held after the last read.
        const held = Math.max(0, channel.last_seq - Math.max(channel.floor_seq - 1, channel.last_read_seq));
        if (channel.unread > held) { channel.unread = held; channel.unread_capped = false; }
      }
      return { status: 'applied', reload: floorPassed(event.channel_id) };
    },

    /** One sync page for an opened channel: { ok, changed } (the records the cache kept, for the renderer). */
    applySync(channelId, page) {
      const entry = open.get(channelId);
      const records = Array.isArray(page?.messages) ? page.messages.map((message) => checkedMessage(message, channelId)) : [null];
      if (!entry || records.includes(null) || !isCount(page.channel_rev)) return { ok: false, changed: [] };
      const kept = upsertTimeline(entry, records);
      sawRoots(channelId, records);
      const channel = channels.get(channelId);
      if (channel && isCount(page.floor_seq)) channel.floor_seq = Math.max(channel.floor_seq, page.floor_seq);
      return { ok: true, changed: kept };
    },

    /** Marks an opened channel consistent up to `rev` (after its last sync page). */
    settle(channelId, rev) {
      const entry = open.get(channelId);
      if (entry) entry.rev = rev;
      const channel = channels.get(channelId);
      if (channel && rev > channel.rev) channel.rev = rev;
    },

    setRead,

    /** A thread mark's answer (`threadReadSeq` null: not followed); true when the row changed. */
    clearThread(channelId, rootId, threadReadSeq) {
      const channel = channels.get(channelId);
      if (threadReadSeq === null) known.learn(channelId, rootId, false, false);
      return Boolean(channel) && counts.clearThread(channel, rootId, threadReadSeq);
    },

    /**
     * Who follows a thread, from a `chatFollow` answer (`explicit`) or a thread page's `following`. Not followed:
     * what the row held for the thread goes, as a thread read takes it. True when the row changed.
     */
    learnFollow(channelId, rootId, on, explicit) {
      known.learn(channelId, rootId, on, explicit);
      const channel = channels.get(channelId);
      return !on && Boolean(channel) && counts.clearThread(channel, rootId, null);
    },

    /** A thread page with the member's own mark: its unread replies, for a thread the row does not list. */
    sawThreadPage(channelId, rootId, page) {
      const channel = channels.get(channelId);
      if (channel) counts.sawThreadPage(channel, rootId, page, memberId);
    },

    /**
     * One `team_chat_read` event; the id of the channel whose row changed, or null. This member's own position is
     * applied as an answered read is (it moves down through their own mark-unread); another listed member's only
     * moves up. An unknown channel or member, a malformed event or a position not above the held one changes nothing.
     */
    applyRead(event) {
      const read = checkedRead(event);
      const channel = read ? channels.get(read.channel_id) : null;
      if (!channel) return null;
      if (read.member_id === memberId) {
        const [seq, unread] = [channel.last_read_seq, channel.unread];
        setRead(read.channel_id, read.seq);
        return channel.last_read_seq !== seq || channel.unread !== unread ? read.channel_id : null;
      }
      const held = channel.reads.find((entry) => entry.member_id === read.member_id);
      if (!listed(read.member_id) || read.seq <= (held ? held.seq : 0)) return null;
      if (held) held.seq = read.seq;
      else channel.reads = [...channel.reads, { member_id: read.member_id, seq: read.seq }].sort(byMemberId);
      return read.channel_id;
    },

    /** An opened channel's cached timeline message as { rev, edited_at, deleted }, or null (a thread reply is not held). */
    record(channelId, messageId) {
      const message = open.get(channelId)?.messages.find((entry) => entry.id === messageId);
      return message ? { rev: message.rev, edited_at: message.edited_at, deleted: message.deleted } : null;
    },

    setNotify(channelId, level) {
      const channel = channels.get(channelId);
      if (channel && isNotify(level)) channel.notify = level;
    },

    channelList: () => [...channels.values()].map(channelCopy),
    /** The listed channels among `ids`, as the renderer sees them. */
    channelsOf: (ids) => [...ids].filter((channelId) => channels.has(channelId)).map((channelId) => channelCopy(channels.get(channelId))),
    messageCount: () => [...open.values()].reduce((sum, entry) => sum + entry.messages.length, 0),

    clear() {
      channels = new Map();
      members = [];
      open.clear();
      known.clear();
      loaded = false;
    },
  };
}

module.exports = { CACHE_MESSAGES, CHANNELS_MAX, OPEN_MAX, checkedMessage, createChatCache };
