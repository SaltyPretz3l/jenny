'use strict';

// new-test-file: a new surface (the S3 executor core)
// Row 200 S3: the pure core of the Strata A/B executor (scripts/eval/strata_ab/run_ab_core.js).
// Plain data in, plain data out: no engine, no app, no GPU.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const core = require('../scripts/eval/strata_ab/run_ab_core');

// Hard-coded mirror of scripts.eval.strata_ab.schedule.ARM_IDS (the cross-language test below
// compares it with the real Python tuple when the venv python is present).
const ARM_IDS = ['ninfer', 'strata_p1_off', 'strata_p1_dspark', 'strata_p2_off'];

// The first 27 lines of the real `python -m scripts.eval.strata_ab plan`: engine starts 1 and 2
// in full, plus the discarded warm-up that opens engine start 3.
const PLAN_27 = `{"arm": "ninfer", "block": 1, "discard": true, "engine_start": 1, "seq": 1, "task_id": "ab_r1_port"}
{"arm": "ninfer", "block": 1, "discard": false, "engine_start": 1, "seq": 2, "task_id": "ab_r1_port"}
{"arm": "ninfer", "block": 1, "discard": false, "engine_start": 1, "seq": 3, "task_id": "ab_r2_raiser"}
{"arm": "ninfer", "block": 1, "discard": false, "engine_start": 1, "seq": 4, "task_id": "ab_r3_deprecation"}
{"arm": "ninfer", "block": 1, "discard": false, "engine_start": 1, "seq": 5, "task_id": "ab_r4_ledger_sum"}
{"arm": "ninfer", "block": 1, "discard": false, "engine_start": 1, "seq": 6, "task_id": "ab_e1_paginate"}
{"arm": "ninfer", "block": 1, "discard": false, "engine_start": 1, "seq": 7, "task_id": "ab_e2_cli_flag"}
{"arm": "ninfer", "block": 1, "discard": false, "engine_start": 1, "seq": 8, "task_id": "ab_e3_rename"}
{"arm": "ninfer", "block": 1, "discard": false, "engine_start": 1, "seq": 9, "task_id": "ab_e4_week_parse"}
{"arm": "ninfer", "block": 1, "discard": false, "engine_start": 1, "seq": 10, "task_id": "ab_l1_64k"}
{"arm": "ninfer", "block": 1, "discard": false, "engine_start": 1, "seq": 11, "task_id": "ab_l2_100k"}
{"arm": "ninfer", "block": 1, "discard": false, "engine_start": 1, "seq": 12, "task_id": "ab_m1_inventory"}
{"arm": "ninfer", "block": 1, "discard": false, "engine_start": 1, "seq": 13, "task_id": "ab_m2_recall"}
{"arm": "strata_p1_off", "block": 1, "discard": true, "engine_start": 2, "seq": 14, "task_id": "ab_r1_port"}
{"arm": "strata_p1_off", "block": 1, "discard": false, "engine_start": 2, "seq": 15, "task_id": "ab_r1_port"}
{"arm": "strata_p1_off", "block": 1, "discard": false, "engine_start": 2, "seq": 16, "task_id": "ab_r2_raiser"}
{"arm": "strata_p1_off", "block": 1, "discard": false, "engine_start": 2, "seq": 17, "task_id": "ab_r3_deprecation"}
{"arm": "strata_p1_off", "block": 1, "discard": false, "engine_start": 2, "seq": 18, "task_id": "ab_r4_ledger_sum"}
{"arm": "strata_p1_off", "block": 1, "discard": false, "engine_start": 2, "seq": 19, "task_id": "ab_e1_paginate"}
{"arm": "strata_p1_off", "block": 1, "discard": false, "engine_start": 2, "seq": 20, "task_id": "ab_e2_cli_flag"}
{"arm": "strata_p1_off", "block": 1, "discard": false, "engine_start": 2, "seq": 21, "task_id": "ab_e3_rename"}
{"arm": "strata_p1_off", "block": 1, "discard": false, "engine_start": 2, "seq": 22, "task_id": "ab_e4_week_parse"}
{"arm": "strata_p1_off", "block": 1, "discard": false, "engine_start": 2, "seq": 23, "task_id": "ab_l1_64k"}
{"arm": "strata_p1_off", "block": 1, "discard": false, "engine_start": 2, "seq": 24, "task_id": "ab_l2_100k"}
{"arm": "strata_p1_off", "block": 1, "discard": false, "engine_start": 2, "seq": 25, "task_id": "ab_m1_inventory"}
{"arm": "strata_p1_off", "block": 1, "discard": false, "engine_start": 2, "seq": 26, "task_id": "ab_m2_recall"}
{"arm": "strata_p1_dspark", "block": 1, "discard": true, "engine_start": 3, "seq": 27, "task_id": "ab_r1_port"}`;

