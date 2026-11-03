'use strict';

// Row 87: the Jenny chat's rules in Activity > Permissions (one "Your rules" list folding in row 76's launch
// permissions, the sentence-builder add form, Remove) and the rule entries in the Activity pane.

const test = require('node:test');
const assert = require('node:assert/strict');

const { SID, RULE_A, RULE_B, flush, entry, fixtures, harness } = require('./primary-activity-fixtures');
const primaryRules = require('../renderer/chat/renderer-primary-rules');

test('the Permissions tab lists live rules and launch permissions as sentences, hides revoked ones and escapes names', async (t) => {
  const h = harness(t, { projects: [{ id: 'p1', name: 'Website <b>x</b>' }, { id: 'p2', name: 'Perf' }] });
  h.open();
  await flush();
  assert.equal(h.$('[data-primary-pane="permissions"]').hidden, true);
  h.showPermissions();
  assert.equal(h.$('[data-primary-pane="permissions"]').hidden, false);
  assert.equal(h.$('[data-primary-pane="activity"]').hidden, true);
  const rows = h.all('[data-primary-pane="permissions"] .primary-activity__perm');
  assert.deepEqual(rows.map((row) => row.getAttribute('data-permission-id')), [RULE_A, 'perm-1', 'perm-2', RULE_B, 'g-1']);
  const titles = rows.map((row) => row.querySelector('.primary-activity__perm-title').textContent);
  assert.deepEqual(titles.slice(0, 4), ['Message chats Jenny started without asking', 'Start chats in Website <b>x</b> without asking',
    'Start chats in every project without asking', 'Never stop any chat']);
  assert.equal(h.$('[data-primary-pane="permissions"] b'), null);
  assert.match(rows[0].querySelector('.primary-activity__perm-meta').textContent, /^Any run mode · up to 60 a day · added /u);
  assert.match(rows[1].querySelector('.primary-activity__perm-meta').textContent, /^Any run mode · 1 chat per request · added /u);
  assert.match(rows[2].querySelector('.primary-activity__perm-meta').textContent, /^Only while Jenny is in Auto · 3 chats per request · added /u);
  assert.match(rows[3].querySelector('.primary-activity__perm-meta').textContent, /^Any run mode · added /u);
  assert.equal(rows[0].querySelector('[data-primary-rule-revoke]').textContent, 'Remove');
  assert.equal(rows[1].querySelector('[data-primary-permission-revoke]').textContent, 'Remove');
  assert.equal(rows[4].querySelector('[data-primary-message-grant-revoke]').textContent, 'Revoke');
  assert.match(rows[4].querySelector('.primary-activity__perm-meta').textContent, /^"Keep notes in step" · 97 sends left · expires /u);
  const notes = h.all('[data-primary-pane="permissions"] .chat-review__note').map((node) => node.textContent);
  assert.deepEqual(notes, ['Adds: Message chats Jenny started without asking',
    'A message from another chat, a scheduled check or a digest never uses an "allow" rule; Jenny asks you instead.',
    'None live. A /linked request grants one for an hour.']);
  const kickers = h.all('.primary-activity__kicker').map((node) => node.textContent);
  assert.deepEqual(kickers, ['Your rules', 'Message grants', 'One-turn grants']);
});

test('no live rule reads None; the form drops what a flag turns off, and hides when both are off', async (t) => {
  const data = fixtures();
  data.permissions = { launch: [], rules: [], message_grants: [], turn_grants: [{ authorization_ref: 'ref-1', created_at: '2026-10-25T08:00:00.000Z', expires_at: '2026-10-25T09:30:00.000Z', remaining: 1, revoked_at: null, live: true }] };
  data.flags.action_rules = false;
  const h = harness(t, { data });
  h.open({ pane: 'permissions' });
  await flush();
  assert.deepEqual(h.options('data-primary-rule-effect'), [['allow', 'Always allow']]);
  assert.deepEqual(h.options('data-primary-rule-action'), [['launch', 'starting chats']]);
  data.flags.launch_permission = false;
  for (const listener of h.listeners) listener({ schema_version: 1 });
  await flush();
  await flush();
  assert.equal(h.$('.primary-activity__form'), null);
  const notes = h.all('[data-primary-pane="permissions"] .chat-review__note').map((node) => node.textContent);
  assert.equal(notes[0], 'None. Jenny asks you before it messages, starts or stops other chats.');
  assert.equal(notes.at(-1), 'None live.');
  const turn = h.$('[data-permission-id="ref-1"]');
  assert.equal(turn.querySelector('.primary-activity__perm-title').textContent, 'A /linked request');
  assert.equal(turn.querySelector('[data-primary-permission-revoke]'), null);
});

