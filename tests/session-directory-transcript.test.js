'use strict';

// session_transcript reads (the directory's `transcript`): paging, tool activity, the 16,000-character budget
// and `last_reply`; session_status keeps its small text-only tail.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionDirectoryService } = require('../services/session-directory-service');

const T0 = '2026-10-20T10:00:00.000Z';
const text = (id, role, content, turn = null) => ({ id, role, content, timestamp: T0, ...(turn ? { turn_id: turn } : {}) });

function chat(id, extra = {}) {
  return { id, project_id: 'project_a', title: `Chat ${id}`, session_type: 'chat', created_at: T0, updated_at: T0,
    message_count: 2, unread_message_count: 0, archived_at: null, lockdown: false, spawned_from: null,
    linked_session_ids: [], run_mode: 'auto', plan_mode: false, ...extra };
}

function service(messages, extraSessions = []) {
  const sessions = [chat('P', { session_role: 'primary' }), chat('A'), ...extraSessions];
  const store = {
    listSessionRecords: () => sessions.map((entry) => ({ ...entry, active_turn: null })),
    getSessionSummary: (id) => sessions.find((entry) => entry.id === id) || null,
    peekSessionMessages: (id) => (id === 'A' ? messages : []),
  };
  return createSessionDirectoryService({ sessionStore: () => store, visibleChat: () => () => true });
}

const read = (directory, args = {}) => directory.transcript({ callerSessionId: 'P', sessionId: 'A', ...args });
const numbered = (count) => Array.from({ length: count }, (_, index) =>
  text(`m${index}`, index % 2 ? 'assistant' : 'user', `row ${index}`, `t${Math.floor(index / 2)}`));

test('the tail honours transcriptRows and pages older rows with the before id', async () => {
  const directory = service(numbered(30));
  const first = await read(directory, { rows: 5 });
  assert.deepEqual(first.rows.map((row) => row.id), ['m25', 'm26', 'm27', 'm28', 'm29']);
  assert.equal(first.more_before, true);
  assert.deepEqual(Object.keys(first.rows[0]).sort(), ['id', 'role', 'text', 'timestamp']);
  const second = await read(directory, { rows: 5, beforeMessageId: 'm25' });
  assert.deepEqual(second.rows.map((row) => row.id), ['m20', 'm21', 'm22', 'm23', 'm24']);
  const last = await read(directory, { rows: 40, beforeMessageId: 'm3' });
  assert.deepEqual(last.rows.map((row) => row.id), ['m0', 'm1', 'm2']);
  assert.equal(last.more_before, false);
  assert.equal((await read(directory)).rows.length, 20, 'default is 20 rows');
  assert.equal((await read(directory, { rows: 40 })).rows.length, 30);
});

test('an unknown before id is an empty page, not an error; a paged read carries rows only', async () => {
  const answer = await read(service(numbered(6)), { beforeMessageId: 'nope' });
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.rows, []);
  assert.equal(answer.more_before, false);
  for (const key of ['last_reply', 'last_reply_clipped', 'last_reply_message_id']) assert.equal(Object.hasOwn(answer, key), false, key);
  const first = await read(service(numbered(6)));
  assert.equal(first.last_reply, 'row 5');
  assert.deepEqual([first.session_id, first.title], ['A', 'Chat A']);
});

test('tool activity is opt-in, compact, one-line and carries no reasoning', async () => {
  const long = `${'out '.repeat(200)}\nsecond line`;
  const messages = [
    text('u1', 'user', 'run it', 't1'),
    { id: 'th', role: 'assistant', kind: 'thinking', content: 'SECRET REASONING', turn_id: 't1' },
    { id: 'tu', role: 'assistant', kind: 'tool_use', content: 'Run npm test', turn_id: 't1',
      tool_call: { tool_name: 'run_command', summary: 'Run npm test', approval_state: 'approved', input: { command: 'npm test' } } },
    { id: 'tr', role: 'tool', kind: 'tool_result', content: 'x', turn_id: 't1',
      tool_result: { tool_name: 'run_command', summary: long, output_text: 'TOKEN=raw-output', approval_state: 'approved', is_error: false } },
    { id: 'te', role: 'tool', kind: 'tool_result', content: 'x', turn_id: 't1',
      tool_result: { tool_name: 'read_file', summary: 'Read .env', output_text: 'API_KEY=hidden', is_error: true } },
    text('a1', 'assistant', 'done', 't1'),
  ];
  const directory = service(messages);
  const plain = await read(directory);
  assert.deepEqual(plain.rows.map((row) => row.id), ['u1', 'a1']);
  const rich = await read(directory, { includeToolActivity: true });
  assert.deepEqual(rich.rows.map((row) => row.id), ['u1', 'tu', 'tr', 'te', 'a1']);
  assert.deepEqual(rich.rows[1], { id: 'tu', role: 'tool', tool_name: 'run_command', state: 'approved', text: 'Run npm test' });
  const [, , result, failed] = rich.rows;
  assert.deepEqual(Object.keys(result).sort(), ['id', 'role', 'state', 'text', 'tool_name']);
  assert.ok(result.text.length <= 300);
  assert.doesNotMatch(result.text, /\n/);
  assert.equal(failed.state, 'error');
  assert.equal(failed.text, 'Read .env');
  assert.doesNotMatch(JSON.stringify(rich), /TOKEN=raw-output|API_KEY=hidden/, 'raw tool output never leaves the chat');
  assert.doesNotMatch(JSON.stringify(rich), /SECRET REASONING/);
});

