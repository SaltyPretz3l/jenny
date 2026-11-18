'use strict';

// The four channel operations on the host (row 173, TEAM_CHANNELS_2026-11-16.md "Operations"): create, update,
// archive or unarchive, and delete. The router has validated the params and run the registry's authorize (the role
// and the channel's visibility: `chat.channel.create` on the team, `chat.channel.manage` on the channel); the
// dispatcher (team-chat-commands.js) has resolved the live actor and spent the mutation limit. This module adds the
// rules the authorizer cannot know, read from the channel document (no segment load):
//
//   - a project or direct channel: `team_chat_channel_fixed` for every operation here;
//   - `#team`: a name change, archive and delete are fixed; its topic is the owner's (`role_forbidden`);
//   - a custom channel: update and archive by its creator or the owner; unarchive and delete by the owner;
//
// then calls the store, which checks names, the cap, staleness and the archived state inside its write chain, and
// announces a change as `team_chat_channel` to the channel's audience. Archive, unarchive and delete are audited
// through the injected `audit` ({ kind, actor_member_id, channel_id, name } => { ok } or a failure, written before
// the change commits); without it a change that would need an entry is refused `team_unavailable` (a repeat that
// changes nothing needs none). Names and topics never reach a log.

const { hostFailure } = require('../../server/api-contract');
const { chatBucket } = require('../../server/team/authorize');

const FIXED = 'team_chat_channel_fixed';
const forbidden = (reason) => hostFailure('forbidden', reason);

// The operations this module answers; each is a member mutation the dispatcher limits and lets publish.
const CHANNEL_OPERATIONS = Object.freeze(['team.chat.channel_create', 'team.chat.channel_update',
  'team.chat.channel_archive', 'team.chat.channel_delete']);

// The event payload of a `team` or `channel` row after a change, from the channel document as it is now.
function channelPayload(header, reason) {
  return { channel_id: header.channel_id, reason, floor_seq: header.floor_seq, channel_rev: header.rev,
    pin_count: header.pin_count, name: header.name, topic: header.topic, created_by: header.created_by,
    archived_by: header.archived_by, changes: header.changes };
}

const isCreatorOrOwner = (header, actor) => actor.owner || header.created_by === actor.member_id;

// The refusal for an update by this actor, or null.
function updateDenial(header, params, actor) {
  if (header.kind === 'team') {
    if (params.name !== undefined) return forbidden(FIXED);
    return actor.owner ? null : forbidden('role_forbidden');
  }
  if (header.kind !== 'channel') return forbidden(FIXED);
  return isCreatorOrOwner(header, actor) ? null : forbidden('role_forbidden');
}

// The refusal for an archive (`on`) or unarchive by this actor, or null.
function archiveDenial(header, on, actor) {
  if (header.kind !== 'channel') return forbidden(FIXED);
  return (on ? isCreatorOrOwner(header, actor) : actor.owner) ? null : forbidden('role_forbidden');
}

function deleteDenial(header, actor) {
  if (header.kind !== 'channel') return forbidden(FIXED);
  return actor.owner ? null : forbidden('role_forbidden');
}

function createChannelOps({ store, audience, audit = null }) {
  function announce(publish, channelId, reason) {
    const header = store.channelHeader(channelId);
    if (!header.ok) return;
    publish('team_chat_channel', channelPayload(header, reason),
      { audience: audience(channelId), bucket: chatBucket(channelId) });
  }

  // The store's audit hook for one change: the entry is built here, the store passes the channel's name as it is
  // inside the write chain and calls it only when the change will commit. A throw is answered as unavailable by the
  // store; with no audit wired the hook answers unavailable, so nothing unaudited is written.
  const auditOf = (kind, actor, channelId) => (name) => (typeof audit === 'function'
    ? audit({ kind, actor_member_id: actor.member_id, channel_id: channelId, name })
    : hostFailure('unavailable', 'team_unavailable'));

  // The channel document an operation is checked against; an unknown id answers the store's not found.
  const headerOf = (channelId) => store.channelHeader(channelId);

  return {
    'team.chat.channel_create': async ({ params, key, publish }) => {
      const made = await store.createCustomChannel({ ...key, name: params.name,
        ...(params.topic === undefined ? {} : { topic: params.topic }) });
      if (!made.ok) return made;
      if (made.replayed !== true) announce(publish, made.channel_id, 'created');
      return { ok: true, channel_id: made.channel_id, rev: made.rev };
    },
    'team.chat.channel_update': async ({ params, actor, key, publish }) => {
      const header = headerOf(params.channel_id);
      if (!header.ok) return header;
      const denied = updateDenial(header, params, actor);
      if (denied) return denied;
      const updated = await store.updateChannel({ ...key, channelId: params.channel_id, expectedRev: params.expected_rev,
        ...(params.name === undefined ? {} : { name: params.name }),
        ...(params.topic === undefined ? {} : { topic: params.topic }) });
      if (!updated.ok) return updated;
      if (updated.changed === true) announce(publish, params.channel_id, 'updated');
      return { ok: true, rev: updated.rev };
    },
    'team.chat.channel_archive': async ({ params, actor, key, publish }) => {
      const header = headerOf(params.channel_id);
      if (!header.ok) return header;
      const denied = archiveDenial(header, params.on, actor);
      if (denied) return denied;
      const kind = params.on ? 'chat_channel_archived' : 'chat_channel_unarchived';
      const archived = await store.archiveChannel({ ...key, channelId: params.channel_id, on: params.on,
        audit: auditOf(kind, actor, params.channel_id) });
      if (!archived.ok) return archived;
      if (archived.changed === true) announce(publish, params.channel_id, params.on ? 'archived' : 'unarchived');
      return { ok: true, rev: archived.rev };
    },
    // The audience is taken before the removal, so the event reaches who could read the channel. A channel another
    // delete removed first answers ok and announces nothing.
    'team.chat.channel_delete': async ({ params, actor, publish }) => {
      const header = headerOf(params.channel_id);
      if (!header.ok) return header;
      const denied = deleteDenial(header, actor);
      if (denied) return denied;
      const readers = audience(params.channel_id);
      const removed = await store.removeChannel({ channelId: params.channel_id,
        audit: auditOf('chat_channel_deleted', actor, params.channel_id) });
      if (!removed.ok) return removed;
      if (removed.removed === true) {
        publish('team_chat_channel', { channel_id: params.channel_id, reason: 'removed', channel_rev: removed.channel_rev },
          { audience: readers, bucket: chatBucket(params.channel_id) });
      }
      return { ok: true };
    },
  };
}

module.exports = { CHANNEL_OPERATIONS, channelPayload, createChannelOps };
