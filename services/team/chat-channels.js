'use strict';

// Channel management on the desktop chat client (row 173, the team channels plan). Four online-only
// methods, each one host operation, none stored, none in the outbox and none retried by this client:
//   chatChannelCreate { name, topic? }                          -> { ok, channel_id, rev }
//   chatChannelUpdate { channel_id, name?, topic?, expected_rev } -> { ok, rev }
//   chatChannelArchive { channel_id, on }                       -> { ok, rev }   (`on: false` unarchives)
//   chatChannelDelete { channel_id }                            -> { ok }
// The payloads are checked in main (ipc-methods.js); the host applies the name and topic rules and decides who may.
// A refusal is the host's own code and reason. A success is rebuilt from checked fields only (host output is
// untrusted), then one overview resync is asked so the new, changed or removed row reaches the renderer even if its
// event was missed. A create waits until the new row is cached (as opening a direct conversation does), so the
// renderer can open the channel as soon as the answer arrives.

const { channelKind, isCount } = require('../host/team-chat-schema');
const { chatFailure, invalidRequest } = require('./team-errors');

const invalid = () => invalidRequest('team_chat_answer_invalid');

const created = (reply) => (channelKind(reply.channel_id) === 'channel' && isCount(reply.rev)
  ? { ok: true, channel_id: reply.channel_id, rev: reply.rev } : invalid());
const revised = (reply) => (isCount(reply.rev) ? { ok: true, rev: reply.rev } : invalid());
const removed = () => ({ ok: true });

/**
 * The methods over the client's own `ready` (online, cache loaded), `direct` (one checked command), the cache and
 * `resync` ({ ask, pending, next }, the chat client's floor-paced overview resync, as chat-dm.js takes it).
 */
function createChatChannels({ cache, ready, direct, resync }) {
  async function run(operation, params, check) {
    const refused = await ready();
    if (refused) return refused;
    const answer = await direct(operation, params, (reply) => (reply && reply.ok === true ? check(reply) : chatFailure(reply)));
    if (!answer.ok) return answer;
    resync.ask();
    if (answer.channel_id) while (resync.pending() && !cache.channel(answer.channel_id)) await resync.next();
    return answer;
  }

  return {
    methods: {
      chatChannelCreate: (value) => run('team.chat.channel_create', value, created),
      chatChannelUpdate: (value) => run('team.chat.channel_update', value, revised),
      chatChannelArchive: (value) => run('team.chat.channel_archive', value, revised),
      chatChannelDelete: (value) => run('team.chat.channel_delete', value, removed),
    },
  };
}

module.exports = { createChatChannels };
