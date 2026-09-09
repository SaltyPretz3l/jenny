const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { JSDOM } = require('jsdom');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { createHarness } = require('./helpers/renderer-stream-handler-harness');
const { markUserQuestionsStale } = require('../renderer/chat/renderer-stream-handler-tools');

function session(id) {
  return { id, title: id, conversation_mode: 'chat', preferred_model: 'gpt-test',
    updated_at: new Date().toISOString(), linked_session_ids: [],
    context_preferences: { history_scope: 'session', include_personality: true, include_memory: true } };
}

test('request events refresh list, compact strip and tabs through waiting, resume and terminal transitions', async (t) => {
  const sessionId = 'status-session';
  const streamId = 'status-stream';
  const app = await loadRendererApp({ shell: { chat: {
    async startStream(_payload, { state }) {
      state.sessions = [session(sessionId), session('background-session')];
      state.messagesBySession.set(sessionId, []);
      return { sessionId, streamId };
    },
  } } });
  t.after(() => app.dispose());
  const { window, shell } = app;
  const doc = window.document;
  const input = doc.getElementById('chatInput');
  input.value = 'Test session states';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.getElementById('sendButton').click();
  await waitForUi(window, 60);
  const emit = async (payload) => {
    await shell.__emitChat({ sessionId, streamId, ...payload });
    await waitForUi(window, 65);
  };
  await emit({ type: 'started' });
  await emit({ type: 'tool_use', callId: 'setup', toolName: 'read_file', status: 'running', input: {} });
  doc.querySelector('[data-session-open="background-session"]').click();
  await waitForUi(window, 70);
  doc.querySelector(`[data-session-open="${sessionId}"]`).click();
  await waitForUi(window, 70);
  window.rendererMultiStreamController.registerStream('background-session', 'background-stream');
  doc.getElementById('chatsPanelCollapseToggle').click();
  await waitForUi(window, 50);
  const chip = doc.querySelector(`[data-strip-session-id="${sessionId}"]`);
  assert.ok(chip);
  chip.focus();
  await waitForUi(window, 20);

  function check(kind, label, id = sessionId) {
    const row = doc.querySelector(`#conversationGroups .conversation-item[data-session-id="${id}"]`);
    const tab = doc.querySelector(`[data-workspace-session-id="${id}"]`)
      || [...doc.querySelectorAll('.workspace-rail-tab')].find((node) => node.querySelector(`[data-workspace-activate="${id}"]`));
    const currentChip = doc.querySelector(`[data-strip-session-id="${id}"]`);
    assert.ok(row, 'session row exists');
    assert.ok(tab, 'session tab exists');
    for (const node of [row, tab, currentChip]) assert.equal(node.dataset.sessionDominantState, kind);
    assert.equal(tab.querySelector('.workspace-rail-indicator').textContent, label);
    for (const node of [row.querySelector('[data-session-open]'), tab.querySelector('.workspace-rail-tab-button'), currentChip]) {
      if (label) assert.ok(node.getAttribute('aria-label').includes(label), node.getAttribute('aria-label'));
      if (['approval', 'plan_review', 'input_needed'].includes(kind)) assert.ok(!node.getAttribute('aria-label').includes('Streaming'));
    }
  }
  check('streaming', 'Streaming');
  for (const [toolName, kind, label] of [
    ['write_file', 'approval', 'Approval needed'],
    ['exit_plan_mode', 'plan_review', 'Plan review'],
    ['ask_user', 'input_needed', 'Input needed'],
  ]) {
    const callId = `call-${toolName}`;
    await emit({ type: toolName === 'ask_user' ? 'user_questions_requested' : 'tool_approval_needed',
      callId, approvalId: callId, toolName, input: {}, questionRef: callId,
      questions: [{ id: 'choice', question: 'Continue?', options: ['Yes', 'No'] }],
      ...(toolName === 'exit_plan_mode' ? { planDocument: { plan_id: 'plan-1', title: 'Plan', status: 'proposed', markdown: 'Do the work.' } } : {}),
    });
    check(kind, label);
    check('streaming', 'Streaming', 'background-session');
    assert.equal(window.rendererMultiStreamController.isSessionSendBusy(sessionId), true);
    assert.equal(doc.querySelector(`[data-workspace-close="${sessionId}"]`).disabled, true);
    doc.querySelector(`[data-strip-session-id="${sessionId}"]`).focus();
    await waitForUi(window, 20);
    assert.equal(doc.getElementById('chatsStripPeekState').textContent, label);
    await emit({ type: 'tool_result', callId, approvalId: callId, toolName, content: 'Done',
      ...(toolName === 'exit_plan_mode' ? { metadata: { result_kind: 'plan_mode_transition', plan_decision: 'approved' } } : {}),
    });
    check('streaming', 'Streaming');
  }
  await emit({ type: 'tool_approval_needed', sessionId: 'background-session', streamId: 'background-stream',
    callId: 'background-call', approvalId: 'background-call', toolName: 'write_file', input: {} });
  check('approval', 'Approval needed', 'background-session');
  check('streaming', 'Streaming');
  await emit({ type: 'error', sessionId: 'background-session', streamId: 'background-stream',
    message: 'Cancelled', status: 'cancelled', terminal_subcode: 'approval' });
  check('open', '', 'background-session');
  await emit({ type: 'complete', content: 'Finished' });
  check('open', '');
});

