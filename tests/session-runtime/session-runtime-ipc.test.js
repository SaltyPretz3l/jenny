'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createJennyShellBridge,
  getBridgeChannel,
} = require('../../services/ipc-contract');
const {
  registerSessionRuntimeIpcHandlers,
} = require('../../services/main/session-runtime-ipc-registration');

const METHOD_PATHS = [
  'projects.list',
  'projects.create',
  'projects.rename',
  'projects.bindRoot',
  'projects.assignSession',
  'projects.adoptWorkspace',
  'projects.delete',
  'projects.chooseRoot',
  'projects.revealFolder',
  'permissionReview.getState',
  'permissionReview.resolve',
];

test('preload contract exposes the closed project and permission-review invoke surface', async () => {
  const calls = [];
  const bridge = createJennyShellBridge({
    ipcRenderer: {
      invoke(channel, ...args) { calls.push([channel, ...args]); return Promise.resolve({ ok: true }); },
      send() {},
    },
  });
  await bridge.projects.list();
  await bridge.projects.create({ name: 'Alpha' });
  await bridge.projects.rename({ project_id: 'project_alpha', name: 'Beta' });
  await bridge.projects.bindRoot({
    project_id: 'project_alpha', root_path: 'G:\\workspace', expected_root_revision: 1,
  });
  await bridge.projects.assignSession({ session_id: 'sess_one', project_id: 'project_alpha' });
  await bridge.projects.adoptWorkspace({ session_id: 'sess_one' });
  await bridge.projects.delete({ project_id: 'project_alpha' });
  await bridge.projects.chooseRoot({ project_id: 'project_alpha', expected_root_revision: 1 });
  await bridge.projects.revealFolder({ project_id: 'project_alpha' });
  await bridge.permissionReview.getState();
  await bridge.permissionReview.resolve({ review_id: 'review_one', decision: 'dismiss' });

  assert.deepEqual(calls.map(([channel]) => channel), METHOD_PATHS.map((path) => getBridgeChannel(path)));
  assert.deepEqual(calls[3][1], {
    project_id: 'project_alpha', root_path: 'G:\\workspace', expected_root_revision: 1,
  });
});

test('desktop registration forwards snake-case payloads and denies untrusted senders', async () => {
  const handlers = new Map();
  const calls = [];
  const applicationService = {
    listProjects: () => ({ projects: [] }),
    createProject: (payload) => { calls.push(['create', payload]); return { ok: true }; },
    renameProject: (payload) => { calls.push(['rename', payload]); return { ok: true }; },
    bindProjectRoot: (payload) => { calls.push(['bind', payload]); return { ok: true }; },
    assignSessionProject: (payload) => { calls.push(['assign', payload]); return { ok: true }; },
    adoptWorkspaceSession: (payload) => { calls.push(['adopt', payload]); return { ok: true }; },
    deleteProject: (payload) => { calls.push(['delete', payload]); return { ok: true }; },
    chooseProjectRoot: (payload) => { calls.push(['choose', payload]); return { ok: true }; },
    revealProjectFolder: (payload) => { calls.push(['reveal', payload]); return { ok: true }; },
    getPermissionReviewState: () => ({ pending_count: 0, pending: [], history: [] }),
    resolvePermissionReview: (payload) => { calls.push(['resolve', payload]); return { ok: true }; },
  };
  const channels = registerSessionRuntimeIpcHandlers({
    handle(channel, handler) { handlers.set(channel, handler); },
  }, {
    applicationService,
    authorization: {
      authorize: (event) => event?.trusted === true,
      unauthorizedResult: () => ({ ok: false, authorized: false, code: 'ipc_sender_unauthorized' }),
    },
  });
  assert.deepEqual(channels, METHOD_PATHS.map((path) => getBridgeChannel(path)));

  const create = handlers.get(getBridgeChannel('projects.create'));
  assert.equal((await create({ trusted: false }, { name: 'Blocked' })).authorized, false);
  assert.equal(calls.length, 0);
  const payload = { name: 'Alpha' };
  assert.deepEqual(await create({ trusted: true }, payload), { ok: true });
  assert.deepEqual(calls, [['create', payload]]);
});

test('runtime inspection uses the trusted invoke bridge and preserves closed snake-case payloads', async () => {
  const handlers = new Map();
  const calls = [];
  const result = { ok: true, schema_version: 1, items: [], next_cursor: null };
  registerSessionRuntimeIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    applicationService: {},
    runtimeApplicationService: {
      getSnapshot: payload => { calls.push(['snapshot', payload]); return result; },
      getWork: payload => { calls.push(['work', payload]); return result; },
    },
    authorization: {
      authorize: event => event?.trusted === true,
      unauthorizedResult: () => ({ ok: false, reason: 'ipc_sender_unauthorized' }),
    },
  });
  let trusted = false;
  const bridge = createJennyShellBridge({ ipcRenderer: {
    invoke: (channel, ...args) => handlers.get(channel)({ trusted }, ...args),
    send() {},
  } });
  const snapshot = { project_id: 'project_one', limit: 10, cursor: null };
  assert.equal((await bridge.sessionRuntime.getSnapshot(snapshot)).ok, false);
  assert.equal((await bridge.sessionRuntime.getWork({ work_id: 'work_one' })).ok, false);
  assert.deepEqual(calls, []);
  trusted = true;
  assert.deepEqual(await bridge.sessionRuntime.getSnapshot(snapshot), result);
  assert.deepEqual(await bridge.sessionRuntime.getWork({ work_id: 'work_one' }), result);
  assert.deepEqual(calls, [['snapshot', snapshot], ['work', { work_id: 'work_one' }]]);
  assert.deepEqual(Object.keys(bridge.sessionRuntime).sort(), ['cancel', 'getResult', 'getSnapshot', 'getWork', 'pause', 'resume', 'start', 'submit', 'updateLimits', 'updatePending']);
});


