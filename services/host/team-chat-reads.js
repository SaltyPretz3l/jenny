'use strict';

// Team chat store reads (row 123; split out of team-chat-store.js in slice
// 2a-3b). Methods installed on TeamChatStore.prototype. Every read is
// synchronous; a read of a channel not yet loaded loads it in one block, so
// the command layer awaits `ensureLoaded` (team-chat-loader.js) first.

const schema = require('./team-chat-schema');
const channels = require('./team-chat-channel');
const { refuse } = require('./team-chat-files');

const readMethods = {
  totalBytes() {
    let total = 0;
    for (const state of this._channels.values()) total += state.doc.bytes;
    return total;
  },

  // The latched store reason, or null (a latched store answers it until restart).
  brokenReason() { return this._broken; },

  // The committed document's view; `rev` can rise on first load after a torn write.
  _docInfo(state) {
    const doc = state.doc;
    return { channel_id: doc.channel_id, kind: doc.kind, rev: doc.rev, last_seq: doc.next_seq - 1,
      floor_seq: doc.floor_seq, archived: doc.archived !== null, broken: state.broken !== null };
  },

  // The channel document's view without loading a segment (typing's existence check).
  channelHeader(channelId) {
    return this._readOp(() => ({ ok: true, ...this._docInfo(this._channelDoc(channelId)) }));
  },

  channelInfo(channelId) {
    return this._readOp(() => {
      const state = this._channel(channelId);
      return { ok: true, ...this._docInfo(state), message_count: state.entries.length, pins: [...state.doc.pins] };
    });
  },

  listChannels() {
    return this._readOp(() => ({
      ok: true, channels: this._index.channels.map((entry) => this._docInfo(this._channels.get(entry.channel_id))),
    }));
  },

  getMessage(channelId, messageId) {
    return this._readOp(() => {
      const state = this._channel(channelId);
      const found = this._find(state, messageId);
      return { ok: true, message: found ? channels.presentMessage(state, found.message) : null };
    });
  },

  // Timeline messages (replies excluded) before `beforeSeq`: the newest page,
  // returned oldest first.
  history(channelId, { beforeSeq, limit } = {}) {
    return this._readOp(() => {
      const state = this._channel(channelId);
      const page = channels.historyPage(state, { beforeSeq, limit });
      if (!page) refuse('invalid', 'team_chat_request_invalid');
      return { ok: true, messages: this._materialize(state, page.entries), has_more: page.hasMore,
        floor_seq: state.doc.floor_seq, channel_rev: state.doc.rev };
    });
  },

  // Every message changed after `afterRev`, ordered by rev then seq.
  changedAfter(channelId, { afterRev, limit } = {}) {
    return this._readOp(() => {
      const state = this._channel(channelId);
      const page = channels.changedPage(state, { afterRev, limit });
      if (!page) refuse('invalid', 'team_chat_request_invalid');
      return { ok: true, messages: this._materialize(state, page.entries), channel_rev: state.doc.rev,
        floor_seq: state.doc.floor_seq, more: page.more };
    });
  },

  thread(channelId, { rootId, afterSeq, limit } = {}) {
    return this._readOp(() => {
      const state = this._channel(channelId);
      const root = this._rootEntry(state, rootId);
      const page = channels.threadPage(state, root, { afterSeq, limit });
      if (!page) refuse('invalid', 'team_chat_request_invalid');
      const [rootMessage, ...replies] = this._materialize(state, [root, ...page.entries]);
      return { ok: true, root: rootMessage, replies, has_more: page.hasMore };
    });
  },

  // Search's walk: one segment's visible messages before `beforeSeq` (0: from
  // the newest), newest first, as light records; `next` continues, null at the floor.
  segmentBefore(channelId, beforeSeq) {
    return this._readOp(() => {
      const state = this._channel(channelId);
      const page = channels.segmentBefore(state, beforeSeq, this._io);
      if (!page) refuse('invalid', 'team_chat_request_invalid');
      return { ok: true, messages: page.messages, next: page.next };
    });
  },

  // The unread walk: messages after `afterSeq`, newest first, every timeline
  // message and the replies whose thread `follows(rootId, members)` admits;
  // at most `limit` (1 to RECENT_LIMIT_MAX), `more` when further ones exist.
  // Light records only: { seq, author, mentions, deleted } (deleted a boolean).
  recentMessages(channelId, { afterSeq, limit, follows } = {}) {
    return this._readOp(() => {
      const state = this._channel(channelId);
      if (!schema.isCount(afterSeq) || !schema.isPositive(limit) || limit > schema.LIMITS.RECENT_LIMIT_MAX
        || typeof follows !== 'function') {
        refuse('invalid', 'team_chat_request_invalid');
      }
      const page = channels.recentEntries(state, { afterSeq, limit, follows });
      return { ok: true, messages: channels.unreadRecords(state, page.entries, this._io), more: page.more };
    });
  },

  // The thread root a message id names (itself, or a reply's root) from the
  // loaded index: no segment read and no copy. Typing uses it; post and follow
  // apply the same rule (`_rootEntry`) inside their write.
  rootIdOf(channelId, messageId) {
    return this._readOp(() => ({ ok: true, root_id: this._rootEntry(this._channel(channelId), messageId).id }));
  },
};

module.exports = { readMethods };
