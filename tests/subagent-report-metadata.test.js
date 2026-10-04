'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeSubagentBatchReport,
  normalizeSubagentMetadata,
  normalizeSubagentReport,
  normalizeUsage,
} = require('../services/backend/subagent-report-metadata');
const {
  normalizePersistedToolResultMetadata,
  normalizeToolResultMetadataForStorage,
} = require('../services/backend/tool-result-diff-metadata');
const { normalizeToolResultMetadata } = require('../services/backend/message-normalization');

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

test('single report validator rebuilds bounded metadata and drops raw provider payloads', () => {
  const normalized = normalizeSubagentReport(report({
    raw_usage: { prompt: 'secret' },
    usage: {
      input_tokens: -1,
      output_tokens: 4.5,
      total_tokens: 42,
      provider: 'ollama',
      model: 'C:\\models\\private',
      raw_usage: { prompt: 'secret' },
    },
    evidence: [
      { relative_path: '../escape.txt', summary: 'drop path' },
      { relative_path: 'src/safe.js', summary: 'keep path' },
    ],
  }));

  assert.equal(normalized.usage.total_tokens, 42);
  assert.equal(normalized.usage.provider, 'ollama');
  assert.equal(Object.hasOwn(normalized.usage, 'model'), false);
  assert.equal(Object.hasOwn(normalized, 'raw_usage'), false);
  assert.equal(Object.hasOwn(normalized.evidence[0], 'relative_path'), false);
  assert.equal(normalized.evidence[1].relative_path, 'src/safe.js');
});

test('usage validator rejects malformed values and caps oversized integers', () => {
  assert.equal(normalizeUsage({ input_tokens: -1, output_tokens: 0.5 }), null);
  assert.deepEqual(normalizeUsage({ total_tokens: Number.MAX_SAFE_INTEGER }), {
    total_tokens: 2147483647,
    estimated: false,
  });
});

test('report validators reject incomplete objects instead of fabricating terminal authority', () => {
  assert.equal(normalizeSubagentReport({}), null);
  assert.equal(normalizeSubagentReport(report({ task_id: '', status: 'running' })), null);
  assert.equal(normalizeSubagentBatchReport({ batch_id: 'batch-1', status: 'completed', tasks: [{}, report()] }).tasks.length, 1);
  assert.equal(normalizeSubagentBatchReport({ batch_id: '', status: 'completed', tasks: [report()] }), null);
});

test('batch validator isolates malformed entries and caps task count', () => {
  const tasks = [null, report({ task_id: 'one' }), report({ task_id: 'two' }), report({ task_id: 'three' }), report({ task_id: 'four' })];
  const normalized = normalizeSubagentBatchReport({ batch_id: 'batch-1', status: 'partial', tasks });
  assert.deepEqual(normalized.tasks.map((task) => task.task_id), ['one', 'two', 'three']);
});

test('delegate metadata retains bounded tool-observed provenance and line ranges', () => {
  const normalized = normalizeSubagentBatchReport({
    batch_id: 'delegate:req:call',
    source_tool: 'delegate',
    execution: 'parallel',
    status: 'completed',
    tasks: [report({
      evidence_trust: 'tool_observed',
      evidence: [{
        source_tool: 'read_file',
        relative_path: 'package.json',
        line_start: 8,
        line_end: 8,
        quote: '"test": "npm test"',
        provenance: 'tool_observed',
        verified: true,
      }],
    })],
  });

  assert.equal(normalized.source_tool, 'delegate');
  assert.equal(normalized.execution, 'parallel');
  assert.equal(normalized.tasks[0].evidence_trust, 'tool_observed');
  assert.deepEqual(normalized.tasks[0].evidence[0], {
    source_tool: 'read_file',
    quote: '"test": "npm test"',
    relative_path: 'package.json',
    line_start: 8,
    line_end: 8,
    provenance: 'tool_observed',
  });
});

