const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTurnRowToolRenderUtils,
  getToolStatusLabel,
  setToolRowExpansion,
  getToolRowExpansion,
  clearToolRowExpansionOverrides,
} = require('../renderer/chat/renderer-turn-row-tool-render-utils');
const toolCallUtils = require('../renderer/chat/tool-call-utils');
const { renderApprovalBlock, resolveApprovalCardState } = require('../renderer/chat/renderer-approval-block');
const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
const { projectPersistedEventsWithReducer } = require('../renderer/chat/renderer-stream-rehydrate');
const { projectRows } = require('./helpers/renderer-turn-row-projector-helpers');
const { livePendingApproval } = require('./helpers/exact-approval-fixtures');

// The renderer state of live approvals, each carrying the backend's exact presentation.
function liveApprovalState(...approvals) {
  return { pendingToolApprovals: new Map(approvals.map((entry) => [entry.approvalId, livePendingApproval(entry)])) };
}

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
    renderArtifactTeaser(artifact) {
      return `<span data-artifact-id="${escapeHtml(artifact && artifact.artifact_id)}">Artifact</span>`;
    },
    buildToolMarkerBannerMarkup(payload) {
      return payload && payload.marker ? `<aside data-marker="${escapeHtml(payload.marker)}"></aside>` : '';
    },
    renderApprovalBlock(request) {
      return `
        <div
          data-approval-id="${escapeHtml(request.approvalId)}"
          data-tool-call-id="${escapeHtml(request.toolCallId)}"
          data-mode="${escapeHtml(request.mode)}"
        >${escapeHtml(request.displayToolName)}:${escapeHtml(request.prompt)}</div>
      `;
    },
    ...overrides,
  });
}

function rowKeyFor(row, options = {}) {
  return toolCallUtils.buildToolRowKey({
    sessionId: options.sessionId,
    turnId: row.turn_id,
    rowId: row.row_id,
    messageId: row.primary_message_id,
    callId: row.payload && row.payload.tool_call_id,
  });
}

const MERMAID_SOURCE = 'graph TD\nA --> B';

function buildMermaidResultRow(overrides = {}) {
  return {
    payload: {
      tool_call_id: 'call-pair',
      tool_name: 'mermaid_generate',
      duration_ms: 14,
      result_summary: 'mermaid_generate',
      output_text: JSON.stringify({ mermaid: MERMAID_SOURCE, diagram_type: 'flowchart' }),
      state: 'completed',
      ...overrides,
    },
  };
}

test('approval gap markup folds a sealed row and keeps an awaiting row live', () => {
  // A sealed row folds once the runtime holds no approval for it.
  let state = {};
  const renderer = createToolRenderer({
    renderApprovalBlock,
    getApprovalCardState: (ref) => resolveApprovalCardState(state, ref),
  });
  const row = {
    kind: 'approval_gap',
    turn_id: 'turn-approval',
    tool_call_id: 'call-approval',
    payload: {
      approval_id: 'approval-1',
      tool_call_id: 'call-approval',
      tool_name: 'write_file',
      prompt: 'Allow edit?',
      state: 'interrupted',
    },
  };
  const inactiveHtml = renderer.buildApprovalGapMarkup(row, [], { sessionId: 'session-1' });
  state = liveApprovalState({
    approvalId: 'approval-1', callId: 'call-approval', toolName: 'write_file', input: { path: 'notes.md', content: 'hi' },
  });
  const liveHtml = renderer.buildApprovalGapMarkup({
    ...row,
    payload: { ...row.payload, state: 'awaiting_approval' },
  }, [], { sessionId: 'session-1' });

  assert.match(inactiveHtml, /data-approval-status="inactive"/);
  assert.match(inactiveHtml, /Approval no longer active/);
  assert.doesNotMatch(inactiveHtml, /Allow once|Always allow|Deny/);
  assert.match(liveHtml, /data-approval-status="pending"/);
  assert.match(liveHtml, /data-approval-exact-field="content"/);
  assert.match(liveHtml, /Allow once/);
  assert.match(liveHtml, /Always allow/);
  assert.match(liveHtml, /Deny/);

  // Rehydrated: the awaiting row has no live exact presentation, so the write has no Allow.
  state = {};
  const rehydratedHtml = renderer.buildApprovalGapMarkup({
    ...row,
    payload: { ...row.payload, state: 'awaiting_approval' },
  }, [], { sessionId: 'session-1' });
  assert.match(rehydratedHtml, /data-approval-exact-unavailable="missing"/);
  assert.doesNotMatch(rehydratedHtml, /Allow once|Always allow/);
  assert.match(rehydratedHtml, /Deny/);
});

