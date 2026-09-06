'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');

const {
  APPROVAL_FACT_KINDS,
  formatToolCallSummary,
  formatToolElapsedLabel,
  getApprovalCommandPreview,
  getApprovalFacts,
  getApprovalPurpose,
  getToolPrimaryPath,
  isFileOperationSettledStatus,
  shouldAutoExpandToolDetails,
} = require('../renderer/chat/tool-call-utils');

test('display name precedence: renderer alias, then catalog name, then title case (F16)', () => {
  const { getToolDisplayName } = require('../renderer/chat/tool-call-utils');
  assert.equal(getToolDisplayName('run_command', 'Run Command'), 'Bash');
  assert.equal(getToolDisplayName('read_file', 'Read File'), 'Read');
  assert.equal(getToolDisplayName('fetch_url', 'Fetch URL'), 'Fetch URL');
  assert.equal(getToolDisplayName('fetch_url'), 'Fetch Url');
  assert.equal(getToolDisplayName('python_execute', 'Python Runtime'), 'Python Runtime');
  assert.equal(getToolDisplayName('inspect_harness', '  Inspect Harness '), 'Inspect Harness');
  assert.equal(getToolDisplayName('', 'Anything'), 'Tool');
});

test('a collapsed failure summarizes its own failure text on one bounded line (R2-12)', () => {
  const { summarizeToolFailure, buildToolHeaderInner } = require('../renderer/chat/tool-call-utils');
  const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  assert.equal(
    summarizeToolFailure({ isError: true, status: 'errored', outputText: '\n  npm ERR! missing script: test\nnpm ERR! more', resultSummary: 'exit 1' }),
    'npm ERR! missing script: test',
    'the first non-empty output line wins, like the detail body'
  );
  assert.equal(summarizeToolFailure({ isError: true, status: 'errored', resultSummary: 'exit 1' }), 'exit 1');
  assert.equal(summarizeToolFailure({ isError: true, status: 'errored' }), 'Tool failed');
  assert.equal(summarizeToolFailure({ isError: false, status: 'completed', outputText: 'fine' }), '');
  for (const status of ['denied', 'cancelled', 'blocked', 'timed_out', 'interrupted', 'abandoned']) {
    assert.equal(summarizeToolFailure({ isError: true, status, outputText: 'x' }), '', status + ' already says so in its status word');
  }
  assert.equal(summarizeToolFailure({ isError: true, status: 'errored', errorCode: 'CMP-APPROVAL-REJECTED', outputText: 'x' }), '');
  assert.equal(
    summarizeToolFailure({ isError: true, status: 'errored', outputText: 'a\u202eb\u0007c' }),
    'a b c',
    'bidi and control characters never reach the header'
  );
  const long = summarizeToolFailure({ isError: true, status: 'errored', outputText: 'y'.repeat(500) });
  assert.equal(Array.from(long).length, 160);
  assert.ok(long.endsWith('...'));

  const header = buildToolHeaderInner({
    displayToolName: 'Bash', summary: 'npm test', status: 'errored', isRunning: false,
    statusLabel: 'Failed', durationLabel: '', secondaryMeta: '', failureSummary: 'npm ERR! <missing>',
  }, { escapeHtml: esc });
  assert.match(header, /<span class="tool-call-failure-summary">npm ERR! &lt;missing&gt;<\/span><\/span>/);
  const clean = buildToolHeaderInner({
    displayToolName: 'Bash', summary: 'npm test', status: 'completed', isRunning: false,
    statusLabel: 'Done', durationLabel: '', secondaryMeta: '', failureSummary: '',
  }, { escapeHtml: esc });
  assert.doesNotMatch(clean, /tool-call-failure-summary/);
});

test('read summary displays the final selected line index', () => {
  const summary = formatToolCallSummary('read_file', {
    path: 'README.md',
    offset: 0,
    limit: 10,
  });

  assert.equal(summary, 'Read README.md lines 0-9');
});

test('file-operation helpers format long elapsed times and summarize batch moves', () => {
  const moves = [
    { source: 'a.txt', destination: 'archive/a.txt' },
    { source: 'b.txt', destination: 'archive/b.txt' },
  ];

  assert.equal(formatToolElapsedLabel(3_903_000), '1:05:03');
  assert.equal(formatToolCallSummary('move_file', { moves }), 'Move 2 files');
  assert.equal(getToolPrimaryPath('move_file', { moves }), 'archive/a.txt');
});

