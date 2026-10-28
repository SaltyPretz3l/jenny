'use strict';

// Row 67: the bounded subagent transcript through the Electron report normalizer.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeChildActivity,
  normalizeSubagentBatchReport,
  normalizeSubagentReport,
} = require('../services/backend/subagent-report-metadata');

function report(overrides = {}) {
  return {
    task_id: 'child-1',
    label: 'Inspect persistence',
    summary: 'The child found the canonical persistence seam.',
    evidence: [{ relative_path: 'services/backend/store.js', summary: 'Canonical writer.' }],
    tools_used: ['read_file'],
    uncertainties: [],
    budget: { elapsed_ms: 1400 },
    status: 'completed',
    agent_id: 'research@request:call:1',
    parent_agent_id: 'main@request',
    usage: { input_tokens: 100, output_tokens: 25, total_tokens: 125, provider: 'ollama', model: 'qwen3.5' },
    ...overrides,
  };
}

function toolEntry(overrides = {}) {
  return { kind: 'tool', call_id: 'call-1', tool: 'read_file', display: 'Read File', status: 'completed', ...overrides };
}

function transcriptChars(transcript) {
  return transcript.reduce((sum, entry) => sum
    + (entry.text || '').length + (entry.input || '').length + (entry.output || '').length, 0);
}

test('transcript is omitted when absent, empty or malformed', () => {
  assert.equal(Object.hasOwn(normalizeSubagentReport(report()), 'transcript'), false);
  assert.equal(Object.hasOwn(normalizeSubagentReport(report({ transcript: [] })), 'transcript'), false);
  assert.equal(Object.hasOwn(normalizeSubagentReport(report({ transcript: 'nope' })), 'transcript'), false);
  assert.equal(Object.hasOwn(normalizeSubagentReport(report({ transcript: [{ kind: 'mystery', text: 'x' }, null, 'x'] })), 'transcript'), false);
  assert.equal(Object.hasOwn(normalizeSubagentReport(report()), 'transcript_dropped'), false);
  assert.equal(Object.hasOwn(normalizeSubagentReport(report({ transcript_dropped: 0 })), 'transcript_dropped'), false);
  assert.equal(Object.hasOwn(normalizeSubagentReport(report({ transcript_dropped: -3 })), 'transcript_dropped'), false);
  assert.equal(Object.hasOwn(normalizeSubagentReport(report({ transcript_dropped: 1.5 })), 'transcript_dropped'), false);
  assert.equal(normalizeSubagentReport(report({ transcript_dropped: 7 })).transcript_dropped, 7);
});

test('transcript entries are rebuilt from known keys with per-field caps', () => {
  const normalized = normalizeSubagentReport(report({
    transcript: [
      { kind: 'thought', text: 't'.repeat(2000), truncated: true, ms: 1200, live: true, extra: 'drop' },
      { kind: 'thought', text: '', live: true, ms: -1, truncated: 'yes' },
      { kind: 'text', text: 'n'.repeat(1800), truncated: true },
      { kind: 'text', text: '   ' },
      toolEntry({
        call_id: 'c'.repeat(300),
        tool: 'x'.repeat(100),
        display: 'd'.repeat(100),
        input: 'i'.repeat(1500),
        output: 'o'.repeat(3000),
        error_code: 'E'.repeat(100),
        ms: 40,
        raw: 'drop',
      }),
      toolEntry({ tool: '', display: 'No tool' }),
      toolEntry({ display: '', status: 'bogus', output_chars: 12.5, ms: 'fast' }),
      { kind: 'mystery', text: 'unknown kind' },
    ],
  }));
  const [thought, liveThought, note, tool, bare] = normalized.transcript;

  assert.equal(normalized.transcript.length, 5);
  assert.deepEqual(Object.keys(thought), ['kind', 'text', 'live', 'truncated', 'ms']);
  assert.equal(thought.text.length, 1500);
  assert.equal(thought.truncated, true);
  assert.equal(thought.live, true);
  assert.equal(thought.ms, 1200);
  assert.deepEqual(liveThought, { kind: 'thought', text: '', live: true });
  assert.equal(note.kind, 'text');
  assert.equal(note.text.length, 1500);
  assert.equal(note.truncated, true);
  assert.equal(tool.call_id.length, 200);
  assert.equal(tool.tool.length, 64);
  assert.equal(tool.display.length, 64);
  assert.equal(tool.input.length, 1000);
  assert.equal(tool.input_truncated, true);
  assert.equal(tool.output.length, 2000);
  assert.equal(tool.output_chars, 3000);
  assert.equal(tool.error_code.length, 64);
  assert.equal(tool.ms, 40);
  assert.equal(Object.hasOwn(tool, 'raw'), false);
  assert.deepEqual(bare, { kind: 'tool', call_id: 'call-1', tool: 'read_file', display: 'read_file' });
});

