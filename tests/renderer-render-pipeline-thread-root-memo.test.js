const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createThreadDomPipeline,
} = require('../renderer/chat/renderer-render-pipeline-thread-dom');

// Finding 3 — settled-root markup memoization. renderThreadTree/renderThreadNode
// accept a renderOptions.markupCache (a plain Map<rootId, {key, html}>, shared
// across renders by the caller — mirrors the real uiRuntime.threadRootMarkupCache).
// A settled root (not renderOptions.activeTurnRootMessageId) whose subtree content
// fingerprints, expansion bits, divider labels, and session-global fields are all
// unchanged between two renderThreadTree calls must reuse the cached HTML instead
// of re-invoking buildArticle. The active/streaming root is NEVER memoized.

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function buildSpyArticle(callLog) {
  return function buildArticle(message) {
    callLog.push(String(message?.id || ''));
    return `<article class="chat-entry" data-message-id="${escapeHtml(message.id)}">${escapeHtml(message.content || '')}</article>`;
  };
}

function buildRootNode(id, content, children) {
  return {
    id,
    role: id.startsWith('u') ? 'user' : 'assistant',
    kind: '',
    parentId: '',
    message: { id, content: content || '' },
    children: children || [],
  };
}

function buildThreadTree(roots) {
  return { roots };
}

function baseRenderOptions(overrides) {
  return Object.assign({
    dividerByMessageId: new Map(),
    markupCache: new Map(),
    activeTurnRootMessageId: '',
    sessionGlobals: {
      sessionId: 's1',
      latestReplyAssistantMessageId: 'a1',
      followUpDisabledReason: '',
      regenerateRequestFingerprint: '',
    },
    messageFingerprintById: new Map([
      ['a1', 'fp-a1-v1'],
    ]),
  }, overrides || {});
}

test('Finding 3 case 1: unchanged settled root is NOT re-invoked on the second render (cache hit)', () => {
  const callLog = [];
  const buildArticle = buildSpyArticle(callLog);
  const pipeline = createThreadDomPipeline({ callbacks: { escapeHtml } });
  const tree = buildThreadTree([buildRootNode('a1', 'hello world')]);
  const renderOptions = baseRenderOptions();

  const firstHtml = pipeline.renderThreadTree(tree, 's1', new Set(), buildArticle, renderOptions);
  assert.deepEqual(callLog, ['a1'], 'first render must build the article');

  const secondHtml = pipeline.renderThreadTree(tree, 's1', new Set(), buildArticle, renderOptions);
  assert.deepEqual(callLog, ['a1'], 'second render must NOT re-invoke buildArticle for an unchanged settled root');
  assert.equal(secondHtml, firstHtml, 'cached HTML must be byte-identical to the fresh build');
});

test('Finding 3 case 2: activeTurnRootMessageId === rootId is rebuilt on BOTH renders (never memoized)', () => {
  const callLog = [];
  const buildArticle = buildSpyArticle(callLog);
  const pipeline = createThreadDomPipeline({ callbacks: { escapeHtml } });
  const tree = buildThreadTree([buildRootNode('a1', 'streaming...')]);
  const renderOptions = baseRenderOptions({ activeTurnRootMessageId: 'a1' });

  pipeline.renderThreadTree(tree, 's1', new Set(), buildArticle, renderOptions);
  assert.deepEqual(callLog, ['a1']);

  pipeline.renderThreadTree(tree, 's1', new Set(), buildArticle, renderOptions);
  assert.deepEqual(callLog, ['a1', 'a1'], 'the active root must be rebuilt every render, never served from cache');
});

test('Finding 3 case 3: a content-fingerprint change re-invokes the builder', () => {
  const callLog = [];
  const buildArticle = buildSpyArticle(callLog);
  const pipeline = createThreadDomPipeline({ callbacks: { escapeHtml } });
  const tree = buildThreadTree([buildRootNode('a1', 'hello world')]);
  const renderOptions1 = baseRenderOptions();
  const sharedCache = renderOptions1.markupCache;

  pipeline.renderThreadTree(tree, 's1', new Set(), buildArticle, renderOptions1);
  assert.deepEqual(callLog, ['a1']);

  const renderOptions2 = baseRenderOptions({
    markupCache: sharedCache,
    messageFingerprintById: new Map([['a1', 'fp-a1-v2']]),
  });
  pipeline.renderThreadTree(tree, 's1', new Set(), buildArticle, renderOptions2);
  assert.deepEqual(callLog, ['a1', 'a1'], 'a changed content fingerprint must invalidate the cache entry');
});

