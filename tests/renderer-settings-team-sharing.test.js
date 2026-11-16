'use strict';

// Settings > Team, the GPU groups (row 123, slice 4e; the owner's picks in picks_4e.md): "Share this
// PC's GPU" for every member and the owner (the switch, the sharer's notice the first time, the six
// state lines, what this PC offers, the switch-off question, read-only), and the owner's "Team GPUs"
// (the team model) and "GPU use" (totals, every request, Show more, unavailable). Through the real page,
// store and inventory modules over a stubbed bridge; state arrives in the team state push.

const test = require('node:test');
const assert = require('node:assert/strict');
const { TEAM, OTHER, ME, DOT, flush, snapshot, memberTeam, hostState, ROSTER, harness } = require('./helpers/team-settings-harness');

const NODE = 'node_AAAAAAAAAAAAAAAA';
const M27 = 'qwen3.8-27b-q4_k_m';
const M8 = 'qwen3.8-8b-q8_0';
const SHARER_NOTICE = 'While you share, this PC sees the prompts and replies of the requests it answers, in plain text, and so does the team’s host. Jenny keeps none of them on this PC.';
const OFF_QUESTION = 'A request from the team is running on this PC. Stop sharing when it finishes, or stop it now? If you stop it now, that reply ends early and its sender can try other hardware.';
const HELP = 'When you are not using it, this PC’s model answers requests from people in the team. Your own chats always go first.';
const READ_ONLY = 'Read-only members cannot share a GPU. The owner can change your role.';
const LINES = {
  idle: 'Sharing. Nobody’s request is running.',
  busy_own: 'Waiting while you use the model. The team’s requests go to other hardware or wait.',
  paused: 'Paused. The team sees this PC as paused.',
  no_model: 'Offering nothing: no model is running on this PC. Start one in Models.',
};

const member = (over = {}) => memberTeam({ label: 'Tower', ...over });
const sharing = (state, over = {}) => ({ team_id: OTHER, state, serving_since: null, models: [M27, M8], engine: 'llama-server', ...over });
const node = (over = {}) => ({ node_id: NODE, member_id: DOT, label: 'Tower', online: true, paused: false, busy_slots: 0, slots: 1,
  models: [{ name: M27, context_length: 32768, vision: false, thinking: true }], ...over });

async function push(h, payload) { h.listeners.state(payload); await flush(); }
function memberPage(t, { teams = [member()], answers = {} } = {}) {
  const h = harness({ teams, answers });
  t.after(h.restore);
  return h;
}
const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();
const buttons = (root) => [...root.querySelectorAll('button')].map((b) => text(b)).filter(Boolean);

test('member page: the group sits after the joined teams, before Join; off by default with the approved words', async (t) => {
  const h = memberPage(t);
  await flush();
  const headings = h.headings();
  assert.deepEqual(headings.slice(headings.indexOf('Teams you have joined'), headings.indexOf('Teams you have joined') + 4),
    ['Teams you have joined', 'Share this PC’s GPU', 'Model sharing', 'Join another team']); // slice 6-7: Model sharing follows the GPU group
  assert.equal(text(h.q('#teamShareTitle')), 'Share with Dot lab');
  assert.equal(text(h.q('#teamShareHelp')), HELP);
  const track = h.q('#teamShareGpu');
  assert.equal(track.getAttribute('role'), 'switch');
  assert.equal(track.getAttribute('aria-checked'), 'false');
  assert.equal(track.getAttribute('aria-labelledby'), 'teamShareTitle', 'the switch is named for a screen reader');
  assert.equal(h.q('.team-share-state'), null, 'no state line while off');
  assert.equal(h.sent('shareSet').length, 0);
});

