const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COMPOSER_LIFECYCLE,
  ensureComposerV2State,
  getDraftForSession,
  getLifecycleForSession,
  setDraftForSession,
  setLifecycleForSession,
} = require('../renderer/chat/renderer-composer-v2-state');

test('ensureComposerV2State attaches controller collections lazily and idempotently', () => {
  const state = {};
  const first = ensureComposerV2State(state);
  assert.ok(state.ui, 'state.ui should be created');
  assert.ok(state.ui.composerV2, 'state.ui.composerV2 should be created');
  assert.ok(first.modeListeners instanceof Map, 'modeListeners should be a Map');
  assert.ok(first.globalListeners instanceof Set, 'globalListeners should be a Set');
  assert.ok(first.draftsBySession instanceof Map, 'draftsBySession should be a Map');
  assert.ok(first.lifecycleBySession instanceof Map, 'lifecycleBySession should be a Map');

  const second = ensureComposerV2State(state);
  assert.strictEqual(first, second, 'second call returns the same composerV2 instance');
  assert.strictEqual(first.modeListeners, second.modeListeners, 'modeListeners Map is preserved');
  assert.strictEqual(first.globalListeners, second.globalListeners, 'globalListeners Set is preserved');
  assert.strictEqual(first.draftsBySession, second.draftsBySession, 'draftsBySession Map is preserved');
  assert.strictEqual(first.lifecycleBySession, second.lifecycleBySession, 'lifecycleBySession Map is preserved');
});

test('ensureComposerV2State repairs missing collections without clobbering existing ones', () => {
  const state = { ui: { composerV2: { modeListeners: 'not-a-map', globalListeners: null, draftsBySession: [], lifecycleBySession: {} } } };
  const repaired = ensureComposerV2State(state);
  assert.ok(repaired.modeListeners instanceof Map, 'invalid modeListeners replaced with Map');
  assert.ok(repaired.globalListeners instanceof Set, 'missing globalListeners replaced with Set');
  assert.ok(repaired.draftsBySession instanceof Map, 'invalid draftsBySession replaced with Map');
  assert.ok(repaired.lifecycleBySession instanceof Map, 'invalid lifecycleBySession replaced with Map');
});

test('setLifecycleForSession follows allowed transitions and rejects illegal transitions', () => {
  const state = {};
  const warnings = [];

  assert.equal(getLifecycleForSession(state, 's1'), COMPOSER_LIFECYCLE.IDLE);

  assert.deepEqual(
    setLifecycleForSession(state, 's1', COMPOSER_LIFECYCLE.DRAFTING),
    { ok: true, previous: 'idle', lifecycle: 'drafting' },
  );
  assert.equal(getLifecycleForSession(state, 's1'), COMPOSER_LIFECYCLE.DRAFTING);

  assert.deepEqual(
    setLifecycleForSession(state, 's1', COMPOSER_LIFECYCLE.QUEUED),
    { ok: true, previous: 'drafting', lifecycle: 'queued' },
  );

  const rejected = setLifecycleForSession(state, 's1', COMPOSER_LIFECYCLE.FAILED, {
    log(details) {
      warnings.push(details);
    },
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'illegal_transition');
  assert.equal(rejected.previous, COMPOSER_LIFECYCLE.QUEUED);
  assert.equal(getLifecycleForSession(state, 's1'), COMPOSER_LIFECYCLE.QUEUED);
  assert.equal(warnings.length, 1);
  assert.deepEqual(
    warnings[0],
    { sessionId: 's1', previous: 'queued', lifecycle: 'failed', reason: 'illegal_transition' },
  );

  assert.equal(setLifecycleForSession(state, 's1', COMPOSER_LIFECYCLE.SENDING).ok, true);
  assert.equal(setLifecycleForSession(state, 's1', COMPOSER_LIFECYCLE.DRAFTING).ok, true);
  assert.equal(setLifecycleForSession(state, 's1', COMPOSER_LIFECYCLE.SENDING).ok, true);
  assert.equal(setLifecycleForSession(state, 's1', COMPOSER_LIFECYCLE.FAILED).ok, true);
  assert.equal(setLifecycleForSession(state, 's1', COMPOSER_LIFECYCLE.DRAFTING).ok, true);
  assert.equal(setLifecycleForSession(state, 's1', COMPOSER_LIFECYCLE.IDLE).ok, true);
  assert.equal(getLifecycleForSession(state, 's1'), COMPOSER_LIFECYCLE.IDLE);
  assert.equal(ensureComposerV2State(state).lifecycleBySession.has('s1'), false);
});

test('draft helpers store deep-copied draft metadata without persistence writes', () => {
  const state = {};
  const attachment = { id: 'a1', nested: { name: 'before' } };
  const meta = { queue: { reason: 'busy' } };
  const runtimePreferences = {
    contextPreferences: { historyScope: 'recent' },
  };

  const stored = setDraftForSession(state, 's1', {
    prompt: 'draft',
    attachments: [attachment],
    runtimePreferences,
    source: 'queued',
    meta,
    createdAt: 123,
  });

  attachment.nested.name = 'after';
  meta.queue.reason = 'mutated';
  runtimePreferences.contextPreferences.historyScope = 'fresh';

  assert.deepEqual(stored, {
    sessionId: 's1',
    prompt: 'draft',
    attachments: [{ id: 'a1', nested: { name: 'before' } }],
    runtimePreferences: { contextPreferences: { historyScope: 'recent' } },
    createdAt: 123,
    source: 'queued',
    meta: { queue: { reason: 'busy' } },
  });

  const restored = getDraftForSession(state, 's1');
  assert.deepEqual(restored, stored);
  restored.attachments[0].nested.name = 'consumer-mutated';
  assert.equal(getDraftForSession(state, 's1').attachments[0].nested.name, 'before');
});

test('draft helpers scrub unsafe clone keys and tolerate circular metadata', () => {
  const state = {};
  const circularMeta = { label: 'meta' };
  const circularAttachment = { id: 'a1' };
  circularMeta.self = circularMeta;
  circularAttachment.self = circularAttachment;
  const unsafePayload = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"polluted":true},"safe":true}');

  const stored = setDraftForSession(state, 's1', {
    prompt: 'draft',
    attachments: [circularAttachment, unsafePayload],
    source: 'queued',
    meta: { circularMeta, unsafePayload },
  });

  assert.equal(stored.meta.circularMeta.self, null);
  assert.equal(stored.attachments[0].self, null);
  assert.deepEqual(stored.meta.unsafePayload, { safe: true });
  assert.deepEqual(stored.attachments[1], { safe: true });
  assert.equal({}.polluted, undefined);

  const restored = getDraftForSession(state, 's1');
  assert.equal(restored.meta.circularMeta.self, null);
  assert.deepEqual(restored.meta.unsafePayload, { safe: true });
});