test('Finding 3 case 4: an expand/collapse change re-invokes the builder', () => {
  const callLog = [];
  const buildArticle = buildSpyArticle(callLog);
  let branchOpen = false;
  const pipeline = createThreadDomPipeline({
    callbacks: {
      escapeHtml,
      shouldShowThreadToggle(node) {
        return Array.isArray(node.children) && node.children.length > 0;
      },
      isThreadBranchOpen() {
        return branchOpen;
      },
    },
  });
  const child = buildRootNode('t1', 'a tool step');
  const tree = buildThreadTree([buildRootNode('a1', 'hello world', [child])]);
  const renderOptions1 = baseRenderOptions({
    messageFingerprintById: new Map([['a1', 'fp-a1'], ['t1', 'fp-t1']]),
  });
  const sharedCache = renderOptions1.markupCache;

  pipeline.renderThreadTree(tree, 's1', new Set(), buildArticle, renderOptions1);
  assert.deepEqual(callLog, ['a1'], 'collapsed branch: only the root article is built (child markup withheld)');

  branchOpen = true;
  const renderOptions2 = baseRenderOptions({
    markupCache: sharedCache,
    messageFingerprintById: new Map([['a1', 'fp-a1'], ['t1', 'fp-t1']]),
  });
  pipeline.renderThreadTree(tree, 's1', new Set(), buildArticle, renderOptions2);
  assert.deepEqual(callLog, ['a1', 'a1', 't1'], 'expanding the branch must invalidate the cache and rebuild, now including the child');
});

test('Finding 3 case 5: a divider entry added/removed re-invokes the builder', () => {
  const callLog = [];
  const buildArticle = buildSpyArticle(callLog);
  const pipeline = createThreadDomPipeline({ callbacks: { escapeHtml } });
  const tree = buildThreadTree([buildRootNode('a1', 'hello world')]);
  const renderOptions1 = baseRenderOptions();
  const sharedCache = renderOptions1.markupCache;

  pipeline.renderThreadTree(tree, 's1', new Set(), buildArticle, renderOptions1);
  assert.deepEqual(callLog, ['a1']);

  const renderOptions2 = baseRenderOptions({
    markupCache: sharedCache,
    dividerByMessageId: new Map([['a1', { beforeMessageId: 'a1', label: '5 min later', ariaLabel: '5 minutes later' }]]),
  });
  pipeline.renderThreadTree(tree, 's1', new Set(), buildArticle, renderOptions2);
  assert.deepEqual(callLog, ['a1', 'a1'], 'adding a divider entry for the root must invalidate the cache');
});

test('Finding 3 case 6: latestReplyAssistantMessageId / followUpDisabledReason change re-invokes the builder', () => {
  const callLog = [];
  const buildArticle = buildSpyArticle(callLog);
  const pipeline = createThreadDomPipeline({ callbacks: { escapeHtml } });
  const tree = buildThreadTree([buildRootNode('a1', 'hello world')]);
  const renderOptions1 = baseRenderOptions();
  const sharedCache = renderOptions1.markupCache;

  pipeline.renderThreadTree(tree, 's1', new Set(), buildArticle, renderOptions1);
  assert.deepEqual(callLog, ['a1']);

  // latestReplyAssistantMessageId change (e.g. a new reply landed elsewhere,
  // shifting which root shows the follow-up affordance).
  const renderOptions2 = baseRenderOptions({
    markupCache: sharedCache,
    sessionGlobals: Object.assign({}, renderOptions1.sessionGlobals, { latestReplyAssistantMessageId: 'a2' }),
  });
  pipeline.renderThreadTree(tree, 's1', new Set(), buildArticle, renderOptions2);
  assert.deepEqual(callLog, ['a1', 'a1'], 'a latestReplyAssistantMessageId change must invalidate every settled root');

  // followUpDisabledReason change (e.g. send became busy).
  const renderOptions3 = baseRenderOptions({
    markupCache: sharedCache,
    sessionGlobals: Object.assign({}, renderOptions1.sessionGlobals, { followUpDisabledReason: 'Wait for the current response to finish before trying that.' }),
  });
  pipeline.renderThreadTree(tree, 's1', new Set(), buildArticle, renderOptions3);
  assert.deepEqual(callLog, ['a1', 'a1', 'a1'], 'a followUpDisabledReason change must also invalidate every settled root');
});