test('turning it on the first time shows the sharer notice; Start sharing confirms and the focus returns to the switch', async (t) => {
  const h = memberPage(t, { answers: { shareSet: (p) => (p.on && !p.confirmed ? { ok: false, error: { code: 'invalid_request', reason: 'team_share_confirm_needed' } } : { ok: true, sharing: null }) } });
  await flush();
  h.click('#teamShareGpu');
  await flush();
  assert.deepEqual(h.sent('shareSet').map((c) => c.payload), [{ team_id: OTHER, on: true, confirmed: false }]);
  const confirm = h.q('.team-set-confirm');
  assert.equal(text(confirm.querySelector('p')), SHARER_NOTICE);
  assert.deepEqual(buttons(confirm), ['Start sharing', 'Cancel']);
  assert.equal(h.q('#teamShareGpu').getAttribute('aria-checked'), 'true', 'the switch reads on while asking');
  h.click('[data-team-action="share-start"]');
  await flush();
  assert.deepEqual(h.sent('shareSet').map((c) => c.payload).at(-1), { team_id: OTHER, on: true, confirmed: true });
  assert.equal(h.q('.team-set-confirm'), null);
  assert.equal(h.window.document.activeElement, h.q('#teamShareGpu'));
});

test('Cancel closes the notice without sharing and gives the focus back to the switch', async (t) => {
  const h = memberPage(t, { answers: { shareSet: { ok: false, error: { code: 'invalid_request', reason: 'team_share_confirm_needed' } } } });
  await flush();
  h.click('#teamShareGpu');
  await flush();
  h.click('[data-team-action="share-cancel"]');
  await flush();
  assert.equal(h.q('.team-set-confirm'), null);
  assert.equal(h.sent('shareSet').length, 1, 'Cancel sends nothing');
  assert.equal(h.q('#teamShareGpu').getAttribute('aria-checked'), 'false');
  assert.equal(h.window.document.activeElement, h.q('#teamShareGpu'));
});

test('each state has its line, tone and buttons; the offers line names the models, the engine and this PC', async (t) => {
  const h = memberPage(t);
  await flush();
  const teams = [member()];
  await push(h, { teams, sharing: sharing('idle'), pools: {} });
  let state = h.q('.team-share-state');
  assert.equal(text(state.querySelector('.inv-status-row')), LINES.idle);
  assert.match(state.querySelector('.inv-status-row').className, /--success/);
  assert.deepEqual(buttons(state), ['Pause']);
  assert.equal(text(h.q('.team-share-offers')), `Offers ${M27} and ${M8}, the models running in llama-server on Tower.`);
  assert.equal(h.qa('.team-share-offers code').length, 2, 'each model in code');

  await push(h, { teams, sharing: sharing('serving', { serving_since: Date.now() - 42_000 }), pools: {} });
  state = h.q('.team-share-state');
  assert.match(text(state.querySelector('.inv-status-row')), /^Answering a request from the team · 4[2-3] s$/);
  assert.deepEqual(buttons(state), ['Pause', 'Stop now']);

  await push(h, { teams, sharing: sharing('busy_own'), pools: {} });
  state = h.q('.team-share-state');
  assert.equal(text(state.querySelector('.inv-status-row')), LINES.busy_own);
  assert.match(state.querySelector('.inv-status-row').className, /--warning/);
  assert.deepEqual(buttons(state), []);

  await push(h, { teams, sharing: sharing('paused'), pools: {} });
  state = h.q('.team-share-state');
  assert.equal(text(state.querySelector('.inv-status-row')), LINES.paused);
  assert.deepEqual(buttons(state), ['Resume']);
  assert.match(state.querySelector('[data-team-action="share-resume"]').className, /primary/);

  await push(h, { teams, sharing: sharing('no_model', { models: [], engine: null }), pools: {} });
  state = h.q('.team-share-state');
  assert.equal(text(state.querySelector('.inv-status-row')), LINES.no_model);
  assert.match(state.querySelector('.inv-status-row').className, /--danger/);
  assert.deepEqual(buttons(state), ['Open Models']);
  assert.equal(h.q('.team-share-offers'), null, 'nothing offered, no offers line');

  await push(h, { teams, sharing: sharing('starting', { models: [], engine: null }), pools: {} });
  state = h.q('.team-share-state');
  assert.equal(text(state.querySelector('.inv-status-row')), 'Starting…', 'starting has its line');
  assert.deepEqual(buttons(state), []);
  assert.equal(h.q('#teamShareGpu').getAttribute('aria-checked'), 'true');

  await push(h, { teams, sharing: sharing('host_not_ready', { models: [], engine: null }), pools: {} });
  state = h.q('.team-share-state');
  assert.equal(text(state.querySelector('.inv-status-row')), 'This team’s host is not set up to use shared GPUs yet.');
  assert.match(state.querySelector('.inv-status-row').className, /--warning/);
  assert.equal(h.q('#teamShareGpu').getAttribute('aria-checked'), 'true', 'the switch stays on');

  for (const [connection, word] of [['offline', 'offline'], ['reconnecting', 'reconnecting'], ['connecting', 'connecting']]) {
    await push(h, { teams, sharing: sharing('team_offline', { connection }), pools: {} });
    state = h.q('.team-share-state');
    assert.equal(text(state.querySelector('.inv-status-row')), word, `the page's word for a team that is ${connection}`);
    assert.match(state.querySelector('.inv-status-row').className, /--warning/);
    assert.deepEqual(buttons(state), [], 'nothing to pause while the team is out of reach');
    assert.equal(h.q('.team-share-offers'), null, 'nothing is offered to a team out of reach');
  }
});

