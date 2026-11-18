'use strict';

// new-test-file: services/team/project-answers.js on its own (row 123 slice 3-9 fix 22), no host: for each project
// operation and each conversation event kind, a host answer with an extra field (dropped), a wrong type, a missing
// key and an oversized list (`team_answer_invalid` / null), through `projectAnswer` and `checkedEvent`; and the
// shared rule module admin-answers.js now uses.

const assert = require('node:assert/strict');
const test = require('node:test');

const { checkedEvent, checkedProjectChange, countedEvent, projectAnswer } = require('../services/team/project-answers');
const rules = require('../services/team/answer-rules');

const P = 'project_aaaaaaaaaaaa';
const S = 'sess_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const M = 'member_aaaaaaaaaaaaaaaaaaaaaa';
const SNAPSHOT = { cursor: 1, session: { session_id: S, title: 'T', revision: 'boot:1', plan_mode: false }, messages: [],
  message_count: 0, has_more: false, active_turn: null, pending_approvals: [], pending_questions: [] };
const LEASE = { member_id: M, expires_at: 5 };

// operation -> [a valid answer body, a key to remove, a wrong-typed value for it, a list key and its row, its cap].
// The shown lists (projects, unjoined, conversations) are tested apart: they drop a bad row instead (gate fault F1).
const CASES = {
  'projects.list': [{ projects: [{ id: P, name: 'A', root_revision: 1, role: 'writer' }], files_supported: true },
    'files_supported', 'yes'],
  'team.project.create': [{ project_id: P, name: 'A', channel: true }, 'project_id', 42],
  'team.project.rename': [{ project_id: P, name: 'A' }, 'name', ''],
  'team.project.members.list': [{ members: [{ member_id: M, role: 'writer' }] }, 'members', {},
    ['members', { member_id: M, role: 'reader' }, 64]],
  'team.project.unjoined': [{ projects: [{ project_id: P, name: null }] }, 'projects', 'x'],
  'team.project.audit.read': [{ entries: [], floor_seq: null, next_cursor: null }, 'next_cursor', 'x',
    ['entries', { seq: 1, at: 1, kind: 'project_created', project_id: P, session_id: null, actor_member_id: null,
      prompter_member_id: null, tool_name: null, decision: null, detail: null }, 100]],
  'sessions.create': [{ session: { session_id: S, title: 'T', project_id: P }, revision: 'boot:1' }, 'revision', 3],
  'sessions.snapshot': [{ snapshot: SNAPSHOT }, 'snapshot', [], null],
  'session.view': [{ viewing: true, viewers: [M] }, 'viewing', 'yes', ['viewers', M, 32]],
  'sessions.rename': [{ revision: 'boot:2' }, 'revision', null],
  'sessions.preferences': [{ revision: 'boot:2', session: { session_id: S, title: 'T' } }, 'revision', 7],
  'chat.send': [{ revision: 'boot:2', turn_id: 'turn_1' }, 'revision', 1],
  'control.acquire': [{ lease: LEASE }, 'lease', null],
  'control.heartbeat': [{ lease: LEASE }, 'lease', { expires_at: 'soon' }],
  'approval.resolve': [{ revision: 'boot:2' }, 'revision', {}],
  'questions.answer': [{ revision: 'boot:2' }, 'revision', []],
  'questions.decline': [{ revision: 'boot:2' }, 'revision', false],
  // Row 175 item 6, F18: the redo, branch and hand answers (ids only).
  'team.project.regenerate': [{ session_id: S, stream_id: 'stream_1', revision: 'boot:2' }, 'session_id', 'sess bad'],
  'team.project.edit_resend': [{ session_id: S, revision: 'boot:2' }, 'revision', 2],
  'team.project.branch': [{ session_id: S, revision: 'boot:1' }, 'session_id', null],
  'team.project.hand_driver': [{ member_id: M }, 'member_id', 'device_x'],
};
const invalid = (answer) => answer.ok === false && answer.error.reason === 'team_answer_invalid';