test('file-operation settled state covers every terminal status', () => {
  for (const status of ['running', 'executing', 'requested', 'approved', 'awaiting_approval', '']) {
    assert.equal(isFileOperationSettledStatus(status), false, status || 'blank');
  }
  for (const status of [
    'completed', 'errored', 'denied', 'cancelled', 'blocked',
    'timed_out', 'interrupted', 'abandoned',
  ]) {
    assert.equal(isFileOperationSettledStatus(status), true, status);
  }
});

test('only a call awaiting approval opens itself; finished rows stay collapsed', () => {
  assert.equal(shouldAutoExpandToolDetails('awaiting_approval'), true);

  for (const status of [
    'errored', 'denied', 'cancelled', 'blocked',
    'timed_out', 'interrupted', 'abandoned', 'completed',
  ]) {
    assert.equal(
      shouldAutoExpandToolDetails(status),
      false,
      status + ' rows must default collapsed',
    );
  }
});

test('approval facts use only each tool kind\'s declared effect parameter', () => {
  const cases = [
    ['run_command', { command: 'npm test' }, [{ kind: 'execute', label: 'Jenny cannot check what this does' }]],
    ['python_execute', { code: 'print(1)' }, [{ kind: 'execute', label: 'Jenny cannot check what this does' }]],
    ['run_temp_script', { script: 'echo ok' }, [{ kind: 'execute', label: 'Jenny cannot check what this does' }]],
    ['read_file', { path: 'README.md' }, [{ kind: 'read', label: 'Reads README.md' }]],
    ['write_file', { path: 'out.txt' }, [{ kind: 'write', label: 'Writes out.txt' }]],
    ['edit_file', { file_path: 'app.js' }, [{ kind: 'write', label: 'Changes app.js' }]],
    ['delete_file', { path: 'old.txt' }, [{ kind: 'delete', label: 'Deletes old.txt' }]],
    ['fetch_url', { url: 'https://example.com:8443/private?q=secret' }, [{ kind: 'network', label: 'Connects to example.com:8443' }]],
    ['web_search', { query: 'current weather' }, [{ kind: 'network', label: 'Searches the web' }]],
    ['glob_files', { pattern: '*.js', path: 'src' }, [{ kind: 'read', label: 'Reads file names under src' }]],
    ['grep_search', { pattern: 'TODO', path: 'src' }, [{ kind: 'read', label: 'Reads files under src' }]],
  ];

  assert.deepEqual(APPROVAL_FACT_KINDS, {
    READ: 'read', WRITE: 'write', DELETE: 'delete', NETWORK: 'network', EXECUTE: 'execute',
  });
  for (const [toolName, input, expected] of cases) {
    assert.deepEqual(getApprovalFacts(toolName, input), expected, toolName);
    assert.deepEqual(getApprovalFacts(toolName, { purpose: 'Explain the call' }), [], toolName + ' without effect parameter');
  }
});

test('move approval facts describe declared source and destination in consequence order', () => {
  assert.deepEqual(getApprovalFacts('move_file', { source: 'old.txt', destination: 'new.txt' }), [
    { kind: 'delete', label: 'Removes old.txt' },
    { kind: 'write', label: 'Writes new.txt' },
  ]);
  assert.deepEqual(getApprovalFacts('move_file', {
    moves: [
      { source: 'a.txt', destination: 'archive/a.txt' },
      { source: 'b.txt', destination: 'archive/b.txt' },
    ],
  }), [
    { kind: 'delete', label: 'Removes 2 source paths' },
    { kind: 'write', label: 'Writes 2 destination paths' },
  ]);
  assert.deepEqual(getApprovalFacts('move_file', { source: 'old.txt' }), []);
});

test('opaque command and code bodies never manufacture inferred facts', () => {
  assert.deepEqual(getApprovalFacts('run_command', { command: 'rm -rf /' }), [
    { kind: 'execute', label: 'Jenny cannot check what this does' },
  ]);
  assert.equal(getApprovalFacts('run_command', { command: 'rm -rf /' }).some((fact) => fact.kind === 'delete'), false);

  assert.deepEqual(getApprovalFacts('python_execute', { code: 'requests.get("https://example.com")' }), [
    { kind: 'execute', label: 'Jenny cannot check what this does' },
  ]);
  assert.equal(getApprovalFacts('python_execute', { code: 'requests.get("https://example.com")' })
    .some((fact) => fact.kind === 'network'), false);
  assert.deepEqual(getApprovalFacts('unlisted_tool', { path: 'secret.txt', url: 'https://example.com' }), []);
});

