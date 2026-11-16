'use strict';

// Reactions, pins, edit history and pinned messages on the desktop chat client (TEAM_CHAT_SPEC "2b-1c as built").
// Four online-only methods, none stored and none in the outbox:
//   chatReact { channel_id, message_id, emoji, on }  chatPin { channel_id, message_id, on }   -> { ok, rev }
//   chatEdits { channel_id, message_id }             chatPins { channel_id }                  -> reads, rebuilt from checked fields
//
// Marks go through a queue (createMarkQueue), per key (a reaction: channel, message, emoji; a pin: channel, message):
//   - sends run one at a time in call order; a newer call waits behind the send in flight and a still newer one
//     replaces it, so every waiting caller gets the answer of the send that carried the final state;
//   - nothing is ever sent twice by this module (the host takes no request-ledger entry for marks, so a late duplicate
//     would apply again): a failed send is answered to its callers and left to the renderer, and a call held behind it
//     is still sent, its caller asked for that state;
//   - the table holds one entry per key with a send in flight or held, at most MARKS_MAX; a new key past that is
//     refused with the retry-later failure;
//   - `clear` answers every held caller and closes the queue, as the read coalescer does (chat-reads.js).
//
// `reconcile` serves the outbox (chat-outbox.js): a reaction or pin raises a message's revision, so an edit queued at
// the older one answers team_chat_stale. The channel is synced once and the cached record handed back, so the outbox
// can decide whether only marks moved the revision.

const { REACTION_EMOJI } = require('../host/team-chat-emoji');
const { editsAnswer, fieldsAnswer, pinsAnswer } = require('./chat-answers');
const { teamFailure } = require('./team-errors');

const MARKS_MAX = 64;
const FAILURE = teamFailure('CONNECTION_FAILED', 'team_unavailable');

function createMarkQueue() {
  // key -> { held: { run, waiters } | null }
  const entries = new Map();
  let closed = null;
  const answerAll = (waiters, answer) => { for (const resolve of waiters) resolve(answer); };

  // Runs the sends of one key until nothing is held: the first, then the final state of whatever was held meanwhile.
  async function drive(key, entry, first) {
    let current = first;
    while (current) {
      let answer;
      try { answer = await current.run(); } catch { answer = FAILURE; }
      answerAll(current.waiters, answer);
      if (entries.get(key) !== entry) return;
      current = entry.held;
      entry.held = null;
    }
    entries.delete(key);
  }

  return {
    /** Sends `run()` for `key` in order; a promise of the answer of the send that carried this call's state. */
    request(key, run) {
      if (closed) return Promise.resolve(closed);
      const entry = entries.get(key);
      if (entry) {
        return new Promise((resolve) => {
          if (entry.held) { entry.held.run = run; entry.held.waiters.push(resolve); } else entry.held = { run, waiters: [resolve] };
        });
      }
      if (entries.size >= MARKS_MAX) return Promise.resolve(teamFailure('CHAT_RETRY_LATER', 'team_chat_rate_limit'));
      const fresh = { held: null };
      entries.set(key, fresh);
      return new Promise((resolve) => { void drive(key, fresh, { run, waiters: [resolve] }); });
    },

    /** Answers every held caller `answer` and closes: a later call gets `answer`, a send in flight answers its own caller. */
    clear(answer) {
      closed = answer;
      for (const entry of entries.values()) if (entry.held) answerAll(entry.held.waiters, answer);
      entries.clear();
    },

    size: () => entries.size,
  };
}

/**
 * The four methods over the client's own `ready` (online, cache loaded, channel listed) and `direct` (one checked
 * command), the queue, and the single sync an edit made stale by marks needs.
 */
function createChatMarks({ cache, ready, direct, syncChannel }) {
  const queue = createMarkQueue();

  async function mark(key, operation, params) {
    const refused = await ready(params.channel_id);
    if (refused) return refused;
    return queue.request(key, () => direct(operation, params, (reply) => fieldsAnswer(reply, ['rev'])));
  }

  async function read(operation, params, check) {
    const refused = await ready(params.channel_id);
    return refused || direct(operation, params, check);
  }

  return {
    methods: {
      chatReact: (v) => mark(`react ${v.channel_id} ${v.message_id} ${v.emoji}`, 'team.chat.react', v),
      chatPin: (v) => mark(`pin ${v.channel_id} ${v.message_id}`, 'team.chat.pin', v),
      chatEdits: (v) => read('team.chat.edits', v, editsAnswer),
      chatPins: (v) => read('team.chat.pins', v, (answer) => pinsAnswer(answer, v.channel_id)),
    },

    /** Syncs the channel once and returns the cached record of the message ({ rev, edited_at, deleted }), or null. */
    async reconcile(channelId, messageId) {
      const held = cache.cached(channelId);
      if (!held || !(await syncChannel(channelId, held.rev))) return null;
      return cache.record(channelId, messageId);
    },

    emoji: REACTION_EMOJI,
    clear: queue.clear,
  };
}

module.exports = { createChatMarks, createMarkQueue };
