'use strict';

/* Split view W0-2 — the pane model.
 *
 * The layout is N-pane from day one even though Wave 0 only ever seeds one:
 * `panes` is an array of `{ paneId, sessionId }` whose ids are re-numbered
 * 0..N-1 on every normalize, so a pane id is always an index into the array
 * and never a durable handle a caller can hold across a normalize.
 *
 * The invariants the later waves lean on, all enforced here:
 *   - one session sits in at most ONE pane (a later duplicate loses its
 *     session, not its pane -- a split view keeps both panes on screen);
 *   - an id the caller says is not a real session becomes '' (blank pane);
 *   - the layout always has at least one pane, whatever the input was;
 *   - everything handed back is frozen, so no consumer can widen it in place.
 *
 * The seed case at the bottom is the reason the module exists in Wave 0: the
 * renderer boot state now carries `state.panes`, and `state.currentSessionId`
 * -- which every existing reader still uses -- is DERIVED from it at the seed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizePaneLayout,
  resolveFocusedPane,
  resolvePaneForSession,
  listPaneSessionIds,
  deriveCurrentSessionId,
} = require('../renderer/shell/renderer-pane-model');

const { createRendererBootstrap } = require('../renderer/shell/renderer-bootstrap-utils');

function paneTuples(layout) {
  return layout.panes.map((pane) => [pane.paneId, pane.sessionId]);
}

test('a missing or malformed layout normalizes to exactly one blank pane', () => {
  for (const raw of [null, undefined, '', 0, 'session-a', [], {}, { panes: [] }, { panes: 'nope' }]) {
    const layout = normalizePaneLayout(raw);
    assert.deepEqual(paneTuples(layout), [[0, '']], `malformed input ${JSON.stringify(raw)} must seed one blank pane`);
    assert.equal(layout.focusedPaneId, 0);
    assert.equal(layout.splitRatio, 0.5);
  }
});

test('pane ids are re-numbered 0..N-1 in array order, whatever the input claimed', () => {
  const layout = normalizePaneLayout({
    panes: [
      { paneId: 7, sessionId: 'session-a' },
      { paneId: 'nonsense', sessionId: 'session-b' },
      { sessionId: 'session-c' },
    ],
  });
  assert.deepEqual(paneTuples(layout), [[0, 'session-a'], [1, 'session-b'], [2, 'session-c']]);
});

test('a pane entry may be a bare session id string', () => {
  const layout = normalizePaneLayout({ panes: ['session-a', 'session-b'] });
  assert.deepEqual(paneTuples(layout), [[0, 'session-a'], [1, 'session-b']]);
});

test('session ids are trimmed and non-string entries blank their pane rather than dropping it', () => {
  const layout = normalizePaneLayout({
    panes: [{ sessionId: '  session-a  ' }, { sessionId: null }, 42, { sessionId: { id: 'x' } }],
  });
  assert.deepEqual(paneTuples(layout), [[0, 'session-a'], [1, ''], [2, ''], [3, '']]);
});

test('a session may sit in at most one pane: the later duplicate keeps its pane and loses the session', () => {
  const layout = normalizePaneLayout({
    panes: [{ sessionId: 'session-a' }, { sessionId: 'session-a' }, { sessionId: 'session-b' }],
  });
  assert.deepEqual(paneTuples(layout), [[0, 'session-a'], [1, ''], [2, 'session-b']]);
  assert.deepEqual(listPaneSessionIds(layout), ['session-a', 'session-b']);
});

test('validSessionIds blanks every pane holding an id the caller does not recognize', () => {
  const raw = { panes: [{ sessionId: 'session-a' }, { sessionId: 'session-gone' }, { sessionId: 'session-b' }] };

  const withArray = normalizePaneLayout(raw, { validSessionIds: ['session-a', 'session-b'] });
  assert.deepEqual(paneTuples(withArray), [[0, 'session-a'], [1, ''], [2, 'session-b']]);

  const withSet = normalizePaneLayout(raw, { validSessionIds: new Set(['session-b']) });
  assert.deepEqual(paneTuples(withSet), [[0, ''], [1, ''], [2, 'session-b']]);

  // An omitted set means "the caller does not know", not "nothing is valid".
  const withoutSet = normalizePaneLayout(raw, {});
  assert.deepEqual(paneTuples(withoutSet), [[0, 'session-a'], [1, 'session-gone'], [2, 'session-b']]);

  // An EMPTY set is a real answer: no session is valid, so every pane blanks.
  const withEmptySet = normalizePaneLayout(raw, { validSessionIds: [] });
  assert.deepEqual(paneTuples(withEmptySet), [[0, ''], [1, ''], [2, '']]);
});

test('focusedPaneId falls back to 0 unless it names a pane that exists', () => {
  const twoPanes = { panes: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }] };
  assert.equal(normalizePaneLayout({ ...twoPanes, focusedPaneId: 1 }).focusedPaneId, 1);
  assert.equal(normalizePaneLayout({ ...twoPanes, focusedPaneId: '1' }).focusedPaneId, 1);
  for (const focusedPaneId of [undefined, null, -1, 2, 9, 1.5, NaN, 'left', {}]) {
    assert.equal(
      normalizePaneLayout({ ...twoPanes, focusedPaneId }).focusedPaneId,
      0,
      `focusedPaneId ${String(focusedPaneId)} must fall back to 0`
    );
  }
});

test('splitRatio defaults to 0.5 and clamps into [0.2, 0.8]', () => {
  const twoPanes = { panes: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }] };
  assert.equal(normalizePaneLayout({ ...twoPanes, splitRatio: 0.35 }).splitRatio, 0.35);
  assert.equal(normalizePaneLayout({ ...twoPanes, splitRatio: 0.2 }).splitRatio, 0.2);
  assert.equal(normalizePaneLayout({ ...twoPanes, splitRatio: 0.8 }).splitRatio, 0.8);
  assert.equal(normalizePaneLayout({ ...twoPanes, splitRatio: 0.05 }).splitRatio, 0.2);
  assert.equal(normalizePaneLayout({ ...twoPanes, splitRatio: 12 }).splitRatio, 0.8);
  assert.equal(normalizePaneLayout({ ...twoPanes, splitRatio: '0.3' }).splitRatio, 0.3);
  // A finite number out of range clamps (0 is a real, if useless, ratio) ...
  assert.equal(normalizePaneLayout({ ...twoPanes, splitRatio: 0 }).splitRatio, 0.2);
  // ... but anything that is not a number or a numeric string is the default,
  // never a clamp edge: '' / false / [] coerce to 0 and true to 1 under Number().
  for (const splitRatio of [undefined, null, NaN, Infinity, 'wide', {}, '', '   ', false, true, []]) {
    assert.equal(
      normalizePaneLayout({ ...twoPanes, splitRatio }).splitRatio,
      0.5,
      `splitRatio ${String(splitRatio)} must fall back to 0.5`
    );
  }
});

test('a malformed validSessionIds is treated as omitted, never as "blank every pane"', () => {
  // A string, a plain object or a number is a caller bug; erring toward "no
  // filtering" keeps the person's panes rather than blanking valid sessions.
  const raw = { panes: [{ sessionId: 'session-a' }, { sessionId: 'session-gone' }] };
  for (const validSessionIds of ['session-a', { 'session-a': true }, 0, 7, true]) {
    assert.deepEqual(
      normalizePaneLayout(raw, { validSessionIds }).panes.map((pane) => pane.sessionId),
      ['session-a', 'session-gone'],
      `validSessionIds ${String(validSessionIds)} must be ignored`
    );
  }
  assert.deepEqual(
    normalizePaneLayout(raw, { validSessionIds: [] }).panes.map((pane) => pane.sessionId),
    ['', ''],
    'an empty list is a real answer'
  );
});

test('the layout, its pane array and every pane entry are frozen', () => {
  const layout = normalizePaneLayout({ panes: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }] });
  assert.equal(Object.isFrozen(layout), true);
  assert.equal(Object.isFrozen(layout.panes), true);
  assert.equal(layout.panes.every((pane) => Object.isFrozen(pane)), true);

  assert.throws(() => { layout.focusedPaneId = 1; }, TypeError);
  assert.throws(() => { layout.panes.push({ paneId: 2, sessionId: 'x' }); }, TypeError);
  assert.throws(() => { layout.panes[0].sessionId = 'hijacked'; }, TypeError);
  assert.deepEqual(paneTuples(layout), [[0, 'session-a'], [1, 'session-b']]);
});

test('resolveFocusedPane returns the focused entry, and falls back to pane 0', () => {
  const layout = normalizePaneLayout({
    panes: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }],
    focusedPaneId: 1,
  });
  assert.deepEqual(resolveFocusedPane(layout), { paneId: 1, sessionId: 'session-b' });

  const defaulted = normalizePaneLayout({ panes: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }] });
  assert.deepEqual(resolveFocusedPane(defaulted), { paneId: 0, sessionId: 'session-a' });

  // Hostile input never throws; there is simply no pane to focus.
  assert.equal(resolveFocusedPane(null), null);
  assert.equal(resolveFocusedPane({}), null);
  assert.equal(resolveFocusedPane({ panes: [] }), null);
});

test('resolvePaneForSession finds the pane holding a session, and never matches a blank', () => {
  const layout = normalizePaneLayout({ panes: [{ sessionId: 'session-a' }, {}, { sessionId: 'session-b' }] });
  assert.deepEqual(resolvePaneForSession(layout, 'session-a'), { paneId: 0, sessionId: 'session-a' });
  assert.deepEqual(resolvePaneForSession(layout, '  session-b  '), { paneId: 2, sessionId: 'session-b' });
  assert.equal(resolvePaneForSession(layout, 'session-missing'), null);
  assert.equal(resolvePaneForSession(layout, ''), null);
  assert.equal(resolvePaneForSession(layout, null), null);
  assert.equal(resolvePaneForSession(null, 'session-a'), null);
});

test('listPaneSessionIds is pane order with no blanks and no duplicates', () => {
  const layout = normalizePaneLayout({ panes: [{}, { sessionId: 'session-b' }, {}, { sessionId: 'session-a' }] });
  assert.deepEqual(listPaneSessionIds(layout), ['session-b', 'session-a']);
  assert.deepEqual(listPaneSessionIds(normalizePaneLayout(null)), []);
  assert.deepEqual(listPaneSessionIds(null), []);
  assert.deepEqual(listPaneSessionIds({ panes: 'nope' }), []);
});

test('deriveCurrentSessionId is the focused pane session, and "" when the focused pane is blank', () => {
  const focusedOnB = normalizePaneLayout({
    panes: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }],
    focusedPaneId: 1,
  });
  assert.equal(deriveCurrentSessionId(focusedOnB), 'session-b');
  assert.equal(deriveCurrentSessionId(normalizePaneLayout({ panes: [{}, { sessionId: 'session-b' }] })), '');
  assert.equal(deriveCurrentSessionId(normalizePaneLayout(null)), '');
  assert.equal(deriveCurrentSessionId(null), '');
});

test('the renderer boot seed carries one blank pane and derives currentSessionId from it', () => {
  // No test builds the boot state today, so this is the seed's first gate. The
  // bootstrap only needs a document that answers getElementById; every DOM
  // lookup it makes at construction is lazy or tolerant of a miss.
  const documentStub = {
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const bootstrap = createRendererBootstrap({
    document: documentStub,
    getDefaultAppearancePreferences: () => ({}),
    appearanceUtils: { STORAGE_KEY: 'jenny.appearance.test' },
  });

  assert.deepEqual(paneTuples(bootstrap.state.panes), [[0, '']]);
  assert.equal(bootstrap.state.panes.focusedPaneId, 0);
  assert.equal(bootstrap.state.panes.splitRatio, 0.5);
  // Unchanged from before the pane model existed: every existing reader of
  // state.currentSessionId sees exactly the empty string it saw at boot.
  assert.equal(bootstrap.state.currentSessionId, '');
  assert.equal(deriveCurrentSessionId(bootstrap.state.panes), bootstrap.state.currentSessionId);
  // W0-2 adds the pane layout beside `workspace` and changes nothing else.
  assert.deepEqual(bootstrap.state.workspace, { activeSessionId: '', openSessionIds: [] });
});