// Every column of recipe section 5 (docs/plans/STRATA_S3_RUN_RECIPE.md), hard-coded.
const RECIPE_COLUMNS = [
  'seq', 'block', 'engine_start', 'arm', 'task_id', 'discard', 'run_index', 'start_utc', 'end_utc',
  'outcome', 'check_reason', 'failure_class', 'ttfa_s', 'complete_s', 'prefill_tokens',
  'cached_tokens', 'prefill_ms', 'prefill_tok_s', 'decode_tokens', 'decode_tok_s', 'prompt_tokens',
  'reasoning_tokens', 'reasoning_budget', 'budget_hit', 'tool_calls', 'tool_errors', 'tool_retries',
  'no_answer_count', 'rejected_tool_calls', 'peak_vram_mib', 'peak_ram_mib', 'peak_rss_mib',
  'status', 'stop_reason', 'chat_error_code',
];

const REPO_ROOT = path.resolve(__dirname, '..');
const VENV_PYTHON = path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe');

// --- arms -----------------------------------------------------------------------------------

test('ARM_CONFIG has one frozen entry per arm id with the recipe settings', () => {
  assert.deepEqual(Object.keys(core.ARM_CONFIG), ARM_IDS);
  assert.ok(Object.isFrozen(core.ARM_CONFIG));
  assert.ok(Object.isFrozen(core.ARM_CONFIG.ninfer.seed.ninfer));
  assert.deepEqual(core.ARM_CONFIG.ninfer, {
    engine: 'ninfer',
    model: 'qwen3.8-27b-nvfp4',
    seed: { ninfer: { contextSize: 153600, mtp: true, vision: true } },
  });
  const strata = (slots, drafting) => ({
    engine: 'strata',
    model: 'inkling-2-mini-sq-20',
    seed: { strata: { slots, kv: 'k8v8', context: null, vision: true, drafting } },
  });
  assert.deepEqual(core.ARM_CONFIG.strata_p1_off, strata(1, 'off'));
  assert.deepEqual(core.ARM_CONFIG.strata_p1_dspark, strata(1, 'dspark'));
  assert.deepEqual(core.ARM_CONFIG.strata_p2_off, strata(2, 'off'));
});

// --- plan -----------------------------------------------------------------------------------

test('parsePlan reads the real plan output and names the line of a bad one', () => {
  const plan = core.parsePlan(PLAN_27);
  assert.equal(plan.length, 27);
  assert.deepEqual(plan[0], {
    seq: 1, block: 1, engine_start: 1, arm: 'ninfer', task_id: 'ab_r1_port', discard: true,
  });
  assert.equal(plan[26].arm, 'strata_p1_dspark');
  assert.equal(core.parsePlan(`${PLAN_27}\r\n\r\n`).length, 27, 'blank lines and CRLF are fine');

  assert.throws(() => core.parsePlan(`${PLAN_27}\nnot json\n`), /line 28/);
  const unknownArm = PLAN_27.split('\n');
  unknownArm[1] = unknownArm[1].replace('"ninfer"', '"mystery"');
  assert.throws(() => core.parsePlan(unknownArm.join('\n')), /line 2.*unknown arm/);
  const noTask = PLAN_27.split('\n');
  noTask[2] = noTask[2].replace('"task_id": "ab_r2_raiser"', '"task_id": ""');
  assert.throws(() => core.parsePlan(noTask.join('\n')), /line 3.*task_id/);
});

test('groupEngineStarts groups in plan order and refuses a mixed or undiscarded start', () => {
  const plan = core.parsePlan(PLAN_27);
  const groups = core.groupEngineStarts(plan);
  assert.deepEqual(groups.map((g) => [g.engineStart, g.block, g.arm, g.runs.length]), [
    [1, 1, 'ninfer', 13],
    [2, 1, 'strata_p1_off', 13],
    [3, 1, 'strata_p1_dspark', 1],
  ]);
  assert.ok(groups.every((g) => g.runs[0].discard === true));

  const mixedArm = plan.map((r) => ({ ...r }));
  mixedArm[4].arm = 'strata_p2_off';
  assert.throws(() => core.groupEngineStarts(mixedArm), /engine start 1.*arm/);
  const mixedBlock = plan.map((r) => ({ ...r }));
  mixedBlock[4].block = 2;
  assert.throws(() => core.groupEngineStarts(mixedBlock), /engine start 1.*block/);
  const noWarmup = plan.map((r) => ({ ...r }));
  noWarmup[0].discard = false;
  assert.throws(() => core.groupEngineStarts(noWarmup), /engine start 1.*warm-up/);
});

test('selectStarts filters by block, engine start and task, keeping the warm-up run', () => {
  const groups = core.groupEngineStarts(core.parsePlan(PLAN_27));
  assert.equal(core.selectStarts(groups, {}).length, 3);
  assert.equal(core.selectStarts(groups, { block: 2 }).length, 0);
  const second = core.selectStarts(groups, { engineStart: 2 });
  assert.deepEqual(second.map((g) => g.arm), ['strata_p1_off']);

  const dry = core.selectStarts(groups, { block: 1, engineStart: 2, taskIds: ['ab_r2_raiser'] });
  assert.equal(dry.length, 1);
  assert.deepEqual(dry[0].runs.map((r) => [r.task_id, r.discard]), [
    ['ab_r1_port', true],
    ['ab_r2_raiser', false],
  ]);
  assert.equal(groups[1].runs.length, 13, 'the input groups are not changed');

  const both = core.selectStarts(groups, { engineStart: 1, taskIds: ['ab_r1_port', 'ab_r2_raiser'] });
  assert.deepEqual(both[0].runs.map((r) => r.seq), [1, 2, 3], 'plan order, warm-up first');
});

