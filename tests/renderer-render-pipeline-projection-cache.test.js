const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createProjectionCachePipeline,
  PROJECTION_CACHE_SESSION_CAP,
} = require('../renderer/chat/renderer-render-pipeline-projection-cache');

// Phase 10 Track A4 — projection caches must stay bounded under rapid session
// switching. Each per-session Map enforces an LRU ceiling on the create
// path so that even pathological cycles (e.g. bootstrap rehydration that
// touches many sessions before the first chat render) cannot grow without
// limit. The current session is exempt from eviction.

function buildPipeline(options = {}) {
  const uiRuntime = options.uiRuntime || {
    projectionContextBySession: new Map(),
    toolRowProjectionFallbacksBySession: new Map(),
    toolRowProjectionFailuresBySession: new Map(),
  };
  const state = options.state || {
    currentSessionId: '',
    ui: { chatTimelineRowModelMetaBySession: new Map() },
  };
  const pipeline = createProjectionCachePipeline({
    state,
    dom: {},
    runtime: { uiRuntime },
    callbacks: options.callbacks || {},
  });
  return { pipeline, uiRuntime, state };
}

test('PROJECTION_CACHE_SESSION_CAP is exported and is a positive integer', () => {
  assert.equal(typeof PROJECTION_CACHE_SESSION_CAP, 'number');
  assert.ok(Number.isInteger(PROJECTION_CACHE_SESSION_CAP));
  assert.ok(PROJECTION_CACHE_SESSION_CAP > 0);
});

test('getProjectionContextCache evicts oldest session when over the LRU cap', () => {
  const { pipeline, uiRuntime, state } = buildPipeline();
  state.currentSessionId = 'session-cap-current';

  // Fill the cache past the cap with non-current sessions.
  const totalSessions = PROJECTION_CACHE_SESSION_CAP + 5;
  for (let index = 0; index < totalSessions; index += 1) {
    pipeline.getProjectionContextCache(`session-${index}`, { create: true });
  }

  assert.equal(
    uiRuntime.projectionContextBySession.size,
    PROJECTION_CACHE_SESSION_CAP,
    'cache must be bounded at the cap'
  );

  // The earliest sessions (session-0 .. session-4) should have been evicted.
  for (let index = 0; index < 5; index += 1) {
    assert.equal(
      uiRuntime.projectionContextBySession.has(`session-${index}`),
      false,
      `session-${index} must have been evicted as oldest`
    );
  }
  // The most recently inserted sessions must remain.
  for (let index = totalSessions - PROJECTION_CACHE_SESSION_CAP; index < totalSessions; index += 1) {
    assert.equal(
      uiRuntime.projectionContextBySession.has(`session-${index}`),
      true,
      `session-${index} must remain`
    );
  }
});

test('LRU eviction never evicts the current session, even if it is the oldest entry', () => {
  const { pipeline, uiRuntime, state } = buildPipeline();
  state.currentSessionId = 'session-current';

  // Insert the current session first — it would naturally be the oldest.
  pipeline.getProjectionContextCache('session-current', { create: true });

  // Then flood with other sessions.
  for (let index = 0; index < PROJECTION_CACHE_SESSION_CAP + 5; index += 1) {
    pipeline.getProjectionContextCache(`session-flood-${index}`, { create: true });
  }

  assert.equal(
    uiRuntime.projectionContextBySession.has('session-current'),
    true,
    'current session must survive LRU eviction'
  );
  assert.equal(
    uiRuntime.projectionContextBySession.size,
    PROJECTION_CACHE_SESSION_CAP,
    'cache size must remain at cap'
  );
});

test('touch-on-read promotes recently-accessed sessions out of the eviction queue', () => {
  const { pipeline, uiRuntime, state } = buildPipeline();
  state.currentSessionId = '';

  // Fill exactly to the cap with non-current sessions.
  for (let index = 0; index < PROJECTION_CACHE_SESSION_CAP; index += 1) {
    pipeline.getProjectionContextCache(`session-${index}`, { create: true });
  }
  assert.equal(uiRuntime.projectionContextBySession.size, PROJECTION_CACHE_SESSION_CAP);

  // Touch session-0 so it becomes most-recently-used.
  pipeline.getProjectionContextCache('session-0', { create: false });

  // Insert one more — the oldest non-touched session should be evicted.
  pipeline.getProjectionContextCache('session-new', { create: true });

  assert.equal(
    uiRuntime.projectionContextBySession.has('session-0'),
    true,
    'touched session must survive eviction'
  );
  assert.equal(
    uiRuntime.projectionContextBySession.has('session-1'),
    false,
    'untouched second-oldest session must be evicted instead'
  );
  assert.equal(
    uiRuntime.projectionContextBySession.has('session-new'),
    true,
    'new session must be inserted'
  );
});