test('metadata never promotes unsupported sources to tool-observed provenance', () => {
  const normalized = normalizeSubagentReport(report({
    evidence: [{ source_tool: 'web_search', fact: 'claim', provenance: 'tool_observed' }],
  }));

  assert.equal(Object.hasOwn(normalized.evidence[0], 'source_tool'), false);
  assert.equal(Object.hasOwn(normalized.evidence[0], 'provenance'), false);
});

test('canonical persistence and reload validation retain only normalized reports', () => {
  const metadata = {
    subagent_report: report({ extra_secret: 'never persist' }),
    arbitrary: { prompt: 'drop this' },
  };
  const persisted = normalizePersistedToolResultMetadata(metadata);
  const storage = normalizeToolResultMetadataForStorage(metadata);
  const reloaded = normalizeToolResultMetadata({
    call_id: 'call-1',
    tool_name: 'subagent_run',
    metadata,
  }).metadata;

  for (const result of [persisted, storage, reloaded]) {
    assert.equal(result.subagent_report.label, 'Inspect persistence');
    assert.equal(Object.hasOwn(result.subagent_report, 'extra_secret'), false);
  }
  assert.equal(Object.hasOwn(persisted, 'arbitrary'), false);
  assert.equal(Object.hasOwn(normalizeSubagentMetadata({ arbitrary: true }) || {}, 'arbitrary'), false);
});

test('steps and answer are optional and old reports validate unchanged', () => {
  const normalized = normalizeSubagentReport(report());

  assert.equal(Object.hasOwn(normalized, 'steps'), false);
  assert.equal(Object.hasOwn(normalized, 'answer'), false);
  assert.equal(normalizeSubagentReport(report({ steps: [], answer: '   ' })).steps, undefined);
  assert.equal(normalizeSubagentReport(report({ steps: 'not an array' })).steps, undefined);
});

test('steps are capped at 40 and rebuilt with only known bounded keys', () => {
  const steps = Array.from({ length: 55 }, (_, index) => ({
    tool: 'read_file',
    display: 'Read File',
    ok: true,
    target: `src/file-${index}.js`,
    injected: 'drop me',
  }));
  const normalized = normalizeSubagentReport(report({ steps }));

  assert.equal(normalized.steps.length, 40);
  assert.equal(normalized.steps[39].target, 'src/file-39.js');
  assert.deepEqual(Object.keys(normalized.steps[0]).sort(), ['display', 'ok', 'target', 'tool']);
});

test('step fields are bounded, defaulted, and invalid entries are dropped', () => {
  const normalized = normalizeSubagentReport(report({
    steps: [
      { tool: 't'.repeat(100), ok: 'yes', target: 'x'.repeat(300), error_code: 'E'.repeat(100), detail: 'd'.repeat(300) },
      { tool: '', display: 'No tool', ok: true },
      'string entry',
      null,
      { tool: 'git_status', ok: false, error_code: 'CMP-TOOL-0001', detail: 'Repository not found' },
    ],
  }));

  assert.equal(normalized.steps.length, 2);
  const [first, second] = normalized.steps;
  assert.equal(first.tool.length, 64);
  assert.equal(first.display, first.tool);
  assert.equal(first.ok, false);
  // A failed step (ok coerced to false) never keeps a target.
  assert.equal(Object.hasOwn(first, 'target'), false);
  assert.equal(first.error_code.length, 64);
  assert.equal(first.detail.length, 160);
  assert.deepEqual(second, {
    tool: 'git_status',
    display: 'git_status',
    ok: false,
    error_code: 'CMP-TOOL-0001',
    detail: 'Repository not found',
  });
});

