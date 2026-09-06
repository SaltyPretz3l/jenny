const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createWorkspaceChromeController,
  resolveSessionPresentation,
} = require('../renderer/shell/renderer-workspace-chrome-utils');

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="rail"></div></body></html>', {
    pretendToBeVisual: true,
  });
  global.window = dom.window;
  global.document = dom.window.document;
  return dom;
}

function registerDomCleanup(t, dom) {
  t.after(async () => {
    delete global.window;
    delete global.document;
    await dom.window.close();
  });
}

test('workspace chrome controller renders the rail with active, streaming, approval, and busy states', async (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const activated = [];
  const closed = [];
  const linked = [];
  const controller = createWorkspaceChromeController({
    containerEl: dom.window.document.getElementById('rail'),
    getSessionSummary(sessionId) {
      return {
        'session-1': { id: 'session-1', title: 'Alpha Notes' },
        'session-2': { id: 'session-2', title: 'Beta Draft' },
      }[sessionId] || null;
    },
    isSessionBusy(sessionId) {
      return sessionId === 'session-2';
    },
    onSessionActivated(sessionId) {
      activated.push(sessionId);
    },
    onSessionClosed(sessionId) {
      closed.push(sessionId);
    },
    onLinkSessionsRequested(sessionId) {
      linked.push(sessionId);
    },
  });

  controller.renderRail(
    ['session-1', 'session-2'],
    'session-2',
    [{ id: 'session-1', title: 'Alpha Notes' }, { id: 'session-2', title: 'Beta Draft' }],
    ['session-1'],
    ['session-2']
  );

  const doc = dom.window.document;
  const tabs = [...doc.querySelectorAll('.workspace-rail-tab')];
  assert.equal(tabs.length, 2);
  assert.equal(tabs[1].classList.contains('active'), true);
  assert.equal(tabs[0].querySelector('.workspace-rail-indicator').textContent, 'Streaming');
  assert.equal(tabs[1].querySelector('.workspace-rail-indicator').textContent, 'Approval');
  assert.equal(doc.querySelector('[data-workspace-close="session-2"]').disabled, true);
  assert.ok(doc.querySelector('[data-workspace-links="session-2"]'));

  doc.querySelector('[data-workspace-activate="session-1"]').click();
  doc.querySelector('[data-workspace-links="session-2"]').click();
  doc.querySelector('[data-workspace-close="session-1"]').click();
  await Promise.resolve();

  assert.deepEqual(activated, ['session-1']);
  assert.deepEqual(linked, ['session-2']);
  assert.deepEqual(closed, ['session-1']);
});

test('workspace chrome controller exposes sidebar runtime state without visible badges', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  doc.body.insertAdjacentHTML('beforeend', `
    <article data-session-id="session-1"><div class="conversation-title">One</div></article>
    <article data-session-id="session-2"><div class="conversation-title">Two</div></article>
    <article data-session-id="session-3"><div class="conversation-title">Three</div></article>
  `);
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
  });

  controller.renderSidebarBadges(
    doc.querySelectorAll('[data-session-id]'),
    ['session-1', 'session-2'],
    ['session-2'],
    ['session-3'],
    { 'session-1': 2, 'session-3': 1 }
  );

  assert.equal(doc.querySelector('.conversation-state-badge'), null, 'no status becomes a visible title badge');
  const sessionOne = doc.querySelector('[data-session-id="session-1"]');
  const sessionTwo = doc.querySelector('[data-session-id="session-2"]');
  const sessionThree = doc.querySelector('[data-session-id="session-3"]');
  assert.equal(sessionOne.dataset.sessionDominantState, 'open');
  assert.equal(sessionTwo.dataset.sessionDominantState, 'streaming');
  assert.equal(sessionThree.dataset.sessionDominantState, 'approval');
  assert.equal(sessionOne.getAttribute('aria-label'), 'Open session One. Status: Open, Linked 2');
  assert.equal(sessionTwo.getAttribute('aria-label'), 'Open session Two. Status: Open, Streaming');
  assert.equal(sessionThree.getAttribute('aria-label'), 'Open session Three. Status: Approval, Linked 1');
});

