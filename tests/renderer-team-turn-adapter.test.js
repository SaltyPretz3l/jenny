'use strict';

// new-test-file: the pure adapter from Team host messages to the local chat shape (row 171), a new module

const test = require('node:test');
const assert = require('node:assert/strict');

const { toLocalMessages, liveMessage, LIMITS } = require('../renderer/team/renderer-team-turn-adapter');

const deepKeys = (value, out = new Set()) => {
  if (Array.isArray(value)) value.forEach((v) => deepKeys(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); deepKeys(v, out); }
  return out;
};

test('a message keeps only the whitelisted fields, as new objects', () => {
  const host = {
    id: 'm1', role: 'assistant', kind: '', content: 'Hello', status: 'complete', terminal_subcode: '', timestamp: 't0',
    turn_id: 'turn-1', parent_stream_id: 's1', event_seq: 4, finalized_at: 't1', model_used: 'qwen', client_message_id: 'c',
    reasoning: { source: 'provider', entries: [{ id: 'r1', text: 'think', extra: 'x' }], other: 1 },
    phases: [{ phase_id: 'p1', metadata: { secret: 1 } }], visible_segments: [{ segment_id: 's', text: 'Hello' }], tool_steps: [],
    generated_artifacts: [{ artifact_id: 'a' }], attachments: [{ id: 'f' }], interactive_batch: {}, interactive_round_recap: {},
    plan_object: {}, plan_document: {}, metadata: { path: 'C:/x' }, author: { kind: 'member', member_id: 'm' },
    recovery_actions: [{ id: 'retry' }], resumable_stop: 'budget', stream_error: 'x', error_code: 'CMP-X-0001',
  };
  const [local] = toLocalMessages([host]);
  assert.deepEqual(Object.keys(local).sort(), ['content', 'event_seq', 'finalizedAt', 'finalized_at', 'id', 'kind', 'parent_stream_id',
    'phases', 'reasoning', 'role', 'status', 'terminal_subcode', 'timestamp', 'tool_steps', 'turn_id', 'visible_segments'].sort());
  assert.deepEqual(local.reasoning, { source: 'provider', entries: [{ id: 'r1', text: 'think' }] });
  assert.deepEqual(local.phases, [{ phase_id: 'p1' }]);
  assert.equal(local.finalizedAt, 't1');
  assert.notEqual(local.visible_segments, host.visible_segments, 'copied, not shared');
});

test('a tool call keeps its name, parsed input and a cleaned summary; approval state is always none', () => {
  const [call] = toLocalMessages([{ id: 't', role: 'assistant', kind: 'tool_use', turn_id: 'x',
    tool_call: { call_id: 'c1', tool_name: 'read\u202e_file', input_json: '{"path":"a.txt"}', status: 'pending_approval',
      summary: 'Read\u200b  a.txt\n' + 'y'.repeat(900), approval_state: 'pending', policy_scope: 'x', user_questions: [{ q: 1 }], input: { evil: 1 } } }]);
  assert.deepEqual(Object.keys(call.tool_call).sort(), ['approval_state', 'call_id', 'input', 'input_json', 'status', 'summary', 'tool_name']);
  assert.equal(call.tool_call.tool_name, 'read_file', 'bidi characters out');
  assert.deepEqual(call.tool_call.input, { path: 'a.txt' });
  assert.equal(call.tool_call.approval_state, 'none');
  assert.equal(Array.from(call.tool_call.summary).length, LIMITS.summary);
  assert.ok(call.tool_call.summary.startsWith('Read a.txt y'));
  for (const json of ['[1,2]', 'not json', '"x"', '{"a":', '']) {
    assert.deepEqual(toLocalMessages([{ id: 't', role: 'assistant', kind: 'tool_use', tool_call: { input_json: json } }])[0].tool_call.input, {});
  }
  const prototype = toLocalMessages([{ id: 't', role: 'assistant', kind: 'tool_use', tool_call: { input_json: '{"__proto__":{"polluted":1},"a":1}' } }]);
  assert.deepEqual(prototype[0].tool_call.input, { a: 1 });
  assert.equal({}.polluted, undefined);
});

