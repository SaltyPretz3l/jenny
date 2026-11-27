'use strict';

// Team tab, the "GPUs" section (row 123, slice 4e; the owner's picks in picks_4e.md, surface 3): absent
// while nobody shares a GPU (the team menu then offers "Share this PC's GPU…"), one row per GPU with its
// dot and state word between the conversations and the people, and the popover with the state sentence,
// "Offers" and, on this PC's row, "Sharing settings". Also the members' notice in the model picker.
// Through the real tab, store and inventory modules over a stubbed bridge.

const test = require('node:test');
const assert = require('node:assert/strict');
const { OTHER, ME, DOT, flush, memberTeam, harness, chatMember, overview } = require('./helpers/team-settings-harness');

const M27 = 'qwen3.8-27b-q4_k_m';
const M8 = 'qwen3.8-8b-q8_0';
const ARJUN = 'member_arjun';
const MAYA = 'member_maya';
const model = (name) => ({ name, context_length: 32768, vision: false, thinking: false });
const node = (id, over = {}) => ({ node_id: 'node_' + id.padEnd(16, 'A'), member_id: DOT, label: 'Tower', online: true, paused: false,
  busy_slots: 0, slots: 1, models: [model(M27)], ...over });
const NODES = [
  node('mine', { member_id: DOT, label: 'Tower', models: [model(M27), model(M8)] }), // Dot is this person (memberTeam)
  node('busy', { member_id: ME, label: 'Studio', busy_slots: 1 }),
  node('paused', { member_id: ARJUN, label: 'Desktop', paused: true, models: [model('gemma-4-12b-q6_k')] }),
  node('offline', { member_id: MAYA, label: 'Laptop', online: false, models: [model(M8)] }),
];
const ROSTER = [
  { member_id: ME, display_name: 'Brendan', role: 'owner', state: 'active' },
  { member_id: DOT, display_name: 'Dot', role: 'member', state: 'active' },
  { member_id: ARJUN, display_name: 'Arjun', role: 'member', state: 'active' },
  { member_id: MAYA, display_name: 'Maya', role: 'member', state: 'active' },
];
const team = () => memberTeam({ label: 'Tower' });
// This PC's row is the one its own sharing names (the node id), never a guess from the PC name.
const SHARING = { team_id: OTHER, state: 'idle', serving_since: null, models: [M27], engine: 'llama-server', node_id: NODES[0].node_id };
const pools = (nodes = NODES) => ({ [OTHER]: { nodes, team_model: null, automatic_model: M27 } });
const menuOf = (h) => h.window.document.querySelector('.inv-context-menu.team-switch-menu');
const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();

async function open(t, { gpus = null, sharing = SHARING } = {}) {
  const members = ROSTER.map((m) => chatMember(m.member_id, m.display_name, { role: m.role }));
  const h = harness({ show: false, teams: [team()], answers: {
    members: { ok: true, members: ROSTER }, chatOverview: overview({ members }), status: { ok: true, teams: [team()], sharing, pools: gpus || {} } } });
  t.after(h.restore);
  require('../renderer/inventory/popover').initPopoverHandlers(h.window.document);
  h.showTab();
  await flush();
  return h;
}
async function push(h, nodes, sharing = SHARING) { h.listeners.state({ teams: [team()], sharing, pools: nodes ? pools(nodes) : {} }); await flush(); }

test('no GPU shared: no GPUs section, and the team menu offers Share this PC’s GPU…, which opens Settings > Team', async (t) => {
  const h = await open(t);
  assert.equal(h.view.q('[data-team-gpus]'), null);
  assert.equal(h.view.qa('.team-panel__label').some((label) => /GPUs/.test(label.textContent)), false);
  h.view.click('[data-team-tab-action="switch"]');
  const items = [...menuOf(h).querySelectorAll('[role="menuitem"]')];
  const share = items.find((item) => item.textContent.trim() === 'Share this PC’s GPU…');
  assert.ok(share, 'the menu item is there');
  share.click();
  await flush();
  assert.deepEqual(h.opened, ['team']);
});