// --- turn diagnostics -----------------------------------------------------------------------

// Built from the real key names: services/backend/turn-diagnostic-dump.js (written_at, stream_id,
// session_id, terminal_status, timing_markers[{name, ts_ms, relative_ms}], provider_diagnostics,
// tool_events[{call_id, name, phase, ts_ms}]) and sidecar/runtime/turn_diagnostics.py.
function diag(overrides = {}) {
  return {
    schema_version: 1,
    written_at: '2026-11-24T10:00:30.000Z',
    request_id: 'stream-1',
    stream_id: 'stream-1',
    session_id: 'sess-1',
    terminal_status: 'completed',
    timing_markers: [
      { name: 'send_initiated', ts_ms: 1000, relative_ms: 0 },
      { name: 'context_assembly_started', ts_ms: 1010, relative_ms: 10 },
      { name: 'sidecar_request_sent', ts_ms: 1500, relative_ms: 500 },
      { name: 'terminal_settled', ts_ms: 13500, relative_ms: 12500 },
    ],
    provider_diagnostics: {
      time_to_first_visible_token_ms: 2500,
      provider_prompt_tokens_evaluated: 120,
      provider_cached_tokens: 30,
      provider_prompt_eval_duration_ms: 400,
      provider_calls: [
        { ordinal: 1, purpose: 'turn', outcome: 'completed', usage: { prompt_eval_count: 900, eval_count: 50, cached_tokens: 700, prompt_tokens_evaluated: 200 } },
        { ordinal: 2, purpose: 'turn', outcome: 'completed', usage: { prompt_eval_count: 1000, eval_count: 80, cached_tokens: 880, prompt_tokens_evaluated: 120 } },
      ],
    },
    tool_events: [],
    ...overrides,
  };
}

const toolEvents = (spec) => spec.flatMap(([id, name, ...results], i) => [
  { call_id: id, name, phase: 'requested', ts_ms: 2000 + i * 100 },
  { call_id: id, name, phase: 'executing', ts_ms: 2010 + i * 100 },
  ...results.map((extra) => ({ call_id: id, name, phase: 'result', ts_ms: 2050 + i * 100, ...extra })),
]);

test('turnMetrics reads a completed turn: markers, first visible token, summed provider calls', () => {
  const m = core.turnMetrics(diag());
  assert.equal(m.terminal, 'completed');
  assert.equal(m.complete_s, 12);
  assert.equal(m.ttfa_s, 2.5);
  assert.equal(m.stream_id, 'stream-1');
  assert.equal(m.prefill_tokens, 320, 'summed over provider_calls[].usage.prompt_tokens_evaluated');
  assert.equal(m.cached_tokens, 1580);
  assert.equal(m.prompt_tokens, 1900, 'summed over provider_calls[].usage.prompt_eval_count');
  assert.equal(m.prefill_ms, null, 'turn-level durations cover only the last call of a multi-call turn');
  assert.deepEqual([m.tool_calls, m.tool_errors, m.tool_retries], [0, 0, 0]);
});

test('turnMetrics falls back to the turn-level provider fields without a call ledger', () => {
  const d = diag();
  delete d.provider_diagnostics.provider_calls;
  const m = core.turnMetrics(d);
  assert.deepEqual([m.prefill_tokens, m.cached_tokens, m.prefill_ms], [120, 30, 400]);
  d.provider_diagnostics.provider_calls = [{ ordinal: 1, usage: null }];
  assert.deepEqual([core.turnMetrics(d).prefill_tokens, core.turnMetrics(d).prefill_ms], [120, 400]);
});

test('turnMetrics on an error turn with missing markers and no provider data gives nulls', () => {
  const m = core.turnMetrics(diag({
    terminal_status: 'error',
    timing_markers: [{ name: 'sidecar_request_sent', ts_ms: 1500, relative_ms: 0 }],
    provider_diagnostics: null,
  }));
  assert.equal(m.terminal, 'error');
  assert.equal(m.complete_s, null);
  assert.deepEqual([m.ttfa_s, m.prefill_tokens, m.cached_tokens, m.prefill_ms], [null, null, null, null]);
  const bare = core.turnMetrics({ stream_id: 's' });
  assert.deepEqual([bare.terminal, bare.complete_s, bare.tool_calls, bare.stream_id], [null, null, 0, 's']);
});

test('turnMetrics counts tools; the real events carry no outcome, so errors stay unknown', () => {
  // The dump keeps only call_id, name, phase and ts_ms; phase is requested, executing or result.
  const real = core.turnMetrics(diag({ tool_events: toolEvents([['c1', 'read_file', {}], ['c2', 'edit_file', {}]]) }));
  assert.deepEqual([real.tool_calls, real.tool_errors, real.tool_retries], [2, null, null]);
  const one = core.turnMetrics(diag({ tool_events: toolEvents([['c1', 'read_file', {}]]) }));
  assert.deepEqual([one.tool_calls, one.tool_errors, one.tool_retries], [1, null, null]);

  const withOutcome = core.turnMetrics(diag({
    tool_events: toolEvents([['c1', 'edit_file', { success: false }], ['c2', 'edit_file', { success: true }], ['c3', 'read_file', { success: false }]]),
  }));
  assert.deepEqual([withOutcome.tool_calls, withOutcome.tool_errors, withOutcome.tool_retries], [3, 2, 1]);
});