test('the elapsed time ticks in its own text: the page is not rebuilt, an open control stays as it was', async (t) => {
  const h = memberPage(t);
  await flush();
  let tick = null;
  const realSet = globalThis.setInterval;
  globalThis.setInterval = (fn) => { tick = fn; return realSet(() => {}, 1e9); };
  t.after(() => { globalThis.setInterval = realSet; });
  await push(h, { teams: [member()], sharing: sharing('serving', { serving_since: Date.now() - 5_000 }), pools: {} });
  globalThis.setInterval = realSet;
  assert.equal(typeof tick, 'function', 'a ticker runs while a request is served');
  const track = h.q('#teamShareGpu');
  const row = h.q('.team-share-state .inv-status-row-message');
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try { tick(); } finally { Date.now = realNow; }
  assert.equal(h.q('#teamShareGpu'), track, 'the switch is the same element: no render');
  assert.equal(h.q('.team-share-state .inv-status-row-message'), row);
  assert.match(text(row), /^Answering a request from the team · 1 min [5-6] s$/);
  h.section.leaveTeamSection();
});

test('hostile names in the offers line are drawn as text', async (t) => {
  const h = memberPage(t, { teams: [member({ label: '<img src=x onerror=alert(1)>' })] });
  await flush();
  await push(h, { teams: [member({ label: '<img src=x onerror=alert(1)>' })], pools: {},
    sharing: sharing('idle', { models: ['<b>bold</b>', 'x"><script>'] }) });
  const offers = h.q('.team-share-offers');
  assert.equal(offers.querySelector('img, b, script'), null);
  assert.match(text(offers), /<img src=x onerror=alert\(1\)>/);
  assert.deepEqual([...offers.querySelectorAll('code')].map(text), ['<b>bold</b>', 'x"><script>']);
});

test('Open Models opens Settings > Models', async (t) => {
  const h = memberPage(t);
  await flush();
  const nav = h.window.document.createElement('button');
  nav.className = 'settings-nav-item';
  nav.dataset.settingsSection = 'models';
  let opened = 0;
  nav.addEventListener('click', () => { opened += 1; });
  h.window.document.body.appendChild(nav);
  await push(h, { teams: [member()], sharing: sharing('no_model', { models: [], engine: null }), pools: {} });
  h.click('[data-team-action="open-models"]');
  assert.equal(opened, 1);
});

test('Pause, Resume and Stop now beside Pause each make their call', async (t) => {
  const h = memberPage(t);
  await flush();
  await push(h, { teams: [member()], sharing: sharing('serving', { serving_since: Date.now() }), pools: {} });
  h.click('[data-team-action="share-pause"]');
  await flush();
  h.click('[data-team-action="share-stop-running"]');
  await flush();
  await push(h, { teams: [member()], sharing: sharing('paused'), pools: {} });
  h.click('[data-team-action="share-resume"]');
  await flush();
  assert.deepEqual(h.sent('sharePause').map((c) => c.payload), [
    { team_id: OTHER, on: true }, { team_id: OTHER, on: true, stop_running: true }, { team_id: OTHER, on: false }]);
});

