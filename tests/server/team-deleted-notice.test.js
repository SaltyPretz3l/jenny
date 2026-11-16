'use strict';

// Slice 5-6 (E61): the host's "deleted by its owner" notice. One `team_deleted` event with the owner's name and the
// time, to the active members, under #team's chat bucket; the event scope admits it only with that audience.

const assert = require('node:assert/strict');
const test = require('node:test');

const { TEAM_DELETED_EVENT, createEventScope } = require('../../server/team/event-scope');
const { announceTeamDeleted } = require('../../server/team/team-deleted-notice');
const { chatBucket } = require('../../server/team/authorize');

function fakeStore(members) {
  return { snapshot: () => ({ members }),
    directory: { activeMemberIds: () => members.filter((m) => m.state === 'active').map((m) => m.member_id) } };
}

test('the notice goes to every active member with the owner\'s name and the time, under #team\'s bucket', () => {
  const published = [];
  const store = fakeStore([{ member_id: 'member_o', display_name: 'Olive', role: 'owner', state: 'active' },
    { member_id: 'member_d', display_name: 'Dot', role: 'member', state: 'active' },
    { member_id: 'member_p', display_name: 'Pat', role: 'member', state: 'pending' }]);
  assert.equal(announceTeamDeleted({ store, now: () => 1234, publish: (...args) => published.push(args) }), true);
  assert.equal(published.length, 1);
  const [type, payload, options] = published[0];
  assert.equal(type, TEAM_DELETED_EVENT);
  assert.deepEqual(payload, { owner_name: 'Olive', deleted_at: 1234 });
  assert.deepEqual([...options.audience], ['member_o', 'member_d']);
  assert.equal(options.bucket, chatBucket('chan_team'));
});

test('no owner, no active member or a publish that throws sends nothing and never throws', () => {
  assert.equal(announceTeamDeleted({ store: fakeStore([]), publish: () => { throw new Error('x'); } }), false);
  assert.equal(announceTeamDeleted({ store: null, publish: () => {} }), false);
  const store = fakeStore([{ member_id: 'member_o', display_name: 'Olive', role: 'owner', state: 'active' }]);
  assert.equal(announceTeamDeleted({ store, publish: () => { throw new Error('x'); } }), false);
});

test('the event type is publisher-scoped: without an audience it is dropped', () => {
  const scope = createEventScope({ sessionScope: { audience: () => null }, logger: () => {} });
  assert.equal(scope(TEAM_DELETED_EVENT, {}, undefined), null);
  const audience = new Set(['member_o']);
  assert.equal(scope(TEAM_DELETED_EVENT, {}, { audience, bucket: chatBucket('chan_team') }).audience, audience);
});
