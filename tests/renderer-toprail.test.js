const assert = require('node:assert/strict');
const test = require('node:test');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

async function loadAppWithRail(t, { beforeBind } = {}) {
  const app = await loadRendererApp();
  t.after(async () => {
    await app.dispose();
  });
  const { window } = app;
  const doc = window.document;
  if (typeof beforeBind === 'function') beforeBind(window, doc);
  // The app now binds and shows its own rail controller at bootstrap (the
  // top_nav_shell flag is gone, so the chrome is unconditional). Dispose it and
  // reset the rail to its pristine ships-hidden/empty state so this standalone
  // controller unit-tests createTopRailController with sole ownership of
  // #topRailTabs (no double-handling, no pre-shown rail).
  window.rendererTopNavShellController?.dispose?.();
  doc.getElementById('topRail')?.classList.add('hidden');
  const _topRailTabs = doc.getElementById('topRailTabs');
  if (_topRailTabs) _topRailTabs.innerHTML = '';
  const activations = [];
  const controller = window.rendererTopRailUtils.createTopRailController({
    state: window.__rendererState,
    staticModel: { tabs: [
      { id: 'home', label: 'Home' },
      { id: 'chat', label: 'Chat' },
      { id: 'ide', label: 'Workspace' },
      { id: 'artifacts', label: 'Artifacts' },
      { id: 'logs', label: 'Logs' },
      { id: 'settings', label: 'Settings' },
    ] },
    dom: {
      topRail: doc.getElementById('topRail'),
      topRailTabs: doc.getElementById('topRailTabs'),
      topRailIndicator: doc.getElementById('topRailIndicator'),
    },
    callbacks: {
      setActiveView: (viewId) => {
        activations.push(viewId);
        window.__rendererState.ui.activeView = viewId;
      },
    },
  });
  controller.bind();
  t.after(() => controller.dispose());
  return { app, window, doc, controller, activations };
}

