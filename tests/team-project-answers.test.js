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
  'chat.send': [{ revision: 'boot:2', turn_id: 'turn_1' }, 'revision', 1],
  'control.acquire': [{ lease: LEASE }, 'lease', null],
  'control.heartbeat': [{ lease: LEASE }, 'lease', { expires_at: 'soon' }],
  'approval.resolve': [{ revision: 'boot:2' }, 'revision', {}],
  'questions.answer': [{ revision: 'boot:2' }, 'revision', []],
  'questions.decline': [{ revision: 'boot:2' }, 'revision', false],
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
    'chat.cancel', 'control.release']) {
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