test('a tool result keeps the output, error flag, duration and code, and drops metadata and artifacts', () => {
  const [result] = toLocalMessages([{ id: 'r', role: 'tool', kind: 'tool_result', turn_id: 'x', tool_result: {
    call_id: 'c1', tool_name: 'run_command', output_text: 'z'.repeat(LIMITS.output + 50), is_error: 'yes', duration_ms: 12,
    error_code: 'CMP-TOOL-0047', metadata: { test_summary: {} }, generated_artifacts: [{}], trusted_attachment_refs: [{ id: 'i' }],
    approval_state: 'denied', exit_code: 1 } }]);
  assert.deepEqual(Object.keys(result.tool_result).sort(), ['call_id', 'duration_ms', 'error_code', 'is_error', 'output_text', 'tool_name']);
  assert.equal(result.tool_result.output_text.length, LIMITS.output);
  assert.equal(result.tool_result.is_error, false, 'only a real true is an error');
  const [noDuration] = toLocalMessages([{ id: 'r', role: 'tool', kind: 'tool_result', tool_result: { duration_ms: -1 } }]);
  assert.equal('duration_ms' in noDuration.tool_result, false);
});

test('card kinds and unknown roles are dropped; turn events lose metadata, artifacts and attachments at any depth', () => {
  const kinds = ['question_batch', 'plan_document', 'plan_proposal', 'interactive_round_recap', 'proactive_suggestion', 'slash_command_output'];
  const messages = kinds.map((kind, i) => ({ id: 'k' + i, role: 'assistant', kind }))
    .concat([{ id: 's', role: 'system', content: 'x' }, { id: 'c', role: 'context', content: 'x' }, null, 'x',
      { id: 'ok', role: 'assistant', content: 'kept', turn_events: [{ kind: 'tool_result', payload: { metadata: { a: 1 },
        nested: [{ generated_artifacts: [1], artifacts: [2], attachments: [3], review_findings: [4], keep: 'yes' }] } }] }]);
  const local = toLocalMessages(messages);
  assert.deepEqual(local.map((m) => m.id), ['ok']);
  const keys = deepKeys(local[0].turn_events);
  for (const banned of ['metadata', 'generated_artifacts', 'artifacts', 'attachments', 'review_findings']) assert.equal(keys.has(banned), false, banned);
  assert.equal(local[0].turn_events[0].payload.nested[0].keep, 'yes');
});

test('content is cut to 256 KB and the input is never mutated', () => {
  const input = [{ id: 'u', role: 'user', content: 'a'.repeat(LIMITS.content + 10), author: { member_id: 'm' }, attachments: [{ id: 'f' }] }];
  const before = JSON.parse(JSON.stringify(input));
  const [local] = toLocalMessages(input);
  assert.equal(local.content.length, LIMITS.content);
  assert.deepEqual(input, before);
  assert.deepEqual(toLocalMessages(null), []);
});

test('the live message carries the unsaved words and reasoning, or is null', () => {
  assert.equal(liveMessage(), null);
  assert.equal(liveMessage({ stream: { id: 's', text: '', reasoning: [{ text: ' ' }] } }), null);
  const live = liveMessage({ stream: { id: 's9', text: 'Hi', reasoning: [{ id: 'a', text: 'why' }, { text: 'how' }] }, turnId: 'turn-9', model: 'qwen\u202e3' });
  assert.deepEqual(live, { id: 'live-s9', role: 'assistant', kind: '', content: 'Hi', status: 'streaming', turn_id: 'turn-9',
    reasoning: { source: 'provider', entries: [{ id: 'a', text: 'why' }, { id: 'live-reasoning-1', text: 'how' }] }, model_used: 'qwen3' });
  assert.equal(liveMessage({ stream: { id: 's', text: 'only words' } }).reasoning, undefined);
});

