const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

function dispatchWheel(window, target, options = {}) {
  const event = new window.WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    ...options,
  });
  target.dispatchEvent(event);
  return event;
}

function readCssRuleBlock(css, selector) {
  const escapedSelector = String(selector).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`).exec(css);
  assert.ok(match, `expected ${selector} CSS rule`);
  return match[1];
}

function readImportedCssSurface(rootDir, importPrefix) {
  const stylesCss = fs.readFileSync(path.join(rootDir, 'styles.css'), 'utf8');
  return stylesCss
    .split(/\r?\n/)
    .map((line) => line.match(/url\("([^"]+)"\)/)?.[1])
    .filter((importPath) => importPath && importPath.startsWith(importPrefix))
    .map((importPath) => fs.readFileSync(path.join(rootDir, importPath.slice(2)), 'utf8'))
    .join('\n');
}

test('renderer syncs chat viewport variables across resize, activation, and context-panel toggles', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const root = doc.documentElement;
  const chatView = doc.getElementById('chatView');
  const heroStage = doc.getElementById('heroStage');
  const chatThreadStage = doc.getElementById('chatThreadStage');
  const composerWrap = doc.getElementById('composerWrap');
  const contextPanelToggle = doc.getElementById('contextPanelToggle');
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');

  let stageBottom = 620;
  let composerGap = 12;
  let composerHeight = 138;

  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    writable: true,
    value: 790,
  });
  chatView.getBoundingClientRect = () => ({ top: 0, bottom: 790, width: 980, height: 790 });
  chatThreadStage.getBoundingClientRect = () => ({ top: 0, bottom: stageBottom, width: 640, height: stageBottom });
  composerWrap.getBoundingClientRect = () => ({
    top: stageBottom + composerGap,
    bottom: stageBottom + composerGap + composerHeight,
    width: 640,
    height: composerHeight,
  });

  window.dispatchEvent(new window.Event('resize'));
  await waitForUi(window, 40);

  assert.ok(heroStage);
  assert.equal(root.style.getPropertyValue('--app-window-height'), '790px');
  assert.equal(chatView.style.getPropertyValue('--composer-safe-offset'), '40px');
  assert.equal(chatView.style.getPropertyValue('--empty-hero-stage-bottom'), '40px');

  input.value = 'Kick off a layout sync';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 40);

  assert.equal(chatView.classList.contains('chat-active'), true);
  assert.equal(chatView.style.getPropertyValue('--composer-safe-offset'), '40px');
  assert.equal(chatView.style.getPropertyValue('--empty-hero-stage-bottom'), '40px');

  composerGap = 24;
  contextPanelToggle.click();
  await waitForUi(window, 40);
  window.dispatchEvent(new window.Event('resize'));
  await waitForUi(window, 40);

  assert.equal(chatView.style.getPropertyValue('--composer-safe-offset'), '52px');
  assert.equal(chatView.style.getPropertyValue('--empty-hero-stage-bottom'), '52px');
});

test('renderer keeps splash composer focusable while prompt chips stay interactive', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const promptGrid = doc.getElementById('promptGrid');
  const input = doc.getElementById('chatInput');

  await waitForUi(window, 40);

  assert.equal(input.disabled, false, 'composer input should be enabled on a fresh splash');
  input.focus();
  assert.equal(doc.activeElement, input, 'composer input should remain focusable on splash');
  assert.equal(input.value, '');
  assert.ok(promptGrid);
  const promptChip = promptGrid.querySelector('[data-prompt]');
  assert.ok(promptChip, 'prompt plumbing should render at least one splash chip');
  promptChip.click();
  await waitForUi(window, 20);
  assert.equal(input.value.length > 0, true, 'clicking a splash chip should seed the composer draft');
});

test('renderer syncs thread and composer surface-state attributes from renderer-local state', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const state = window.__rendererState;
  const shell = window.jennyShell;
  const chatThreadStage = doc.getElementById('chatThreadStage');
  const composerWrap = doc.getElementById('composerWrap');
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');

  input.value = 'Map the workbench state';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 80);

  const sessionId = String(state.currentSessionId || '').trim();
  assert.equal(sessionId, 'session-1');

  await shell.__emitChat({
    type: 'done',
    sessionId,
    streamId: 'stream-test-1',
    content: 'Workbench state mapped.',
  });
  await waitForUi(window, 40);

  state.pendingToolApprovals.clear();
  state.ui.followLatest = true;
  input.blur();
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitForUi(window, 20);

  assert.equal(chatThreadStage.dataset.surfaceState, 'idle');
  assert.equal(composerWrap.dataset.surfaceState, 'idle');

  state.messagesBySession.set(sessionId, [{
    id: 'assistant_surface_state',
    role: 'assistant',
    kind: 'assistant',
    content: 'Workbench state mapped.',
    status: 'done',
  }]);

  state.pendingToolApprovals.set('call-1', { sessionId });
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitForUi(window, 20);
  assert.match(chatThreadStage.dataset.surfaceState, /\bbusy\b/);

  state.pendingToolApprovals.clear();
  state.messagesBySession.get(sessionId)[0].status = 'error';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitForUi(window, 20);
  assert.match(chatThreadStage.dataset.surfaceState, /\berror\b/);

  // A user-intent terminal (stop/deny) keeps the coarse error status but must
  // not light the red thread glow (GUI finding 2026-07-20).
  state.messagesBySession.get(sessionId)[0].terminal_status = 'cancelled';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitForUi(window, 20);
  assert.doesNotMatch(chatThreadStage.dataset.surfaceState, /\berror\b/);
  delete state.messagesBySession.get(sessionId)[0].terminal_status;

  state.messagesBySession.get(sessionId)[0].status = 'done';
  state.ui.followLatest = false;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitForUi(window, 20);
  assert.match(chatThreadStage.dataset.surfaceState, /\bactive\b/);

  input.value = 'Draft reply';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitForUi(window, 20);
  assert.match(composerWrap.dataset.surfaceState, /\bactive\b/);

  input.value = '';
  state.ui.followLatest = true;
  input.blur();
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitForUi(window, 20);
  assert.equal(chatThreadStage.dataset.surfaceState, 'idle');
  assert.equal(composerWrap.dataset.surfaceState, 'idle');
});

test('renderer exposes stable send lifecycle attributes across send and settle phases', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const state = window.__rendererState;
  const shell = window.jennyShell;
  const chatView = doc.getElementById('chatView');
  const composerWrap = doc.getElementById('composerWrap');
  const composer = doc.querySelector('.composer');
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');

  input.value = 'Keep the handoff calm';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 40);

  const sessionId = String(state.currentSessionId || '').trim();
  assert.equal(chatView.dataset.sendLifecycle, 'streaming');
  assert.equal(composerWrap.dataset.sendLifecycle, 'streaming');
  assert.equal(composer.dataset.sendLifecycle, 'streaming');
  assert.equal(doc.querySelectorAll('.chat-entry').length, 1);

  shell.__state.messagesBySession.set(sessionId, [
    {
      id: 'user_surface_lifecycle',
      role: 'user',
      content: 'Keep the handoff calm',
      status: 'complete',
    },
    {
      id: 'assistant_surface_lifecycle',
      role: 'assistant',
      content: 'Calm reply complete.',
      status: 'complete',
    },
  ]);
  await shell.__emitChat({
    type: 'done',
    sessionId,
    streamId: 'stream-test-1',
    content: 'Calm reply complete.',
  });
  await waitForUi(window, 40);

  assert.equal(chatView.dataset.sendLifecycle, 'idle');
  assert.equal(composerWrap.dataset.sendLifecycle, 'idle');
  assert.equal(composer.dataset.sendLifecycle, 'idle');
  assert.equal(doc.querySelectorAll('.chat-entry').length, 2);
});

test('surface effects stay on chat gutters across empty and threaded chat while home keeps the shared effect contract', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    appearance: {
      paletteId: 'midnight',
      typographyId: 'system',
      motionId: 'standard',
      surfaceEffectId: 'reactive-grid',
    },
  });
  const doc = window.document;
  const homeView = doc.getElementById('homeView');
  const chatView = doc.getElementById('chatView');
  const chatSurfaceEffectLeft = doc.getElementById('chatSurfaceEffectLeft');
  // F1 (2026-08-21): chat publishes exactly one full-bleed effect host.
  assert.equal(doc.getElementById('chatSurfaceEffectRight'), null);
  assert.equal(doc.querySelectorAll('.chat-surface-effect-gutter').length, 1);
  const homeNavButton = doc.getElementById('homeNavButton');
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');

  await waitForUi(window, 40);

  assert.equal(chatSurfaceEffectLeft.getAttribute('data-widget-modifier'), 'reactive-grid');
  assert.equal(chatView.hasAttribute('data-widget-modifier'), false);
  assert.equal(homeView.hasAttribute('data-widget-modifier'), false);

  input.value = 'Fade the ambient layer back';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 40);

  assert.equal(chatSurfaceEffectLeft.getAttribute('data-widget-modifier'), 'reactive-grid');
  assert.equal(chatView.hasAttribute('data-widget-modifier'), false);
  assert.equal(homeView.hasAttribute('data-widget-modifier'), false);

  homeNavButton.click();
  await waitForUi(window, 40);

  assert.equal(homeView.getAttribute('data-widget-modifier'), 'reactive-grid');
  assert.equal(chatSurfaceEffectLeft.hasAttribute('data-widget-modifier'), false);
  assert.equal(chatView.hasAttribute('data-widget-modifier'), false);
});

test('the surface-effect host leaves normal wheel input native while preserving Ctrl-wheel zoom', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    appearance: {
      paletteId: 'midnight',
      typographyId: 'system',
      motionId: 'standard',
      surfaceEffectId: 'reactive-grid',
    },
  });
  const doc = window.document;
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');
  const chatThreadScroll = doc.getElementById('chatThreadScroll');
  const chatSurfaceEffectLeft = doc.getElementById('chatSurfaceEffectLeft');

  input.value = 'Make the effect host scroll';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 40);

  chatThreadScroll.scrollTop = 40;
  const leftWheelEvent = dispatchWheel(window, chatSurfaceEffectLeft, { deltaY: 120 });

  assert.equal(leftWheelEvent.defaultPrevented, false);
  assert.equal(chatThreadScroll.scrollTop, 40);

  const secondWheelEvent = dispatchWheel(window, chatSurfaceEffectLeft, { deltaY: 40 });

  assert.equal(secondWheelEvent.defaultPrevented, false);
  assert.equal(chatThreadScroll.scrollTop, 40);

  const lineWheelEvent = dispatchWheel(window, chatSurfaceEffectLeft, { deltaMode: 1, deltaY: 3 });

  assert.equal(lineWheelEvent.defaultPrevented, false);
  assert.equal(chatThreadScroll.scrollTop, 40);

  const ctrlWheelEvent = dispatchWheel(window, chatSurfaceEffectLeft, { ctrlKey: true, deltaY: 80 });

  assert.equal(ctrlWheelEvent.defaultPrevented, true, 'ctrl-wheel should continue through the existing chat zoom path');
  assert.equal(chatThreadScroll.scrollTop, 40);
});

test('renderer places transcript utilities in the height-free chat overlay', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const state = window.__rendererState;
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');
  const jumpTools = doc.querySelector('.composer-jump-tools');
  const composerMeta = doc.querySelector('.composer-meta');
  const wayfinderHost = doc.getElementById('composerWayfinderHost');
  const assertComposerWayfinderOwnsNavigation = (message) => {
    assert.equal(jumpTools.classList.contains('hidden'), true, message);
    assert.equal(wayfinderHost.hidden, false, 'wayfinder host should be visible in the timeline utility cluster');
    assert.equal(wayfinderHost.querySelector('.chat-wayfinder-button')?.dataset.chatWayfinderState, 'prompt');
    assert.equal(wayfinderHost.querySelector('.chat-wayfinder-icon')?.tagName.toLowerCase(), 'svg', 'wayfinder should render the shared line-icon SVG');
    assert.equal(doc.getElementById('chatUnreadOrientationHost'), null, 'the legacy timeline overlay host was removed outright by scroll-W4b');
  };

  await waitForUi(window, 40);
  assert.equal(doc.getElementById('composerTokenLabel'), null, 'composer token label should be removed from the UI');
  assert.equal(wayfinderHost.parentElement, doc.getElementById('chatTimelineUtilityCluster'), 'wayfinder should mount in the height-free timeline utility cluster');
  assert.equal(doc.getElementById('timelineCollapseExpandToggle').parentElement, wayfinderHost.parentElement, 'collapse-all and wayfinder should share the overlay cluster');
  assert.equal(doc.getElementById('artifactSplitViewToggle').parentElement, wayfinderHost.parentElement, 'artifact toggle should share the chat-only overlay cluster');
  for (const obsoleteId of ['workbenchHeader', 'workbenchSessionTitle', 'workbenchModeLabel', 'workbenchModelLabel']) {
    assert.equal(doc.getElementById(obsoleteId), null, `${obsoleteId} should be absent`);
  }
  const healthPillSlot = doc.getElementById('workbenchHealthPillSlot');
  assert.ok(healthPillSlot.closest('.titlebar-brand'), 'runtime health should live beside the titlebar wordmark');
  assert.equal(doc.getElementById('topRailActions').contains(healthPillSlot), false, 'global rail should not own runtime health');
  assert.equal(doc.getElementById('topRailActions').contains(doc.getElementById('artifactSplitViewToggle')), false, 'global rail should no longer own the chat-specific artifact toggle');

  input.value = 'Show the navigation affordances only when needed';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 40);

  assertComposerWayfinderOwnsNavigation('wayfinder row should appear when the prompt wayfinder is active');

  state.ui.followLatest = false;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitForUi(window, 20);

  assertComposerWayfinderOwnsNavigation('wayfinder row should stay visible when the thread moves away from latest');
});

test('composer rail (D3): meta row gone, model pill + popover host the selects, jump cluster floats outside the composer', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  await waitForUi(window, 40);

  assert.equal(doc.querySelector('.composer-meta'), null, 'composer meta row should be deleted');

  const pill = doc.getElementById('composerModelPill');
  assert.ok(pill, 'model pill chip mounts into the rail slot');
  assert.ok(pill.closest('.composer-toolbar-right'), 'pill lives in the toolbar rail');
  assert.ok(String(pill.textContent || '').trim(), 'pill carries a visible label');
  // The picker keeps the pill title in sync with the selection ("Model: <label>");
  // the static phrase lives in the aria-label prefix.
  assert.match(pill.getAttribute('title'), /^Model: /);
  assert.match(pill.getAttribute('aria-label'), /^Model and reasoning effort\./);

  const popover = doc.getElementById('composerModelPopover');
  assert.ok(popover, 'model popover exists');
  assert.equal(popover.hidden, true, 'model popover starts closed');
  assert.ok(popover.querySelector('#composerModelSelect'), 'model select moved into the popover');
  assert.ok(popover.querySelector('#composerEffortSelect'), 'effort select moved into the popover');

  pill.click();
  await waitForUi(window, 10);
  assert.equal(popover.hidden, false, 'pill click opens the popover');
  assert.equal(pill.getAttribute('aria-expanded'), 'true');
  pill.click();
  await waitForUi(window, 10);
  assert.equal(popover.hidden, true, 'second pill click closes the popover');

  const jumpTools = doc.querySelector('.composer-jump-tools');
  assert.ok(jumpTools, 'jump tools survive as the floating cluster');
  assert.ok(jumpTools.classList.contains('chat-jump-cluster'), 'cluster carries the floating-cluster class');
  assert.equal(jumpTools.closest('#composerWrap'), null, 'cluster sits outside the composer wrap');
  assert.ok(jumpTools.closest('#chatThreadStage'), 'cluster anchors inside the chat thread stage');

  assert.ok(
    doc.querySelector('#composerSettingsButton #composerGearPostureDot'),
    'gear carries the local-only posture dot'
  );
  assert.equal(doc.getElementById('composerLocalOnlyLabel'), null, 'meta-row Local only label is gone');
  assert.equal(doc.getElementById('composerOfflineLabel'), null, 'meta-row offline label is gone');
});

test('composer tools chip owns web search: popover switch persists tools.web and the gear row is gone', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      tools: {
        list: () => ['web_search', 'run_command', 'read_file'],
      },
    },
  });
  const doc = window.document;

  await waitForUi(window, 60);

  assert.equal(doc.getElementById('webSearchToggle'), null, 'gear popover web-search row removed (B3 de-dup)');
  assert.equal(doc.getElementById('webSearchBadge'), null, 'gear popover web-search badge removed');

  const chip = doc.getElementById('composerToolsChip');
  assert.ok(chip, 'tools chip renders into the tool-toggle slot');
  assert.equal(chip.getAttribute('title'), 'Session tools: 2/3 enabled');
  assert.equal(
    chip.querySelector('.inv-chip-count').textContent,
    '2/3',
    'hydration honors the persisted tools config (web starts off in the stub config)'
  );

  const popover = doc.getElementById('composerToolsPopover');
  assert.ok(popover, 'tools popover renders');
  assert.equal(popover.hidden, true, 'popover starts closed');

  chip.click();
  await waitForUi(window, 20);
  assert.equal(popover.hidden, false, 'chip click opens the popover');
  assert.equal(chip.getAttribute('aria-expanded'), 'true');

  const webSwitch = popover.querySelector('[data-inv-toggle="tool-toggle-web_search"]');
  assert.ok(webSwitch, 'web search switch lives only in the tools popover');
  assert.equal(webSwitch.getAttribute('aria-checked'), 'false', 'switch reflects hydrated web=off');
  webSwitch.click();
  await waitForUi(window, 20);

  assert.equal(popover.hidden, false, 'toggling a switch keeps the popover open');
  const rolledBackSwitch = doc.querySelector('[data-inv-toggle="tool-toggle-web_search"]');
  const rolledBackChip = doc.getElementById('composerToolsChip');
  assert.equal(rolledBackSwitch.getAttribute('aria-checked'), 'false', 'unsaved chat rejects and rolls back the override');
  assert.equal(rolledBackChip.querySelector('.inv-chip-count').textContent, '2/3', 'chip count rolls back in place');
  assert.match(doc.body.textContent, /previous value was restored/i);

  rolledBackSwitch.click();
  await waitForUi(window, 20);
  assert.equal(doc.querySelector('[data-inv-toggle="tool-toggle-web_search"]').getAttribute('aria-checked'), 'false');
  assert.equal(doc.getElementById('composerToolsChip').querySelector('.inv-chip-count').textContent, '2/3');
});

test('context log disclosure stays collapsed by default and does not persist a separate preference', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const state = window.__rendererState;
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');
  const logDisclosure = doc.getElementById('contextLogDisclosure');
  const logFeed = doc.getElementById('contextSessionLogs');

  input.value = 'Collect context logs';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 60);

  assert.ok(logDisclosure, 'expected a context log disclosure button');

  if (!logDisclosure.classList.contains('hidden')) {
    assert.equal(logDisclosure.getAttribute('aria-expanded'), 'false');
  } else {
    assert.equal(logFeed.hidden, false, 'empty-state log copy should remain visible when there are no entries');
    return;
  }

  const persistedBefore = window.localStorage.getItem('jenny.contextPanel.v1');
  logDisclosure.click();
  await waitForUi(window, 20);

  assert.equal(window.localStorage.getItem('jenny.contextPanel.v1'), persistedBefore, 'log disclosure should not persist a new panel preference');

  state.ui.followLatest = true;
});

// Pre-land review (M5): every reveal consumer fails closed when the shared
// viewportReveal dep is absent, and the unit suites all inject it directly —
// nothing proved the LIVE composition threads it lifecycle → controllers →
// shell. Ctrl+F search is a true late-bind consumer (keyboard-utils receives
// callbacks.viewportReveal, unlike scrollMessageIntoView which owns an internal
// reveal controller): if the late-bind at lifecycle-composition breaks, the
// search jump fails closed, scrollIntoView never fires, and this goes red.
test('the shared reveal helper is threaded through the live composition', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const state = window.__rendererState;
  await waitForUi(window, 40);

  const input = doc.getElementById('chatInput');
  input.value = 'Reveal threading probe';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.getElementById('sendButton').click();
  await waitForUi(window, 40);

  const revealCalls = [];
  for (const entry of doc.querySelectorAll('.chat-entry')) {
    entry.scrollIntoView = (options) => revealCalls.push(options || {});
  }
  state.ui.followLatest = true;

  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
  await waitForUi(window, 40);
  const searchInput = doc.querySelector('.chat-search-bar-input');
  assert.ok(searchInput, 'Ctrl+F must open the chat search overlay');
  searchInput.value = 'threading';
  searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitForUi(window, 300); // past the 120ms rescan debounce

  assert.ok(revealCalls.length >= 1, 'the search jump must reach scrollIntoView through the composed reveal helper');
  assert.equal(revealCalls[0].behavior, 'auto', 'search reveals stay instant end-to-end (M1)');
  assert.equal(state.ui.followLatest, false, 'the composed reveal helper releases follow — the dep threaded end-to-end');
});