test('the section: between the conversations and the people, "{ready or busy} of {all}", one row per GPU with its word and dot', async (t) => {
  const h = await open(t, { gpus: pools() });
  const section = h.view.q('[data-team-gpus]');
  assert.ok(section);
  const label = section.querySelector('.team-panel__label');
  assert.deepEqual([...label.children].map(text), ['GPUs', '2 of 4']);
  const people = h.view.q('[data-team-people]');
  assert.equal(section.compareDocumentPosition(people) & h.window.Node.DOCUMENT_POSITION_FOLLOWING, h.window.Node.DOCUMENT_POSITION_FOLLOWING, 'before Online/Offline');
  const channel = h.view.q('[data-team-channel]');
  assert.equal(channel.compareDocumentPosition(section) & h.window.Node.DOCUMENT_POSITION_FOLLOWING, h.window.Node.DOCUMENT_POSITION_FOLLOWING, 'after the conversations');
  const rows = [...section.querySelectorAll('.team-gpu-row')];
  assert.deepEqual(rows.map((row) => text(row.querySelector('.team-row__name'))), ['Tower (this PC)', 'Brendan’s Studio', 'Arjun’s Desktop', 'Maya’s Laptop']);
  assert.deepEqual(rows.map((row) => text(row.querySelector('.team-row__meta'))), ['', 'busy', 'paused', 'offline']);
  assert.deepEqual(rows.map((row) => row.querySelector('.team-dot').dataset.p), ['online', 'away', 'offline', 'offline']);
  for (const row of rows) {
    assert.equal(row.tagName, 'BUTTON', 'every row is reachable by keyboard');
    assert.equal(row.getAttribute('aria-haspopup'), 'dialog');
  }
  h.view.click('[data-team-tab-action="switch"]');
  assert.equal([...menuOf(h).querySelectorAll('[role="menuitem"]')].some((item) => /Share this PC/.test(item.textContent)), false,
    'with GPUs listed the menu does not offer it');
});

test('the popover: the state sentence for each of the four states, Offers, and Sharing settings on this PC only', async (t) => {
  const h = await open(t, { gpus: pools() });
  const pop = () => h.window.document.getElementById('teamGpuPop');
  const openRow = async (index) => { h.view.qa('.team-gpu-row')[index].click(); await flush(); return pop(); };
  let el = await openRow(0);
  assert.equal(el.getAttribute('role'), 'dialog');
  assert.equal(el.getAttribute('aria-label'), 'Tower (this PC)');
  assert.equal(text(el.querySelector('h4')), 'Tower (this PC)');
  assert.equal(text(el.querySelector('p')), 'Ready: it takes the next request for its models.');
  assert.equal(text(el.querySelectorAll('p')[1]), 'Offers');
  assert.deepEqual([...el.querySelectorAll('li code')].map(text), [M27, M8]);
  assert.equal(text(el.querySelector('[data-team-tab-action="share-settings"]')), 'Sharing settings');
  assert.equal(h.view.qa('.team-gpu-row')[0].getAttribute('aria-expanded'), 'true');
  el = await openRow(1);
  assert.equal(text(el.querySelector('p')), 'Busy answering a request.');
  assert.equal(el.querySelector('[data-team-tab-action="share-settings"]'), null, 'not this PC: no settings link');
  el = await openRow(2);
  assert.equal(text(el.querySelector('p')), 'Arjun has paused it. It answers nothing until they resume.');
  el = await openRow(3);
  assert.equal(text(el.querySelector('p')), 'Not connected. It is listed while Maya still shares it.');
  assert.equal(h.window.document.querySelectorAll('#teamGpuPop').length, 1, 'one popover at a time');
});

test('“(this PC)” is the row this PC shares as: not a second PC of the same person and name; still after a rename', async (t) => {
  const twin = node('twin', { member_id: DOT, label: 'Tower' });
  const h = await open(t, { gpus: pools([NODES[0], twin]) });
  assert.deepEqual(h.view.qa('.team-gpu-row .team-row__name').map(text), ['Tower (this PC)', 'Dot’s Tower']);
  await push(h, [{ ...NODES[0], label: 'Old name' }, twin]);
  assert.deepEqual(h.view.qa('.team-gpu-row .team-row__name').map(text), ['Old name (this PC)', 'Dot’s Tower'], 'renamed: still this PC');
  await push(h, [NODES[0], twin], null);
  assert.deepEqual(h.view.qa('.team-gpu-row .team-row__name').map(text), ['Dot’s Tower', 'Dot’s Tower'], 'not sharing: no row is this PC');
});

test('Escape closes the popover and gives the focus back to its row; a click on the row again closes it too', async (t) => {
  const h = await open(t, { gpus: pools() });
  const row = h.view.qa('.team-gpu-row')[1];
  row.focus();
  row.click();
  await flush();
  const pop = h.window.document.getElementById('teamGpuPop');
  assert.equal(h.window.document.activeElement, pop, 'the focus moves into the popover');
  pop.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flush();
  assert.equal(h.window.document.getElementById('teamGpuPop'), null);
  assert.equal(h.window.document.activeElement.id, row.id);
  h.view.qa('.team-gpu-row')[1].click();
  await flush();
  h.view.qa('.team-gpu-row')[1].click();
  await flush();
  assert.equal(h.window.document.getElementById('teamGpuPop'), null);
});

