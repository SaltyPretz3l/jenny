const test = require('node:test');
const assert = require('node:assert/strict');

const { createSurfaceActivityResolver } = require('../renderer/chat/renderer-surface-activity-resolver');
const { createSurfaceStatePipeline } = require('../renderer/chat/renderer-render-pipeline-surface-state');

// Builds deps for the effects-facing resolver from a fixed stub shape shared
// across the mandatory table and the anti-divergence table below.
function buildResolverDeps({
  explicitLifecycle = 'idle',
  preflightPending = false,
  streaming = false,
  approvalPending = false,
  currentSessionId = 'session-1',
} = {}) {
  return {
    getChatSendLifecycle: () => explicitLifecycle,
    isSendPreflightPending: () => preflightPending,
    isSessionStreaming: () => streaming,
    hasPendingToolApprovalForSession: () => approvalPending,
    getCurrentSessionId: () => currentSessionId,
  };
}

function resolveDom(deps, sessionId) {
  const state = { currentSessionId: deps.getCurrentSessionId(), ui: {} };
  const pipeline = createSurfaceStatePipeline({
    state,
    dom: {},
    callbacks: {
      getChatSendLifecycle: deps.getChatSendLifecycle,
      isSendPreflightPending: deps.isSendPreflightPending,
      isSessionStreaming: deps.isSessionStreaming,
      hasPendingToolApprovalForSession: deps.hasPendingToolApprovalForSession,
    },
  });
  return pipeline.resolveChatSendLifecycle(sessionId);
}

function resolveEffects(deps, sessionId) {
  const resolver = createSurfaceActivityResolver(deps);
  return resolver.resolveSurfaceActivityPhase(sessionId);
}

// --- a) Mandatory 5-row table -------------------------------------------

test('effects resolver: explicit streaming + approval pending resolves to awaiting-user', () => {
  const deps = buildResolverDeps({ explicitLifecycle: 'streaming', approvalPending: true });
  assert.equal(resolveEffects(deps, 'session-1'), 'awaiting-user');
});

test('effects resolver: explicit idle + approval pending resolves to awaiting-user', () => {
  const deps = buildResolverDeps({ explicitLifecycle: 'idle', approvalPending: true });
  assert.equal(resolveEffects(deps, 'session-1'), 'awaiting-user');
});

test('effects resolver: explicit failed + approval pending resolves to failed (failed wins)', () => {
  const deps = buildResolverDeps({ explicitLifecycle: 'failed', approvalPending: true });
  assert.equal(resolveEffects(deps, 'session-1'), 'failed');
});

test('effects resolver: explicit settling + no approval resolves to settling', () => {
  const deps = buildResolverDeps({ explicitLifecycle: 'settling', approvalPending: false });
  assert.equal(resolveEffects(deps, 'session-1'), 'settling');
});

test('effects resolver: explicit streaming + no approval resolves to streaming', () => {
  const deps = buildResolverDeps({ explicitLifecycle: 'streaming', approvalPending: false });
  assert.equal(resolveEffects(deps, 'session-1'), 'streaming');
});

// --- b) Edge cases --------------------------------------------------------

test('effects resolver: empty sessionId with empty current session resolves to idle', () => {
  const deps = buildResolverDeps({ currentSessionId: '' });
  assert.equal(resolveEffects(deps, ''), 'idle');
  assert.equal(resolveEffects(deps, undefined), 'idle');
});

test('effects resolver: omitted sessionId falls back to getCurrentSessionId()', () => {
  const deps = buildResolverDeps({ explicitLifecycle: 'streaming', currentSessionId: 'session-9' });
  assert.equal(resolveEffects(deps), 'streaming');
});

test('effects resolver: preflight only applies when session matches current session', () => {
  const deps = buildResolverDeps({ preflightPending: true, currentSessionId: 'session-1' });
  assert.equal(resolveEffects(deps, 'session-1'), 'preflight');
  assert.equal(resolveEffects(deps, 'session-other'), 'idle');
});

test('effects resolver: malformed lifecycle tokens normalize like the DOM resolver', () => {
  const paddedDeps = buildResolverDeps({ explicitLifecycle: 'STREAMING  ' });
  assert.equal(resolveEffects(paddedDeps, 'session-1'), 'streaming');

  const garbageDeps = buildResolverDeps({ explicitLifecycle: 'garbage', streaming: true });
  assert.equal(resolveEffects(garbageDeps, 'session-1'), 'streaming');
});

test('effects resolver: no deps at all resolves to idle without throwing', () => {
  assert.doesNotThrow(() => {
    const resolver = createSurfaceActivityResolver();
    assert.equal(resolver.resolveSurfaceActivityPhase('any-session'), 'idle');
  });
  assert.doesNotThrow(() => {
    const resolver = createSurfaceActivityResolver({});
    assert.equal(resolver.resolveSurfaceActivityPhase(), 'idle');
  });
});

// --- c) Anti-divergence shared table (Rev 2 section 10) -------------------
// Documents the ONLY intended divergence between the DOM resolver
// (resolveChatSendLifecycle) and the effects-facing resolver
// (resolveSurfaceActivityPhase): a pending tool approval surfaces as its own
// 'awaiting-user' phase for effects while the DOM resolver folds it into
// 'streaming'. Every other row must agree.

const antiDivergenceRows = [
  {
    name: 'explicit streaming + approval pending',
    config: { explicitLifecycle: 'streaming', approvalPending: true },
    effects: 'awaiting-user',
    dom: 'streaming',
    divergent: true,
  },
  {
    name: 'explicit idle + approval pending',
    config: { explicitLifecycle: 'idle', approvalPending: true },
    effects: 'awaiting-user',
    dom: 'streaming',
    divergent: true,
  },
  {
    name: 'explicit failed + approval pending',
    config: { explicitLifecycle: 'failed', approvalPending: true },
    effects: 'failed',
    dom: 'failed',
    divergent: false,
  },
  {
    name: 'explicit settling + no approval',
    config: { explicitLifecycle: 'settling', approvalPending: false },
    effects: 'settling',
    dom: 'settling',
    divergent: false,
  },
  {
    name: 'explicit streaming + no approval',
    config: { explicitLifecycle: 'streaming', approvalPending: false },
    effects: 'streaming',
    dom: 'streaming',
    divergent: false,
  },
];

antiDivergenceRows.forEach((row) => {
  test(`anti-divergence table: ${row.name}`, () => {
    const deps = buildResolverDeps(row.config);
    const effectsResult = resolveEffects(deps, 'session-1');
    const domResult = resolveDom(deps, 'session-1');

    assert.equal(effectsResult, row.effects);
    assert.equal(domResult, row.dom);

    if (row.divergent) {
      assert.notEqual(effectsResult, domResult);
      assert.equal(domResult, 'streaming');
      assert.equal(effectsResult, 'awaiting-user');
    } else {
      assert.equal(effectsResult, domResult);
    }
  });
});
