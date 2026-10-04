'use strict';

// CMC-1: the skills catalog a chat sees (getState, the `/` picker, the
// request-time invocation check) follows THAT chat's bound project root, not
// the open Workspace; a chat without a project gets no project skills; and an
// unavailable invocation surfaces a named refusal instead of failing silently.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SkillsService } = require('../services/skills-service');
const { resolveSkillsAuthority } = require('../services/skills-project-scope');
const { getBridgeChannel } = require('../services/ipc-contract');
const { registerGuidanceIpcHandlers } = require('../services/main/ipc-handler-registration');
const { startLocalEngineChatStream } = require('../services/backend/local-engine-requests');
const { RuntimeApplicationService } = require('../services/session-runtime/application-service');
const { describeRuntimeRefusal } = require('../renderer/chat/renderer-runtime-refusals');
const { createSlashCommandRegistry } = require('../renderer/shell/renderer-slash-command-registry');
const { createSendSlashDispatch } = require('../renderer/chat/renderer-skill-slash-commands');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-chat-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeSkill(projectRoot, name) {
  const dir = path.join(projectRoot, '.jenny', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\nBody.\n`, 'utf8');
}

function fixture(t) {
  const root = tempRoot(t);
  const sandbox = path.join(root, 'sandbox');
  const proj2 = path.join(root, 'proj2');
  writeSkill(sandbox, 'sandbox-falcon');
  writeSkill(proj2, 'proj2-heron');
  const service = new SkillsService({
    configService: { getState: () => ({ toolsWorkspaceRoot: sandbox,
      skills: { projectEnabled: true, userEnabled: false, bundledEnabled: false } }) },
    bundledRoot: path.join(root, 'bundled'), homedir: () => root,
    featureEnabled: true, watchIntervalMs: 0,
  });
  t.after(() => service.dispose());
  const authorities = {
    project_sandbox: { project_id: 'project_sandbox', root_path: sandbox },
    project_proj2: { project_id: 'project_proj2', root_path: proj2 },
    project_general: { project_id: 'project_general', root_path: null },
  };
  const sessions = { s_sandbox: 'project_sandbox', s_proj2: 'project_proj2', s_general: 'project_general' };
  const projectAuthority = {
    captureProject(id = 'project_general') {
      if (!authorities[id]) throw Object.assign(new Error('Project was not found.'), { reason: 'project_not_found' });
      return authorities[id];
    },
    captureSession(id) {
      if (!sessions[id]) throw Object.assign(new Error('Session was not found.'), { reason: 'session_not_found' });
      return authorities[sessions[id]];
    },
    requireCurrent: (authority) => authority,
  };
  return { service, projectAuthority, sandbox, proj2 };
}

const projectIds = (state) => state.scopes.find((scope) => scope.scope === 'project').entries.map((entry) => entry.id);

test('getState scopes project skills to the given authority and leaves the unscoped Workspace view alone', (t) => {
  const { service, projectAuthority } = fixture(t);
  assert.deepEqual(projectIds(service.getState()), ['project/sandbox-falcon']);
  const proj2 = service.getState({ authority: projectAuthority.captureSession('s_proj2') });
  assert.deepEqual(projectIds(proj2), ['project/proj2-heron']);
  assert.deepEqual(proj2.entries.map((entry) => entry.id), ['project/proj2-heron']);
  assert.equal(proj2.counts.total, 1);
  const general = service.getState({ authority: projectAuthority.captureSession('s_general') });
  assert.deepEqual(projectIds(general), []);
  assert.equal(general.scopes.find((scope) => scope.scope === 'project').status, 'blocked');
  assert.deepEqual(projectIds(service.getState()), ['project/sandbox-falcon']);
  assert.throws(() => service.getState({ authority: { project_id: 'project_x', root_path: 'relative' } }),
    /Invalid project authority/);
});

test('resolveSkillsAuthority prefers the bound session, falls back to a draft project, else General', (t) => {
  const { projectAuthority, proj2 } = fixture(t);
  assert.equal(resolveSkillsAuthority(projectAuthority, { sessionId: 's_proj2', projectId: 'project_sandbox' }).root_path, proj2);
  assert.equal(resolveSkillsAuthority(projectAuthority, { sessionId: 'draft_1', projectId: 'project_proj2' }).root_path, proj2);
  assert.equal(resolveSkillsAuthority(projectAuthority, { sessionId: 'draft_1' }).root_path, null);
  assert.equal(resolveSkillsAuthority(projectAuthority, {}).root_path, null);
  assert.equal(resolveSkillsAuthority(projectAuthority, { projectId: 'project_missing' }).root_path, null);
  assert.equal(resolveSkillsAuthority(null, { sessionId: 's_proj2' }).root_path, null);
});

test('skills.getState IPC resolves the chat project from the session, never the open Workspace', async (t) => {
  const { service, projectAuthority } = fixture(t);
  const handlers = new Map();
  registerGuidanceIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) },
    service, { projectAuthority });
  const getState = handlers.get(getBridgeChannel('skills.getState', 'invoke'));
  assert.deepEqual(projectIds(await getState({}, { session_id: 's_proj2' })), ['project/proj2-heron']);
  assert.deepEqual(projectIds(await getState({}, { session_id: 's_general' })), []);
  assert.deepEqual(projectIds(await getState({}, {})), []);
  assert.deepEqual(projectIds(await getState({})), ['project/sandbox-falcon'], 'Settings keeps the Workspace view');
  await assert.rejects(async () => getState({}, { session_id: 42 }), /Invalid skills scope/);
});

test('the request-time invocation check uses the chat authority and refuses another project skill', async (t) => {
  const { service, projectAuthority } = fixture(t);
  const calls = [];
  const session = { id: 's_proj2', active_turn: null };
  const backend = {
    sessionStore: {
      getSession: () => session, getSessionSummary: () => session, getSessionMessages: () => [],
      getActiveTurn: () => session.active_turn,
      setTurnIdentity(_id, identity) { Object.assign(session, identity); return session; },
      setActiveTurn(_id, activeTurn) { session.active_turn = activeTurn; return session; },
      clearActiveTurn() { const prior = session.active_turn; session.active_turn = null; return prior ? session : null; },
      flushSession: () => true,
    },
    activeStreams: new Map(), skillsService: service, projectAuthority,
    _startManagedSidecarChatStream: (args) => { calls.push(args); return 'STREAM'; },
  };
  const base = { sessionId: 's_proj2', prompt: 'p', visiblePrompt: 'p', traceId: 't', attachments: [] };
  await assert.rejects(
    () => startLocalEngineChatStream(backend, { ...base, skillInvocation: { id: 'project/sandbox-falcon' } }),
    (error) => error?.code === 'SKILL_NOT_AVAILABLE' && error?.reason === 'skill_unknown');
  assert.equal(calls.length, 0);
  await startLocalEngineChatStream(backend, { ...base, skillInvocation: { id: 'project/proj2-heron' } });
  assert.equal(calls[0].skillInvocation.id, 'project/proj2-heron');
});

test('an unavailable skill reaches the composer as a named refusal, not the generic one', async () => {
  const runtime = { store: {}, submit: async () => {
    throw Object.assign(new Error('Skill invocation is not available.'),
      { code: 'SKILL_NOT_AVAILABLE', reason: 'skill_unknown', submissionOutcome: 'rejected' });
  } };
  const result = await new RuntimeApplicationService({ getRuntime: () => runtime }).submit({
    session_id: 'session_1', idempotency_key: 'durable_1', prompt: 'hello',
  });
  assert.equal(result.acceptance, 'rejected');
  assert.equal(result.error.reason, 'skill_not_available');
  const described = describeRuntimeRefusal(result);
  assert.equal(described.reason, 'skill_not_available');
  assert.match(described.hint, /skill/i);
});

test('the slash picker asks for the focused chat scope and refetches when the chat changes', async () => {
  const state = { currentSessionId: 's_sandbox', ui: {}, composerSessionState: new Map(),
    sessions: [{ id: 's_sandbox', project_id: 'project_sandbox' }, { id: 's_proj2', project_id: 'project_proj2' },
      { id: 'draft_9', project_id: 'project_proj2' }] };
  const catalogs = {
    s_sandbox: 'sandbox-falcon', s_proj2: 'proj2-heron',
  };
  const requests = [];
  const listeners = [];
  const getSkillsState = async (scope) => {
    requests.push(scope);
    const command = catalogs[scope?.session_id];
    return { scopes: [{ scope: 'project', enabled: true, entries: command
      ? [{ id: `project/${command}`, name: command, command, enabled: true }] : [] }] };
  };
  const registry = createSlashCommandRegistry({ state });
  const dispatch = createSendSlashDispatch({
    state, registry, chatInput: { value: '' }, getSkillsState,
    onSkillsChanged: (listener) => { listeners.push(listener); return () => {}; },
  });
  const names = () => registry.listCommands().map((row) => row.name);
  await dispatch.refreshSkills();
  assert.deepEqual(requests.at(-1), { session_id: 's_sandbox', project_id: 'project_sandbox' });
  assert.deepEqual(names(), ['/sandbox-falcon']);

  state.currentSessionId = 's_proj2';
  const result = await dispatch.dispatch('/proj2-heron do it', {});
  assert.deepEqual(requests.at(-1), { session_id: 's_proj2', project_id: 'project_proj2' });
  assert.deepEqual(names(), ['/proj2-heron']);
  assert.equal(result.settings.skillInvocation?.id, 'project/proj2-heron');

  // A pushed snapshot is the open Workspace's view: refetch the chat's own scope instead.
  listeners[0]({ scopes: [{ scope: 'project', enabled: true,
    entries: [{ id: 'project/sandbox-falcon', name: 'x', command: 'sandbox-falcon', enabled: true }] }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(names(), ['/proj2-heron']);

  state.currentSessionId = '';
  await dispatch.dispatch('/anything', {});
  assert.deepEqual(requests.at(-1), {});
  assert.deepEqual(names(), []);
  dispatch.dispose();
});

test('pane 0 wiring: re-binding the CURRENT chat to another project refetches on composer focus and on "/"', async () => {
  const { createPaneSessionContext } = require('../renderer/chat/renderer-pane-session-context');
  const { EventEmitter } = require('node:events');
  // The renderer summary can still name the old project (assignSession made
  // elsewhere); main resolves the canonical binding on every request.
  const state = { currentSessionId: 'sess_live', ui: {}, composerSessionState: new Map(),
    sessions: [{ id: 'sess_live', project_id: 'project_sandbox' }] };
  const binding = { sess_live: 'sandbox-falcon' };
  const requests = [];
  const getSkillsState = async (scope) => {
    requests.push(scope);
    const command = binding[scope?.session_id];
    return { scopes: [{ scope: 'project', enabled: true, entries: command
      ? [{ id: `project/${command}`, name: command, command, enabled: true }] : [] }] };
  };
  const input = new EventEmitter();
  input.value = '';
  input.addEventListener = (name, fn) => input.on(name, fn);
  input.removeEventListener = (name, fn) => input.off(name, fn);
  const registry = createSlashCommandRegistry({ state });
  let clock = 1000;
  const dispatch = createSendSlashDispatch({
    state, sessionContext: createPaneSessionContext({ state, paneId: 0 }), registry, chatInput: input,
    getSkillsState, now: () => clock,
  });
  const names = () => registry.listCommands().map((row) => row.name);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await settle();
  assert.deepEqual(names(), ['/sandbox-falcon']);
  assert.deepEqual(requests.at(-1), { session_id: 'sess_live', project_id: 'project_sandbox' });

  binding.sess_live = 'proj2-heron'; // projects.assignSession on the same session id
  clock += 5000;
  input.emit('focus', { type: 'focus' });
  await settle();
  assert.deepEqual(names(), ['/proj2-heron'], 'focus re-reads the chat catalog');

  binding.sess_live = 'sandbox-falcon';
  clock += 5000;
  input.value = '/';
  input.emit('input', { type: 'input' });
  await settle();
  assert.deepEqual(names(), ['/sandbox-falcon'], 'opening the "/" menu re-reads the chat catalog');

  const fetches = requests.length;
  input.value = '/s';
  input.emit('input', { type: 'input' });
  input.emit('focus', { type: 'focus' });
  await settle();
  assert.equal(requests.length, fetches, 'a burst inside the freshness window does not refetch');

  binding.sess_live = 'proj2-heron';
  clock += 5000;
  const sent = await dispatch.dispatch('/proj2-heron go', {});
  assert.equal(sent.settings.skillInvocation?.id, 'project/proj2-heron', 'send re-reads a stale catalog');
  dispatch.dispose();
});