test('the add form follows its first choice, offers the chats Jenny started, and sends addRule', async (t) => {
  const state = { sessions: [
    { id: 'kid-1', title: 'Hero copy', spawned_from: { parent_session_id: SID } },
    { id: 'kid-2', title: 'Old', spawned_from: { parent_session_id: SID }, archived: true },
    { id: 'other', title: 'Mine', spawned_from: null },
  ] };
  const h = harness(t, { state });
  h.open({ pane: 'permissions' });
  await flush();
  assert.deepEqual(h.options('data-primary-rule-effect').map(([value]) => value), ['allow', 'ask', 'deny']);
  assert.deepEqual(h.options('data-primary-rule-action').map(([value]) => value), ['message', 'launch']);
  assert.deepEqual(h.options('data-primary-rule-target'), [['linked', 'chats Jenny started'], ['any', 'any chat'], ['p:p1', 'chats in Website'],
    ['p:p2', 'chats in Perf'], ['c:kid-1', 'Hero copy']]);
  h.choose('data-primary-rule-effect', 'deny');
  assert.deepEqual(h.options('data-primary-rule-action').map(([value]) => value), ['message', 'launch', 'stop', 'schedule', 'setting']);
  h.choose('data-primary-rule-action', 'setting');
  assert.equal(h.$('[data-primary-rule-target]'), null, 'settings rules have no target');
  assert.equal(h.$('[data-primary-pane="permissions"] .chat-review__note').textContent, 'Adds: Never change settings');
  h.choose('data-primary-rule-action', 'stop');
  h.choose('data-primary-rule-target', 'c:kid-1');
  h.$('[data-primary-rule-auto]').click();
  const before = h.calledWith('permissions').length;
  h.$('[data-primary-rule-submit]').click();
  await flush();
  await flush();
  assert.deepEqual(h.calledWith('addRule')[0].request, { schema_version: 1, action: 'stop', target: { kind: 'chat', id: 'kid-1' }, effect: 'deny', run_modes: ['auto'] });
  assert.equal(h.calledWith('permissions').length, before + 1, 'refetched');
  assert.equal(h.$('[data-primary-rule-target]').value, 'c:kid-1', 'the form keeps its choices across the repaint');
});

test('Always allow starting chats goes through grantLaunch with the project, or * for every project', async (t) => {
  const h = harness(t);
  h.open({ pane: 'permissions' });
  await flush();
  h.choose('data-primary-rule-action', 'launch');
  assert.deepEqual(h.options('data-primary-rule-target'), [['p:p1', 'in Website'], ['p:p2', 'in Perf'], ['any', 'in every project']]);
  h.choose('data-primary-rule-target', 'p:p2');
  h.$('[data-primary-rule-submit]').click();
  await flush();
  await flush();
  assert.deepEqual(h.calledWith('grantLaunch')[0].request, { schema_version: 1, project_id: 'p2', run_modes: null });
  h.choose('data-primary-rule-target', 'any');
  h.$('[data-primary-rule-submit]').click();
  await flush();
  await flush();
  assert.deepEqual(h.calledWith('grantLaunch')[1].request, { schema_version: 1, project_id: '*', run_modes: null });
  assert.equal(h.calledWith('addRule').length, 0);
});

test('a refused rule paints a notice, and a full list says to remove one first', async (t) => {
  const h = harness(t, { ruleAnswer: { schema_version: 1, ok: false, code: 'CMP-PRIMARY-0007', reason: 'capacity', retryable: false } });
  h.open({ pane: 'permissions' });
  await flush();
  h.$('[data-primary-rule-submit]').click();
  await flush();
  await flush();
  assert.equal(h.$('.chat-review__notice').textContent, 'The rule list is full; remove one first.');
  const other = harness(t, { ruleAnswer: { schema_version: 1, ok: false, reason: 'unknown_project' } });
  other.open({ pane: 'permissions' });
  await flush();
  other.$('[data-primary-rule-submit]').click();
  await flush();
  await flush();
  assert.equal(other.$('.chat-review__notice').textContent, 'Could not add that rule.');
});

