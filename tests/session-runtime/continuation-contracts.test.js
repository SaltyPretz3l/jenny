'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

const {
  CONTINUATION_KIND,
  CONTINUATION_SCHEMA_VERSION,
  ContinuationContractError,
  MAX_CONTINUATION_BYTES,
  MAX_CONTINUATION_TOOL_CALLS,
  decodeContinuation,
  encodeContinuation,
  normalizeContinuation,
} = require('../../services/session-runtime/continuation-contracts');

function ref(refId, revision = 3) {
  return { ref_id: refId, revision, sha256: 'a'.repeat(64) };
}

function fixture() {
  return {
    schema_version: 1,
    kind: 'before_tool_dispatch',
    identity: {
      checkpoint_id: 'checkpoint_1',
      work_id: 'work_1',
      turn_id: 'turn_1',
      request_id: 'stream_1',
      trace_id: null,
      session_id: 'session_1',
    },
    source_attempt: {
      attempt_id: 'attempt_1',
      stream_id: 'stream_1',
      incarnation: 'incarnation_1',
      authority_revision: 'authority_1',
    },
    authority: {
      project_id: 'project_1',
      root_id: 'root_1',
      root_revision: 4,
      sha256: 'b'.repeat(64),
    },
    route: {
      route_id: 'route_1',
      route_revision: 'config:4',
      sha256: 'c'.repeat(64),
    },
    canonical_refs: {
      request_ref: ref('request_ref_1'),
      history_ref: ref('history_ref_1'),
      message_ref: ref('message_ref_1'),
      turn_ref: {
        ...ref('turn_ref_1', 8),
        stream_id: 'stream_1',
        through_seq: 12,
      },
      tool_batch_ref: ref('tool_batch_ref_1'),
    },
    position: {
      completed_iterations: 1,
      remaining_iterations: 7,
      current_iteration: 1,
      tool_call_limit: 20,
      tool_calls_consumed: 2,
      active_budget_ms_remaining: 123_456,
      ordered_call_ids: ['call_1', 'call_2'],
    },
    pending_call: {
      call_id: 'call_1',
      tool_id: 'builtin:run/tool',
      effective_args_sha256: 'd'.repeat(64),
      frozen_input_ref: ref('frozen_input_ref_1'),
    },
    wait: {
      kind: 'resource',
      resource_class: 'native_processes',
      dependency_id: null,
      operation_id: 'call_1',
    },
    eligibility: {
      pending_call_index: 0,
      prior_outcome_count: 0,
      emitted_tool_execution_count: 0,
      preview_count: 0,
      approval_pending: false,
      mutation_started: false,
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertCode(operation, code) {
  assert.throws(operation, error => (
    error instanceof ContinuationContractError && error.code === code
  ));
}

test('normalization is fresh and encoding is canonical and deterministic', () => {
  const source = fixture();
  const reversed = Object.fromEntries(Object.entries(source).reverse());
  const normalized = normalizeContinuation(source);
  const first = encodeContinuation(source);
  const second = encodeContinuation(reversed);

  assert.deepEqual(normalized, source);
  assert.notEqual(normalized, source);
  assert.notEqual(normalized.identity, source.identity);
  assert.deepEqual(first, second);
  assert.equal(first.sha256, createHash('sha256').update(first.body).digest('hex'));
  assert.ok(first.body.length <= MAX_CONTINUATION_BYTES);
  assert.deepEqual(decodeContinuation(first.body), source);
  assert.equal(normalized.route.route_revision, 'config:4');
  assert.equal(normalized.wait.dependency_id, null);
});

for (const kind of ['resource', 'resource_progress', 'explicit_pause', 'dependency', 'repeated_dependency', 'approval', 'user_questions', 'repeated_decision', 'unexecuted_failure', 'approval_bundle', 'mixed_dependency']) for (const withQuota of [false, true]) test(`${kind} (quota=${withQuota}) canonical bytes round-trip through the Python continuation codec`, () => {
  const python = path.join(process.cwd(), '.venv', process.platform === 'win32'
    ? path.join('Scripts', 'python.exe') : path.join('bin', 'python'));
  const probe = [
    'import base64, json, sys',
    'from sidecar.runtime.continuation_codec import decode_continuation_checkpoint, encode_continuation_checkpoint',
    'body = base64.b64decode(sys.stdin.buffer.read(), validate=True)',
    'encoded = encode_continuation_checkpoint(decode_continuation_checkpoint(body))',
    "sys.stdout.write(json.dumps({'body': base64.b64encode(encoded.body).decode('ascii'), 'sha256': encoded.sha256}, sort_keys=True, separators=(',', ':')))",
  ].join('\n');
  const value = ['approval', 'user_questions', 'repeated_decision', 'unexecuted_failure', 'approval_bundle'].includes(kind) ? decisionFixture(kind)
    : kind === 'mixed_dependency' ? mixedDependencyFixture() : kind === 'repeated_dependency' ? repeatedDependencyFixture() : kind === 'dependency' ? dependencyFixture() : fixture();
  if (kind === 'resource_progress') {
    Object.assign(value, { schema_version: 8, completed_effect_refs: [{ call_id: 'completed_1',
      tool_id: 'read_file', success: true, result_sha256: 'a'.repeat(64) }], prior_checkpoint_ref: null, prior_effect_count: 0 });
    Object.assign(value.position, { current_iteration: 2, completed_iterations: 2, tool_calls_consumed: 3 });
    Object.assign(value.eligibility, { prior_outcome_count: 1, emitted_tool_execution_count: 1 });
  }
  if (kind === 'approval_bundle') {
    value.schema_version = 4;
    value.approval_inputs_ref = ref('approval_inputs_1');
  }
  if (kind === 'explicit_pause') value.wait = { ...value.wait, kind, resource_class: null };
  if (withQuota) Object.assign(value, { base_schema_version: value.schema_version, schema_version: 7,
    quota_state: require('../helpers/quota-state-fixture').quotaState() });
  const encoded = encodeContinuation(value);
  const result = spawnSync(python, ['-c', probe], {
    cwd: process.cwd(),
    input: Buffer.from(encoded.body.toString('base64'), 'ascii'),
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const pythonResult = JSON.parse(result.stdout);
  assert.equal(pythonResult.body, encoded.body.toString('base64'));
  assert.equal(pythonResult.sha256, encoded.sha256);
});

test('opaque canonical references are shape-checked without claiming persistence', () => {
  const value = fixture();
  value.canonical_refs.request_ref = ref('opaque_unresolved_ref', 999);

  assert.equal(
    normalizeContinuation(value).canonical_refs.request_ref.ref_id,
    'opaque_unresolved_ref',
  );
});

test('future versions, unsupported kinds, extras, and missing keys fail closed', () => {
  const future = fixture();
  future.schema_version = 2;
  assertCode(() => normalizeContinuation(future), 'unsupported_continuation_schema_version');

  const wrongKind = fixture();
  wrongKind.kind = 'after_tool_dispatch';
  assertCode(() => normalizeContinuation(wrongKind), 'unsupported_continuation_kind');

  for (const key of ['preview_bytes', 'credentials', 'cancel_handle', 'provider_cache',
    'wall_clock_deadline']) {
    const extra = fixture();
    extra[key] = 'forbidden';
    assertCode(() => normalizeContinuation(extra), 'invalid_continuation_keys');
  }
  const missing = fixture();
  delete missing.canonical_refs.message_ref;
  assertCode(() => normalizeContinuation(missing), 'invalid_canonical_refs_keys');
});

test('identity, attempt, stream, call, and digest fences are exact', () => {
  const cases = [
    [value => { value.identity.request_id = 'other_stream'; }, 'request_stream_identity_mismatch'],
    [value => { value.canonical_refs.turn_ref.stream_id = 'other_stream'; },
      'turn_ref_stream_mismatch'],
    [value => { value.wait.operation_id = 'call_2'; }, 'operation_call_identity_mismatch'],
    [value => { value.pending_call.call_id = 'call_2'; },
      'unsupported_later_call_continuation'],
    [value => { value.identity.work_id = 'bad:id'; }, 'invalid_identity_work_id'],
    [value => { value.authority.sha256 = 'A'.repeat(64); }, 'invalid_authority_sha256'],
    [value => { value.route.route_revision = 'bad revision'; }, 'invalid_route_revision'],
  ];
  for (const [mutate, code] of cases) {
    const value = fixture();
    mutate(value);
    assertCode(() => normalizeContinuation(value), code);
  }
});

test('position counters encode the actual pre-dispatch whole-batch reservation', () => {
  const consumedMismatch = fixture();
  consumedMismatch.position.tool_calls_consumed = 1;
  assertCode(() => normalizeContinuation(consumedMismatch), 'invalid_ordered_call_ids');

  const iterationMismatch = fixture();
  iterationMismatch.position.current_iteration = 2;
  assertCode(() => normalizeContinuation(iterationMismatch), 'invalid_iteration_position');

  const floatingBudget = fixture();
  floatingBudget.position.active_budget_ms_remaining = 1.5;
  assertCode(() => normalizeContinuation(floatingBudget), 'invalid_active_budget_ms_remaining');

  const maximum = fixture();
  maximum.position.tool_call_limit = MAX_CONTINUATION_TOOL_CALLS;
  maximum.position.tool_calls_consumed = MAX_CONTINUATION_TOOL_CALLS;
  maximum.position.ordered_call_ids = Array.from(
    { length: MAX_CONTINUATION_TOOL_CALLS }, (_, index) => `call_${index}`,
  );
  maximum.pending_call.call_id = maximum.position.ordered_call_ids[0];
  maximum.wait.operation_id = maximum.pending_call.call_id;
  assert.equal(normalizeContinuation(maximum).position.ordered_call_ids.length, 256);
});

test('later-call, outcome, execution, preview, approval and mutation state is refused', () => {
  const cases = [
    ['pending_call_index', 1],
    ['prior_outcome_count', 1],
    ['emitted_tool_execution_count', 1],
    ['preview_count', 1],
    ['approval_pending', true],
    ['mutation_started', true],
    ['prior_outcome_count', false],
    ['approval_pending', 0],
  ];
  for (const [field, unsupported] of cases) {
    const value = fixture();
    value.eligibility[field] = unsupported;
    assertCode(() => normalizeContinuation(value), 'unsupported_continuation_state');
  }
});

test('plain data records reject prototype, accessor, symbol and hidden-field pitfalls', () => {
  const inherited = Object.create({ credentials: 'hidden' });
  Object.assign(inherited, fixture());
  assertCode(() => normalizeContinuation(inherited), 'invalid_continuation');

  const accessor = fixture();
  let getterCalled = false;
  Object.defineProperty(accessor, 'kind', {
    enumerable: true,
    get() { getterCalled = true; return CONTINUATION_KIND; },
  });
  assertCode(() => normalizeContinuation(accessor), 'invalid_continuation_keys');
  assert.equal(getterCalled, false);

  const symbol = fixture();
  symbol[Symbol('credential')] = 'hidden';
  assertCode(() => normalizeContinuation(symbol), 'invalid_continuation_keys');

  const hidden = fixture();
  Object.defineProperty(hidden, 'credential', { value: 'hidden', enumerable: false });
  assertCode(() => normalizeContinuation(hidden), 'invalid_continuation_keys');

  const nullPrototype = Object.assign(Object.create(null), fixture());
  assert.deepEqual(normalizeContinuation(nullPrototype), fixture());
});

test('decode rejects duplicate, noncanonical and invalid UTF-8 bodies', () => {
  const body = encodeContinuation(fixture()).body;
  const duplicate = Buffer.from(body.toString('utf8').replace(
    '"kind":"before_tool_dispatch",',
    '"kind":"before_tool_dispatch","kind":"before_tool_dispatch",',
  ), 'utf8');
  assertCode(() => decodeContinuation(duplicate), 'noncanonical_continuation_body');

  const spaced = Buffer.from(JSON.stringify(JSON.parse(body.toString('utf8')), null, 2), 'utf8');
  assertCode(() => decodeContinuation(spaced), 'noncanonical_continuation_body');
  assertCode(
    () => decodeContinuation(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d])),
    'invalid_continuation_json',
  );
});

test('decode requires a bounded Buffer', () => {
  for (const body of [null, '', new Uint8Array([0x7b, 0x7d]), Buffer.alloc(0), Buffer.from('{')]) {
    assertCode(() => decodeContinuation(body), 'continuation_body_capacity');
  }
  assertCode(
    () => decodeContinuation(Buffer.alloc(MAX_CONTINUATION_BYTES + 1, 0x78)),
    'continuation_body_capacity',
  );
});

test('normalization does not mutate input and constants match the Python contract', () => {
  const value = fixture();
  const before = clone(value);

  normalizeContinuation(value);

  assert.deepEqual(value, before);
  assert.equal(CONTINUATION_SCHEMA_VERSION, 1);
  assert.equal(CONTINUATION_KIND, 'before_tool_dispatch');
});


test('explicit pause cannot encode a fabricated resource dependency', () => {
  for (const extra of [{ resource_class: 'filesystem' }, { dependency_id: 'fake_wait' }]) {
    const value = fixture();
    value.wait = { ...value.wait, kind: 'explicit_pause', resource_class: null, ...extra };
    assertCode(() => normalizeContinuation(value), 'unsupported_continuation_wait');
  }
});


function dependencyFixture() {
  const value = fixture();
  value.kind = 'before_dependency_wait';
  value.completed_spawn_refs = [{ call_id: 'spawn_1', child_work_id: 'child_work_1', result_sha256: 'e'.repeat(64) }];
  Object.assign(value.position, { current_iteration: 2, completed_iterations: 2, remaining_iterations: 6,
    ordered_call_ids: ['call_1'], tool_calls_consumed: 2 });
  value.pending_call.tool_id = 'session_wait';
  Object.assign(value.wait, { kind: 'dependency', resource_class: null, dependency_id: 'child_work_1' });
  Object.assign(value.eligibility, { prior_outcome_count: 1, emitted_tool_execution_count: 1 });
  return value;
}

test('dependency variant accounts for completed spawns without reopening first-tool eligibility', () => {
  const dependency = dependencyFixture();
  assert.deepEqual(decodeContinuation(encodeContinuation(dependency).body), dependency);
  const legacy = fixture();
  legacy.eligibility.prior_outcome_count = 1;
  assertCode(() => encodeContinuation(legacy), 'unsupported_continuation_state');
  legacy.eligibility.prior_outcome_count = 0;
  legacy.completed_spawn_refs = dependency.completed_spawn_refs;
  assertCode(() => encodeContinuation(legacy), 'invalid_continuation_keys');
});

for (const [name, mutate] of [
  ['foreign dependency', value => { value.wait.dependency_id = 'foreign'; }],
  ['self dependency', value => { value.completed_spawn_refs[0].child_work_id = 'work_1'; }],
  ['non-wait tool', value => { value.pending_call.tool_id = 'run_command'; }],
  ['resource wait', value => { value.wait.kind = 'resource'; }],
  ['resource claim', value => { value.wait.resource_class = 'tool_operations'; }],
  ['wrong operation', value => { value.wait.operation_id = 'other'; }],
  ['missing spawn', value => { value.completed_spawn_refs = []; }],
  ['duplicate spawn', value => { value.completed_spawn_refs.push(value.completed_spawn_refs[0]); }],
  ['pending spawn replay', value => { value.completed_spawn_refs[0].call_id = 'call_1'; }],
  ['changed result hash', value => { value.completed_spawn_refs[0].result_sha256 = 'bad'; }],
  ['extra authority', value => { value.completed_spawn_refs[0].authority = {}; }],
  ['count reset', value => { value.position.tool_calls_consumed = 1; }],
  ['prior outcome reset', value => { value.eligibility.prior_outcome_count = 0; }],
  ['execution reset', value => { value.eligibility.emitted_tool_execution_count = 0; }],
  ['preview', value => { value.eligibility.preview_count = 1; }],
  ['approval', value => { value.eligibility.approval_pending = true; }],
  ['mutation', value => { value.eligibility.mutation_started = true; }],
  ['first iteration', value => { value.position.completed_iterations = 1; value.position.current_iteration = 1; }],
  ['multiple pending calls', value => { value.position.ordered_call_ids.push('call_2'); value.position.tool_calls_consumed = 3; }],
]) test(`dependency codec rejects ${name}`, () => {
  const value = dependencyFixture();
  mutate(value);
  assert.throws(() => encodeContinuation(value), ContinuationContractError);
});

test('first-tool resume refuses dependency bodies before canonical hydration', () => {
  const { hydrateRuntimeContinuation } = require('../../services/backend/runtime-continuation-resume');
  const value = dependencyFixture();
  const encoded = encodeContinuation(value);
  const work = { status: 'paused', attempt: value.source_attempt,
    checkpoint_ref: { schema_version: 1, checkpoint_id: value.identity.checkpoint_id,
      sha256: encoded.sha256, bytes: encoded.body.length, source_attempt: value.source_attempt } };
  assert.throws(() => hydrateRuntimeContinuation({ work, assertCurrent: () => true,
    checkpointStore: { read: () => value }, conversationStore: {
      resolvePendingContinuation() { assert.fail('unsupported boundary must not hydrate history'); },
    } }), { reason: 'runtime_resume_boundary_unsupported' });
});


test('sparse reference and call arrays cannot encode invalid canonical JSON', () => {
  const value = dependencyFixture();
  value.completed_spawn_refs.length = 2;
  value.position.tool_calls_consumed = 3;
  value.eligibility.prior_outcome_count = 2;
  value.eligibility.emitted_tool_execution_count = 2;
  assertCode(() => encodeContinuation(value), 'invalid_completed_spawn_ref');
  const legacy = fixture();
  delete legacy.position.ordered_call_ids[1];
  assertCode(() => encodeContinuation(legacy), 'invalid_ordered_call_id');
});


function repeatedDependencyFixture() {
  const value = dependencyFixture();
  value.schema_version = 2;
  value.completed_wait_refs = [{ call_id: 'previous_wait', child_work_id: value.wait.dependency_id, result_sha256: 'f'.repeat(64) }];
  value.prior_checkpoint_ref = { schema_version: 1, checkpoint_id: 'previous_checkpoint', sha256: 'c'.repeat(64), bytes: 1024,
    source_attempt: { ...value.source_attempt, stream_id: 'previous_stream', attempt_id: 'previous_attempt' } };
  value.prior_effect_count = 1;
  value.position.tool_calls_consumed = 3;
  value.position.current_iteration = value.position.completed_iterations = 3;
  return value;
}

for (const [name, mutate] of [
  ['missing predecessor', value => { value.prior_checkpoint_ref = null; }],
  ['same source attempt', value => { value.prior_checkpoint_ref.source_attempt = value.source_attempt; }],
  ['prior count reset', value => { value.prior_effect_count = 0; }],
  ['no fresh completed wait', value => { value.prior_effect_count = 2; }],
  ['foreign wait', value => { value.completed_wait_refs[0].child_work_id = 'foreign'; }],
  ['reused call', value => { value.completed_wait_refs[0].call_id = value.completed_spawn_refs[0].call_id; }],
  ['consumption reset', value => { value.position.tool_calls_consumed = 2; }],
]) test(`repeated dependency refuses ${name}`, () => {
  const value = repeatedDependencyFixture();
  mutate(value);
  assert.throws(() => encodeContinuation(value), ContinuationContractError);
});

test('repeated predecessor refuses accessor-backed authority without evaluating it', () => {
  const value = repeatedDependencyFixture();
  let invoked = false;
  Object.defineProperty(value.prior_checkpoint_ref.source_attempt, 'attempt_id', {
    enumerable: true, get() { invoked = true; return 'forged'; } });
  assert.throws(() => encodeContinuation(value), ContinuationContractError);
  assert.equal(invoked, false);
});


function decisionFixture(kind = 'approval') {
  const value = fixture();
  value.schema_version = 3;
  value.kind = 'before_decision_wait';
  value.decision = { kind: kind === 'user_questions' ? kind : 'approval', decision_id: 'decision_1',
    call_id: 'call_1', execution_started: kind === 'user_questions' };
  value.completed_effect_refs = [{ call_id: 'previous_read', tool_id: 'read_file',
    result_sha256: 'e'.repeat(64), success: false }];
  value.prior_checkpoint_ref = null;
  value.prior_effect_count = 0;
  Object.assign(value.position, { current_iteration: 2, completed_iterations: 2,
    remaining_iterations: 6, tool_calls_consumed: 3 });
  value.pending_call.tool_id = kind === 'user_questions' ? 'ask_user' : 'read_file';
  Object.assign(value.wait, { kind: 'explicit_pause', resource_class: null });
  Object.assign(value.eligibility, { prior_outcome_count: 1,
    emitted_tool_execution_count: kind === 'user_questions' ? 2 : 1 });
  if (kind === 'unexecuted_failure') {
    value.position.tool_calls_consumed = 2;
    value.eligibility.emitted_tool_execution_count = 0;
  }
  if (kind === 'repeated_decision') {
    value.prior_checkpoint_ref = repeatedDependencyFixture().prior_checkpoint_ref;
    value.prior_effect_count = 1;
    value.eligibility.prior_outcome_count = 0;
    value.eligibility.emitted_tool_execution_count = 0;
  }
  return value;
}

for (const [name, mutate] of [
  ['old body version', value => { value.schema_version = 1; }],
  ['future body version', value => { value.schema_version = 5; }],
  ['foreign decision call', value => { value.decision.call_id = 'foreign'; }],
  ['completed call replay', value => { value.completed_effect_refs[0].call_id = 'call_1'; }],
  ['duplicate completed call', value => { value.completed_effect_refs.push(value.completed_effect_refs[0]); }],
  ['missing result proof', value => { delete value.completed_effect_refs[0].result_sha256; }],
  ['nonboolean success', value => { value.completed_effect_refs[0].success = 1; }],
  ['pending consent', value => { value.eligibility.approval_pending = true; }],
  ['mutation in progress', value => { value.eligibility.mutation_started = true; }],
  ['unreserved pending call', value => { value.position.tool_calls_consumed = 1; }],
  ['reset outcome count', value => { value.eligibility.prior_outcome_count = 0; }],
  ['unproven earlier effects', value => { value.prior_effect_count = 1; }],
  ['resource auto-resume', value => { value.wait.kind = 'resource'; value.wait.resource_class = 'filesystem'; }],
  ['question on another tool', value => { value.decision.kind = 'user_questions'; value.decision.execution_started = true; }],
  ['unstarted question', value => { value.decision.kind = 'user_questions'; }],
  ['executing approval', value => { value.decision.execution_started = true; }],
  ['started later call', value => { value.decision.execution_started = true; value.decision.call_id = 'call_2'; }],
  ['invalid predecessor schema', value => {
    value.prior_checkpoint_ref = repeatedDependencyFixture().prior_checkpoint_ref;
    value.prior_checkpoint_ref.schema_version = 2;
  }],
]) test(`decision checkpoint codecs reject ${name}`, () => {
  const value = decisionFixture();
  mutate(value);
  assert.throws(() => encodeContinuation(value), ContinuationContractError);
  const python = path.join(process.cwd(), '.venv', process.platform === 'win32'
    ? path.join('Scripts', 'python.exe') : path.join('bin', 'python'));
  const result = spawnSync(python, ['-c', [
    'import json, sys',
    'from sidecar.runtime.continuation_codec import encode_continuation_checkpoint, ContinuationCodecError',
    'try:',
    '    encode_continuation_checkpoint(json.load(sys.stdin))',
    'except ContinuationCodecError:',
    '    sys.exit(0)',
    'sys.exit(1)',
  ].join('\n')], { input: JSON.stringify(value), encoding: 'utf8', timeout: 10_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || 'Python accepted an invalid decision checkpoint');
});

test('decision records refuse accessors without evaluating them and sparse effect lists', () => {
  for (const [owner, field] of [['eligibility', 'emitted_tool_execution_count'], ['wait', 'kind']]) {
    const value = decisionFixture('user_questions');
    let invoked = false;
    Object.defineProperty(value[owner], field, { enumerable: true, get() { invoked = true; return 2; } });
    assert.throws(() => encodeContinuation(value), ContinuationContractError);
    assert.equal(invoked, false);
  }
  const sparse = decisionFixture();
  delete sparse.completed_effect_refs[0];
  assertCode(() => encodeContinuation(sparse), 'invalid_completed_effect_ref');
});


test('decision budget preserves uncharged preflight failures independently of outcome count', () => {
  const value = decisionFixture();
  value.position.tool_calls_consumed = 2;
  assert.deepEqual(decodeContinuation(encodeContinuation(value).body), value);
});


function mixedDependencyFixture() {
  const value = repeatedDependencyFixture();
  value.schema_version = 5;
  value.completed_effect_refs = [
    ...value.completed_spawn_refs.map(ref => ({ call_id: ref.call_id, tool_id: 'session_spawn', success: true, result_sha256: 'a'.repeat(64) })),
    ...value.completed_wait_refs.map(ref => ({ call_id: ref.call_id, tool_id: 'session_wait', success: true, result_sha256: 'b'.repeat(64) })),
    { call_id: 'question_done', tool_id: 'ask_user', success: true, result_sha256: 'd'.repeat(64) },
  ];
  value.position.tool_calls_consumed++;
  value.eligibility.prior_outcome_count++;
  value.eligibility.emitted_tool_execution_count++;
  return value;
}
for (const [name, mutate] of [
  ['unreferenced child', value => { value.completed_effect_refs.shift(); }],
  ['failed child', value => { value.completed_effect_refs[0].success = false; }],
  ['wrong child tool', value => { value.completed_effect_refs[0].tool_id = 'read_file'; }],
  ['pending completed effect', value => { value.completed_effect_refs.at(-1).call_id = value.pending_call.call_id; }],
  ['wrong wait list shape', value => { value.completed_wait_refs = null; }],
  ['missing generic effects', value => { delete value.completed_effect_refs; }],
]) test(`mixed dependency codecs reject ${name}`, () => {
  const value = mixedDependencyFixture(); mutate(value);
  assert.throws(() => normalizeContinuation(value));
  const python = path.join(process.cwd(), '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const result = spawnSync(python, ['-c', [
    'import json,sys', 'from sidecar.runtime.continuation_codec import encode_continuation_checkpoint',
    'try: encode_continuation_checkpoint(json.load(sys.stdin))',
    'except (ValueError, TypeError): sys.exit(0)', 'sys.exit(1)',
  ].join('\n')], { input: JSON.stringify(value), encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
});


test('quota wrapper rejects recursive, missing, extra and conflicting base variants', () => {
  const base = fixture();
  const wrapper = { ...base, schema_version: 7, base_schema_version: 1,
    quota_state: require('../helpers/quota-state-fixture').quotaState() };
  for (const mutate of [
    value => { value.base_schema_version = 7; },
    value => { delete value.quota_state; },
    value => { value.unknown = 1; },
    value => { value.base_schema_version = 6; },
  ]) { const value = structuredClone(wrapper); mutate(value); assert.throws(() => normalizeContinuation(value)); }
});

test('encoding digest of the reference fixture is pinned', () => {
  assert.equal(encodeContinuation(fixture()).sha256, '195d417d9a99c2abf910bd6028585d415867b718e0d0069edb1317cfece94dce');
});
