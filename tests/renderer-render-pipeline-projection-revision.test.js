// Regression: a projection-row-only change must invalidate the transcript
// render signature by itself (2026-07-16 follow-up to the terminal-error-card
// loss fix, commit 068f3c40).
//
// Live/reconciled projection rows live in state.ui.chatTimelineLiveStateBySession,
// not on any message, so message fingerprints cannot see them. The original fix
// threaded a per-render `projectionContext.forceFullRender` boolean through
// every render guard; this suite pins its replacement — a monotonic per-session
// projection-state revision owned by renderer-render-pipeline-projection-context.js
// that participates in messageRenderSignature (the `PSR:` component) and in the
// full-render-committed key the narrow patch paths consult. No flag, one signature.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPipelineHarness,
  withWindowGlobals,
  createRenderDom,
} = require('./helpers/render-pipeline-test-harness');

const SESSION_ID = 'session-source';

function settledMessages() {
  return [
    {
      id: 'u1',
      role: 'user',
      content: 'Write the notes file',
      status: 'complete',
      timestamp: '2026-07-16T10:00:00.000Z',
    },
    {
      id: 'a1',
      role: 'assistant',
      content: 'Projection revision regression text marker.',
      status: 'complete',
      finalizedAt: '2026-07-16T10:00:05.000Z',
      timestamp: '2026-07-16T10:00:05.000Z',
    },
  ];
}

// A minimal but production-shaped reconciled entry: the turn maps onto the
// already-settled messages and carries one canonical assistant_text row, so
// consuming it changes projection rows without touching any message object.
function injectPendingReconciledTurn(state) {
  state.ui.chatTimelineLiveStateBySession.set(SESSION_ID, {
    active_turn_id: '',
    turns_by_id: {},
    reconciled_rows_by_turn_id: {
      'turn-a1': {
        turn: {
          turn_id: 'turn-a1',
          primary_user_message_id: 'u1',
          primary_assistant_message_id: 'a1',
        },
        rows: [
          {
            kind: 'assistant_text',
            row_id: 'row-a1',
            turn_id: 'turn-a1',
            primary_message_id: 'a1',
            render_message_id: 'a1',
            payload: {},
          },
        ],
        staleRows: [],
        viewModel: null,
      },
    },
    pending_reconciliation_by_turn_id: { 'turn-a1': true },
  });
}

function setDomSentinel(dom) {
  const entry = dom.window.document.querySelector('#timeline .chat-entry');
  assert.ok(entry, 'timeline must hold at least one rendered entry');
  entry.setAttribute('data-projection-revision-sentinel', '1');
}

function domSentinelSurvives(dom) {
  return Boolean(
    dom.window.document.querySelector('[data-projection-revision-sentinel]')
  );
}

test('a projection-row-only change invalidates the render signature and commits a full render', (t) => {
  const dom = createRenderDom();
  const { pipeline, uiRuntime, state } = createPipelineHarness({
    dom,
    visibleMessages: settledMessages(),
    rowModelEnabled: true,
  });
  // The live overlay path additionally reads the per-session row-model store
  // directly (isLiveRowModelEnabledForSession).
  state.ui.chatTimelineRowModelBySession.set(SESSION_ID, true);
  t.after(() => { pipeline.dispose?.(); });

  withWindowGlobals(dom, () => {
    // Render 1: settle the timeline and establish the committed signature.
    pipeline.renderMessages({});
    const settledSignature = uiRuntime.messageRenderSignature;
    assert.ok(settledSignature, 'first render must commit a render signature');
    assert.equal(
      uiRuntime.projectionCommittedRevisionKey,
      `${SESSION_ID}|0`,
      'the full render must commit the projection revision key'
    );

    // Render 2 with NO changes at all must be a no-op (sentinel survives).
    setDomSentinel(dom);
    pipeline.renderMessages({});
    assert.equal(
      domSentinelSurvives(dom),
      true,
      'an unchanged transcript must not be re-rendered'
    );

    // Now change ONLY projection rows: store a pending reconciled turn. No
    // message object changes, so every message fingerprint stays identical.
    injectPendingReconciledTurn(state);
    pipeline.renderMessages({});

    assert.notEqual(
      uiRuntime.messageRenderSignature,
      settledSignature,
      'consuming reconciled rows must invalidate the render signature without any forceFullRender flag'
    );
    assert.equal(
      domSentinelSurvives(dom),
      false,
      'the projection-row-only change must reach the DOM via a full timeline commit'
    );
    assert.equal(
      uiRuntime.projectionCommittedRevisionKey,
      `${SESSION_ID}|1`,
      'the consuming render must advance the committed projection revision'
    );
    assert.equal(
      dom.window.document.getElementById('timeline').textContent
        .includes('Projection revision regression text marker.'),
      true,
      'the settled turn text must survive the reconcile commit'
    );

    // The reconciled entry was consumed and pruned in the same render.
    const liveState = state.ui.chatTimelineLiveStateBySession.get(SESSION_ID);
    assert.equal(
      Boolean(liveState && liveState.pending_reconciliation_by_turn_id
        && liveState.pending_reconciliation_by_turn_id['turn-a1']),
      false,
      'the pending reconciliation must be consumed by the committing render'
    );

    // Render 4: revision is stable again, so the no-op guard holds.
    setDomSentinel(dom);
    pipeline.renderMessages({});
    assert.equal(
      domSentinelSurvives(dom),
      true,
      'after the reconcile commit the timeline must settle back to no-op renders'
    );
  });
});

test('explicit projection authority invalidation survives until a full render commits', (t) => {
  const dom = createRenderDom();
  const { pipeline, uiRuntime, state } = createPipelineHarness({
    dom,
    visibleMessages: settledMessages(),
    rowModelEnabled: true,
  });
  state.ui.chatTimelineRowModelBySession.set(SESSION_ID, true);
  t.after(() => { pipeline.dispose?.(); });

  withWindowGlobals(dom, () => {
    pipeline.renderMessages({});
    setDomSentinel(dom);

    assert.equal(pipeline.invalidateProjectionStateForSession(SESSION_ID), 1);
    pipeline.renderMessages({});

    assert.equal(
      domSentinelSurvives(dom),
      false,
      'an authority-only change must bypass active-turn patch no-op guards'
    );
    assert.equal(uiRuntime.projectionCommittedRevisionKey, `${SESSION_ID}|1`);
  });
});

test('the projection context carries no forceFullRender flag (revision replaces it)', (t) => {
  const dom = createRenderDom();
  const { pipeline, uiRuntime, state } = createPipelineHarness({
    dom,
    visibleMessages: settledMessages(),
    rowModelEnabled: true,
  });
  state.ui.chatTimelineRowModelBySession.set(SESSION_ID, true);
  t.after(() => { pipeline.dispose?.(); });

  withWindowGlobals(dom, () => {
    pipeline.renderMessages({});
    injectPendingReconciledTurn(state);
    pipeline.renderMessages({});
    const context = uiRuntime.projectionContextBySession.get(SESSION_ID)?.currentContext;
    assert.ok(context, 'the projection cache must hold the last built context');
    assert.equal(
      'forceFullRender' in context,
      false,
      'the per-render forceFullRender flag must not exist on the projection context'
    );
    assert.equal(
      context.projectionStateRevisionKey,
      `${SESSION_ID}|1`,
      'the context must expose the session-scoped projection revision key'
    );
  });
});