test('switching off mid-request asks once with three buttons; idle switches off at once', async (t) => {
  const h = memberPage(t);
  await flush();
  await push(h, { teams: [member()], sharing: sharing('serving', { serving_since: Date.now() }), pools: {} });
  h.click('#teamShareGpu');
  await flush();
  const confirm = h.q('.team-set-confirm');
  assert.equal(text(confirm.querySelector('p')), OFF_QUESTION);
  assert.deepEqual(buttons(confirm), ['Stop after it', 'Stop now', 'Cancel']);
  assert.match(confirm.querySelector('[data-team-action="share-after"]').className, /primary/);
  assert.match(confirm.querySelector('[data-team-action="share-stop"]').className, /danger/);
  assert.deepEqual(buttons(h.q('.team-share-state')), [], 'Pause and Stop now step aside while asking');
  assert.equal(h.sent('shareSet').length, 0, 'asking sends nothing');
  h.click('[data-team-action="share-after"]');
  await flush();
  assert.deepEqual(h.sent('shareSet').map((c) => c.payload), [{ team_id: OTHER, on: false }]);
  assert.equal(h.window.document.activeElement, h.q('#teamShareGpu'));

  await push(h, { teams: [member()], sharing: sharing('serving', { serving_since: Date.now() }), pools: {} });
  h.click('#teamShareGpu');
  await flush();
  h.click('[data-team-action="share-stop"]');
  await flush();
  assert.deepEqual(h.sent('shareStop').map((c) => c.payload), [{ team_id: OTHER }]);

  await push(h, { teams: [member()], sharing: sharing('idle'), pools: {} });
  h.click('#teamShareGpu');
  await flush();
  assert.equal(h.q('.team-set-confirm'), null, 'idle does not ask');
  assert.deepEqual(h.sent('shareSet').map((c) => c.payload).at(-1), { team_id: OTHER, on: false });
});

test('a read-only member sees the switch disabled with the approved sentence and no state line', async (t) => {
  const h = memberPage(t, { teams: [member({ role: 'read_only' })] });
  await flush();
  await push(h, { teams: [member({ role: 'read_only' })], sharing: sharing('idle'), pools: {} });
  const track = h.q('#teamShareGpu');
  assert.equal(track.disabled, true);
  assert.equal(track.getAttribute('aria-checked'), 'false');
  assert.equal(text(h.q('#teamShareHelp')), READ_ONLY);
  assert.equal(h.q('.team-share-state'), null);
  track.click();
  await flush();
  assert.equal(h.sent('shareSet').length, 0);
});

test('two teams: a team picker; the other team while one shares is refused with its sentence', async (t) => {
  const teams = [member(), snapshot({ team_id: TEAM, team_name: 'Studio', role: 'member', state: 'online' })];
  const h = memberPage(t, { teams, answers: { shareSet: { ok: false, error: { code: 'invalid_request', reason: 'node_agent_running' } } } });
  await flush();
  await push(h, { teams, sharing: sharing('idle'), pools: {} });
  const picker = h.q('#teamShareTeam');
  assert.ok(picker, 'one PC shares with one team at a time: the row picks the team');
  assert.equal(picker.value, OTHER, 'the sharing team is shown first');
  h.choose('#teamShareTeam', TEAM);
  await flush();
  assert.equal(text(h.q('#teamShareTitle')), 'Share with Studio');
  assert.equal(h.q('#teamShareGpu').getAttribute('aria-checked'), 'false');
  h.click('#teamShareGpu');
  await flush();
  assert.equal(h.sent('shareSet').at(-1).payload.team_id, TEAM);
  assert.match(h.text(), /This PC already shares its GPU with another team\. Turn that off first\./);
});

// ------------------------------------------------------------------ owner

const USAGE = {
  ok: true,
  totals: [{ member_id: DOT, requests: 140, tokens: 1_900_000 }, { member_id: ME, requests: 1, tokens: 880_000 }],
  rows: [{ seq: 9, at: Date.UTC(2026, 10, 12, 10, 42), member_id: DOT, model: M27, tokens: 2140, duration_ms: 18_000, node_member_id: DOT, node_label: 'Tower' },
    { seq: 8, at: Date.UTC(2026, 10, 12, 9, 58), member_id: ME, model: M8, tokens: null, duration_ms: 9_000, node_member_id: ME, node_label: 'Desk' }],
  next_cursor: 8,
};
const POOL = { [TEAM]: { nodes: [node({ member_id: DOT }), node({ node_id: 'node_BBBBBBBBBBBBBBBB', member_id: ME, label: 'Desk',
  models: [{ name: M8, context_length: null, vision: false, thinking: false }] })], team_model: null, automatic_model: M27 } };