test('session presentation resolver keeps dominant status separate from linked context', () => {
  const presentation = resolveSessionPresentation('session-1', {
    openIds: ['session-1'],
    streamingIds: ['session-1'],
    approvalIds: ['session-1'],
    linkedCounts: { 'session-1': 3 },
  });

  assert.equal(presentation.dominantState, 'approval');
  assert.equal(presentation.railIndicatorLabel, 'Approval');
  assert.equal(presentation.linkedCount, 3);
  assert.deepEqual(presentation.badgeLabels, ['Open', 'Streaming', 'Approval', 'Linked 3']);
});

test('sidebar badge render writes collapsed status data attributes', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  doc.body.insertAdjacentHTML('beforeend', `
    <article data-session-id="session-1" title="One"><div class="conversation-title">One</div></article>
    <article data-session-id="session-2" title="Two"><div class="conversation-title">Two</div></article>
  `);
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
  });

  controller.renderSidebarBadges(
    doc.querySelectorAll('[data-session-id]'),
    ['session-1', 'session-2'],
    ['session-1'],
    ['session-2'],
    { 'session-1': 2 }
  );

  const streaming = doc.querySelector('[data-session-id="session-1"]');
  const approval = doc.querySelector('[data-session-id="session-2"]');
  assert.equal(streaming.dataset.sessionDominantState, 'streaming');
  assert.equal(streaming.dataset.sessionLinkedCount, '2');
  assert.equal(streaming.getAttribute('aria-label'), 'Open session One. Status: Open, Streaming, Linked 2');
  assert.equal(approval.dataset.sessionDominantState, 'approval');
  assert.equal(approval.dataset.sessionLinkedCount, '0');
  assert.equal(approval.getAttribute('aria-label'), 'Open session Two. Status: Open, Approval');
});

test('sidebar runtime badge patches retain pin/outbox labels and skip unchanged DOM writes', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  doc.body.insertAdjacentHTML('beforeend', `
    <article data-session-id="session-1" data-session-pinned="true" data-session-type="chat">
      <button data-session-open="session-1"><span class="conversation-title"><span class="session-row__title-text">Pinned work</span><span class="send-outbox-badge" aria-label="1 queued send failed">1 failed</span></span></button>
    </article>
  `);
  const controller = createWorkspaceChromeController({ containerEl: doc.getElementById('rail') });
  const rows = doc.querySelectorAll('[data-session-id]');
  controller.renderSidebarBadges(rows, ['session-1'], ['session-1'], [], {});
  const open = doc.querySelector('[data-session-open]');
  assert.match(open.getAttribute('aria-label'), /Status: Open, Streaming, Pinned, 1 queued send failed/);
  assert.equal(doc.querySelector('.conversation-state-badge'), null);
  const originalSetAttribute = open.setAttribute.bind(open);
  let attributeWrites = 0;
  open.setAttribute = (...args) => {
    attributeWrites += 1;
    return originalSetAttribute(...args);
  };
  controller.renderSidebarBadges(rows, ['session-1'], ['session-1'], [], {});
  assert.equal(attributeWrites, 0, 'unchanged runtime facts avoid repeated DOM writes');
  assert.equal(doc.querySelector('.conversation-state-badge'), null);
});

test('renderRail reuses existing tab DOM nodes on re-render (no flicker)', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
  });

  controller.renderRail(['s1'], 's1', [{ id: 's1', title: 'Alpha' }], [], []);
  const tabEl = doc.querySelector('.workspace-rail-tab');
  assert.ok(tabEl, 'tab rendered on first call');

  controller.renderRail(['s1'], 's1', [{ id: 's1', title: 'Alpha Renamed' }], [], []);
  const tabEl2 = doc.querySelector('.workspace-rail-tab');
  assert.strictEqual(tabEl, tabEl2, 'tab element must be the same DOM node after re-render');
  assert.equal(doc.querySelector('.workspace-rail-title').textContent, 'Alpha Renamed', 'title updated in place');
});