test('every project answer: an extra field is dropped; a wrong type, a missing key, an oversized list refuse it', () => {
  for (const [operation, [body, key, wrong, listed]] of Object.entries(CASES)) {
    const kept = projectAnswer(operation, { ok: true, ...body, extra_secret: 'root_path', device_id: 'device_x' });
    assert.equal(kept.ok, true, operation);
    assert.equal(JSON.stringify(kept).includes('extra_secret'), false, `${operation} drops the extra field`);
    assert.equal(JSON.stringify(kept).includes('device_x'), false, operation);
    const missing = { ok: true, ...body };
    delete missing[key];
    assert.ok(invalid(projectAnswer(operation, missing)), `${operation} without ${key}`);
    assert.ok(invalid(projectAnswer(operation, { ok: true, ...body, [key]: wrong })), `${operation} ${key} wrong type`);
    if (listed) {
      const [listKey, item, cap] = listed;
      assert.ok(invalid(projectAnswer(operation, { ok: true, ...body, [listKey]: Array(cap + 1).fill(item) })),
        `${operation} ${listKey} over ${cap}`);
    }
  }
});

// The host's own row shapes: `projects.list` on a team host (services/host/project-commands.js with the team extras:
// exactly id, name, root_revision, role; the owner's General row reads `owner`) and `sessions.list`
// (server/command-router.js safeSession, where a General conversation may carry `project_id: 'project_general'`).
const GENERAL = { id: 'project_general', name: 'General', root_revision: 0, role: 'owner' };
const projectRow = (id, role = 'admin') => ({ id, name: `Name ${id.slice(-4)}`, root_revision: 2, role });
const P2 = 'project_bbbbbbbbbbbb';

test('F1: General is dropped silently from the projects list; a bad row is dropped and marks it truncated', () => {
  const owner = projectAnswer('projects.list', { ok: true, projects: [GENERAL, projectRow(P), projectRow(P2, 'owner')],
    files_supported: true });
  assert.deepEqual(owner, { ok: true, projects: [projectRow(P), projectRow(P2, 'owner')], truncated: false,
    files_supported: true }, 'the owner\'s real shape: two rows, not truncated');
  assert.deepEqual(projectAnswer('projects.list', { ok: true, projects: [GENERAL], files_supported: false }),
    { ok: true, projects: [], truncated: false, files_supported: false }, 'General only');
  const mixed = projectAnswer('projects.list', { ok: true, projects: [projectRow(P), { id: 'project_bad id', name: 'X',
    root_revision: 1, role: 'admin' }, projectRow(P2)], files_supported: true });
  assert.deepEqual([mixed.projects.map((r) => r.id), mixed.truncated], [[P, P2], true], 'one malformed row among three');
  const bad = projectAnswer('projects.list', { ok: true, projects: [{ id: 5 }, null, 'x'], files_supported: true });
  assert.deepEqual([bad.ok, bad.projects, bad.truncated], [true, [], true], 'only malformed rows');
  const many = projectAnswer('projects.list', { ok: true, projects: Array(129).fill(projectRow(P)), files_supported: true });
  assert.deepEqual([many.projects.length, many.truncated], [128, true], 'past the cap');
  assert.ok(invalid(projectAnswer('projects.list', { ok: true, projects: 'x', files_supported: true })), 'not a list');
  const unjoined = projectAnswer('team.project.unjoined', { ok: true, projects: [{ project_id: 'project_general', name: 'General' },
    { project_id: P, name: null }, { project_id: 'bad', name: 'x' }] });
  assert.deepEqual(unjoined, { ok: true, projects: [{ project_id: P, name: null }], truncated: true });
  // A General conversation is not a bad row: dropped without marking the list truncated.
  const sessions = projectAnswer('sessions.list', { ok: true, sessions: [{ session_id: S, title: 'G', project_id: 'project_general' },
    { session_id: S, title: 'A', project_id: P }], total: 2 });
  assert.deepEqual(sessions, { ok: true, sessions: [{ session_id: S, title: 'A', project_id: P }], truncated: false });
});

