'use strict';

// Team chat marks (row 123 slice 2b-1, TEAM_CHAT_SPEC "2b-1 as built"): reactions,
// pins and the edit-history read. Methods installed on TeamChatStore.prototype;
// every change goes through the store's `_rewrite` (one segment, then
// channel.json), so a crash and a race behave as they do for an edit. A torn
// pin leaves the pin list behind the record; the load repairs it
// (team-chat-channel.js). The store does not authorize: the command layer passes
// only authorized members. Every refusal happens before a write.
//
// React and pin are idempotent by state and take no entry in the request
// ledger: a change that would leave the record as it is (the repeat of one
// already committed included) answers the current revision, writes nothing and
// is flagged `unchanged` so nothing is announced.

const { isReactionEmoji } = require('./team-chat-emoji');
const { refuse } = require('./team-chat-files');
const { LIMITS } = require('./team-chat-schema');

// The reaction map after `memberId` reacts or un-reacts with `emoji`, or null
// when nothing would change. Refuses at the limits.
function reactionsWith(reactions, emoji, memberId, on) {
  const current = Object.hasOwn(reactions, emoji) ? reactions[emoji] : [];
  if (current.includes(memberId) === on) return null;
  if (!on) {
    const { [emoji]: _removed, ...rest } = reactions;
    const left = current.filter((id) => id !== memberId);
    return left.length > 0 ? { ...rest, [emoji]: left } : rest;
  }
  if (current.length === 0 && Object.keys(reactions).length >= LIMITS.REACTIONS_MAX) refuse('limit', 'team_chat_reaction_limit');
  if (current.length >= LIMITS.REACTORS_MAX) refuse('limit', 'team_chat_reaction_limit');
  return { ...reactions, [emoji]: [...current, memberId] };
}

const marksMethods = {
  // The live message a write names, under the channel lock: an archived channel,
  // a missing message and a deleted one are refused.
  _markTarget(state, messageId) {
    if (state.doc.archived) refuse('forbidden', 'team_chat_archived');
    const found = this._find(state, messageId);
    if (!found || found.message.deleted !== null) refuse('forbidden', 'team_chat_not_found');
    return found;
  },

  // The shared prelude of react and pin. `check` validates the rest of the input; `plan` returns
  // null when nothing would change, else { change, pinsAfter } for `_rewrite`.
  _mark(input, check, plan) {
    return this._afterLoad(input.channelId, () => this._mutate(() => {
      const state = this._channel(input.channelId);
      const key = this._requestKey(input);
      check();
      if (typeof input.on !== 'boolean') refuse('invalid', 'team_chat_request_invalid');
      const found = this._markTarget(state, input.messageId);
      const next = plan(found.message, key, state);
      if (next === null) return { ok: true, rev: found.message.rev, replayed: false, unchanged: true, pruned: [] };
      return this._rewrite(state, null, null, found, next.change, next.pinsAfter);
    }));
  },

  react(input = {}) {
    return this._mark(input, () => {
      if (!isReactionEmoji(input.emoji)) refuse('invalid', 'team_chat_emoji_invalid');
    }, (old, key) => {
      const reactions = reactionsWith(old.reactions, input.emoji, key.actorId, input.on);
      return reactions === null ? null : { change: (rev) => ({ ...old, reactions, rev }) };
    });
  },

  pin(input = {}) {
    return this._mark(input, () => {}, (old, key, state) => {
      if ((old.pinned !== null) === input.on) return null;
      if (input.on && state.doc.pins.length >= LIMITS.PINS_MAX) refuse('limit', 'team_chat_pin_limit');
      const pinned = input.on ? { by: key.actorId, at: this._nowIso() } : null;
      return {
        change: (rev) => ({ ...old, pinned, rev }),
        pinsAfter: (pins) => (input.on ? [...pins, old.id] : pins.filter((id) => id !== old.id)),
      };
    });
  },

  // The pinned messages in the order the channel keeps its pins, as history sends a record but with the earlier
  // versions emptied (the lean event's shape). A missing or deleted message is never listed; each segment is read once.
  pinned(channelId) {
    return this._readOp(() => {
      const state = this._channel(channelId);
      const entries = state.doc.pins.map((id) => state.byId.get(id)).filter(Boolean);
      const pins = this._materialize(state, entries).filter((message) => message.deleted === null)
        .map((message) => ({ ...message, edits: [] }));
      return { ok: true, channel_rev: state.doc.rev, pins };
    });
  },

  // The earlier versions of a message, oldest first (a deleted message keeps none).
  edits(channelId, messageId) {
    return this._readOp(() => {
      const found = this._find(this._channel(channelId), messageId);
      if (!found) refuse('forbidden', 'team_chat_not_found');
      return { ok: true, edits: found.message.edits.map((entry) => ({ ...entry })), rev: found.message.rev };
    });
  },
};

module.exports = { marksMethods };