test('runtime rail labels coalesce an overflow-arrow refresh', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const frames = [];
  dom.window.requestAnimationFrame = (callback) => {
    frames.push(callback);
    return frames.length;
  };
  dom.window.cancelAnimationFrame = () => {};
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
  });
  controller.renderRail(['s1'], 's1', [{ id: 's1', title: 'Alpha' }], [], []);
  const rail = doc.querySelector('.workspace-rail');
  const indicator = doc.querySelector('.workspace-rail-indicator');
  Object.defineProperty(rail, 'clientWidth', { configurable: true, value: 100 });
  Object.defineProperty(rail, 'scrollWidth', {
    configurable: true,
    get: () => (indicator.textContent === 'Streaming' ? 140 : 80),
  });
  Object.defineProperty(rail, 'scrollLeft', { configurable: true, writable: true, value: 0 });
  controller.renderRail(['s1'], 's1', [{ id: 's1', title: 'Alpha' }], [], []);
  const [leftArrow, rightArrow] = doc.querySelectorAll('.workspace-rail-scroll-arrow');
  assert.equal(leftArrow.hidden, true);
  assert.equal(rightArrow.hidden, true);

  controller.patchRailRuntime('s1', ['s1'], []);
  controller.patchRailRuntime('s1', ['s1'], []);
  assert.equal(indicator.textContent, 'Streaming');
  assert.equal(frames.length, 1, 'rapid runtime patches schedule one measurement frame');
  frames.shift()();
  assert.equal(leftArrow.hidden, true, 'the left arrow stays hidden at the leading edge');
  assert.equal(rightArrow.hidden, false, 'the widened runtime label exposes the right arrow');
  controller.dispose();
});

test('renderRail removes stale tabs and keeps current ones', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
  });

  controller.renderRail(['s1', 's2'], 's1', [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }], [], []);
  assert.equal(doc.querySelectorAll('.workspace-rail-tab').length, 2);

  controller.renderRail(['s1'], 's1', [{ id: 's1', title: 'A' }], [], []);
  assert.equal(doc.querySelectorAll('.workspace-rail-tab').length, 1);
  assert.equal(doc.querySelector('[data-workspace-close="s2"]'), null);
  assert.ok(doc.querySelector('[data-workspace-close="s1"]'), 's1 tab still present');
});

test('renderRail close button uses SVG icon not text', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
  });

  controller.renderRail(['s1'], 's1', [{ id: 's1', title: 'T' }], [], []);
  const closeBtn = doc.querySelector('[data-workspace-close="s1"]');
  assert.ok(closeBtn.querySelector('svg'), 'close button must contain an SVG element');
  assert.notEqual(closeBtn.textContent.trim(), 'x', 'close button must not use text "x"');
});

test('renderRail adds new-session button outside rail when onNewSessionRequested provided', async (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const newRequests = [];
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
    onNewSessionRequested() { newRequests.push(1); },
  });

  controller.renderRail(['s1'], 's1', [{ id: 's1', title: 'A' }], [], []);
  const newBtn = doc.querySelector('[data-workspace-new]');
  assert.ok(newBtn, '+ button must exist');
  const railEl = doc.querySelector('.workspace-rail');
  assert.equal(railEl.contains(newBtn), false, '+ button must be outside the rail scroll region');

  newBtn.click();
  await Promise.resolve();
  assert.equal(newRequests.length, 1, 'onNewSessionRequested fired');
});

test('renderRail omits new-session button when onNewSessionRequested not provided', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
  });

  controller.renderRail(['s1'], 's1', [{ id: 's1', title: 'A' }], [], []);
  assert.equal(doc.querySelector('[data-workspace-new]'), null, '+ button must not exist without callback');
});

test('renderRail sets role="tablist" and aria-label on the rail element', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
  });

  controller.renderRail(['s1'], 's1', [{ id: 's1', title: 'A' }], [], []);
  const railEl = doc.querySelector('.workspace-rail');
  assert.equal(railEl.getAttribute('role'), 'tablist');
  assert.equal(railEl.getAttribute('aria-label'), 'Open sessions');
});

test('renderRail sets aria-selected and tabindex on active and inactive tab buttons', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
  });

  controller.renderRail(
    ['s1', 's2'],
    's1',
    [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }],
    [], []
  );
  const btn1 = doc.querySelector('[data-workspace-activate="s1"]');
  const btn2 = doc.querySelector('[data-workspace-activate="s2"]');
  assert.equal(btn1.getAttribute('aria-selected'), 'true');
  assert.equal(btn1.tabIndex, 0);
  assert.equal(btn2.getAttribute('aria-selected'), 'false');
  assert.equal(btn2.tabIndex, -1);

  // After re-render with different active tab
  controller.renderRail(
    ['s1', 's2'],
    's2',
    [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }],
    [], []
  );
  assert.equal(btn1.getAttribute('aria-selected'), 'false');
  assert.equal(btn1.tabIndex, -1);
  assert.equal(btn2.getAttribute('aria-selected'), 'true');
  assert.equal(btn2.tabIndex, 0);
});