// ------------------------------------------------------------ row 175, wave 1: the live tail's place, cursors and status

const adapter = require('../renderer/team/renderer-team-turn-adapter');
const { normalizeChatMessages } = require('../renderer/chat/chat-message-utils');
const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');
const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');

const TURN = 'turn-1';
const savedTurn = () => [
  { id: 'u1', role: 'user', content: 'read the file', turn_id: TURN, event_seq: 200, timestamp: '2026-11-17T10:00:00Z' },
  { id: 'assistant_s1_seg0', role: 'assistant', content: 'Let me look.', turn_id: TURN, event_seq: 201, timestamp: '2026-11-17T10:00:01Z', status: 'complete' },
  { id: 'tu1', role: 'assistant', kind: 'tool_use', turn_id: TURN, event_seq: 202, tool_call: { call_id: 'c1', tool_name: 'read_file', input_json: '{"path":"a.txt"}', status: 'completed' } },
  { id: 'tr1', role: 'tool', kind: 'tool_result', turn_id: TURN, event_seq: 203, tool_result: { call_id: 'c1', tool_name: 'read_file', output_text: 'hello' } },
];
// The popover's row chain over local messages, as `<kind> <message id> row id` lines.
const chainRows = (list) => projectTurnTree({ messages: normalizeChatMessages(list.map((m) => ({ ...m, turn_id: TURN }))) }).turns
  .flatMap((t) => projectTurnRows(t.events || [], { deterministicRowId: true }) || [])
  .map((r) => r.kind + ' <' + (r.primary_message_id || (r.source_message_ids || [])[0] || '') + '> ' + r.row_id);

test('the live tail sorts after every saved message and takes the row id the saved message will have (A1)', () => {
  const base = adapter.toLocalMessages(savedTurn());
  const tail = adapter.liveMessage({ stream: { id: 's1', text: 'The file says hello.' }, turnId: TURN, saved: base });
  assert.equal(tail.event_seq, 204);
  const rows = chainRows(base.concat(tail));
  assert.match(rows[0], /^user_bubble <u1>/, 'the prompt is first');
  assert.match(rows[1], /^assistant_text <assistant_s1_seg0>/);
  assert.match(rows[rows.length - 1], /^assistant_text <live-s1> row:assistant_text:turn-1:1$/);
  const rowIds = rows.map((r) => r.split(' ').pop());
  assert.equal(new Set(rowIds).size, rowIds.length, 'no saved row id is reused');
});

test('nextEventSeq: the highest saved plus one, 0 with nothing saved, none when saved messages carry no sequence', () => {
  assert.equal(adapter.nextEventSeq([]), 0);
  assert.equal(adapter.nextEventSeq(undefined), 0);
  assert.equal(adapter.nextEventSeq([{ event_seq: 3 }, { event_seq: 9 }, {}]), 10);
  assert.equal(adapter.nextEventSeq([{ id: 'a' }]), undefined);
  assert.equal(adapter.liveMessage({ stream: { id: 's', text: 'Hi' } }).event_seq, undefined, 'no saved list given: no stamp');
  assert.equal(adapter.liveMessage({ stream: { id: 's', text: 'Hi' }, saved: [] }).event_seq, 0);
});

test('liveMessage with cursors carries only the unsaved words and reasoning; null when nothing is left', () => {
  const stream = { id: 's1', text: 'Let me look.\n\nThe file says hello.', reasoning: [{ id: 'r0', text: 'saved thought' }, { id: 'r1', text: 'new thought' }] };
  const tail = adapter.liveMessage({ stream, turnId: TURN, savedTextLength: 'Let me look.'.length, savedReasoningIds: ['r0'] });
  assert.equal(tail.content, 'The file says hello.');
  assert.deepEqual(tail.reasoning.entries, [{ id: 'r1', text: 'new thought' }]);
  assert.equal(adapter.liveMessage({ stream: { id: 's1', text: 'Done.', reasoning: [{ id: 'r0', text: 'x' }] }, savedTextLength: 5, savedReasoningIds: ['r0'] }), null);
  assert.equal(adapter.liveMessage({ stream: { id: 's1', text: 'abc' }, savedTextLength: 99 }), null, 'a cursor past the words leaves none');
});