test('Finding 3 case 7: flag-off (markupCache = null) always rebuilds', () => {
  const callLog = [];
  const buildArticle = buildSpyArticle(callLog);
  const pipeline = createThreadDomPipeline({ callbacks: { escapeHtml } });
  const tree = buildThreadTree([buildRootNode('a1', 'hello world')]);
  const renderOptions = baseRenderOptions({ markupCache: null });

  pipeline.renderThreadTree(tree, 's1', new Set(), buildArticle, renderOptions);
  pipeline.renderThreadTree(tree, 's1', new Set(), buildArticle, renderOptions);
  pipeline.renderThreadTree(tree, 's1', new Set(), buildArticle, renderOptions);

  assert.deepEqual(callLog, ['a1', 'a1', 'a1'], 'with markupCache=null every render must rebuild fresh (flag-off parity with today)');
});

test('Finding 3 case 8: a settled root stays cached when an UNRELATED (streaming) turn changes', () => {
  // The efficacy guarantee: the per-root key must depend only on that root's
  // own subtree + the cross-cutting affordance globals — NOT on a
  // whole-transcript signature. Otherwise every settled root would miss the
  // cache whenever the active turn streamed a token, defeating the memo in the
  // exact structural-update-while-streaming case Finding 3 targets.
  const callLog = [];
  const buildArticle = buildSpyArticle(callLog);
  const pipeline = createThreadDomPipeline({ callbacks: { escapeHtml } });
  const tree = buildThreadTree([
    buildRootNode('a1', 'settled turn'),
    buildRootNode('a2', 'streaming turn v1'),
  ]);
  // a2 is the active/streaming root — never memoized — so it must not mask a1's
  // cache hit; assert a1 (settled) is the one that stays cached.
  const renderOptions1 = baseRenderOptions({
    activeTurnRootMessageId: 'a2',
    messageFingerprintById: new Map([['a1', 'fp-a1'], ['a2', 'fp-a2-v1']]),
  });
  const sharedCache = renderOptions1.markupCache;

  pipeline.renderThreadTree(tree, 's1', new Set(), buildArticle, renderOptions1);
  assert.deepEqual(callLog, ['a1', 'a2'], 'first render builds both roots');

  // Only the streaming turn a2 advances (new fingerprint); a1 is untouched.
  const renderOptions2 = baseRenderOptions({
    activeTurnRootMessageId: 'a2',
    markupCache: sharedCache,
    messageFingerprintById: new Map([['a1', 'fp-a1'], ['a2', 'fp-a2-v2']]),
  });
  pipeline.renderThreadTree(tree, 's1', new Set(), buildArticle, renderOptions2);
  assert.deepEqual(
    callLog,
    ['a1', 'a2', 'a2'],
    'the settled root a1 must be served from cache (built once) while only the streaming root a2 rebuilds'
  );
});

test('Finding 3: cache is pruned of rootIds no longer present in threadTree.roots', () => {
  const callLog = [];
  const buildArticle = buildSpyArticle(callLog);
  const pipeline = createThreadDomPipeline({ callbacks: { escapeHtml } });
  const treeWithTwoRoots = buildThreadTree([
    buildRootNode('a1', 'first'),
    buildRootNode('a2', 'second'),
  ]);
  const renderOptions1 = baseRenderOptions({
    messageFingerprintById: new Map([['a1', 'fp-a1'], ['a2', 'fp-a2']]),
  });
  const sharedCache = renderOptions1.markupCache;

  pipeline.renderThreadTree(treeWithTwoRoots, 's1', new Set(), buildArticle, renderOptions1);
  assert.equal(sharedCache.size, 2, 'both roots must be cached after the first render');

  // a2 is no longer part of the transcript (e.g. pruned/rebuilt canonical list).
  const treeWithOneRoot = buildThreadTree([buildRootNode('a1', 'first')]);
  const renderOptions2 = baseRenderOptions({
    markupCache: sharedCache,
    messageFingerprintById: new Map([['a1', 'fp-a1']]),
  });
  pipeline.renderThreadTree(treeWithOneRoot, 's1', new Set(), buildArticle, renderOptions2);

  assert.equal(sharedCache.size, 1, 'the stale a2 cache entry must be pruned once it drops out of threadTree.roots');
  assert.ok(sharedCache.has('a1'), 'the still-live a1 entry must remain cached');
});

// Review-remediation cases 9-11 — memo-key completeness for ambient UI state
// that buildMessageArticleMarkup reads straight off `state`/callbacks and that
// the per-root content key does NOT capture. Without the guards below, a
// settled root memoized before one of these changed would be served stale
// (the F1 stale-cache class).

