'use strict';

// Shared set-up for the direct-message tests (row 123 slice 2d, host half): the chat command fixture with a few
// more active members, and the helpers that open a conversation, compare answers byte for byte and read the
// serialized text a member can see.

const crypto = require('node:crypto');

const { createTeamChatCommandsFixture } = require('./team-chat-commands-fixture');

// The id of a direct conversation, worked out here on its own from the rule in the spec: `chan_dm_` and the
// SHA-256 hex of the sorted member ids joined by one line feed.
const dmIdOf = (memberIds) => `chan_dm_${crypto.createHash('sha256').update([...memberIds].sort().join('\n')).digest('hex')}`;

// A well-formed direct conversation id that names no conversation, and a message id that names no message.
const NO_SUCH_DM = `chan_dm_${'0'.repeat(64)}`;
const SOME_MESSAGE = 'msg_01ARZ3NDEKTSV4RRFFQ69G5FAV';

// The answer without its per-call request id, so two answers compare byte for byte.
function bytesOf(answer) {
  if (answer.ok !== false) return JSON.stringify(answer);
  const { request_id: requestId, ...error } = answer.error;
  if (typeof requestId !== 'string') throw new Error('a refusal carries its request id');
  return JSON.stringify({ ...answer, error });
}

async function createDmFixture(t, { extras = 0, ...options } = {}) {
  const f = await createTeamChatCommandsFixture(t, options);
  const ownerId = f.seats.owner.member_id;
  const more = [];
  for (let at = 0; at < extras; at += 1) {
    more.push((await f.fx.joinMember(f.store, ownerId, { displayName: `Extra ${at}` })).member_id);
  }
  const id = (name) => f.seats[name].member_id;
  // Seven members besides the owner who can all be active at once (the team's bound is eight): the pending seat is
  // admitted and the revoked seat's member, whose only device was revoked, is still a live member.
  const admitted = await f.store.admit({ actorMemberId: ownerId, memberId: id('pat') });
  if (!admitted.ok) throw new Error(`admit failed: ${admitted.error.reason}`);
  const sevenOthers = [id('alice'), id('bob'), id('rae'), id('pat'), id('revoked'), ...more];
  const open = (seat, others) => f.send(seat, 'team.chat.dm_open', { member_ids: others });
  return {
    ...f, id, extras: more, sevenOthers, open,
    async opened(seat, others) {
      const answer = await open(seat, others);
      if (!answer.ok) throw new Error(`dm_open failed: ${answer.error.reason}`);
      return answer.channel_id;
    },
    postIn: (seat, channelId, text) => f.send(seat, 'team.chat.post', { channel_id: channelId, text }),
    // Every operation that takes a channel id, with its parameters for `channelId` and a message of that channel.
    channelOperations: (channelId, messageId = SOME_MESSAGE) => [
      ['team.chat.history', { channel_id: channelId, limit: 5 }],
      ['team.chat.sync', { channel_id: channelId, after_rev: 0, limit: 5 }],
      ['team.chat.thread', { channel_id: channelId, root_id: messageId, limit: 5 }],
      ['team.chat.post', { channel_id: channelId, text: 'hello' }],
      ['team.chat.edit', { channel_id: channelId, message_id: messageId, text: 'x', expected_rev: 1 }],
      ['team.chat.delete', { channel_id: channelId, message_id: messageId }],
      ['team.chat.react', { channel_id: channelId, message_id: messageId, emoji: '\u{1F44D}', on: true }],
      ['team.chat.pin', { channel_id: channelId, message_id: messageId, on: true }],
      ['team.chat.pins', { channel_id: channelId }],
      ['team.chat.edits', { channel_id: channelId, message_id: messageId }],
      ['team.chat.typing', { channel_id: channelId }],
      ['team.chat.mark_read', { channel_id: channelId, seq: 1 }],
      ['team.chat.set_notify', { channel_id: channelId, level: 'none' }],
      ['team.chat.follow', { channel_id: channelId, root_id: messageId, on: true }],
      ['team.chat.search', { query: 'needle', channel_id: channelId, limit: 5 }],
    ],
  };
}

module.exports = { NO_SUCH_DM, SOME_MESSAGE, bytesOf, createDmFixture, dmIdOf };