test('keyboard ArrowRight and ArrowLeft move focus between tab buttons', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
  });

  controller.renderRail(
    ['s1', 's2', 's3'],
    's1',
    [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }, { id: 's3', title: 'C' }],
    [], []
  );
  const btn1 = doc.querySelector('[data-workspace-activate="s1"]');
  const btn2 = doc.querySelector('[data-workspace-activate="s2"]');
  const btn3 = doc.querySelector('[data-workspace-activate="s3"]');

  btn1.focus();
  btn1.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(doc.activeElement, btn2, 'ArrowRight moves to next tab');

  btn2.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(doc.activeElement, btn3, 'ArrowRight moves to last tab');

  btn3.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(doc.activeElement, btn1, 'ArrowRight wraps to first tab');

  btn1.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(doc.activeElement, btn3, 'ArrowLeft wraps to last tab');

  btn3.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  assert.equal(doc.activeElement, btn1, 'Home focuses first tab');

  btn1.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  assert.equal(doc.activeElement, btn3, 'End focuses last tab');
});

test('keyboard Enter and Space activate the focused tab', async (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const activated = [];
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
    onSessionActivated(id) { activated.push(id); },
  });

  controller.renderRail(
    ['s1', 's2'],
    's1',
    [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }],
    [], []
  );
  const btn2 = doc.querySelector('[data-workspace-activate="s2"]');

  btn2.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await Promise.resolve();
  assert.deepEqual(activated, ['s2']);

  btn2.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  await Promise.resolve();
  assert.deepEqual(activated, ['s2', 's2']);
});

test('workspace chrome controller filters the linked-session popover by title and updates links immediately', async (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const changes = [];
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
    onLinkSessionsRequested() {},
  });

  controller.renderRail(['session-1'], 'session-1', [{ id: 'session-1', title: 'Anchor' }], [], []);
  controller.showLinkedSessionPopover(
    'session-1',
    [
      { id: 'session-1', title: 'Anchor' },
      { id: 'session-2', title: 'Beta Project' },
      { id: 'session-3', title: 'Gamma Log' },
    ],
    ['session-3'],
    (linkedIds) => changes.push(linkedIds.slice().sort())
  );

  const popover = doc.querySelector('.workspace-linked-popover');
  assert.ok(popover);
  assert.match(popover.textContent, /Linked sessions: 1/);

  const searchInput = popover.querySelector('input[type="search"]');
  searchInput.value = 'beta';
  searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(popover.querySelectorAll('label').length, 1);
  assert.match(popover.textContent, /Beta Project/);

  const checkbox = popover.querySelector('input[type="checkbox"]');
  checkbox.checked = true;
  checkbox.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await Promise.resolve();
  assert.deepEqual(changes.at(-1), ['session-2', 'session-3']);

  doc.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(doc.querySelector('.workspace-linked-popover'), null);

  controller.showLinkedSessionPopover('session-1', [{ id: 'session-1', title: 'Anchor' }, { id: 'session-2', title: 'Beta Project' }], [], () => {});
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(doc.querySelector('.workspace-linked-popover'), null);
});

test('toggling a linked-session checkbox preserves focus across the rerender (WIDE-056a)', async (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
    onLinkSessionsRequested() {},
  });
  controller.renderRail(['session-1'], 'session-1', [{ id: 'session-1', title: 'Anchor' }], [], []);
  controller.showLinkedSessionPopover(
    'session-1',
    [{ id: 'session-1', title: 'Anchor' }, { id: 'session-2', title: 'Beta Project' }],
    [],
    () => {}
  );

  const popover = doc.querySelector('.workspace-linked-popover');
  const checkbox = popover.querySelector('input[data-linked-session-id="session-2"]');
  checkbox.focus();
  assert.equal(doc.activeElement, checkbox, 'checkbox is focused before the toggle');

  checkbox.checked = true;
  checkbox.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await Promise.resolve();

  const rerendered = popover.querySelector('input[data-linked-session-id="session-2"]');
  assert.notEqual(rerendered, checkbox, 'rerender rebuilt the row (a new node)');
  assert.equal(doc.activeElement, rerendered, 'focus followed the rebuilt checkbox for the same session');
});

