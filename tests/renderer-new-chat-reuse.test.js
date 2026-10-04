'use strict';

// Real-app finding X3 (2026-09-29): "+ New chat" while an untouched empty
// "New Chat" exists must reuse it instead of stacking another empty tab.
// Exercised through the shell runtime controller's handleCreateSessionWithWorkspace,
// the one path the New chat button, tab-rail +, Chats +, Ctrl+N and the
// command palette all reach.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createShellRuntimeController } = require('../renderer/shell/renderer-shell-runtime-utils');

function emptyChat(id, overrides = {}) {
  return {
    id,
    title: 'New Chat',
    session_type: 'chat',
    message_count: 0,
    project_id: 'project_general',
    pinned: false,
    created_at: '2026-09-29T10:00:00.000Z',
    ...overrides,
  };
}

function setup({ sessions = [], openSessionIds = null, currentSessionId = '', workspaceRoot = '', projectsList = null, stateExtras = {} } = {}) {
  const state = {
    ui: { chatsProjectFilter: '' },
    sessions: sessions.slice(),
    currentSessionId,
    workspace: { activeSessionId: currentSessionId, openSessionIds: openSessionIds || sessions.map((s) => s.id) },
    workspaceRoot: { path: workspaceRoot },
    messagesBySession: new Map(),
    composerSessionState: new Map(),
    ...stateExtras,
  };
  const createCalls = [];
  const activations = [];
  const logs = [];
  const composer = { focused: 0 };
  const listCalls = [];
  let nextId = 1;
  const windowRef = {
    jennyShell: projectsList ? { projects: { list: async () => { listCalls.push(1); return projectsList(); } } } : {},
  };
  const controller = createShellRuntimeController({
    state,
    windowRef,
    callbacks: {
      appendClientLog: (level, event, details) => logs.push({ level, event, details }),
      focusComposer: () => { composer.focused += 1; },
      handleCreateSession: async (...args) => {
        createCalls.push(args);
        const id = `sess_created_${nextId++}`;
        const projectId = args[0] && args[0].projectId ? args[0].projectId : (state.defaultProjectForTest || 'project_general');
        state.sessions.push(emptyChat(id, { project_id: projectId, created_at: new Date(Date.UTC(2026, 8, 29, 12, nextId)).toISOString() }));
        state.currentSessionId = id;
        return id;
      },
      activateWorkspaceSession: async (id, options) => {
        activations.push({ id, options });
        state.currentSessionId = id;
        state.workspace.activeSessionId = id;
        if (!state.workspace.openSessionIds.includes(id)) state.workspace.openSessionIds.push(id);
      },
    },
  });
  return { state, controller, createCalls, activations, logs, composer, listCalls };
}

test('two bare New chat clicks create one chat: the second reuses the untouched first', async () => {
  const { controller, createCalls, activations, state } = setup();
  const first = await controller.handleCreateSessionWithWorkspace();
  const second = await controller.handleCreateSessionWithWorkspace();
  assert.equal(createCalls.length, 1);
  assert.equal(second, first);
  assert.equal(state.sessions.length, 1);
  assert.equal(activations.at(-1).id, first);
  assert.equal(activations.at(-1).options.mode, 'new-tab');
});

test('reuse activates the existing empty chat, focuses the composer and returns its id', async () => {
  const { controller, createCalls, activations, composer, logs } = setup({
    sessions: [emptyChat('sess_empty'), { ...emptyChat('sess_busy'), title: 'Real work', message_count: 4 }],
    currentSessionId: 'sess_busy',
  });
  assert.equal(await controller.handleCreateSessionWithWorkspace(), 'sess_empty');
  assert.equal(createCalls.length, 0);
  assert.deepEqual(activations.map((entry) => entry.id), ['sess_empty']);
  assert.equal(composer.focused, 1);
  assert.ok(logs.some((entry) => entry.event === 'sessions.new_chat_reused'));
});

