'use strict';

// Helpers shared by the member store's transition files. member-transitions.js
// requires project-transitions.js for the cascades, so the two cannot borrow
// from each other without a cycle; both take these from here.

const { hostFailure } = require('../api-contract');
const { displayNameKey } = require('./member-schema');

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

// The owner admits a person by reading the name, so no two members who are pending or active share one (R01-F04).
// `exceptMemberId`: the member who is renaming themselves, who may keep their own name in another case or spacing.
function nameIsFree(doc, displayName, exceptMemberId = null) {
  const key = displayNameKey(displayName);
  return !doc.members.some((member) => member.member_id !== exceptMemberId && member.state !== 'revoked'
    && displayNameKey(member.display_name) === key);
}

module.exports = { refuse, findMember, activeActor, nameIsFree };