test('the empty answers and a refusal: closed, rebuilt, the reason checked', () => {
  for (const operation of ['team.project.delete', 'team.project.members.add', 'team.project.leave', 'sessions.delete',
    'chat.cancel', 'control.release', 'team.project.ask']) {
    assert.deepEqual(projectAnswer(operation, { ok: true, anything: 1 }), { ok: true }, operation);
  }
  assert.ok(invalid(projectAnswer('team.nothing', { ok: true })), 'an operation with no row');
  const refused = projectAnswer('chat.send', { ok: false, error: { code: 'CMP-HOST-0003', reason: 'bad reason <marker> x', extra: 1 } });
  assert.deepEqual(refused, { ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_unavailable' } });
});

test('a snapshot rebuilds its parts: an unknown author is dropped, the lease loses its client', () => {
  const answer = projectAnswer('sessions.snapshot', { ok: true, snapshot: { ...SNAPSHOT,
    messages: [{ id: 'm1', role: 'user', content: 'x', author: { kind: 'device', device_id: 'device_x' } }],
    control: { member_id: M, expires_at: 9, client_id: 'client_x' } } });
  assert.equal(answer.ok, true);
  assert.equal(Object.hasOwn(answer.snapshot.messages[0], 'author'), false);
  assert.deepEqual(answer.snapshot.control, { member_id: M, expires_at: 9 });
  assert.ok(invalid(projectAnswer('sessions.snapshot', { ok: true, snapshot: { ...SNAPSHOT, messages: Array(101).fill({ id: 'm' }) } })));
});

const EVENTS = {
  chat_stream: [{ session_id: S, stream_id: 'stream_1', event: { type: 'started' } }, 'stream_id', 5],
  session_changed: [{ session_id: S, revision: 'boot:2', reason: 'renamed' }, 'session_id', 'sess bad'],
  control_changed: [{ session_id: S, member_id: M, expires_at: 3 }, 'session_id', null],
  decision_changed: [{ session_id: S, stream_id: 'stream_1', approval_id: 'approval_1', approved: true }, 'stream_id', {}],
  approval_unattended: [{ session_id: S, stream_id: 'stream_1', approval_id: 'approval_1', prompter_member_id: null },
    'approval_id', 7],
  // Row 175 F13 (D8).
  teammate_asked: [{ session_id: S, project_id: P, asker_member_id: M, asked_member_id: M, approval_id: 'approval_1' },
    'asker_member_id', 'Alice'],
};

test('every conversation event: an extra field is dropped; a wrong type or a missing key refuses it', () => {
  for (const [type, [body, key, wrong]] of Object.entries(EVENTS)) {
    const kept = checkedEvent(type, { ...body, client_id: 'client_x', device_id: 'device_x' });
    assert.ok(kept, type);
    assert.equal(JSON.stringify(kept).includes('client_x') || JSON.stringify(kept).includes('device_x'), false, type);
    const missing = { ...body };
    delete missing[key];
    assert.equal(checkedEvent(type, missing), null, `${type} without ${key}`);
    assert.equal(checkedEvent(type, { ...body, [key]: wrong }), null, `${type} ${key} wrong type`);
  }
  assert.equal(checkedEvent('chat_stream', { ...EVENTS.chat_stream[0], event: { type: 'started', big: 'x'.repeat(600 * 1024) } }),
    null, 'a stream event over its byte bound');
  assert.equal(checkedEvent('team_secret', { session_id: S }), null, 'a type with no row');
  assert.deepEqual(checkedProjectChange({ project_id: P, reason: 'members', extra: 1 }), { project_id: P, reason: 'members' });
  assert.equal(checkedProjectChange({ project_id: P, reason: 'stolen' }), null);
});

test('countedEvent reads only a count\'s fields and answers null for any other kind', () => {
  assert.deepEqual(countedEvent('chat_stream', { session_id: S, event: { type: 'complete' } }), { session_id: S, kind: 'complete' });
  assert.equal(countedEvent('chat_stream', { session_id: S, event: { type: 'token' } }), null);
  assert.equal(countedEvent('chat_stream', { session_id: S, event: { type: 'tool_approval_needed' } }), null, 'no approval id');
  assert.equal(countedEvent('decision_changed', { session_id: S, question_ref: 'q' }), null, 'a question is not counted');
  assert.equal(countedEvent('approval_unattended', { session_id: 'bad', approval_id: 'a' }), null);
});

test('the shared rules: fields keeps exactly the spec, optional keys may be absent', () => {
  const spec = { a: rules.count, b: rules.optional(rules.flag) };
  assert.deepEqual(rules.fields({ a: 1, z: 2 }, spec), { a: 1 });
  assert.equal(rules.fields({ a: 1, b: 'no' }, spec), rules.BAD);
  assert.equal(rules.fields({ b: true }, spec), rules.BAD);
  assert.equal(rules.list(rules.count, 2)([1, 2, 3]), rules.BAD);
  assert.equal(rules.jsonCopy(4)({ x: 'long' }), rules.BAD);
});

// Row 172: a team host's conversation settings in the snapshot; every field optional, each bounded.
test('row 172: the snapshot keeps the conversation\'s model, effort, switches, log and file tools; a bad one refuses it', () => {
  const state = { model: null, effort: 'default', read: true, write: true };
  const entry = { at: '2026-11-16T10:00:00.000Z', by: M, from: state, to: { ...state, model: 'gemma4-12b', write: false } };
  const team = { preferred_model: 'gemma4-12b', reasoning_effort: 'high', team_tools: { read: true, write: false },
    preference_log: [entry], file_tools: 'unavailable' };
  const read = (session) => projectAnswer('sessions.snapshot', { ok: true, snapshot: { ...SNAPSHOT, session: { ...SNAPSHOT.session, ...session } } });
  const kept = read({ ...team, preference_log: [{ ...entry, note: 'x' }], team_tools: { ...team.team_tools, run: true } });
  assert.equal(kept.ok, true);
  assert.deepEqual(kept.snapshot.session, { ...SNAPSHOT.session, ...team }, 'exactly the documented fields');
  assert.equal(read({}).ok, true, 'an older host sends none of them');
  assert.equal(read({ preferred_model: null }).snapshot.session.preferred_model, null, 'null is the team default');
  for (const bad of [{ preferred_model: 'x'.repeat(257) }, { preferred_model: 'two\nlines' }, { reasoning_effort: 'xhigh' },
    { team_tools: { read: true } }, { team_tools: { read: 'yes', write: true } }, { file_tools: 'maybe' },
    { preference_log: Array(51).fill(entry) }, { preference_log: [{ ...entry, by: 'device_x' }] },
    { preference_log: [{ ...entry, to: { ...state, effort: 'max' } }] }, { preference_log: [{ ...entry, at: 'x'.repeat(41) }] }]) {
    assert.ok(invalid(read(bad)), JSON.stringify(bad).slice(0, 80));
  }
});

// Team host file tools (row 123): why a host with the setting on offers none, one word from a closed list.
test('the snapshot keeps a file tools reason from the closed list and refuses any other word', () => {
  const read = (session) => projectAnswer('sessions.snapshot', { ok: true, snapshot: { ...SNAPSHOT, session: { ...SNAPSHOT.session, ...session } } });
  for (const reason of ['file_access_switch_off', 'file_access_elevated', 'file_access_unavailable']) {
    const kept = read({ file_tools: 'unavailable', file_tools_reason: reason });
    assert.equal(kept.ok, true, reason);
    assert.equal(kept.snapshot.session.file_tools_reason, reason);
  }
  for (const bad of ['file_access_made_up', 'C:/Users/owner/projects', '', 7, null]) {
    assert.ok(invalid(read({ file_tools: 'unavailable', file_tools_reason: bad })), String(bad));
  }
});

// Row 175 F5: a pending write_file / edit_file approval's exact presentation survives only when it validates.
test('a pending approval keeps a valid exact presentation and drops a malformed one', () => {
  const approval = { approval_id: 'approval_1', decision_revision: 'dec_abc', stream_id: 'stream_1', tool_name: 'write_file',
    call_id: 'call_1', summary: 'Write a.md' };
  const exact = { schema_version: 1, fields: [{ name: 'file_path', text: 'a.md' }, { name: 'content', text: '<b>hi</b>' }],
    bytes: 30, sha256: 'a'.repeat(64) };
  const read = (extra) => projectAnswer('sessions.snapshot', { ok: true, snapshot: { ...SNAPSHOT,
    pending_approvals: [{ ...approval, ...extra }] } });
  const kept = read({ exact_approval: { ...exact, extra_key: 'dropped' } });
  assert.equal(kept.ok, true);
  assert.deepEqual(kept.snapshot.pending_approvals[0].exact_approval, exact, 'rebuilt field by field; the text is data, unchanged');
  const large = { schema_version: 1, too_large: true, bytes: 40_000, limit_bytes: 32_768 };
  assert.deepEqual(read({ exact_approval: { ...large, junk: 1 } }).snapshot.pending_approvals[0].exact_approval, large);
  const many = Array.from({ length: 17 }, (_, index) => ({ name: `f${index}`, text: 'x' }));
  for (const bad of [{ ...exact, sha256: 'A'.repeat(64) }, { ...exact, sha256: 'a'.repeat(63) }, { ...exact, fields: many },
    { ...exact, fields: [{ name: 'content', text: 'x'.repeat(32 * 1024 + 1) }] }, { ...exact, schema_version: 2 },
    { ...exact, fields: [{ name: 'bad name', text: 'x' }] }, { ...exact, fields: [{ name: 'content', text: 5 }] },
    { ...exact, fields: 'x' }, { schema_version: 1, too_large: true, bytes: 'many', limit_bytes: 1 }, 'text', null, [], 7]) {
    const result = read({ exact_approval: bad });
    assert.equal(result.ok, true, 'the approval itself stays');
    const entry = result.snapshot.pending_approvals[0];
    assert.equal(entry.summary, 'Write a.md');
    assert.equal(entry.exact_approval, null, 'kept as null, so the card fails closed: ' + JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(Object.hasOwn(read({}).snapshot.pending_approvals[0], 'exact_approval'), false, 'an older host sends none');
});

test('row 175 wave 5: the reader view answers keep their fields within bounds; anything else refuses them', () => {
  const file = { path: 'docs/a.md', size: 3, kind: 'file' };
  const dir = { path: 'docs', size: 0, kind: 'dir' };
  const page = { entries: [dir, file], next_cursor: null, total: 2, capped: false };
  assert.deepEqual(projectAnswer('team.project.files.list', { ok: true, ...page, request_id: 'r', extra: 1,
    entries: [dir, { ...file, sha256: 'x' }] }), { ok: true, ...page });
  const read = { path: 'docs/a.md', size: 3, text: 'abc', truncated: false, binary: false };
  assert.deepEqual(projectAnswer('team.project.files.read', { ok: true, ...read, extra: 'x' }), { ok: true, ...read });
  // At the bounds: 500 rows, a 1,024-character path, 256 KiB of text.
  const long = 'a'.repeat(1024);
  assert.equal(projectAnswer('team.project.files.list', { ok: true, ...page,
    entries: Array.from({ length: 500 }, () => ({ ...file, path: long })) }).entries.length, 500);
  assert.equal(projectAnswer('team.project.files.read', { ok: true, ...read, path: long, text: 'x'.repeat(256 * 1024) }).ok, true);
  const refused = (operation, body) => assert.equal(projectAnswer(operation, { ok: true, ...body }).error.reason,
    'team_answer_invalid', `${operation} ${JSON.stringify(body).slice(0, 80)}`);
  for (const entries of [Array.from({ length: 501 }, () => file), [{ ...file, kind: 'link' }], [{ ...file, path: '' }],
    [{ ...file, path: `${long}a` }], [{ ...file, path: 'a\nb' }], [{ ...file, size: -1 }], [{ path: 'a', kind: 'file' }]]) {
    refused('team.project.files.list', { ...page, entries });
  }
  refused('team.project.files.list', { ...page, next_cursor: 'x' });
  refused('team.project.files.list', { entries: [], next_cursor: null, capped: false });
  for (const change of [{ text: 'x'.repeat(256 * 1024 + 1) }, { path: `${long}a` }, { path: '' }, { binary: 'yes' },
    { size: 1.5 }, { text: 7 }]) refused('team.project.files.read', { ...read, ...change });
  const { truncated: _truncated, ...missing } = read;
  refused('team.project.files.read', missing);
  // A refusal passes as the host's checked failure.
  assert.equal(projectAnswer('team.project.files.read', { ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_not_found' } })
    .error.reason, 'team_not_found');
});

// Row 175 wave 2 (F4, F14): the stream events the renderer reads a failure's reason and a compaction from reach it whole
// inside their byte bound, so the reason's whitelist is the renderer's; nothing outside the event body is added.
test('a stream end keeps the host\'s own failure fields and a compaction event passes, both inside the event bound', () => {
  const end = { type: 'error', message: 'It failed', error_code: 'CMP-AI-0002', category: 'model_unavailable', status: 'failed', terminal_subcode: 'node_lost',
    cancel_reason: 'service_stop', retryable: true };
  const kept = checkedEvent('chat_stream', { session_id: S, stream_id: 'stream_1', event: end, client_id: 'client_x' });
  assert.deepEqual(kept, { session_id: S, stream_id: 'stream_1', event: end });
  const compacted = checkedEvent('chat_stream', { session_id: S, stream_id: 'stream_1', event: { type: 'context_compacted', strategy: 'micro', tokensBefore: 9, tokensAfter: 3 } });
  assert.equal(compacted.event.type, 'context_compacted');
  assert.equal(checkedEvent('chat_stream', { session_id: S, stream_id: 'stream_1', event: { ...end, message: 'x'.repeat(600 * 1024) } }), null);
});

// Row 175 round 2 (D13): the read's picture answer and its too-large answer, each alone; the bytes are checked here.
test('team.project.files.read: a picture passes whole when its bytes match, past the pixel bounds it is too large', () => {
  const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const png = (w, h) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32be(13), Buffer.from('IHDR'), u32be(w), u32be(h),
    Buffer.from([8, 6, 0, 0, 0, 0, 0, 0, 0])]);
  const gif = (w, h) => { const b = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(8)]); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b; };
  const answer = (bytes, mime, extra = {}) => projectAnswer('team.project.files.read', { ok: true, path: 'pics/a.png', size: bytes.length,
    image: { mime, data_base64: bytes.toString('base64') }, ...extra });
  const small = png(2, 3);
  assert.deepEqual(answer(small, 'image/png'), { ok: true, path: 'pics/a.png', size: small.length, image: { mime: 'image/png', data_base64: small.toString('base64') } });
  assert.equal(answer(gif(2, 2), 'image/gif').image.mime, 'image/gif');
  // Past 8192 px a side, 40 megapixels, or 4 megapixels for a GIF: too large to show, no bytes passed on.
  for (const [bytes, mime] of [[png(8193, 1), 'image/png'], [png(7000, 7000), 'image/png'], [gif(2001, 2000), 'image/gif']]) {
    assert.deepEqual(answer(bytes, mime), { ok: true, path: 'pics/a.png', size: bytes.length, too_large: true });
  }
  const tooLarge = { ok: true, path: 'big.png', size: 9 * 1024 * 1024, too_large: true };
  assert.deepEqual(projectAnswer('team.project.files.read', { ...tooLarge, extra: 1 }), tooLarge);
  const refused = (body) => assert.equal(projectAnswer('team.project.files.read', body).error.reason, 'team_answer_invalid', JSON.stringify(body).slice(0, 120));
  // A signature that does not match the type, a length that is not the size, bad base64, an unknown type, mixed shapes.
  refused({ ok: true, path: 'a.png', size: small.length, image: { mime: 'image/jpeg', data_base64: small.toString('base64') } });
  refused({ ok: true, path: 'a.png', size: small.length + 1, image: { mime: 'image/png', data_base64: small.toString('base64') } });
  refused({ ok: true, path: 'a.png', size: 3, image: { mime: 'image/png', data_base64: 'ab$=' } });
  refused({ ok: true, path: 'a.svg', size: 3, image: { mime: 'image/svg+xml', data_base64: 'YWJj' } });
  refused({ ok: true, path: 'a.png', size: small.length, image: { mime: 'image/png', data_base64: small.toString('base64') }, text: '', truncated: false, binary: false });
  refused({ ...tooLarge, text: 'x' });
  refused({ ...tooLarge, too_large: false });
  refused({ ok: true, path: 'a.png', size: 1, text: 'x' });
  refused({ ok: true, path: 'a.png', size: 1, image: { mime: 'image/png', data_base64: 'A'.repeat(Math.ceil(4 * 1024 * 1024 / 3) * 4 + 4) } });
});

test('row 175 item 11: snapshot receipts keep ids and host time, drop a malformed one alone, and keep the newest 50', () => {
  const receipt = (seq, extra = {}) => ({ seq, session_id: S, outcome: 'allowed', tool_name: 'write_file', approver_member_id: M,
    prompter_member_id: M, decided_at: '2026-11-17T10:00:00.000Z', ...extra });
  const kept = projectAnswer('sessions.snapshot', { ok: true, snapshot: { ...SNAPSHOT, receipts: [
    receipt(1, { prompt: 'secret prompt' }), receipt(2, { outcome: 'maybe' }), receipt(3, { decided_at: 'yesterday' }),
    receipt(4, { approver_member_id: 'Alice' }), receipt(5, { outcome: 'expired', approver_member_id: null }), 'junk'] } });
  assert.equal(kept.ok, true);
  assert.deepEqual(kept.snapshot.receipts, [receipt(1), receipt(5, { outcome: 'expired', approver_member_id: null })]);
  const many = projectAnswer('sessions.snapshot', { ok: true, snapshot: { ...SNAPSHOT,
    receipts: Array.from({ length: 60 }, (_v, i) => receipt(i + 1)) } });
  assert.deepEqual([many.snapshot.receipts.length, many.snapshot.receipts[0].seq], [50, 11]);
  assert.deepEqual(projectAnswer('sessions.snapshot', { ok: true, snapshot: { ...SNAPSHOT, receipts: 'x' } }).snapshot.receipts, []);
  assert.equal(Object.hasOwn(projectAnswer('sessions.snapshot', { ok: true, snapshot: SNAPSHOT }).snapshot, 'receipts'), false,
    'an older host sends none and none is made up');
});

test('row 175 F9: a listed conversation keeps its waiting counts; a malformed one is dropped and the row stays', () => {
  const row = (waiting) => ({ session_id: S, title: 'T', project_id: P, ...(waiting === undefined ? {} : { waiting }) });
  const answer = projectAnswer('sessions.list', { ok: true, sessions: [row({ approvals: 2, questions: 1, extra: 'x' }),
    row({ approvals: 65, questions: 0 }), row({ approvals: -1, questions: 0 }), row('2'), row({ approvals: 1 }), row()] });
  assert.equal(answer.ok, true);
  assert.equal(answer.truncated, false);
  assert.deepEqual(answer.sessions.map((r) => r.waiting), [{ approvals: 2, questions: 1 }, undefined, undefined, undefined,
    undefined, undefined]);
  assert.equal(answer.sessions.slice(1).every((r) => !Object.hasOwn(r, 'waiting')), true);
});

test('row 175 F18: a snapshot keeps who views it as member ids; a bad list refuses it; an older host sends none', () => {
  const answer = projectAnswer('sessions.snapshot', { ok: true, snapshot: { ...SNAPSHOT, viewers: [M] } });
  assert.deepEqual(answer.snapshot.viewers, [M]);
  assert.equal(Object.hasOwn(projectAnswer('sessions.snapshot', { ok: true, snapshot: SNAPSHOT }).snapshot, 'viewers'), false);
  for (const viewers of [['Alice'], Array(33).fill(M), 'x']) {
    assert.ok(invalid(projectAnswer('sessions.snapshot', { ok: true, snapshot: { ...SNAPSHOT, viewers } })), JSON.stringify(viewers).slice(0, 20));
  }
});

test('audit schema 4: a receipt keeps its approval and call ids and an answered outcome; a bad id drops that receipt', () => {
  const receipt = (seq, extra = {}) => ({ seq, session_id: S, outcome: 'allowed', tool_name: 'write_file', approver_member_id: M,
    prompter_member_id: M, decided_at: '2026-11-17T10:00:00.000Z', ...extra });
  const ids = { approval_id: `approval_${S}_stream_1_functions.write_file:0`, call_id: 'functions.write_file:0' };
  const answered = receipt(2, { outcome: 'answered', tool_name: null, call_id: 'call_q' });
  const kept = projectAnswer('sessions.snapshot', { ok: true, snapshot: { ...SNAPSHOT, receipts: [receipt(1, ids), answered,
    receipt(3, { approval_id: 'C:/secret/a b' }), receipt(4, { call_id: 'x'.repeat(129) }), receipt(5, { approval_id: '' })] } });
  assert.deepEqual(kept.snapshot.receipts, [receipt(1, ids), answered], 'an older host\'s receipt (no ids) still passes');
});

test('row 175 item 7: a preference log state keeps an optional plan flag; an older host\'s entry has none; a bad one refuses', () => {
  const state = { model: null, effort: 'default', read: true, write: true };
  const read = (log) => projectAnswer('sessions.snapshot', { ok: true, snapshot: { ...SNAPSHOT,
    session: { ...SNAPSHOT.session, preference_log: log } } });
  const planned = { at: '2026-11-17T10:00:00.000Z', by: M, from: { ...state, plan: false }, to: { ...state, plan: true } };
  const older = { at: '2026-11-16T10:00:00.000Z', by: M, from: state, to: { ...state, write: false } };
  assert.deepEqual(read([older, planned]).snapshot.session.preference_log, [older, planned]);
  assert.ok(invalid(read([{ ...planned, to: { ...state, plan: 'on' } }])));
});