function pressKey(window, target, key) {
  const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

test('top rail starts hidden and renders the tab views in rail order; Diagnostics and Settings are glyph buttons', async (t) => {
  const { window, doc, controller } = await loadAppWithRail(t);
  const topRail = doc.getElementById('topRail');
  assert.equal(topRail.classList.contains('hidden'), true, 'rail ships hidden until setTopRailVisible is called');

  controller.renderTopRail();
  await waitForUi(window, 20);

  const tabs = [...doc.querySelectorAll('#topRailTabs .toprail-tab')];
  assert.deepEqual(
    tabs.map((tab) => tab.dataset.tabId),
    ['home', 'chat', 'ide'],
    'rail order is Home, Chat, Workspace; Diagnostics and Settings are not tabs'
  );
  assert.ok(tabs.every((tab) => !tab.querySelector('svg')), 'the nav is text only');
  assert.equal(tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true').length, 1, 'one tab is the active view');
  assert.equal(new Set(tabs.map((tab) => tab.className)).size, 1, 'the active tab wears no fill class: the underline marks it');
  const gear = doc.getElementById('settingsTopRailTab');
  assert.ok(gear, 'the Settings gear renders into the title bar slot');
  assert.equal(gear.parentElement, doc.getElementById('titlebarSettingsSlot'));
  assert.equal(gear.getAttribute('aria-label'), 'Settings');
  assert.equal(gear.getAttribute('title'), 'Settings (Ctrl+5)');
  assert.equal(gear.querySelectorAll('svg path').length, 1, 'one cog outline');
  assert.equal(gear.querySelector('svg circle')?.getAttribute('r'), '2.6', 'the gear hub, not the old 2.5 sun');
  assert.equal(doc.querySelector('#topRail circle[r="2.5"]'), null, 'no sun glyph anywhere in the nav');
  const diagnostics = doc.getElementById('logsTopRailTab');
  assert.equal(diagnostics.nextElementSibling, gear, 'Diagnostics sits just left of the gear');
  assert.ok(diagnostics.classList.contains('titlebar-icon-button'));
  assert.equal(diagnostics.getAttribute('aria-label'), 'Logs', 'named by its model label');
  assert.equal(diagnostics.getAttribute('title'), 'Logs (Ctrl+4)');
  assert.equal(diagnostics.querySelectorAll('svg.titlebar-icon path').length, 1, 'one pulse trace');
  assert.deepEqual(
    [...window.rendererTopRailUtils.VIEW_TAB_ORDER],
    ['home', 'chat', 'ide', 'logs', 'settings'],
    'shared constant stays the numbered-shortcut source of truth'
  );
  assert.ok(!tabs.some((tab) => tab.dataset.tabId === 'artifacts'), 'hidden artifacts view stays off the rail');
  assert.ok(tabs.every((tab) => tab.id.endsWith('TopRailTab')), 'rail ids cannot collide with legacy nav ids');
  assert.equal(doc.getElementById('topRailTabs').getAttribute('role'), 'tablist');
  assert.equal(doc.getElementById('topRailTabs').getAttribute('aria-orientation'), 'horizontal');
});

test('every view tabpanel is labelled by a rail tab; Diagnostics and Settings (glyph buttons, not tabs) are named regions', async (t) => {
  const { doc } = await loadAppWithRail(t);
  const gear = doc.getElementById('settingsTopRailTab');
  assert.ok(gear, 'the gear renders');
  assert.notEqual(gear.getAttribute('role'), 'tab');
  for (const panel of doc.querySelectorAll('.main-view[role="tabpanel"]')) {
    const labelId = panel.getAttribute('aria-labelledby');
    assert.notEqual(labelId, 'settingsTopRailTab', `${panel.id} is not labelled by the gear button`);
    assert.notEqual(labelId, 'logsTopRailTab', `${panel.id} is not labelled by the Diagnostics button`);
  }
  assert.notEqual(doc.getElementById('logsTopRailTab').getAttribute('role'), 'tab');
  const logsView = doc.getElementById('logsView');
  assert.equal(logsView.getAttribute('role'), 'region');
  assert.equal(logsView.getAttribute('aria-labelledby'), null);
  assert.equal(logsView.getAttribute('aria-label'), 'Diagnostics');
  const settingsView = doc.getElementById('settingsView');
  assert.equal(settingsView.getAttribute('role'), 'region');
  assert.equal(settingsView.getAttribute('aria-labelledby'), null);
  assert.equal(settingsView.getAttribute('aria-label'), 'Settings');
});

test('rail tabs expose tab semantics with a roving tabindex on the active view', async (t) => {
  const { window, doc, controller } = await loadAppWithRail(t);
  window.__rendererState.ui.activeView = 'chat';
  controller.renderTopRail();
  await waitForUi(window, 20);

  const chatTab = doc.getElementById('chatTopRailTab');
  const homeTab = doc.getElementById('homeTopRailTab');
  assert.equal(chatTab.getAttribute('role'), 'tab');
  assert.equal(chatTab.getAttribute('aria-selected'), 'true');
  assert.equal(chatTab.getAttribute('aria-controls'), 'chatView');
  assert.equal(chatTab.tabIndex, 0);
  assert.equal(homeTab.getAttribute('aria-selected'), 'false');
  assert.equal(homeTab.tabIndex, -1);
});

test('UIUX-038: a tabless view (activeView matches no rail tab) still leaves one tab keyboard-reachable', async (t) => {
  const { window, doc, controller } = await loadAppWithRail(t);

  // 'artifacts' has no rail tab (VIEW_TAB_ORDER excludes it) -- when it is
  // the active view, every tab's dataset.tabId !== 'artifacts', so the
  // roving-tabindex must not collapse ALL of them to -1 (that strands a
  // keyboard user: Tab can no longer reach the rail at all).
  window.__rendererState.ui.activeView = 'artifacts';
  controller.renderTopRail();
  await waitForUi(window, 20);

  const tabs = [...doc.querySelectorAll('#topRailTabs .toprail-tab')];
  assert.ok(tabs.some((tab) => tab.tabIndex === 0), 'at least one rail tab stays Tab-reachable');
  assert.equal(doc.getElementById('homeTopRailTab').tabIndex, 0, 'falls back to the first tab');
  assert.ok(tabs.every((tab) => tab.getAttribute('aria-selected') === 'false'),
    'no tab claims to BE the active view -- none of them is');

  // The same fallback must hold on the cheap-sync re-render path (same
  // markup, only aria-selected/tabIndex resynced in place), not just the
  // full-rebuild path exercised above.
  controller.renderTopRail();
  await waitForUi(window, 20);
  assert.equal(doc.getElementById('homeTopRailTab').tabIndex, 0, 'fallback survives a redundant cheap-sync render');
});

test('clicking a rail tab activates the view and resyncs aria state', async (t) => {
  const { window, doc, controller, activations } = await loadAppWithRail(t);
  window.__rendererState.ui.activeView = 'home';
  controller.renderTopRail();
  await waitForUi(window, 20);

  doc.getElementById('ideTopRailTab').click();
  await waitForUi(window, 20);

  assert.deepEqual(activations, ['ide']);
  assert.equal(doc.getElementById('ideTopRailTab').getAttribute('aria-selected'), 'true');
  assert.equal(doc.getElementById('homeTopRailTab').getAttribute('aria-selected'), 'false');
});

test('arrow keys and Home/End move focus without opening a view; Enter or Space opens the focused one', async (t) => {
  const { window, doc, controller, activations } = await loadAppWithRail(t);
  window.__rendererState.ui.activeView = 'home';
  controller.renderTopRail();
  await waitForUi(window, 20);
  const tab = (id) => doc.getElementById(`${id}TopRailTab`);

  tab('home').focus();
  pressKey(window, tab('home'), 'ArrowRight');
  assert.equal(doc.activeElement, tab('chat'), 'ArrowRight moves focus to the next tab');
  assert.equal(tab('chat').tabIndex, 0, 'the focused tab is the roving stop');
  assert.equal(tab('home').tabIndex, -1);
  assert.deepEqual(activations, [], 'moving focus opens nothing');

  pressKey(window, tab('chat'), 'ArrowLeft');
  assert.equal(doc.activeElement, tab('home'), 'ArrowLeft goes back');
  pressKey(window, tab('home'), 'ArrowLeft');
  assert.equal(doc.activeElement, tab('ide'), 'ArrowLeft wraps from the first tab to the last');
  pressKey(window, tab('ide'), 'Home');
  assert.equal(doc.activeElement, tab('home'));
  pressKey(window, tab('home'), 'End');
  assert.equal(doc.activeElement, tab('ide'));
  assert.deepEqual(activations, [], 'still nothing opened');

  const enterEvent = pressKey(window, tab('ide'), 'Enter');
  assert.equal(enterEvent.defaultPrevented, true);
  assert.deepEqual(activations, ['ide'], 'Enter opens the focused tab');
  pressKey(window, tab('ide'), 'ArrowLeft');
  pressKey(window, doc.activeElement, ' ');
  assert.deepEqual(activations, ['ide', 'chat'], 'Space opens the focused tab');
});

test('clicking the tab of the view already showing only focuses it', async (t) => {
  const { window, doc, controller, activations } = await loadAppWithRail(t);
  window.__rendererState.ui.activeView = 'chat';
  controller.renderTopRail();
  doc.getElementById('chatTopRailTab').click();
  assert.deepEqual(activations, [], 'the view is not switched again');
  doc.getElementById('homeTopRailTab').click();
  assert.deepEqual(activations, ['home']);
});

test('setTopRailVisible toggles the hidden class and renders on show', async (t) => {
  const { doc, controller } = await loadAppWithRail(t);
  const topRail = doc.getElementById('topRail');

  controller.setTopRailVisible(true);
  assert.equal(topRail.classList.contains('hidden'), false);
  assert.ok(doc.querySelector('#topRailTabs .toprail-tab'), 'showing the rail renders tabs');

  controller.setTopRailVisible(false);
  assert.equal(topRail.classList.contains('hidden'), true);
});

// UIUX-040: the sliding indicator was measured only during render — no
// resize/scroll re-measure — so font-scale changes, window resizes, and the
// ≤719px horizontal tab scroller (whose scrollLeft offsetLeft ignores) all
// left a stale underline while CSS had already suppressed the per-tab
// fallback via [data-indicator-ready].
function installFakeResizeObserver(window) {
  const instances = [];
  window.ResizeObserver = class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = [];
      this.disconnected = false;
      instances.push(this);
    }
    observe(el) { this.observed.push(el); }
    unobserve() {}
    disconnect() { this.disconnected = true; this.observed.length = 0; }
  };
  return instances;
}

