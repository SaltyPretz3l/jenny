// Sibling of tests/renderer-turn-row-tool-render-utils.test.js (that file
// sits at the test-size ratchet): pins the running row's self-anchored live
// elapsed node (ticked by renderer-turn-elapsed-clock's transcript scan).
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTurnRowToolRenderUtils,
} = require('../renderer/chat/renderer-turn-row-tool-render-utils');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createToolRenderer(overrides = {}) {
  return createTurnRowToolRenderUtils({
    escapeHtml,
    normalizeId(value) {
      return String(value || '').trim();
    },
    formatDurationMs(ms) {
      const durationMs = Number(ms);
      return Number.isFinite(durationMs) && durationMs > 0 ? `${durationMs}ms` : '';
    },
    ...overrides,
  });
}

test('running row with a running anchor renders a self-anchored live elapsed node', () => {
  const renderer = createToolRenderer({ getNow: () => 8000 });
  const markup = renderer.buildToolCallRowMarkup({
    payload: {
      tool_call_id: 'call-elapsed',
      tool_name: 'run_command',
      state: 'running',
      running_started_at_ms: 1000,
    },
  }, [], {});

  assert.match(markup, /data-turn-elapsed="true"/);
  assert.match(markup, /data-elapsed-started-at="1000"/);
  assert.match(markup, /data-elapsed-running="true"/);
  // Seed label: 7000ms -> "0:07" (same M:SS grammar the transcript clock writes).
  assert.match(markup, /<span class="tool-result-duration"[^>]*>0:07<\/span>/);
});

test('running row without an anchor renders no live elapsed attributes', () => {
  const renderer = createToolRenderer();
  const markup = renderer.buildToolCallRowMarkup({
    payload: {
      tool_call_id: 'call-plain',
      tool_name: 'run_command',
      state: 'running',
    },
  }, [], {});

  assert.doesNotMatch(markup, /data-turn-elapsed/);
  assert.doesNotMatch(markup, /data-elapsed-started-at/);
});

test('settled row with a paired result keeps the plain duration label, never the live node', () => {
  const renderer = createToolRenderer({ getNow: () => 99999 });
  const markup = renderer.buildToolCallRowMarkup({
    payload: {
      tool_call_id: 'call-done',
      tool_name: 'run_command',
      state: 'running',
      running_started_at_ms: 1000,
    },
  }, [], {
    pairedToolResultRow: {
      payload: {
        tool_call_id: 'call-done',
        state: 'completed',
        duration_ms: 14,
        output_text: 'ok',
      },
    },
  });

  assert.doesNotMatch(markup, /data-turn-elapsed/);
  assert.match(markup, /<span class="tool-result-duration">14ms<\/span>/);
});

// ── Approval-gap command preview (same sibling file: the primary render-utils
// test file sits at the test-size ratchet) ──

const { renderApprovalBlock, resolveApprovalCardState } = require('../renderer/chat/renderer-approval-block');
const { livePendingApproval } = require('./helpers/exact-approval-fixtures');

// The renderer state of a live approval, carrying the backend's exact presentation.
function liveApprovalState(entry) {
  return { pendingToolApprovals: new Map([[entry.approvalId, livePendingApproval(entry)]]) };
}

function createApprovalRenderer(state) {
  return createToolRenderer({
    renderApprovalBlock,
    getApprovalCardState: (ref) => resolveApprovalCardState(state, ref),
  });
}

const APPROVAL_ROW = {
  payload: {
    approval_id: 'approval-approve',
    tool_call_id: 'call-approve',
    tool_name: 'run_command',
    prompt: 'Jenny wants to run: rm -rf build',
    input_json: JSON.stringify({ command: 'rm -rf build', timeout_seconds: 30 }),
    state: 'awaiting_approval',
  },
};

test('live approval gap row quotes the exact run_command command', () => {
  const state = liveApprovalState({
    approvalId: 'approval-approve',
    callId: 'call-approve',
    toolName: 'run_command',
    input: { command: 'rm -rf build', timeout_seconds: 30 },
  });
  const markup = createApprovalRenderer(state).buildApprovalGapMarkup(APPROVAL_ROW, [], {});

  assert.match(markup, /tool-approval-command/);
  assert.match(markup, /data-approval-exact-field="command"/);
  assert.match(markup, /rm -rf build/);
  assert.match(markup, /Allow once/);
});

test('approval gap row without the live exact presentation fails closed', () => {
  // Rehydrated after a restart: the persisted input_json is a redacted snapshot, never
  // shown as the command, and the card offers Deny only.
  const markup = createApprovalRenderer({}).buildApprovalGapMarkup(APPROVAL_ROW, [], {});

  assert.doesNotMatch(markup, /tool-approval-command/);
  assert.match(markup, /data-approval-exact-unavailable="missing"/);
  assert.doesNotMatch(markup, /Allow once|Always allow/);
  assert.match(markup, /Deny/);
});

// ── W1-4 clickable path chips (same sibling file, same ratchet reason) ──

test('file-target tool row stamps data-chat-path and renders the summary path as a chip', () => {
  const renderer = createToolRenderer();
  const markup = renderer.buildToolCallRowMarkup({
    payload: {
      tool_call_id: 'call-read',
      tool_name: 'Read',
      state: 'completed',
      input: { file_path: 'renderer\\chat\\a.js' },
    },
  }, [], {});

  // Row-level hook for the delegated context menu, forward-slash normalized.
  assert.match(markup, /data-chat-path="renderer\/chat\/a\.js"/);
  // Summary keeps its original text but the path portion becomes the chip.
  assert.match(markup, /<span class="tool-path-chip" role="link" tabindex="0" data-chat-path-open="renderer\/chat\/a\.js"[^>]*>renderer\\chat\\a\.js<\/span>/);
});

test('command tool rows render no path chip and no data-chat-path stamp', () => {
  const renderer = createToolRenderer();
  const markup = renderer.buildToolCallRowMarkup({
    payload: {
      tool_call_id: 'call-bash',
      tool_name: 'run_command',
      state: 'completed',
      input: { command: 'cat file_path.js' },
    },
  }, [], {});

  assert.doesNotMatch(markup, /data-chat-path/);
  assert.doesNotMatch(markup, /tool-path-chip/);
});

test('approval gap row markup degrades to prompt-only on unparsable input_json', () => {
  const approvalRenderer = createApprovalRenderer();
  const markup = approvalRenderer.buildApprovalGapMarkup({
    payload: {
      tool_call_id: 'call-broken',
      tool_name: 'run_command',
      prompt: 'Approve?',
      input_json: '{not json',
      state: 'awaiting_approval',
    },
  });

  assert.doesNotMatch(markup, /tool-approval-command/);
  assert.match(markup, /Approve\?/);
});