test('getToolRowProjectionFallbackSet (Set-valued cache) also enforces the LRU cap', () => {
  const { pipeline, uiRuntime, state } = buildPipeline();
  state.currentSessionId = '';

  // logToolRowProjectionFallbackOnce calls getToolRowProjectionFallbackSet
  // with { create: true } — exercise the same path.
  for (let index = 0; index < PROJECTION_CACHE_SESSION_CAP + 3; index += 1) {
    state.currentSessionId = `session-fallback-${index}`;
    pipeline.logToolRowProjectionFallbackOnce(`msg-${index}`, 'missing_projected_row');
  }

  assert.equal(
    uiRuntime.toolRowProjectionFallbacksBySession.size,
    PROJECTION_CACHE_SESSION_CAP,
    'fallback-set cache must be bounded at the cap'
  );
});

test('pruneToolRowProjectionSessionCaches also cleans chatTimelineRowModelMetaBySession', () => {
  const { pipeline, state } = buildPipeline();
  state.currentSessionId = 'session-keep';

  const metaStore = state.ui.chatTimelineRowModelMetaBySession;
  metaStore.set('session-keep', { enabled: true });
  metaStore.set('session-stale-1', { enabled: false });
  metaStore.set('session-stale-2', { enabled: false });

  pipeline.pruneToolRowProjectionSessionCaches('session-keep');

  assert.equal(metaStore.size, 1, 'only the active session meta entry must survive');
  assert.equal(metaStore.has('session-keep'), true);
  assert.equal(metaStore.has('session-stale-1'), false);
  assert.equal(metaStore.has('session-stale-2'), false);
});

test('pruneToolRowProjectionSessionCaches without an active session id clears chatTimelineRowModelMetaBySession entirely', () => {
  const { pipeline, state } = buildPipeline();
  const metaStore = state.ui.chatTimelineRowModelMetaBySession;
  metaStore.set('session-a', { enabled: true });
  metaStore.set('session-b', { enabled: true });

  pipeline.pruneToolRowProjectionSessionCaches('');

  assert.equal(metaStore.size, 0, 'no surviving session id means clear the entire meta store');
});

test('getRowModelMeta also enforces the LRU cap', () => {
  const { pipeline, state } = buildPipeline();
  state.currentSessionId = '';

  for (let index = 0; index < PROJECTION_CACHE_SESSION_CAP + 4; index += 1) {
    pipeline.getRowModelMeta(`session-meta-${index}`, { create: true });
  }

  assert.equal(
    state.ui.chatTimelineRowModelMetaBySession.size,
    PROJECTION_CACHE_SESSION_CAP,
    'row-model meta cache must be bounded'
  );
});

// ---------------------------------------------------------------------------
// Split view W0-5 — the retained-set projection-cache policy.
//
// `enforceProjectionCacheBound` and `pruneToolRowProjectionSessionCaches` used
// to retain exactly one session id. They now take a RETAINED SET: a string
// (the old contract, answer for answer) or an array/Set of ids. With one pane
// the retained set is `[currentSessionId]`, so every answer below that is
// marked "unchanged" is the pre-W0-5 answer, pinned here.
//
// `resolveRetainedSessionIds(state)` is the one place the policy is decided:
// the pane layout when it holds at least one session, `state.currentSessionId`
// otherwise -- because W0-2 seeds `state.panes` without rewiring the writers of
// `currentSessionId`, so a blank layout means "ask currentSessionId".
// ---------------------------------------------------------------------------

const {
  resolveRetainedSessionIds,
} = require('../renderer/chat/renderer-render-pipeline-projection-cache');
const { normalizePaneLayout } = require('../renderer/shell/renderer-pane-model');