function stubTabMetrics(doc, metrics) {
  for (const tab of doc.querySelectorAll('#topRailTabs .toprail-tab[data-tab-id]')) {
    const entry = metrics[tab.dataset.tabId];
    if (!entry) continue;
    Object.defineProperty(tab, 'offsetWidth', { configurable: true, get: () => entry.width });
    Object.defineProperty(tab, 'offsetLeft', { configurable: true, get: () => entry.left });
  }
}

async function loadRailWithMeasurableIndicator(t) {
  const roInstances = [];
  const setup = await loadAppWithRail(t, {
    beforeBind(window) {
      roInstances.push(...installFakeResizeObserver(window));
      // Not enough: instances created after this call must land too — swap
      // the array the class pushes into for the shared one.
      const shared = roInstances;
      window.ResizeObserver = class FakeResizeObserver {
        constructor(callback) {
          this.callback = callback;
          this.observed = [];
          this.disconnected = false;
          shared.push(this);
        }
        observe(el) { this.observed.push(el); }
        unobserve() {}
        disconnect() { this.disconnected = true; this.observed.length = 0; }
      };
      window.requestAnimationFrame = (cb) => { cb(0); return 1; };
      window.cancelAnimationFrame = () => {};
    },
  });
  const { window, doc, controller } = setup;
  window.__rendererState.ui.activeView = 'chat';
  controller.renderTopRail();
  stubTabMetrics(doc, { chat: { width: 80, left: 40 } });
  controller.updateIndicator();
  return { ...setup, roInstances };
}

