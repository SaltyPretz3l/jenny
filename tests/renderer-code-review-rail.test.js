'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { JSDOM } = require('jsdom');

const { createCodeReviewRail } = require('../renderer/features/renderer-code-review-rail');
const { createCodeReviewRenderer } = require('../renderer/features/renderer-code-review-render');
const { renderDiffHunks } = require('../renderer/chat/renderer-diff-hunks-render');
const {
  buildSessionDiffReviewModel,
  resolveReviewScope,
} = require('../renderer/chat/renderer-session-diff-review-model');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function makeChange(overrides = {}) {
  return {
    changeId: 'c1',
    diffId: 'c1',
    operationIndex: 0,
    workspaceId: 'default',
    fileKey: 'default:a.js',
    path: 'a.js',
    oldPath: null,
    turnId: 't1',
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
    afterHash: null,
    hashKind: 'diff_input_text',
    hunks: [
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' x', '+y'] },
    ],
    ...overrides,
  };
}

function buildHarness(changes, options = {}) {
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<button id="opener">Review changes</button>'
    + '<div id="chatPane"><article class="chat-entry" tabindex="0" data-message-id="m1">Row 1</article></div>'
    + '<aside id="artifactReviewPanel"><div class="artifact-review-detail-panel"></div><div class="context-empty-state"></div></aside>'
    + '</body></html>');
  const { document } = dom.window;
  // Provide focus support hooks JSDOM needs (focus(), isConnected are native).
  const artifactReviewPanel = document.getElementById('artifactReviewPanel');
  const detailPanel = artifactReviewPanel.querySelector('.artifact-review-detail-panel');
  const detailEmpty = artifactReviewPanel.querySelector('.context-empty-state');
  const renderer = createCodeReviewRenderer({ escapeHtml, renderDiffHunks });

  const state = { ui: { artifactReview: { mode: 'artifact', enabled: true, collapsed: false } } };
  const log = [];
  const calls = { setArtifactRailMode: [], jumpToArtifactSource: [], syncCalls: 0, renderCalls: 0 };

  let model = buildSessionDiffReviewModel(changes, { sessionId: 'sess_1' });

  function renderRail() {
    if (state.ui.artifactReview.mode !== 'code_review') {
      detailPanel.innerHTML = '';
      return;
    }
    rail.renderRailContent({ key: 'split', detailPanel, detailEmpty });
  }

  const rail = createCodeReviewRail({
    state,
    dom: { artifactReviewPanel },
    codeReviewRenderer: renderer,
    buildJennyChangeLedgerFromTurnViewModels: () => ({ sessionId: 'sess_1', workspaceId: 'default', changes, skipped: [] }),
    buildSessionDiffReviewModel: (ledger) => buildSessionDiffReviewModel(ledger.changes, { sessionId: ledger.sessionId }),
    resolveReviewScope,
    getTurnViewModelsForActiveSession: () => [],
    getActiveSessionId: () => 'sess_1',
    getWorkspaceId: () => 'default',
    setArtifactRailMode: (mode) => {
      calls.setArtifactRailMode.push(mode);
      state.ui.artifactReview.mode = mode === 'code_review' ? 'code_review' : 'artifact';
      // Mirror onto the DOM the way renderer-artifacts-utils.syncArtifactReviewLayout would.
      artifactReviewPanel.dataset.artifactReviewMode = state.ui.artifactReview.mode;
    },
    renderArtifactReviewPanel: () => { calls.renderCalls += 1; renderRail(); },
    syncArtifactReviewLayout: () => { calls.syncCalls += 1; },
    jumpToArtifactSource: (id) => { calls.jumpToArtifactSource.push(id); },
    appendClientLog: (level, code, payload) => { log.push({ level, code, payload }); },
    showComposerActionError: () => {},
    ...options.depOverrides,
  });

  rail.bind();
  return { dom, document, rail, artifactReviewPanel, detailPanel, state, calls, log };
}

test('openCodeReviewTarget focuses the selected row after render', () => {
  const changes = [makeChange({ changeId: 'c1' }), makeChange({ changeId: 'c2', sourceMessageId: 'tool_result_2', turnId: 't2' })];
  const h = buildHarness(changes);
  const opener = h.document.getElementById('opener');
  opener.focus();
  assert.equal(h.document.activeElement, opener);
  const ok = h.rail.openCodeReviewTarget({ scope: 'change', changeId: 'c2', turnId: 't2', fileKey: 'default:a.js' });
  assert.equal(ok, true);
  assert.equal(h.state.ui.artifactReview.mode, 'code_review');
  const focused = h.document.activeElement;
  assert.ok(focused, 'expected focus to move into the rail');
  assert.equal(focused.getAttribute('role'), 'option');
  assert.equal(focused.dataset.changeId, 'c2');
  assert.equal(focused.getAttribute('aria-selected'), 'true');
});