test('toolRetries counts a call that immediately follows a failed call to the same tool', () => {
  const ev = (rows) => rows.flatMap(([id, name, ts, success]) => [
    { call_id: id, name, phase: 'executing', ts_ms: ts },
    { call_id: id, name, phase: 'result', ts_ms: ts + 5, success },
  ]);
  assert.equal(core.toolRetries([]), 0);
  assert.equal(core.toolRetries(ev([['a', 'edit', 10, false], ['b', 'edit', 20, true]])), 1);
  assert.equal(core.toolRetries(ev([['a', 'edit', 10, false], ['b', 'read', 20, true], ['c', 'edit', 30, true]])), 0, 'not immediate');
  assert.equal(core.toolRetries(ev([['a', 'edit', 10, true], ['b', 'edit', 20, true]])), 0, 'first call succeeded');
  assert.equal(core.toolRetries(ev([['a', 'edit', 10, false], ['b', 'edit', 20, false], ['c', 'edit', 30, true]])), 2);
  const shuffled = ev([['b', 'edit', 20, true], ['a', 'edit', 10, false]]);
  assert.equal(core.toolRetries(shuffled), 1, 'events are ordered by ts_ms first');
  const byStatus = [
    { call_id: 'a', name: 'bash', phase: 'result', ts_ms: 1, status: 'error' },
    { call_id: 'b', name: 'bash', phase: 'result', ts_ms: 2, status: 'ok' },
  ];
  assert.equal(core.toolRetries(byStatus), 1);
});

test('diagnosticsForRun keeps one session at or after sinceMs, oldest first', () => {
  const at = (iso, extra) => diag({ written_at: iso, stream_id: extra.stream_id, ...extra });
  const all = [
    at('2026-11-24T10:00:50.000Z', { stream_id: 'late' }),
    at('2026-11-24T10:00:10.000Z', { stream_id: 'old' }),
    at('2026-11-24T10:00:30.000Z', { stream_id: 'mid' }),
    at('2026-11-24T10:00:40.000Z', { stream_id: 'other', session_id: 'sess-2' }),
    { stream_id: 'garbled', session_id: 'sess-1', written_at: 'not a time' },
  ];
  const since = Date.parse('2026-11-24T10:00:20.000Z');
  const mine = core.diagnosticsForRun(all, { sessionId: 'sess-1', sinceMs: since });
  assert.deepEqual(mine.map((d) => d.stream_id), ['mid', 'late']);
  assert.deepEqual(core.diagnosticsForRun(all, { sessionId: 'sess-1', sinceMs: 0 }).map((d) => d.stream_id), ['old', 'mid', 'late']);
  assert.deepEqual(core.diagnosticsForRun([], { sessionId: 'sess-1', sinceMs: 0 }), []);
});

test('combineTurns sums a multi-turn task, keeps the first ttfa and the last terminal', () => {
  const turn = (over) => ({
    terminal: 'completed', ttfa_s: null, complete_s: null, prefill_tokens: null, cached_tokens: null,
    prefill_ms: null, tool_calls: 0, tool_errors: null, tool_retries: null, stream_id: 's', ...over,
  });
  const combined = core.combineTurns([
    turn({ ttfa_s: 1.5, complete_s: 10, prefill_tokens: 100, cached_tokens: 0, tool_calls: 2, tool_errors: 1, stream_id: 'a' }),
    turn({ ttfa_s: 0.5, complete_s: 5.5, prefill_tokens: null, cached_tokens: 40, tool_calls: 1, tool_errors: null, stream_id: 'b' }),
    turn({ terminal: 'error', ttfa_s: null, complete_s: 4, prefill_tokens: 25, cached_tokens: 10, tool_calls: 0, tool_errors: 0, stream_id: 'c' }),
  ]);
  assert.equal(combined.terminal, 'error');
  assert.equal(combined.ttfa_s, 1.5);
  assert.equal(combined.complete_s, 19.5);
  assert.deepEqual([combined.prefill_tokens, combined.cached_tokens], [125, 50]);
  assert.deepEqual([combined.tool_calls, combined.tool_errors], [3, 1]);
  assert.equal(combined.prefill_ms, null, 'null in every turn stays null');
  assert.equal(combined.tool_retries, null);
  assert.equal(combined.stream_id, 'c');
  assert.deepEqual(combined.stream_ids, ['a', 'b', 'c']);

  const single = core.combineTurns([turn({ complete_s: 3 })]);
  assert.equal(single.complete_s, 3);
  const empty = core.combineTurns([]);
  assert.deepEqual([empty.terminal, empty.complete_s, empty.tool_calls, empty.stream_ids], [null, null, null, []]);
});

// --- usage history --------------------------------------------------------------------------