test('the sliding indicator hides while the active view has no rail tab (Settings is the gear)', async (t) => {
  const { window, doc, controller } = await loadRailWithMeasurableIndicator(t);
  const indicator = doc.getElementById('topRailIndicator');
  assert.equal(indicator.hidden, false, 'a measurable active tab shows the underline');
  window.__rendererState.ui.activeView = 'settings';
  controller.updateIndicator();
  assert.equal(indicator.hidden, true, 'no tab is active, so no underline may stay under the last one');
  window.__rendererState.ui.activeView = 'chat';
  controller.updateIndicator();
  assert.equal(indicator.hidden, false, 'returning to a tab shows the underline again');
});

test('indicator re-measures when the rail or a tab resizes (UIUX-040)', async (t) => {
  const { doc, roInstances } = await loadRailWithMeasurableIndicator(t);
  const indicator = doc.getElementById('topRailIndicator');
  assert.equal(indicator.style.width, '80px');
  assert.equal(indicator.style.transform, 'translateX(40px)');

  assert.ok(roInstances.length >= 1, 'binding the rail must register a ResizeObserver');
  const observer = roInstances[0];
  assert.ok(
    observer.observed.some((el) => el && el.classList && el.classList.contains('toprail-tab')),
    'each rail tab must be observed so label/font-scale width changes re-measure'
  );

  // Font-scale bump: the active tab grows and shifts without any re-render.
  stubTabMetrics(doc, { chat: { width: 96, left: 52 } });
  observer.callback([]);
  assert.equal(indicator.style.width, '96px', 'resize must re-measure the underline width');
  assert.equal(indicator.style.transform, 'translateX(52px)', 'resize must re-measure the underline position');
});

test('scrolling the ≤719px tab scroller offsets the underline (UIUX-040)', async (t) => {
  const { window, doc } = await loadRailWithMeasurableIndicator(t);
  const indicator = doc.getElementById('topRailIndicator');
  const tabsHost = doc.getElementById('topRailTabs');

  Object.defineProperty(tabsHost, 'scrollLeft', { configurable: true, get: () => 24 });
  tabsHost.dispatchEvent(new window.Event('scroll'));
  assert.equal(
    indicator.style.transform,
    'translateX(16px)',
    'the indicator sits outside the scroller, so scrollLeft must be subtracted'
  );
  assert.equal(
    indicator.style.transition,
    'none',
    'scroll-driven updates must not animate (the slide transition is for activation only)'
  );
});

test('dispose disconnects the indicator ResizeObserver (UIUX-040)', async (t) => {
  const { controller, roInstances } = await loadRailWithMeasurableIndicator(t);
  controller.dispose();
  assert.ok(roInstances.length >= 1, 'binding the rail must register a ResizeObserver');
  assert.equal(roInstances[0].disconnected, true);
});

test('repeated view-chrome synchronization keeps one rail binding and one ResizeObserver', async (t) => {
  const { controller, roInstances } = await loadRailWithMeasurableIndicator(t);
  controller.bind();
  controller.bind();
  controller.bind();
  assert.equal(roInstances.length, 1, 'bind is idempotent across view and feature refreshes');
});

test('the gear activates Settings and carries aria-current while Settings is active', async (t) => {
  const { window, doc, controller, activations } = await loadAppWithRail(t);
  window.__rendererState.ui.activeView = 'chat';
  controller.renderTopRail();
  await waitForUi(window, 20);
  const gear = doc.getElementById('settingsTopRailTab');
  assert.equal(gear.hasAttribute('aria-current'), false);

  gear.click();
  await waitForUi(window, 20);
  assert.deepEqual(activations, ['settings']);
  assert.equal(gear.getAttribute('aria-current'), 'page');
  assert.ok([...doc.querySelectorAll('#topRailTabs .toprail-tab')].every((tab) => tab.getAttribute('aria-selected') === 'false'));
});

test('the Diagnostics button activates the logs view and hands aria-current over from the gear', async (t) => {
  const { window, doc, controller, activations } = await loadAppWithRail(t);
  window.__rendererState.ui.activeView = 'settings';
  controller.renderTopRail();
  await waitForUi(window, 20);
  const diagnostics = doc.getElementById('logsTopRailTab');
  const gear = doc.getElementById('settingsTopRailTab');
  assert.equal(gear.getAttribute('aria-current'), 'page');
  assert.equal(diagnostics.hasAttribute('aria-current'), false);

  diagnostics.click();
  await waitForUi(window, 20);
  assert.deepEqual(activations, ['logs']);
  assert.equal(diagnostics.getAttribute('aria-current'), 'page');
  assert.equal(gear.hasAttribute('aria-current'), false);
  assert.equal(doc.getElementById('logsTopRailTab'), diagnostics, 'a re-render keeps the same button');
  assert.ok([...doc.querySelectorAll('#topRailTabs .toprail-tab')].every((tab) => tab.getAttribute('aria-selected') === 'false'));
});
