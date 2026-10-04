'use strict';

/* CTR-010 -- each split-view pane owns its reasoning controller.
 *
 * One ThinkingPanelController used to be injected into both panes. A full render
 * of a pane hydrates persisted disclosure state with
 * syncPersistedReasoningPhaseExpansionState(paneSessionId, messages), which clears
 * the controller's phaseExpansionState and loads ONE session, and then prunes it
 * to that pane's messages: so rendering pane B wiped pane A's entries, A's DOM
 * still showed the disclosure open, and the next click computed from the collapsed
 * default and "opened" it again (aria-expanded false -> true -> true -> true).
 *
 * With one controller per pane the clear-then-load and prune are correct per pane;
 * these tests pin the hydration target and the per-call controller of the shared
 * reasoning renderer. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

delete global.rendererAppLifecyclePreferences;
require('../renderer/app/renderer-app-lifecycle-preferences');
const { createReasoningPhaseExpansionController } = global.rendererAppLifecyclePreferences;
const { ThinkingPanelController, groupReasoningByPhase, shouldShowThinkingToggle } = require('../renderer/chat/chat-thinking-utils');
const { createReasoningV2Renderer } = require('../renderer/chat/renderer-transcript-reasoning-v2');

function makePreferences(appController) {
  const storage = { getItem: () => '', setItem: () => {} };
  const state = { ui: { reasoningPhaseExpansionBySession: new Map() } };
  const preferences = createReasoningPhaseExpansionController({
    state, storage, storageKey: 'pane-reasoning-test', getThinkingController: () => appController,
  });
  return { preferences, state };
}

test('hydrating pane B into its own controller leaves pane A disclosure state intact, so the next click closes it', () => {
  const paneA = new ThinkingPanelController();
  const paneB = new ThinkingPanelController();
  const { preferences } = makePreferences(paneA);

  // Pane A: the reader opens the (default collapsed) disclosure; it is persisted too.
  assert.equal(paneA.togglePhaseExpanded('msg_a', 'phase_1', false), true);
  preferences.setReasoningPhaseExpandedPreference('session_a', 'msg_a', 'phase_1', true, { defaultExpanded: false });
  preferences.setReasoningPhaseExpandedPreference('session_b', 'msg_b', 'phase_1', true, { defaultExpanded: false });

  // Pane B renders: hydrate its session into ITS controller, then prune to its messages.
  preferences.syncPersistedReasoningPhaseExpansionState('session_b', [{ id: 'msg_b' }], paneB);
  paneB.prune(['msg_b']);

  assert.equal(paneB.isPhaseExpanded('msg_b', 'phase_1', false), true, 'pane B hydrated its own persisted state');
  assert.equal(paneB.isPhaseExpanded('msg_a', 'phase_1', false), false, 'pane B never held pane A state');
  assert.equal(paneA.isPhaseExpanded('msg_a', 'phase_1', false), true, 'pane A state survived the render of pane B');
  assert.equal(paneA.togglePhaseExpanded('msg_a', 'phase_1', false), false, 'the next click on pane A closes the disclosure');
});

test('without a controller argument the app-level controller is hydrated, as before', () => {
  const app = new ThinkingPanelController();
  const { preferences } = makePreferences(app);
  preferences.setReasoningPhaseExpandedPreference('session_a', 'msg_a', 'phase_1', true, { defaultExpanded: false });

  preferences.syncPersistedReasoningPhaseExpansionState('session_a', [{ id: 'msg_a' }]);

  assert.equal(app.isPhaseExpanded('msg_a', 'phase_1', false), true);
});

test('hydrating and pruning pane B leaves pane A pause reasons alone', () => {
  const paneA = new ThinkingPanelController();
  const paneB = new ThinkingPanelController();
  const { preferences } = makePreferences(paneA);
  paneA.handleScroll({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });
  assert.equal(paneA.isReaderAway(), true);
  paneB.togglePhaseExpanded('msg_b', 'phase_1', false);
  preferences.setReasoningPhaseExpandedPreference('session_b', 'msg_b', 'phase_1', true, { defaultExpanded: false });
  assert.equal(paneB.shouldAutoScroll(), false, 'pane B paused for its expanded disclosure');
  assert.equal(paneA.autoScrollPauseReasons.has('reasoning_expanded'), false);

  preferences.syncPersistedReasoningPhaseExpansionState('session_b', [{ id: 'msg_b' }], paneB);
  paneB.prune(['msg_b']);

  assert.equal(paneA.isReaderAway(), true, 'pane A reader_away survived');
  assert.equal(paneA.shouldAutoScroll(), false);
  paneA.resumeAutoScroll('reader_away');
  assert.equal(paneB.shouldAutoScroll(), false, 'pane B pause is not cleared by pane A');
});

function makeSharedRenderer(appController) {
  return createReasoningV2Renderer({
    escapeHtml: (s) => String(s),
    groupReasoningByPhase,
    getReasoningEntries: (message) => message?.reasoning?.entries || [],
    renderMarkdown: (text) => `<p>${text}</p>`,
    renderStreamingMarkdownUnits: (text) => ({ html: `<p>${text}</p>`, units: [] }),
    shouldShowThinkingToggle,
    thinkingController: appController,
  });
}

function settledMessage(id, text) {
  return {
    id, role: 'assistant', status: 'complete',
    reasoning: { source: 'provider', status: 'complete', entries: [{ text, thinkingId: 'tid_1' }] },
  };
}

function ariaExpanded(html) {
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const toggle = doc.querySelector('[data-reasoning-toggle]');
  return { expanded: toggle.getAttribute('aria-expanded'), phaseKey: toggle.getAttribute('data-phase-key') };
}

test('the shared reasoning renderer reads the controller passed per call, falling back to its own', () => {
  const app = new ThinkingPanelController();
  const other = new ThinkingPanelController();
  const renderer = makeSharedRenderer(app);
  const message = settledMessage('msg_settled', 'Worked it out');
  const render = (options) => ariaExpanded(renderer.renderThinkingWidget(message, 'msg_latest', options));
  const { phaseKey } = render();
  assert.ok(phaseKey, 'the phase renders a toggle');

  app.togglePhaseExpanded(message.id, phaseKey, false);
  assert.equal(render().expanded, 'true', 'closed-over controller: open');
  assert.equal(render({ thinkingController: app }).expanded, 'true');
  assert.equal(render({ thinkingController: other }).expanded, 'false', 'the other pane own controller: still closed');

  other.togglePhaseExpanded(message.id, phaseKey, false);
  app.togglePhaseExpanded(message.id, phaseKey, false);
  assert.equal(render({ thinkingController: other }).expanded, 'true');
  assert.equal(render().expanded, 'false', 'closing in one controller does not close the other');
});

test('the settled-body cache cannot carry one pane expansion state to the other', () => {
  const app = new ThinkingPanelController();
  const other = new ThinkingPanelController();
  const renderer = makeSharedRenderer(app);
  const message = settledMessage('msg_cache', 'Cached body');
  const { phaseKey } = ariaExpanded(renderer.renderThinkingWidget(message, 'msg_latest'));
  app.togglePhaseExpanded(message.id, phaseKey, false);

  // Same message, same cache key, two panes: the cached body html is shared, the open state is not.
  const first = renderer.renderThinkingWidget(message, 'msg_latest');
  const second = renderer.renderThinkingWidget(message, 'msg_latest', { thinkingController: other });
  assert.equal(ariaExpanded(first).expanded, 'true');
  assert.equal(ariaExpanded(second).expanded, 'false');
  assert.match(first, /reasoning-row-panel expanded/);
  assert.doesNotMatch(second, /reasoning-row-panel expanded/);
  assert.match(second, /Cached body/, 'the settled body itself still comes from the shared cache');
});
