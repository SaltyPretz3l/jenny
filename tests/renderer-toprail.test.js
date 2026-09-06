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

test('top rail starts hidden and renders the five primary views in shortcut order', async (t) => {
  const { window, doc, controller } = await loadAppWithRail(t);
  const topRail = doc.getElementById('topRail');
  assert.equal(topRail.classList.contains('hidden'), true, 'rail ships hidden until setTopRailVisible is called');

  controller.renderTopRail();
  await waitForUi(window, 20);

  const tabs = [...doc.querySelectorAll('#topRailTabs .toprail-tab')];
  assert.deepEqual(
    tabs.map((tab) => tab.dataset.tabId),
    ['home', 'chat', 'ide', 'logs', 'settings'],
    'rail order matches VIEW_TAB_ORDER'
  );
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

test('horizontal arrow keys move and activate; Home/End jump; Enter activates', async (t) => {
  const { window, doc, controller, activations } = await loadAppWithRail(t);
  window.__rendererState.ui.activeView = 'home';
  controller.renderTopRail();
  await waitForUi(window, 20);

  const homeTab = doc.getElementById('homeTopRailTab');
  pressKey(window, homeTab, 'ArrowRight');
  assert.deepEqual(activations, ['chat'], 'ArrowRight advances to the next view');

  pressKey(window, doc.getElementById('chatTopRailTab'), 'ArrowLeft');
  assert.deepEqual(activations, ['chat', 'home'], 'ArrowLeft goes back');

  pressKey(window, doc.getElementById('homeTopRailTab'), 'ArrowLeft');
  assert.deepEqual(activations.at(-1), 'settings', 'ArrowLeft wraps from the first tab to the last');

  pressKey(window, doc.getElementById('settingsTopRailTab'), 'End');
  assert.equal(activations.at(-1), 'settings');
  pressKey(window, doc.getElementById('settingsTopRailTab'), 'Home');
  assert.equal(activations.at(-1), 'home');

  const enterEvent = pressKey(window, doc.getElementById('homeTopRailTab'), 'Enter');
  assert.equal(enterEvent.defaultPrevented, true);
  assert.equal(activations.at(-1), 'home');
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
