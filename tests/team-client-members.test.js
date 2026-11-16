'use strict';

// The desktop chat client carries the team's members (slice 2a-4c): the
// overview's `members` are rebuilt from checked fields (the member id check, the
// host's display-name rule, its closed role and presence lists, a timestamp or
// null, at most the team's member limit, no other key); a list that fails any
// check makes the answer team_chat_answer_invalid and nothing of it reaches the
// renderer; a resync replaces the list and pushes it; a cleared team drops it.
// Against the real host chat composition behind a fake connection manager.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ME, OTHER, createChatFakeHost, settleChats, startChats, tempDir, writeMembership,
} = require('./helpers/team-chat-fake-host');

const INVALID = 'team_chat_answer_invalid';
const MARKER = 'Hostile Marker';

async function setup(t, options = {}) {
  const host = await createChatFakeHost(t, options.host);
  const userData = tempDir(t, 'jenny-team-chat-members-');
  const teamId = writeMembership(userData).team_id;
  const started = startChats(t, host, { userData, teamId });
  return { host, teamId, userData, ...started };
}

const overview = (s) => s.chats.handle('chatOverview', { team_id: s.teamId });
const ofType = (s, type) => s.pushes.filter((push) => push.type === type);

test('the overview carries every member rebuilt from checked fields', async (t) => {
  const s = await setup(t);
  const answer = await overview(s);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(Object.keys(answer).sort(), ['channels', 'members', 'ok', 'outbox', 'reaction_emoji']);
  assert.deepEqual(answer.members, [
    { member_id: ME.member_id, display_name: 'Mika Member', role: 'member', state: 'offline', last_seen_at: null },
    { member_id: OTHER.member_id, display_name: 'Oona Other', role: 'member', state: 'offline', last_seen_at: null },
  ]);
  await settleChats(s.chats, s.teamId, s.timers);
  assert.deepEqual(ofType(s, 'members').at(-1), { team_id: s.teamId, type: 'members', members: answer.members });
});

const NINE = Array.from({ length: 9 }, (_unused, n) => ({ member_id: `member_nine${n}AAAA`, display_name: `${MARKER} ${n}`,
  role: 'member', state: 'online', last_seen_at: '2026-11-11T10:00:00.000Z' }));

const HOSTILE = [
  ['a bad member id', (members) => [{ ...members[0], member_id: `../${MARKER}` }, members[1]]],
  ['an over-long name', (members) => [{ ...members[0], display_name: `${MARKER}${'x'.repeat(40)}` }, members[1]]],
  ['a name with a control character', (members) => [{ ...members[0], display_name: `${MARKER}\u0007` }]],
  ['an unknown role', (members) => [{ ...members[0], role: 'admin', display_name: MARKER }]],
  ['an unknown state', (members) => [{ ...members[0], state: 'busy', display_name: MARKER }]],
  ['a last_seen_at that is not a timestamp', (members) => [{ ...members[0], last_seen_at: 'yesterday', display_name: MARKER }]],
  ['a ninth member past the limit', () => NINE],
  ['an extra key', (members) => [{ ...members[0], display_name: MARKER, address: '192.0.2.7:4242' }]],
  ['a repeated member', (members) => [{ ...members[0], display_name: MARKER }, { ...members[0], display_name: MARKER }]],
  ['members that are not a list', () => ({ [MARKER]: true })],
];

for (const [name, rewrite] of HOSTILE) {
  test(`${name} makes the overview answer invalid and nothing of it reaches the renderer`, async (t) => {
    const s = await setup(t);
    s.manager.hook = async ({ operation, dispatch }) => {
      if (operation !== 'team.chat.overview') return null;
      const answer = await dispatch();
      return { ...answer, members: rewrite(answer.members) };
    };
    const answer = await overview(s);
    assert.equal(answer.ok, false, JSON.stringify(answer));
    assert.equal(answer.error.reason, INVALID);
    await s.chats.idle(s.teamId);
    const text = JSON.stringify({ answer, pushes: s.pushes });
    assert.equal(text.includes(MARKER), false, 'nothing of the hostile list reached the renderer');
    assert.deepEqual(ofType(s, 'members'), []);
    assert.deepEqual(ofType(s, 'channels'), [], 'the hostile overview did not load the channel list either');
  });
}

test('a resync replaces the members and pushes the new list; an unchanged list is not pushed again', async (t) => {
  const s = await setup(t);
  assert.equal((await overview(s)).members.length, 2);
  await settleChats(s.chats, s.teamId, s.timers);
  assert.equal(ofType(s, 'members').length, 1);
  // A resync with nothing changed pushes the channels again, not the members.
  const channelsBefore = ofType(s, 'channels').length;
  s.manager.deliver({ event_type: 'resync_required', cursor: s.host.nextCursor(), boot_epoch: s.host.bootEpoch() });
  await settleChats(s.chats, s.teamId, s.timers);
  assert.ok(ofType(s, 'channels').length > channelsBefore, 'the resync ran');
  assert.equal(ofType(s, 'members').length, 1, 'an unchanged list is not pushed');
  // A third member is admitted and another leaves: the next resync replaces the list.
  s.host.members.push({ member_id: 'member_thirdCCC333', device_id: 'device_thirdCCC333', role: 'read_only',
    display_name: 'Tove Third' });
  s.host.members.splice(s.host.members.indexOf(OTHER), 1);
  s.manager.deliver({ event_type: 'resync_required', cursor: s.host.nextCursor(), boot_epoch: s.host.bootEpoch() });
  await settleChats(s.chats, s.teamId, s.timers);
  const pushed = ofType(s, 'members').at(-1).members;
  assert.deepEqual(pushed.map((member) => [member.member_id, member.role]),
    [[ME.member_id, 'member'], ['member_thirdCCC333', 'read_only']]);
  assert.deepEqual((await overview(s)).members, pushed);
});