test('perfForStreams sums the inference summaries of the named streams only', () => {
  // services/usage-history-service.js: { turns: [{ record_id: 'stream:<id>', stream_id,
  // inference_performance: { summaries: [...] } }] }; fields from performance-contract.js.
  const summary = (over) => ({
    phase: 'finished', provider_kind: 'strata', generated_tokens: 100, decode_elapsed_ms: 2000,
    prompt_tokens: 1000, cached_prompt_tokens: 800, processed_prompt_tokens: 200,
    prefill_elapsed_ms: 500, time_to_first_generated_token_ms: 900, terminal_decode_tps: 50,
    terminal_prefill_tps: 400, ...over,
  });
  const history = {
    schema_version: 1,
    turns: [
      { record_id: 'stream:a', stream_id: 'a', inference_performance: { schema_version: 1, summaries: [summary({}), summary({ generated_tokens: 20, decode_elapsed_ms: 400 })], omitted_count: 0 } },
      { record_id: 'stream:b', stream_id: 'b', inference_performance: { schema_version: 1, summaries: [summary({ prompt_tokens: 3000, processed_prompt_tokens: null })] } },
      { record_id: 'stream:z', stream_id: 'z', inference_performance: { summaries: [summary({ generated_tokens: 9999 })] } },
      { record_id: 'stream:n', stream_id: 'n' },
    ],
  };
  assert.deepEqual(core.perfForStreams(history, ['a', 'b']), {
    // b has no processed count: prompt 3000 minus cached 800 stands in (NInfer and Strata, step 7 dry run).
    prefill_tokens: 2600, cached_tokens: 2400, prefill_ms: 1500, decode_tokens: 220, decode_ms: 4400, prompt_tokens: 5000,
  });
  assert.deepEqual(core.perfForStreams(history, ['n', 'missing']), {
    prefill_tokens: null, cached_tokens: null, prefill_ms: null, decode_tokens: null, decode_ms: null, prompt_tokens: null,
  });
  // NInfer (step 7 dry run): no processed count and no time; the rate is over the uncached tokens.
  const ninfer = { turns: [{ stream_id: 'n1', inference_performance: { summaries: [
    summary({ prompt_tokens: 18130, cached_prompt_tokens: 17566, processed_prompt_tokens: null, prefill_elapsed_ms: null, terminal_prefill_tps: 2018 }),
  ] } }] };
  const nperf = core.perfForStreams(ninfer, ['n1']);
  assert.equal(nperf.prefill_tokens, 564);
  assert.ok(Math.abs(nperf.prefill_ms - (564 * 1000) / 2018) < 1e-9);
  // Strata (step 6 smoke): prefill_elapsed_ms null, terminal_prefill_tps set -> derived time.
  const strata = { turns: [{ stream_id: 's', inference_performance: { summaries: [
    summary({ prefill_elapsed_ms: null, processed_prompt_tokens: 13853, terminal_prefill_tps: 6624 }),
    summary({ prefill_elapsed_ms: null, terminal_prefill_tps: null }),
  ] } }] };
  assert.ok(Math.abs(core.perfForStreams(strata, ['s']).prefill_ms - (13853 * 1000) / 6624) < 1e-9,
    'a summary with neither a time nor a rate adds nothing');
  assert.equal(core.perfForStreams({}, ['a']).decode_tokens, null);
  assert.equal(core.perfForStreams(null, ['a']).decode_tokens, null);
});

// --- samplers -------------------------------------------------------------------------------

test('parseVramCsv reads nvidia-smi rows (local time), skips the header and a torn last line', () => {
  const text = [
    'timestamp, memory.used [MiB]',
    '2026/11/24 14:03:22.500, 1200 MiB',
    '2026/11/24 14:03:23.000, 30500 MiB',
    '2026/11/24 14:03:23.500, 31000 MiB',
    '2026/11/24 14:03:24.0',
  ].join('\r\n');
  const samples = core.parseVramCsv(text);
  assert.equal(samples.length, 3);
  const t0 = new Date(2026, 10, 24, 14, 3, 22, 500).getTime();
  assert.deepEqual(samples[0], { tMs: t0, vram_mib: 1200 });
  assert.equal(samples[2].tMs - t0, 1000);
  assert.equal(core.peakInWindow(samples, 'vram_mib', t0, t0 + 500), 30500);
  assert.equal(core.peakInWindow(samples, 'vram_mib', t0, t0 + 1000), 31000);
  assert.equal(core.peakInWindow(samples, 'vram_mib', t0 + 2000, t0 + 3000), null);
  assert.equal(core.peakInWindow([], 'vram_mib', 0, 1), null);
  assert.equal(core.parseVramCsv('2026/11/24 14:03:22.500, 77\n', { utc: true })[0].tMs, Date.UTC(2026, 10, 24, 14, 3, 22, 500));
});

test('parseRamCsv and rssSumByTime give the per-timestamp server plus engine working set', () => {
  const text = [
    't_utc,pid,rss_mib,sys_used_mib',
    '2026-11-24T14:03:22.5000000Z,4100,900,20000',
    '2026-11-24T14:03:22.5000000Z,4200,5000,20000',
    '2026-11-24T14:03:23.0000000Z,4100,950,21000',
    '2026-11-24T14:03:23.0000000Z,4200,5200,21000',
    '2026-11-24T14:03:23.5000000Z,4100,700,19000',
    '',
  ].join('\n');
  const samples = core.parseRamCsv(text);
  assert.equal(samples.length, 5);
  const t0 = Date.UTC(2026, 10, 24, 14, 3, 22, 500);
  assert.deepEqual(samples[0], { tMs: t0, pid: 4100, rss_mib: 900, sys_used_mib: 20000 });
  assert.equal(core.peakInWindow(samples, 'sys_used_mib', t0, t0 + 1000), 21000);
  const sums = core.rssSumByTime(samples);
  assert.deepEqual(sums.map((s) => s.rss_mib), [5900, 6150, 700]);
  assert.equal(core.peakInWindow(sums, 'rss_mib', t0, t0 + 1000), 6150);
  assert.equal(core.peakInWindow(sums, 'rss_mib', t0 + 1000, t0 + 1000), 700);
});

