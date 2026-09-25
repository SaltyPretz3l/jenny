'use strict';

// The Workspace folder is the project: with a folder configured, a chat whose
// project has no folder (General, or unbound by hand) gets a "Use <folder>"
// action on the existing workspace-root nudge that adopts the workspace
// project through projects.adoptWorkspace. Idle chats only; per-chat dismiss;
// non-General chats are judged by one bounded projects.list read.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createWorkspaceRootNudgeController, folderName } = require('../renderer/features/renderer-workspace-root-nudge');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

function makeDom() {
  return new JSDOM(`
    <!doctype html>
    <html>
      <body>
        <div class="composer-wrap" id="composerWrap" data-dock-anchor="composer">
          <div class="composer" id="composerRoot"><div class="composer-rail"><div class="composer-project-pill-slot" id="composerProjectPillSlot"></div></div></div>
        </div>
      </body>
    </html>
  `, { pretendToBeVisual: true, url: 'http://localhost/' });
}

function makeState(overrides) {
  return {
    features: { featureFlags: { workspace_root_nudge: true } },
    workspaceRoot: { path: 'D:\\Projects\\Ascend', status: { state: 'ready', message: 'Workspace root is configured.' } },
    currentSessionId: 'sess_old',
    sessions: [{ id: 'sess_old', title: 'Old chat', project_id: 'project_general' }],
    ...overrides,
  };
}

function makeProjectsApi({ projects, adopt } = {}) {
  const calls = { list: 0, adopt: [] };
  return {
    calls,
    api: {
      async list() { calls.list += 1; return { ok: true, projects: projects || [] }; },
      async adoptWorkspace(payload) {
        calls.adopt.push(payload);
        return typeof adopt === 'function' ? adopt(payload) : {
          ok: true,
          session: { id: payload.session_id, project_id: 'project_ws' },
          project: { id: 'project_ws', name: 'Ascend', root_path: 'D:\\Projects\\Ascend' },
        };
      },
    },
  };
}

function createHarness(t, { state, api, refreshSessions, appendClientLog, now } = {}) {
  const dom = makeDom();
  const controller = createWorkspaceRootNudgeController({
    state: state || makeState(),
    windowRef: dom.window,
    documentRef: dom.window.document,
    appendClientLog: appendClientLog || (() => {}),
    getProjectsApi: () => api || null,
    refreshSessions,
    now,
  });
  controller.bind();
  t.after(() => controller.dispose());
  return { dom, controller };
}

function chip(dom) {
  return dom.window.document.getElementById('workspaceRootNudge');
}

function useFolderButton(dom) {
  return dom.window.document.querySelector('[data-workspace-root-nudge-action="use-folder"]');
}