test('Remove sends revokeRule or revokeLaunch with the id, then refetches; a message grant goes through chatMessages.revokeGrant', async (t) => {
  const h = harness(t);
  h.open({ pane: 'permissions' });
  await flush();
  const before = h.calledWith('permissions').length;
  h.$(`[data-primary-rule-revoke="${RULE_B}"]`).click();
  await flush();
  await flush();
  assert.deepEqual(h.calledWith('revokeRule')[0].request, { schema_version: 1, rule_id: RULE_B });
  assert.equal(h.calledWith('permissions').length, before + 1);
  h.$('[data-primary-permission-revoke="perm-2"]').click();
  await flush();
  await flush();
  assert.deepEqual(h.calledWith('revokeLaunch')[0].request, { schema_version: 1, permission_id: 'perm-2' });
  h.$('[data-primary-message-grant-revoke="g-1"]').click();
  await flush();
  assert.deepEqual(h.calledWith('revokeGrant')[0].request, { schema_version: 1, source_session_id: SID, grant_id: 'g-1' });
});

test('rule entries read Rule added, Rule removed and Rule blocked; a send under a rule says so (row 87)', async (t) => {
  const data = fixtures();
  const rule = { action: 'message', target: { kind: 'project', id: 'p1' }, effect: 'deny' };
  data.activity = { entries: [
    { id: `rule:${RULE_A}:rule_denied:1`, kind: 'rule_denied', at: '2026-10-25T09:03:00.000Z', rule_id: RULE_A, rule },
    { id: `rule:${RULE_A}:rule_added:1`, kind: 'rule_added', at: '2026-10-25T09:02:00.000Z', rule_id: RULE_A, rule },
    { id: `rule:${RULE_B}:rule_revoked:1`, kind: 'rule_revoked', at: '2026-10-25T09:01:00.000Z', rule_id: RULE_B, rule: null },
    entry({ id: 'm', kind: 'message_sent', title: 'Hero copy', status: 'delivered', authorization: 'rule' }),
  ], truncated: false };
  const h = harness(t, { data });
  h.open();
  await flush();
  const rows = h.all('[data-primary-pane="activity"] li.chat-review__item');
  assert.deepEqual(rows.map((li) => li.querySelector('.primary-activity__kind').textContent), ['Rule blocked', 'Rule added', 'Rule removed', 'Message sent']);
  assert.equal(rows[0].querySelector('strong').textContent, 'Never message chats in Website');
  assert.equal(rows[0].querySelector('.chat-review__state').textContent, 'Refused by your rule');
  assert.equal(rows[0].querySelector('.chat-review__status').getAttribute('data-tone'), 'error');
  assert.equal(rows[1].querySelector('.chat-review__status'), null);
  assert.equal(rows[2].querySelector('strong').textContent, 'A rule that was removed');
  assert.equal(rows[3].querySelector('.chat-review__state').textContent, 'Delivered · under your rule');
});

test('submission maps the form to addRule, or to grantLaunch for a launch allow', () => {
  assert.deepEqual(primaryRules.submission({ effect: 'ask', action: 'message', target: 'p:p1', auto: false }),
    { method: 'addRule', request: { schema_version: 1, action: 'message', target: { kind: 'project', id: 'p1' }, effect: 'ask', run_modes: null } });
  assert.deepEqual(primaryRules.submission({ effect: 'allow', action: 'message', target: 'linked', auto: true }),
    { method: 'addRule', request: { schema_version: 1, action: 'message', target: { kind: 'linked_children' }, effect: 'allow', run_modes: ['auto'] } });
  assert.deepEqual(primaryRules.submission({ effect: 'deny', action: 'schedule', target: '', auto: false }).request.target, { kind: 'any' });
  assert.deepEqual(primaryRules.submission({ effect: 'allow', action: 'launch', target: 'any', auto: false }),
    { method: 'grantLaunch', request: { schema_version: 1, project_id: '*', run_modes: null } });
});

test('settleForm falls back to offered choices and returns null when nothing is offered', () => {
  const model = { projects: [{ id: 'p1', name: 'Website' }], sessions: [], primaryId: SID, state: { flags: { action_rules: true, launch_permission: true } } };
  const settled = primaryRules.settleForm({ effect: 'ask', action: 'stop', target: 'c:gone' }, model);
  assert.deepEqual([settled.effect, settled.action, settled.target, settled.auto], ['ask', 'message', 'linked', false]);
  assert.deepEqual(settled.offered, { allow: ['message', 'launch'], ask: ['message'], deny: ['message', 'launch', 'stop', 'schedule', 'setting'] });
  assert.deepEqual(settled.targets.map((option) => option.value), ['linked', 'any', 'p:p1']);
  assert.equal(primaryRules.settleForm({ effect: 'deny', action: 'setting' }, model).target, '');
  assert.equal(primaryRules.settleForm({}, { ...model, state: { flags: { action_rules: false, launch_permission: false } } }), null);
});