function fillProjectionCache(pipeline, count, prefix) {
  for (let index = 0; index < count; index += 1) {
    pipeline.getProjectionContextCache(`${prefix}-${index}`, { create: true });
  }
}

test('resolveRetainedSessionIds falls back to currentSessionId when no pane holds a session', () => {
  assert.deepEqual(resolveRetainedSessionIds({ currentSessionId: 'session-solo' }), ['session-solo']);
  assert.deepEqual(
    resolveRetainedSessionIds({ currentSessionId: '  session-solo  ', panes: normalizePaneLayout(null) }),
    ['session-solo'],
    'the seeded blank layout must not shadow the current session'
  );
  assert.deepEqual(resolveRetainedSessionIds({ currentSessionId: '' }), ['']);
  assert.deepEqual(resolveRetainedSessionIds(null), ['']);
});

test('resolveRetainedSessionIds is the pane session ids once a pane holds one', () => {
  const state = {
    currentSessionId: 'session-a',
    panes: normalizePaneLayout({ panes: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }] }),
  };
  assert.deepEqual(resolveRetainedSessionIds(state), ['session-a', 'session-b']);

  const blankFirst = {
    currentSessionId: 'session-a',
    panes: normalizePaneLayout({ panes: [{}, { sessionId: 'session-b' }] }),
  };
  assert.deepEqual(resolveRetainedSessionIds(blankFirst), ['session-b']);
});

test('PROJECTION_CACHE_SESSION_CAP leaves room for every retained pane session', () => {
  const state = {
    currentSessionId: 'session-a',
    panes: normalizePaneLayout({ panes: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }] }),
  };
  const retained = resolveRetainedSessionIds(state);
  assert.equal(retained.length, 2);
  assert.equal(PROJECTION_CACHE_SESSION_CAP >= retained.length, true);
  assert.equal(PROJECTION_CACHE_SESSION_CAP, 16, 'W0-5 must not move the cap');
});

test('a single retained id prunes exactly as the pre-W0-5 single-session contract did', () => {
  const { pipeline, uiRuntime, state } = buildPipeline();
  state.currentSessionId = 'session-keep';
  for (const sessionId of ['session-keep', 'session-stale-1', 'session-stale-2']) {
    pipeline.getProjectionContextCache(sessionId, { create: true });
  }
  state.ui.chatTimelineRowModelMetaBySession.set('session-keep', { enabled: true });
  state.ui.chatTimelineRowModelMetaBySession.set('session-stale-1', { enabled: false });

  pipeline.pruneToolRowProjectionSessionCaches('session-keep');

  assert.deepEqual([...uiRuntime.projectionContextBySession.keys()], ['session-keep']);
  assert.deepEqual([...state.ui.chatTimelineRowModelMetaBySession.keys()], ['session-keep']);

  // The same answer through the new shapes: a 1-element array and a 1-id Set.
  for (const retained of [['session-keep'], new Set(['session-keep'])]) {
    const fresh = buildPipeline();
    fresh.state.currentSessionId = 'session-keep';
    for (const sessionId of ['session-keep', 'session-stale-1']) {
      fresh.pipeline.getProjectionContextCache(sessionId, { create: true });
    }
    fresh.pipeline.pruneToolRowProjectionSessionCaches(retained);
    assert.deepEqual([...fresh.uiRuntime.projectionContextBySession.keys()], ['session-keep']);
  }
});

test('an empty retained set still clears every session cache, as the empty id did', () => {
  for (const retained of ['', [], new Set(), ['   '], null, undefined]) {
    const { pipeline, uiRuntime, state } = buildPipeline();
    pipeline.getProjectionContextCache('session-a', { create: true });
    pipeline.getProjectionContextCache('session-b', { create: true });
    state.ui.chatTimelineRowModelMetaBySession.set('session-a', { enabled: true });

    pipeline.pruneToolRowProjectionSessionCaches(retained);

    assert.equal(uiRuntime.projectionContextBySession.size, 0, `retained=${String(retained)}`);
    assert.equal(state.ui.chatTimelineRowModelMetaBySession.size, 0, `retained=${String(retained)}`);
  }
});

