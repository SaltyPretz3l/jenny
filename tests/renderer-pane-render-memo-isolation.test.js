// Split view W0-6, the load-bearing acceptance test: per-pane render memos.
//
// The render pipeline memoizes "what this surface last painted" on `uiRuntime`
// (`messageRenderSignature`, `cachedCanonicalMessages`, `cachedThreadTree`, ...)
// and skips the rebuild when the signature is unchanged. Today there is ONE
// such bag for the whole renderer, which is fine with one surface and fatal
// with two: pane 1's render overwrites pane 0's signature, pane 0's next render
// misses, and every article in both panes is rebuilt on every frame -- exactly
// the thrash the split-view plan names as the reason this slice exists.
//
// So this file drives two real pipelines over two real documents in the
// interleaving that breaks today (A, then B, then A again with identical
// sources) and asserts that pane A's third render is a memo HIT.
//
// It is a DUAL-oracle test on purpose:
//   oracle 1 -- pane A still holds its `a1` article. A test that only checked
//     "nothing was rebuilt" would pass if the third render dropped the timeline
//     entirely, which is the other way this slice could go wrong.
//   oracle 2 -- nothing was rebuilt: a sentinel written INTO the a1 article
//     after the first render survives, pane A's own render signature is
//     untouched by pane B's render, the canonical transcript and thread tree
//     keep object identity, and the shared session store still holds BOTH
//     sessions' projection contexts (per-pane memos must not come at the cost
//     of splitting the caches that are per SESSION, where `activeTurnId` lives).
//
// NOT node identity. Measured 2026-09-16: the timeline reconcile reuses the
// `article` ELEMENT for a message id even on a full rebuild and rewrites its
// contents in place, so `article === article` is true for the broken shape too
// and would be a vacuous oracle. What a rebuild does destroy is anything a
// test wrote inside that article, which is why the sentinel is an attribute AND
// an appended child rather than a reference comparison.
//
// And the file carries its own negative control: the same sequence with one
// shared `uiRuntime` (the shape renderer/app.js shipped before this slice) must
// FAIL oracle 2 while still passing oracle 1. An oracle that cannot fail is not
// an oracle.
//
// Both render paths are covered: the legacy transcript path (the harness
// default) and the row-model path, which are different code and memoize
// separately.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createPipelineHarness,
  withWindowGlobals,
  createRenderDom,
} = require('./helpers/render-pipeline-test-harness');
const {
  createSharedSessionStore,
  createPaneRuntime,
} = require('../renderer/chat/renderer-pane-runtime.js');
const { normalizePaneLayout } = require('../renderer/shell/renderer-pane-model.js');

const SESSION_A = 'session-pane-a';
const SESSION_B = 'session-pane-b';
const SENTINEL_ATTRIBUTE = 'data-pane-memo-sentinel';
const SENTINEL_CHILD_ID = 'paneMemoSentinelChild';

// Two panes, one holding each session. Both harness states carry the SAME
// layout because in production both panes read one `state`: the retained set
// the projection cache prunes against is the whole pane layout, not one pane's
// view of it. Set it on one state only and rendering that pane would evict the
// other pane's projection context out of the shared store.
const TWO_PANE_LAYOUT = normalizePaneLayout({
  panes: [{ sessionId: SESSION_A }, { sessionId: SESSION_B }],
  focusedPaneId: 0,
});

function settledMessages(assistantId, text) {
  return [
    {
      id: `u-${assistantId}`,
      role: 'user',
      content: `Prompt for ${assistantId}`,
      status: 'complete',
      timestamp: '2026-09-16T10:00:00.000Z',
    },
    {
      id: assistantId,
      role: 'assistant',
      content: text,
      status: 'complete',
      finalizedAt: '2026-09-16T10:00:05.000Z',
      timestamp: '2026-09-16T10:00:05.000Z',
    },
  ];
}

function articleNode(dom, messageId) {
  return dom.window.document.querySelector(`#timeline [data-message-id="${messageId}"]`);
}