test('unknown approval previews use bounded flat lines and preserve nested JSON', () => {
  assert.equal(getApprovalCommandPreview('unlisted_tool', {
    alpha: 'one',
    count: 2,
    enabled: false,
  }), 'alpha: one\ncount: 2\nenabled: false');

  assert.equal(getApprovalCommandPreview('unlisted_tool', {
    config: { mode: 'safe' },
  }), '{\n  "config": {\n    "mode": "safe"\n  }\n}');

  const preview = getApprovalCommandPreview('unlisted_tool', {
    enormous: 'x'.repeat(1000),
    visible: 'still here',
  });
  const [firstLine, secondLine] = preview.split('\n');
  assert.equal(firstLine.length, 'enormous: '.length + 240);
  assert.equal(firstLine.endsWith('...'), true);
  assert.equal(secondLine, 'visible: still here');
});

test('approval purpose is normalized, bounded, and excluded from every preview path', () => {
  assert.equal(getApprovalPurpose({ purpose: '  Explain\n what\twill happen.  ' }), 'Explain what will happen.');
  assert.equal(getApprovalPurpose({ purpose: 42 }), '');
  assert.equal(getApprovalPurpose({ purpose: 'x'.repeat(1000) }).length, 240);

  assert.equal(getApprovalCommandPreview('run_command', {
    command: 'npm test',
    purpose: 'Run the focused tests',
  }), 'npm test');
  assert.equal(getApprovalCommandPreview('unlisted_tool', {
    purpose: 'Summarize the call',
    count: 2,
  }), 'count: 2');
  assert.equal(getApprovalCommandPreview('unlisted_tool', {
    purpose: 'Summarize the call',
    config: { mode: 'safe' },
  }), '{\n  "config": {\n    "mode": "safe"\n  }\n}');
  assert.equal(getApprovalCommandPreview('unlisted_tool', { purpose: 'Only purpose' }), '');
});

test('every approval-gated manifest tool (plus fetch_url) declares optional purpose', () => {
  // Derived from the manifest and the policy defaults so a new approval-gated
  // tool cannot ship without the field: an approval card with no stated
  // intent shows only the derived prompt. A side-effecting tool whose default
  // policy is 'auto' (verify) never shows a card; fetch_url is read-only but
  // reaches the network.
  const { DEFAULT_TOOL_DEFAULTS } = require('../services/tools/tool-policy-evaluator');
  const manifestPath = path.join(__dirname, '..', 'services', 'tools', 'tool-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const expectedNames = [...new Set([
    ...manifest.tools
      .filter((tool) => tool.side_effecting === true && DEFAULT_TOOL_DEFAULTS[tool.name] !== 'auto')
      .map((tool) => tool.name),
    'fetch_url',
  ])].sort();
  assert.equal(expectedNames.length, 15, expectedNames.join(','));
  assert.equal(expectedNames.includes('exit_plan_mode'), false, 'the plan card is not an intent card');
  const withPurpose = manifest.tools
    .filter((tool) => tool.parameters?.properties?.purpose)
    .map((tool) => tool.name)
    .sort();

  assert.deepEqual(withPurpose, expectedNames);
  for (const toolName of expectedNames) {
    const tool = manifest.tools.find((candidate) => candidate.name === toolName);
    assert.deepEqual(tool.parameters.properties.purpose, {
      type: 'string',
      description: "One short plain sentence explaining what will happen in the user's terms.",
    });
    assert.equal(tool.parameters.required?.includes('purpose') || false, false, toolName);
  }
});

test('tools reaching the renderer under their manifest name get a real preview, not a dump', () => {
  // TOOL_KIND_ALIASES never rewrites glob_files/grep_search, so a switch that
  // matched only the 'Glob'/'Grep' aliases sent both to the JSON fallback.
  for (const toolName of ['glob_files', 'Glob', 'grep_search', 'Grep']) {
    assert.equal(
      getApprovalCommandPreview(toolName, { pattern: 'src/**/*.js', path: 'renderer' }),
      'src/**/*.js',
      `${toolName} must preview its pattern`
    );
  }
  assert.equal(
    getApprovalCommandPreview('run_temp_script', { script: 'print(1)', language: 'python' }),
    'print(1)'
  );
});

