'use strict';

// new-test-file: Settings > Team's "Project files" group (row 123, file tools on a team host, slice 3) is a new module
// with its own surface; renderer-settings-team-section.test.js and renderer-settings-team-models.test.js sit near the
// line cap. It also holds the project page's paused "Always allowed" section, which this slice changes and no existing
// renderer test reaches. The group: each file_tools state, the help suffix, Force local, the confirm and its calls,
// a failed answer, absence without the host field. Real modules over the shared team harness.

const test = require('node:test');
const assert = require('node:assert/strict');
const { TEAM, flush, snapshot, hostState, harness, inventory } = require('./helpers/team-settings-harness');

const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();
const HELP = 'Members’ prompts, and text inside the files themselves, can make Jenny read and change files in team project folders on this PC. Every change asks a person first. Jenny cannot reach any other folder.';
const COPY = 'When a member asks in a project’s conversation, Jenny can read, search, write and edit files in that project’s folder on this PC.';
const SUFFIX = ' Takes effect when you start the server.';
const WINDOWS_HELP = 'Not on Windows yet. It waits for a safety review of how Jenny reaches files on Windows.';
const TOGGLE = '[data-inv-toggle="teamFileTools"]';

async function ownerPage(t, fileTools, { host = {}, answers = {} } = {}) {
  const h = harness({ host: hostState({ ...(fileTools === undefined ? {} : { file_tools: fileTools }), ...host }), teams: [snapshot()], answers });
  t.after(h.restore);
  await flush();
  await flush();
  return h;
}
const group = (h) => h.q('[data-team-group="files"]');
const line = (h) => { const el = group(h).querySelector('.team-relay-state'); return el ? text(el) : null; };
const checked = (h) => h.q('#teamFileTools').getAttribute('aria-checked');
const disabled = (h) => { const el = h.q('#teamFileTools'); return el.disabled === true || el.getAttribute('aria-disabled') === 'true'; };
const tone = (h) => group(h).querySelector('.team-relay-state [data-tone], .team-relay-state .inv-status-row, .team-relay-state > *');

test('absent: the group is not drawn without the host\'s file_tools field', async (t) => {
  const h = await ownerPage(t, undefined);
  assert.equal(group(h), null);
  assert.equal(h.headings().includes('Project files'), false);
});

test('off: the group sits after Model sharing with its copy and an unchecked, enabled switch and no line', async (t) => {
  const h = await ownerPage(t, { on: false, state: 'off', reason: null });
  const headings = h.headings();
  assert.ok(headings.indexOf('Project files') > headings.indexOf('GPU use'), headings.join('|'));
  assert.equal(text(group(h).querySelector('.settings-group-copy')), COPY);
  assert.equal(text(h.q('#teamFileToolsTitle')), 'Let Jenny work with project files');
  assert.equal(text(h.q('#teamFileToolsHelp')), HELP);
  assert.equal(checked(h), 'false');
  assert.equal(disabled(h), false);
  assert.equal(line(h), null);
  assert.equal(h.sent('hostFileTools').length, 0, 'nothing is set by drawing');
});

test('an unknown state draws like off', async (t) => {
  const h = await ownerPage(t, { on: false, state: 'mystery', reason: null });
  assert.equal(checked(h), 'false');
  assert.equal(disabled(h), false);
  assert.equal(line(h), null);
});

test('unavailable: off and greyed, with the Windows sentence in place of the help', async (t) => {
  const h = await ownerPage(t, { on: false, state: 'unavailable', reason: 'team_file_tools_windows_unreviewed' });
  assert.equal(checked(h), 'false');
  assert.equal(disabled(h), true);
  assert.equal(text(h.q('#teamFileToolsHelp')), WINDOWS_HELP);
});

test('an on switch is never disabled by the reason, so it can always be turned off', async (t) => {
  const h = await ownerPage(t, { on: true, state: 'unavailable', reason: 'team_file_tools_windows_unreviewed' });
  assert.equal(checked(h), 'true');
  assert.equal(disabled(h), false);
  assert.equal(text(h.q('#teamFileToolsHelp')), HELP);
});

test('saved: on, the server stopped, the help says when it takes effect, and no state line', async (t) => {
  const h = await ownerPage(t, { on: true, state: 'saved', reason: null }, { host: { state: 'stopped', owner: true } });
  assert.equal(checked(h), 'true');
  assert.equal(text(h.q('#teamFileToolsHelp')), HELP + SUFFIX);
});

test('starting: on, waiting for the server to start project files', async (t) => {
  const h = await ownerPage(t, { on: true, state: 'starting', reason: null });
  assert.equal(checked(h), 'true');
  assert.equal(line(h), 'Waiting for the server to start project files.');
  assert.equal(text(h.q('#teamFileToolsHelp')), HELP);
});

test('working: on, with the success line', async (t) => {
  const h = await ownerPage(t, { on: true, state: 'working', reason: null });
  assert.equal(checked(h), 'true');
  assert.equal(line(h), 'On. Members see file tools in project conversations.');
  assert.match(String(tone(h).outerHTML), /success/);
});

