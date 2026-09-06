'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { JSDOM } = require('jsdom');

const { createCodeReviewRenderer } = require('../renderer/features/renderer-code-review-render');
const { renderDiffHunks } = require('../renderer/chat/renderer-diff-hunks-render');
const { buildSessionDiffReviewModel, resolveReviewScope } = require('../renderer/chat/renderer-session-diff-review-model');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function change(overrides = {}) {
  return {
    changeId: 'change_1',
    diffId: 'change_1',
    operationIndex: 0,
    workspaceId: 'default',
    fileKey: 'default:src/app.js',
    path: 'src/app.js',
    oldPath: null,
    turnId: 'turn_1',
    sourceMessageId: 'tool_result_1',
    toolCallId: 'call_1',
    toolName: 'Write',
    status: 'modified',
    reviewState: 'full',
    reviewable: true,
    bodyKind: 'inline_hunks',
    additions: 1,
    deletions: 0,
    truncated: false,
    truncationReason: null,
    beforeHash: null,
    afterHash: 'sha256:bb',
    hashKind: 'diff_input_text',
    hunks: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        lines: [' const a = 1;', '+const b = 2;'],
      },
    ],
    ...overrides,
  };
}

function makeSurface(dom) {
  const detailPanel = dom.window.document.createElement('div');
  detailPanel.className = 'artifact-review-detail-panel';
  detailPanel.dataset.artifactReviewMode = 'code_review';
  const detailEmpty = dom.window.document.createElement('div');
  detailEmpty.className = 'context-empty-state';
  return { key: 'split', detailPanel, detailEmpty };
}

test('code-review renderer emits empty state when scope has no changes', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const surface = makeSurface(dom);
  const renderer = createCodeReviewRenderer({ escapeHtml, renderDiffHunks });
  const model = buildSessionDiffReviewModel([], { sessionId: 'session_empty' });
  const scope = resolveReviewScope(model, { type: 'session' });
  renderer.renderInto(surface, { sessionModel: model, scopeResult: scope, selectedChangeId: '' });
  assert.ok(/No Jenny-authored code changes in this session/.test(surface.detailPanel.innerHTML));
  assert.equal(surface.detailEmpty.classList.contains('hidden'), true);
});

test('code-review renderer groups changes by file and renders selected diff', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const surface = makeSurface(dom);
  const renderer = createCodeReviewRenderer({ escapeHtml, renderDiffHunks });
  const changes = [
    change({ changeId: 'c1', fileKey: 'default:a.js', path: 'a.js', turnId: 't1' }),
    change({ changeId: 'c2', fileKey: 'default:a.js', path: 'a.js', turnId: 't2', additions: 4, deletions: 1 }),
    change({ changeId: 'c3', fileKey: 'default:b.js', path: 'b.js', turnId: 't2', additions: 0, deletions: 0, status: 'created', hunks: [] }),
  ];
  const model = buildSessionDiffReviewModel(changes, { sessionId: 'session_1' });
  const scope = resolveReviewScope(model, { type: 'session' });
  renderer.renderInto(surface, { sessionModel: model, scopeResult: scope, selectedChangeId: 'c1' });
  const html = surface.detailPanel.innerHTML;
  assert.ok(html.includes('jenny-code-review-file-row'));
  assert.ok(/data-file-key="default:a\.js"/.test(html));
  assert.ok(/data-file-key="default:b\.js"/.test(html));
  // Selected change pane should render the diff container with hunk markup
  assert.ok(html.includes('jenny-code-review-diff-container'));
  assert.ok(/diff-line-add/.test(html));
  // Jump-to-chat affordance carries the source_message_id
  assert.ok(/data-jenny-jump-to-chat="tool_result_1"/.test(html));
  // Scope label rendered
  assert.ok(/Session scope/.test(html));
});