test('move_file previews each source and destination pair', () => {
  assert.equal(
    getApprovalCommandPreview('move_file', { source: 'a.txt', destination: 'b.txt' }),
    'a.txt -> b.txt'
  );
  assert.equal(
    getApprovalCommandPreview('move_file', {
      moves: [
        { source: 'a.txt', destination: 'b.txt' },
        { source: 'c.txt', destination: 'd.txt' },
      ],
      purpose: 'Tidy the tree',
    }),
    'a.txt -> b.txt\nc.txt -> d.txt'
  );
});

test('a bounded purpose keeps its ellipsis inside the bound', () => {
  const bounded = getApprovalPurpose({ purpose: 'x'.repeat(400) });
  assert.equal(bounded.length, 240);
  assert.ok(bounded.endsWith('...'));
  // Surrogate pairs must not be split into a broken code unit.
  const emoji = getApprovalPurpose({ purpose: '😀'.repeat(400) });
  assert.equal(Array.from(emoji).length, 240);
});

test('declared arguments that widen an effect surface as facts', () => {
  // recursive, cwd and overwrite are declared inputs, not inferred from free
  // text, so stating them on the card is safe and omitting them was the defect:
  // a recursive delete read exactly like a single-file one.
  assert.deepEqual(getApprovalFacts('delete_file', { path: 'build', recursive: true }), [
    { kind: 'delete', label: 'Deletes build and everything under it' },
  ]);
  assert.deepEqual(getApprovalFacts('delete_file', { path: 'build', recursive: 'yes' }), [
    { kind: 'delete', label: 'Deletes build' },
  ]);
  assert.deepEqual(getApprovalFacts('run_command', { command: 'npm test', cwd: 'packages/app' }), [
    { kind: 'execute', label: 'Jenny cannot check what this does' },
    { kind: 'execute', label: 'Runs in packages/app' },
  ]);
  assert.deepEqual(getApprovalFacts('run_temp_script', { script: 'echo hi', cwd: 'tmp' }), [
    { kind: 'execute', label: 'Jenny cannot check what this does' },
    { kind: 'execute', label: 'Runs in tmp' },
  ]);
  assert.deepEqual(getApprovalFacts('python_execute', { code: 'print(1)', cwd: 'ignored' }), [
    { kind: 'execute', label: 'Jenny cannot check what this does' },
  ]);
  assert.deepEqual(getApprovalFacts('move_file', { source: 'a.txt', destination: 'b.txt', overwrite: true }), [
    { kind: 'delete', label: 'Removes a.txt' },
    { kind: 'write', label: 'Replaces b.txt' },
  ]);
  assert.deepEqual(getApprovalFacts('move_file', {
    moves: [{ source: 'a', destination: 'b' }, { source: 'c', destination: 'd' }], overwrite: true,
  }), [
    { kind: 'delete', label: 'Removes 2 source paths' },
    { kind: 'write', label: 'Replaces 2 destination paths' },
  ]);
});

test('tool approval facts exposes the extracted factory and preserves toolCallUtils behavior', () => {
  const toolApprovalFacts = require('../renderer/chat/tool-approval-facts');
  const toolCallUtils = require('../renderer/chat/tool-call-utils');

  assert.equal(typeof toolApprovalFacts.createToolApprovalFacts, 'function');
  assert.deepEqual(toolApprovalFacts.APPROVAL_FACT_KINDS, toolCallUtils.APPROVAL_FACT_KINDS);
  assert.throws(() => toolApprovalFacts.createToolApprovalFacts({}), TypeError);

  const extracted = toolApprovalFacts.createToolApprovalFacts({
    normalizeToolKind: toolCallUtils.normalizeToolKind,
    normalizeString: (value) => String(value || '').trim(),
  });
  assert.deepEqual(
    extracted.getApprovalFacts('read_file', { path: 'a.txt' }),
    toolCallUtils.getApprovalFacts('read_file', { path: 'a.txt' })
  );
});
