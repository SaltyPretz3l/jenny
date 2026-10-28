'use strict';

// Jenny CLI S3: the cli.v1 projection is the public agent contract. Each desktop chat-stream event
// maps to at most one closed, bounded cli.v1 event; host frames go through the same validator; a
// run ends with exactly one result. The golden fixture pairs every input with its expected frame.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  CLI_EVENT_KINDS, CLI_LIMITS, EXIT_CODES, createEventProjector, validateCliEvent,
} = require('../../services/cli-host/event-projection');
const { createResultAggregator } = require('../../services/cli-host/result-aggregator');

const FIXTURE = path.join(__dirname, 'fixtures', 'cli-v1-golden.ndjson');
const BASE = { sessionId: 'sess_1', streamId: 'stream_a', turnId: 'turn_a' };

function projector(options = {}) {
  return createEventProjector({ run_id: 'run_1', session_id: 'sess_1', request_id: 'req_1', ...options });
}

function started(p) {
  return p.project({ type: 'started', ...BASE });
}

function assertValid(event) {
  const verdict = validateCliEvent(event);
  assert.deepEqual(verdict, { ok: true }, JSON.stringify(event).slice(0, 400));
}

function runGolden() {
  const lines = fs.readFileSync(FIXTURE, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  const p = projector();
  const aggregator = createResultAggregator({ run_id: 'run_1', session_id: 'sess_1', started_at_ms: 1700000000000 });
  const emitted = [];
  const rows = lines.map((line) => {
    let out = null;
    if (line.desktop) out = p.project(line.desktop);
    else if (line.host) out = p.next(line.host.kind, line.host.payload, line.host.identities);
    else if (line.finish) out = p.next('result', aggregator.finish(line.finish));
    if (out) {
      aggregator.observe(out);
      emitted.push(out);
    }
    return { line, out };
  });
  return { rows, emitted };
}

test('golden run: every desktop event projects to its expected cli.v1 frame', () => {
  const { rows, emitted } = runGolden();
  for (const [index, { line, out }] of rows.entries()) {
    assert.ok(Object.hasOwn(line, 'out'), `fixture line ${index + 1} carries an expected frame`);
    assert.deepEqual(out, line.out, `fixture line ${index + 1}`);
  }
  for (const event of emitted) assertValid(event);
  assert.deepEqual(emitted.map((event) => event.event_seq), emitted.map((_event, index) => index));
  assert.equal(emitted.filter((event) => event.kind === 'result').length, 1);
  assert.equal(emitted.at(-1).kind, 'result');
});

test('golden run: the result carries the surviving text and the run totals', () => {
  const result = runGolden().emitted.at(-1).payload;
  assert.equal(result.result, 'Let me look. \n\nFinal answer.');
  assert.equal(result.subtype, 'success');
  assert.equal(result.exit_code, EXIT_CODES.OK);
  assert.equal(result.num_turns, 1);
  assert.equal(result.duration_ms, 4321);
  assert.deepEqual(result.usage, { input_tokens: 120, output_tokens: 30, total_tokens: 150, estimated: false });
});

test('the schema covers exactly the contract kinds', () => {
  assert.deepEqual([...CLI_EVENT_KINDS].sort(), [
    'accepted', 'complete', 'decision', 'delta', 'error', 'init', 'plan_proposal_withdrawn', 'plan_proposed',
    'reset', 'result', 'started', 'status', 'thinking', 'tool_approval_needed', 'tool_approval_withdrawn',
    'tool_output', 'tool_result', 'tool_use', 'user_questions_requested', 'user_questions_withdrawn',
  ]);
});

test('reset mirrors each desktop discard scope, including the legacy fallbacks', () => {
  const p = projector();
  started(p);
  const reset = (fields) => p.project({ type: 'stream_reset', ...BASE, ...fields }).payload;
  assert.deepEqual(reset({ discard_scope: 'all', preserve_prior_segments: false, reason: 'provider_retry' }),
    { discard_scope: 'all', preserve_prior_segments: false, reason: 'provider_retry' });
  assert.deepEqual(reset({ discard_scope: 'live_slice', preserve_prior_segments: true, reason: 'model_winddown' }),
    { discard_scope: 'live_slice', preserve_prior_segments: true, reason: 'model_winddown' });
  assert.deepEqual(reset({ discard_scope: 'none', preserve_prior_segments: true, next_assistant_message_id: 'assistant_stream_a_seg2' }),
    { discard_scope: 'none', preserve_prior_segments: true, next_assistant_message_id: 'assistant_stream_a_seg2' });
  assert.equal(reset({ preserve_prior_segments: true, reason: 'model_winddown' }).discard_scope, 'live_slice');
  assert.equal(reset({ preserve_prior_segments: true, reason: 'tool_continuation' }).discard_scope, 'none');
  assert.equal(reset({ preserve_prior_segments: false }).discard_scope, 'all');
  assert.equal(reset({ reason: 'tool_continuation' }).discard_scope, 'none');
  assert.equal(reset({ reason: 'nudge_retry' }).discard_scope, 'all');
  assert.equal(reset({ discard_scope: 'bogus' }).discard_scope, 'all');
});

test('the aggregator drops text per discard scope', () => {
  const run = (scope) => {
    const p = projector();
    const aggregator = createResultAggregator({ run_id: 'run_1', session_id: 'sess_1', started_at_ms: 0 });
    const feed = (event) => { const out = p.project(event); if (out) aggregator.observe(out); };
    feed({ type: 'started', ...BASE });
    feed({ type: 'delta', ...BASE, content: 'segment one' });
    feed({ type: 'tool_use', ...BASE, callId: 'c1', toolName: 'read_file', summary: 'Read' });
    feed({ type: 'delta', ...BASE, content: 'live slice' });
    feed({ type: 'stream_reset', ...BASE, discard_scope: scope, preserve_prior_segments: scope !== 'all' });
    feed({ type: 'delta', ...BASE, content: 'after' });
    return aggregator.finish({ reason: 'complete', now_ms: 5 }).result;
  };
  assert.equal(run('all'), 'after');
  assert.equal(run('live_slice'), 'segment one\n\nafter');
  assert.equal(run('none'), 'segment one\n\nlive slice\n\nafter');
});

test('events from another session, another stream, or a closed stream are dropped', () => {
  const p = projector();
  assert.equal(p.project({ type: 'delta', ...BASE, content: 'before start' }), null);
  assert.ok(started(p));
  assert.equal(p.project({ type: 'delta', ...BASE, sessionId: 'sess_2', content: 'x' }), null);
  assert.equal(p.project({ type: 'delta', ...BASE, streamId: 'stream_z', content: 'x' }), null);
  assert.equal(p.project({ type: 'delta', ...BASE, streamId: undefined, content: 'x' }), null);
  assert.equal(p.project({ type: 'delta', ...BASE, runtimeAdmission: {
    work_id: 'w', turn_id: 'turn_a', session_id: 'sess_2', stream_id: 'stream_a', user_message_id: 'u', idempotency_key: 'k',
  }, content: 'x' }), null);
  assert.ok(p.project({ type: 'complete', ...BASE }));
  assert.equal(p.project({ type: 'delta', ...BASE, content: 'late' }), null);
  assert.equal(p.project({ type: 'started', ...BASE }), null, 'a closed stream never restarts');
  assert.equal(p.seq(), 2);
});

test('a known work id rejects another work item on the same session', () => {
  const p = projector({ work_id: 'work_1' });
  const admission = (workId) => ({ work_id: workId, turn_id: 'turn_a', session_id: 'sess_1', stream_id: 'stream_a',
    user_message_id: 'u', idempotency_key: 'k' });
  assert.equal(p.project({ type: 'started', ...BASE, runtimeAdmission: admission('work_2') }), null);
  const event = p.project({ type: 'started', ...BASE, runtimeAdmission: admission('work_1') });
  assert.equal(event.work_id, 'work_1');
  assert.equal(event.request_id, 'req_1');
  assert.equal(event.turn_id, 'turn_a');
});

test('a pre-start error for this session is still reported', () => {
  const p = projector();
  const event = p.project({ type: 'error', ...BASE, message: 'a turn is already running', error_code: 'session_busy',
    category: 'session_busy', retryable: true });
  assert.equal(event.kind, 'error');
  assert.match(event.payload.code, /^CMP-/u);
  assert.equal(event.payload.retryable, true);
  assertValid(event);
});

test('unbounded text is clipped at the schema limit and still validates', () => {
  const p = projector({ options: { thinking: true, tool_output: true } });
  started(p);
  const huge = 'x'.repeat(CLI_LIMITS.result_text + 10);
  const delta = p.project({ type: 'delta', ...BASE, content: huge });
  assert.equal(delta.payload.text.length, CLI_LIMITS.delta_text);
  assert.equal(delta.payload.truncated, true);
  const pair = `${'y'.repeat(CLI_LIMITS.delta_text - 1)}\u{1F600}`;
  const surrogate = p.project({ type: 'delta', ...BASE, content: pair });
  assert.equal(surrogate.payload.text.length, CLI_LIMITS.delta_text - 1, 'never splits a surrogate pair');
  const result = p.project({ type: 'tool_result', ...BASE, callId: 'c1', toolName: 'read_file', content: huge });
  assert.equal(result.payload.text.length, CLI_LIMITS.tool_result_text);
  const thinking = p.project({ type: 'delta', ...BASE, content: '', reasoning: { entriesDelta: [{ id: 'r', text: huge }] } });
  assert.equal(thinking.payload.text.length, CLI_LIMITS.thinking_text);
  const output = p.project({ type: 'tool_output_chunk', ...BASE, callId: 'c1', toolName: 'run_command',
    lines: Array.from({ length: 80 }, () => ({ stream: 'stderr', text: huge })), partial: huge });
  assert.equal(output.payload.lines.length, 50);
  assert.equal(output.payload.lines[0].text.length, CLI_LIMITS.output_line_text);
  const error = p.project({ type: 'error', ...BASE, message: huge, error_code: 'CMP-AI-0002' });
  assert.equal(error.payload.message.length, CLI_LIMITS.message_text);
  for (const event of [delta, surrogate, result, thinking, output, error]) assertValid(event);
  const aggregator = createResultAggregator({ run_id: 'run_1', session_id: 'sess_1', started_at_ms: 0 });
  for (let index = 0; index < 6; index += 1) aggregator.observe(delta);
  const final = p.next('result', aggregator.finish({ reason: 'complete', now_ms: 1 }));
  assert.equal(final.payload.result.length, CLI_LIMITS.result_text);
  assert.equal(final.payload.truncated, true);
  assertValid(final);
});

test('over-long refs drop the event instead of clipping an identity', () => {
  const p = projector();
  started(p);
  assert.equal(p.project({ type: 'tool_approval_needed', ...BASE, callId: 'c1', toolName: 'run_command',
    approvalId: 'a'.repeat(600) }), null);
});

test('thinking and tool_output are absent unless opted in', () => {
  const reasoning = { type: 'delta', ...BASE, content: '', reasoning: { entriesDelta: [{ id: 'r1', append: 'hmm' }] } };
  const chunk = { type: 'tool_output_chunk', ...BASE, callId: 'c1', toolName: 'run_command',
    lines: [{ stream: 'stdout', text: 'ok' }], partial: '', sequence: 1 };
  const off = projector();
  started(off);
  assert.equal(off.project(reasoning), null);
  assert.equal(off.project(chunk), null);
  const on = projector({ options: { thinking: true, tool_output: true } });
  started(on);
  assert.deepEqual(on.project(reasoning).payload, { thinking_id: 'r1', text: 'hmm' });
  assert.deepEqual(on.project(chunk).payload, { call_id: 'c1', tool_name: 'run_command',
    lines: [{ stream: 'stdout', text: 'ok' }], partial: '', sequence: 1 });
});

test('no secret-looking or arbitrary fields are copied from tool events', () => {
  const p = projector();
  started(p);
  const secrets = { input: { api_key: 'sk-live-1', command: 'curl -H "Authorization: Bearer t"' }, password: 'hunter2',
    token: 'tok', authorization: 'Bearer t', externalPayloads: { secret: 's' }, metadata: { api_key: 'k' }, apiKey: 'k' };
  const events = [
    p.project({ type: 'tool_use', ...BASE, callId: 'c1', toolName: 'run_command', summary: 'Run curl', status: 'running', ...secrets }),
    p.project({ type: 'tool_approval_needed', ...BASE, callId: 'c1', approvalId: 'ap_1', toolName: 'run_command', summary: 'Run curl', ...secrets }),
    p.project({ type: 'tool_result', ...BASE, callId: 'c1', toolName: 'run_command', content: 'done', isError: false, ...secrets }),
  ];
  assert.deepEqual(events[0].payload, { call_id: 'c1', tool_name: 'run_command', summary: 'Run curl', status: 'running' });
  assert.deepEqual(events[1].payload, { ref: 'ap_1', call_id: 'c1', tool_name: 'run_command', summary: 'Run curl' });
  assert.deepEqual(events[2].payload, { call_id: 'c1', tool_name: 'run_command', status: 'ok', text: 'done' });
  for (const event of events) {
    const wire = JSON.stringify(event);
    for (const needle of ['sk-live-1', 'hunter2', 'Bearer', 'api_key', 'apiKey', 'secret', 'tok"']) {
      assert.equal(wire.includes(needle), false, `${needle} leaked in ${event.kind}`);
    }
    assertValid(event);
  }
});

test('plan approvals project as plan_proposed and their withdrawal as plan_proposal_withdrawn', () => {
  const p = projector();
  started(p);
  const plan = p.project({ type: 'tool_approval_needed', ...BASE, callId: 'c_plan', approvalId: 'ap_plan',
    toolName: 'exit_plan_mode', summary: 'Review plan: Ship', planDocument: { plan_id: 'plan_abc', tool_call_id: 'c_plan',
      approval_id: 'ap_plan', state: 'pending', title: 'Ship', summary: 'Do it', steps: ['one', 'two'], notes: 'n',
      files_read: ['a.js'] } });
  assert.equal(plan.kind, 'plan_proposed');
  assert.deepEqual(plan.payload, { ref: 'ap_plan', plan_id: 'plan_abc', call_id: 'c_plan', title: 'Ship',
    summary: 'Do it', steps: ['one', 'two'] });
  const withdrawn = p.project({ type: 'tool_approval_withdrawn', ...BASE, callId: 'c_plan', approvalId: 'ap_plan',
    toolName: 'exit_plan_mode', reason: 'runtime_pause' });
  assert.equal(withdrawn.kind, 'plan_proposal_withdrawn');
  const toolWithdrawn = p.project({ type: 'tool_approval_withdrawn', ...BASE, callId: 'c2', approvalId: 'ap_2',
    toolName: 'run_command', reason: 'runtime_pause' });
  assert.deepEqual(toolWithdrawn.payload, { ref: 'ap_2', call_id: 'c2', reason: 'runtime_pause' });
  for (const event of [plan, withdrawn, toolWithdrawn]) assertValid(event);
});

test('ask_user questions and terminal question batches both project as user_questions_requested', () => {
  const p = projector();
  started(p);
  const asked = p.project({ type: 'user_questions_requested', ...BASE, callId: 'c_q', questionRef: 'question_ref_1',
    questionId: 'qid', toolName: 'ask_user', questions: [{ id: 'q1', prompt: 'Which?', options: ['A', 'B'], multi_select: true }],
    input: { questions: [] } });
  assert.deepEqual(asked.payload, { ref: 'question_ref_1', call_id: 'c_q', terminal: false,
    questions: [{ id: 'q1', prompt: 'Which?', options: ['A', 'B'], multi_select: true, allow_other: false }] });
  const batch = p.project({ type: 'question_batch', ...BASE, batch: { batch_id: 'batch_1', questions: [
    { id: 'q1', prompt: 'Pick one', options: [{ id: 'o1', label: 'Yes' }, { id: 'o2', label: 'No' }] }] } });
  assert.equal(batch.kind, 'user_questions_requested');
  assert.equal(batch.payload.terminal, true);
  assert.deepEqual(batch.payload.questions[0].options, ['Yes', 'No']);
  const withdrawn = p.project({ type: 'user_questions_withdrawn', ...BASE, callId: 'c_q', questionRef: 'question_ref_1',
    reason: 'runtime_pause' });
  assert.equal(withdrawn.kind, 'user_questions_withdrawn');
  assert.equal(p.project({ type: 'question_batch', ...BASE, batch: { questions: [] } }), null);
  for (const event of [asked, batch, withdrawn]) assertValid(event);
});

test('next validates host frames, threads the work id, and allows exactly one result', () => {
  const p = projector();
  assert.throws(() => p.next('delta', { text: 'x', extra: true }), /cli\.v1/u);
  assert.throws(() => p.next('decision', { ref: 'a', request: 'tool_approval', outcome: 'allow', by: 'robot' }), /cli\.v1/u);
  assert.throws(() => p.next('status', { phase: 'work' }, { bogus: 'x' }), /identity/u);
  assert.equal(p.seq(), 0, 'a rejected frame never consumes a sequence number');
  const accepted = p.next('accepted', { user_message_id: 'u1', idempotency_key: 'k1', retry_point: { revision: 0, status: 'pending' } },
    { work_id: 'work_9' });
  assert.equal(accepted.event_seq, 0);
  assert.equal(p.next('status', { phase: 'work', work_status: 'running' }).work_id, 'work_9');
  const aggregator = createResultAggregator({ run_id: 'run_1', session_id: 'sess_1', started_at_ms: 0 });
  const result = p.next('result', aggregator.finish({ reason: 'complete', now_ms: 0 }));
  assertValid(result);
  assert.throws(() => p.next('result', result.payload), /result/u);
  assert.equal(p.project({ type: 'started', ...BASE }), null);
});

test('validateCliEvent rejects open objects, unknown kinds and unbounded strings', () => {
  const base = { v: 1, kind: 'delta', event_seq: 0, run_id: 'r', session_id: 's', payload: { text: 'hi' } };
  assert.deepEqual(validateCliEvent(base), { ok: true });
  assert.equal(validateCliEvent({ ...base, extra: 1 }).ok, false);
  assert.equal(validateCliEvent({ ...base, kind: 'nope' }).ok, false);
  assert.equal(validateCliEvent({ ...base, payload: { text: 'x'.repeat(CLI_LIMITS.delta_text + 1) } }).ok, false);
  const verdict = validateCliEvent({ ...base, v: 2, payload: { text: 1 } });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.length >= 2, 'allErrors reports every violation');
});

test('the exit-code table is frozen', () => {
  assert.deepEqual({ ...EXIT_CODES }, {
    OK: 0, RUNTIME_ERROR: 1, USAGE: 2, POLICY_DENIED: 3, DECISION_REQUIRED: 4, BUDGET: 5,
    ENGINE_UNAVAILABLE: 6, PROFILE_BUSY: 75, SIGINT: 130, SIGTERM: 143,
  });
  assert.ok(Object.isFrozen(EXIT_CODES));
});