test('absolute step targets are dropped and secrets are redacted in step text', () => {
  const normalized = normalizeSubagentReport(report({
    steps: [
      { tool: 'read_file', ok: true, target: 'C:\\Users\\me\\repo\\a.js' },
      { tool: 'read_file', ok: true, target: '/home/me/repo/a.js' },
      { tool: 'read_file', ok: true, target: '\\\\server\\share\\a.js' },
      { tool: 'read_file', ok: true, target: 'src/ok.js' },
      {
        tool: 'read_file',
        ok: false,
        detail: 'lookup failed api_key=step-secret-value at C:\\Users\\me',
      },
    ],
  }));

  // Each absolute target is either dropped or redacted; none leaks the real directory.
  const targets = normalized.steps.slice(0, 3).map((step) => step.target || '');
  for (const target of targets) {
    assert.equal(/Users|home[/\\]me|server|share/.test(target), false, target);
    assert.equal(/^([A-Za-z]:[\\/]|[/\\])/.test(target), false, target);
  }
  assert.equal(Object.hasOwn(normalized.steps[2], 'target'), false);
  assert.equal(normalized.steps[3].target, 'src/ok.js');
  assert.equal(normalized.steps[4].detail.includes('step-secret-value'), false);
  assert.equal(normalized.steps[4].detail.length > 0, true);
});

test('a failed step keeps no target and its detail never names an outside path', () => {
  const normalized = normalizeSubagentReport(report({
    steps: [
      { tool: 'read_file', ok: false, target: 'linked/secret-ledger.csv', error_code: 'CMP-TOOL-0003' },
      { tool: 'read_file', ok: true, target: '../../outside/ledger.csv' },
      { tool: 'read_file', ok: true, target: 'docs/notes.md' },
      { tool: 'read_file', ok: false, detail: 'denied \\\\nas\\finance\\q3.xlsx' },
      { tool: 'read_file', ok: false, detail: 'denied //nas/finance/q3.xlsx' },
      { tool: 'read_file', ok: false, detail: 'denied D:/vault/q3.xlsx' },
      { tool: 'read_file', ok: false, detail: 'escapes root: ../../outside/ledger.csv' },
    ],
  }));

  assert.equal(Object.hasOwn(normalized.steps[0], 'target'), false);
  assert.equal(normalized.steps[0].error_code, 'CMP-TOOL-0003');
  assert.equal(Object.hasOwn(normalized.steps[1], 'target'), false);
  assert.equal(normalized.steps[2].target, 'docs/notes.md');
  for (const step of normalized.steps.slice(3)) {
    assert.equal(/nas|finance|vault|q3|outside|ledger/.test(step.detail), false, step.detail);
    assert.match(step.detail, /<path>/);
  }
});

test('a successful step keeps no error line; the scrub covers quoted, spaced, home-relative and invisible-split paths', () => {
  const normalized = normalizeSubagentReport(report({
    steps: [
      { tool: 'read_file', ok: true, target: 'a.txt', detail: 'SECRET FILE BODY line', error_code: 'X' },
      { tool: 'read_file', ok: false, detail: "failed to read file: [Errno 13] Permission denied: 'C:\\\\Users\\\\me\\\\OneDrive - Acme Corp\\\\secret notes.txt'" },
      { tool: 'read_file', ok: false, detail: 'no such file /home/me/My Files/key.pem' },
      { tool: 'read_file', ok: false, detail: 'cannot open ~/.ssh/id_rsa' },
      { tool: 'read_file', ok: false, detail: 'blocked C\u200b:\\Users\\me\\x.txt' },
      { tool: 'read_file', ok: false, detail: '\u202edenied\u2066 here' },
    ],
  }));

  assert.deepEqual(normalized.steps[0], { tool: 'read_file', display: 'read_file', ok: true, target: 'a.txt' });
  for (const step of normalized.steps.slice(1, 5)) {
    assert.equal(/Acme|secret notes|My Files|key\.pem|\.ssh|id_rsa|Users|x\.txt/.test(step.detail), false, step.detail);
    assert.match(step.detail, /<path>/);
  }
  assert.equal(normalized.steps[5].detail, 'denied here');
});