test('plan approval gap keeps pending hold markup without generic controls while ordinary tools stay interactive', () => {
  const state = liveApprovalState({ approvalId: 'approval-write', callId: 'call-write', toolName: 'write_file', input: {} });
  const renderer = createToolRenderer({
    renderApprovalBlock,
    getApprovalCardState: (ref) => resolveApprovalCardState(state, ref),
  });
  const planProjection = projectRows([
    { id: 'user-plan', role: 'user', content: 'Plan the change' },
    {
      id: 'tool-use-plan',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call-plan',
        tool_name: 'exit_plan_mode',
        status: 'pending_approval',
        approval_state: 'pending',
        parent_stream_id: 'stream-plan',
      },
    },
    {
      id: 'plan-document-plan',
      role: 'assistant',
      kind: 'plan_document',
      plan_document: {
        plan_id: 'plan-1',
        tool_call_id: 'call-plan',
        state: 'pending',
        title: 'Build it',
        steps: ['Implement'],
        parent_stream_id: 'stream-plan',
      },
    },
  ]);
  const ordinaryProjection = projectRows([
    { id: 'user-write', role: 'user', content: 'Write the file' },
    {
      id: 'tool-use-write',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call-write',
        tool_name: 'write_file',
        status: 'pending_approval',
        approval_state: 'pending',
        parent_stream_id: 'stream-write',
      },
    },
  ]);
  const planHtml = renderer.buildApprovalGapMarkup(
    planProjection.rows.find((row) => row.kind === 'approval_gap')
  );
  const ordinaryHtml = renderer.buildApprovalGapMarkup(
    ordinaryProjection.rows.find((row) => row.kind === 'approval_gap')
  );
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(`<main>${planHtml}${ordinaryHtml}</main>`);
  const planGap = dom.window.document.querySelector('[data-tool-call-id="call-plan"].approval-gap-row');
  const ordinaryGap = dom.window.document.querySelector('[data-tool-call-id="call-write"].approval-gap-row');

  assert.ok(planGap);
  assert.equal(planGap.getAttribute('data-approval-status'), 'pending');
  assert.equal(planGap.getAttribute('data-approval-variant'), 'plan');
  assert.equal(planGap.querySelector('.tool-approval-block'), null);
  assert.equal(planGap.querySelector('.tool-approve-btn'), null);
  assert.equal(planGap.querySelector('.tool-deny-btn'), null);
  assert.equal(planGap.querySelector('.tool-approve-always-btn'), null);
  assert.ok(ordinaryGap);
  assert.equal(ordinaryGap.getAttribute('data-approval-variant'), null);
  assert.ok(ordinaryGap.querySelector('.tool-approve-btn'));
  assert.ok(ordinaryGap.querySelector('.tool-deny-btn'));
  assert.ok(ordinaryGap.querySelector('.tool-approve-always-btn'));
});

test('the approval gap card previews the full input object, never the capped input_json stub', () => {
  const { JSDOM } = require('jsdom');
  const code = Array.from({ length: 5 }, (_, index) => `print(${index})`).join('\n');
  const state = liveApprovalState({ approvalId: 'approval-full', callId: 'call-full', toolName: 'python_execute', input: { code } });
  const renderer = createToolRenderer({
    renderApprovalBlock, toolCallUtils, getApprovalCardState: (ref) => resolveApprovalCardState(state, ref),
  });
  const stub = JSON.stringify({ truncated: true, preview: '{"pattern":"needle...' });

  // Persisted rows past the input_json cap carry the {truncated, preview}
  // stub there while `input` is still the full sanitized object. (A tool
  // outside the exact-approval set: its preview still comes from the input.)
  const full = renderer.buildApprovalGapMarkup({
    kind: 'approval_gap', tool_call_id: 'call-grep',
    payload: { tool_name: 'grep_search', input: { pattern: 'needle(s)?', purpose: 'Find the needle' }, input_json: stub },
  });
  const fullDom = new JSDOM(`<main>${full}</main>`).window.document;
  assert.equal(fullDom.querySelector('.tool-approval-command').textContent, 'needle(s)?');
  assert.equal(fullDom.querySelector('.tool-approval-prompt').textContent, 'Jenny says Find the needle');

  // With only the stub available the card degrades to prompt-only rather
  // than quoting a JSON fragment as if it were the arguments.
  const stubOnly = renderer.buildApprovalGapMarkup({
    kind: 'approval_gap', tool_call_id: 'call-stub',
    payload: { tool_name: 'grep_search', prompt: 'Approve search?', input_json: stub },
  });
  const stubDom = new JSDOM(`<main>${stubOnly}</main>`).window.document;
  assert.equal(stubDom.querySelector('.tool-approval-command'), null);
  assert.equal(stubDom.querySelector('.tool-approval-prompt').textContent, 'Approve search?');

  // Older rows with input_json only still preview.
  const legacy = renderer.buildApprovalGapMarkup({
    kind: 'approval_gap', tool_call_id: 'call-legacy',
    payload: { tool_name: 'grep_search', input_json: JSON.stringify({ pattern: 'needle' }) },
  });
  const legacyDom = new JSDOM(`<main>${legacy}</main>`).window.document;
  assert.equal(legacyDom.querySelector('.tool-approval-command').textContent, 'needle');

  // Code is quoted from the live exact presentation, never the (redacted, clipped) row input.
  const python = renderer.buildApprovalGapMarkup({
    kind: 'approval_gap', tool_call_id: 'call-full',
    payload: { tool_name: 'python_execute', input: { code: 'print(0)...', purpose: 'Print five numbers' }, input_json: stub },
  });
  const pythonDom = new JSDOM(`<main>${python}</main>`).window.document;
  assert.equal(pythonDom.querySelector('[data-approval-exact-field="code"]').textContent, code);
  assert.equal(pythonDom.querySelector('.tool-approval-prompt').textContent, 'Jenny says Print five numbers');
  assert.ok(pythonDom.querySelector('.tool-approve-btn'));

  // A rehydrated command (no live approval) keeps its headline but has no Allow.
  const rehydrated = renderer.buildApprovalGapMarkup({
    kind: 'approval_gap', tool_call_id: 'call-rehydrated',
    payload: { tool_name: 'run_command', input_json: JSON.stringify({ command: 'npm test' }) },
  });
  const rehydratedDom = new JSDOM(`<main>${rehydrated}</main>`).window.document;
  assert.equal(rehydratedDom.querySelector('.tool-approve-btn'), null);
  assert.equal(rehydratedDom.querySelector('.tool-approval-command'), null);
  assert.ok(rehydratedDom.querySelector('[data-approval-exact-unavailable="missing"]'));
});

