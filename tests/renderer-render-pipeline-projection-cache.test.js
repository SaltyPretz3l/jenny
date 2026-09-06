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