// One pane: its own document, its own pipeline, and the uiRuntime the caller
// chooses -- a pane runtime for the real case, one shared object for the
// negative control.
function createPane({ dom, sessionId, assistantId, text, uiRuntime, rowModelEnabled }) {
  const harness = createPipelineHarness({
    dom,
    uiRuntime,
    currentSessionId: sessionId,
    visibleMessages: settledMessages(assistantId, text),
    rowModelEnabled,
  });
  harness.state.panes = TWO_PANE_LAYOUT;
  if (rowModelEnabled) {
    harness.state.ui.chatTimelineRowModelBySession.set(sessionId, true);
  }
  return harness;
}

function render(harness) {
  withWindowGlobals(harness.dom, () => {
    harness.pipeline.renderMessages({});
  });
}

/* Write a mark INTO the article that only a rebuild of that article destroys. */
function installSentinel(article, documentRef) {
  article.setAttribute(SENTINEL_ATTRIBUTE, '1');
  const child = documentRef.createElement('span');
  child.id = SENTINEL_CHILD_ID;
  article.appendChild(child);
}

function sentinelSurvives(dom) {
  const documentRef = dom.window.document;
  return Boolean(documentRef.querySelector(`[${SENTINEL_ATTRIBUTE}]`))
    && Boolean(documentRef.getElementById(SENTINEL_CHILD_ID));
}

/**
 * The A -> B -> A interleaving, run over whatever pair of runtimes is handed in.
 * Everything the two oracles need comes back as data so the two tests below
 * differ only in what they assert.
 */
function runInterleavedRenders({ runtime0, runtime1, rowModelEnabled }) {
  const dom0 = createRenderDom();
  const dom1 = createRenderDom();
  const paneA = createPane({
    dom: dom0,
    sessionId: SESSION_A,
    assistantId: 'a1',
    text: 'Pane A settled assistant text.',
    uiRuntime: runtime0,
    rowModelEnabled,
  });
  const paneB = createPane({
    dom: dom1,
    sessionId: SESSION_B,
    assistantId: 'b1',
    text: 'Pane B settled assistant text.',
    uiRuntime: runtime1,
    rowModelEnabled,
  });

  render(paneA);
  const firstArticle = articleNode(dom0, 'a1');
  if (firstArticle) installSentinel(firstArticle, dom0.window.document);
  const signatureAfterA = runtime0.messageRenderSignature;
  const canonicalAfterA = runtime0.cachedCanonicalMessages;
  const threadTreeAfterA = runtime0.cachedThreadTree;

  render(paneB);
  const signatureAfterB = runtime0.messageRenderSignature;

  render(paneA); // identical sources: nothing about pane A changed

  return {
    paneA,
    paneB,
    dom0,
    firstArticle,
    articleAfterInterleave: articleNode(dom0, 'a1'),
    sentinelSurvived: sentinelSurvives(dom0),
    signatureAfterA,
    signatureAfterB,
    canonicalAfterA,
    canonicalAfterInterleave: runtime0.cachedCanonicalMessages,
    threadTreeAfterA,
    threadTreeAfterInterleave: runtime0.cachedThreadTree,
  };
}