function click(dom, element) {
  element.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

test('folderName takes the last segment of either separator style', () => {
  assert.equal(folderName('D:\\Projects\\Ascend'), 'Ascend');
  assert.equal(folderName('/home/dev/ascend/'), 'ascend');
  assert.equal(folderName(''), '');
});

test('a General chat under a configured folder offers "Use <folder>" without listing projects', (t) => {
  const { calls, api } = makeProjectsApi();
  const { dom, controller } = createHarness(t, { api });
  controller.render();
  assert.ok(chip(dom));
  assert.equal(chip(dom).getAttribute('data-nudge-variant'), 'use-folder');
  assert.match(chip(dom).textContent, /This chat has no folder/);
  assert.equal(useFolderButton(dom).textContent.trim(), 'Use Ascend');
  assert.equal(useFolderButton(dom).disabled, false);
  assert.equal(calls.list, 0, 'General needs no project lookup');
  assert.equal(dom.window.document.querySelector('[data-workspace-root-nudge-action="set-root"]'), null);
});

test('the action is disabled while the chat is busy and re-enabled once idle', (t) => {
  const state = makeState({ activeStreamSessionId: 'sess_old' });
  const { dom, controller } = createHarness(t, { state });
  controller.render();
  assert.equal(useFolderButton(dom).disabled, true);
  assert.equal(useFolderButton(dom).title, 'Wait for this chat to finish first.');

  state.activeStreamSessionId = '';
  controller.render();
  assert.equal(useFolderButton(dom).disabled, false);
  assert.equal(useFolderButton(dom).title, 'D:\\Projects\\Ascend');

  state.sessions[0].active_turn = { id: 'turn_1' };
  controller.render();
  assert.equal(useFolderButton(dom).disabled, true);
});

test('clicking "Use <folder>" adopts the chat, updates its summary, refreshes the list and removes the chip', async (t) => {
  const state = makeState();
  const { calls, api } = makeProjectsApi();
  let refreshed = 0;
  const { dom, controller } = createHarness(t, { state, api, refreshSessions: () => { refreshed += 1; } });
  controller.render();

  click(dom, useFolderButton(dom));
  assert.equal(useFolderButton(dom).disabled, true, 'pending adoption disables the action');
  await settle();

  assert.deepEqual(calls.adopt, [{ session_id: 'sess_old' }]);
  assert.equal(state.sessions[0].project_id, 'project_ws');
  assert.equal(refreshed, 1);
  // Projects v2: a bound chat shows nothing above the composer; its project
  // is named by the composer pill.
  assert.equal(chip(dom), null, 'a bound chat has no hint above the composer');
  const pill = dom.window.document.getElementById('composerProjectPill');
  assert.equal(pill.querySelector('.inv-chip-label').textContent, 'Ascend');
  assert.match(pill.title, /D:\\Projects\\Ascend/);
  controller.render();
  assert.equal(chip(dom), null, 'a bound chat stays hint-free');
});

test('a refused adoption keeps the chip, names the failure, and leaves the chat where it was', async (t) => {
  const state = makeState();
  const logs = [];
  const { api } = makeProjectsApi({
    adopt: () => ({ ok: false, error: { reason: 'session_busy', message: 'The session must be idle before its project can change.' } }),
  });
  const { dom, controller } = createHarness(t, {
    state, api, appendClientLog: (level, event, details) => logs.push([level, event, details]),
  });
  controller.render();
  click(dom, useFolderButton(dom));
  await settle();

  assert.ok(chip(dom));
  assert.match(chip(dom).textContent, /Could not use Ascend: The session must be idle/);
  assert.equal(useFolderButton(dom).disabled, false);
  assert.equal(state.sessions[0].project_id, 'project_general');
  assert.deepEqual(logs.map(([, event]) => event), ['workspace_root_nudge.adopt_failed']);
});

test('an adoption result arriving after disposal cannot touch the page', async (t) => {
  const state = makeState();
  let release;
  const api = {
    async list() { return { ok: true, projects: [] }; },
    adoptWorkspace: () => new Promise((resolve) => { release = resolve; }),
  };
  const { dom, controller } = createHarness(t, { state, api });
  controller.render();
  click(dom, useFolderButton(dom));
  assert.equal(typeof release, 'function');
  controller.dispose();
  assert.equal(chip(dom), null);
  release({ ok: true, session: { id: 'sess_old', project_id: 'project_ws' }, project: { id: 'project_ws' } });
  await settle();
  assert.equal(chip(dom), null);
  assert.equal(state.sessions[0].project_id, 'project_general');
});

test('dismissing "Use <folder>" is per chat, and the chip follows the current chat', (t) => {
  const state = makeState({
    sessions: [
      { id: 'sess_old', title: 'Old chat', project_id: 'project_general' },
      { id: 'sess_other', title: 'Other chat', project_id: 'project_general' },
    ],
  });
  const { dom, controller } = createHarness(t, { state });
  controller.render();
  click(dom, dom.window.document.querySelector('[data-workspace-root-nudge-action="dismiss"]'));
  assert.equal(chip(dom), null);

  state.currentSessionId = 'sess_other';
  controller.render();
  assert.ok(chip(dom), 'another unbound chat still gets the hint');

  state.currentSessionId = 'sess_old';
  controller.render();
  assert.equal(chip(dom), null, 'the dismissed chat stays quiet');

  state.currentSessionId = '';
  controller.render();
  assert.equal(chip(dom), null, 'no chat, no hint');
});

test('the composer render announcement re-evaluates the chip for the newly current chat', (t) => {
  const state = makeState({ currentSessionId: '' });
  const { dom, controller } = createHarness(t, { state });
  controller.render();
  assert.equal(chip(dom), null);

  state.currentSessionId = 'sess_old';
  dom.window.document.getElementById('composerRoot')
    .dispatchEvent(new dom.window.CustomEvent('composer-state-rendered', { bubbles: true }));
  assert.ok(useFolderButton(dom), 'a chat switch announced by the composer mounts the hint without polling');

  controller.dispose();
  state.currentSessionId = '';
  dom.window.document.getElementById('composerRoot')
    .dispatchEvent(new dom.window.CustomEvent('composer-state-rendered', { bubbles: true }));
  assert.equal(chip(dom), null, 'a disposed controller ignores the announcement');
});

test('clearing the folder swaps back to the set-root hint; a bound chat under a folder shows its project line', async (t) => {
  const state = makeState();
  const { dom, controller } = createHarness(t, { state });
  controller.render();
  assert.equal(chip(dom).getAttribute('data-nudge-variant'), 'use-folder');

  state.workspaceRoot = { path: '', status: { state: 'missing', message: 'No workspace root is configured yet.' } };
  controller.render();
  assert.equal(chip(dom).getAttribute('data-nudge-variant'), 'set-root');

  state.workspaceRoot = { path: 'D:\\Projects\\Ascend', status: { state: 'ready', message: '' } };
  state.sessions[0].project_id = 'project_ws';
  const { api } = makeProjectsApi({ projects: [{ id: 'project_ws', name: 'Ascend', root_path: 'D:\\Projects\\Ascend' }] });
  const bound = createHarness(t, { state, api });
  bound.controller.render();
  assert.equal(chip(bound.dom), null, 'unknown project renders nothing until the list arrives');
  await settle();
  assert.equal(chip(bound.dom), null, 'a bound chat shows no hint');
  assert.equal(bound.dom.window.document.querySelector('#composerProjectPill .inv-chip-label').textContent, 'Ascend');
});

test('a non-General chat is judged by its project root after one bounded list fetch', async (t) => {
  const state = makeState({
    sessions: [
      { id: 'sess_old', title: 'Bound chat', project_id: 'project_bound' },
      { id: 'sess_loose', title: 'Loose chat', project_id: 'project_loose' },
    ],
  });
  const { calls, api } = makeProjectsApi({ projects: [
    { id: 'project_bound', name: 'Bound', root_path: 'D:\\Projects\\Ascend' },
    { id: 'project_loose', name: 'Loose', root_path: null },
  ] });
  let clock = 1000;
  const { dom, controller } = createHarness(t, { state, api, now: () => clock });

  controller.render();
  assert.equal(chip(dom), null, 'unknown project renders nothing yet');
  await settle();
  assert.equal(calls.list, 1);
  assert.equal(chip(dom), null, 'a bound project gets no hint (the composer pill names it)');
  assert.equal(dom.window.document.querySelector('#composerProjectPill .inv-chip-label').textContent, 'Bound');

  state.currentSessionId = 'sess_loose';
  controller.render();
  assert.ok(useFolderButton(dom), 'an unbound project gets the hint');
  assert.equal(calls.list, 1, 'the fresh list is reused');

  clock += 20000;
  controller.render();
  await settle();
  assert.equal(calls.list, 2, 'a stale list is re-read on the snapshot cadence');
});

test('app binding mounts "Use <folder>" for a folderless chat and routes the click to projects.adoptWorkspace', async () => {
  const adoptCalls = [];
  const app = await loadRendererApp({
    shell: {
      sessions: [{
        id: 'sess_old', title: 'Old chat', project_id: 'project_general', conversation_mode: 'chat',
        preferred_model: 'gpt-test', reasoning_effort: 'default', interactive_round_count: 0,
        interactive_sequence_state: 'idle', pending_question_batch: null, linked_session_ids: [],
        updated_at: new Date().toISOString(),
      }],
      features: { state: { featureFlags: { workspace_root_nudge: true } } },
      workspaceRoot: { state: { workspaceRoot: 'G:/workspace/Ascend', workspaceRootStatus: { state: 'ready', message: 'Workspace root is configured.' } } },
      projects: {
        list: () => ({ ok: true, projects: [] }),
        adoptWorkspace: (payload) => {
          adoptCalls.push(payload);
          return {
            ok: true,
            session: { id: payload.session_id, project_id: 'project_ws' },
            project: { id: 'project_ws', name: 'Ascend', root_path: 'G:/workspace/Ascend' },
          };
        },
      },
    },
  });
  try {
    const button = app.window.document.querySelector('[data-workspace-root-nudge-action="use-folder"]');
    assert.ok(button, 'a configured folder plus a General chat should mount the adopt action');
    assert.equal(button.textContent.trim(), 'Use Ascend');
    assert.equal(app.window.document.querySelector('[data-workspace-root-nudge-action="set-root"]'), null);

    button.click();
    await waitForUi(app.window, 80);

    // The payload is built in the JSDOM realm, so compare by value, not prototype.
    assert.equal(JSON.stringify(adoptCalls), JSON.stringify([{ session_id: 'sess_old' }]));
    assert.equal(app.window.document.getElementById('workspaceRootNudge'), null, 'the adopted chat no longer needs a hint');
    const pill = app.window.document.getElementById('composerProjectPill');
    assert.ok(pill, 'the composer pill is painted from the real index.html slot');
    assert.equal(pill.querySelector('.inv-chip-label').textContent, 'Ascend');
  } finally {
    await app.dispose();
  }
});