// --- outcome and row ------------------------------------------------------------------------

test('outcomeOf ranks timeout, then error, then the check result', () => {
  const base = { checkOk: true, timedOut: false, terminal: 'completed', driverError: null };
  assert.equal(core.outcomeOf(base), 'pass');
  assert.equal(core.outcomeOf({ ...base, checkOk: false }), 'fail');
  assert.equal(core.outcomeOf({ ...base, timedOut: true, driverError: 'x', terminal: 'error' }), 'timeout');
  assert.equal(core.outcomeOf({ ...base, driverError: 'CDP closed' }), 'error');
  assert.equal(core.outcomeOf({ ...base, terminal: 'error', checkOk: false }), 'error');
  assert.equal(core.outcomeOf({ ...base, terminal: 'cancelled', checkOk: false }), 'fail');
});

const planned = (over = {}) => ({
  seq: 15, block: 3, engine_start: 2, arm: 'strata_p1_off', task_id: 'ab_r1_port', discard: false, ...over,
});

const FULL_PARTS = () => ({
  startMs: Date.UTC(2026, 10, 24, 14, 0, 0),
  endMs: Date.UTC(2026, 10, 24, 14, 0, 20),
  checkOk: true,
  checkReason: 'ok\nall good ',
  turn: core.turnMetrics(diag()),
  perf: {
    prefill_tokens: 200, cached_tokens: 800, prefill_ms: 500, decode_tokens: 120, decode_ms: 2400, prompt_tokens: 1000,
  },
  peaks: { peak_vram_mib: 31000, peak_ram_mib: 21000, peak_rss_mib: 6150 },
});

function assertAllColumns(row) {
  for (const column of RECIPE_COLUMNS) {
    assert.ok(Object.hasOwn(row, column), `missing column ${column}`);
  }
}

test('buildRow for a pass carries every recipe column and prefers the usage history', () => {
  const row = core.buildRow(planned(), FULL_PARTS());
  assertAllColumns(row);
  assert.deepEqual(
    [row.seq, row.block, row.engine_start, row.arm, row.task_id, row.discard, row.run_index],
    [15, 3, 2, 'strata_p1_off', 'ab_r1_port', false, 3],
  );
  assert.equal(row.outcome, 'pass');
  assert.equal(row.failure_class, 'none');
  assert.equal(row.check_reason, 'all good');
  assert.equal(row.start_utc, '2026-11-24T14:00:00.000Z');
  assert.equal(row.end_utc, '2026-11-24T14:00:20.000Z');
  assert.equal(row.complete_s, 12);
  assert.equal(row.ttfa_s, 2.5);
  assert.deepEqual([row.prefill_tokens, row.cached_tokens, row.prefill_ms], [200, 800, 500]);
  assert.equal(row.prefill_tok_s, 400);
  assert.deepEqual([row.decode_tokens, row.decode_tok_s, row.prompt_tokens], [120, 50, 1000]);
  assert.deepEqual([row.peak_vram_mib, row.peak_ram_mib, row.peak_rss_mib], [31000, 21000, 6150]);
  assert.deepEqual([row.reasoning_tokens, row.reasoning_budget, row.budget_hit, row.no_answer_count], [null, null, null, null]);
  assert.equal(row.rejected_tool_calls, null, 'a Strata arm has no source for it');
  assert.equal(core.buildRow(planned({ arm: 'ninfer' }), FULL_PARTS()).rejected_tool_calls, 0);
  assert.equal(core.buildRow(planned(), { ...FULL_PARTS(), rejected_tool_calls: 2 }).rejected_tool_calls, 2);
  assert.equal(row.status, 'completed');
});

test('buildRow for a timeout keeps what is known and nulls the rest', () => {
  const row = core.buildRow(planned({ discard: true }), {
    startMs: 1000, endMs: 901000, timedOut: true, checkOk: false, completeS: 900, checkReason: 'check timed out',
    turn: null, perf: null, peaks: null, stop_reason: 'timeout', chat_error_code: null,
  });
  assertAllColumns(row);
  assert.equal(row.outcome, 'timeout');
  assert.equal(row.discard, true);
  assert.equal(row.complete_s, 900);
  assert.equal(row.stop_reason, 'timeout');
  for (const column of ['ttfa_s', 'prefill_tokens', 'prefill_tok_s', 'decode_tok_s', 'tool_calls', 'peak_vram_mib', 'status']) {
    assert.equal(row[column], null, column);
  }
});

