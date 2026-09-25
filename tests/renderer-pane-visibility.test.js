'use strict';

/* Split view W0-3 — the per-pane visibility predicate.
 *
 * `isVisibleChatSession` in renderer-stream-handler.js was, and with one pane
 * must remain, exactly:
 *
 *     normalizeId(sessionId) === normalizeId(state.currentSessionId)
 *       && isChatSurfaceLive(state)
 *
 * That expression is reproduced verbatim below as `legacyIsVisibleChatSession`
 * and is the oracle for the one-pane half of this suite: the new predicate is
 * asserted EQUAL to it across the whole (session x view x flag x dock) matrix,
 * so Wave 0 cannot change a single answer the six DI submodules read.
 *
 * The second half is the part Wave 0 buys: with two panes in `state.panes`, a
 * session the person is NOT "currently" on is visible in its own pane and in
 * "any pane", while the current session stays visible in pane 0.
 *
 * The fallback the one-pane half exercises matters: W0-2 seeds `state.panes`
 * but does NOT rewire the writers of `state.currentSessionId`, so at runtime
 * today the seeded layout stays blank while `currentSessionId` moves. A blank
 * layout therefore has to mean "ask currentSessionId", not "nothing is
 * visible" -- the same rule W0-5's retained set uses.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isSessionVisibleInPane,
  isSessionVisibleInAnyPane,
} = require('../renderer/chat/renderer-pane-visibility-utils');
const { isChatSurfaceLive } = require('../renderer/chat/renderer-chat-surface-live-utils');
const { normalizePaneLayout } = require('../renderer/shell/renderer-pane-model');

// The pre-W0-3 expression, character for character (normalizeId is
// `String(value || '').trim()` in renderer/shared/string-utils.js).
function legacyIsVisibleChatSession(state, sessionId) {
  const normalizeId = (value) => String(value || '').trim();
  return normalizeId(sessionId) === normalizeId(state.currentSessionId) && isChatSurfaceLive(state);
}

const SURFACES = [
  { label: 'chat view', ui: { activeView: 'chat' }, flags: {} },
  { label: 'chat view + dock flag on', ui: { activeView: 'chat', ideChatDockOpen: false }, flags: { ide_chat_dock: true } },
  { label: 'workspace + dock open + flag on', ui: { activeView: 'ide', ideChatDockOpen: true }, flags: { ide_chat_dock: true } },
  { label: 'workspace + dock closed + flag on', ui: { activeView: 'ide', ideChatDockOpen: false }, flags: { ide_chat_dock: true } },
  { label: 'workspace + dock open + flag off', ui: { activeView: 'ide', ideChatDockOpen: true }, flags: { ide_chat_dock: false } },
  { label: 'settings view', ui: { activeView: 'settings' }, flags: { ide_chat_dock: true } },
  { label: 'home view', ui: { activeView: 'home' }, flags: {} },
];

function makeState(surface, { currentSessionId, panes }) {
  const state = {
    currentSessionId,
    ui: { ...surface.ui },
    features: { featureFlags: { ...surface.flags } },
  };
  if (panes !== undefined) state.panes = panes;
  return state;
}

test('with one blank seeded pane, every surface answers exactly what the old expression answered', () => {
  const seeded = normalizePaneLayout(null);
  const probes = ['session-current', 'session-other', '', '  session-current  ', null];
  let checked = 0;
  for (const surface of SURFACES) {
    for (const currentSessionId of ['session-current', '']) {
      const state = makeState(surface, { currentSessionId, panes: seeded });
      for (const probe of probes) {
        const expected = legacyIsVisibleChatSession(state, probe);
        assert.equal(
          isSessionVisibleInAnyPane(state, probe),
          expected,
          `${surface.label} / current=${JSON.stringify(currentSessionId)} / probe=${JSON.stringify(probe)}`
        );
        assert.equal(
          isSessionVisibleInPane(state, probe, 0),
          expected,
          `pane 0 is the only pane: ${surface.label} / probe=${JSON.stringify(probe)}`
        );
        checked += 1;
      }
    }
  }
  assert.equal(checked, SURFACES.length * 2 * probes.length);
});

test('a state with no pane layout at all still answers exactly what the old expression answered', () => {
  // Every harness fixture and every state built before W0-2 is this shape.
  for (const surface of SURFACES) {
    const state = makeState(surface, { currentSessionId: 'session-current' });
    assert.equal(state.panes, undefined);
    assert.equal(
      isSessionVisibleInAnyPane(state, 'session-current'),
      legacyIsVisibleChatSession(state, 'session-current'),
      `${surface.label}: current session`
    );
    assert.equal(
      isSessionVisibleInAnyPane(state, 'session-other'),
      false,
      `${surface.label}: a session that is not the current one is never visible with one pane`
    );
  }
});

test('hostile states never throw and are never visible', () => {
  assert.equal(isSessionVisibleInAnyPane(null, 'session-a'), false);
  assert.equal(isSessionVisibleInAnyPane(undefined, 'session-a'), false);
  assert.equal(isSessionVisibleInAnyPane({}, 'session-a'), false);
  assert.equal(isSessionVisibleInAnyPane({ ui: {} }, ''), false);
  assert.equal(isSessionVisibleInPane(null, 'session-a', 0), false);
  assert.equal(isSessionVisibleInPane({ ui: { activeView: 'chat' }, currentSessionId: 'session-a' }, 'session-a', 3), false);
  assert.equal(isSessionVisibleInPane({ ui: { activeView: 'chat' }, currentSessionId: 'session-a' }, 'session-a', 'left'), false);
});

test('a blank pane holds no session, and matches only the blank id the old expression matched', () => {
  const state = makeState(SURFACES[0], {
    currentSessionId: 'session-a',
    panes: normalizePaneLayout({ panes: [{ sessionId: 'session-a' }, {}] }),
  });
  assert.equal(isSessionVisibleInPane(state, 'session-a', 1), false);
  assert.equal(isSessionVisibleInPane(state, 'session-b', 1), false);
  assert.equal(isSessionVisibleInAnyPane(state, 'session-b'), false);
  // Pinned, not endorsed, in the ONE-PANE branch: the expression this replaces
  // compared normalized ids with NO blank guard, so a blank id matched a blank
  // current session on a live surface, and an invisible refactor does not get
  // to tighten that. The PANE branch is a new answer and does guard (the
  // independent review's finding): a blank pane holds nothing, so a payload
  // with no session id is never "visible" because a pane happens to be empty.
  const blankCurrent = makeState(SURFACES[0], { currentSessionId: '', panes: normalizePaneLayout(null) });
  assert.equal(legacyIsVisibleChatSession(blankCurrent, ''), true);
  assert.equal(isSessionVisibleInAnyPane(blankCurrent, ''), true);
  assert.equal(isSessionVisibleInPane(blankCurrent, '', 0), true);
  for (const blank of ['', '   ', null, undefined]) {
    assert.equal(isSessionVisibleInPane(state, blank, 1), false, `pane 1 never shows ${String(blank)}`);
    assert.equal(isSessionVisibleInAnyPane(state, blank), false, `no pane shows ${String(blank)}`);
  }
});

test('the predicates read the layout in place: no pane model global, no allocation-bearing helper', () => {
  // The gate runs per delta. It must not depend on renderer-pane-model.js (which
  // loads later in index.html) and must not build arrays or Sets per call.
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'chat', 'renderer-pane-visibility-utils.js'), 'utf8'
  ).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/rendererPaneModel|listPaneSessionIds|require\('\.\.\/shell/.test(source), false);
  assert.equal(/new Set\(|\.map\(|\.filter\(|\.indexOf\(|Array\.from/.test(source), false);
});

test('with two panes, the second pane session is visible in its pane and in any pane', () => {
  const panes = normalizePaneLayout({ panes: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }] });
  const live = makeState(SURFACES[0], { currentSessionId: 'session-a', panes });

  assert.equal(isSessionVisibleInPane(live, 'session-a', 0), true);
  assert.equal(isSessionVisibleInPane(live, 'session-b', 1), true);
  assert.equal(isSessionVisibleInAnyPane(live, 'session-a'), true);
  assert.equal(isSessionVisibleInAnyPane(live, 'session-b'), true);
  // The pane a session is NOT in never claims it.
  assert.equal(isSessionVisibleInPane(live, 'session-a', 1), false);
  assert.equal(isSessionVisibleInPane(live, 'session-b', 0), false);
  // A session in no pane is in no pane.
  assert.equal(isSessionVisibleInAnyPane(live, 'session-c'), false);
  // Ids are compared the way the stream handler compared them.
  assert.equal(isSessionVisibleInAnyPane(live, '  session-b  '), true);

  // This is the one Wave 0 answer that a single pane could never give: the
  // second pane's session is visible although it is not `currentSessionId`.
  assert.equal(legacyIsVisibleChatSession(live, 'session-b'), false);
});

test('the surface gate still dominates both panes', () => {
  const panes = normalizePaneLayout({ panes: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }] });
  for (const surface of SURFACES) {
    const state = makeState(surface, { currentSessionId: 'session-a', panes });
    const live = isChatSurfaceLive(state);
    assert.equal(isSessionVisibleInPane(state, 'session-a', 0), live, `${surface.label}: pane 0`);
    assert.equal(isSessionVisibleInPane(state, 'session-b', 1), live, `${surface.label}: pane 1`);
    assert.equal(isSessionVisibleInAnyPane(state, 'session-b'), live, `${surface.label}: any pane`);
  }
});
