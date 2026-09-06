/* Live-pipeline regression: a streamed tool turn must render ONE combined
 * tool card in the live timeline — the tool_call card shows "Running..."
 * while executing, then the paired tool_result folds into the SAME card
 * (status flips to Completed, closed raw-output disclosure + artifact teaser
 * render in the card's result body). The mermaid chart block is answer-first:
 * mid-turn the card stays diagram-free (the model may still echo the fence in
 * its answer), and the card renders the chart only as a settled-turn fallback
 * when no whitespace-equivalent fence landed in the assistant text. Pins both
 * the indexRowsByRenderMessageId remap (tool_result articles are
 * anchor-suppressed, so an unremapped result row silently vanishes from the
 * live view) and the render-layer call/result pairing in
 * renderer-turn-row-list-utils (one tool call = one timeline row). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

function createToolSessionStartStream(sessionId, title) {
  return async function startStream(payload, { state }) {
    state.sessions = [{
      id: sessionId,
      title,
      conversation_mode: payload.conversationMode || 'chat',
      preferred_model: payload.preferredModel || 'gpt-test',
      reasoning_effort: payload.reasoningEffort || 'default',
      interactive_round_count: 0,
      interactive_sequence_state: 'idle',
      pending_question_batch: null,
      updated_at: new Date().toISOString(),
    }];
    state.messagesBySession.set(sessionId, []);
    return { sessionId, streamId: `stream-${sessionId}` };
  };
}

async function submitPrompt(window, promptText) {
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  input.value = promptText;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 20);
}

test('live timeline renders one combined tool card that updates in place', async (t) => {
  const sessionId = 'session-live-tool-result';
  const streamId = `stream-${sessionId}`;
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        startStream: createToolSessionStartStream(sessionId, 'Live Tool Result'),
      },
    },
  });

  await submitPrompt(window, 'Please render this as a diagram for me');
  await shell.__emitChat({ type: 'started', sessionId, streamId });

  // gen-0 reasoning before the tool call (gemma4 pattern).
  await shell.__emitChat({
    type: 'delta',
    sessionId,
    streamId,
    content: '',
    aggregate: '',
    reasoning: {
      source: 'provider',
      entriesDelta: [{ id: 'reason-live-1', text: 'I should call mermaid_generate.' }],
    },
    thinkingId: 'think-live-1',
  });

  await shell.__emitChat({
    type: 'tool_use',
    sessionId,
    streamId,
    callId: 'call_live_result_1',
    toolName: 'mermaid_generate',
    summary: 'mermaid_generate',
    input: { prompt: 'graph TD\nA[Start] --> B[End]', diagram_type: 'flowchart' },
    status: 'running',
  });
  await waitForUi(window, 40);

  // While executing: a single card in the running state, no result body yet.
  const runningCard = window.document.querySelector('.tool-call-row[data-tool-call-id="call_live_result_1"]');
  assert.ok(runningCard, 'tool card should render while the tool is running');
  assert.equal(runningCard.getAttribute('data-tool-status'), 'running');
  assert.equal(runningCard.querySelector('.tool-result-body'), null, 'no result body before the tool_result event');
  // .tool-result-body is now the DIAGRAM-only body (renderer-turn-row-tool-render-utils.js);
  // the generic detail body is [data-tool-detail-body]. Assert both, or this
  // absence check silently passes on a card that already materialized details.
  assert.equal(runningCard.querySelector('[data-tool-detail-body="true"]'), null, 'no detail body before the tool_result event');

  await shell.__emitChat({
    type: 'tool_result',
    sessionId,
    streamId,
    callId: 'call_live_result_1',
    toolName: 'mermaid_generate',
    summary: 'mermaid_generate',
    content: JSON.stringify({ mermaid: 'graph TD\nA[Start] --> B[End]', diagram_type: 'flowchart' }),
    isError: false,
    approvalState: 'auto',
    durationMs: 14,
    generatedArtifacts: [{
      artifact_id: 'artifact_live_result_mmd',
      artifact_kind: 'document',
      title: 'Backend Response Flow',
      file_name: 'backend-response-flow.mmd',
      display_path: '.jenny/artifacts/session-live-tool-result/backend-response-flow.mmd',
      language: 'mermaid',
      editable: true,
      status: 'available',
    }],
    metadata: {},
  });
  await waitForUi(window, 40);

  // Mid-stream: the SAME card flipped to completed with the result folded in.
  const midStreamCards = window.document.querySelectorAll('.tool-call-row[data-tool-call-id="call_live_result_1"]');
  assert.equal(midStreamCards.length, 1, 'exactly one tool card mid-stream');
  const midStreamCard = midStreamCards[0];
  assert.equal(midStreamCard.getAttribute('data-tool-status'), 'completed');
  assert.equal(midStreamCard.getAttribute('data-has-result'), 'true');
  assert.equal(
    window.document.querySelector('.tool-result-row'),
    null,
    'no standalone tool_result row renders mid-stream'
  );
  assert.equal(
    midStreamCard.querySelector('.tool-result-body[data-tool-call-id="call_live_result_1"]'),
    null,
    'collapsed settled cards defer their result details'
  );
  assert.equal(
    midStreamCard.querySelector('[data-tool-detail-body="true"]'),
    null,
    'collapsed settled cards defer their generic detail body too'
  );
  assert.notEqual(
    midStreamCard.getAttribute('data-tool-details-materialized'),
    'true',
    'the card is not marked materialized before the first expansion'
  );
  assert.equal(
    midStreamCard.querySelector('.markdown-mermaid-block'),
    null,
    'no mermaid chart mid-stream — the answer is the diagram\'s canonical home; the card fallback waits for settle'
  );
  midStreamCard.querySelector('[data-tool-row-toggle="true"]').click();
  await waitForUi(window, 40);
  const expandedMidStreamCard = window.document.querySelector('.tool-call-row[data-tool-call-id="call_live_result_1"]');
  const midStreamBody = expandedMidStreamCard.querySelector('.tool-call-row-body [data-tool-detail-body="true"]');
  assert.ok(midStreamBody, 'the first expansion materializes result details inside the card');
  assert.equal(
    expandedMidStreamCard.getAttribute('data-tool-details-materialized'),
    'true',
    'the card records that its details are materialized'
  );

  await shell.__emitChat({
    type: 'delta',
    sessionId,
    streamId,
    content: 'I have rendered the diagram for you below:',
    aggregate: 'I have rendered the diagram for you below:',
  });
  await shell.__emitChat({
    type: 'complete',
    sessionId,
    streamId,
    content: 'I have rendered the diagram for you below:',
  });
  await waitForUi(window, 200);

  // Settled: still one combined card inside the tool article, chart block
  // present, raw-output details closed, artifact teaser rendered.
  const toolArticle = window.document.querySelector(`[data-message-id="tool_use_${streamId}_call_live_result_1"]`);
  assert.ok(toolArticle, 'tool_use article should exist after settle');
  const settledCards = toolArticle.querySelectorAll('.tool-call-row[data-tool-call-id="call_live_result_1"]');
  assert.equal(settledCards.length, 1, 'exactly one tool card after settle');
  const settledCard = settledCards[0];
  assert.equal(settledCard.getAttribute('data-tool-status'), 'completed');
  assert.equal(
    toolArticle.querySelector('.tool-result-row'),
    null,
    'no standalone tool_result row after settle'
  );
  const diagramBody = settledCard.querySelector('.tool-result-body.tool-result-diagram[data-tool-call-id="call_live_result_1"]');
  assert.ok(diagramBody, 'settled fallback: diagram body renders in the card (no matching fence in the answer)');
  const mermaidBlock = diagramBody.querySelector('.markdown-mermaid-block');
  assert.ok(mermaidBlock, 'mermaid chart block should render after settle');
  assert.ok(mermaidBlock.querySelector('.markdown-mermaid-preview'), 'chart preview host should exist');
  // The panel's generic body: .tool-result-body is the diagram body (a direct
  // child of the card, asserted above), while the expandable panel holds
  // [data-tool-detail-body].
  const settledBody = settledCard.querySelector('.tool-call-row-body [data-tool-detail-body="true"]');
  assert.ok(settledBody, 'result body should stay inside the card after settle');
  const outputCode = settledBody.querySelector('.inv-codeblock-wrap');
  assert.ok(outputCode, 'output renders as a numbered code view in the panel');
  assert.ok(
    settledCard.querySelector('[data-artifact-id="artifact_live_result_mmd"], .inv-artifact-card'),
    'artifact teaser should remain available while result details are collapsed'
  );
});