test('the tail status follows how the stream ended', () => {
  const status = (ended) => adapter.liveMessage({ stream: { id: 's', text: 'Hi', ended } }).status;
  assert.deepEqual(['', 'complete', 'error', 'failed', 'cancelled', 'canceled'].map(status), ['streaming', 'complete', 'error', 'error', 'cancelled', 'cancelled']);
});

test('a running tool with no saved row becomes a synthetic running tool_use, after the saved rows', () => {
  const tools = [{ id: 'c1', name: 'read_file', state: 'running' }, { id: 'c2', name: 'grep_search', state: 'running' }, { id: 'c3', name: 'x', state: 'done' },
    { id: '', name: 'anon', state: 'running' }, { id: 'c2', name: 'grep_search', state: 'running' }];
  const live = adapter.liveToolMessages(tools, ['c1'], TURN, 204);
  assert.equal(live.length, 1, 'saved, finished, nameless-id and repeated calls give no row');
  assert.deepEqual(live[0], { id: 'live-tool-c2', role: 'assistant', kind: 'tool_use', content: '', status: '', turn_id: TURN, event_seq: 204,
    tool_call: { call_id: 'c2', tool_name: 'grep_search', input: {}, input_json: '', status: 'running', summary: '', approval_state: 'none' } });
  assert.equal(adapter.liveToolMessages(tools, [], TURN)[1].event_seq, undefined, 'no sequence when none is known');
  assert.deepEqual(adapter.liveToolMessages(null, null, TURN, 0), []);
  const rows = chainRows(adapter.toLocalMessages(savedTurn()).concat(live));
  assert.match(rows[rows.length - 1], /^tool_call <live-tool-c2>/);
});

// ------------------------------------------------------------ row 175, wave 2: Jenny's edits as diffs, the compaction notice

const call = (id, tool, input) => ({ id: 'tu-' + id, role: 'assistant', kind: 'tool_use', turn_id: TURN,
  tool_call: { call_id: id, tool_name: tool, input_json: typeof input === 'string' ? input : JSON.stringify(input), status: 'completed' } });
const result = (id, tool, extra = {}) => ({ id: 'tr-' + id, role: 'tool', kind: 'tool_result', turn_id: TURN,
  tool_result: { call_id: id, tool_name: tool, output_text: 'ok', is_error: false, ...extra } });
const diffOf = (list) => adapter.toLocalMessages(list).find((m) => m.role === 'tool').tool_result.metadata;

test('a write_file result carries the content as an all-added file; the host metadata is not copied', () => {
  const metadata = diffOf([call('c1', 'write_file', { path: 'a.txt', content: 'one\ntwo\n' }),
    result('c1', 'write_file', { metadata: { diff: { path: 'C:/secret', hunks: [{ lines: ['+evil'] }] }, path: 'C:/x' } })]);
  assert.deepEqual(metadata, { diff: { path: 'a.txt', additions: 2, deletions: 0,
    hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+one', '+two'] }] } });
  const alias = diffOf([call('c1', 'write_file', { file_path: 'b.txt', content: '' }), result('c1', 'write_file')]);
  assert.equal(alias.diff.path, 'b.txt', 'file_path is the same field');
  assert.equal(alias.diff.additions, 0);
});

test('an edit_file result carries its old and new strings as hunks, one per edit', () => {
  const single = diffOf([call('c1', 'edit_file', { file_path: 'b.js', old_string: 'a\nb', new_string: 'c' }), result('c1', 'edit_file')]);
  assert.deepEqual(single, { diff: { path: 'b.js', additions: 1, deletions: 2,
    hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 1, lines: ['-a', '-b', '+c'] }] } });
  const batch = diffOf([call('c1', 'edit_file', { file_path: 'b.js', edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'p', new_string: '' }, 'bad', null] }),
    result('c1', 'edit_file')]);
  assert.deepEqual(batch.diff.hunks.map((h) => h.lines), [['-x', '+y'], ['-p']]);
  assert.deepEqual([batch.diff.additions, batch.diff.deletions], [1, 2]);
});

