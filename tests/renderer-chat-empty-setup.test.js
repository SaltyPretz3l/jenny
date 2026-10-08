'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createChromePipeline } = require('../renderer/chat/renderer-render-pipeline-chrome');
const { createChatsPanelController } = require('../renderer/shell/renderer-chats-panel');
const actionButton = require('../renderer/inventory/action-button');
const segmentedControl = require('../renderer/inventory/segmented-control');

function heroHarness(t, steps, resume = () => {}) {
  const previousResume = globalThis.jennySetupResume;
  const previousActionButton = globalThis.inventoryActionButton;
  globalThis.jennySetupResume = resume;
  globalThis.inventoryActionButton = actionButton;
  const page = new JSDOM('<body>' + [0, 1].map((id) => `
    <div class="hero-stage" data-pane="${id}"><div class="hero-stack">
      <div class="hero-avatar"></div><h1 class="hero-title"></h1>
      <p class="hero-subtitle"></p><p class="hero-runtime-hint hidden"></p>
    </div></div>`).join('') + '<textarea></textarea></body>');
  const state = {
    sessions: [], currentSessionId: '', ui: { activeView: 'chat' },
    setup: { loaded: true, setupComplete: false, steps },
    backend: { phase: 'ready' }, status: { model_loaded: false },
  };
  const pipelines = Array.from(page.window.document.querySelectorAll('.hero-stage'), (hero) => createChromePipeline({
    state,
    dom: {
      heroAvatar: hero.querySelector('.hero-avatar'), heroTitle: hero.querySelector('.hero-title'),
      heroSubtitle: hero.querySelector('.hero-subtitle'), heroRuntimeHint: hero.querySelector('.hero-runtime-hint'),
    },
    callbacks: { getVisibleSessionMessages: () => state.messages || [] },
  }));
  t.after(() => {
    pipelines.forEach((pipeline) => pipeline.dispose?.());
    page.window.close();
    if (previousResume === undefined) delete globalThis.jennySetupResume;
    else globalThis.jennySetupResume = previousResume;
    if (previousActionButton === undefined) delete globalThis.inventoryActionButton;
    else globalThis.inventoryActionButton = previousActionButton;
  });
  const render = () => pipelines.forEach((pipeline) => pipeline.renderHero());
  return { state, pipelines, document: page.window.document, render };
}

test('incomplete empty heroes name the next steps without indirect Home copy', (t) => {
  const { document, render } = heroHarness(t, { workspaceRoot: 'pending', localModel: 'pending', endpoint: 'pending' });
  render();
  for (const hero of document.querySelectorAll('.hero-stage')) {
    assert.doesNotMatch(hero.textContent, /Companion Home|below/);
    assert.equal(hero.querySelector('.hero-title').textContent, "Let's finish setting up Jenny");
    assert.equal(hero.querySelector('.hero-subtitle').textContent, 'Choose a model route and a workspace folder to finish.');
  }
});

test('each pane renders one primary Resume setup action and one click calls the seam once', (t) => {
  let calls = 0;
  const { document, render } = heroHarness(t, undefined, () => { calls += 1; });
  render();
  render();
  for (const hero of document.querySelectorAll('.hero-stage')) {
    const buttons = hero.querySelectorAll('button');
    assert.equal(buttons.length, 1, 'each hero needs exactly one Resume setup button');
    assert.equal(buttons[0].textContent, 'Resume setup');
    assert.ok(buttons[0].classList.contains('btn--primary'));
    assert.equal(hero.querySelector('.hero-subtitle').nextElementSibling, buttons[0]);
    assert.ok(buttons[0].nextElementSibling.classList.contains('hidden'));
  }
  document.querySelector('button').click();
  assert.equal(calls, 1);
  assert.equal(document.querySelector('textarea').disabled, false);
});