test('Review fix case 9: the edited root is excluded from memo; sibling roots stay cached', () => {
  // A user root whose id === renderOptions.editingMessageId swaps its bubble
  // for the inline editor (article-markup buildMessageInnerMarkup reads
  // state.ui.editingMessageId directly), so it must never be served from cache.
  // The exclusion must be targeted — a settled sibling stays memoized.
  const callLog = [];
  const buildArticle = buildSpyArticle(callLog);
  const pipeline = createThreadDomPipeline({ callbacks: { escapeHtml } });
  const tree = buildThreadTree([
    buildRootNode('u1', 'being edited'),
    buildRootNode('u2', 'settled sibling'),
  ]);
  const renderOptions1 = baseRenderOptions({
    editingMessageId: 'u1',
    messageFingerprintById: new Map([['u1', 'fp-u1'], ['u2', 'fp-u2']]),
  });
  const sharedCache = renderOptions1.markupCache;

  pipeline.renderThreadTree(tree, 's1', new Set(), buildArticle, renderOptions1);
  assert.deepEqual(callLog, ['u1', 'u2'], 'first render builds both roots');

  const renderOptions2 = baseRenderOptions({
    editingMessageId: 'u1',
    markupCache: sharedCache,
    messageFingerprintById: new Map([['u1', 'fp-u1'], ['u2', 'fp-u2']]),
  });
  pipeline.renderThreadTree(tree, 's1', new Set(), buildArticle, renderOptions2);
  assert.deepEqual(
    callLog,
    ['u1', 'u2', 'u1'],
    'the edited root u1 must rebuild every render (excluded); the settled sibling u2 must be served from cache'
  );
  assert.equal(sharedCache.has('u1'), false, 'the edited root must not be written to the markup cache');
  assert.ok(sharedCache.has('u2'), 'the settled sibling must remain cached');
});

test('Review fix case 10: selectionModeActive suspends memo for every root', () => {
  // Selection mode grows a checkbox/handle on every settled root
  // (article-markup resolveSelectionState reads state.ui.selectionMode
  // directly), so no root may be served from cache while it is active.
  const callLog = [];
  const buildArticle = buildSpyArticle(callLog);
  const pipeline = createThreadDomPipeline({ callbacks: { escapeHtml } });
  const tree = buildThreadTree([
    buildRootNode('a1', 'one'),
    buildRootNode('a2', 'two'),
  ]);
  const renderOptions1 = baseRenderOptions({
    selectionModeActive: true,
    messageFingerprintById: new Map([['a1', 'fp-a1'], ['a2', 'fp-a2']]),
  });
  const sharedCache = renderOptions1.markupCache;

  pipeline.renderThreadTree(tree, 's1', new Set(), buildArticle, renderOptions1);
  const renderOptions2 = baseRenderOptions({
    selectionModeActive: true,
    markupCache: sharedCache,
    messageFingerprintById: new Map([['a1', 'fp-a1'], ['a2', 'fp-a2']]),
  });
  pipeline.renderThreadTree(tree, 's1', new Set(), buildArticle, renderOptions2);
  assert.deepEqual(
    callLog,
    ['a1', 'a2', 'a1', 'a2'],
    'while selection mode is active no root may be served from cache'
  );
  assert.equal(sharedCache.size, 0, 'no root is written to the cache while selection mode suspends memo');
});

test('Review fix case 11: an isArtifactReviewVisible() toggle busts the settled-root key', () => {
  // isArtifactReviewVisible() flips the latest settled turn's phase to
  // review_artifact; it is folded into sessionGlobals.artifactReviewVisible so
  // a panel toggle invalidates the cached root instead of serving it stale.
  const callLog = [];
  const buildArticle = buildSpyArticle(callLog);
  const pipeline = createThreadDomPipeline({ callbacks: { escapeHtml } });
  const tree = buildThreadTree([buildRootNode('a1', 'the latest settled turn')]);
  const globals = {
    sessionId: 's1',
    latestReplyAssistantMessageId: 'a1',
    followUpDisabledReason: '',
    regenerateRequestFingerprint: '',
    artifactReviewVisible: false,
  };
  const renderOptions1 = baseRenderOptions({ sessionGlobals: Object.assign({}, globals) });
  const sharedCache = renderOptions1.markupCache;

  pipeline.renderThreadTree(tree, 's1', new Set(), buildArticle, renderOptions1);
  assert.deepEqual(callLog, ['a1'], 'first render builds the settled root');

  // Panel opens -> the latest settled turn's phase flips to review_artifact.
  const renderOptions2 = baseRenderOptions({
    markupCache: sharedCache,
    sessionGlobals: Object.assign({}, globals, { artifactReviewVisible: true }),
  });
  pipeline.renderThreadTree(tree, 's1', new Set(), buildArticle, renderOptions2);
  assert.deepEqual(
    callLog,
    ['a1', 'a1'],
    'toggling isArtifactReviewVisible must invalidate the cached settled root so review_artifact is not served stale'
  );
});
