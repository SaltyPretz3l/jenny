'use strict';

/* Row 87 S4: the per-action rules wire schemas, the two primaryChat.* rule channels and the Activity
 * projections (rule authorization, rule history entries, `permissions().rules`). Services are faked. */

const test = require('node:test');
const assert = require('node:assert/strict');

const contract = require('../services/primary-chat-contract');
const { registerPrimaryChatIpc, METHODS } = require('../services/main/primary-chat-ipc-registration');
const { JENNY_SHELL_BRIDGE_DESCRIPTORS } = require('../services/ipc-contract');
const { PRIMARY_ERROR_CODES: CODES } = require('../services/backend/error-codes');
const { createPrimaryActivityLog } = require('../services/primary-activity-log');

const V1 = { schema_version: 1 };
const RULE_ID = `ar_${'a'.repeat(32)}`;
const RULE_ID_2 = `ar_${'b'.repeat(32)}`;
const PERMISSION_ID = `lp_${'c'.repeat(32)}`;
const add = (extra) => ({ ...V1, action: 'message', target: { kind: 'any' }, effect: 'ask', ...extra });

// ---------- validators ----------

test('validateAddRuleRequest accepts each offered action, effect and target shape', () => {
  const valid = [
    [add({}), { action: 'message', target: { kind: 'any' }, effect: 'ask', run_modes: null }],
    [add({ target: { kind: 'linked_children' }, effect: 'allow' }), { action: 'message', target: { kind: 'linked_children' }, effect: 'allow', run_modes: null }],
    [add({ target: { kind: 'project', id: 'proj_1' }, effect: 'deny', run_modes: ['auto', 'plan'] }),
      { action: 'message', target: { kind: 'project', id: 'proj_1' }, effect: 'deny', run_modes: ['auto', 'plan'] }],
    [add({ target: { kind: 'chat', id: 'x'.repeat(128) }, run_modes: null }),
      { action: 'message', target: { kind: 'chat', id: 'x'.repeat(128) }, effect: 'ask', run_modes: null }],
    [add({ action: 'launch', effect: 'deny', target: { kind: 'project', id: 'p' } }), { action: 'launch', target: { kind: 'project', id: 'p' }, effect: 'deny', run_modes: null }],
    [add({ action: 'stop', effect: 'deny', target: { kind: 'linked_children' } }), { action: 'stop', target: { kind: 'linked_children' }, effect: 'deny', run_modes: null }],
    [add({ action: 'schedule', effect: 'deny' }), { action: 'schedule', target: { kind: 'any' }, effect: 'deny', run_modes: null }],
    [add({ action: 'setting', effect: 'deny' }), { action: 'setting', target: { kind: 'any' }, effect: 'deny', run_modes: null }],
  ];
  for (const [raw, value] of valid) assert.deepEqual(contract.validateAddRuleRequest(raw), { ok: true, value }, JSON.stringify(raw));
});

test('validateAddRuleRequest fails closed on every invalid shape', () => {
  const longId = 'x'.repeat(129);
  const invalid = [
    undefined, null, [], 'rule', { action: 'message', target: { kind: 'any' }, effect: 'ask' },
    add({ schema_version: 2 }), add({ extra: 1 }),
    add({ action: undefined }), add({ target: undefined }), add({ effect: undefined }),
    add({ action: 'delete' }), add({ action: 'constructor' }), add({ action: 7 }),
    add({ effect: 'maybe' }), add({ effect: 'toString' }), add({ effect: ['ask'] }),
    // a launch allow is a row 76 permission, not a rule
    add({ action: 'launch', effect: 'allow', target: { kind: 'any' } }),
    add({ action: 'launch', effect: 'ask', target: { kind: 'any' } }),
    add({ action: 'launch', effect: 'deny', target: { kind: 'chat', id: 'c' } }),
    add({ action: 'launch', effect: 'deny', target: { kind: 'linked_children' } }),
    add({ action: 'stop', effect: 'allow' }), add({ action: 'schedule', effect: 'deny', target: { kind: 'project', id: 'p' } }),
    add({ action: 'setting', effect: 'ask' }),
    add({ target: 'any' }), add({ target: [] }), add({ target: {} }), add({ target: { kind: 'everything' } }),
    add({ target: { kind: 'any', id: 'p' } }), add({ target: { kind: 'linked_children', extra: 1 } }),
    add({ target: { kind: 'project' } }), add({ target: { kind: 'project', id: '' } }), add({ target: { kind: 'project', id: longId } }),
    add({ target: { kind: 'project', id: 'a\nb' } }), add({ target: { kind: 'project', id: 'a\u007fb' } }),
    add({ target: { kind: 'project', id: '*' } }), add({ target: { kind: 'chat', id: 5 } }),
    add({ target: { kind: 'chat', id: 'c', extra: true } }),
    add({ run_modes: [] }), add({ run_modes: ['yolo'] }), add({ run_modes: ['ask', 'ask'] }), add({ run_modes: 'ask' }),
  ];
  for (const raw of invalid) assert.deepEqual(contract.validateAddRuleRequest(raw), { ok: false, reason: 'invalid_request' }, JSON.stringify(raw));
});

