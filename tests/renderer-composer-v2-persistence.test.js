const test = require('node:test');
const assert = require('node:assert/strict');

const { ensureComposerV2State } = require('../renderer/chat/renderer-composer-v2-state');

test('state.ui.composerV2 slots are Map/Set (not JSON-serializable POJOs)', () => {
  const state = {};
  const composer = ensureComposerV2State(state);
  assert.ok(composer.modeListeners instanceof Map);
  assert.ok(composer.globalListeners instanceof Set);
  assert.ok(composer.draftsBySession instanceof Map);
  assert.ok(composer.lifecycleBySession instanceof Map);
  composer.modeListeners.set('s1', new Set([() => {}]));
  composer.globalListeners.add(() => {});
  composer.draftsBySession.set('s1', { prompt: 'draft' });
  composer.lifecycleBySession.set('s1', 'drafting');
  composer.toolToggleState.set('web_search', true);
  composer.availableToolCategories.set('web_search', true);
  composer.toolCategoryMeta.set('web_search', { reason: '' });
  composer.sessionOverrideCategories.add('web_search');

  // Assert the invariant, not a frozen serialization string: every Map/Set slot
  // must serialize to an empty object (Maps/Sets are not JSON-serializable), so
  // no live session state can leak into a persisted snapshot. The old exact
  // string match went stale the moment a new slot landed (e7811b54 added
  // sessionOverrideCategories).
  const snapshot = JSON.parse(JSON.stringify(state.ui.composerV2));
  for (const [key, value] of Object.entries(state.ui.composerV2)) {
    if (value instanceof Map || value instanceof Set) {
      assert.ok(value.size > 0, `${key} is populated for the leak check`);
      assert.deepEqual(snapshot[key], {}, `${key} serializes to an empty object`);
    } else {
      // Plain scalars are allowed through; they must stay JSON-primitive.
      assert.ok(
        value === null || ['boolean', 'number', 'string'].includes(typeof value),
        `${key} is a JSON-primitive scalar slot`
      );
    }
  }
  assert.ok(state.ui.composerV2.sessionOverrideCategories instanceof Set);
});

test('state module does not import FileJsonStore or message-store modules', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const stateSource = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'chat', 'renderer-composer-v2-state.js'),
    'utf8',
  );
  assert.doesNotMatch(stateSource, /FileJsonStore/i, 'must not reference FileJsonStore');
  assert.doesNotMatch(stateSource, /sessions\.json/i, 'must not reference sessions.json');
  assert.doesNotMatch(stateSource, /patchSessionSummary/, 'must not import session-summary mutators');
  assert.doesNotMatch(stateSource, /upsertSessionSummary/, 'must not import session-summary mutators');
});
