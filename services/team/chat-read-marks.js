'use strict';

// The read marks, follows and thread reads of one team's chat client (moved out of chat-client.js in slice E59).
//
// - A channel mark goes through its own coalescer (chat-reads.js), as before.
// - A thread's own mark (E59, `thread_root_id`) goes through a second coalescer keyed by channel and thread, so a
//   thread mark is coalesced like a channel mark (the first at once, then at most one per window, the highest seq)
//   and never waits for, or delays, a channel mark. The answer clears the thread's count in the cache. A refusal
//   or a lost answer changes nothing here; the renderer asks again (renderer-team-chat-reads.js).
// - A `chatFollow` answer and a thread page's `following` teach the cache who follows the thread; an answered
//   unfollow takes the thread's count off the row. A thread page with the member's own mark (`read_seq`) lets the
//   cache take a thread the row does not list off the row's count when it is marked.
//
// `ready(channelId)` answers a refusal or null; `direct(operation, params, check)` sends when online;
// `pushTouched(ids)` tells the renderer which rows changed.

const { LIMITS } = require('../host/team-chat-schema');
const { fieldsAnswer, threadAnswer } = require('./chat-answers');
const { createReadCoalescer } = require('./chat-reads');

const KEY_GAP = ' ';

function createChatReadMarks({ cache, ready, direct, pushTouched, timers, failure }) {
  const reads = createReadCoalescer({ timers, failure, send: (channelId, seq, unread) => sendRead(channelId, seq, unread) });
  const threadReads = createReadCoalescer({ timers, failure, send: (key, seq) => sendThreadRead(key, seq) });

  // One mark_read send for the channel coalescer.
  async function sendRead(channelId, seq, unread) {
    const params = { channel_id: channelId, seq, ...(unread ? { unread: true } : {}) };
    const answer = await direct('team.chat.mark_read', params, (reply) => fieldsAnswer(reply, ['last_read_seq']));
    if (answer.ok) { cache.setRead(channelId, answer.last_read_seq); pushTouched(new Set([channelId])); }
    return answer;
  }

  // One thread mark send: the channel mark in the answer is the host's own (it did not move).
  async function sendThreadRead(key, seq) {
    const [channelId, rootId] = key.split(KEY_GAP);
    const answer = await direct('team.chat.mark_read', { channel_id: channelId, seq, thread_root_id: rootId },
      (reply) => fieldsAnswer(reply, ['last_read_seq', 'thread_read_seq']));
    if (answer.ok && cache.clearThread(channelId, rootId, answer.thread_read_seq)) pushTouched(new Set([channelId]));
    return answer;
  }

  // `unread` with `thread_root_id` is refused before this (ipc-methods.js), as the host refuses it.
  async function markRead(value) {
    const refused = await ready(value.channel_id);
    if (refused) return refused;
    if (value.thread_root_id !== undefined) {
      return threadReads.request(value.channel_id + KEY_GAP + value.thread_root_id, value.seq, false);
    }
    return reads.request(value.channel_id, value.seq, value.unread === true);
  }

  async function follow(value) {
    const answer = await direct('team.chat.follow', value, (reply) => fieldsAnswer(reply, ['root_id', 'on']));
    if (answer.ok && cache.learnFollow(value.channel_id, answer.root_id, answer.on, true)) pushTouched(new Set([value.channel_id]));
    return answer;
  }

  async function thread(value) {
    const limit = value.limit || LIMITS.THREAD_LIMIT_MAX;
    const answer = await direct('team.chat.thread', { ...value, limit },
      (page) => threadAnswer(page, value.channel_id, value.root_id, limit));
    if (answer.ok && typeof answer.following === 'boolean') {
      const changed = cache.learnFollow(value.channel_id, answer.root.id, answer.following, false);
      cache.sawThreadPage(value.channel_id, answer.root.id, answer);
      if (changed) pushTouched(new Set([value.channel_id]));
    }
    return answer;
  }

  return {
    methods: {
      chatMarkRead: (value) => markRead(value),
      chatFollow: (value) => follow(value),
      chatThread: (value) => thread(value),
    },
    clear(answer) {
      reads.clear(answer);
      threadReads.clear(answer);
    },
  };
}

module.exports = { createChatReadMarks };