test('not working: a known reason says its sentence; an unknown reason uses the generic one', async (t) => {
  const known = await ownerPage(t, { on: true, state: 'not_working', reason: 'file_access_elevated' });
  assert.equal(line(known), 'On, but Jenny could not open project files: Jenny is running as administrator. Start Jenny normally, then restart the server. Until then members get no file tools.');
  assert.match(String(tone(known).outerHTML), /warning/);
  assert.equal(disabled(known), false);
  known.restore();
  const unknown = await ownerPage(t, { on: true, state: 'not_working', reason: 'file_access_made_up' });
  assert.equal(line(unknown), 'On, but Jenny could not open project files: Jenny could not start file access. Until then members get no file tools.');
});

test('not working: every reason word has its own sentence', async (t) => {
  const words = ['api_missing', 'backup_privilege', 'component_missing', 'elevated', 'platform_unsupported', 'root_identity', 'root_invalid', 'selfcheck_failed', 'switch_off', 'volume_unsupported', 'unavailable'];
  const seen = new Set();
  for (const word of words) {
    const h = await ownerPage(t, { on: true, state: 'not_working', reason: 'file_access_' + word });
    seen.add(line(h));
    h.restore();
  }
  assert.equal(seen.size, words.length);
});

test('Force local greys the switch and says why', async (t) => {
  const h = await ownerPage(t, { on: false, state: 'off', reason: null }, { host: { force_local: true } });
  assert.equal(disabled(h), true);
  assert.equal(text(h.q('#teamFileToolsHelp')), require('../renderer/shell/renderer-settings-team-strings').forceLocalText());
});

test('turning on asks first (running): no call until Turn on; Cancel clears the question', async (t) => {
  const h = await ownerPage(t, { on: false, state: 'off', reason: null }, { answers: { hostFileTools: (p) => ({ ok: true, host: hostState({ file_tools: { on: p.on, state: 'starting', reason: null } }), restarted: true }) } });
  h.q(TOGGLE).click();
  await flush();
  const ask = group(h).querySelector('.team-set-confirm');
  assert.equal(text(ask.querySelector('p')), 'Turn on project files? The server restarts and members reconnect by themselves. From then on a member’s prompt, or text inside a file, can lead Jenny to change files in team project folders; each change still asks a person first.');
  assert.equal(h.sent('hostFileTools').length, 0, 'asked, not done');
  h.q('[data-team-action="confirm-cancel"]').click();
  await flush();
  assert.equal(group(h).querySelector('.team-set-confirm'), null);
  assert.equal(h.sent('hostFileTools').length, 0);
  h.q(TOGGLE).click();
  await flush();
  h.q('[data-team-action="files-confirm-on"]').click();
  await flush();
  assert.deepEqual(h.sent('hostFileTools').map((c) => c.payload), [{ on: true }]);
  assert.equal(group(h).querySelector('.team-set-confirm'), null, 'a good answer clears the question');
  assert.equal(checked(h), 'true', 'the page redraws from the answer\'s host state');
});

test('turning on asks first (stopped): the sentence says it takes effect when the server starts', async (t) => {
  const h = await ownerPage(t, { on: false, state: 'off', reason: null }, { host: { state: 'stopped', owner: true } });
  h.q(TOGGLE).click();
  await flush();
  assert.equal(text(group(h).querySelector('.team-set-confirm p')), 'Turn on project files? From then on a member’s prompt, or text inside a file, can lead Jenny to change files in team project folders; each change still asks a person first. It takes effect when you start the server.');
});

test('turning off asks nothing and calls at once', async (t) => {
  const h = await ownerPage(t, { on: true, state: 'working', reason: null }, { answers: { hostFileTools: (p) => ({ ok: true, host: hostState({ file_tools: { on: p.on, state: 'off', reason: null } }), restarted: true }) } });
  h.q(TOGGLE).click();
  await flush();
  assert.deepEqual(h.sent('hostFileTools').map((c) => c.payload), [{ on: false }]);
  assert.equal(group(h).querySelector('.team-set-confirm'), null);
  assert.equal(checked(h), 'false');
});

test('while the call is out and the server runs, the restarting sentence replaces the state line and the switch is greyed', async (t) => {
  let release;
  const h = await ownerPage(t, { on: true, state: 'working', reason: null }, { answers: { hostFileTools: () => new Promise((resolve) => { release = resolve; }) } });
  h.q(TOGGLE).click();
  await flush();
  assert.equal(line(h), 'Restarting the server with the new setting…');
  assert.equal(disabled(h), true);
  release({ ok: true, host: hostState({ file_tools: { on: false, state: 'off', reason: null } }), restarted: true });
  await flush();
  assert.equal(line(h), null);
});