test('empty heroes follow model state per pane, clear on other branches, and render idempotently', (t) => {
  const { document, state, render, pipelines } = heroHarness(t);
  state.setup.setupComplete = true;
  state.modelList = { available: true, data: [] };
  state.modelRecommendation = { tag: 'fit:3b', downloadSizeMb: 2000 };
  render();
  for (const hero of document.querySelectorAll('.hero-stage')) {
    assert.equal(hero.dataset.modelState, 'noModel');
    assert.equal(hero.querySelector('.hero-title').textContent, 'Pick a model to start');
    assert.equal(hero.querySelectorAll('[data-hero-action]').length, 2);
    assert.match(hero.querySelector('.hero-runtime-hint').textContent, /ChatGPT/);
  }
  const nodes = [...document.querySelectorAll('.hero-actions, [data-hero-action]')];
  const observer = new document.defaultView.MutationObserver(() => {});
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  render();
  assert.deepEqual([...document.querySelectorAll('.hero-actions, [data-hero-action]')], nodes);
  assert.equal(observer.takeRecords().length, 0, 'same view must not mutate nodes');
  observer.disconnect();
  state.modelPulls = { fit: { tag: 'fit:3b', status: 'running', percent: 40 } };
  render();
  assert.equal(document.querySelector('.hero-stage').dataset.modelState, 'downloading');
  assert.match(document.querySelector('.hero-subtitle').textContent, /40%/);
  assert.equal(document.querySelector('[data-hero-action]').dataset.heroAction, 'cancel-download');
  state.backend = { phase: 'model_unavailable', model_lifecycle: { failure: { cause: 'out_of_memory', model: 'large:8b', context: 40960 } } };
  render();
  assert.equal(document.querySelector('.hero-stage').dataset.modelState, 'failed');
  assert.equal(document.querySelectorAll('[data-pane="0"] [data-hero-model="large:8b"]').length, 2);
  state.backend = { phase: 'ready' };
  state.modelPulls = {};
  state.modelList.data = [{ id: 'fit:3b' }];
  state.status.model = 'fit:3b';
  render();
  assert.equal(document.querySelector('.hero-stage').dataset.modelState, 'ready');
  assert.equal(document.querySelectorAll('[data-hero-action]').length, 0);
  assert.equal(document.querySelector('.hero-runtime-hint').textContent, 'fit:3b loads with your first message');
  state.setup.setupComplete = false;
  render();
  assert.equal(document.querySelector('.hero-stage').hasAttribute('data-model-state'), false);
  assert.equal(document.querySelector('.hero-setup-footnote').textContent, 'fit:3b is ready, so you can start chatting now.');
  assert.equal(document.querySelector('.hero-setup-footnote').classList.contains('hidden'), false);
  state.modelPulls = { fit: { status: 'running', tag: 'fit:3b' } };
  render();
  assert.equal(document.querySelector('.hero-setup-footnote').classList.contains('hidden'), true);
  state.setup.setupComplete = true;
  state.sessions = [{ id: 'chat' }]; state.currentSessionId = 'chat'; state.messages = [{ kind: 'user', content: 'Hello' }];
  render();
  assert.equal(document.querySelector('.hero-stage').hasAttribute('data-model-state'), false);
  state.sessions[0].session_type = 'plugin'; state.messages = [];
  render();
  assert.equal(document.querySelector('.hero-stage').hasAttribute('data-model-state'), false);
  pipelines[0].dispose();
  assert.equal(document.querySelector('[data-pane="0"] .hero-actions'), null);
});

for (const [label, steps, subtitle] of [
  ['model only', { workspaceRoot: 'done', localModel: 'skipped', endpoint: 'error' }, 'Choose a model route to finish.'],
  ['folder only with local model', { workspaceRoot: 'error', localModel: 'done', endpoint: 'pending' }, 'Choose a workspace folder so file tools can work.'],
  ['folder only with endpoint', { workspaceRoot: 'skipped', localModel: 'pending', endpoint: 'done' }, 'Choose a workspace folder so file tools can work.'],
  ['optional steps', { workspaceRoot: 'done', localModel: 'pending', endpoint: 'done' }, 'A few optional steps are left.'],
  ['missing step detail', undefined, 'Choose a model route and a workspace folder to finish.'],
]) {
  test(`setup subtitle reflects ${label}`, (t) => {
    const { document, render } = heroHarness(t, steps);
    render();
    assert.equal(document.querySelector('.hero-subtitle').textContent, subtitle);
  });
}

test('Resume setup is absent without the seam and appears when it becomes available', (t) => {
  const { document, render } = heroHarness(t, undefined, null);
  render();
  assert.equal(document.querySelector('button'), null);
  globalThis.jennySetupResume = () => {};
  render();
  assert.equal(document.querySelector('button')?.textContent, 'Resume setup');
});

