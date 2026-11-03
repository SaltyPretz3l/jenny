'use strict';

/* Row 87 S1: the Jenny chat's per-action rules. The `actionRules` store shape, the controls service's
 * add / revoke / rule_denied writes, and the matcher (services/primary-action-rules.js): precedence,
 * target specificity, run modes, wake turns dropping allow rules, fail-closed ports and the flag. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPrimaryChatControls } = require('../services/primary-chat-controls');
const { createPrimaryActionRules, RULE_DENIED_MESSAGE } = require('../services/primary-action-rules');
const {
  PRIMARY_ACTION_RULE_SHAPES, PRIMARY_CHAT_LIMITS, applyPrimaryChatPatch, normalizeActionRule, normalizePrimaryChat,
} = require('../services/shell-config-primary-chat');

const PRIMARY = 'sess_primary';
const CHILD = 'sess_child';
const OTHER = 'sess_other';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const RID = (n) => `ar_${n.toString(16).padStart(32, '0')}`;
const AT = (n) => new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString();
const rule = (n, extra = {}) => ({
  rule_id: RID(n), action: 'message', target: { kind: 'any' }, effect: 'allow', run_modes: null,
  created_at: AT(n), revoked_at: null, ...extra,
});

function harness({ flags = {}, wake = false } = {}) {
  const config = { block: normalizePrimaryChat({}), writes: 0 };
  const configService = {
    getState: () => ({ primaryChat: JSON.parse(JSON.stringify(config.block)) }),
    updatePrimaryChat(patch) {
      config.block = applyPrimaryChatPatch(config.block, patch);
      config.writes += 1;
      return JSON.parse(JSON.stringify(config.block));
    },
  };
  const summaries = new Map([
    [PRIMARY, { id: PRIMARY, created_at: '2026-02-01T00:00:00.000Z', session_role: 'primary', project_id: null }],
    [CHILD, { id: CHILD, created_at: '2026-03-01T00:00:00.000Z', project_id: 'project_a', spawned_from: { parent_session_id: PRIMARY } }],
    [OTHER, { id: OTHER, created_at: '2026-01-01T00:00:00.000Z', project_id: 'project_b', spawned_from: null }],
  ]);
  const sessionStore = {
    listSessions: () => [...summaries.values()],
    peekSessionSummary: (id) => summaries.get(id) || null,
  };
  const state = { flags, clock: Date.parse('2026-10-25T12:00:00.000Z'), ids: 0, wake };
  const controls = createPrimaryChatControls({
    configService: () => configService,
    sessionStore: () => sessionStore,
    featureFlags: () => state.flags,
    projectService: () => ({ get: (id) => (['project_a', 'project_b'].includes(id) ? { id, name: id } : null) }),
    createRuleId: () => RID((state.ids += 1)),
    now: () => new Date(state.clock),
  });
  const rules = createPrimaryActionRules({
    controls: () => controls,
    getSessionSummary: (id) => summaries.get(id) || null,
    isWakeTurn: () => state.wake,
  });
  return { config, controls, rules, state };
}

test('store: each action offers only its effects and targets; invalid records are dropped', () => {
  assert.deepEqual(Object.keys(PRIMARY_ACTION_RULE_SHAPES), ['message', 'launch', 'stop', 'schedule', 'setting']);
  assert.ok(normalizeActionRule(rule(1)));
  assert.ok(normalizeActionRule(rule(1, { effect: 'ask', target: { kind: 'chat', id: CHILD } })));
  assert.ok(normalizeActionRule(rule(1, { action: 'launch', effect: 'deny', target: { kind: 'project', id: 'p' } })));
  for (const bad of [
    rule(1, { action: 'launch' }), // a launch allow is a launch permission, never a rule
    rule(1, { action: 'stop', effect: 'ask' }),
    rule(1, { action: 'schedule', effect: 'deny', target: { kind: 'linked_children' } }),
    rule(1, { action: 'launch', effect: 'deny', target: { kind: 'chat', id: CHILD } }),
    rule(1, { target: { kind: 'project', id: '*' } }),
    rule(1, { target: { kind: 'chat' } }),
    rule(1, { target: { kind: 'any', id: 'x' } }),
    rule(1, { target: { kind: 'chat', id: 'a\nb' } }),
    rule(1, { rule_id: 'lp_00000000000000000000000000000001' }),
    rule(1, { run_modes: [] }),
    rule(1, { run_modes: ['ask', 'ask'] }),
    rule(1, { created_at: '2026-13-45T00:00:00.000Z' }),
    rule(1, { action: 'delete' }),
  ]) assert.equal(normalizeActionRule(bad), null, JSON.stringify(bad));
  assert.deepEqual(normalizeActionRule(rule(1, { run_modes: ['plan', 'ask'] })).run_modes, ['ask', 'plan']);
  const block = normalizePrimaryChat({ actionRules: [rule(1), rule(1), { junk: true }, rule(2, { effect: 'nope' })] });
  assert.deepEqual(block.actionRules.map((entry) => entry.rule_id), [RID(1)]);
  const many = normalizePrimaryChat({ actionRules: Array.from({ length: 70 }, (_, i) => rule(i + 1)) });
  assert.equal(many.actionRules.length, PRIMARY_CHAT_LIMITS.action_rules_max);
  assert.equal(many.actionRules[0].rule_id, RID(7), 'over the cap the newest are kept');
  assert.deepEqual(normalizePrimaryChat({}).actionRules, []);
});

test('controls: add, dedupe, revoke and history; the model-facing kinds are not writable through recordHistory', () => {
  const { controls, config } = harness();
  const added = controls.addActionRule({ action: 'message', target: { kind: 'linked_children' }, effect: 'allow' });
  assert.equal(added.ok, true);
  assert.equal(added.created, true);
  assert.equal(added.rule.rule_id, RID(1));
  assert.equal(added.rule.run_modes, null);
  const again = controls.addActionRule({ action: 'message', target: { kind: 'linked_children' }, effect: 'allow' });
  assert.equal(again.created, false);
  assert.equal(again.rule.rule_id, RID(1));
  assert.equal(controls.listActionRules().length, 1);
  assert.deepEqual(config.block.history.map((row) => row.kind), ['rule_added']);
  const revoked = controls.revokeActionRule({ rule_id: RID(1) });
  assert.equal(revoked.ok, true);
  assert.ok(revoked.rule.revoked_at);
  assert.equal(controls.revokeActionRule({ rule_id: RID(1) }).created, false, 'a second revoke is a no-op');
  assert.deepEqual(controls.revokeActionRule({ rule_id: RID(9) }), { ok: false, reason: 'not_found' });
  assert.deepEqual(controls.revokeActionRule({ rule_id: 'nope' }), { ok: false, reason: 'invalid_request' });
  assert.deepEqual(config.block.history.map((row) => row.kind), ['rule_added', 'rule_revoked']);
  assert.equal(controls.listActionRules({ include_revoked: false }).length, 0);
  assert.equal(controls.recordHistory('rule_added'), false);
  assert.equal(controls.recordHistory('rule_denied'), false);
  const state = controls.getState();
  assert.equal(state.rules.length, 1);
  assert.equal(state.flags.action_rules, true);
});

test('controls: refuses invalid shapes, unknown targets, the Jenny chat itself, and the capacity', () => {
  const { controls, state, config } = harness();
  assert.deepEqual(controls.addActionRule({ action: 'launch', target: { kind: 'any' }, effect: 'allow' }), { ok: false, reason: 'invalid_request' });
  assert.deepEqual(controls.addActionRule(null), { ok: false, reason: 'invalid_request' });
  assert.deepEqual(controls.addActionRule({ action: 'stop', target: { kind: 'project', id: 'project_z' }, effect: 'deny' }),
    { ok: false, reason: 'unknown_project' });
  assert.deepEqual(controls.addActionRule({ action: 'message', target: { kind: 'chat', id: 'sess_gone' }, effect: 'deny' }),
    { ok: false, reason: 'not_found' });
  assert.deepEqual(controls.addActionRule({ action: 'message', target: { kind: 'chat', id: PRIMARY }, effect: 'deny' }),
    { ok: false, reason: 'not_found' });
  config.block = applyPrimaryChatPatch(config.block, {
    actionRules: Array.from({ length: PRIMARY_CHAT_LIMITS.action_rules_max }, (_, i) => rule(i + 1)),
  });
  state.ids = 500;
  assert.deepEqual(controls.addActionRule({ action: 'stop', target: { kind: 'any' }, effect: 'deny' }), { ok: false, reason: 'capacity' });
  controls.revokeActionRule({ rule_id: RID(1) });
  const room = controls.addActionRule({ action: 'stop', target: { kind: 'any' }, effect: 'deny' });
  assert.equal(room.ok, true, 'a revoked record makes room');
  assert.equal(config.block.actionRules.length, PRIMARY_CHAT_LIMITS.action_rules_max);
  assert.equal(config.block.actionRules.some((entry) => entry.rule_id === RID(1)), false, 'the revoked record was dropped first');
});

test('controls: flag off refuses adding but still revokes; revoked rules are pruned after 30 days', () => {
  const { controls, state, config } = harness();
  controls.addActionRule({ action: 'stop', target: { kind: 'any' }, effect: 'deny' });
  state.flags = { primary_action_rules: false };
  assert.deepEqual(controls.addActionRule({ action: 'setting', target: { kind: 'any' }, effect: 'deny' }), { ok: false, reason: 'disabled' });
  assert.equal(controls.revokeActionRule({ rule_id: RID(1) }).ok, true);
  assert.equal(controls.getState().flags.action_rules, false);
  state.flags = {};
  state.clock += 31 * DAY;
  controls.addActionRule({ action: 'setting', target: { kind: 'any' }, effect: 'deny' });
  assert.deepEqual(config.block.actionRules.map((entry) => entry.rule_id), [RID(2)], 'the refused add minted no id; the revoked rule is gone');
});

test('controls: rule_denied is coalesced to one entry per rule per hour', () => {
  const { controls, state, config } = harness();
  controls.addActionRule({ action: 'stop', target: { kind: 'any' }, effect: 'deny' });
  assert.equal(controls.recordRuleDenied(RID(1)), true);
  controls.recordRuleDenied(RID(1));
  state.clock += 30 * 60 * 1000;
  controls.recordRuleDenied(RID(1));
  assert.equal(config.block.history.filter((row) => row.kind === 'rule_denied').length, 1);
  state.clock += HOUR;
  controls.recordRuleDenied(RID(1));
  assert.equal(config.block.history.filter((row) => row.kind === 'rule_denied').length, 2);
  assert.equal(controls.recordRuleDenied('bad'), false);
});

test('matcher: deny beats ask beats allow; then the most specific target; then the newest', () => {
  const { controls, rules, state } = harness();
  const add = (action, target, effect, extra = {}) => controls.addActionRule({ action, target, effect, ...extra }).rule.rule_id;
  const msg = (target, extra = {}) => rules.match({ action: 'message', sessionId: PRIMARY, turnId: 't1', target, runMode: 'ask', ...extra });
  assert.equal(msg({ session_id: CHILD }), null);
  const anyAllow = add('message', { kind: 'any' }, 'allow');
  assert.deepEqual(msg({ session_id: OTHER }), { effect: 'allow', rule_id: anyAllow });
  const linkedAllow = add('message', { kind: 'linked_children' }, 'allow');
  assert.deepEqual(msg({ session_id: CHILD }), { effect: 'allow', rule_id: linkedAllow }, 'linked_children is more specific than any');
  assert.deepEqual(msg({ session_id: OTHER }), { effect: 'allow', rule_id: anyAllow }, 'a chat the primary did not start is no linked child');
  state.clock += 1000;
  const chatAllow = add('message', { kind: 'chat', id: CHILD }, 'allow');
  assert.equal(msg({ session_id: CHILD }).rule_id, chatAllow);
  const projectAsk = add('message', { kind: 'project', id: 'project_a' }, 'ask');
  assert.deepEqual(msg({ session_id: CHILD }), { effect: 'ask', rule_id: projectAsk }, 'ask beats any allow, however specific');
  const anyDeny = add('message', { kind: 'any' }, 'deny');
  assert.deepEqual(msg({ session_id: CHILD }), { effect: 'deny', rule_id: anyDeny }, 'deny beats everything');
  controls.revokeActionRule({ rule_id: anyDeny });
  assert.equal(msg({ session_id: CHILD }).rule_id, projectAsk, 'a revoked rule no longer matches');
  state.clock += 1000;
  const newerAsk = add('message', { kind: 'project', id: 'project_a' }, 'ask', { run_modes: ['ask'] });
  assert.equal(msg({ session_id: CHILD }).rule_id, newerAsk, 'same effect and target: the newest wins');
  assert.equal(msg({ session_id: CHILD }, { runMode: 'auto' }).rule_id, projectAsk, 'run modes scope a rule');
  assert.equal(rules.match({ action: 'stop', sessionId: PRIMARY, target: { session_id: CHILD } }), null, 'actions are independent');
});

test('matcher: launch targets the destination project; stop targets the chat', () => {
  const { controls, rules } = harness();
  const deny = controls.addActionRule({ action: 'launch', target: { kind: 'project', id: 'project_b' }, effect: 'deny' }).rule.rule_id;
  assert.equal(rules.match({ action: 'launch', sessionId: PRIMARY, target: { project_id: 'project_b' }, runMode: 'ask' }).rule_id, deny);
  assert.equal(rules.match({ action: 'launch', sessionId: PRIMARY, target: { project_id: 'project_a' }, runMode: 'ask' }), null);
  assert.equal(rules.match({ action: 'launch', sessionId: PRIMARY, target: { project_id: null }, runMode: 'ask' }), null);
  const stop = controls.addActionRule({ action: 'stop', target: { kind: 'linked_children' }, effect: 'deny' }).rule.rule_id;
  assert.equal(rules.match({ action: 'stop', sessionId: PRIMARY, target: { session_id: CHILD } }).rule_id, stop);
  assert.equal(rules.match({ action: 'stop', sessionId: PRIMARY, target: { session_id: OTHER } }), null);
});

test('matcher: a wake turn drops allow rules but keeps deny and ask; a wake port that fails counts as a wake', () => {
  const { controls, rules, state } = harness();
  const allow = controls.addActionRule({ action: 'message', target: { kind: 'linked_children' }, effect: 'allow' }).rule.rule_id;
  const args = { action: 'message', sessionId: PRIMARY, turnId: 't1', target: { session_id: CHILD }, runMode: 'auto' };
  assert.equal(rules.match(args).rule_id, allow);
  state.wake = true;
  assert.equal(rules.match(args), null);
  const ask = controls.addActionRule({ action: 'message', target: { kind: 'chat', id: CHILD }, effect: 'ask' }).rule.rule_id;
  assert.equal(rules.match(args).rule_id, ask);
  state.wake = false;
  const throwing = createPrimaryActionRules({
    controls: () => controls, getSessionSummary: () => ({ spawned_from: { parent_session_id: PRIMARY } }),
    isWakeTurn: () => { throw new Error('boom'); },
  });
  controls.revokeActionRule({ rule_id: ask });
  assert.equal(throwing.match(args), null, 'unknown wake state: no allow');
  const unknown = createPrimaryActionRules({ controls: () => controls, getSessionSummary: () => ({ spawned_from: { parent_session_id: PRIMARY } }), isWakeTurn: () => undefined });
  assert.equal(unknown.match(args), null);
  const defaults = createPrimaryActionRules({ controls: () => controls, getSessionSummary: () => ({ spawned_from: { parent_session_id: PRIMARY } }) });
  assert.equal(defaults.match(args), null, 'the default wake port fails closed');
});

test('matcher: only the primary chat, only with the flag on; missing or throwing ports yield null', () => {
  const { controls, rules, state } = harness();
  controls.addActionRule({ action: 'message', target: { kind: 'any' }, effect: 'deny' });
  const args = { action: 'message', sessionId: PRIMARY, target: { session_id: OTHER }, runMode: 'ask' };
  assert.equal(rules.match(args).effect, 'deny');
  assert.equal(rules.match({ ...args, sessionId: OTHER }), null, 'rules never apply to another chat');
  assert.equal(rules.match({ ...args, action: 'nope' }), null);
  state.flags = { primary_action_rules: false };
  assert.equal(rules.match(args), null, 'the kill switch leaves existing behavior untouched');
  state.flags = { primary_chat: false };
  assert.equal(rules.match(args), null);
  state.flags = {};
  assert.equal(createPrimaryActionRules({}).match(args), null);
  assert.equal(createPrimaryActionRules({ controls: () => { throw new Error('x'); } }).match(args), null);
  const logs = [];
  const broken = createPrimaryActionRules({
    controls: () => ({ actionRulesEnabled: () => true, isPrimary: (id) => id === PRIMARY, listActionRules: () => { throw new Error('x'); } }),
    log: (...entry) => logs.push(entry),
  });
  assert.equal(broken.match(args), null);
  assert.equal(logs[0][1], 'primary_action_rules.match_failed');
});

test('isLive(): a live rule with the flag on; revoked, unknown or flag off is not', () => {
  const { controls, rules, state } = harness();
  const id = controls.addActionRule({ action: 'message', target: { kind: 'linked_children' }, effect: 'allow' }).rule.rule_id;
  assert.equal(rules.isLive(id), true);
  assert.equal(rules.isLive(RID(99)), false);
  state.flags = { primary_action_rules: false };
  assert.equal(rules.isLive(id), false);
  state.flags = {};
  controls.revokeActionRule({ rule_id: id });
  assert.equal(rules.isLive(id), false);
  assert.equal(createPrimaryActionRules({ controls: () => { throw new Error('x'); } }).isLive(id), false);
});

test('denial(): only a deny match, recorded in history', () => {
  const { controls, rules, config } = harness();
  const id = controls.addActionRule({ action: 'setting', target: { kind: 'any' }, effect: 'deny' }).rule.rule_id;
  controls.addActionRule({ action: 'message', target: { kind: 'any' }, effect: 'allow' });
  assert.equal(rules.denial({ action: 'message', sessionId: PRIMARY, target: { session_id: OTHER }, runMode: 'ask' }), null);
  assert.equal(rules.denial({ action: 'setting', sessionId: PRIMARY, runMode: 'ask' }).rule_id, id);
  assert.equal(config.block.history.filter((row) => row.kind === 'rule_denied' && row.rule_id === id).length, 1);
  assert.match(RULE_DENIED_MESSAGE, /standing rule/);
});

test('matcher: an unreadable run mode still meets mode-scoped deny and ask rules, never a mode-scoped allow', () => {
  const { controls, rules } = harness();
  const allow = controls.addActionRule({ action: 'message', target: { kind: 'any' }, effect: 'allow', run_modes: ['auto'] }).rule.rule_id;
  const msg = (runMode) => rules.match({ action: 'message', sessionId: PRIMARY, turnId: 't1', target: { session_id: OTHER }, runMode });
  assert.equal(msg('auto').rule_id, allow);
  assert.equal(msg(null), null, 'an allow needs its mode');
  const deny = controls.addActionRule({ action: 'stop', target: { kind: 'any' }, effect: 'deny', run_modes: ['auto'] }).rule.rule_id;
  assert.equal(rules.match({ action: 'stop', sessionId: PRIMARY, target: { session_id: OTHER }, runMode: null }).rule_id, deny);
  assert.equal(rules.match({ action: 'stop', sessionId: PRIMARY, target: { session_id: OTHER }, runMode: 'ask' }), null);
});