test('no diff for another tool, an error result, a call with no input to read or no matching call; the input is not mutated', () => {
  const none = (list) => adapter.toLocalMessages(list).find((m) => m.role === 'tool').tool_result.metadata;
  assert.equal(none([call('c1', 'read_file', { path: 'a.txt', content: 'x' }), result('c1', 'read_file')]), undefined);
  assert.equal(none([call('c1', 'write_file', { path: 'a.txt', content: 'x' }), result('c1', 'write_file', { is_error: true })]), undefined);
  assert.equal(none([call('c1', 'write_file', { path: 'a.txt', content: 7 }), result('c1', 'write_file')]), undefined, 'content is not text');
  assert.equal(none([call('c1', 'write_file', { content: 'x' }), result('c1', 'write_file')]), undefined, 'no path');
  assert.equal(none([call('c1', 'edit_file', { file_path: 'a', old_string: 4, new_string: 'x' }), result('c1', 'edit_file')]), undefined);
  assert.equal(none([call('c1', 'write_file', 'not json'), result('c1', 'write_file')]), undefined);
  assert.equal(none([call('c2', 'write_file', { path: 'a.txt', content: 'x' }), result('c1', 'write_file')]), undefined, 'a result of another call');
  const host = [call('c1', 'write_file', { path: 'a.txt', content: 'x' }), result('c1', 'write_file')];
  const before = JSON.parse(JSON.stringify(host));
  adapter.toLocalMessages(host);
  assert.deepEqual(host, before);
});

test('a change over 64 KiB of input text or 400 lines becomes a path-only truncated diff', () => {
  const tooLong = (input, tool = 'write_file') => diffOf([call('c1', tool, input), result('c1', tool)]);
  const expected = { diff: { path: 'big.txt', truncated: true, truncation_reason: 'line_limit' } };
  assert.deepEqual(tooLong({ path: 'big.txt', content: 'x'.repeat(64 * 1024 + 1) }), expected, 'over the text bound');
  assert.deepEqual(tooLong({ path: 'big.txt', content: 'x\n'.repeat(401) }), expected, 'over the line bound');
  assert.equal(tooLong({ path: 'big.txt', content: 'x\n'.repeat(400) }).diff.additions, 400, 'exactly 400 lines is drawn');
  assert.deepEqual(tooLong({ file_path: 'big.txt', old_string: 'a\n'.repeat(200), new_string: 'b\n'.repeat(201) }, 'edit_file'), expected, 'old and new count together');
  const cut = diffOf([call('c1', 'write_file', '{"path":"big.txt","content":"' + 'y'.repeat(LIMITS.inputJson + 10) + '"}'), result('c1', 'write_file')]);
  assert.deepEqual(cut, expected, 'an input the whitelist had to cut');
});

test('a message keeps a bounded context_compacted notice and nothing else of it', () => {
  const [kept] = adapter.toLocalMessages([{ id: 'a', role: 'assistant', content: 'x', turn_id: TURN, context_compacted: { strategy: 'micro\u202e', tokensBefore: 900.7, tokensAfter: -3,
    phase: 'preflight', occurredAt: '2026-11-17T10:00:00Z', summaryExcerpt: 'SECRET TEXT', droppedBytes: 5, reasonCode: 'x' },
  context_compactions: [{ strategy: 'a' }] }]);
  assert.deepEqual(kept.context_compacted, { strategy: 'micro', tokensBefore: 900, tokensAfter: 0, phase: 'preflight', occurredAt: '2026-11-17T10:00:00Z' });
  assert.equal(kept.context_compactions, undefined);
  for (const bad of [null, 'yes', 7, [1], undefined]) {
    assert.equal(adapter.toLocalMessages([{ id: 'a', role: 'assistant', content: 'x', context_compacted: bad }])[0].context_compacted, undefined);
  }
});