test('validateRevokeRuleRequest takes exactly a rule id', () => {
  assert.deepEqual(contract.validateRevokeRuleRequest({ ...V1, rule_id: RULE_ID }), { ok: true, value: { rule_id: RULE_ID } });
  const invalid = [
    undefined, V1, { ...V1, rule_id: 'ar_x' }, { ...V1, rule_id: `ar_${'A'.repeat(32)}` }, { ...V1, rule_id: `ar_${'a'.repeat(33)}` },
    { ...V1, rule_id: PERMISSION_ID }, { ...V1, rule_id: 5 }, { ...V1, rule_id: RULE_ID, extra: 1 }, { schema_version: 2, rule_id: RULE_ID },
  ];
  for (const raw of invalid) assert.deepEqual(contract.validateRevokeRuleRequest(raw), { ok: false, reason: 'invalid_request' }, JSON.stringify(raw));
});

// ---------- IPC ----------

const CHANNELS = { addRule: 'primary-chat:add-rule', revokeRule: 'primary-chat:revoke-rule' };
const RULE = {
  rule_id: RULE_ID, action: 'message', target: { kind: 'any' }, effect: 'ask', run_modes: null,
  created_at: '2026-11-02T10:00:00.000Z', revoked_at: null,
};

function register({ allow = true, controls } = {}) {
  const handlers = new Map();
  registerPrimaryChatIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    backendService: controls === undefined ? {} : { primaryChatControls: controls },
    authorization: { authorize: () => allow },
  });
  return { handlers, invoke: (channel, payload) => handlers.get(channel)({ sender: {} }, payload) };
}

test('the rule channels are declared, registered and desktop descriptors', () => {
  const { handlers } = register();
  for (const [method, channel] of Object.entries(CHANNELS)) {
    assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS[`primaryChat.${method}`], { kind: 'invoke', channel }, method);
    assert.equal(typeof handlers.get(channel), 'function', channel);
  }
  assert.equal(METHODS['primaryChat.addRule'], 'addActionRule');
  assert.equal(METHODS['primaryChat.revokeRule'], 'revokeActionRule');
});

test('addRule validates before the controls, forwards the validated rule and wraps the answer', async () => {
  const calls = [];
  const { invoke } = register({ controls: { addActionRule: async (input) => { calls.push(input); return { ok: true, rule: RULE, created: true }; } } });
  for (const bad of [V1, add({ extra: 1 }), add({ action: 'launch', effect: 'allow' }), add({ target: { kind: 'project', id: '*' } })]) {
    const result = await invoke(CHANNELS.addRule, bad);
    assert.deepEqual([result.ok, result.code, result.reason, result.retryable], [false, CODES.INVALID_REQUEST, 'invalid_request', false]);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await invoke(CHANNELS.addRule, add({ target: { kind: 'chat', id: 'sess_a' }, run_modes: ['ask'] })), {
    schema_version: 1, ok: true, rule: RULE, created: true,
  });
  assert.deepEqual(calls, [{ action: 'message', target: { kind: 'chat', id: 'sess_a' }, effect: 'ask', run_modes: ['ask'] }]);
});