test('handleRailKeydown ignores keys when mode !== code_review', () => {
  const h = buildHarness([makeChange()]);
  // Mode is artifact, no rail rendered; key handler should bail.
  const event = new h.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
  h.rail.handleRailKeydown(event);
  assert.equal(event.defaultPrevented, false);
});

test('ArrowDown/ArrowUp/Home/End move focus through options', () => {
  const changes = [
    makeChange({ changeId: 'c1', fileKey: 'default:a.js', path: 'a.js', turnId: 't1' }),
    makeChange({ changeId: 'c2', fileKey: 'default:a.js', path: 'a.js', turnId: 't1' }),
    makeChange({ changeId: 'c3', fileKey: 'default:b.js', path: 'b.js', turnId: 't2' }),
  ];
  const h = buildHarness(changes);
  h.rail.openCodeReviewTarget({ scope: 'session' });
  const options = Array.from(h.artifactReviewPanel.querySelectorAll('[role="option"]'));
  assert.ok(options.length >= 4, 'expected file + change options');
  // After open, focus is on first selected row. Simulate ArrowDown.
  function press(key) {
    const e = new h.dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    h.artifactReviewPanel.dispatchEvent(e);
    return e;
  }
  press('ArrowDown');
  const idx1 = options.indexOf(h.document.activeElement);
  assert.ok(idx1 >= 1, 'ArrowDown should move forward');
  press('ArrowDown');
  const idx2 = options.indexOf(h.document.activeElement);
  assert.equal(idx2, Math.min(idx1 + 1, options.length - 1));
  press('End');
  assert.equal(h.document.activeElement, options[options.length - 1]);
  press('Home');
  assert.equal(h.document.activeElement, options[0]);
  press('ArrowUp');
  assert.equal(h.document.activeElement, options[0], 'ArrowUp at top clamps');
});

test('Enter activates the focused option and refocuses the new selection', () => {
  const changes = [
    makeChange({ changeId: 'c1', fileKey: 'default:a.js', path: 'a.js' }),
    makeChange({ changeId: 'c2', fileKey: 'default:a.js', path: 'a.js' }),
  ];
  const h = buildHarness(changes);
  h.rail.openCodeReviewTarget({ scope: 'session' });
  // Focus the second change row.
  const changeRows = Array.from(h.artifactReviewPanel.querySelectorAll('[data-jenny-code-review-select="change"]'));
  const c2Btn = changeRows.find((opt) => opt.dataset.changeId === 'c2');
  c2Btn.focus();
  const enter = new h.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  h.artifactReviewPanel.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, true);
  // After re-render, the selected change is c2 and focus is on the new c2 button.
  const newFocused = h.document.activeElement;
  assert.equal(newFocused.getAttribute('role'), 'option');
  assert.equal(newFocused.dataset.changeId, 'c2');
  assert.equal(newFocused.getAttribute('aria-selected'), 'true');
});

test('Escape closes and restores focus to the opener', () => {
  const h = buildHarness([makeChange()]);
  const opener = h.document.getElementById('opener');
  opener.focus();
  h.rail.openCodeReviewTarget({ scope: 'change', changeId: 'c1', turnId: 't1', fileKey: 'default:a.js' });
  assert.equal(h.state.ui.artifactReview.mode, 'code_review');
  const escape = new h.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  h.artifactReviewPanel.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(h.state.ui.artifactReview.mode, 'artifact');
  assert.equal(h.document.activeElement, opener);
});

test('closeCodeReview falls back to first chat-entry when the opener detaches', () => {
  const h = buildHarness([makeChange()]);
  const opener = h.document.getElementById('opener');
  opener.focus();
  h.rail.openCodeReviewTarget({ scope: 'change', changeId: 'c1', turnId: 't1', fileKey: 'default:a.js' });
  // Remove the opener while the rail is open.
  opener.remove();
  h.rail.closeCodeReview();
  const chatEntry = h.document.querySelector('.chat-entry');
  assert.equal(h.document.activeElement, chatEntry, 'fallback should be the first .chat-entry');
});

