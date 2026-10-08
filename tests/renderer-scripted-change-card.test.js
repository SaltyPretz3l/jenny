'use strict';

// Row 34 S5 step 2: the script tool card. run_command (and its Bash/bash
// aliases), run_temp_script and python_execute show their output first, then
// a "Changed files" section built from the shared .file-diff rows, with honest
// notices from scripted_change_review that never read as "no changes".

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const toolCallUtils = require('../renderer/chat/tool-call-utils');
const detailBody = require('../renderer/chat/renderer-tool-detail-body');
const toolShellUtils = require('../renderer/chat/renderer-tool-shell-utils');
const fileDiffBindings = require('../renderer/chat/renderer-file-diff-bindings');
const { escapeHtml } = require('../renderer/shared/string-utils');
const { withInventory } = require('./helpers/inventory-harness');
const { createTranscriptToolCallRenderer } = require('../renderer/chat/renderer-transcript-tool-calls');
const { createTurnRowToolRenderUtils } = require('../renderer/chat/renderer-turn-row-tool-render-utils');

function review(overrides = {}) {
  return {
    schema_version: 1,
    state: 'observed',
    certainty: 'observed_during_call',
    call_outcome: 'succeeded',
    changed_paths: ['src/app.py'],
    changed_path_count: 1,
    diff_count: 1,
    summary_only_count: 0,
    omitted_count: 0,
    coverage: 'git_status_paths',
    ...overrides,
  };
}

function fullDiff(path = 'src/app.py', overrides = {}) {
  return {
    diff_id: `scripted:${path}`, operation_index: 0, path, status: 'modified', review_state: 'full',
    body_kind: 'inline_hunks', additions: 2, deletions: 1, truncated: false, truncation_reason: null,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a = 1', '+a = 2', '+b = 3'] }],
    ...overrides,
  };
}

function summaryDiff(path, reason) {
  return {
    diff_id: `scripted:${path}`, operation_index: 1, path, status: 'modified', review_state: 'summary_only',
    body_kind: 'summary_only', additions: 0, deletions: 0, truncated: true, truncation_reason: reason, hunks: [],
  };
}

const SCRIPTED_MODELS = {
  run_command: (metadata, extra = {}) => ({
    toolName: 'run_command', toolKind: 'Bash', callId: 'call-cmd', sessionId: 'session-s5', domToken: 'cmd',
    input: { command: 'python fix.py' }, inputJson: '{"command":"python fix.py"}',
    outputText: '', metadata: { stdout: 'fixed\n', exit_code: 0, ...metadata }, ...extra,
  }),
  run_temp_script: (metadata, extra = {}) => ({
    toolName: 'run_temp_script', toolKind: 'run_temp_script', callId: 'call-temp', sessionId: 'session-s5', domToken: 'temp',
    input: { language: 'python', script: 'print("fixed")' }, inputJson: '{"language":"python","script":"print(\\"fixed\\")"}',
    outputText: '', metadata: { stdout: 'fixed\n', exit_code: 0, ...metadata }, ...extra,
  }),
  python_execute: (metadata, extra = {}) => ({
    toolName: 'python_execute', toolKind: 'python_execute', callId: 'call-py', sessionId: 'session-s5', domToken: 'py',
    input: { code: 'print("fixed")' }, inputJson: '{"code":"print(\\"fixed\\")"}',
    outputText: JSON.stringify({ stdout: 'fixed\n' }), metadata: { ...metadata }, ...extra,
  }),
};

function detailDoc(model) {
  const html = detailBody.createToolDetailBody({ toolCallUtils }).buildDetailBodyMarkup(model);
  return new JSDOM(`<body>${html}</body>`).window.document;
}

function shellDoc(t, model) {
  withInventory(t);
  const renderer = toolShellUtils.createToolShellRenderer({ escapeHtml, toolCallUtils, sanitizeHtmlFragment: null });
  const html = renderer.renderToolShell({
    displayToolName: model.toolName, summary: '', status: model.isError ? 'errored' : 'completed',
    statusLabel: '', isRunning: false, durationLabel: '', defaultExpanded: true, ...model,
    toolKind: model.toolName === 'run_command' ? 'run_command' : model.toolKind,
  });
  assert.ok(html, `${model.toolName} should render a shell`);
  return new JSDOM(`<body>${html}</body>`).window.document;
}