test('buildRow for an error run that never sent says so and passes complete_s 0', () => {
  const row = core.buildRow(planned({ arm: 'ninfer' }), {
    startMs: 5000, endMs: 6000, checkOk: false, driverError: 'composer never appeared', neverSent: true,
    checkReason: 'x'.repeat(400), turn: null, perf: { prefill_tokens: 0, prefill_ms: 0, decode_tokens: null, decode_ms: null },
  });
  assertAllColumns(row);
  assert.equal(row.outcome, 'error');
  assert.equal(row.complete_s, 0);
  assert.match(row.check_reason, /^never sent: x+$/);
  assert.equal(row.check_reason.length, 300);
  assert.equal(row.prefill_tok_s, null, 'a zero denominator gives null');
  assert.equal(row.decode_tok_s, null);
});

test('buildRow takes tool counts from parts.tools and the error terminal from the turn', () => {
  const row = core.buildRow(planned(), {
    ...FULL_PARTS(),
    turn: core.turnMetrics(diag({ terminal_status: 'error' })),
    tools: { tool_calls: 7, tool_errors: 2, tool_retries: 1 },
    reasoning_tokens: 640, reasoning_budget: 4096, budget_hit: false, no_answer_count: 0,
  });
  assert.equal(row.outcome, 'error');
  assert.deepEqual([row.tool_calls, row.tool_errors, row.tool_retries], [7, 2, 1]);
  assert.deepEqual([row.reasoning_tokens, row.reasoning_budget, row.budget_hit, row.no_answer_count], [640, 4096, false, 0]);
  const fallback = core.buildRow(planned(), { ...FULL_PARTS(), perf: null });
  assert.deepEqual([fallback.prefill_tokens, fallback.cached_tokens, fallback.prefill_ms], [320, 1580, null]);
});

// --- cross-language ---------------------------------------------------------------------------