test('a rejected onLinksChanged rolls the optimistic toggle back and reconciles the UI (WIDE-056a)', async (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
    onLinkSessionsRequested() {},
  });
  controller.renderRail(['session-1'], 'session-1', [{ id: 'session-1', title: 'Anchor' }], [], []);
  controller.showLinkedSessionPopover(
    'session-1',
    [{ id: 'session-1', title: 'Anchor' }, { id: 'session-2', title: 'Beta Project' }],
    [],
    () => Promise.reject(new Error('persist failed'))
  );

  const popover = doc.querySelector('.workspace-linked-popover');
  const checkbox = popover.querySelector('input[data-linked-session-id="session-2"]');
  checkbox.checked = true;
  checkbox.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  // Let the optimistic renderList land, then the rejection's rollback renderList.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const reconciled = popover.querySelector('input[data-linked-session-id="session-2"]');
  assert.equal(reconciled.checked, false, 'failed persistence rolls the optimistic check back off');
  assert.match(popover.textContent, /Linked sessions: 0/);
});

/* ── Phase D: middle-click close ── */

test('auxclick with button 1 on tab fires onSessionClosed', async (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const closed = [];
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
    isSessionBusy: () => false,
    onSessionClosed(id) { closed.push(id); },
  });
  controller.renderRail(['s1', 's2'], 's1', [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }], [], []);
  const tab = doc.querySelector('[data-session-id="s2"]');
  tab.dispatchEvent(new dom.window.MouseEvent('auxclick', { button: 1, bubbles: true }));
  await Promise.resolve();
  assert.deepEqual(closed, ['s2']);
});

test('auxclick on close button does not fire duplicate close', async (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const closed = [];
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
    isSessionBusy: () => false,
    onSessionClosed(id) { closed.push(id); },
  });
  controller.renderRail(['s1'], 's1', [{ id: 's1', title: 'A' }], [], []);
  const closeBtn = doc.querySelector('.workspace-rail-close-button');
  closeBtn.dispatchEvent(new dom.window.MouseEvent('auxclick', { button: 1, bubbles: true }));
  await Promise.resolve();
  assert.deepEqual(closed, [], 'close button guard should prevent auxclick close');
});

test('auxclick with button 2 is ignored', async (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const closed = [];
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
    onSessionClosed(id) { closed.push(id); },
  });
  controller.renderRail(['s1'], 's1', [{ id: 's1', title: 'A' }], [], []);
  const tab = doc.querySelector('[data-session-id="s1"]');
  tab.dispatchEvent(new dom.window.MouseEvent('auxclick', { button: 2, bubbles: true }));
  await Promise.resolve();
  assert.deepEqual(closed, [], 'button 2 should not trigger close');
});

/* ── Phase D: context menu ── */

test('contextmenu on tab opens context menu with four items', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
    isSessionBusy: (id) => id === 's1',
    onSessionClosed() {},
    onCloseOtherSessions() {},
    onCloseSessionsToRight() {},
    onCloseAllSessions() {},
  });
  controller.renderRail(['s1', 's2'], 's1', [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }], [], []);
  const tab = doc.querySelector('[data-session-id="s1"]');
  tab.dispatchEvent(new dom.window.MouseEvent('contextmenu', { clientX: 50, clientY: 30, bubbles: true }));
  const menu = doc.querySelector('.workspace-tab-context-menu');
  assert.ok(menu, 'context menu must exist');
  const items = menu.querySelectorAll('.workspace-tab-context-menu-item');
  assert.equal(items.length, 4, 'four menu items');
  assert.equal(items[0].textContent, 'Close');
  assert.equal(items[0].disabled, true, 'Close disabled for busy session');
  assert.equal(items[1].textContent, 'Close Others');
  assert.equal(items[2].textContent, 'Close to the Right');
  assert.equal(items[3].textContent, 'Close All');
});

test('context menu Close fires onSessionClosed and removes menu', async (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const closed = [];
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
    isSessionBusy: () => false,
    onSessionClosed(id) { closed.push(id); },
    onCloseOtherSessions() {},
    onCloseSessionsToRight() {},
    onCloseAllSessions() {},
  });
  controller.renderRail(['s1'], 's1', [{ id: 's1', title: 'A' }], [], []);
  doc.querySelector('[data-session-id="s1"]').dispatchEvent(new dom.window.MouseEvent('contextmenu', { clientX: 10, clientY: 10, bubbles: true }));
  const closeItem = doc.querySelector('.workspace-tab-context-menu-item');
  closeItem.click();
  await Promise.resolve();
  assert.deepEqual(closed, ['s1']);
  assert.equal(doc.querySelector('.workspace-tab-context-menu'), null, 'menu removed after action');
});

