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