function ownerPage(t, answers = {}) {
  const h = harness({ host: hostState(), teams: [snapshot({ label: 'Desk' })], answers: {
    members: { ok: true, team: { team_id: TEAM, name: 'Studio' }, members: ROSTER }, gpuUse: USAGE, ...answers } });
  t.after(h.restore);
  return h;
}

test('owner page: Share, Team GPUs and GPU use sit after Your devices, before Activity', async (t) => {
  const h = ownerPage(t);
  await flush();
  await push(h, { teams: [snapshot({ label: 'Desk' })], sharing: null, pools: POOL });
  const headings = h.headings();
  const at = headings.indexOf('Your devices');
  assert.deepEqual(headings.slice(at, at + 5), ['Your devices', 'Share this PC’s GPU', 'Team GPUs', 'GPU use', 'Activity']);
  assert.equal(text(h.q('#teamShareTitle')), 'Share with Studio');
});

test('Team model: Automatic first, then every online model; the help names Automatic now; a change sets it', async (t) => {
  const h = ownerPage(t);
  await flush();
  await push(h, { teams: [snapshot({ label: 'Desk' })], sharing: null, pools: POOL });
  const select = h.q('#teamModel');
  assert.deepEqual([...select.options].map((o) => o.textContent), ['Automatic', M27, M8]);
  assert.equal(select.value, 'auto');
  assert.equal(text(h.q('[data-settings-field="teamModelRow"] .settings-field-title')), 'Team model');
  assert.equal(text(h.q('#teamModelHelp')), `New conversations start on it. Anyone can pick another model in their own conversation. Automatic picks the model offered by the most connected hardware (now ${M27}).`);
  h.choose('#teamModel', M8);
  await flush();
  h.choose('#teamModel', 'auto');
  await flush();
  assert.deepEqual(h.sent('teamModelSet').map((c) => c.payload), [{ team_id: TEAM, model: M8 }, { team_id: TEAM, model: null }]);
  // A stored model that is not online reads as Automatic.
  await push(h, { teams: [snapshot({ label: 'Desk' })], sharing: null, pools: { [TEAM]: { ...POOL[TEAM], team_model: 'gone-model' } } });
  assert.equal(h.q('#teamModel').value, 'auto');
  // Paused hardware answers nothing: its models are not offered and a stored one on it reads as Automatic.
  const paused = { [TEAM]: { ...POOL[TEAM], team_model: M8, nodes: [POOL[TEAM].nodes[0], { ...POOL[TEAM].nodes[1], paused: true }] } };
  await push(h, { teams: [snapshot({ label: 'Desk' })], sharing: null, pools: paused });
  assert.deepEqual([...h.q('#teamModel').options].map((o) => o.textContent), ['Automatic', M27]);
  assert.equal(h.q('#teamModel').value, 'auto');
  // With nothing online there is no Team GPUs group.
  await push(h, { teams: [snapshot({ label: 'Desk' })], sharing: null, pools: { [TEAM]: { nodes: [node({ online: false })], team_model: null, automatic_model: null } } });
  assert.equal(h.q('#teamModel'), null);
  assert.equal(h.headings().includes('Team GPUs'), false);
});