test('context menu batch actions fire respective callbacks', async (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const others = [], toRight = [], all = [];
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
    isSessionBusy: () => false,
    onSessionClosed() {},
    onCloseOtherSessions(id) { others.push(id); },
    onCloseSessionsToRight(id) { toRight.push(id); },
    onCloseAllSessions() { all.push(1); },
  });
  controller.renderRail(['s1', 's2'], 's1', [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }], [], []);

  // Close Others
  doc.querySelector('[data-session-id="s1"]').dispatchEvent(new dom.window.MouseEvent('contextmenu', { clientX: 10, clientY: 10, bubbles: true }));
  doc.querySelectorAll('.workspace-tab-context-menu-item')[1].click();
  await Promise.resolve();
  assert.deepEqual(others, ['s1']);

  // Close to the Right
  doc.querySelector('[data-session-id="s1"]').dispatchEvent(new dom.window.MouseEvent('contextmenu', { clientX: 10, clientY: 10, bubbles: true }));
  doc.querySelectorAll('.workspace-tab-context-menu-item')[2].click();
  await Promise.resolve();
  assert.deepEqual(toRight, ['s1']);

  // Close All
  doc.querySelector('[data-session-id="s1"]').dispatchEvent(new dom.window.MouseEvent('contextmenu', { clientX: 10, clientY: 10, bubbles: true }));
  doc.querySelectorAll('.workspace-tab-context-menu-item')[3].click();
  await Promise.resolve();
  assert.deepEqual(all, [1]);
});

test('context menu dismissed on Escape', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
    onSessionClosed() {},
    onCloseOtherSessions() {},
    onCloseSessionsToRight() {},
    onCloseAllSessions() {},
  });
  controller.renderRail(['s1'], 's1', [{ id: 's1', title: 'A' }], [], []);
  doc.querySelector('[data-session-id="s1"]').dispatchEvent(new dom.window.MouseEvent('contextmenu', { clientX: 10, clientY: 10, bubbles: true }));
  assert.ok(doc.querySelector('.workspace-tab-context-menu'));
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(doc.querySelector('.workspace-tab-context-menu'), null, 'menu dismissed on Escape');
});

test('context menu dismissed on outside mousedown', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
    onSessionClosed() {},
    onCloseOtherSessions() {},
    onCloseSessionsToRight() {},
    onCloseAllSessions() {},
  });
  controller.renderRail(['s1'], 's1', [{ id: 's1', title: 'A' }], [], []);
  doc.querySelector('[data-session-id="s1"]').dispatchEvent(new dom.window.MouseEvent('contextmenu', { clientX: 10, clientY: 10, bubbles: true }));
  assert.ok(doc.querySelector('.workspace-tab-context-menu'));
  doc.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(doc.querySelector('.workspace-tab-context-menu'), null, 'menu dismissed on outside click');
});

test('opening context menu dismisses linked-session popover', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
    onSessionClosed() {},
    onCloseOtherSessions() {},
    onCloseSessionsToRight() {},
    onCloseAllSessions() {},
    onLinkSessionsRequested() {},
  });
  controller.renderRail(['s1'], 's1', [{ id: 's1', title: 'A' }], [], []);
  controller.showLinkedSessionPopover('s1', [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }], [], () => {});
  assert.ok(doc.querySelector('.workspace-linked-popover'), 'popover present');
  doc.querySelector('[data-session-id="s1"]').dispatchEvent(new dom.window.MouseEvent('contextmenu', { clientX: 10, clientY: 10, bubbles: true }));
  assert.equal(doc.querySelector('.workspace-linked-popover'), null, 'popover dismissed');
  assert.ok(doc.querySelector('.workspace-tab-context-menu'), 'context menu present');
});