test('transcript keeps the first 80 entries and unknown kinds do not count toward the cap', () => {
  const transcript = [];
  for (let index = 0; index < 100; index += 1) {
    transcript.push({ kind: 'mystery', text: `junk ${index}` });
    transcript.push({ kind: 'text', text: `note ${index}` });
  }
  const normalized = normalizeSubagentReport(report({ transcript }));

  assert.equal(normalized.transcript.length, 80);
  assert.equal(normalized.transcript[0].text, 'note 0');
  assert.equal(normalized.transcript[79].text, 'note 79');
});

test('transcript redacts secrets in every text field', () => {
  const normalized = normalizeSubagentReport(report({
    transcript: [
      { kind: 'thought', text: 'thinking api_key=thought-secret-value' },
      { kind: 'text', text: 'note token=note-secret-value' },
      toolEntry({ input: '{"api_key":"input-secret-value"}', output: 'ok api_key=sk-output-secret-value' }),
      toolEntry({ status: 'failed', input: 'password=failed-input-secret', output: 'denied api_key=failed-output-secret' }),
    ],
  }));
  const text = JSON.stringify(normalized.transcript);

  for (const secret of ['thought-secret-value', 'note-secret-value', 'input-secret-value', 'sk-output-secret-value', 'failed-input-secret', 'failed-output-secret']) {
    assert.equal(text.includes(secret), false, secret);
  }
  assert.match(normalized.transcript[2].output, /^ok /);
});

test('completed tool calls keep real paths while failed and interrupted calls scrub them', () => {
  const abs = 'C:\\Users\\me\\vault\\ledger.csv';
  const normalized = normalizeSubagentReport(report({
    transcript: [
      toolEntry({ status: 'completed', input: '{"path":"src/app.py"}', output: `read ${abs}\nsecond line` }),
      toolEntry({ status: 'running', input: '{"path":"src/app.py"}' }),
      toolEntry({ status: 'failed', input: `{"path":"${abs}"}`, output: `denied ${abs}\nsecond line /home/me/key.pem` }),
      toolEntry({ status: 'interrupted', input: 'open //nas/finance/q3.xlsx', output: 'cannot read ../../outside/ledger.csv' }),
    ],
  }));
  const [completed, running, failed, interrupted] = normalized.transcript;

  assert.equal(completed.input, '{"path":"src/app.py"}');
  assert.equal(completed.output, `read ${abs}\nsecond line`);
  assert.equal(running.input, '{"path":"src/app.py"}');
  for (const entry of [failed, interrupted]) {
    const text = `${entry.input} ${entry.output}`;
    assert.equal(/Users|vault|ledger|nas|finance|q3|outside|key\.pem/.test(text), false, text);
    assert.match(text, /<path>/);
  }
  assert.match(failed.output, /\nsecond line/, 'line breaks survive the scrub');
});

