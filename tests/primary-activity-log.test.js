'use strict';

/* Row 76 S5: the primary chat activity log projector over in-memory fakes. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPrimaryActivityLog } = require('../services/primary-activity-log');

const PRIMARY = 'sess_primary';
const NOW = new Date('2026-10-25T12:00:00.000Z');
const TITLES = { sess_a: 'Alpha chat', sess_b: 'Beta chat', sess_child: 'Child chat' };
const PROJECTS = { proj_x: { id: 'proj_x', name: 'Project X' } };

const at = (minutes) => new Date(NOW.getTime() - minutes * 60000).toISOString();

function envelope(id, kind, extra = {}) {
  return {
    message_id: id, source_session_id: PRIMARY, destination_session_id: 'sess_a', source_turn_id: 'turn_1',
    kind, created_at: at(10), body: 'hello there', report: null, ...extra,
  };
}

function outbox(id, kind, state, extra = {}) {
  return {
    envelope: envelope(id, kind, extra.envelope), operation_id: `op_${id}`, gesture_id: null, tool_call_id: 'call_1',
    authorization_id: null, state, prepared_at: at(10), send_requested_at: at(9), delivered_at: null,
    last_error: null, ...extra.record,
  };
}

function inbox(id, kind, state, extra = {}) {
  return {
    envelope: envelope(id, kind, { source_session_id: 'sess_b', destination_session_id: PRIMARY, ...extra }),
    receipt_id: `rc_${id}`, receive_sequence: 1, delivered_at: at(5), read_at: null, context: { state },
  };
}

function build(over = {}) {
  const logs = [];
  const mail = over.mail === undefined ? { outbox: [], inbox: [], discarded: [], authorizations: [] } : over.mail;
  const service = createPrimaryActivityLog({
    primarySessionId: () => PRIMARY,
    readMail: () => mail,
    readProposals: () => over.proposals ?? { records: [], launch_grants: [] },
    runtimeStore: () => over.runtime ?? null,
    peekMessages: () => over.rows ?? [],
    controls: () => over.controls ?? null,
    getSessionSummary: (id) => (TITLES[id] ? { id, title: TITLES[id], project_id: null } : null),
    getProject: (id) => PROJECTS[id] || null,
    featureFlags: () => over.flags ?? {},
    now: () => NOW,
    log: (level, event, fields) => logs.push({ level, event, fields }),
    ...over.deps,
  });
  return { service, logs };
}

const byId = (result, id) => result.entries.find((item) => item.id === id);

test('mail kinds carry the documented id, at, status, title, detail and authorization', () => {
  const mail = {
    outbox: [
      outbox('m1', 'agent_message', 'delivered', {
        record: { authorization_id: 'auth_dir', delivered_at: at(8) }, envelope: { body: 'line one\nline two\u0007' },
      }),
      outbox('m2', 'agent_message', 'pending', { record: { authorization_id: 'auth_once' } }),
      outbox('m3', 'user_message', 'delivered', { record: { authorization_id: 'auth_user' } }),
      outbox('m4', 'terminal_report', 'delivered', { envelope: { report: { outcome: 'success', clipped: false, error_code: null } } }),
      outbox('m5', 'agent_message', 'cancelled', { record: { send_requested_at: null } }),
    ],
    inbox: [
      inbox('i1', 'agent_message', 'queued'),
      inbox('i2', 'terminal_report', 'included'),
      inbox('i3', 'agent_message', 'excluded_by_user'),
      inbox('i4', 'agent_message', 'reserved'),
    ],
    discarded: [{ message_id: 'd1', receipt_id: 'rc_d1', receive_sequence: 9, discarded_at: at(2) }],
    authorizations: [
      { authorization_id: 'auth_dir', kind: 'agent_directional', destination_session_id: 'sess_a', purpose: 'Coordinate docs',
        created_at: at(20), expires_at: at(-9999), remaining_sends: 3, revoked_at: at(15) },
      { authorization_id: 'auth_once', kind: 'agent_once', destination_session_id: 'sess_a', purpose: null, created_at: at(10),
        expires_at: at(-5), remaining_sends: 1, revoked_at: null },
      { authorization_id: 'auth_user', kind: 'user_send', destination_session_id: 'sess_a', purpose: null, created_at: at(10),
        expires_at: null, remaining_sends: 1, revoked_at: null },
    ],
  };
  const result = build({ mail }).service.list();
  assert.equal(result.ok, true);
  assert.equal(result.schema_version, 1);
  assert.equal(result.session_id, PRIMARY);
  assert.deepEqual(byId(result, 'out:m1'), {
    id: 'out:m1', kind: 'message_sent', at: at(10), status: 'delivered', title: 'Alpha chat', detail: 'line one line two',
    session_id: 'sess_a', project: null, authorization: 'grant', permission_id: null,
  });
  assert.equal(byId(result, 'out:m2').authorization, 'approval');
  assert.equal(byId(result, 'out:m2').status, 'pending');
  assert.equal(byId(result, 'out:m3').authorization, 'user');
  assert.equal(byId(result, 'out:m3').kind, 'message_sent');
  assert.equal(byId(result, 'out:m4').kind, 'report_sent');
  assert.equal(byId(result, 'out:m4').detail, 'success');
  assert.equal(byId(result, 'out:m5').status, 'denied');
  assert.equal(byId(result, 'out:m5').authorization, null);

  assert.deepEqual(byId(result, 'in:i1'), {
    id: 'in:i1', kind: 'message_received', at: at(5), status: 'queued', title: 'Beta chat', detail: 'hello there',
    session_id: 'sess_b', project: null, authorization: null, permission_id: null,
  });
  assert.equal(byId(result, 'in:i2').kind, 'report_received');
  assert.equal(byId(result, 'in:i2').status, 'included');
  assert.equal(byId(result, 'in:i3').status, 'excluded');
  assert.equal(byId(result, 'in:i4').status, 'reserved');
  const discarded = byId(result, 'in:d1');
  assert.equal(discarded.status, 'discarded');
  assert.equal(discarded.at, at(2));
  assert.equal(discarded.detail, null);
  assert.equal(discarded.title, 'another chat');

  const created = byId(result, 'grant:auth_dir:created');
  assert.deepEqual([created.kind, created.at, created.title, created.detail, created.session_id],
    ['grant_created', at(20), 'Alpha chat', 'Coordinate docs', 'sess_a']);
  const revoked = byId(result, 'grant:auth_dir:revoked');
  assert.deepEqual([revoked.kind, revoked.at], ['grant_revoked', at(15)]);
  assert.equal(byId(result, 'grant:auth_once:created'), undefined, 'only directional grants are logged');
});

test('a standing-minted proposal reads permission, a linked grant reads linked, no grant reads offer', () => {
  const proposal = (id, ref, minutes, extra = {}) => ({
    proposal_id: id, kind: 'session', created_at: at(minutes), expires_at: at(-60),
    normalized_input: { initiation: ref ? 'user_asked' : 'offer', title: `Title ${id}`, description: 'd' },
    binding: { session: { effective_initiation: ref ? 'user_asked' : 'offer', authorization_required: !ref, launch_grant_ref: ref } },
    options: { destination_project_id: 'proj_x' }, decision_state: 'accepted', action_state: 'child_created',
    decision: { choice: 'new_session', accepted_at: at(minutes) }, child_session_id: 'sess_child', ...extra,
  });
  const proposals = {
    records: [
      proposal('p1', 'g_standing', 30),
      proposal('p2', 'g_linked', 29),
      proposal('p3', null, 28, { decision_state: 'pending', action_state: 'none', decision: null, child_session_id: null }),
      { ...proposal('p4', null, 27), kind: 'git' },
    ],
    launch_grants: [
      { authorization_ref: 'g_standing', source_user_message_id: 'standing.lp_abc123', source_turn_id: 't', destination_project_ids: ['proj_x'],
        created_at: at(30), expires_at: at(-30), remaining: 0, revoked_at: null },
      { authorization_ref: 'g_linked', source_user_message_id: 'msg_9', source_turn_id: 't', destination_project_ids: ['proj_x'],
        created_at: at(40), expires_at: at(-20), remaining: 1, revoked_at: null },
      { authorization_ref: 'g_old', source_user_message_id: 'msg_1', source_turn_id: 't', destination_project_ids: ['proj_x', 'proj_y'],
        created_at: at(500), expires_at: at(440), remaining: 1, revoked_at: null },
      { authorization_ref: 'g_rev', source_user_message_id: 'msg_2', source_turn_id: 't', destination_project_ids: ['proj_x'],
        created_at: at(60), expires_at: at(-60), remaining: 1, revoked_at: at(50) },
    ],
  };
  const result = build({ proposals }).service.list();
  assert.deepEqual(byId(result, 'prop:p1'), {
    id: 'prop:p1', kind: 'proposal', at: at(30), status: 'accepted/child_created', title: 'Title p1', detail: 'new_session',
    session_id: 'sess_child', project: { id: 'proj_x', name: 'Project X' }, authorization: 'permission', permission_id: 'lp_abc123',
  });
  assert.equal(byId(result, 'prop:p2').authorization, 'linked');
  assert.equal(byId(result, 'prop:p2').permission_id, null);
  const offer = byId(result, 'prop:p3');
  assert.deepEqual([offer.authorization, offer.status, offer.detail, offer.session_id], ['offer', 'pending/none', null, null]);
  assert.equal(byId(result, 'prop:p4'), undefined, 'only session proposals are logged');
  assert.equal(byId(result, 'lgrant:g_standing'), undefined, 'a standing-minted grant is not a /linked grant');
  assert.equal(byId(result, 'lgrant:g_linked').status, 'live');
  assert.equal(byId(result, 'lgrant:g_linked').kind, 'launch_grant');
  assert.equal(byId(result, 'lgrant:g_old').status, 'expired');
  assert.equal(byId(result, 'lgrant:g_rev').status, 'revoked');
});

test('a spent /linked grant reads spent', () => {
  const proposals = { records: [], launch_grants: [
    { authorization_ref: 'g1', source_user_message_id: 'm', source_turn_id: 't', destination_project_ids: ['proj_x'],
      created_at: at(5), expires_at: at(-55), remaining: 0, revoked_at: null },
  ] };
  assert.equal(byId(build({ proposals }).service.list(), 'lgrant:g1').status, 'spent');
});

test('woken comes from the wake_ key and the stored visible prompt, not from transcript text', () => {
  const rows = [
    { work_id: 'work_1', session_id: PRIMARY, turn_id: 't1', status: 'completed', created_at: at(12), updated_at: at(11), idempotency_key: 'wake_abc' },
    { work_id: 'work_2', session_id: PRIMARY, turn_id: 't2', status: 'completed', created_at: at(8), updated_at: at(7), idempotency_key: 'user_turn_1' },
    { work_id: 'work_3', session_id: PRIMARY, turn_id: 't3', status: 'failed', created_at: at(6), updated_at: at(6), idempotency_key: 'wake_def' },
  ];
  const gets = [];
  const runtime = {
    listSummaries: () => ({ items: rows, next_cursor: null }),
    get: (id) => {
      gets.push(id);
      return id === 'work_1' ? { input: { request: { visiblePrompt: 'Woken by a message from Beta chat' } } } : { input: { compacted: true } };
    },
  };
  const typed = [{ kind: 'user', role: 'user', content: 'Woken by a message from Beta chat', timestamp: at(3) }];
  const result = build({ runtime, rows: typed }).service.list();
  assert.deepEqual(result.entries.filter((item) => item.kind === 'woken').map((item) => item.id), ['wake:work_3', 'wake:work_1']);
  assert.deepEqual(byId(result, 'wake:work_1'), {
    id: 'wake:work_1', kind: 'woken', at: at(12), status: 'completed', title: 'Woken by a message from Beta chat', detail: null,
    session_id: null, project: null, authorization: null, permission_id: null,
  });
  assert.equal(byId(result, 'wake:work_3').title, null, 'a compacted record has no title');
  assert.equal(byId(result, 'wake:work_3').status, 'failed');
  assert.equal(result.entries.length, 2, 'a typed line and a non-wake row produce nothing');
  assert.equal(gets.includes('work_2'), false);

  const limited = build({ runtime }).service.list({ limit: 1 });
  assert.deepEqual(limited.entries.map((item) => item.id), ['wake:work_3']);
  assert.deepEqual(gets.slice(2), ['work_3'], 'only entries inside the window read their stored record');
});

test('runtime scan pages at most three times', () => {
  let pages = 0;
  const runtime = {
    listSummaries: () => { pages += 1; return { items: [], next_cursor: `c${pages}` }; },
    get: () => null,
  };
  build({ runtime }).service.list();
  assert.equal(pages, 3);
});

test('stop pairs the call with its result and reads approval_state', () => {
  const rows = [
    { kind: 'tool_use', role: 'assistant', timestamp: at(4),
      tool_call: { call_id: 'call_s1', tool_name: 'session_stop', input: { session_id: 'sess_a', purpose: 'runaway' }, approval_state: 'approved', status: 'completed' } },
    { kind: 'tool_result', role: 'tool', timestamp: at(3),
      tool_result: { call_id: 'call_s1', tool_name: 'session_stop', output_text: 'Stopped sess_a for you.', is_error: false } },
    { kind: 'tool_use', role: 'assistant', timestamp: at(2),
      tool_call: { call_id: 'call_s2', tool_name: 'session_stop', input: { session_id: 'sess_unknown' }, approval_state: 'denied', status: 'failed' } },
    { kind: 'tool_use', role: 'assistant', timestamp: at(1),
      tool_call: { call_id: 'call_o', tool_name: 'read_file', input: {}, approval_state: 'auto', status: 'completed' } },
  ];
  const result = build({ rows }).service.list();
  assert.deepEqual(byId(result, 'stop:call_s1'), {
    id: 'stop:call_s1', kind: 'stop', at: at(4), status: 'approved', title: 'Alpha chat', detail: 'Stopped that chat for you.',
    session_id: 'sess_a', project: null, authorization: null, permission_id: null,
  });
  const denied = byId(result, 'stop:call_s2');
  assert.deepEqual([denied.status, denied.title, denied.detail], ['denied', 'another chat', null]);
  assert.equal(result.entries.length, 2);
});

test('controls yield permission and history entries', () => {
  const controls = {
    getState: () => ({
      session_id: PRIMARY, paused: false, paused_at: null,
      permissions: [
        { permission_id: 'lp_1', project_id: 'proj_x', run_modes: ['auto', 'ask'], max_children_per_turn: 1, created_at: at(50), revoked_at: at(40),
          project: { id: 'proj_x', name: 'Project X' } },
        { permission_id: 'lp_2', project_id: '*', run_modes: null, max_children_per_turn: 2, created_at: at(45), revoked_at: null, project: null },
      ],
      history: [
        { kind: 'paused', at: at(30) }, { kind: 'resumed', at: at(29) }, { kind: 'reset', at: at(28) }, { kind: 'forgot', at: at(27) },
        { kind: 'permission_granted', at: at(50), permission_id: 'lp_1' },
      ],
    }),
    primarySessionId: () => PRIMARY,
  };
  const result = build({ controls }).service.list();
  assert.deepEqual(byId(result, 'perm:lp_1:granted'), {
    id: 'perm:lp_1:granted', kind: 'permission_granted', at: at(50), status: null, title: 'Project X', detail: 'auto, ask',
    session_id: null, project: { id: 'proj_x', name: 'Project X' }, authorization: null, permission_id: 'lp_1',
  });
  assert.equal(byId(result, 'perm:lp_1:revoked').at, at(40));
  const every = byId(result, 'perm:lp_2:granted');
  assert.deepEqual([every.title, every.detail, every.project], ['Every project', null, null]);
  assert.equal(byId(result, 'perm:lp_2:revoked'), undefined);
  for (const kind of ['paused', 'resumed', 'reset', 'forgot']) {
    const item = result.entries.find((candidate) => candidate.kind === kind);
    assert.ok(item, kind);
    assert.equal(item.id, `hist:${kind}:${item.at}`);
  }
  assert.equal(result.entries.length, 3 + 4, 'history permission rows are not duplicated');
});

test('a Jenny-made settings batch is one entry with its changes and its undo time (row 88)', () => {
  const CID = (n) => `sc_${String(n).padStart(32, '0')}`;
  const changes = [{ key: 'time_format_24h', before: false, after: true }, { key: 'palette', before: 'slate', after: 'paper', before_label: 'Slate', after_label: 'Paper' }];
  const controls = {
    getState: () => ({
      permissions: [],
      history: [
        { kind: 'setting_changed', at: at(20), change_id: CID(1), changes },
        { kind: 'setting_changed', at: at(10), change_id: CID(2), changes },
        { kind: 'setting_undone', at: at(5), change_id: CID(1) },
      ],
    }),
  };
  const result = build({ controls }).service.list();
  assert.deepEqual(result.entries.map((item) => [item.id, item.kind, item.undone_at]), [
    [`set:${CID(2)}`, 'setting_changed', null],
    [`set:${CID(1)}`, 'setting_changed', at(5)],
  ], 'the undo is a state of its batch, not an entry of its own');
  assert.deepEqual(byId(result, `set:${CID(1)}`).changes, changes);
  assert.equal(byId(result, `set:${CID(1)}`).change_id, CID(1));
});

test('a Jenny-made chat change is one entry with its target, values and undo time (row 94)', () => {
  const CID = (n) => `sc_${String(n).padStart(32, '0')}`;
  const row = (n, extra) => ({
    kind: 'chat_changed', at: at(n), change_id: CID(n), session_id: 'sess_t', action: 'rename', field: 'title', before: 'A', after: 'B', ...extra,
  });
  const controls = {
    getState: () => ({
      permissions: [],
      history: [
        row(20), row(10, { action: 'move_to_project', field: 'project_id', before: null, after: 'proj_x' }),
        { kind: 'chat_change_undone', at: at(5), change_id: CID(20) },
        { kind: 'chat_changed', at: at(30), change_id: 7 },
      ],
    }),
  };
  const result = build({ controls, deps: { getSessionSummary: (id) => (id === 'sess_t' ? { title: 'Target chat' } : null), getProject: (id) => ({ id, name: 'Project X' }) } }).service.list();
  assert.deepEqual(result.entries.map((item) => [item.id, item.kind, item.undone_at]), [
    [`chat:${CID(10)}`, 'chat_changed', null],
    [`chat:${CID(20)}`, 'chat_changed', at(5)],
  ], 'the undo is a state of its change, not an entry of its own');
  assert.deepEqual(byId(result, `chat:${CID(20)}`), {
    id: `chat:${CID(20)}`, kind: 'chat_changed', at: at(20), status: null, title: 'Target chat', detail: null, session_id: 'sess_t',
    project: null, authorization: null, permission_id: null, change_id: CID(20), action: 'rename', field: 'title',
    before: 'A', after: 'B', undone_at: at(5),
  });
  assert.deepEqual(byId(result, `chat:${CID(10)}`).project, { id: 'proj_x', name: 'Project X' }, 'a move names its destination project');
});

test('entries are newest first, limit and truncated apply, before pages', () => {
  const mail = { outbox: [], discarded: [], authorizations: [], inbox: [] };
  for (let index = 1; index <= 7; index += 1) {
    const record = inbox(`n${index}`, 'agent_message', 'queued');
    record.delivered_at = at(index * 10);
    mail.inbox.push(record);
  }
  const { service } = build({ mail });
  const first = service.list({ limit: 3 });
  assert.deepEqual(first.entries.map((item) => item.id), ['in:n1', 'in:n2', 'in:n3']);
  assert.equal(first.truncated, true);
  const second = service.list({ limit: 3, before: first.entries[2].at });
  assert.deepEqual(second.entries.map((item) => item.id), ['in:n4', 'in:n5', 'in:n6']);
  assert.equal(second.truncated, true);
  const third = service.list({ limit: 3, before: second.entries[2].at });
  assert.deepEqual(third.entries.map((item) => item.id), ['in:n7']);
  assert.equal(third.truncated, false);
  assert.equal(service.list().entries.length, 7);
  assert.equal(service.list({ limit: 0 }).entries.length, 7, 'an invalid limit falls back to the default');
  assert.equal(service.list({ limit: 500 }).entries.length, 7);
  assert.equal(service.list({ limit: 200 }).truncated, false);
});

test('previews clip at 160 code points, strip control characters and keep surrogate pairs whole', () => {
  const body = `\u0000‮${'\u{1F600}'.repeat(200)}`;
  const mail = { outbox: [], discarded: [], authorizations: [], inbox: [inbox('big', 'agent_message', 'queued', { body })] };
  const detail = byId(build({ mail }).service.list(), 'in:big').detail;
  assert.equal(Array.from(detail).length, 160);
  assert.equal(detail.endsWith('…'), true);
  assert.equal(detail.includes('\u0000'), false);
  assert.equal(detail.includes('‮'), false);
  const blank = { outbox: [], discarded: [], authorizations: [], inbox: [inbox('blank', 'agent_message', 'queued', { body: ' \n\t ' })] };
  assert.equal(byId(build({ mail: blank }).service.list(), 'in:blank').detail, null);
});

test('unknown titles fall back and no raw ids reach title or detail', () => {
  const mail = { outbox: [outbox('x1', 'agent_message', 'failed', { envelope: { destination_session_id: 'sess_zzz' }, record: { last_error: { code: 'E', reason: 'r', retryable: false } } })],
    inbox: [], discarded: [], authorizations: [] };
  const item = byId(build({ mail }).service.list(), 'out:x1');
  assert.equal(item.title, 'another chat');
  assert.equal(item.session_id, 'sess_zzz');
  assert.equal(item.status, 'failed');
});

test('a throwing readMail keeps the other sources and logs one source_unavailable', () => {
  const controls = { getState: () => ({ permissions: [], history: [{ kind: 'paused', at: at(1) }] }) };
  const { service, logs } = build({ controls, deps: { readMail: () => { throw new Error('boom'); } } });
  const result = service.list();
  assert.equal(result.ok, true);
  assert.deepEqual(result.entries.map((item) => item.kind), ['paused']);
  const unavailable = logs.filter((line) => line.event === 'primary_activity_log.source_unavailable');
  assert.deepEqual(unavailable.map((line) => line.fields), [{ source: 'mail' }]);
  const again = service.list();
  assert.equal(logs.filter((line) => line.event === 'primary_activity_log.source_unavailable').length, 2, 'one log per call');
  assert.equal(again.ok, true);
});

test('every source that throws is one unavailable fact and never a throw', () => {
  const boom = () => { throw new Error('boom'); };
  const { service, logs } = build({ deps: {
    readProposals: boom, runtimeStore: boom, peekMessages: boom, controls: boom, getSessionSummary: boom,
  } });
  const result = service.list();
  assert.deepEqual(result, { ok: true, schema_version: 1, session_id: PRIMARY, entries: [], truncated: false });
  const sources = logs.map((line) => line.fields.source).sort();
  assert.deepEqual(sources, ['controls', 'proposals', 'runtime', 'transcript']);
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes('boom'), false);
});

test('the mail store read shape and failed reads are tolerated', () => {
  const inner = { outbox: [], inbox: [inbox('w1', 'agent_message', 'queued')], discarded: [], authorizations: [] };
  assert.equal(build({ mail: { ok: true, mail: inner } }).service.list().entries.length, 1);
  const { service, logs } = build({ mail: { ok: false, reason: 'not_found' } });
  assert.equal(service.list().entries.length, 0);
  assert.equal(logs.length, 1);
});

test('disabled and not_found reasons', () => {
  for (const flags of [{ primary_activity_log: false }, { primary_chat: false }]) {
    const { service } = build({ flags });
    assert.deepEqual(service.list(), { ok: false, reason: 'disabled' });
    assert.deepEqual(service.permissions(), { ok: false, reason: 'disabled' });
  }
  const enabled = build({ flags: { primary_launch_permission: false, primary_chat_controls: false } }).service;
  assert.equal(enabled.list().ok, true);
  const none = build({ deps: { primarySessionId: () => null } }).service;
  assert.deepEqual(none.list(), { ok: false, reason: 'not_found' });
  assert.deepEqual(none.permissions(), { ok: false, reason: 'not_found' });
  const broken = build({ deps: { primarySessionId: () => { throw new Error('x'); } } }).service;
  assert.deepEqual(broken.list(), { ok: false, reason: 'unavailable' });
});

test('permissions lists launch permissions, directional grants and non-standing launch grants with liveness', () => {
  const controls = { getState: () => ({
    permissions: [{ permission_id: 'lp_1', project_id: 'proj_x', run_modes: null, max_children_per_turn: 1, created_at: at(50), revoked_at: null, project: null }],
    history: [],
  }) };
  const mail = { outbox: [], inbox: [], discarded: [], authorizations: [
    { authorization_id: 'a_live', kind: 'agent_directional', destination_session_id: 'sess_a', purpose: 'Docs', created_at: at(30),
      expires_at: at(-600), remaining_sends: 4, revoked_at: null },
    { authorization_id: 'a_rev', kind: 'agent_directional', destination_session_id: 'sess_b', purpose: 'Other', created_at: at(20),
      expires_at: at(-600), remaining_sends: 4, revoked_at: at(10) },
    { authorization_id: 'a_spent', kind: 'agent_directional', destination_session_id: 'sess_a', purpose: 'Spent', created_at: at(40),
      expires_at: at(-600), remaining_sends: 0, revoked_at: null },
    { authorization_id: 'a_old', kind: 'agent_directional', destination_session_id: 'sess_a', purpose: 'Old', created_at: at(900),
      expires_at: at(10), remaining_sends: 2, revoked_at: null },
    { authorization_id: 'a_once', kind: 'agent_once', destination_session_id: 'sess_a', purpose: null, created_at: at(5),
      expires_at: at(-5), remaining_sends: 1, revoked_at: null },
  ] };
  const proposals = { records: [], launch_grants: [
    { authorization_ref: 'tg_live', source_user_message_id: 'm', source_turn_id: 't', destination_project_ids: ['proj_x'],
      created_at: at(5), expires_at: at(-55), remaining: 1, revoked_at: null },
    { authorization_ref: 'tg_stand', source_user_message_id: 'standing.lp_1', source_turn_id: 't', destination_project_ids: ['proj_x'],
      created_at: at(4), expires_at: at(-56), remaining: 0, revoked_at: null },
    { authorization_ref: 'tg_dead', source_user_message_id: 'm', source_turn_id: 't', destination_project_ids: ['proj_x'],
      created_at: at(100), expires_at: at(40), remaining: 1, revoked_at: null },
  ] };
  const result = build({ controls, mail, proposals }).service.permissions();
  assert.equal(result.ok, true);
  assert.equal(result.schema_version, 1);
  assert.equal(result.launch.length, 1);
  assert.deepEqual(result.launch[0].project, { id: 'proj_x', name: 'Project X' });
  assert.equal(result.launch[0].permission_id, 'lp_1');
  assert.deepEqual(result.message_grants.map((grant) => [grant.grant_id, grant.live]),
    [['a_rev', false], ['a_live', true], ['a_spent', false], ['a_old', false]]);
  assert.deepEqual(result.message_grants.find((grant) => grant.grant_id === 'a_live'), {
    grant_id: 'a_live', destination: { session_id: 'sess_a', title: 'Alpha chat' }, purpose: 'Docs', created_at: at(30),
    expires_at: at(-600), remaining_sends: 4, revoked_at: null, live: true,
  });
  assert.deepEqual(result.turn_grants.map((grant) => [grant.authorization_ref, grant.live]), [['tg_live', true], ['tg_dead', false]]);
  assert.deepEqual(Object.keys(result.turn_grants[0]).sort(),
    ['authorization_ref', 'created_at', 'destination_project_ids', 'expires_at', 'live', 'remaining', 'revoked_at']);
});

test('permissions degrades per source and logs the failed source once', () => {
  const { service, logs } = build({ deps: { readMail: () => { throw new Error('x'); }, readProposals: () => { throw new Error('y'); } } });
  assert.deepEqual(service.permissions(), { ok: true, schema_version: 1, launch: [], message_grants: [], turn_grants: [], rules: [] });
  assert.deepEqual(logs.map((line) => line.fields.source).sort(), ['mail', 'proposals']);
});

test('schedule history kinds project as entries with their label, reason and author (row 85)', () => {
  const history = [
    { kind: 'schedule_created', at: at(30), reminder_id: 'rem_1', label: 'Morning\nsummary', by: 'jenny' },
    { kind: 'schedule_updated', at: at(25), reminder_id: 'rem_1', label: 'Morning summary', by: 'user' },
    { kind: 'schedule_enabled', at: at(24), reminder_id: 'rem_1', label: 'Morning summary', by: 'jenny' },
    { kind: 'schedule_disabled', at: at(23), reminder_id: 'rem_1', label: 'Morning summary', by: 'jenny' },
    { kind: 'schedule_skipped', at: at(20), reminder_id: 'rem_1', label: 'Morning summary', reason: 'paused' },
    { kind: 'schedule_missed', at: at(20), reminder_id: 'rem_2', label: 'Release PR', reason: 'too_late' },
    { kind: 'schedule_cancelled', at: at(10), reminder_id: 'rem_2', label: 'Release PR', by: 'jenny' },
  ];
  const result = build({ controls: { getState: () => ({ permissions: [], history }) } }).service.list();
  assert.deepEqual(result.entries.map((item) => item.kind), [
    'schedule_cancelled', 'schedule_skipped', 'schedule_missed', 'schedule_disabled', 'schedule_enabled', 'schedule_updated', 'schedule_created',
  ]);
  assert.equal(result.entries.length, 7, 'two entries at the same instant stay distinct');
  assert.deepEqual(byId(result, `hist:schedule_created:${at(30)}:rem_1`), {
    id: `hist:schedule_created:${at(30)}:rem_1`, kind: 'schedule_created', at: at(30), status: null, title: 'Morning summary',
    detail: null, session_id: null, project: null, authorization: null, permission_id: null,
    reminder_id: 'rem_1', reason: null, by: 'jenny',
  });
  assert.equal(byId(result, `hist:schedule_missed:${at(20)}:rem_2`).reason, 'too_late');
  assert.equal(byId(result, `hist:schedule_skipped:${at(20)}:rem_1`).by, null);
});

test('schedule_fired comes from the sched_ key and the stored visible prompt (row 85)', () => {
  const rows = [
    { work_id: 'work_s', session_id: PRIMARY, turn_id: 't1', status: 'completed', created_at: at(12), updated_at: at(11), idempotency_key: `sched_${'a'.repeat(32)}` },
    { work_id: 'work_w', session_id: PRIMARY, turn_id: 't2', status: 'completed', created_at: at(8), updated_at: at(7), idempotency_key: 'wake_abc' },
    { work_id: 'work_x', session_id: PRIMARY, turn_id: 't3', status: 'completed', created_at: at(6), updated_at: at(6), idempotency_key: 'schedule_typed' },
  ];
  const runtime = {
    listSummaries: () => ({ items: rows, next_cursor: null }),
    get: (id) => ({ input: { request: { visiblePrompt: id === 'work_s' ? 'Scheduled check: Morning summary' : 'Woken' } } }),
  };
  const result = build({ runtime }).service.list();
  assert.deepEqual(result.entries.map((item) => [item.id, item.kind]), [['wake:work_w', 'woken'], ['sched:work_s', 'schedule_fired']]);
  assert.deepEqual(byId(result, 'sched:work_s'), {
    id: 'sched:work_s', kind: 'schedule_fired', at: at(12), status: 'completed', title: 'Scheduled check: Morning summary', detail: null,
    session_id: null, project: null, authorization: null, permission_id: null,
  });
});

test('the projected schedule kinds are exactly the stored ones (row 85)', () => {
  const { SCHEDULE_HISTORY_KINDS } = require('../services/primary-activity-log');
  const stored = require('../services/shell-config-primary-chat').SCHEDULE_HISTORY_KINDS;
  assert.deepEqual([...SCHEDULE_HISTORY_KINDS].sort(), [...stored].sort());
});

test('row 86: a digest turn comes from the digest_ key; a held-back digest projects its reason', () => {
  const rows = [
    { work_id: 'work_d', session_id: PRIMARY, turn_id: 't1', status: 'completed', created_at: at(12), updated_at: at(11), idempotency_key: `digest_${'b'.repeat(32)}` },
  ];
  const runtime = {
    listSummaries: () => ({ items: rows, next_cursor: null }),
    get: () => ({ input: { request: { visiblePrompt: 'While you were away' } } }),
  };
  const history = [{ kind: 'digest_skipped', at: at(20), reason: 'quiet_hours' }, { kind: 'digest_skipped', at: at(21) }];
  const result = build({ runtime, controls: { getState: () => ({ permissions: [], history }) } }).service.list();
  assert.deepEqual(byId(result, 'digest:work_d'), {
    id: 'digest:work_d', kind: 'digest', at: at(12), status: 'completed', title: 'While you were away', detail: null,
    session_id: null, project: null, authorization: null, permission_id: null,
  });
  assert.equal(byId(result, `hist:digest_skipped:${at(20)}`).reason, 'quiet_hours');
  assert.equal(result.entries.filter((item) => item.kind === 'digest_skipped').length, 1, 'no reason, no entry');
});