test('a later resync whose members fail keeps the last good list and pushes nothing of the hostile one', async (t) => {
  const s = await setup(t);
  const good = (await overview(s)).members;
  await settleChats(s.chats, s.teamId, s.timers);
  s.manager.hook = async ({ operation, dispatch }) => {
    if (operation !== 'team.chat.overview') return null;
    const answer = await dispatch();
    return { ...answer, members: [{ ...answer.members[0], role: 'owner_of_all', display_name: MARKER }] };
  };
  s.manager.deliver({ event_type: 'resync_required', cursor: s.host.nextCursor(), boot_epoch: s.host.bootEpoch() });
  await s.chats.idle(s.teamId);
  assert.equal(JSON.stringify(s.pushes).includes(MARKER), false);
  assert.deepEqual((await overview(s)).members, good);
});

test('a cleared team drops its members', async (t) => {
  const s = await setup(t);
  assert.equal((await overview(s)).members.length, 2);
  assert.equal(s.chats.cacheOf(s.teamId).members.length, 2);
  s.manager.setState('revoked');
  await settleChats(s.chats, s.teamId, s.timers);
  assert.deepEqual(ofType(s, 'cleared').map((push) => push.team_id), [s.teamId]);
  assert.deepEqual(s.chats.cacheOf(s.teamId).members, []);
  const after = await overview(s);
  assert.equal(after.ok, false, 'a revoked team answers nothing');
  assert.equal(JSON.stringify(after).includes('Oona Other'), false);
});

// Slice 2b-3: a project's member change resyncs the overview once, so a project row's audience stays fresh;
// a project created or renamed changes no audience and asks for nothing.
test('team_project_changed with members, deleting or deleted resyncs once; created and renamed do not', async (t) => {
  const s = await setup(t);
  const PROJECT = 'chan_project_alpha';
  assert.equal((await s.host.store.createChannel({ channelId: PROJECT })).ok, true);
  assert.equal((await overview(s)).ok, true);
  await settleChats(s.chats, s.teamId, s.timers);
  const overviews = () => s.manager.calls.filter((call) => call.operation === 'team.chat.overview').length;
  const audienceOf = () => (s.pushes.filter((push) => push.type === 'channels' && !push.partial).at(-1)
    ?.channels.find((row) => row.channel_id === PROJECT) || {}).audience;
  assert.deepEqual(audienceOf(), [ME.member_id, OTHER.member_id].sort());
  const changed = async (reason) => {
    s.manager.deliver({ event_type: 'team_project_changed', cursor: s.host.nextCursor(), boot_epoch: s.host.bootEpoch(),
      api_version: 1, project_id: 'project_alpha', reason });
    await settleChats(s.chats, s.teamId, s.timers);
  };
  let before = overviews();
  for (const reason of ['created', 'renamed']) await changed(reason);
  assert.equal(overviews(), before, 'created and renamed cause no resync');

  const third = { member_id: 'member_thirdCCC333', device_id: 'device_thirdCCC333', role: 'member', display_name: 'Tess' };
  s.host.members.push(third);
  t.after(() => { s.host.members.splice(s.host.members.indexOf(third), 1); });
  for (const reason of ['members', 'deleting', 'deleted']) {
    before = overviews();
    await changed(reason);
    assert.equal(overviews(), before + 1, `${reason}: one overview resync`);
  }
  assert.deepEqual(audienceOf(), [ME.member_id, OTHER.member_id, third.member_id].sort(), 'the pushed row has the new audience');
});

test('a burst of project member changes resyncs once; one during a resync in flight causes exactly one more', async (t) => {
  const s = await setup(t);
  assert.equal((await overview(s)).ok, true);
  await settleChats(s.chats, s.teamId, s.timers);
  const overviews = () => s.manager.calls.filter((call) => call.operation === 'team.chat.overview').length;
  const event = () => ({ event_type: 'team_project_changed', cursor: s.host.nextCursor(), boot_epoch: s.host.bootEpoch(),
    api_version: 1, project_id: 'project_alpha', reason: 'members' });
  let before = overviews();
  s.manager.deliver(event());
  s.manager.deliver(event());
  await settleChats(s.chats, s.teamId, s.timers);
  assert.equal(overviews(), before + 1, 'two events in one batch: one overview call');

  let release = null;
  let held = false;
  s.manager.hook = async ({ operation, dispatch }) => {
    if (operation !== 'team.chat.overview' || held) return null;
    held = true;
    await new Promise((resolve) => { release = resolve; });
    return dispatch();
  };
  before = overviews();
  s.manager.deliver(event());
  for (let n = 0; n < 20 && !release; n += 1) { await new Promise((resolve) => setImmediate(resolve)); s.timers.fire(); }
  assert.ok(release, 'the resync is in flight');
  s.manager.deliver(event());
  s.manager.deliver(event());
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await settleChats(s.chats, s.teamId, s.timers);
  assert.equal(overviews(), before + 2, 'the resync in flight and exactly one more');
});