test('GPU use: totals per person, every request behind the fold, Show more with a cursor', async (t) => {
  const h = ownerPage(t);
  await flush();
  const group = () => h.q('[data-team-group="use"]');
  assert.equal(text(group().querySelector('.settings-group-heading')), 'GPU uselast 7 days');
  assert.equal(text(group().querySelector('.settings-group-copy')),
    'Requests people sent from their own chats through the team. Jenny records who, when, the model, the hardware and the token count, never the words.');
  assert.deepEqual(h.sent('gpuUse').map((c) => c.payload), [{ team_id: TEAM, limit: 20 }]);
  const totals = [...group().querySelectorAll('[data-team-use] .team-set-person')].map(text);
  assert.deepEqual(totals, ['Dot140 requests · 1.9 million tokens', 'Olive Owner1 request · 880,000 tokens']);
  assert.equal(group().querySelector('[data-team-use-requests]'), null, 'the requests are folded');
  assert.deepEqual(buttons(group()), ['Show every request']);
  h.click('[data-team-action="use-toggle"]');
  await flush();
  const lines = [...group().querySelectorAll('[data-team-use-requests] li')].map((li) => [...li.children].slice(1).map(text).join(' | '));
  assert.deepEqual(lines, [`Dot | ${M27} · on Dot’s Tower · 2,140 tokens · 18 s`, `Olive Owner | ${M8} · on Olive Owner’s Desk · no count sent · 9 s`]);
  assert.deepEqual(buttons(group()), ['Show more', 'Hide the requests']);
  h.click('[data-team-action="use-more"]');
  await flush();
  assert.deepEqual(h.sent('gpuUse').at(-1).payload, { team_id: TEAM, limit: 20, cursor: 8 });
  h.click('[data-team-action="use-toggle"]');
  await flush();
  assert.equal(group().querySelector('[data-team-use-requests]'), null);
});

test('GPU use: a refused or degraded log shows Unavailable, not an empty list', async (t) => {
  const h = ownerPage(t, { gpuUse: { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_pool_unavailable' } } });
  await flush();
  const group = h.q('[data-team-group="use"]');
  assert.match(text(group), /Unavailable/);
  assert.equal(group.querySelector('[data-team-use]'), null);
  assert.doesNotMatch(text(group), /Nothing has happened yet/);
});

test('a member page never shows the owner groups or reads GPU use', async (t) => {
  const h = memberPage(t);
  await flush();
  await push(h, { teams: [member()], sharing: null, pools: { [OTHER]: POOL[TEAM] } });
  assert.equal(h.headings().includes('GPU use'), false);
  assert.equal(h.headings().includes('Team GPUs'), false);
  assert.equal(h.sent('gpuUse').length, 0);
});

test('leaving the page stops the elapsed timer', async (t) => {
  const h = memberPage(t);
  await flush();
  await push(h, { teams: [member()], sharing: sharing('serving', { serving_since: Date.now() }), pools: {} });
  const gpu = require('../renderer/shell/renderer-settings-team-gpu');
  assert.equal(gpu._ticking, true);
  h.section.leaveTeamSection();
  assert.equal(gpu._ticking, false);
});

test('with the Team feature off no script of this slice loads: both live only in the lazy team lists', () => {
  const manifest = require('../renderer/shell/renderer-settings-script-manifest');
  const fs = require('node:fs');
  const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
  for (const src of ['renderer/shell/renderer-settings-team-gpu.js', 'renderer/team/renderer-team-gpus.js']) {
    assert.equal(manifest.some(([s]) => s === src), false, `${src} is not in the always-loaded group`);
    assert.equal(html.includes(src), false, `${src} is not in index.html`);
  }
  assert.ok(manifest.teamSection.some(([s]) => s === 'renderer/shell/renderer-settings-team-gpu.js'));
  assert.ok(manifest.teamTab.some(([s]) => s === 'renderer/team/renderer-team-gpus.js'));
});

test('GPU use: hostile member, PC and model names are drawn as text', async (t) => {
  const evil = '<img src=x onerror=alert(1)>';
  const roster = ROSTER.map((m) => (m.member_id === DOT ? { ...m, display_name: evil } : m));
  const h = harness({ host: hostState(), teams: [snapshot({ label: 'Desk' })], answers: {
    members: { ok: true, team: { team_id: TEAM, name: 'Studio' }, members: roster },
    gpuUse: { ...USAGE, rows: [{ ...USAGE.rows[0], model: '<b>m</b>', node_label: '<i>pc</i>' }] } } });
  t.after(h.restore);
  await flush();
  h.click('[data-team-action="use-toggle"]');
  await flush();
  const group = h.q('[data-team-group="use"]');
  assert.equal(group.querySelector('img, b, i'), null);
  assert.match(text(group), /<img src=x onerror=alert\(1\)>140 requests/);
  assert.match(text(group.querySelector('[data-team-use-requests] li')), /<b>m<\/b> · on <img src=x onerror=alert\(1\)>’s <i>pc<\/i>/);
});