test('rows clip at 2,000 characters and the tail budget at 16,000 drops the oldest rows first', async () => {
  const messages = Array.from({ length: 20 }, (_, index) => text(`m${index}`, index % 2 ? 'assistant' : 'user', `${index}`.padEnd(5000, 'y')));
  const answer = await read(service(messages), { rows: 40 });
  const rows = answer.rows;
  assert.ok(rows.every((row) => row.text.length <= 2000));
  assert.equal(rows.reduce((sum, row) => sum + row.text.length, 0), 16000);
  assert.equal(rows.length, 8);
  assert.equal(rows.at(-1).id, 'm19');
  assert.equal(rows[0].id, 'm12', 'the oldest rows are dropped, never trimmed');
  assert.equal(answer.more_before, true);
  const next = await read(service(messages), { rows: 40, beforeMessageId: rows[0].id });
  assert.equal(next.rows.at(-1).id, 'm11', 'paging resumes right below the dropped rows');
});

test('a clip never splits a surrogate pair', async () => {
  const content = `${'a'.repeat(1998)}😀tail`;
  const [row] = (await read(service([text('m', 'user', content)]))).rows;
  assert.doesNotMatch(row.text, /[\ud800-\udbff](?![\udc00-\udfff])/);
  assert.ok(row.text.length <= 2000);
});

test('last_reply joins the last turn assistant text rows and clips at 8,192 bytes', async () => {
  const messages = [text('u1', 'user', 'q1', 't1'), text('a1', 'assistant', 'old answer', 't1'),
    text('u2', 'user', 'q2', 't2'), text('a2', 'assistant', 'first part', 't2'),
    { id: 'tu', role: 'assistant', kind: 'tool_use', content: 'tool', turn_id: 't2', tool_call: { tool_name: 'x' } },
    text('a3', 'assistant', 'second part', 't2')];
  const answer = await read(service(messages));
  assert.equal(answer.last_reply, 'first part\n\nsecond part');
  assert.equal(answer.last_reply_clipped, false);
  assert.equal(answer.last_reply_message_id, 'a3');
  const big = await read(service([text('a', 'assistant', 'é'.repeat(6000), 't')]));
  assert.ok(Buffer.byteLength(big.last_reply, 'utf8') <= 8192);
  assert.equal(big.last_reply_clipped, true);
  assert.ok(!big.last_reply.includes('�'));
  const none = await read(service([text('u', 'user', 'hi')]));
  assert.deepEqual([none.last_reply, none.last_reply_clipped, none.last_reply_message_id], [null, false, null]);
});

test('session_status keeps its small text-only tail; an out-of-scope transcript reads not_found', async () => {
  const long = Array.from({ length: 30 }, (_, index) => text(`m${index}`, 'assistant', `row ${index} ${'w'.repeat(1500)}`, `t${index}`));
  const directory = service(long, [chat('B', { project_id: 'project_b' })]);
  const status = await directory.digest({ callerSessionId: 'P', sessionId: 'A' });
  assert.ok(status.transcript_tail.length <= 12);
  assert.ok(status.transcript_tail.every((row) => row.text.length <= 1000));
  assert.ok(status.transcript_tail.reduce((sum, row) => sum + row.text.length, 0) <= 4000);
  for (const key of ['more_before', 'last_reply', 'transcript_more_before']) assert.equal(Object.hasOwn(status, key), false, key);
  assert.deepEqual(await directory.transcript({ callerSessionId: 'B', sessionId: 'A', rows: 5 }), { ok: false, reason: 'not_found' });
  assert.deepEqual(await directory.transcript({ callerSessionId: 'B', sessionId: 'A', beforeMessageId: 'm2',
    includeToolActivity: true }), { ok: false, reason: 'not_found' });
});

test('a huge row is cut from a bounded head: the tail row and last_reply keep their caps and their clip flags', async () => {
  const huge = `${'\u0007'.repeat(10)}${'z'.repeat(1_000_000)}`;
  const result = await read(service([text('u1', 'user', 'go', 't1'), text('a1', 'assistant', huge, 't1'),
    { id: 'r1', role: 'tool', kind: 'tool_result', tool_result: { tool_name: 'read_file', summary: huge } }]),
  { includeToolActivity: true });
  const row = result.rows.find((entry) => entry.id === 'a1');
  assert.equal(row.text.length, 2000);
  assert.ok(row.text.endsWith(' [clipped]'));
  assert.ok(!row.text.includes('\u0007'), 'the head is still sanitized');
  const tool = result.rows.find((entry) => entry.id === 'r1');
  assert.ok(tool.text.length <= 300);
  assert.equal(result.last_reply_clipped, true);
  assert.ok(Buffer.byteLength(result.last_reply, 'utf8') <= 8192);
  assert.ok(result.last_reply.length > 8000);
});

test('last_reply keeps the end of a long turn, and a clipped long row id still pages', async () => {
  const narration = text('a1', 'assistant', `checking ${'n'.repeat(12000)}`, 't1');
  const conclusion = text('a2', 'assistant', 'FINAL ANSWER: ship it', 't1');
  const reply = await read(service([text('u1', 'user', 'go', 't1'), narration, conclusion]));
  assert.equal(reply.last_reply_clipped, true);
  assert.ok(reply.last_reply.endsWith('FINAL ANSWER: ship it'));
  assert.ok(Buffer.byteLength(reply.last_reply, 'utf8') <= 8192);
  assert.equal(reply.last_reply_message_id, 'a2');

  const longId = `m_${'x'.repeat(200)}`;
  const rows = [text('old', 'user', 'older', 't0'), text(longId, 'assistant', 'long id row', 't0'), text('new', 'user', 'newest', 't1')];
  const first = await read(service(rows), { rows: 2 });
  assert.equal(first.more_before, true);
  const oldestId = first.rows[0].id;
  assert.equal(oldestId.length, 128);
  const next = await read(service(rows), { rows: 2, beforeMessageId: oldestId });
  assert.deepEqual(next.rows.map((row) => row.id), ['old']);
});
