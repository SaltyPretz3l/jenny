const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createContextPanelController } = require('../renderer/features/renderer-context-panel-utils.js');

test('dispose cancels the delayed composer layout update after a panel toggle', () => {
  const dom = new JSDOM('<button id="toggle"></button><aside id="panel"></aside>');
  const documentRef = dom.window.document;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = new Map();
  let nextTimerId = 0;
  let updates = 0;
  global.setTimeout = (callback) => {
    nextTimerId += 1;
    timers.set(nextTimerId, callback);
    return nextTimerId;
  };
  global.clearTimeout = (timerId) => timers.delete(timerId);

  try {
    const controller = createContextPanelController({
      state: { ui: { activeView: 'chat' } },
      dom: {
        chatContextPanel: documentRef.getElementById('panel'),
        contextPanelToggle: documentRef.getElementById('toggle'),
      },
      callbacks: {
        updateComposerSafeOffset() { updates += 1; },
        escapeHtml: String,
      },
      constants: {},
    });
    controller.bind();
    documentRef.getElementById('toggle').click();
    assert.equal(updates, 1);

    controller.dispose();
    for (const callback of timers.values()) callback();

    assert.equal(updates, 1);
    assert.equal(timers.size, 0);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

function bindWithStoredPreference(stored) {
  const dom = new JSDOM('<button id="toggle"></button><aside id="panel"></aside>');
  const documentRef = dom.window.document;
  const originalLocalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => (stored === undefined ? null : JSON.stringify(stored)),
      setItem() {},
    },
  });
  try {
    const controller = createContextPanelController({
      state: { ui: { activeView: 'chat' } },
      dom: {
        chatContextPanel: documentRef.getElementById('panel'),
        contextPanelToggle: documentRef.getElementById('toggle'),
      },
      callbacks: { updateComposerSafeOffset() {}, escapeHtml: String },
      constants: {},
    });
    controller.bind();
    const collapsed = documentRef.getElementById('panel').classList.contains('collapsed');
    controller.dispose();
    return collapsed;
  } finally {
    if (originalLocalStorage === undefined) {
      delete globalThis.localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage });
    }
  }
}

test('the context panel starts collapsed unless the user explicitly expanded it', () => {
  assert.equal(bindWithStoredPreference(undefined), true, 'fresh profile collapses');
  assert.equal(bindWithStoredPreference({}), true, 'stored prefs without the key collapse');
  assert.equal(bindWithStoredPreference({ collapsed: true }), true);
  assert.equal(bindWithStoredPreference({ collapsed: false }), false, 'an explicit expand is honored');
});

// 2026-09-27 rail polish: humanized rows, selection, list semantics, jump,
// focus preservation, Activity disclosure (Session Pulse removed).
const orbitCard = require('../renderer/inventory/orbit-card.js');

const RAIL_MARKUP = '<aside id="panel">'
  + '<section id="contextArtifactSection"><span id="contextArtifactCount">0</span>'
  + '<button id="contextArtifactExpand" type="button"></button><button id="contextPanelToggle" type="button"></button>'
  + '<div id="contextArtifactList" role="list"></div></section>'
  + '<section class="logs-collapsed" id="contextLogSection">'
  + '<button id="contextLogDisclosure" type="button" aria-expanded="false"><span id="contextLogCount">0</span></button>'
  + '<div id="contextSessionLogs" hidden></div></section></aside>';

// One minute ago: the meta line's age is formatted live (Intl, en -> '1m ago').
const ONE_MINUTE_AGO = new Date(Date.now() - 60000).toISOString();
const FIXTURES = Object.freeze({
  image: { id: 'img1', artifactType: 'image', title: 'cat.png', status: 'available', sourceMessageId: 'm1', timestamp: ONE_MINUTE_AGO, image: { width: 640, height: 480 } },
  doc: { id: 'doc1', artifactType: 'generated_file', title: 'Plan', status: 'available', sourceMessageId: 'm2', timestamp: ONE_MINUTE_AGO, generatedFile: { fileName: 'plan.md', isMarkdownDocument: true } },
  file: { id: 'file1', artifactType: 'generated_file', title: 'Script', status: 'available', sourceMessageId: '', timestamp: ONE_MINUTE_AGO, generatedFile: { fileName: 'main.py', isMarkdownDocument: false } },
  tool: { id: 'tool1', artifactType: 'tool_output', title: 'Researched the topic', status: 'completed', sourceMessageId: 'm3', timestamp: ONE_MINUTE_AGO, tool: { toolName: 'delegate', summary: 'Researched the topic', isError: false } },
  failed: { id: 'tool2', artifactType: 'tool_output', title: 'Search failed', status: 'error', sourceMessageId: 'm4', timestamp: ONE_MINUTE_AGO, tool: { toolName: 'web_search', isError: true } },
});