test('transcript shares a 24,000 character budget and flags what it cuts', () => {
  const normalized = normalizeSubagentReport(report({
    transcript: [
      ...Array.from({ length: 10 }, () => toolEntry({ input: 'i'.repeat(1000), output: 'o'.repeat(1400) })),
      { kind: 'text', text: 'n'.repeat(1000) },
      toolEntry({ input: 'i'.repeat(500), output: 'o'.repeat(500) }),
      { kind: 'text', text: 'late note' },
    ],
  }));

  // The first ten spend all 24,000; a later text entry is empty and drops, a later tool
  // call keeps its identity with the cut fields flagged.
  assert.equal(transcriptChars(normalized.transcript), 24000);
  assert.equal(normalized.transcript.length, 11);
  const late = normalized.transcript[10];
  assert.equal(late.kind, 'tool');
  assert.equal(late.input_truncated, true);
  assert.equal(late.output_chars, 500);
  assert.equal(Object.hasOwn(late, 'input'), false);
  assert.equal(Object.hasOwn(late, 'output'), false);
});

test('transcript budget cuts a partial field to what remains and keeps a supplied output_chars', () => {
  const normalized = normalizeSubagentReport(report({
    transcript: [
      { kind: 'thought', text: 't'.repeat(1000) },
      ...Array.from({ length: 15 }, () => ({ kind: 'text', text: 'n'.repeat(1500) })),
      { kind: 'thought', text: 'a'.repeat(1500) },
      { kind: 'thought', text: 'last one' },
      toolEntry({ output: 'o'.repeat(1000), output_chars: 9999 }),
    ],
  }));
  const thoughts = normalized.transcript.filter((entry) => entry.kind === 'thought');

  assert.equal(transcriptChars(normalized.transcript), 24000);
  assert.equal(Object.hasOwn(thoughts[0], 'truncated'), false);
  assert.equal(thoughts[1].text.length, 500, 'cut to the 500 remaining');
  assert.equal(thoughts[1].truncated, true);
  assert.equal(thoughts[2].text, '');
  assert.equal(thoughts[2].truncated, true);
  assert.equal(normalized.transcript.at(-1).output_chars, 9999);
  assert.equal(Object.hasOwn(normalized.transcript.at(-1), 'output'), false);
});

test('transcript flows through batch tasks and the report keeps transcript_dropped', () => {
  const batch = normalizeSubagentBatchReport({
    batch_id: 'delegate:req:call',
    status: 'completed',
    tasks: [{
      ...report(),
      ordinal: 1,
      transcript: [{ kind: 'text', text: 'First, read the file.' }, toolEntry({ output: 'body' })],
      transcript_dropped: 4,
    }],
  });

  assert.deepEqual(batch.tasks[0].transcript, [
    { kind: 'text', text: 'First, read the file.' },
    { kind: 'tool', call_id: 'call-1', tool: 'read_file', display: 'Read File', status: 'completed', output: 'body' },
  ]);
  assert.equal(batch.tasks[0].transcript_dropped, 4);
});

test('child activity keeps transcript and transcript_version, and omits them when absent', () => {
  const activity = normalizeChildActivity({
    sequence: 3,
    transcript: [
      { kind: 'thought', text: '', live: true },
      toolEntry({ status: 'running', input: '{"path":"src/app.py"}' }),
    ],
    transcript_version: 5,
  });

  assert.equal(activity.transcript_version, 5);
  assert.deepEqual(activity.transcript, [
    { kind: 'thought', text: '', live: true },
    { kind: 'tool', call_id: 'call-1', tool: 'read_file', display: 'Read File', status: 'running', input: '{"path":"src/app.py"}' },
  ]);

  const bare = normalizeChildActivity({ sequence: 4, transcript_version: -1 });
  assert.equal(Object.hasOwn(bare, 'transcript'), false);
  assert.equal(Object.hasOwn(bare, 'transcript_version'), false);
  assert.equal(Object.hasOwn(normalizeChildActivity({ sequence: 4, transcript: [] }), 'transcript'), false);
});