test('re-open while already focused inside the rail preserves the original opener', () => {
  const h = buildHarness([makeChange({ changeId: 'c1' }), makeChange({ changeId: 'c2', turnId: 't2' })]);
  const opener = h.document.getElementById('opener');
  opener.focus();
  h.rail.openCodeReviewTarget({ scope: 'change', changeId: 'c1', turnId: 't1', fileKey: 'default:a.js' });
  assert.notEqual(h.document.activeElement, opener, 'focus should be in the rail');
  // Re-open a different scope without explicit close.
  h.rail.openCodeReviewTarget({ scope: 'change', changeId: 'c2', turnId: 't2', fileKey: 'default:a.js' });
  // Close once and ensure the ORIGINAL opener regains focus.
  h.rail.closeCodeReview();
  assert.equal(h.document.activeElement, opener);
});

test('rail click delegation still routes the close button', () => {
  const h = buildHarness([makeChange()]);
  const opener = h.document.getElementById('opener');
  opener.focus();
  h.rail.openCodeReviewTarget({ scope: 'change', changeId: 'c1', turnId: 't1', fileKey: 'default:a.js' });
  const closeBtn = h.artifactReviewPanel.querySelector('[data-jenny-code-review-close]');
  assert.ok(closeBtn, 'expected close button in rendered rail');
  closeBtn.click();
  assert.equal(h.state.ui.artifactReview.mode, 'artifact');
  assert.equal(h.document.activeElement, opener);
});

test('renderRailContent rebuilds cached review state after the active session changes', () => {
  let activeSessionId = 'session-1';
  const renderedSessions = [];
  const state = { ui: { artifactReview: { mode: 'code_review' } } };
  const rail = createCodeReviewRail({
    state,
    codeReviewRenderer: {
      renderInto: (_surface, payload) => renderedSessions.push(payload.scopeResult.sessionId),
    },
    buildJennyChangeLedgerFromTurnViewModels: () => ({ sessionId: activeSessionId, changes: [] }),
    buildSessionDiffReviewModel: (ledger) => ({ sessionId: ledger.sessionId }),
    resolveReviewScope: (model, scope) => ({ found: true, sessionId: model.sessionId, scope, changes: [] }),
    getActiveSessionId: () => activeSessionId,
  });

  assert.equal(rail.openCodeReviewTarget({ scope: 'session' }), true);
  activeSessionId = 'session-2';
  rail.renderRailContent({ detailPanel: {} });

  assert.deepEqual(renderedSessions, ['session-2']);
  assert.equal(state.ui.codeReview.sessionId, 'session-2');
});

test('clicking a file clears the prior change and turn selection', () => {
  const h = buildHarness([
    makeChange({ changeId: 'c1', fileKey: 'default:a.js', path: 'a.js', turnId: 't1' }),
    makeChange({ changeId: 'c2', fileKey: 'default:b.js', path: 'b.js', turnId: 't2' }),
  ]);
  h.rail.openCodeReviewTarget({ scope: 'session' });
  const fileB = h.artifactReviewPanel.querySelector('[data-jenny-code-review-select="file"][data-file-key="default:b.js"]');

  fileB.click();

  assert.equal(h.state.ui.codeReview.selectedChangeId, '');
  assert.equal(h.state.ui.codeReview.selectedTurnId, '');
  assert.equal(h.state.ui.codeReview.selectedFileKey, 'default:b.js');
  assert.equal(h.artifactReviewPanel.querySelector('.jenny-code-review-selected-path').textContent, 'b.js');
});

test('keyboard file selection clears the prior change and turn selection', () => {
  const h = buildHarness([
    makeChange({ changeId: 'c1', fileKey: 'default:a.js', path: 'a.js', turnId: 't1' }),
    makeChange({ changeId: 'c2', fileKey: 'default:b.js', path: 'b.js', turnId: 't2' }),
  ]);
  h.rail.openCodeReviewTarget({ scope: 'session' });
  const fileB = h.artifactReviewPanel.querySelector('[data-jenny-code-review-select="file"][data-file-key="default:b.js"]');
  fileB.focus();

  h.artifactReviewPanel.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true,
  }));

  assert.equal(h.state.ui.codeReview.selectedChangeId, '');
  assert.equal(h.state.ui.codeReview.selectedTurnId, '');
  assert.equal(h.state.ui.codeReview.selectedFileKey, 'default:b.js');
  assert.equal(h.artifactReviewPanel.querySelector('.jenny-code-review-selected-path').textContent, 'b.js');
});