test('a failed answer shows its reason sentence and clears the question', async (t) => {
  const h = await ownerPage(t, { on: false, state: 'off', reason: null }, { answers: { hostFileTools: () => ({ ok: false, error: { reason: 'team_host_turn_running' } }) } });
  h.q(TOGGLE).click();
  await flush();
  h.q('[data-team-action="files-confirm-on"]').click();
  await flush();
  assert.equal(text(group(h).querySelector('.team-set-note')), 'A turn is running in a team project. Try again when it finishes.');
  assert.equal(group(h).querySelector('.team-set-confirm'), null);
  assert.equal(checked(h), 'false');
});

test('the Windows refusal has its sentence', () => {
  const words = require('../renderer/shell/renderer-settings-team-strings');
  assert.equal(words.errorText({ reason: 'team_file_tools_windows_unreviewed' }), 'Project files are not on Windows yet. They wait for a safety review of how Jenny reaches files on Windows.');
  assert.equal(words.errorText({ reason: 'team_host_turn_running' }), 'A turn is running in a team project. Try again when it finishes.');
});

// ------------------------------------------------------------------ the project page's "Always allowed"

const PAUSED_SENTENCE = 'Paused while project files are on: every change Jenny makes asks a person, whatever these rules say. The host’s owner turns project files on and off in Settings, Team.';
const PAUSED_TITLE = 'Paused while project files are on';
const RULES = {
  ok: true,
  rules: [{ rule_seq: 1, tool_name: 'write_file', folder: 'docs', set_by: 'maya' }, { rule_seq: 2, tool_name: 'edit_file', folder: '', set_by: 'me' }],
  requests: [{ request_seq: 7, tool_name: 'write_file', asker_member_id: 'maya', session_id: 's', asked_at: 1, state: 'open' }],
};

async function rulesSection(t, answer, admin = true) {
  const saved = globalThis.inventory;
  globalThis.inventory = inventory();
  t.after(() => { if (saved === undefined) delete globalThis.inventory; else globalThis.inventory = saved; });
  const calls = [];
  const rules = require('../renderer/team/renderer-team-project-rules').createRules({ teamId: 't', projectId: 'p',
    call: async (method, payload) => { calls.push({ method, payload }); return method === 'projectRules' ? answer : { ok: true }; },
    isAdmin: () => admin, nameOf: (id) => id, conversationTitle: () => '', timeText: () => 'now', errorText: () => 'error', onChange() {} });
  await rules.refresh();
  return { rules, calls, html: rules.html() };
}

test('rules: paused adds the sentence, dims the list and disables every button with the title', async (t) => {
  const { html, rules, calls } = await rulesSection(t, { ...RULES, paused: 'file_tools' });
  assert.ok(html.includes(PAUSED_SENTENCE));
  assert.match(html, /<ul class="team-set-list team-set-list--paused" aria-disabled="true">/);
  const buttons = html.match(/<button[^>]*>/g);
  assert.ok(buttons.length >= 5, 'Allow, Change, Decline, Remove x2, Add a rule');
  for (const tag of buttons) {
    assert.match(tag, /disabled/, tag);
    assert.ok(tag.includes('title="' + PAUSED_TITLE + '"'), tag);
  }
  assert.ok(html.includes('Always allowed') && html.includes('write_file'), 'the rules stay visible');
  const fake = (action, extra = {}) => ({ dataset: { projectAction: action, requestSeq: '7', ruleSeq: '1', ...extra } });
  for (const action of ['rule-allow', 'rule-change', 'rule-decline', 'rule-add', 'rule-remove']) rules.onClick(fake(action));
  assert.deepEqual(calls.filter((c) => c.method !== 'projectRules'), [], 'a paused click calls nothing');
  assert.equal(rules.html(), html, 'and opens no form');
});

test('rules: without paused the markup carries none of it', async (t) => {
  const plain = await rulesSection(t, RULES);
  assert.equal(plain.html.includes('Paused while'), false);
  assert.equal(plain.html.includes('aria-disabled'), false);
  assert.equal(plain.html.includes('team-set-list--paused'), false);
  const none = await rulesSection(t, { ...RULES, paused: null });
  assert.equal(none.html, plain.html);
  const other = await rulesSection(t, { ...RULES, paused: 'something_else' });
  assert.equal(other.html, plain.html, 'only file_tools pauses');
  const click = plain.rules.onClick({ dataset: { projectAction: 'rule-allow', requestSeq: '7' } });
  assert.equal(click, true);
  assert.equal(plain.calls.some((c) => c.method === 'projectRuleAnswer'), true, 'unpaused, Allow still answers');
});

test('a stopped server draws the group for its owner only', async (t) => {
  const tools = { on: false, state: 'off', reason: null };
  const owner = await ownerPage(t, tools, { host: { state: 'stopped', owner: true } });
  assert.notEqual(group(owner), null);
  owner.restore();
  const other = await ownerPage(t, tools, { host: { state: 'stopped', owner: false } });
  assert.equal(group(other), null);
});

test('rules: a member (not an admin) sees the sentence and the dimmed list too', async (t) => {
  const { html } = await rulesSection(t, { ...RULES, paused: 'file_tools' }, false);
  assert.ok(html.includes(PAUSED_SENTENCE));
  assert.match(html, /team-set-list--paused/);
});