function renderers(t) {
  return [
    ['detail body', (model) => detailDoc(model)],
    ['shell', (model) => shellDoc(t, model)],
  ];
}

function kickers(doc) {
  return Array.from(doc.querySelectorAll('.tool-call-section-kicker'), (node) => node.textContent.trim());
}

function changedFilesSection(doc) {
  return Array.from(doc.querySelectorAll('.tool-call-section'))
    .find((section) => section.querySelector('.tool-call-section-kicker')?.textContent.trim() === 'Changed files') || null;
}

function noticeTexts(doc) {
  const section = changedFilesSection(doc);
  return section ? Array.from(section.querySelectorAll('.tool-call-empty'), (node) => node.textContent.trim()) : [];
}

test('all three scripted tools render their output, then the changed files', (t) => {
  fileDiffBindings.disposeFileDiffBindings();
  t.after(() => fileDiffBindings.disposeFileDiffBindings());
  for (const [label, render] of renderers(t)) {
    for (const [toolName, build] of Object.entries(SCRIPTED_MODELS)) {
      const doc = render(build({ diffs: [fullDiff()], scripted_change_review: review() }));
      const names = kickers(doc);
      const changedAt = names.indexOf('Changed files');
      assert.ok(changedAt > 0, `${label} ${toolName}: Changed files section present after output (${names})`);
      assert.ok(names.slice(0, changedAt).some((name) => /Stdout|Output/.test(name)), `${label} ${toolName}: output first`);
      const section = changedFilesSection(doc);
      const rows = section.querySelectorAll('.file-diff');
      assert.equal(rows.length, 1, `${label} ${toolName}: one diff row`);
      assert.equal(section.querySelector('.file-diff-basename').textContent, 'app.py');
      assert.equal(section.querySelector('.file-diff-count-add').textContent, '+2');
      assert.ok(doc.body.textContent.includes('fixed'), `${label} ${toolName}: output text kept`);
      assert.equal(noticeTexts(doc).length, 0, `${label} ${toolName}: an observed review adds no notice`);
    }
  }
});

test('a sensitive file renders path-only with the secrets note; other summary-only rows keep their look', (t) => {
  for (const [label, render] of renderers(t)) {
    const doc = render(SCRIPTED_MODELS.run_command({
      diffs: [summaryDiff('.env', 'sensitive_path'), summaryDiff('big.log', 'time_limit')],
      scripted_change_review: review({ state: 'partial', changed_path_count: 2, summary_only_count: 2 }),
    }));
    const [sensitive, other] = changedFilesSection(doc).querySelectorAll('.file-diff');
    assert.equal(sensitive.querySelector('.file-diff-basename').textContent, '.env');
    assert.equal(sensitive.querySelector('.file-diff-truncated').textContent, 'contents not shown: looks like a secrets file');
    assert.equal(sensitive.querySelector('.file-diff-body'), null, `${label}: no diff body for a sensitive file`);
    assert.equal(sensitive.querySelector('.file-diff-chevron'), null);
    assert.equal(sensitive.querySelector('.file-diff-open'), null, `${label}: path only, no editor link`);
    assert.equal(other.querySelector('.file-diff-truncated').textContent, 'too large to show inline');
  }
});

test('unavailable and unsupported reviews say so honestly and never read as no changes', (t) => {
  const cases = [
    [review({ state: 'unavailable', reason: 'probe_failed', changed_paths: [], changed_path_count: 0 }), "Couldn't check which files changed"],
    [review({ state: 'unavailable', reason: 'status_over_limit', changed_paths: [], changed_path_count: 0 }), "Couldn't check which files changed"],
    [review({ state: 'unsupported', reason: 'not_git', changed_paths: [], changed_path_count: 0 }), 'Change tracking needs a git folder'],
  ];
  for (const [label, render] of renderers(t)) {
    for (const [scriptedReview, copy] of cases) {
      for (const build of Object.values(SCRIPTED_MODELS)) {
        const doc = render(build({ scripted_change_review: scriptedReview }));
        assert.deepEqual(noticeTexts(doc), [copy], `${label}: ${scriptedReview.state}/${scriptedReview.reason}`);
        assert.doesNotMatch(doc.body.textContent, /no changes/i);
      }
    }
  }
});