test('opening linked-session popover dismisses context menu', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
    onSessionClosed() {},
    onCloseOtherSessions() {},
    onCloseSessionsToRight() {},
    onCloseAllSessions() {},
    onLinkSessionsRequested() {},
  });
  controller.renderRail(['s1'], 's1', [{ id: 's1', title: 'A' }], [], []);
  doc.querySelector('[data-session-id="s1"]').dispatchEvent(new dom.window.MouseEvent('contextmenu', { clientX: 10, clientY: 10, bubbles: true }));
  assert.ok(doc.querySelector('.workspace-tab-context-menu'), 'context menu present');
  controller.showLinkedSessionPopover('s1', [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }], [], () => {});
  assert.equal(doc.querySelector('.workspace-tab-context-menu'), null, 'context menu dismissed');
  assert.ok(doc.querySelector('.workspace-linked-popover'), 'popover present');
});

test('keyboard Shift+F10 opens context menu on focused tab', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
    onSessionClosed() {},
    onCloseOtherSessions() {},
    onCloseSessionsToRight() {},
    onCloseAllSessions() {},
  });
  controller.renderRail(['s1', 's2'], 's1', [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }], [], []);
  const btn = doc.querySelector('[data-workspace-activate="s2"]');
  btn.focus();
  btn.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
  assert.ok(doc.querySelector('.workspace-tab-context-menu'), 'context menu opens on Shift+F10');
});

test('dispose removes rail, scroll arrows, new tab button, and context menu from DOM', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
    onSessionClosed() {},
    onCloseOtherSessions() {},
    onCloseSessionsToRight() {},
    onCloseAllSessions() {},
    onNewSessionRequested() {},
  });
  controller.renderRail(['s1'], 's1', [{ id: 's1', title: 'A' }], [], []);
  assert.ok(doc.querySelector('.workspace-rail'), 'rail present before dispose');
  assert.ok(doc.querySelector('.workspace-rail-new-button'), 'new-tab button present before dispose');
  assert.equal(doc.querySelectorAll('.workspace-rail-scroll-arrow').length, 2, 'scroll arrows present before dispose');

  doc.querySelector('[data-session-id="s1"]').dispatchEvent(new dom.window.MouseEvent('contextmenu', { clientX: 10, clientY: 10, bubbles: true }));
  assert.ok(doc.querySelector('.workspace-tab-context-menu'), 'context menu present before dispose');

  controller.dispose();
  assert.equal(doc.querySelector('.workspace-rail'), null, 'rail removed');
  assert.equal(doc.querySelector('.workspace-rail-new-button'), null, 'new-tab button removed');
  assert.equal(doc.querySelectorAll('.workspace-rail-scroll-arrow').length, 0, 'scroll arrows removed');
  assert.equal(doc.querySelector('.workspace-tab-context-menu'), null, 'context menu removed');
});

test('dispose clears context menu', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
    onSessionClosed() {},
    onCloseOtherSessions() {},
    onCloseSessionsToRight() {},
    onCloseAllSessions() {},
  });
  controller.renderRail(['s1'], 's1', [{ id: 's1', title: 'A' }], [], []);
  doc.querySelector('[data-session-id="s1"]').dispatchEvent(new dom.window.MouseEvent('contextmenu', { clientX: 10, clientY: 10, bubbles: true }));
  assert.ok(doc.querySelector('.workspace-tab-context-menu'));
  controller.dispose();
  assert.equal(doc.querySelector('.workspace-tab-context-menu'), null, 'menu cleared on dispose');
});

// ---- UIUX-030: rail overflow-arrow scrolling must honor prefers-reduced-motion ----

function setupOverflowRail(t, matches) {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  dom.window.matchMedia = () => ({ matches });
  const doc = dom.window.document;
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
    onSessionClosed() {},
  });
  controller.renderRail(['s1', 's2'], 's1', [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }], [], []);
  const rail = doc.querySelector('.workspace-rail');
  let captured = null;
  rail.scrollBy = (opts) => { captured = opts; };
  return {
    doc,
    getCaptured: () => captured,
  };
}

test('left scroll arrow scrolls the rail smoothly when the OS does not prefer reduced motion', (t) => {
  const { doc, getCaptured } = setupOverflowRail(t, false);
  doc.querySelector('.workspace-rail-scroll-arrow').dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
  const captured = getCaptured();
  assert.ok(captured, 'expected scrollBy to be called');
  assert.equal(captured.behavior, 'smooth');
});