test('setup actions hide for ready, populated, and provider heroes', (t) => {
  const { document, state, render } = heroHarness(t);
  render();
  const button = document.querySelector('button');
  assert.ok(button);
  state.setup.setupComplete = true;
  // Row 38 item 5: "no model" needs a catalog that was read and lists no usable route.
  state.modelList = { available: true, data: [] };
  render();
  assert.ok(button.classList.contains('hidden'));
  assert.equal(document.querySelector('.hero-title').textContent, 'Pick a model to start');
  state.setup.setupComplete = false;
  state.sessions = [{ id: 'chat', title: 'Existing chat' }];
  state.currentSessionId = 'chat';
  state.messages = [{ kind: 'user', content: 'Hello' }];
  render();
  assert.ok(button.classList.contains('hidden'));
  assert.equal(document.querySelector('.hero-title').textContent, 'Existing chat');
  state.sessions[0].session_type = 'plugin';
  state.messages = [];
  render();
  assert.ok(button.classList.contains('hidden'));
  assert.equal(document.querySelector('.hero-subtitle').textContent, 'Open the provider workspace to begin.');
});

test('chrome teardown removes the Resume setup listener and its owned nodes', (t) => {
  let calls = 0;
  const { document, pipelines, render } = heroHarness(t, undefined, () => { calls += 1; });
  render();
  const button = document.querySelector('button');
  assert.equal(typeof pipelines[0].dispose, 'function', 'chrome needs teardown for its Resume listener');
  pipelines[0].dispose();
  button.click();
  assert.equal(calls, 0);
  assert.equal(document.querySelector('[data-pane="0"] button'), null);
  assert.equal(document.querySelector('[data-pane="0"] .hero-setup-footnote'), null);
});

function sidebarHarness(t, headerAction = true) {
  const page = new JSDOM(`<body><aside class="view-panel">
    <div class="sidebar-header">${headerAction ? actionButton({ label: 'New chat', className: 'new-chat-button' }) : ''}</div>
    <label class="search-shell"><input type="search"></label><div class="chats-project-row"></div>
    <div class="chats-scope-row"><div class="chats-scope-slot"></div><div id="chatsSelectionEntry"></div></div>
    <div class="conversation-groups"></div><div class="status"></div></aside></body>`);
  const document = page.window.document;
  const state = { sessions: [], ui: {} };
  let newChats = 0;
  const controller = createChatsPanelController({
    state, documentRef: document, windowRef: page.window,
    dom: {
      conversationGroups: document.querySelector('.conversation-groups'), searchInput: document.querySelector('input'),
      projectRow: document.querySelector('.chats-project-row'), scopeSlot: document.querySelector('.chats-scope-slot'),
      status: document.querySelector('.status'),
    },
    inventory: { actionButton, segmentedControl }, callbacks: { newChat: () => { newChats += 1; } },
  });
  t.after(() => { controller.dispose(); page.window.close(); });
  return { document, state, controller, newChats: () => newChats, root: document.querySelector('.view-panel') };
}

test('sidebar marks no history, keeps only one empty message and the header New chat action, and clears after one session', (t) => {
  const { document, state, controller, root } = sidebarHarness(t);
  controller.renderNow();
  assert.equal(root.dataset.chatsHistory, 'none');
  assert.equal(document.querySelector('[data-chats-empty]').textContent, 'No chats yet.');
  assert.equal(document.querySelector('[data-chats-empty-action]'), null, 'the visible header already offers New chat');
  state.sessions.push({ id: 'one', title: 'First chat' });
  controller.renderNow();
  assert.equal(root.hasAttribute('data-chats-history'), false);
});

test('archived-only history in another project keeps controls and filtered empty behavior', (t) => {
  const { document, state, controller, root } = sidebarHarness(t);
  state.sessions = [{ id: 'archived', title: 'Saved chat', project_id: 'other', archived_at: '2026-10-03' }];
  state.ui.chatsProjectFilter = 'project_general';
  controller.renderNow();
  assert.equal(root.hasAttribute('data-chats-history'), false);
  assert.equal(document.querySelector('[data-chats-empty]').dataset.emptyKind, 'project');
  state.sessions = [];
  state.ui.sidebarArchivedView = true;
  controller.renderNow();
  assert.equal(root.dataset.chatsHistory, 'none');
  assert.equal(document.querySelector('[data-chats-empty]').textContent, 'No chats yet.');
  document.querySelector('input').value = 'missing';
  controller.renderNow();
  assert.equal(root.hasAttribute('data-chats-history'), false);
  assert.equal(document.querySelector('[data-chats-empty]').dataset.emptyKind, 'search');
});

test('without a header action the empty sidebar offers one working New chat action', (t) => {
  const { document, controller, newChats } = sidebarHarness(t, false);
  controller.renderNow();
  assert.equal(document.querySelector('.sidebar-empty-copy').textContent, '');
  const button = document.querySelector('[data-chats-empty-action]');
  assert.equal(button.textContent, 'New chat');
  button.click();
  assert.equal(newChats(), 1);
});
