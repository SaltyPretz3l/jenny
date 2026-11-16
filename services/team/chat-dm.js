'use strict';

// Direct messages on the desktop chat client (TEAM_CHAT_SPEC "2d renderer as built"). One online-only method, never
// stored and never in the outbox:
//   chatDmOpen { member_ids }  ->  { ok, channel_id }
// `member_ids` are the other participants (1 to 7 distinct member ids, never this member's own: main refuses that
// before anything is sent). The host answers the same id for the same people, so opening a conversation that exists
// shows it again. The answer's id must be a direct conversation's id and hash to these participants with this member
// added; anything else is `team_chat_answer_invalid`.
//
// The renderer opens the answered id at once, so the call answers only once the cache lists it: a new conversation
// is announced to its participants as a `team_chat_channel` event, which the cache treats as a gap while the row is
// not cached (a full resync brings the row with its `participants`). When the row is not cached yet, the call waits
// for the resync that is running or pending, or asks one when none is, always under the resync floor (repeated
// Starts never force one), until the row is cached or no resync is left (offline, stopped). A refusal (`team_chat_dm_members_invalid`, the rate limit, the disk gate) is answered as it comes,
// mapped by team-errors.js. No log line carries a member id or the conversation's id.

const { channelKind, dmChannelId } = require('../host/team-chat-schema');
const { chatFailure, invalidRequest } = require('./team-errors');

/**
 * The method over the client's own `ready` (online, cache loaded), `direct` (one checked command), the cache and
 * `resync`: `ask()` (one floor-paced resync unless one is running), `pending()` (one is asked, armed or running while
 * online) and `next()` (resolves when the loop next releases its snapshot waiters).
 */
function createChatDm({ memberId, cache, ready, direct, resync }) {
  async function open({ member_ids: memberIds }) {
    const refused = await ready();
    if (refused) return refused;
    const expected = dmChannelId([memberId, ...memberIds]);
    const answer = await direct('team.chat.dm_open', { member_ids: memberIds }, (reply) => {
      if (!reply || reply.ok !== true) return chatFailure(reply);
      const id = reply.channel_id;
      return channelKind(id) === 'dm' && id === expected ? { ok: true, channel_id: id } : invalidRequest('team_chat_answer_invalid');
    });
    if (answer.ok && !cache.channel(answer.channel_id)) {
      resync.ask();
      while (resync.pending() && !cache.channel(answer.channel_id)) await resync.next();
    }
    return answer;
  }

  return { methods: { chatDmOpen: (value) => open(value) } };
}

module.exports = { createChatDm };