test('rows from buildRow pass the Python sheet validator; ARM_IDS match schedule.ARMS', (t) => {
  if (!fs.existsSync(VENV_PYTHON)) {
    t.skip(`venv python not found at ${VENV_PYTHON}; run the cross-language check by hand`);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-ab-core-'));
  try {
    const rows = [
      core.buildRow(planned(), FULL_PARTS()),
      core.buildRow(planned({ seq: 16, arm: 'ninfer', discard: true }), { startMs: 1, endMs: 2, checkOk: false, driverError: 'e', neverSent: true }),
      core.buildRow(planned({ seq: 17 }), { startMs: 1, endMs: 2, timedOut: true, completeS: 900 }),
    ];
    const file = path.join(dir, 'sheet.ndjson');
    fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
    const run = (args) => spawnSync(VENV_PYTHON, args, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60000 });
    const validated = run(['-m', 'scripts.eval.strata_ab', 'validate', file]);
    assert.equal(validated.status, 0, `${validated.stdout}${validated.stderr}`);
    assert.match(validated.stdout, /ok 3 rows/);
    fs.writeFileSync(file, `${JSON.stringify({ ...rows[0], outcome: 'weird' })}\n`, 'utf8');
    assert.equal(run(['-m', 'scripts.eval.strata_ab', 'validate', file]).status, 1);
    const arms = run(['-c', 'import json; from scripts.eval.strata_ab.schedule import ARM_IDS; print(json.dumps(ARM_IDS))']);
    assert.deepEqual(JSON.parse(arms.stdout), ARM_IDS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- driver inputs (run_ab.js) ----------------------------------------------------------------

test('seedShellConfig writes the arm settings, a managed engine and Setup done, keeping other keys', () => {
  const existing = { version: 9, theme: 'dark', localEngines: { ninfer: { contextSize: 1 }, strata: { slots: 2, extra: true } } };
  const strata = core.seedShellConfig(existing, 'strata_p1_off', { configVersion: 12, workspace: 'W' });
  assert.equal(strata.version, 9);
  assert.equal(strata.theme, 'dark');
  assert.equal(strata.preferredEngineType, 'openai-compatible');
  assert.equal(strata.toolsWorkspaceRoot, 'W');
  assert.deepEqual(strata.setup, { seen: true, dismissed: true, setupComplete: true });
  assert.deepEqual(strata.localEngines.strata, { slots: 1, extra: true, kv: 'k8v8', context: null, vision: true, drafting: 'off' });
  assert.deepEqual(strata.localEngines.ninfer, { contextSize: 1 }, 'the other engine is untouched');
  assert.equal(existing.localEngines.strata.slots, 2, 'the input is not mutated');
  const ninfer = core.seedShellConfig(null, 'ninfer', { configVersion: 12, workspace: 'W' });
  assert.equal(ninfer.version, 12);
  assert.deepEqual(ninfer.localEngines, { ninfer: { contextSize: 153600, mtp: true, vision: true } });
  assert.throws(() => core.seedShellConfig({}, 'nope', { configVersion: 1, workspace: 'W' }), /unknown arm/);
});

test('parseDriverArgs requires the paths and mode, and parses the filters', () => {
  const base = ['--results', 'R', '--fixtures', 'F', '--plan', 'P', '--profiles', 'Q', '--mode', 'ask'];
  assert.deepEqual(core.parseDriverArgs(base), { port: 9361, preflightTokens: false, results: 'R', fixtures: 'F', plan: 'P', profiles: 'Q', mode: 'ask' });
  const filtered = core.parseDriverArgs([...base, '--engine-start', '2', '--tasks', 'ab_e1_paginate, ab_r2_raiser', '--port', '9400', '--preflight-tokens']);
  assert.deepEqual([filtered.engineStart, filtered.tasks, filtered.port, filtered.preflightTokens], [2, ['ab_e1_paginate', 'ab_r2_raiser'], 9400, true]);
  assert.throws(() => core.parseDriverArgs(base.slice(2)), /--results is required/);
  assert.throws(() => core.parseDriverArgs([...base.slice(0, -1), 'plan']), /ask or auto/);
  assert.throws(() => core.parseDriverArgs([...base, '--block', '0']), /positive integer/);
  assert.throws(() => core.parseDriverArgs([...base, '--bogus', '1']), /unknown or incomplete/);
  assert.throws(() => core.parseDriverArgs([...base, '--tasks']), /unknown or incomplete/);
});

test('tokenPreflight subtracts the overhead, checks the band and the window', () => {
  assert.deepEqual(core.tokenPreflight('ab_l1_64k', { totalTokens: 80_000, overheadTokens: 14_000, window: 114_432 }), {
    task_id: 'ab_l1_64k', ok: true, prompt_tokens: 66_000, total_tokens: 80_000, band: [55_000, 75_000], window: 114_432, reason: 'ok',
  });
  assert.match(core.tokenPreflight('ab_l1_64k', { totalTokens: 60_000, overheadTokens: 14_000 }).reason, /outside 55000-75000/);
  const tight = core.tokenPreflight('ab_l2_100k', { totalTokens: 115_000, overheadTokens: 14_000, window: 114_432 });
  assert.deepEqual([tight.ok, tight.reason], [false, 'total 115000 reaches the window 114432']);
  assert.equal(core.tokenPreflight('ab_l2_100k', { totalTokens: 110_000, overheadTokens: 14_000, window: null }).ok, true);
  assert.deepEqual(core.tokenPreflight('ab_l2_100k', { totalTokens: null, overheadTokens: 1 }), { task_id: 'ab_l2_100k', ok: false, reason: 'no prompt count' });
  assert.throws(() => core.tokenPreflight('ab_r1_port', { totalTokens: 1, overheadTokens: 0 }), /no token band/);
  assert.deepEqual(Object.keys(core.TOKEN_BANDS), ['ab_l1_64k', 'ab_l2_100k'], 'the driver iterates the exported bands');
  // The preflight reads the first provider call: a tool loop's later calls repeat the prompt (S3 restart).
  const loop = { provider_diagnostics: { provider_prompt_eval_count: 74_069, provider_calls: [
    { usage: { prompt_eval_count: 70_100 } }, { usage: { prompt_eval_count: 74_069 } }] } };
  assert.equal(core.firstCallPromptTokens(loop), 70_100);
  assert.equal(core.firstCallPromptTokens({ provider_diagnostics: { provider_prompt_eval_count: 16_671 } }), 16_671);
  assert.equal(core.firstCallPromptTokens({ provider_diagnostics: { provider_calls: [{ usage: {} }] } }), null);
  assert.equal(core.firstCallPromptTokens(null), null);
});

test('run_ab.js loads without running; seedProfile seeds a Strata profile and reuses pack receipts', () => {
  const driver = require('../scripts/eval/strata_ab/run_ab');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-ab-driver-'));
  try {
    fs.writeFileSync(path.join(dir, 'pack-receipts.json'), '{"schema_version":1,"receipts":[]}');
    const profile = path.join(dir, 'es02', 'profile');
    driver.seedProfile(profile, 'strata_p1_dspark', dir);
    const config = JSON.parse(fs.readFileSync(path.join(profile, 'shell-config.json'), 'utf8'));
    assert.equal(config.localEngines.strata.drafting, 'dspark');
    assert.equal(config.toolsWorkspaceRoot, path.join(dir, 'es02', 'workspace'));
    assert.ok(fs.existsSync(config.toolsWorkspaceRoot));
    assert.equal(fs.readFileSync(path.join(profile, 'strata', 'pack-receipts.json'), 'utf8'), '{"schema_version":1,"receipts":[]}');
    assert.ok(!fs.existsSync(path.join(profile, 'engines')), 'a Strata arm copies no NInfer runtime');
    fs.writeFileSync(path.join(dir, 'vram.csv'), 'timestamp, memory.used [MiB]\n2026/11/24 14:00:01.000, 30000 MiB\n2026/11/24 14:00:09.000, 31000 MiB\n');
    const start = new Date(2026, 10, 24, 14, 0, 0).getTime();
    const t = new Date(start + 2000).toISOString().replace('Z', '0000Z');
    fs.writeFileSync(path.join(dir, 'ram.csv'), `t_utc,pid,rss_mib,sys_used_mib\n${t},1,100,9000\n${t},2,50,9100\n`);
    const peaks = driver.peaksFor({ vramFile: path.join(dir, 'vram.csv'), ramFile: path.join(dir, 'ram.csv') }, start, start + 5000);
    assert.equal(peaks.peak_vram_mib, 30000, 'local-time nvidia-smi rows cut to the window');
    assert.deepEqual([peaks.peak_ram_mib, peaks.peak_rss_mib], [9100, 150], 'system peak; server plus engine summed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