test('an empty chat with composer draft text is not reused', async () => {
  const { controller, createCalls, state } = setup({ sessions: [emptyChat('sess_draft')] });
  state.composerSessionState.set('sess_draft', { text: 'half-typed question', attachments: [] });
  const id = await controller.handleCreateSessionWithWorkspace();
  assert.equal(createCalls.length, 1);
  assert.notEqual(id, 'sess_draft');
});

test('attachments queued in the composer of the current empty chat count as a draft', async () => {
  const { controller, createCalls, state } = setup({ sessions: [emptyChat('sess_current')], currentSessionId: 'sess_current' });
  state.attachments = { queued: [{ path: 'C:/notes.txt' }] };
  await controller.handleCreateSessionWithWorkspace();
  assert.equal(createCalls.length, 1);
});

test('the current untouched empty chat is reused in place', async () => {
  const { controller, createCalls, activations } = setup({
    sessions: [emptyChat('sess_current'), emptyChat('sess_newer', { created_at: '2026-09-29T11:00:00.000Z' })],
    currentSessionId: 'sess_current',
  });
  assert.equal(await controller.handleCreateSessionWithWorkspace(), 'sess_current');
  assert.equal(createCalls.length, 0);
  assert.equal(activations[0].id, 'sess_current');
});

test('a pinned empty chat is not reused', async () => {
  const { controller, createCalls } = setup({ sessions: [emptyChat('sess_pinned', { pinned: true })] });
  await controller.handleCreateSessionWithWorkspace();
  assert.equal(createCalls.length, 1);
});

test('an empty chat in a different project than the new chat is not reused', async () => {
  const { controller, createCalls } = setup({ sessions: [emptyChat('sess_other', { project_id: 'project_work' })] });
  await controller.handleCreateSessionWithWorkspace();
  assert.equal(createCalls.length, 1);
});

test('a create with options (initialPrompt, projectId, requireRecord) always creates and passes them through', async () => {
  const { controller, createCalls } = setup({ sessions: [emptyChat('sess_empty')] });
  await controller.handleCreateSessionWithWorkspace({ initialPrompt: 'hello' });
  await controller.handleCreateSessionWithWorkspace({ projectId: 'project_general', requireRecord: true });
  assert.equal(createCalls.length, 2);
  assert.deepEqual(createCalls[0], [{ initialPrompt: 'hello' }]);
  assert.deepEqual(createCalls[1], [{ projectId: 'project_general', requireRecord: true }]);
});

test('a chat with a non-default title is not reused', async () => {
  const { controller, createCalls } = setup({ sessions: [emptyChat('sess_named', { title: 'Tax notes' })] });
  await controller.handleCreateSessionWithWorkspace();
  assert.equal(createCalls.length, 1);
});

test('a blank stored title counts as the default, like the backend sweep', async () => {
  const { controller, createCalls } = setup({ sessions: [emptyChat('sess_blank', { title: '   ' })] });
  assert.equal(await controller.handleCreateSessionWithWorkspace(), 'sess_blank');
  assert.equal(createCalls.length, 0);
});

test('chats with messages, a live turn, a queued send, or a plugin type are not reused', async () => {
  const cases = [
    { session: emptyChat('s', { message_count: 2 }) },
    { session: emptyChat('s'), prep: (state) => state.messagesBySession.set('s', [{ id: 'm1', role: 'user' }]) },
    { session: emptyChat('s', { active_turn: { stream_id: 'x' } }) },
    { session: emptyChat('s'), prep: (state) => { state.activeStreamSessionId = 's'; } },
    { session: emptyChat('s'), prep: (state) => { state.queuedSendBySession = new Map([['s', {}]]); } },
    { session: emptyChat('s', { session_type: 'plugin', plugin_session: { id: 'p' } }) },
    { session: emptyChat('s', { archived_at: '2026-09-28T00:00:00.000Z' }) },
    { session: emptyChat('s', { composer_draft: 'persisted prompt' }) },
  ];
  for (const { session, prep } of cases) {
    const { controller, createCalls, state } = setup({ sessions: [session] });
    if (prep) prep(state);
    await controller.handleCreateSessionWithWorkspace();
    assert.equal(createCalls.length, 1, JSON.stringify(session));
  }
});

