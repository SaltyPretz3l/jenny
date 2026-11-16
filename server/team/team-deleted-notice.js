'use strict';

// "Deleted by its owner" (slice 5-6, E61): when the desktop says it is deleting the team, the host tells every
// active member once, before it is stopped. One `team_deleted` event with the owner's display name and the time,
// to the active members, under the #team channel's chat bucket (every active member reads #team, so the stream
// predicate admits it without a new bucketless type). A member's Jenny keeps the team as a "deleted" row
// (services/team/team-deleted.js). It carries no id, key or address; nothing here logs a name.

const { chatBucket } = require('./authorize');

const TEAM_CHANNEL = 'chan_team';

/** Publishes the notice; answers true when it went out. Never throws. */
function announceTeamDeleted({ store, publish, now = Date.now }) {
  try {
    const members = store?.snapshot()?.members || [];
    const owner = members.find((member) => member.role === 'owner' && member.state === 'active');
    const audience = new Set(store.directory.activeMemberIds());
    if (!owner || audience.size === 0) return false;
    publish('team_deleted', { owner_name: owner.display_name, deleted_at: now() },
      { audience, bucket: chatBucket(TEAM_CHANNEL) });
    return true;
  } catch {
    return false;
  }
}

module.exports = { TEAM_CHANNEL, announceTeamDeleted };