test('an unexpected retained shape coerces to one id, as the old contract did, never to "clear everything"', () => {
  // The old single-id contract ran String(x || '').trim() on whatever it got,
  // so a numeric or boolean id RETAINED that session. An empty retained set
  // clears every cache, so misreading an odd shape as "nothing" would be the
  // destructive direction (the independent review's finding).
  for (const [retained, kept] of [[42, '42'], [true, 'true']]) {
    const { pipeline, uiRuntime } = buildPipeline();
    for (const sessionId of [kept, 'session-other']) {
      pipeline.getProjectionContextCache(sessionId, { create: true });
    }
    pipeline.pruneToolRowProjectionSessionCaches(retained);
    assert.deepEqual([...uiRuntime.projectionContextBySession.keys()], [kept], `retained ${String(retained)}`);
  }
  // null / undefined still mean "retain nothing", exactly as '' does.
  for (const retained of [null, undefined, '']) {
    const { pipeline, uiRuntime } = buildPipeline();
    pipeline.getProjectionContextCache('session-any', { create: true });
    pipeline.pruneToolRowProjectionSessionCaches(retained);
    assert.deepEqual([...uiRuntime.projectionContextBySession.keys()], [], `retained ${String(retained)}`);
  }
});

test('a second retained session survives the prune that keeps the first', () => {
  const { pipeline, uiRuntime, state } = buildPipeline();
  state.currentSessionId = 'session-a';
  state.panes = normalizePaneLayout({ panes: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }] });
  for (const sessionId of ['session-a', 'session-b', 'session-elsewhere']) {
    pipeline.getProjectionContextCache(sessionId, { create: true });
    state.ui.chatTimelineRowModelMetaBySession.set(sessionId, { enabled: true });
  }

  pipeline.pruneToolRowProjectionSessionCaches(resolveRetainedSessionIds(state));

  assert.deepEqual([...uiRuntime.projectionContextBySession.keys()], ['session-a', 'session-b']);
  assert.deepEqual([...state.ui.chatTimelineRowModelMetaBySession.keys()], ['session-a', 'session-b']);
});

test('a second retained session survives the LRU bound while an unretained session is evicted first', () => {
  const { pipeline, uiRuntime, state } = buildPipeline();
  state.currentSessionId = 'session-a';
  state.panes = normalizePaneLayout({ panes: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }] });

  // Both retained sessions enter FIRST, so a single-id policy would evict
  // session-b before any of the filler: it is the oldest unpinned key.
  pipeline.getProjectionContextCache('session-a', { create: true });
  pipeline.getProjectionContextCache('session-b', { create: true });
  fillProjectionCache(pipeline, PROJECTION_CACHE_SESSION_CAP + 4, 'filler');

  const surviving = [...uiRuntime.projectionContextBySession.keys()];
  assert.equal(uiRuntime.projectionContextBySession.size, PROJECTION_CACHE_SESSION_CAP);
  assert.equal(surviving.includes('session-a'), true, 'the focused pane survives');
  assert.equal(surviving.includes('session-b'), true, 'the second pane survives');
  // The oldest UNRETAINED entries are the ones that went.
  assert.equal(surviving.includes('filler-0'), false);
  assert.equal(surviving.includes('filler-1'), false);
  assert.equal(
    surviving.includes(`filler-${PROJECTION_CACHE_SESSION_CAP + 3}`),
    true,
    'the newest filler is retained by recency'
  );
});

test('the row-model meta cache honours the retained set too', () => {
  const { pipeline, state } = buildPipeline();
  state.currentSessionId = 'session-a';
  state.panes = normalizePaneLayout({ panes: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }] });

  pipeline.getRowModelMeta('session-a', { create: true });
  pipeline.getRowModelMeta('session-b', { create: true });
  for (let index = 0; index < PROJECTION_CACHE_SESSION_CAP + 4; index += 1) {
    pipeline.getRowModelMeta(`meta-filler-${index}`, { create: true });
  }

  const surviving = [...state.ui.chatTimelineRowModelMetaBySession.keys()];
  assert.equal(state.ui.chatTimelineRowModelMetaBySession.size, PROJECTION_CACHE_SESSION_CAP);
  assert.equal(surviving.includes('session-a'), true);
  assert.equal(surviving.includes('session-b'), true);
});