for (const rowModelEnabled of [false, true]) {
  const pathLabel = rowModelEnabled ? 'row-model' : 'legacy';

  test(`two panes over one shared session store keep their own render memos (${pathLabel} path)`, (t) => {
    const shared = createSharedSessionStore();
    const runtime0 = createPaneRuntime({ paneId: 0, shared });
    const runtime1 = createPaneRuntime({ paneId: 1, shared });

    const result = runInterleavedRenders({ runtime0, runtime1, rowModelEnabled });
    t.after(() => {
      result.paneA.pipeline.dispose?.();
      result.paneB.pipeline.dispose?.();
    });

    assert.ok(result.firstArticle, 'pane A\'s first render must produce the a1 article');
    assert.ok(
      result.paneB.dom.window.document.querySelector('#timeline [data-message-id="b1"]'),
      'pane B must render its own article, or the interleave never happened'
    );

    // Oracle 1: the re-render did not quietly drop pane A's timeline.
    assert.ok(result.articleAfterInterleave, 'pane A still holds the a1 article after pane B rendered in between');

    // Oracle 2a: nothing inside that article was rebuilt.
    assert.equal(
      result.sentinelSurvived,
      true,
      'pane B\'s render must not invalidate pane A\'s render memo: the a1 article must not be rebuilt'
    );

    // Oracle 2b: the mechanism -- pane B never touched pane 0's memo fields.
    assert.ok(result.signatureAfterA, 'pane A\'s first render must commit a render signature');
    assert.equal(
      result.signatureAfterB,
      result.signatureAfterA,
      'pane B\'s render must not overwrite pane A\'s messageRenderSignature'
    );
    assert.equal(
      result.canonicalAfterInterleave,
      result.canonicalAfterA,
      'pane A\'s canonical transcript must keep object identity: the memo hit, so it was not rebuilt'
    );
    assert.equal(
      result.threadTreeAfterInterleave,
      result.threadTreeAfterA,
      'pane A\'s thread tree must keep object identity for the same reason'
    );

    // Oracle 2c: per-pane memos must NOT split the per-session caches.
    const projectionContexts = shared.projectionContextBySession;
    assert.equal(
      result.paneA.uiRuntime.projectionContextBySession,
      projectionContexts,
      'pane A memoizes into the shared projection-context Map, not a private one'
    );
    assert.equal(
      result.paneB.uiRuntime.projectionContextBySession,
      projectionContexts,
      'pane B memoizes into the same Map'
    );
    assert.deepEqual(
      [...projectionContexts.keys()].sort(),
      [SESSION_A, SESSION_B].sort(),
      'both panes\' sessions must survive in the shared store: the retained set is the whole pane layout'
    );
  });

  // The negative control. Same interleaving, but the two pipelines share ONE
  // uiRuntime -- the shape renderer/app.js shipped before this slice. Oracle 1
  // still holds; oracle 2 must FAIL, which is what proves the assertions above
  // are measuring the memo rather than measuring nothing.
  test(`negative control: one shared uiRuntime rebuilds pane A's article, so oracle 2 discriminates (${pathLabel} path)`, (t) => {
    const singleRuntime = {
      projectionContextBySession: new Map(),
      toolRowProjectionFallbacksBySession: new Map(),
      toolRowProjectionFailuresBySession: new Map(),
    };

    const result = runInterleavedRenders({
      runtime0: singleRuntime,
      runtime1: singleRuntime,
      rowModelEnabled,
    });
    t.after(() => {
      result.paneA.pipeline.dispose?.();
      result.paneB.pipeline.dispose?.();
    });

    assert.ok(result.firstArticle, 'the control must render the a1 article too, or it is not the same sequence');

    // Oracle 1 holds for the broken shape as well: this is exactly why oracle 1
    // alone cannot detect the bug and the suite needs both.
    assert.ok(result.articleAfterInterleave, 'the control still ends with an a1 article in the DOM');

    // Oracle 2 fails: pane B's render clobbered the one signature, so pane A's
    // third render missed its memo and rebuilt.
    assert.equal(
      result.sentinelSurvived,
      false,
      'with one shared uiRuntime the a1 article is REBUILT -- if this ever stops being true, '
      + 'oracle 2a above has stopped discriminating and this suite proves nothing'
    );
    assert.notEqual(
      result.signatureAfterB,
      result.signatureAfterA,
      'with one shared uiRuntime pane B\'s render overwrites pane A\'s messageRenderSignature'
    );
    assert.notEqual(
      result.canonicalAfterInterleave,
      result.canonicalAfterA,
      'with one shared uiRuntime pane A\'s canonical transcript is rebuilt, losing object identity'
    );
    assert.notEqual(
      result.threadTreeAfterInterleave,
      result.threadTreeAfterA,
      'with one shared uiRuntime pane A\'s thread tree is rebuilt too'
    );
  });
}