// Split view W2-2a: a send resolves the REQUESTED session's preferences, so a
// send from pane 1 carries pane 1's model, effort and run mode whichever pane
// is focused. Without a session (or a reader) it is `current()` as before.
test('resolveSendRuntimePreferences reads the requested session through fromSession', () => {
  const { resolveSendRuntimePreferences, cloneJsonLike } = require('../renderer/chat/renderer-composer-v2-state');
  const focused = { preferredModel: 'model-x', reasoningEffort: 'high', runMode: 'ask', planMode: false };
  const sessionB = { id: 'session-b', preferred_model: 'model-y', reasoning_effort: 'low', run_mode: 'auto', plan_mode: false };
  const fromSession = (session) => ({
    preferredModel: session.preferred_model, reasoningEffort: session.reasoning_effort, runMode: session.run_mode, planMode: session.plan_mode === true,
  });

  const resolved = resolveSendRuntimePreferences({ session: sessionB, current: () => focused, clone: cloneJsonLike, fromSession });
  assert.deepEqual(resolved, { preferredModel: 'model-y', reasoningEffort: 'low', runMode: 'auto', planMode: false });

  assert.deepEqual(
    resolveSendRuntimePreferences({ session: null, current: () => focused, clone: cloneJsonLike, fromSession }),
    focused,
    'no requested session: the current preferences'
  );
  assert.deepEqual(
    resolveSendRuntimePreferences({ session: sessionB, current: () => focused, clone: cloneJsonLike }),
    focused,
    'no reader: the current preferences (the pre-split contract)'
  );
});

test('resolveSendRuntimePreferences keeps a queued snapshot frozen and re-reads only the live run mode', () => {
  const { resolveSendRuntimePreferences, cloneJsonLike } = require('../renderer/chat/renderer-composer-v2-state');
  const snapshot = { preferredModel: 'model-q', reasoningEffort: 'medium', runMode: 'ask', planMode: false };
  const sessionB = { id: 'session-b', preferred_model: 'model-y', reasoning_effort: 'low', run_mode: 'plan', plan_mode: true, pre_plan_run_mode: 'auto' };
  const resolved = resolveSendRuntimePreferences({
    snapshot, session: sessionB, current: () => ({}), clone: cloneJsonLike, fromSession: () => ({ preferredModel: 'wrong' }),
  });
  assert.deepEqual(resolved, { preferredModel: 'model-q', reasoningEffort: 'medium', runMode: 'plan', planMode: true, prePlanRunMode: 'auto' });
});

test('a pending skill whose session another pane still shows is kept, not dropped, by a read bound elsewhere (W3-1)', () => {
  const api = require('../renderer/chat/renderer-composer-v2-state');
  const previous = globalThis.rendererPaneVisibilityUtils;
  const visible = new Set(['sess-B']);
  globalThis.rendererPaneVisibilityUtils = { isSessionVisibleInAnyPane: (_state, id) => visible.has(id) };
  try {
    const state = { currentSessionId: 'sess-A' };
    api.setPendingSkillInvocation(state, { id: 'skill-1', name: 'Research' }, { getSessionId: () => 'sess-B' });
    assert.equal(api.getPendingSkillInvocation(state), null, 'pane 0 (sess-A) does not see pane 1\'s skill');
    assert.equal(api.peekPendingSkillInvocation(state, 'sess-B').id, 'skill-1', 'pane 1 still holds it');
    visible.delete('sess-B');
    assert.equal(api.getPendingSkillInvocation(state), null);
    assert.equal(api.peekPendingSkillInvocation(state, 'sess-B'), null, 'once no pane shows it, the old drop applies');
  } finally {
    if (previous === undefined) delete globalThis.rendererPaneVisibilityUtils;
    else globalThis.rendererPaneVisibilityUtils = previous;
  }
});