function mountRail(t, { artifacts = [], logs = [], artifactsState = {}, withJump = true } = {}) {
  const jsdom = new JSDOM(`<!doctype html><body>${RAIL_MARKUP}</body>`);
  const doc = jsdom.window.document;
  const ctx = { artifacts, logs };
  const calls = { open: [], jump: [] };
  const state = { ui: { activeView: 'chat' }, currentSessionId: 's1', artifacts: artifactsState };
  const originalI18n = globalThis.jennyI18n;
  globalThis.jennyI18n = { tag: () => 'en' };
  const callbacks = {
    escapeHtml: orbitCard.escapeHtml,
    updateComposerSafeOffset() {},
    getArtifactsForSession: (sessionId) => (sessionId === 's1' ? ctx.artifacts : []),
    getLogEntries: () => ctx.logs,
    openArtifactTarget: (id) => { calls.open.push(id); return Promise.resolve(); },
  };
  if (withJump) callbacks.jumpToArtifactSource = (id) => { calls.jump.push(id); };
  const controller = createContextPanelController({
    state,
    dom: {
      chatContextPanel: doc.getElementById('panel'),
      contextArtifactList: doc.getElementById('contextArtifactList'),
      contextSessionLogs: doc.getElementById('contextSessionLogs'),
      contextPanelToggle: doc.getElementById('contextPanelToggle'),
      contextArtifactExpand: doc.getElementById('contextArtifactExpand'),
    },
    callbacks,
    constants: {},
  });
  controller.bind();
  controller.renderContextPanel();
  t.after(() => {
    controller.dispose();
    if (originalI18n === undefined) delete globalThis.jennyI18n;
    else globalThis.jennyI18n = originalI18n;
  });
  const list = doc.getElementById('contextArtifactList');
  const card = (id) => list.querySelector(`[data-orbit-card-id="${id}"]`);
  const meta = (id) => card(id).querySelector('.orbit-card-meta').textContent;
  return { doc, window: jsdom.window, controller, ctx, calls, state, list, card, meta };
}

test('orbitCard renders tone, tooltip and a leading escaped status span', () => {
  const html = orbitCard({ id: 'a"1', title: '<b>T</b>', meta: 'x<y', tooltip: 'say "hi"', tone: 'muted', status: '<Failed>', statusTone: 'danger' });
  const { window } = new JSDOM(`<!doctype html><body>${html}</body>`);
  const button = window.document.querySelector('button.orbit-card');
  assert.equal(button.dataset.tone, 'muted');
  assert.equal(button.getAttribute('title'), 'say "hi"');
  assert.equal(button.dataset.orbitCardId, 'a"1');
  assert.equal(button.querySelector('.orbit-card-title').textContent, '<b>T</b>');
  const status = button.querySelector('.orbit-card-meta .orbit-card-status');
  assert.equal(status.textContent, '<Failed>');
  assert.equal(status.dataset.tone, 'danger');
  // Status leads the meta line so a long detail can never ellipsize it away.
  assert.equal(button.querySelector('.orbit-card-meta').textContent, '<Failed> · x<y');
  // Existing opts keep their existing output; the title takes its own
  // direction (2026-09-27 gate N4: English under the Arabic locale).
  assert.equal(orbitCard({ id: 'b', title: 'T', meta: 'M' }),
    '<button class="orbit-card" type="button" data-orbit-card-id="b"><span class="orbit-card-icon" aria-hidden="true"></span>'
    + '<span class="orbit-card-body"><span class="orbit-card-title" dir="auto">T</span><span class="orbit-card-meta">M</span></span></button>');
});