test('code-review renderer applies ARIA listbox semantics and roving tabindex', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const surface = makeSurface(dom);
  const renderer = createCodeReviewRenderer({ escapeHtml, renderDiffHunks });
  const changes = [
    change({ changeId: 'c1', fileKey: 'default:a.js', path: 'a.js', turnId: 't1' }),
    change({ changeId: 'c2', fileKey: 'default:a.js', path: 'a.js', turnId: 't2', additions: 4, deletions: 1 }),
    change({ changeId: 'c3', fileKey: 'default:b.js', path: 'b.js', turnId: 't2', status: 'created', hunks: [] }),
  ];
  const model = buildSessionDiffReviewModel(changes, { sessionId: 'session_aria' });
  const scope = resolveReviewScope(model, { type: 'session' });
  renderer.renderInto(surface, { sessionModel: model, scopeResult: scope, selectedChangeId: 'c1' });
  const root = surface.detailPanel.querySelector('.jenny-code-review-root');
  assert.ok(root, 'expected rendered root');
  assert.equal(root.getAttribute('role'), 'region');
  assert.equal(root.getAttribute('aria-labelledby'), 'jenny-code-review-title');
  const title = root.querySelector('h2.jenny-code-review-title');
  assert.equal(title?.id, 'jenny-code-review-title');
  const closeButton = root.querySelector('[data-jenny-code-review-close]');
  assert.ok(closeButton, 'expected close button in header');
  assert.equal(closeButton.getAttribute('aria-label'), 'Close code review');
  const fileList = root.querySelector('.jenny-code-review-file-list');
  assert.equal(fileList.getAttribute('role'), 'listbox');
  assert.equal(fileList.getAttribute('aria-label'), 'Changed files');
  const nestedChangeLists = root.querySelectorAll('.jenny-code-review-change-list');
  assert.ok(nestedChangeLists.length >= 1, 'expected at least one nested change listbox');
  for (const list of nestedChangeLists) {
    assert.equal(list.getAttribute('role'), 'listbox');
    assert.ok(/^Operations in /.test(String(list.getAttribute('aria-label') || '')));
  }
  const options = Array.from(root.querySelectorAll('[role="option"]'));
  assert.ok(options.length > 0, 'expected option rows');
  for (const opt of options) {
    assert.ok(opt.hasAttribute('aria-selected'), 'every option must declare aria-selected');
    assert.ok(opt.hasAttribute('tabindex'), 'every option must declare tabindex');
    assert.ok(!opt.hasAttribute('aria-pressed'), 'aria-pressed must not survive the contract swap');
  }
  const focusable = options.filter((opt) => opt.getAttribute('tabindex') === '0');
  assert.equal(focusable.length, 1, 'exactly one option should be tabindex=0 (roving)');
  assert.equal(focusable[0].getAttribute('aria-selected'), 'true');
  assert.equal(focusable[0].dataset.changeId, 'c1');
  // In-row Jump button stays out of the tab sequence so the option row is the primary stop.
  const inRowJumps = Array.from(root.querySelectorAll('.jenny-code-review-jump:not(.jenny-code-review-jump--primary)'));
  for (const jump of inRowJumps) {
    assert.equal(jump.getAttribute('tabindex'), '-1');
  }
});

test('code-review renderer surfaces truncation reason without inline hunks', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const surface = makeSurface(dom);
  const renderer = createCodeReviewRenderer({ escapeHtml, renderDiffHunks });
  const changes = [
    change({
      changeId: 'c_truncated',
      reviewState: 'summary_only',
      bodyKind: 'summary_only',
      truncated: true,
      truncationReason: 'line_limit',
      hunks: [],
      additions: 200,
      deletions: 50,
    }),
  ];
  const model = buildSessionDiffReviewModel(changes, { sessionId: 'session_trunc' });
  const scope = resolveReviewScope(model, { type: 'change', changeId: 'c_truncated' });
  renderer.renderInto(surface, { sessionModel: model, scopeResult: scope, selectedChangeId: 'c_truncated' });
  const html = surface.detailPanel.innerHTML;
  assert.ok(/Diff truncated/.test(html));
  assert.ok(/jenny-change-review-state-pill/.test(html));
  // No diff-line-add / diff-line-remove because hunks are empty
  assert.ok(!/diff-line-add/.test(html));
});