test('Sharing settings opens Settings > Team', async (t) => {
  const h = await open(t, { gpus: pools() });
  h.view.qa('.team-gpu-row')[0].click();
  await flush();
  h.window.document.querySelector('#teamGpuPop [data-team-tab-action="share-settings"]').click();
  await flush();
  assert.deepEqual(h.opened, ['team']);
});

test('the list follows the push: a row changes its word and the open popover its sentence; a GPU that left closes it', async (t) => {
  const h = await open(t, { gpus: pools() });
  h.view.qa('.team-gpu-row')[1].click();
  await flush();
  await push(h, [NODES[0], { ...NODES[1], busy_slots: 0, paused: true }, NODES[2]]);
  await flush();
  assert.deepEqual(h.view.qa('.team-gpu-row .team-row__meta').map(text), ['', 'paused', 'paused']);
  assert.deepEqual([...h.view.q('[data-team-gpus] .team-panel__label').children].map(text), ['GPUs', '1 of 3']);
  assert.equal(text(h.window.document.querySelector('#teamGpuPop p')), 'Brendan has paused it. It answers nothing until they resume.');
  await push(h, [NODES[0]]);
  await flush();
  assert.equal(h.window.document.getElementById('teamGpuPop'), null);
  await push(h, null);
  assert.equal(h.view.q('[data-team-gpus]'), null, 'nobody shares: the section goes');
});

test('hostile names are drawn as text: the row, and the popover heading, sentence, code and title', async (t) => {
  const evil = '<img src=x onerror=alert(1)>';
  const h = await open(t, { gpus: pools([node('evil', { member_id: ME, label: evil, paused: true, models: [model('<b>m</b>')] })]) });
  assert.equal(h.view.q('[data-team-gpus] img'), null);
  assert.match(text(h.view.q('.team-gpu-row .team-row__name')), /<img src=x/);
  assert.equal(h.view.q('.team-gpu-row').getAttribute('title'), '<b>m</b>', 'the row tooltip (its models) holds the text');
  h.view.qa('.team-gpu-row')[0].click();
  await flush();
  const pop = h.window.document.getElementById('teamGpuPop');
  assert.equal(pop.querySelector('img, b'), null);
  assert.match(text(pop), /<img src=x onerror=alert\(1\)>/);
  assert.deepEqual([...pop.querySelectorAll('code')].map(text), ['<b>m</b>']);
});

test('hiding the tab removes an open popover', async (t) => {
  const h = await open(t, { gpus: pools() });
  h.view.qa('.team-gpu-row')[0].click();
  await flush();
  assert.ok(h.window.document.getElementById('teamGpuPop'));
  h.tab.hideTeamTab();
  assert.equal(h.window.document.getElementById('teamGpuPop'), null);
});

test('the members’ notice in the model picker is the owner’s final sentence', () => {
  const utils = require('../renderer/chat/renderer-composer-model-picker-utils');
  const row = { id: 'team/team_alpha1/qwen3:8b-q4', engine_type: 'openai-compatible', team_id: 'team_alpha1', team_name: 'Alpha crew' };
  const entry = utils.normalizeCatalogEntry(row);
  const group = utils.groupCatalogEntries([row], {}).find((g) => g.key === 'team:team_alpha1');
  const section = utils.groupSectionHtml(group, '', { escapeHtml: (value) => String(value), id: 'g1', showHeading: true });
  assert.match(section, />The team’s host and the person whose hardware responds can read your prompts and replies\.</);
  assert.equal(entry.hint, '', 'drawn once under the team heading, not on each row');
});

test('E76: a GPU its owner is using says so in the list and the popover; one the owner paused by hand still says paused', async (t) => {
  const used = node('inuse', { member_id: ARJUN, label: 'Desktop', paused: true, owner_busy: true });
  const h = await open(t, { gpus: pools([NODES[0], used, NODES[2]]) });
  const rows = h.view.qa('.team-gpu-row');
  assert.deepEqual(rows.map((row) => text(row.querySelector('.team-row__meta'))), ['', 'in use by its owner', 'paused']);
  assert.deepEqual(rows.map((row) => row.querySelector('.team-dot').dataset.p), ['online', 'away', 'offline']);
  assert.deepEqual([...h.view.q('[data-team-gpus] .team-panel__label').children].map(text), ['GPUs', '1 of 3'], 'a GPU in use takes no request: not counted');
  rows[1].click();
  await flush();
  assert.equal(text(h.window.document.getElementById('teamGpuPop').querySelector('p')), 'Arjun is using it. It takes requests again when they are done. Requests for its models fail meanwhile.');
});