test('revokeRule validates the id, forwards it and wraps the answer', async () => {
  const calls = [];
  const { invoke } = register({ controls: { revokeActionRule: async (input) => { calls.push(input); return { ok: true, rule: { ...RULE, revoked_at: '2026-11-02T11:00:00.000Z' } }; } } });
  assert.equal((await invoke(CHANNELS.revokeRule, { ...V1, rule_id: 'nope' })).code, CODES.INVALID_REQUEST);
  assert.equal(calls.length, 0);
  const result = await invoke(CHANNELS.revokeRule, { ...V1, rule_id: RULE_ID });
  assert.equal(result.ok, true);
  assert.equal(result.rule.revoked_at, '2026-11-02T11:00:00.000Z');
  assert.deepEqual(calls, [{ rule_id: RULE_ID }]);
});

test('control refusals map through the stable reason classes; a missing or throwing service is unavailable', async () => {
  const refuse = (reason) => async () => ({ ok: false, reason });
  const cases = [
    ['disabled', CODES.DISABLED, false], ['invalid_request', CODES.INVALID_REQUEST, false], ['unknown_project', CODES.UNKNOWN_PROJECT, false],
    ['not_found', CODES.NOT_FOUND, false], ['capacity', CODES.CAPACITY, false], ['unavailable', CODES.UNAVAILABLE, true],
  ];
  for (const [reason, code, retryable] of cases) {
    const { invoke } = register({ controls: { addActionRule: refuse(reason), revokeActionRule: refuse(reason) } });
    const expected = { schema_version: 1, ok: false, code, reason, retryable };
    assert.deepEqual(await invoke(CHANNELS.addRule, add({})), expected, reason);
    assert.deepEqual(await invoke(CHANNELS.revokeRule, { ...V1, rule_id: RULE_ID }), expected, reason);
  }
  const unavailable = { schema_version: 1, ok: false, code: CODES.UNAVAILABLE, reason: 'unavailable', retryable: true };
  const missing = register();
  const boom = async () => { throw new Error('secret path C:\\Users\\x'); };
  const throwing = register({ controls: { listActionRules: boom, addActionRule: boom, revokeActionRule: boom } });
  for (const { invoke } of [missing, throwing]) {
    for (const [channel, payload] of [[CHANNELS.addRule, add({})], [CHANNELS.revokeRule, { ...V1, rule_id: RULE_ID }]]) {
      const result = await invoke(channel, payload);
      assert.deepEqual(result, unavailable, channel);
      assert.doesNotMatch(JSON.stringify(result), /secret|Users/u);
    }
  }
});

test('an untrusted sender is refused on the rule channels', async () => {
  const calls = [];
  const { invoke } = register({ allow: false, controls: { addActionRule: async () => { calls.push('y'); }, revokeActionRule: async () => { calls.push('z'); } } });
  for (const [channel, payload] of [[CHANNELS.addRule, add({})], [CHANNELS.revokeRule, { ...V1, rule_id: RULE_ID }]]) {
    let outcome;
    try { outcome = await invoke(channel, payload); } catch (error) { outcome = { threw: true }; }
    assert.notEqual(outcome && outcome.ok, true, channel);
  }
  assert.equal(calls.length, 0);
});

// ---------- Activity ----------

const PRIMARY = 'sess_primary';
const NOW = new Date('2026-11-02T12:00:00.000Z');
const at = (minutes) => new Date(NOW.getTime() - minutes * 60000).toISOString();

function build({ mail, controls }) {
  return createPrimaryActivityLog({
    primarySessionId: () => PRIMARY,
    readMail: () => mail ?? { outbox: [], inbox: [], discarded: [], authorizations: [] },
    readProposals: () => ({ records: [], launch_grants: [] }),
    controls: () => controls ?? null,
    getSessionSummary: (id) => ({ id, title: `Chat ${id}`, project_id: null }),
    getProject: () => null,
    now: () => NOW,
  });
}

function outboxRecord(id, authorizationId) {
  return {
    envelope: {
      message_id: id, source_session_id: PRIMARY, destination_session_id: 'sess_a', source_turn_id: 't1', kind: 'agent_message',
      created_at: at(10), body: 'hi', report: null,
    },
    operation_id: `op_${id}`, gesture_id: null, tool_call_id: 'call_1', authorization_id: authorizationId, state: 'delivered',
    prepared_at: at(10), send_requested_at: at(9), delivered_at: at(8), last_error: null,
  };
}