test('a target that names an outside path after its grep pattern is dropped', () => {
  const normalized = normalizeSubagentReport(report({
    steps: [
      { tool: 'grep_search', ok: true, target: '"q" in \\\\server\\share\\payroll.xlsx' },
      { tool: 'grep_search', ok: true, target: '"q" in ../outside/secret.txt' },
      { tool: 'grep_search', ok: true, target: '"q" in C:\\Users\\me\\secret.txt' },
      { tool: 'read_file', ok: true, target: 'file:///C:/etc/passwd' },
      { tool: 'grep_search', ok: true, target: '"q" in src/lib · p3' },
    ],
  }));

  for (const step of normalized.steps.slice(0, 4)) assert.equal(Object.hasOwn(step, 'target'), false, JSON.stringify(step));
  assert.equal(normalized.steps[4].target, '"q" in src/lib · p3');
});

test('bidi and zero-width controls are stripped from the answer and the label', () => {
  const normalized = normalizeSubagentReport(report({ label: '\u202eReview\u200b ledger', answer: 'Line\u2066 one\n\u200bLine two' }));

  assert.equal(normalized.label, 'Review ledger');
  assert.equal(normalized.answer, 'Line one\nLine two');
});

test('answer is capped at 4000 characters, redacted, and keeps line breaks', () => {
  const capped = normalizeSubagentReport(report({ answer: 'a'.repeat(6000) }));
  assert.equal(capped.answer.length, 4000);

  const markdown = normalizeSubagentReport(report({
    answer: '# Title\r\n\r\n| a | b |\n| - | - |\n\u0007bell\u0000',
  }));
  assert.equal(markdown.answer.startsWith('# Title\n\n| a | b |\n'), true);
  assert.equal(markdown.answer.includes('\u0007'), false);
  assert.equal(markdown.answer.includes('\u0000'), false);

  const secret = normalizeSubagentReport(report({ answer: 'Found api_key=answer-secret-value' }));
  assert.equal(secret.answer.includes('answer-secret-value'), false);
});

test('batch tasks keep steps and answer through the shared report normalizer', () => {
  const batch = normalizeSubagentBatchReport({
    batch_id: 'delegate:req:call',
    source_tool: 'delegate',
    execution: 'single',
    status: 'completed',
    tasks: [{
      ...report({ label: 'Find the test command' }),
      ordinal: 1,
      evidence_trust: 'none',
      answer: 'Run npm test.',
      steps: [{ tool: 'read_file', display: 'Read File', ok: true, target: 'package.json' }],
    }],
  });

  assert.equal(batch.tasks[0].answer, 'Run npm test.');
  assert.deepEqual(batch.tasks[0].steps, [
    { tool: 'read_file', display: 'Read File', ok: true, target: 'package.json' },
  ]);
});

test('HB-021: label, summary and answer keep real paths (HB-012) while secrets stay redacted', () => {
  const normalized = normalizeSubagentReport(report({
    label: 'Read D:\\scratch\\dogfood-bank-recon\\REQUIREMENTS.md',
    summary: 'Listed /home/me/proj/agentj.md with api_key=summary-secret-value',
    answer: 'See D:\\scratch\\dogfood-bank-recon\\REQUIREMENTS.md\ntoken=answer-secret-value',
    steps: [{ tool: 'read_file', ok: false, detail: 'denied C:\\Users\\me\\vault.txt' }],
  }));

  assert.equal(normalized.label, 'Read D:\\scratch\\dogfood-bank-recon\\REQUIREMENTS.md');
  assert.equal(normalized.summary.includes('/home/me/proj/agentj.md'), true);
  assert.equal(normalized.summary.includes('summary-secret-value'), false);
  assert.equal(normalized.answer.includes('D:\\scratch\\dogfood-bank-recon\\REQUIREMENTS.md'), true);
  assert.equal(normalized.answer.includes('answer-secret-value'), false);
  assert.equal(/redacted:path/.test(normalized.label + normalized.summary + normalized.answer), false);
  assert.equal(/Users|vault/.test(normalized.steps[0].detail), false, 'a failed step still scrubs an outside path');
});