test('a background start and a background finish carry their own copy', (t) => {
  for (const [label, render] of renderers(t)) {
    const started = render(SCRIPTED_MODELS.run_command({
      scripted_change_review: review({ state: 'unavailable', reason: 'background', changed_paths: [], changed_path_count: 0 }),
    }));
    assert.deepEqual(noticeTexts(started), ['Changes are checked when it finishes'], label);

    const finished = render(SCRIPTED_MODELS.run_command({
      diffs: [fullDiff('a.py'), fullDiff('b.py'), fullDiff('c.py')],
      scripted_change_review: review({ certainty: 'background_window', changed_path_count: 3, diff_count: 3 }),
    }));
    assert.deepEqual(noticeTexts(finished), ['3 files changed while it ran (may include other edits)'], label);
    assert.equal(changedFilesSection(finished).querySelectorAll('.file-diff').length, 3);

    const single = render(SCRIPTED_MODELS.run_command({
      diffs: [fullDiff('a.py')],
      scripted_change_review: review({ certainty: 'background_window', changed_path_count: 1 }),
    }));
    assert.deepEqual(noticeTexts(single), ['1 file changed while it ran (may include other edits)'], label);
  }
});

test('files over the cap are counted, not dropped silently', (t) => {
  for (const [label, render] of renderers(t)) {
    const doc = render(SCRIPTED_MODELS.python_execute({
      diffs: [fullDiff()],
      scripted_change_review: review({ state: 'partial', changed_path_count: 56, omitted_count: 55 }),
    }));
    assert.deepEqual(noticeTexts(doc), ['55 more files not shown'], label);
  }
});

test('an observed review with no changed paths leaves the card unchanged', (t) => {
  for (const [label, render] of renderers(t)) {
    const doc = render(SCRIPTED_MODELS.run_command({
      scripted_change_review: review({ changed_paths: [], changed_path_count: 0, diff_count: 0 }),
    }));
    assert.equal(changedFilesSection(doc), null, label);
  }
});

test('a failed python_execute keeps its error and still shows the changed files after it', (t) => {
  for (const [label, render] of renderers(t)) {
    const doc = render(SCRIPTED_MODELS.python_execute({
      diffs: [fullDiff()],
      scripted_change_review: review({ call_outcome: 'failed' }),
    }, {
      isError: true, status: 'errored',
      outputText: JSON.stringify({ stdout: 'half done\n', error: { message: 'ValueError: bad', traceback: 'Traceback\nValueError: bad' } }),
    }));
    const names = kickers(doc);
    const errorAt = names.findIndex((name) => /Error/.test(name));
    const changedAt = names.indexOf('Changed files');
    assert.ok(errorAt >= 0, `${label}: error shown (${names})`);
    assert.ok(changedAt > errorAt, `${label}: changed files after the error (${names})`);
    assert.ok(doc.body.textContent.includes('ValueError: bad'));
    assert.equal(changedFilesSection(doc).querySelectorAll('.file-diff').length, 1);
  }
});

test('a failed run_command keeps its exit presentation and shows the changed files', (t) => {
  for (const [label, render] of renderers(t)) {
    const doc = render(SCRIPTED_MODELS.run_command({
      exit_code: 1, stderr: 'boom', diffs: [fullDiff()], scripted_change_review: review({ call_outcome: 'failed' }),
    }, { isError: true, status: 'errored' }));
    assert.ok(doc.querySelector('.bash-exit-badge'), `${label}: exit badge kept`);
    assert.match(doc.querySelector('.bash-exit-badge').textContent, /exit 1/);
    assert.equal(changedFilesSection(doc).querySelectorAll('.file-diff').length, 1, label);
  }
});

test('long output stays clamped at ten lines in the detail body when files changed', () => {
  const stdout = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n');
  const doc = detailDoc(SCRIPTED_MODELS.run_command({ stdout, diffs: [fullDiff()] }));
  const stdoutSection = Array.from(doc.querySelectorAll('.tool-call-section'))
    .find((section) => section.querySelector('.tool-call-section-kicker')?.textContent.trim() === 'Stdout');
  assert.equal(stdoutSection.querySelector('pre').getAttribute('data-detail-clamped'), 'true');
  assert.match(stdoutSection.querySelector('.tool-detail-toggle').textContent, /Show 20 more lines/);
});