test('attention follows resolution, stale questions and terminal cleanup without reviving old requests', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());
  const attention = () => harness.multiStreamController.getSessionAttentionStates(['session-1']).get('session-1');
  const emit = (payload) => harness.emit({ sessionId: 'session-1', streamId: 'stream-1', ...payload });
  await emit({ type: 'started' });
  for (const decision of ['approved', 'revised', 'abandoned']) {
    await emit({ type: 'tool_approval_needed', callId: 'plan', approvalId: 'plan', toolName: 'exit_plan_mode', input: {} });
    assert.equal(attention(), 'plan_review');
    await emit({ type: 'tool_result', callId: 'plan', approvalId: 'plan', toolName: 'exit_plan_mode',
      metadata: { result_kind: 'plan_mode_transition', plan_decision: decision } });
    assert.equal(attention(), undefined);
  }
  await emit({ type: 'tool_approval_needed', callId: 'permission', approvalId: 'permission', toolName: 'write_file' });
  await emit({ type: 'tool_result', callId: 'permission', approvalId: 'permission', toolName: 'write_file', approvalState: 'denied' });
  assert.equal(attention(), undefined);
  await emit({ type: 'user_questions_requested', callId: 'question', toolName: 'ask_user', questionRef: 'question', questions: [] });
  assert.equal(attention(), 'input_needed');
  assert.equal(markUserQuestionsStale('session-1', 'question', {
    getSessionMessages: (id) => harness.state.messagesBySession.get(id),
    setSessionMessages: (id, messages) => harness.state.messagesBySession.set(id, messages),
  }), true);
  assert.equal(attention(), undefined);
  await emit({ type: 'user_questions_requested', callId: 'question-2', toolName: 'ask_user', questionRef: 'question-2', questions: [] });
  await emit({ type: 'error', message: 'Stopped' });
  assert.equal(attention(), undefined);
  harness.multiStreamController.registerStream('session-1', 'stream-new');
  assert.equal(attention(), undefined, 'old pending rows do not affect the next stream');
});

test('all waiting indicators select amber rules and only streaming selects pulse rules', (t) => {
  const dom = new JSDOM('<div class="session-row"><span class="session-row__dot"></span></div><div class="workspace-rail-tab"><span class="workspace-rail-indicator"></span></div><button class="chats-strip__chip"></button>');
  t.after(() => dom.window.close());
  for (const [file, selector, property] of [
    ['chats-panel.css', '.session-row', 'background'],
    ['workspace-rail.css', '.workspace-rail-tab', 'color'],
    ['chats-panel-collapsed.css', '.chats-strip__chip', 'background'],
  ]) {
    const css = readFileSync(require.resolve(`../styles/${file}`), 'utf8');
    const node = dom.window.document.querySelector(selector);
    for (const kind of ['approval', 'plan_review', 'input_needed']) {
      node.dataset.sessionDominantState = kind;
      const amberRules = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)].filter((match) => match[2].includes(`${property}: var(--sidebar-state-approval-color)`));
      assert.ok(amberRules.some((match) => node.matches(match[1].trim().replace(/::after| \.session-row__dot| \.workspace-rail-indicator/g, ''))), `${file}: ${kind}`);
    }
    assert.ok(!/\[data-session-dominant-state="(?:approval|plan_review|input_needed)"\][^{]*\{[^}]*animation\s*:/s.test(css));
  }
});