test('submit and resume cross only the trusted desktop invoke boundary', async () => {
  const handlers = new Map();
  const calls = [];
  registerSessionRuntimeIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    applicationService: {}, runtimeApplicationService: {
      submit: payload => { calls.push(['submit', payload]); return { ok: true, work_id: 'work_1' }; },
      resume: payload => { calls.push(['resume', payload]); return { ok: true, work_id: 'work_1' }; },
      pause: payload => { calls.push(['pause', payload]); return { ok: true, status: 'requested' }; },
    }, authorization: { authorize: event => event.trusted,
      unauthorizedResult: () => ({ ok: false, reason: 'ipc_sender_unauthorized' }) },
  });
  let trusted = false;
  const bridge = createJennyShellBridge({ ipcRenderer: {
    invoke: (channel, ...args) => handlers.get(channel)({ trusted }, ...args), send() {},
  } });
  const submit = { session_id: 'session_1', idempotency_key: 'key_1', prompt: 'hello' };
  const resume = { work_id: 'work_1', expected_revision: 2 };
  assert.equal((await bridge.sessionRuntime.submit(submit)).ok, false);
  assert.equal((await bridge.sessionRuntime.resume(resume)).ok, false);
  assert.equal((await bridge.sessionRuntime.pause(resume)).ok, false);
  assert.deepEqual(calls, []);
  trusted = true;
  assert.equal((await bridge.sessionRuntime.submit(submit)).ok, true);
  assert.equal((await bridge.sessionRuntime.resume(resume)).ok, true);
  assert.equal((await bridge.sessionRuntime.pause(resume)).status, 'requested');
  assert.deepEqual(calls, [['submit', submit], ['resume', resume], ['pause', resume]]);
});


test('projects.chooseRoot opens the folder picker in main and hands the application only the id payload', async () => {
  const handlers = new Map();
  const received = [];
  const dialogCalls = [];
  const owner = { id: 'main-window' };
  registerSessionRuntimeIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    applicationService: {
      listProjects: () => ({ ok: true, projects: [] }),
      async chooseProjectRoot(payload, { pickFolder }) {
        received.push(payload);
        return { ok: true, picked: await pickFolder({ defaultPath: 'D:/Projects' }) };
      },
    },
    dialog: {
      showOpenDialog: async (window, options) => {
        dialogCalls.push([window, options]);
        return { canceled: false, filePaths: ['D:/Projects/Ascend'] };
      },
    },
    getMainWindow: () => owner,
    authorization: {
      authorize: (event) => event?.trusted === true,
      unauthorizedResult: () => ({ ok: false, authorized: false, code: 'ipc_sender_unauthorized' }),
    },
  });
  const choose = handlers.get(getBridgeChannel('projects.chooseRoot'));
  assert.equal(getBridgeChannel('projects.chooseRoot'), 'projects:choose-root');
  const payload = { project_id: 'project_alpha', expected_root_revision: 2 };
  assert.equal((await choose({ trusted: false }, payload)).authorized, false);
  assert.deepEqual(received, [], 'an untrusted sender never reaches the picker');
  const result = await choose({ trusted: true }, payload);
  assert.deepEqual(received, [payload]);
  assert.deepEqual(result.picked, { canceled: false, path: 'D:/Projects/Ascend' });
  assert.equal(dialogCalls.length, 1);
  assert.equal(dialogCalls[0][0], owner);
  assert.deepEqual(dialogCalls[0][1].properties, ['openDirectory']);
  assert.equal(dialogCalls[0][1].defaultPath, 'D:/Projects');
  assert.equal(typeof dialogCalls[0][1].title, 'string');
});

test('projects.list prefers the status-bearing async list when the application offers it', async () => {
  const handlers = new Map();
  registerSessionRuntimeIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    applicationService: {
      listProjects: () => ({ ok: true, projects: [], sync: true }),
      listProjectsWithStatus: async () => ({ ok: true, projects: [], status: true }),
    },
    authorization: { authorize: () => true, unauthorizedResult: () => ({ ok: false }) },
  });
  const list = handlers.get(getBridgeChannel('projects.list'));
  assert.deepEqual(await list({}, undefined), { ok: true, projects: [], status: true });
});