test('code-review renderer reports failed diff state with explanatory copy', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const surface = makeSurface(dom);
  const renderer = createCodeReviewRenderer({ escapeHtml, renderDiffHunks });
  const changes = [
    change({
      changeId: 'c_failed',
      reviewState: 'failed',
      bodyKind: 'none',
      truncated: true,
      truncationReason: 'diff_generation_failed',
      hunks: [],
      additions: 0,
      deletions: 0,
    }),
  ];
  const model = buildSessionDiffReviewModel(changes, { sessionId: 'session_failed' });
  const scope = resolveReviewScope(model, { type: 'session' });
  renderer.renderInto(surface, { sessionModel: model, scopeResult: scope, selectedChangeId: 'c_failed' });
  const html = surface.detailPanel.innerHTML;
  assert.ok(/Diff generation failed/.test(html));
});

const TRUNCATION_BRANCH_CASES = [
  { reason: 'line_limit', body: 'summary_only', state: 'summary_only', hunks: false, copy: /Diff truncated — too many lines/ },
  { reason: 'byte_limit', body: 'summary_only', state: 'summary_only', hunks: false, copy: /Diff truncated — exceeded the inline byte limit/ },
  { reason: 'hunk_limit', body: 'summary_only', state: 'summary_only', hunks: false, copy: /Diff truncated — too many hunks/ },
  { reason: 'binary', body: 'summary_only', state: 'non_text', hunks: false, copy: /Diff omitted — binary content/ },
  { reason: 'decode_error', body: 'summary_only', state: 'failed', hunks: false, copy: /Diff omitted — file content could not be decoded/ },
  { reason: 'diff_generation_failed', body: 'none', state: 'failed', hunks: false, copy: /Diff generation failed/ },
  { reason: 'unknown', body: 'summary_only', state: 'summary_only', hunks: false, copy: /Diff truncated\.?/ },
];

for (const branch of TRUNCATION_BRANCH_CASES) {
  test(`code-review renderer renders truncationReason="${branch.reason}" copy in the body note`, () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const surface = makeSurface(dom);
    const renderer = createCodeReviewRenderer({ escapeHtml, renderDiffHunks });
    const changes = [
      change({
        changeId: `c_${branch.reason}`,
        reviewState: branch.state,
        bodyKind: branch.body,
        truncated: branch.reason !== 'diff_generation_failed',
        truncationReason: branch.reason,
        hunks: branch.hunks ? [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [' line'] }] : [],
        additions: 1,
        deletions: 1,
      }),
    ];
    const model = buildSessionDiffReviewModel(changes, { sessionId: `session_${branch.reason}` });
    const scope = resolveReviewScope(model, { type: 'change', changeId: `c_${branch.reason}` });
    renderer.renderInto(surface, { sessionModel: model, scopeResult: scope, selectedChangeId: `c_${branch.reason}` });
    const html = surface.detailPanel.innerHTML;
    assert.ok(branch.copy.test(html), `expected copy ${branch.copy} for truncationReason=${branch.reason}, got: ${html}`);
  });
}

test('code-review renderer renders non_text review state copy when reason absent', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const surface = makeSurface(dom);
  const renderer = createCodeReviewRenderer({ escapeHtml, renderDiffHunks });
  const changes = [
    change({
      changeId: 'c_non_text',
      reviewState: 'non_text',
      bodyKind: 'summary_only',
      truncated: false,
      truncationReason: null,
      hunks: [],
      additions: 0,
      deletions: 0,
    }),
  ];
  const model = buildSessionDiffReviewModel(changes, { sessionId: 'session_non_text' });
  const scope = resolveReviewScope(model, { type: 'change', changeId: 'c_non_text' });
  renderer.renderInto(surface, { sessionModel: model, scopeResult: scope, selectedChangeId: 'c_non_text' });
  const html = surface.detailPanel.innerHTML;
  assert.ok(/Non-text change/.test(html));
});