test('left scroll arrow degrades to instant scrolling under OS prefers-reduced-motion', (t) => {
  const { doc, getCaptured } = setupOverflowRail(t, true);
  doc.querySelector('.workspace-rail-scroll-arrow').dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
  const captured = getCaptured();
  assert.ok(captured, 'expected scrollBy to be called');
  assert.equal(captured.behavior, 'auto', 'reduced motion must degrade the rail scroll-arrow jump to instant');
});

test('right scroll arrow degrades to instant scrolling under OS prefers-reduced-motion', (t) => {
  const { doc, getCaptured } = setupOverflowRail(t, true);
  const arrows = doc.querySelectorAll('.workspace-rail-scroll-arrow');
  arrows[arrows.length - 1].dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
  const captured = getCaptured();
  assert.ok(captured, 'expected scrollBy to be called');
  assert.equal(captured.behavior, 'auto', 'reduced motion must degrade the rail scroll-arrow jump to instant');
});

// The band that holds the tabs is a direct child of .main-stage, so with zero
// open tabs it used to render as an empty 36px strip carrying nothing but the +
// button, pinned under the window controls. `.workspace-rail-shell:empty` was
// meant to collapse it but can never match: renderRail() builds the scroll
// arrows, the rail, and the + unconditionally on first call. data-tab-count is
// the real collapse signal the stylesheet keys off.
test('renderRail publishes the open-tab count so CSS can collapse the empty band', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const shell = doc.getElementById('rail');
  const controller = createWorkspaceChromeController({
    containerEl: shell,
    onNewSessionRequested() {},
  });

  controller.renderRail([], '', [], [], []);
  assert.equal(shell.dataset.tabCount, '0', 'no open sessions must report zero tabs');

  controller.renderRail(['s1'], 's1', [{ id: 's1', title: 'A' }], [], []);
  assert.equal(shell.dataset.tabCount, '1', 'a single open session must report one tab');

  controller.renderRail(
    ['s1', 's2'],
    's1',
    [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }],
    [],
    []
  );
  assert.equal(shell.dataset.tabCount, '2', 'two open sessions must report two tabs');

  controller.renderRail(
    ['s1', 's2', 's3'],
    's1',
    [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }, { id: 's3', title: 'C' }],
    [],
    []
  );
  assert.equal(shell.dataset.tabCount, '3', 'three open sessions must report three tabs');
});

test('renderRail lowers the published tab count when sessions close', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const shell = doc.getElementById('rail');
  const controller = createWorkspaceChromeController({
    containerEl: shell,
    onNewSessionRequested() {},
  });

  controller.renderRail(
    ['s1', 's2', 's3'],
    's1',
    [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }, { id: 's3', title: 'C' }],
    [],
    []
  );
  assert.equal(shell.dataset.tabCount, '3');

  controller.renderRail(['s1', 's2'], 's1', [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }], [], []);
  assert.equal(shell.dataset.tabCount, '2', 'closing a tab must lower the count');

  // Dropping to a single tab is what re-collapses the band; a stale '2' here
  // would leave the strip on screen with one lone tab in it.
  controller.renderRail(['s1'], 's1', [{ id: 's1', title: 'A' }], [], []);
  assert.equal(shell.dataset.tabCount, '1', 'dropping to one tab must re-collapse the band');

  controller.renderRail([], '', [], [], []);
  assert.equal(shell.dataset.tabCount, '0', 'closing the last tab must report zero');
});

test('dispose clears the published tab count with the DOM it described', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const shell = doc.getElementById('rail');
  const controller = createWorkspaceChromeController({
    containerEl: shell,
    onNewSessionRequested() {},
  });

  controller.renderRail(['s1', 's2'], 's1', [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }], [], []);
  assert.equal(shell.dataset.tabCount, '2');

  controller.dispose();
  assert.equal(shell.dataset.tabCount, undefined, 'dispose must not leave a stale tab count behind');
});

test('the rail new-chat button matches the naming of the other new-chat affordances', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
    onNewSessionRequested() {},
  });

  controller.renderRail(['s1'], 's1', [{ id: 's1', title: 'A' }], [], []);
  const newBtn = doc.querySelector('[data-workspace-new]');
  assert.equal(newBtn.getAttribute('aria-label'), 'New chat');
  assert.match(newBtn.title, /Ctrl\+N/, 'the button should surface the same shortcut the collapsed strip does');
});