test('artifact rows carry humanized meta per type and never a raw enum', (t) => {
  const f = FIXTURES;
  const { list, card, meta, doc } = mountRail(t, { artifacts: [f.image, f.doc, f.file, f.tool, f.failed] });
  assert.equal(doc.getElementById('contextArtifactCount').textContent, '5');
  assert.equal(meta('img1'), 'Image · 640×480 · 1m ago');
  assert.equal(meta('doc1'), 'Document · plan.md · 1m ago');
  assert.equal(meta('file1'), 'File · main.py · 1m ago');
  assert.equal(meta('tool1'), 'Tool result · delegate · 1m ago');
  assert.equal(card('tool1').querySelector('.orbit-card-title').textContent, 'Researched the topic');
  assert.equal(card('tool1').getAttribute('title'), 'Researched the topic');
  assert.equal(card('tool1').dataset.tone, 'muted');
  assert.equal(card('doc1').dataset.tone, 'accent');
  // A failed result swaps the age for a danger status.
  assert.equal(meta('tool2'), 'Failed · Tool result · web_search');
  const status = card('tool2').querySelector('.orbit-card-status');
  assert.equal(status.textContent, 'Failed');
  assert.equal(status.dataset.tone, 'danger');
  assert.doesNotMatch(list.textContent, /TOOL_OUTPUT|GENERATED_FILE|IMAGE\b/);
  // Per-type icons are stroke glyphs with no fill attributes.
  assert.equal(list.querySelectorAll('.orbit-card-icon svg [fill]').length, 0);
  assert.ok(card('img1').querySelector('.orbit-card-icon svg circle'), 'image glyph');
});

test('a missing image shows a muted Missing status and no size when dimensions are unknown', (t) => {
  const missing = { ...FIXTURES.image, id: 'img2', status: 'missing', image: { width: 0, height: 0 } };
  const { card, meta } = mountRail(t, { artifacts: [missing] });
  assert.equal(meta('img2'), 'Missing · Image');
  assert.equal(card('img2').querySelector('.orbit-card-status').dataset.tone, 'muted');
});

test('each row is a listitem holding the card and, with a source message, a jump button', (t) => {
  const f = FIXTURES;
  const { list, card, calls, window } = mountRail(t, { artifacts: [f.image, f.file] });
  const items = list.querySelectorAll(':scope > [role="listitem"]');
  assert.equal(items.length, 2);
  assert.equal(list.querySelectorAll(':scope > button').length, 0, 'no bare buttons under role=list');
  const jump = items[0].querySelector('.orbit-card-jump');
  assert.ok(jump, 'jump button with a sourceMessageId');
  assert.equal(jump.dataset.artifactJump, 'm1');
  assert.equal(jump.getAttribute('aria-label'), 'Jump to message');
  assert.equal(card('img1').contains(jump), false, 'the jump button is a sibling, not nested');
  assert.equal(items[1].querySelector('.orbit-card-jump'), null, 'no jump without a sourceMessageId');
  assert.equal(list.getAttribute('role'), 'list');

  jump.querySelector('svg').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(calls.jump, ['m1']);
  assert.deepEqual(calls.open, [], 'a jump never opens the artifact');
  card('file1').click();
  assert.deepEqual(calls.open, ['file1']);
  assert.deepEqual(calls.jump, ['m1']);
});

test('focus stays on the same row across a re-render with changed data', (t) => {
  const f = FIXTURES;
  const rail = mountRail(t, { artifacts: [f.image, f.doc] });
  const before = rail.card('doc1');
  before.focus();
  assert.equal(rail.doc.activeElement, before);
  rail.ctx.artifacts = [f.tool, f.image, f.doc];
  rail.controller.renderContextPanel();
  const after = rail.card('doc1');
  assert.notEqual(after, before, 'the row was rebuilt');
  assert.equal(rail.doc.activeElement, after, 'focus returned to the rebuilt row');

  const jump = after.parentNode.querySelector('.orbit-card-jump');
  jump.focus();
  rail.ctx.artifacts = [f.doc];
  rail.controller.renderContextPanel();
  const rebuiltJump = rail.card('doc1').parentNode.querySelector('.orbit-card-jump');
  assert.notEqual(rebuiltJump, jump);
  assert.equal(rail.doc.activeElement, rebuiltJump, 'focus returned to the rebuilt jump button');
});