test('a paired propose_command result renders the proposal card, anything else keeps the tool row', async () => {
  const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');
  const store = require('../renderer/chat/renderer-proposal-card-store');
  const cardsModule = require('../renderer/chat/renderer-proposal-cards');
  const proposalId = `proposal_${'d'.repeat(64)}`;
  const gets = [];
  const savedWindow = globalThis.window;
  globalThis.window = { jennyShell: { sessionProposals: { get: async (request) => { gets.push(request); return null; }, onChanged: () => () => {} } } };
  Object.assign(globalThis, { rendererProposalCardStore: store, rendererProposalCards: cardsModule });
  try {
    const renderer = createTurnRowRenderUtils({ MESSAGE_STATUS: { STREAMING: 'streaming' }, escapeHtml });
    const call = { row_id: 'r1', turn_id: 't1', kind: 'tool_call', primary_message_id: 'tool_use_c1', tool_call_id: 'c1',
      payload: { tool_call_id: 'c1', tool_name: 'propose_command', state: 'completed', input: { command: 'echo "<x>" && ls' } } };
    const result = { row_id: 'r2', turn_id: 't1', kind: 'tool_result', primary_message_id: 'tool_result_c1', tool_call_id: 'c1',
      payload: { tool_call_id: 'c1', tool_name: 'propose_command', state: 'completed', metadata: { result_kind: 'command_proposal', proposal_id: proposalId } } };
    const html = renderer.buildTurnRowListMarkup([call, result], [], { sessionId: 'pane-s' });
    assert.match(html, new RegExp(`data-proposal-id="${proposalId}"`));
    assert.match(html, /data-proposal-session="pane-s"/);
    assert.match(html, /echo &quot;&lt;x&gt;&quot; &amp;&amp; ls/);
    assert.equal((html.match(/data-row-id=/g) || []).length, 1, 'one card for the call and its result');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(gets, [{ schema_version: 1, session_id: 'pane-s', proposal_id: proposalId }]);
    assert.doesNotMatch(renderer.buildTurnRowListMarkup([call], [], { sessionId: 'pane-s' }), /data-proposal-id/, 'no result yet: the plain row');
    const bare = { ...result, payload: { ...result.payload, metadata: { result_kind: 'something_else' } } };
    assert.doesNotMatch(renderer.buildTurnRowListMarkup([call, bare], [], { sessionId: 'pane-s' }), /data-proposal-id/);
  } finally {
    globalThis.window = savedWindow;
    delete globalThis.rendererProposalCardStore;
    delete globalThis.rendererProposalCards;
  }
  for (const toolName of ['propose_git_action', 'propose_command']) {
    assert.equal(toolCallUtils.isToolRunFoldable({ toolName, status: 'completed', approvalRequested: false, hasOwnContent: false }), false, toolName);
  }
});
