'use strict';

// Helpers shared by the member store's transition files. member-transitions.js
// requires project-transitions.js for the cascades, so the two cannot borrow
// from each other without a cycle; both take these from here.

const { hostFailure } = require('../api-contract');

function refuse(kind, reason) {
  return { ok: false, failure: hostFailure(kind, reason) };
}

function findMember(doc, memberId) {
  if (typeof memberId !== 'string') return null;
  return doc.members.find((member) => member.member_id === memberId) || null;
}

// The actor of an administrative transition must be an active member. A
// missing or unknown actor reads like one that does not exist, never the owner.
function activeActor(doc, actorMemberId) {
  const actor = findMember(doc, actorMemberId);
  if (!actor) return refuse('forbidden', 'team_not_found');
  if (actor.state === 'pending') return refuse('forbidden', 'member_pending');
  if (actor.state === 'revoked') return refuse('forbidden', 'member_revoked');
  return { ok: true, actor };
}

module.exports = { refuse, findMember, activeActor };