test('an empty chat open as a tab wins over a newer one that is not; ties go to the most recent', async () => {
  const tabbed = setup({
    sessions: [emptyChat('sess_tab', { created_at: '2026-09-29T09:00:00.000Z' }), emptyChat('sess_closed', { created_at: '2026-09-29T11:00:00.000Z' })],
    openSessionIds: ['sess_tab'],
  });
  assert.equal(await tabbed.controller.handleCreateSessionWithWorkspace(), 'sess_tab');
  const tie = setup({
    sessions: [emptyChat('sess_old', { created_at: '2026-09-29T09:00:00.000Z' }), emptyChat('sess_new', { created_at: '2026-09-29T11:00:00.000Z' })],
  });
  assert.equal(await tie.controller.handleCreateSessionWithWorkspace(), 'sess_new');
});

test('a failing lookup falls back to creating', async () => {
  const { controller, createCalls, state } = setup({ sessions: [emptyChat('sess_empty')] });
  Object.defineProperty(state, 'composerSessionState', { get() { throw new Error('boom'); } });
  const id = await controller.handleCreateSessionWithWorkspace();
  assert.equal(createCalls.length, 1);
  assert.notEqual(id, 'sess_empty');
});

test('with a Workspace folder open, reuse is scoped to that folder\'s project (read once, then remembered)', async () => {
  const { controller, createCalls, listCalls } = setup({
    sessions: [emptyChat('sess_general'), emptyChat('sess_ws', { project_id: 'project_ws' })],
    workspaceRoot: 'G:/code/app',
    projectsList: () => ({ ok: true, projects: [{ id: 'project_general', is_current: false }, { id: 'project_ws', is_current: true }] }),
  });
  assert.equal(await controller.handleCreateSessionWithWorkspace(), 'sess_ws');
  assert.equal(await controller.handleCreateSessionWithWorkspace(), 'sess_ws');
  assert.equal(createCalls.length, 0);
  assert.equal(listCalls.length, 1);
});

test('with a Workspace folder open and no project known for it, New chat creates', async () => {
  const unknown = setup({
    sessions: [emptyChat('sess_general')],
    workspaceRoot: 'G:/code/app',
    projectsList: () => ({ ok: true, projects: [{ id: 'project_general', is_current: false }] }),
  });
  await unknown.controller.handleCreateSessionWithWorkspace();
  assert.equal(unknown.createCalls.length, 1);
  const failing = setup({
    sessions: [emptyChat('sess_ws', { project_id: 'project_ws' })],
    workspaceRoot: 'G:/code/app',
    projectsList: () => { throw new Error('ipc down'); },
  });
  await failing.controller.handleCreateSessionWithWorkspace();
  assert.equal(failing.createCalls.length, 1);
});

test('a bare create teaches the folder\'s project, so the next bare create reuses without a list read', async () => {
  const { controller, createCalls, listCalls, state } = setup({ workspaceRoot: 'G:/code/app' });
  state.defaultProjectForTest = 'project_ws';
  const first = await controller.handleCreateSessionWithWorkspace();
  assert.equal(await controller.handleCreateSessionWithWorkspace(), first);
  assert.equal(createCalls.length, 1);
  assert.equal(listCalls.length, 0);
});

test('a local draft chat (created while another chat streams) is reused', async () => {
  const { controller, createCalls } = setup({
    sessions: [{ ...emptyChat('draft_1'), project_id: undefined, local_draft: true }],
    workspaceRoot: 'G:/code/app',
  });
  assert.equal(await controller.handleCreateSessionWithWorkspace(), 'draft_1');
  assert.equal(createCalls.length, 0);
});