test('a live tail with a compaction and no words is still a message, carrying only the notice', () => {
  assert.equal(adapter.liveMessage({ stream: { id: 's', text: '' }, compacted: 0 }), null);
  const tail = adapter.liveMessage({ stream: { id: 's', text: '' }, turnId: TURN, compacted: 1 });
  assert.equal(tail.content, '');
  assert.equal(tail.status, 'streaming');
  assert.equal(typeof tail.context_compacted, 'object');
  assert.equal(adapter.liveMessage({ stream: { id: 's', text: 'Hi' }, compacted: 1 }).content, 'Hi');
});

// ------------------------------------------------------------------ a plan document (row 175, item 7)

test('planOf keeps a plan_document as bounded whitelisted fields only; the chain still never gets one', () => {
  const host = { id: 'plan_1', role: 'assistant', kind: 'plan_document', turn_id: 'turn_1', content: 'Title', metadata: { path: 'C:/x' }, author: { kind: 'member', member_id: 'm' },
    plan_document: { plan_id: 'p1', tool_call_id: 'call_1', approval_id: 'appr_1', title: 'T'.repeat(500), summary: 'S'.repeat(5000),
      steps: ['one', { summary: 'two', extra: 1 }, '', 7, ...Array.from({ length: 40 }, (_v, i) => 'step ' + i)], notes: 'N'.repeat(9000), verification: { summary: 'check', other: 1 },
      feedback: 'F'.repeat(2000), plan_edited: true, files_read: Array.from({ length: 40 }, (_v, i) => 'f' + i + '.js'), state: 'accepted',
      decided_by: 'member_maya', decided_at: '2026-11-12T10:31:00.000Z', metadata: { secret: 1 }, onclick: 'x()', __proto__: { polluted: true } } };
  const out = adapter.planOf(host);
  assert.deepEqual(Object.keys(out), ['id', 'turn_id', 'plan']);
  assert.deepEqual(Object.keys(out.plan).sort(), ['approval_id', 'decided_at', 'decided_by', 'feedback', 'files_read', 'notes', 'plan_edited', 'plan_id', 'state', 'steps', 'summary',
    'title', 'tool_call_id', 'verification'].sort());
  assert.deepEqual([out.plan.title.length, out.plan.summary.length, out.plan.notes.length, out.plan.feedback.length, out.plan.steps.length, out.plan.files_read.length], [120, 1200, 4000, 800, 20, 20]);
  assert.deepEqual([out.plan.steps[0], out.plan.steps[1], out.plan.verification, out.plan.state, out.plan.plan_edited], ['one', 'two', 'check', 'accepted', true]);
  assert.equal(out.plan === host.plan_document, false, 'a copy');
  assert.deepEqual(adapter.toLocalMessages([host]), [], 'the chain (the popover) never draws the local plan document');
  for (const other of [null, 'x', { id: 'a', role: 'assistant', kind: 'message' }, { id: 'a', kind: 'plan_document' }, { id: 'a', kind: 'plan_document', plan_document: [] }]) assert.equal(adapter.planOf(other), null);
});

test('planOf: invisible and directional characters are removed, newlines in notes stay, an unknown state is pending', () => {
  const [bidi, zero] = ['\u202e', '\u200b'];
  const out = adapter.planOf({ id: 'p', kind: 'plan_document', plan_document: { title: 'a' + bidi + 'b' + zero, notes: 'line one\nline two' + bidi, steps: ['x' + zero + 'y'], state: 'bogus' } });
  assert.deepEqual([out.plan.title, out.plan.notes, out.plan.steps, out.plan.state], ['ab', 'line one\nline two', ['xy'], 'pending']);
  assert.equal(adapter.planOf({ id: 'p', kind: 'plan_document', plan_document: { transition: 'approved', state: 'pending' } }).plan.state, 'approved', 'the transition wins, as the local document reads it');
});