test('an agent_once authorization minted by a rule reads as authorization "rule" with its rule id', () => {
  const authorization = (id, consent) => ({
    authorization_id: id, kind: 'agent_once', consent_event_id: consent, destination_session_id: 'sess_a', purpose: null,
    created_at: at(10), expires_at: at(-5), remaining_sends: 1, revoked_at: null,
  });
  const mail = {
    outbox: [outboxRecord('m1', 'a1'), outboxRecord('m2', 'a2'), outboxRecord('m3', 'a3'), outboxRecord('m4', 'a4')],
    inbox: [], discarded: [],
    authorizations: [
      authorization('a1', `rule:${RULE_ID}`), authorization('a2', 'approval:evt_1'), authorization('a3', 'rule:not-a-rule-id'),
      { ...authorization('a4', null), kind: 'agent_directional' },
    ],
  };
  const result = build({ mail }).list();
  const byId = (id) => result.entries.find((item) => item.id === id);
  assert.equal(byId('out:m1').authorization, 'rule');
  assert.equal(byId('out:m1').rule_id, RULE_ID);
  assert.equal(byId('out:m2').authorization, 'approval');
  assert.equal(Object.hasOwn(byId('out:m2'), 'rule_id'), false);
  assert.equal(byId('out:m3').authorization, 'rule');
  assert.equal(byId('out:m3').rule_id, null);
  assert.equal(byId('out:m4').authorization, 'grant');
});

test('rule history kinds become entries carrying the matching rule record', () => {
  const revoked = { ...RULE, rule_id: RULE_ID_2, effect: 'deny', revoked_at: at(1) };
  const controls = {
    getState: () => ({
      permissions: [],
      rules: [RULE, revoked],
      history: [
        { kind: 'rule_added', at: at(30), rule_id: RULE_ID },
        { kind: 'rule_denied', at: at(20), rule_id: RULE_ID_2 },
        { kind: 'rule_revoked', at: at(1), rule_id: RULE_ID_2 },
        { kind: 'rule_added', at: at(40), rule_id: `ar_${'e'.repeat(32)}` }, // pruned rule: rule is null
        { kind: 'rule_added', at: at(50), rule_id: 'ar_bad' }, // malformed: dropped
      ],
    }),
  };
  const result = build({ controls }).list();
  assert.deepEqual(result.entries.map((item) => item.id), [
    `rule:${RULE_ID_2}:rule_revoked:${at(1)}`,
    `rule:${RULE_ID_2}:rule_denied:${at(20)}`,
    `rule:${RULE_ID}:rule_added:${at(30)}`,
    `rule:ar_${'e'.repeat(32)}:rule_added:${at(40)}`,
  ]);
  const [revokedEntry, deniedEntry, addedEntry, prunedEntry] = result.entries;
  assert.equal(revokedEntry.kind, 'rule_revoked');
  assert.equal(revokedEntry.at, at(1));
  assert.equal(revokedEntry.rule_id, RULE_ID_2);
  assert.deepEqual(revokedEntry.rule, revoked);
  assert.deepEqual([deniedEntry.kind, deniedEntry.rule_id, deniedEntry.rule], ['rule_denied', RULE_ID_2, revoked]);
  assert.deepEqual([addedEntry.kind, addedEntry.rule], ['rule_added', RULE]);
  assert.equal(prunedEntry.rule, null);
});

test('permissions() carries every stored rule newest first, and an empty list when there are none', () => {
  const newer = { ...RULE, rule_id: RULE_ID_2, created_at: at(5), revoked_at: at(1) };
  const older = { ...RULE, created_at: at(500) };
  const result = build({ controls: { getState: () => ({ permissions: [], rules: [older, newer], history: [] }) } }).permissions();
  assert.equal(result.ok, true);
  assert.deepEqual(result.rules.map((rule) => rule.rule_id), [RULE_ID_2, RULE_ID]);
  assert.deepEqual(build({ controls: { getState: () => ({ permissions: [], history: [] }) } }).permissions().rules, []);
  assert.deepEqual(build({}).permissions().rules, []);
});