test('an identical re-render leaves the row nodes in place', (t) => {
  const f = FIXTURES;
  const rail = mountRail(t, { artifacts: [f.image, f.doc] });
  const first = rail.list.firstElementChild;
  rail.controller.renderContextPanel();
  assert.equal(rail.list.firstElementChild, first);
});

test('the rail renders without any Session Pulse dom and explains an empty list', (t) => {
  const rail = mountRail(t, { artifacts: [] });
  assert.equal(rail.doc.getElementById('contextPulse'), null);
  assert.equal(rail.doc.querySelector('.context-metric-row'), null);
  const empty = rail.list.querySelector('p.context-empty-state');
  assert.ok(empty);
  assert.equal(empty.textContent, 'Files, images, and tool results from this chat appear here.');
  assert.equal(rail.doc.getElementById('contextArtifactCount').textContent, '0');
  assert.equal(empty.getAttribute('role'), null, 'the empty sentence is not a listitem');
  assert.equal(rail.list.getAttribute('role'), null, 'an empty list is not announced as a one-item list');
});

test('the age is localized through Intl and the jump button needs a jump callback', (t) => {
  const rail = mountRail(t, { artifacts: [FIXTURES.image] });
  assert.equal(rail.meta('img1'), 'Image · 640×480 · 1m ago');
  globalThis.jennyI18n = { tag: () => 'fr' };
  rail.ctx.artifacts = [{ ...FIXTURES.image, id: 'img9' }];
  rail.controller.renderContextPanel();
  assert.equal(rail.meta('img9'), 'Image · 640×480 · -1 min');

  // A composition without the callback (the fallback configuration) renders no inert jump button.
  const noJump = mountRail(t, { artifacts: [FIXTURES.image], withJump: false });
  assert.ok(noJump.card('img1'));
  assert.equal(noJump.list.querySelector('.orbit-card-jump'), null);
});

test('the Activity disclosure toggles the feed and stays visible with zero entries', (t) => {
  const rail = mountRail(t, { logs: [] });
  const disclosure = rail.doc.getElementById('contextLogDisclosure');
  const feed = rail.doc.getElementById('contextSessionLogs');
  const section = rail.doc.getElementById('contextLogSection');
  assert.equal(disclosure.classList.contains('hidden'), false);
  assert.equal(disclosure.disabled, false);
  assert.equal(disclosure.getAttribute('aria-expanded'), 'false');
  assert.equal(feed.hidden, true);
  assert.equal(section.classList.contains('logs-collapsed'), true);
  assert.equal(rail.doc.getElementById('contextLogCount').textContent, '0');

  disclosure.click();
  assert.equal(disclosure.getAttribute('aria-expanded'), 'true');
  assert.equal(feed.hidden, false);
  assert.equal(section.classList.contains('logs-collapsed'), false);
  assert.equal(feed.querySelector('p.context-empty-state').textContent, 'Nothing logged yet.');

  rail.ctx.logs = [{ ts: Date.now(), event: 'chat.send' }];
  rail.controller.renderContextPanel();
  assert.equal(feed.querySelectorAll('.context-log-line').length, 1);
  assert.equal(rail.doc.getElementById('contextLogCount').textContent, '1');

  rail.ctx.logs = [];
  rail.controller.renderContextPanel();
  assert.equal(disclosure.getAttribute('aria-expanded'), 'true', 'emptying the feed keeps the user\'s expanded state');
  assert.equal(feed.hidden, false);

  disclosure.click();
  assert.equal(disclosure.getAttribute('aria-expanded'), 'false');
  assert.equal(feed.hidden, true);
  assert.equal(section.classList.contains('logs-collapsed'), true);
});