test('header meta counts files and full/partial lines for scripted tools only', () => {
  const metadata = {
    diffs: [fullDiff('a.py'), fullDiff('b.py', { review_state: 'partial', additions: 3, deletions: 0 }), summaryDiff('.env', 'sensitive_path')],
    scripted_change_review: review({ state: 'partial', changed_path_count: 4 }),
  };
  for (const name of ['run_command', 'Bash', 'bash', 'run_temp_script', 'python_execute']) {
    assert.deepEqual(toolCallUtils.getToolLineCounts(name, metadata, 'completed', false), { files: 4, additions: 5, deletions: 1 }, name);
    assert.deepEqual(toolCallUtils.getToolLineCounts(name, metadata, 'errored', true), { files: 4, additions: 5, deletions: 1 }, `${name} failed`);
  }
  assert.deepEqual(
    toolCallUtils.getToolLineCounts('run_command', { diffs: [summaryDiff('.env', 'sensitive_path')] }, 'completed', false),
    { files: 1 },
    'no +/- when no diff carries reviewable lines; files fall back to the diff count'
  );
  assert.equal(toolCallUtils.getToolLineCounts('run_command', { diffs: [] }, 'completed', false), null);
  assert.equal(toolCallUtils.getToolLineCounts('run_command', { scripted_change_review: review() }, 'completed', false), null);
  assert.equal(toolCallUtils.getToolLineCounts('run_command', { diff: fullDiff() }, 'completed', false), null);
  assert.deepEqual(toolCallUtils.getToolLineCounts('Edit', { diff: fullDiff() }, 'completed', false), { additions: 2, deletions: 1 });
});

function renderRows(toolName, meta, isError = false) {
  const input = { command: 'python fix.py' };
  const result = { call_id: 'call-s5', tool_name: toolName, metadata: meta, is_error: isError, duration_ms: 300 };
  const use = { id: 'use-s5', role: 'assistant', kind: 'tool_use', tool_call: { call_id: 'call-s5', tool_name: toolName, input, status: 'running' } };
  const message = { id: 'result-s5', role: 'tool', kind: 'tool_result', tool_result: result };
  const transcript = createTranscriptToolCallRenderer({ escapeHtml, toolCallUtils });
  const timeline = createTurnRowToolRenderUtils({ escapeHtml });
  return [
    transcript.renderToolCallBlock(use, [use, message], {}),
    timeline.buildToolCallRowMarkup({ row_id: 'row-s5', payload: { tool_call_id: 'call-s5', tool_name: toolName, input, state: 'running' } }, [message], {
      pairedToolResultRow: { primary_message_id: message.id, payload: result },
    }),
  ];
}

test('both header render paths show "{n} files changed · +a −d" for a scripted call', () => {
  const meta = {
    stdout: 'ok', exit_code: 1,
    diffs: [fullDiff('a.py'), fullDiff('b.py')],
    scripted_change_review: review({ changed_path_count: 2, call_outcome: 'failed' }),
  };
  for (const markup of renderRows('run_command', meta, true)) {
    const doc = new JSDOM(markup).window.document;
    const counts = doc.querySelector('.tool-call-status-cluster > .tool-call-line-counts');
    assert.ok(counts, 'count group present');
    assert.equal(counts.querySelector('.tool-call-line-files').textContent, '2 files changed');
    assert.equal(counts.querySelector('.tool-call-line-add').textContent, '+4');
    assert.equal(counts.querySelector('.tool-call-line-remove').textContent, '−2');
    assert.match(counts.textContent.replace(/\s+/g, ' '), /2 files changed · /);
  }
  for (const markup of renderRows('python_execute', { diffs: [summaryDiff('.env', 'sensitive_path')] })) {
    const doc = new JSDOM(markup).window.document;
    assert.equal(doc.querySelector('.tool-call-line-files').textContent, '1 file changed');
    assert.equal(doc.querySelector('.tool-call-line-add'), null);
  }
});
