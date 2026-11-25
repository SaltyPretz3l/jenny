'use strict';

// Project channels as first-class human channels (team review fixes, C9.2 and OD-8): a channel row of kind `project` is
// listed for message links, may be shown from a search hit or a chip, and is named by its project everywhere a channel
// name is drawn (one resolver in renderer-team-channels.js). Pure helpers over a stubbed project store.
// new-test-file: a new surface (the project channel's naming and listing rules); tests/renderer-team-channels.test.js is at its line cap.

const test = require('node:test');
const assert = require('node:assert/strict');

const channels = require('../renderer/team/renderer-team-channels');
const link = require('../renderer/team/renderer-team-link');

const TEAM = 'team_alpha';
const ME = 'member_me';
const DOT = 'member_dot';
const SITE = 'chan_project_site';
const DM = `chan_dm_${'a'.repeat(64)}`;
const MSG = 'msg_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ROWS = [
  { channel_id: 'chan_team', kind: 'team' },
  { channel_id: 'chan_c_abcdefghijklmnop', kind: 'channel', name: 'design' },
  { channel_id: SITE, kind: 'project', audience: [ME, DOT] },
  { channel_id: DM, kind: 'dm', participants: [ME, DOT] },
];
const PROJECTS = { [`${TEAM}|project_site`]: { id: 'project_site', name: 'Site\u202e plan', role: 'writer' } };

// The project store is a global the Team tab loads; this stands in for it.
function withProjects(t) {
  const before = globalThis.rendererTeamProjectStore;
  globalThis.rendererTeamProjectStore = { getProjectStore: () => ({ project: (teamId, id) => PROJECTS[`${teamId}|${id}`] || null }) };
  t.after(() => { if (before === undefined) delete globalThis.rendererTeamProjectStore; else globalThis.rendererTeamProjectStore = before; });
}
const context = (over = {}) => channels.frameContext({ team: { team_id: TEAM, member_id: ME, role: 'member', state: 'online' }, teamId: TEAM, loaded: true,
  people: [{ member_id: ME, display_name: 'Me' }, { member_id: DOT, display_name: 'Dot' }], channelId: 'chan_team', rows: ROWS, ...over });

test('a project channel row is told apart by kind, by id, and may be shown', () => {
  assert.equal(channels.isProject(ROWS[2]), true);
  assert.equal(channels.isProject(ROWS[1]), false);
  assert.equal(channels.isProjectId(SITE), true);
  assert.equal(channels.isProjectId('chan_c_abcdefghijklmnop'), false);
  assert.deepEqual(ROWS.map((row) => channels.isShowable(row)), [true, true, true, true], '#team, a channel, a project channel and a conversation');
  assert.equal(channels.isShowable({ channel_id: 'chan_x', kind: 'other' }), false);
  assert.equal(channels.isShowable(null), false);
});

test('listed: #team, custom channels and project channels; a conversation and an unknown id are not', () => {
  const { listed } = context();
  assert.equal(listed('chan_team'), true);
  assert.equal(listed('chan_c_abcdefghijklmnop'), true);
  assert.equal(listed(SITE), true, 'a project channel is listed');
  assert.equal(listed(DM), false, 'a link to a conversation stays plain text');
  assert.equal(listed('chan_project_gone'), false);
});

test('a copied link to a project channel message is a chip, not raw text', () => {
  const ctx = context();
  const label = (l) => ({ where: '#' + ctx.channelNameOf(l.channelId) + ' \u00b7 message', text: '' });
  const words = (text) => link.linkKey(text, ctx, label);
  assert.equal(words(`see jenny-team:${TEAM}/${SITE}/3/${MSG}`), '#site \u00b7 message\u0001', 'a message link into a project channel');
  assert.equal(words(`see jenny-team:${TEAM}/${SITE}`), '#site\u0001', 'a channel link too');
  assert.equal(words(`see jenny-team:${TEAM}/${DM}/2/${MSG}`), '', 'a link into a conversation stays plain text');
});

test('the channel-name resolver gives a project channel its project name, markup and direction marks out', (t) => {
  withProjects(t);
  assert.equal(channels.channelName(SITE, TEAM), 'Site plan');
  assert.equal(channels.channelName(SITE), 'site', 'with no team to ask, what the id says (the old fallback)');
  assert.equal(channels.channelName('chan_project_gone', TEAM), 'gone', 'a project this member does not know');
  assert.equal(channels.channelName('chan_team', TEAM), 'team');
  const ctx = context({ channelId: SITE });
  assert.equal(ctx.channelNameOf(SITE), 'Site plan', 'the frame context names it with no project callback');
  assert.equal(ctx.channelTitleOf(SITE), '#Site plan');
  assert.equal(ctx.channelTitle, '#Site plan');
});

test('a project name the tab supplies still wins over the resolver', (t) => {
  withProjects(t);
  const ctx = context({ channelId: SITE, projectNameOf: () => 'Renamed' });
  assert.equal(ctx.channelNameOf(SITE), 'Renamed');
});
