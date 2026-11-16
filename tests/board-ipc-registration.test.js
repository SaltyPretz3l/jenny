'use strict';

// new-test-file: boards.* is a new IPC surface (services/main/board-ipc-registration.js), tested like its neighbours' registrations.
// boards.* IPC: the descriptor-backed channels, the trusted-sender gate, the flag-off answer with
// nothing built or read, raw payloads reaching the service, the failure envelope, the push event,
// and the lazy desktop composition over a real profile.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { EXTRA_METHODS, METHODS, TRANSFER_METHODS, createLazyBoardExtras, createLazyBoardService, createLazyBoardTransfer, registerBoardIpc } = require('../services/main/board-ipc-registration');
const { JENNY_SHELL_BRIDGE_DESCRIPTORS, listBridgeMethodPaths } = require('../services/ipc-contract');

const CHANNELS = {
  list: 'boards:list', create: 'boards:create', get: 'boards:get', apply: 'boards:apply', undo: 'boards:undo',
  redo: 'boards:redo', rename: 'boards:rename', duplicate: 'boards:duplicate', delete: 'boards:delete', restore: 'boards:restore',
};

const FETCH = 'boards:fetch-link-title'; // not the service's: one page title through the URL guard
const SELECT = 'boards:set-selection'; // not the service's: the page's selection, for the docked chat's turns (tests/board-turn-context.test.js)
const EXTRA = [FETCH, SELECT];
// Pictures and file cards (slice B7): not the service's either.
const EXTRAS = { addAsset: 'boards:add-asset', readAsset: 'boards:read-asset', resolveFile: 'boards:resolve-file', openFile: 'boards:open-file', fileStatus: 'boards:file-status',
  listProposals: 'boards:list-proposals', decideProposal: 'boards:decide-proposal',
  pin: 'boards:pin', chatRefs: 'boards:chat-refs', // pin and chatRefs: slice C5, services/boards/board-pin.js
  revealFile: 'boards:reveal-file', setAside: 'boards:set-aside' }; // slice B11, services/boards/board-set-aside.js
// Export and import of .jennyboard files (slice B10): the transfer object shows the dialogs and does the IO.
const TRANSFER = { exportFile: 'boards:export-file', importFile: 'boards:import-file' };

function register({ allow = true, enabled = true, getService, backendService = {}, fetchLinkTitle, getExtras, getTransfer } = {}) {
  const handlers = new Map();
  const result = registerBoardIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    backendService,
    authorization: { authorize: () => allow },
    isEnabled: () => enabled,
    getService,
    ...(fetchLinkTitle ? { fetchLinkTitle } : {}),
    ...(getExtras ? { getExtras } : {}),
    ...(getTransfer ? { getTransfer } : {}),
  });
  return { handlers, result, invoke: (channel, payload) => handlers.get(channel)({ sender: {} }, payload) };
}

test('exactly the twenty-five descriptor-backed invoke channels are registered, plus the changed subscription', () => {
  const { handlers, result } = register({ getService: () => ({}) });
  const all = [...Object.values(CHANNELS), ...EXTRA, ...Object.values(EXTRAS), ...Object.values(TRANSFER)].sort();
  assert.deepEqual([...handlers.keys()].sort(), all);
  assert.deepEqual(result.channels.slice().sort(), all);
  assert.deepEqual(EXTRA_METHODS, Object.keys(EXTRAS).map((name) => `boards.${name}`));
  for (const [name, channel] of Object.entries(EXTRAS)) assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS[`boards.${name}`], { kind: 'invoke', channel });
  assert.deepEqual(TRANSFER_METHODS, Object.keys(TRANSFER).map((name) => `boards.${name}`));
  for (const [name, channel] of Object.entries(TRANSFER)) assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS[`boards.${name}`], { kind: 'invoke', channel });
  assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS['boards.fetchLinkTitle'], { kind: 'invoke', channel: FETCH });
  assert.equal(METHODS['boards.fetchLinkTitle'], undefined, 'it is not a service method');
  for (const [method, channel] of Object.entries(CHANNELS)) {
    assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS[`boards.${method}`], { kind: 'invoke', channel });
    assert.equal(METHODS[`boards.${method}`], method);
  }
  assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS['boards.onChanged'], { kind: 'subscribe', channel: 'boards:changed' });
  assert.deepEqual(
    listBridgeMethodPaths().filter((methodPath) => methodPath.startsWith('boards.')).sort(),
    [...Object.keys(CHANNELS).map((method) => `boards.${method}`), 'boards.fetchLinkTitle', 'boards.setSelection', 'boards.onChanged', ...EXTRA_METHODS, ...TRANSFER_METHODS].sort()
  );
});

test('with the flag off every channel answers disabled and the service is never built', async () => {
  let built = 0;
  const backendService = {};
  let fetched = 0;
  const { invoke } = register({ enabled: false, backendService, getService: () => { built += 1; return {}; }, fetchLinkTitle: () => { fetched += 1; return { ok: true, title: 'x' }; },
    getExtras: () => { built += 1; return {}; }, getTransfer: () => { built += 1; return {}; } });
  for (const channel of [...Object.values(CHANNELS), ...EXTRA, ...Object.values(EXTRAS), ...Object.values(TRANSFER)]) {
    assert.deepEqual(await invoke(channel, { projectId: 'project_general', url: 'https://example.com/' }), { ok: false, reason: 'disabled' });
  }
  assert.equal(built, 0);
  assert.equal(fetched, 0, 'nothing is fetched with the flag off');
  assert.equal(backendService.getBoardService(), null, 'the project delete hook sees no service');
  assert.equal(built, 0);
});

test('an untrusted sender reaches no service method', async () => {
  const calls = [];
  const service = new Proxy({}, { get: (_t, name) => (...args) => { calls.push([name, args]); return { ok: true }; } });
  let fetched = 0;
  const { invoke } = register({ allow: false, getService: () => service, fetchLinkTitle: () => { fetched += 1; return { ok: true, title: 'x' }; }, getTransfer: () => service });
  for (const channel of [...Object.values(CHANNELS), ...EXTRA, ...Object.values(TRANSFER)]) assert.equal((await invoke(channel, { boardId: 'x', url: 'https://example.com/' })).ok, false);
  assert.deepEqual(calls, []);
  assert.equal(fetched, 0);
});

test('fetchLinkTitle hands its raw request to the title fetcher and returns its answer; a throw is failed; the real fetcher refuses a non-web address without a network', async () => {
  const seen = [];
  const answers = [{ ok: true, title: 'A page' }, { ok: false, reason: 'refused' }];
  const { invoke } = register({ getService: () => ({}), fetchLinkTitle: (request) => { seen.push(request); return answers.shift(); } });
  assert.deepEqual(await invoke(FETCH, { url: 'https://example.com/' }), { ok: true, title: 'A page' });
  assert.deepEqual(await invoke(FETCH, { url: 'http://127.0.0.1/' }), { ok: false, reason: 'refused' });
  assert.deepEqual(seen, [{ url: 'https://example.com/' }, { url: 'http://127.0.0.1/' }]);
  const broken = register({ getService: () => ({}), fetchLinkTitle: () => { throw new Error('boom'); } });
  assert.deepEqual(await broken.invoke(FETCH, { url: 'https://example.com/' }), { ok: false, reason: 'failed' });
  const real = register({ getService: () => ({}) });
  assert.deepEqual(await real.invoke(FETCH, { url: 'ftp://example.com/' }), { ok: false, reason: 'invalid' });
  assert.deepEqual(await real.invoke(FETCH, undefined), { ok: false, reason: 'invalid' });
});

test('each channel hands its raw payload to the service method of the same name, and a throw becomes io', async () => {
  const calls = [];
  const service = new Proxy({}, { get: (_t, name) => async (raw) => { calls.push([name, raw]); return { ok: true, name }; } });
  const backendService = {};
  const { invoke } = register({ getService: () => service, backendService });
  for (const [method, channel] of Object.entries(CHANNELS)) {
    assert.deepEqual(await invoke(channel, { boardId: method }), { ok: true, name: method });
  }
  assert.deepEqual(calls.map(([name]) => name), Object.keys(CHANNELS));
  assert.equal(backendService.getBoardService(), service);
  const broken = register({ getService: () => ({ list: () => { throw new Error('boom'); } }) });
  assert.deepEqual(await broken.invoke(CHANNELS.list, { projectId: 'project_general' }), { ok: false, reason: 'io' });
  const missing = register({ getService: () => { throw new Error('no store'); } });
  assert.deepEqual(await missing.invoke(CHANNELS.get, { boardId: 'x' }), { ok: false, reason: 'io' });
});

test('the lazy composition builds once over <userData>/boards, reads nothing until called, and pushes boards.onChanged', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-board-ipc-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const sent = [];
  const backendService = { featureFlags: { project_boards: true }, projectService: { get: (id) => (id === 'project_general' ? { id } : null) } };
  const getService = createLazyBoardService({ app: { getPath: () => userDataPath }, backendService,
    sendBridgeEvent: (methodPath, payload) => sent.push([methodPath, payload]) });
  const handlers = new Map();
  registerBoardIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    backendService, authorization: { authorize: () => true }, getService,
  });
  assert.equal(fs.existsSync(path.join(userDataPath, 'boards')), false, 'registration reads and writes nothing');
  assert.equal(getService(), getService());
  const invoke = (channel, payload) => handlers.get(channel)({ sender: {} }, payload);
  assert.deepEqual(await invoke(CHANNELS.create, { projectId: 'project_gone', name: 'x' }), { ok: false, reason: 'not_found' });
  const made = await invoke(CHANNELS.create, { projectId: 'project_general', name: 'Plan' });
  assert.equal(made.ok, true);
  assert.equal(fs.existsSync(path.join(userDataPath, 'boards', `${made.board.id}.json`)), true);
  assert.deepEqual(sent, [['boards.onChanged', { boardId: made.board.id, projectId: 'project_general', kind: 'created', rev: 0 }]]);
  backendService.featureFlags.project_boards = false;
  assert.deepEqual(await invoke(CHANNELS.list, { projectId: 'project_general' }), { ok: false, reason: 'disabled' });
  assert.deepEqual(await getService().list({ projectId: 'project_general' }), { ok: false, reason: 'disabled' });
});

test('pictures and files: oversize bytes are refused first, then a missing or read-only board; the rest pass through', async () => {
  const calls = [];
  let gets = 0;
  let built = 0;
  const boards = { [`board_${'0'.repeat(8)}-0000-4000-8000-000000000001`]: { ok: true, board: {}, readOnly: false },
    [`board_${'0'.repeat(8)}-0000-4000-8000-000000000002`]: { ok: true, board: null, readOnly: true } };
  const [live, readOnly] = Object.keys(boards);
  const extras = {
    assets: { add: (bytes) => { calls.push(['add', bytes.byteLength]); return { ok: true, asset: 'a' }; }, read: (asset) => { calls.push(['read', asset]); return { ok: true }; } },
    files: { resolveFile: (raw) => { calls.push(['resolve', raw]); return { ok: true }; }, openFile: (raw) => { calls.push(['open', raw]); return { ok: true }; }, fileStatus: (raw) => { calls.push(['status', raw]); return { ok: true, missing: [] }; } },
    sweeper: { maybeSweep: () => calls.push(['sweep']) },
  };
  const service = { get: async ({ boardId }) => { gets += 1; return boards[boardId] || { ok: false, reason: 'not_found' }; } };
  const { invoke } = register({ getService: () => service, getExtras: () => { built += 1; return extras; } });
  const oversize = new Uint8Array(10 * 1024 * 1024 + 1);
  assert.deepEqual(await invoke(EXTRAS.addAsset, { boardId: live, bytes: oversize }), { ok: false, reason: 'too_large' });
  assert.equal(gets, 0, 'refused before the board is read');
  assert.deepEqual(calls, [['sweep']], 'nothing reached the store');
  for (const bad of [{ boardId: live, bytes: 'png' }, { boardId: live }, { boardId: 'board_x', bytes: new Uint8Array(1) }, { boardId: live, bytes: new Uint8Array(1), path: 'x' }]) {
    assert.deepEqual(await invoke(EXTRAS.addAsset, bad), { ok: false, reason: 'invalid' });
  }
  assert.deepEqual(await invoke(EXTRAS.addAsset, { boardId: `board_${'0'.repeat(8)}-0000-4000-8000-000000000009`, bytes: new Uint8Array(4) }), { ok: false, reason: 'not_found' });
  assert.deepEqual(await invoke(EXTRAS.addAsset, { boardId: readOnly, bytes: new Uint8Array(4) }), { ok: false, reason: 'read_only' });
  assert.deepEqual(await invoke(EXTRAS.addAsset, { boardId: live, bytes: new Uint8Array(4).buffer }), { ok: true, asset: 'a' });
  assert.deepEqual(await invoke(EXTRAS.readAsset, { boardId: live, asset: 'f'.repeat(64) }), { ok: true });
  assert.deepEqual(await invoke(EXTRAS.readAsset, { boardId: 'nope', asset: 'f'.repeat(64) }), { ok: false, reason: 'invalid' });
  for (const name of ['resolveFile', 'openFile', 'fileStatus']) assert.equal((await invoke(EXTRAS[name], { boardId: live, path: 'a' })).ok, true);
  assert.deepEqual(calls.filter(([name]) => name !== 'sweep'), [['add', 4], ['read', 'f'.repeat(64)],
    ['resolve', { boardId: live, path: 'a' }], ['open', { boardId: live, path: 'a' }], ['status', { boardId: live, path: 'a' }]]);
  assert.equal(calls.filter(([name]) => name === 'sweep').length, 13, 'every call with the flag on offers the sweep a turn');
  assert.ok(built > 0);

  // Proposals: the list and one decision reach the module only with a board id and no stray key; the backend hook records.
  const seen = [];
  const proposals = { list: async (raw) => { seen.push(['list', raw]); return { ok: true, proposals: [] }; }, decide: async (raw) => { seen.push(['decide', raw]); return { ok: true }; },
    record: async (raw) => { seen.push(['record', raw.boardId]); return { ok: true, proposal: null }; } };
  const backendService = {};
  const wired = register({ backendService, getService: () => service, getExtras: () => ({ ...extras, proposals }) });
  assert.deepEqual(await wired.invoke(EXTRAS.listProposals, { boardId: live }), { ok: true, proposals: [] });
  assert.deepEqual(await wired.invoke(EXTRAS.listProposals, { boardId: live, extra: 1 }), { ok: false, reason: 'invalid' });
  assert.deepEqual(await wired.invoke(EXTRAS.decideProposal, { boardId: live, proposalId: 's:m:1', action: 'accept', n: 2 }), { ok: true });
  assert.deepEqual(await wired.invoke(EXTRAS.decideProposal, { boardId: 'nope', proposalId: 's:m:1', action: 'reject' }), { ok: false, reason: 'invalid' });
  assert.deepEqual(await backendService.boardProposals.record({ boardId: live }), { ok: true, proposal: null });
  const off = {};
  register({ enabled: false, backendService: off, getService: () => service, getExtras: () => ({ ...extras, proposals }) });
  assert.deepEqual(await off.boardProposals.record({ boardId: live }), { ok: false, reason: 'disabled' });
  assert.deepEqual(seen, [['list', { boardId: live }], ['decide', { boardId: live, proposalId: 's:m:1', action: 'accept', n: 2 }], ['record', live]]);

  // A sweeper that cannot be built changes no answer.
  const noExtras = register({ getService: () => ({ list: async () => ({ ok: true, boards: [] }) }), getExtras: () => { throw new Error('no profile'); } });
  assert.deepEqual(await noExtras.invoke(CHANNELS.list, { projectId: 'project_general' }), { ok: true, boards: [] });
  const denied = register({ allow: false, getService: () => service, getExtras: () => extras });
  calls.length = 0;
  for (const channel of Object.values(EXTRAS)) assert.equal((await denied.invoke(channel, { boardId: live, bytes: new Uint8Array(1) })).ok, false);
  assert.deepEqual(calls, [], 'an untrusted sender reaches nothing');
});

test('the lazy extras store a picture under <userData>/board-assets and take the folder from the project authority', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-board-ipc-extras-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const folder = path.join(userDataPath, 'project');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'notes.md'), '# n\n');
  const captured = [];
  const backendService = {
    featureFlags: { project_boards: true }, projectService: { get: (id) => ({ id }) },
    projectAuthority: { captureProject: (id) => { captured.push(id); return { project_id: id, root_path: folder }; } },
  };
  const app = { getPath: () => userDataPath };
  const getService = createLazyBoardService({ app, backendService });
  const getExtras = createLazyBoardExtras({ app, backendService, getService });
  const handlers = new Map();
  registerBoardIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, { app, backendService, authorization: { authorize: () => true }, getService, getExtras });
  const invoke = (channel, payload) => handlers.get(channel)({ sender: {} }, payload);
  const board = (await invoke(CHANNELS.create, { projectId: 'project_alpha', name: 'Plan' })).board;
  const gif = Buffer.from('474946383961020003008000000000ffffff2c000000000100010000020244010003b', 'hex');
  const added = await invoke(EXTRAS.addAsset, { boardId: board.id, bytes: new Uint8Array(gif) });
  assert.deepEqual([added.ok, added.ext, added.width, added.height], [true, 'gif', 2, 3]);
  assert.equal(fs.existsSync(path.join(userDataPath, 'board-assets', `${added.asset}.gif`)), true);
  const read = await invoke(EXTRAS.readAsset, { boardId: board.id, asset: added.asset });
  assert.deepEqual([read.ok, read.mime, Buffer.compare(Buffer.from(read.bytes), gif)], [true, 'image/gif', 0]);
  assert.deepEqual(await invoke(EXTRAS.resolveFile, { boardId: board.id, path: path.join(folder, 'notes.md') }), { ok: true, path: 'notes.md', title: 'notes.md' });
  // Pin to board (slice C5): a note and a file through the real extras, then the chat's own cards.
  const pinned = await invoke(EXTRAS.pin, { boardId: board.id, item: { kind: 'note', text: 'From a chat' } });
  assert.deepEqual([pinned.ok, pinned.boardId, pinned.boardName], [true, board.id, 'Plan']);
  assert.equal((await invoke(EXTRAS.pin, { boardId: board.id, item: { kind: 'file', path: 'notes.md' } })).ok, true);
  assert.equal((await invoke(EXTRAS.pin, { boardId: board.id, item: { kind: 'chat', sessionId: 's1', messageId: 'm1', title: 'T', excerpt: 'E' } })).ok, true);
  assert.deepEqual((await invoke(EXTRAS.chatRefs, { projectId: 'project_alpha', sessionId: 's1' })).refs.map((ref) => [ref.messageId, ref.boardId]), [['m1', board.id]]);
  assert.deepEqual(await invoke(EXTRAS.pin, { boardId: board.id, item: { kind: 'image', ref: { kind: 'attachment', id: 'a', sessionId: 's1' } } }), { ok: false, reason: 'unavailable' });
  assert.deepEqual(captured, ['project_alpha', 'project_alpha'], 'the resolveFile call and the file pin each took the folder from the authority');
  assert.equal(getService().redoInverses().length, 0);
  await new Promise((resolve) => setImmediate(resolve)); // the sweep's turn, after the answers
  backendService.featureFlags.project_boards = false;
  assert.deepEqual(await invoke(EXTRAS.readAsset, { boardId: board.id, asset: added.asset }), { ok: false, reason: 'disabled' });
});

test('export and import: the request is checked, then handed to the transfer object, which is built once on first use', async (t) => {
  const calls = [];
  let built = 0;
  const transfer = {
    exportFile: async (request) => { calls.push(['export', request]); return { ok: true, name: 'Plan.jennyboard' }; },
    importFile: async (request) => { calls.push(['import', request]); return { ok: false, reason: 'cancelled' }; },
  };
  const { invoke } = register({ getService: () => ({}), getExtras: () => ({ sweeper: { maybeSweep() {} } }), getTransfer: () => { built += 1; return transfer; } });
  const boardId = `board_${'0'.repeat(8)}-0000-4000-8000-000000000001`;
  assert.deepEqual(await invoke(TRANSFER.exportFile, { boardId }), { ok: true, name: 'Plan.jennyboard' });
  assert.deepEqual(await invoke(TRANSFER.importFile, { projectId: 'project_alpha' }), { ok: false, reason: 'cancelled' });
  for (const bad of [{ boardId, path: 'C:/x.jennyboard' }, { boardId: 'board_x' }, undefined, [], { projectId: 'project_alpha' }]) {
    assert.deepEqual(await invoke(TRANSFER.exportFile, bad), { ok: false, reason: 'invalid' });
  }
  for (const bad of [{ projectId: 'project_alpha', text: '{}' }, { projectId: '../x' }, null, { boardId }]) {
    assert.deepEqual(await invoke(TRANSFER.importFile, bad), { ok: false, reason: 'invalid' });
  }
  assert.deepEqual(calls, [['export', { boardId }], ['import', { projectId: 'project_alpha' }]]);
  assert.ok(built >= 1);

  // The lazy composition over a real profile, with an injected dialog: nothing is built until the first call.
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-board-ipc-transfer-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const app = { getPath: () => userDataPath };
  const backendService = { featureFlags: { project_boards: true }, projectService: { get: (id) => ({ id }) } };
  const getService = createLazyBoardService({ app, backendService });
  const getExtras = createLazyBoardExtras({ app, backendService, getService });
  const dialogs = [];
  const dialog = { showSaveDialog: async (o) => { dialogs.push(o); return { canceled: true }; }, showOpenDialog: async (o) => { dialogs.push(o); return { canceled: true, filePaths: [] }; } };
  const getTransfer = createLazyBoardTransfer({ app, getService, getExtras, dialog });
  assert.equal(getTransfer(), getTransfer());
  const handlers = new Map();
  registerBoardIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, { app, backendService, authorization: { authorize: () => true }, getService, getExtras, getTransfer });
  const call = (channel, payload) => handlers.get(channel)({ sender: {} }, payload);
  const board = (await call(CHANNELS.create, { projectId: 'project_alpha', name: 'Plan' })).board;
  assert.deepEqual(await call(TRANSFER.exportFile, { boardId: board.id }), { ok: false, reason: 'cancelled' });
  assert.deepEqual(await call(TRANSFER.importFile, { projectId: 'project_alpha' }), { ok: false, reason: 'cancelled' });
  assert.equal(dialogs.length, 2);
  backendService.featureFlags.project_boards = false;
  assert.deepEqual(await call(TRANSFER.importFile, { projectId: 'project_alpha' }), { ok: false, reason: 'disabled' });
  assert.equal(dialogs.length, 2, 'no dialog with the flag off');
  await new Promise((resolve) => setImmediate(resolve));
});

test('pin and chatRefs hand their raw request to the extras pins; a throw becomes io and the flag-off answer comes first', async () => {
  const seen = [];
  const pins = { pin: async (raw) => { seen.push(['pin', raw]); return { ok: true, cardId: 'c' }; }, chatRefs: async (raw) => { seen.push(['refs', raw]); return { ok: true, refs: [] }; } };
  const { invoke } = register({ getService: () => ({}), getExtras: () => ({ pins, sweeper: { maybeSweep() {} } }) });
  assert.deepEqual(await invoke(EXTRAS.pin, { boardId: 'b', item: { kind: 'note', text: 'x' } }), { ok: true, cardId: 'c' });
  assert.deepEqual(await invoke(EXTRAS.chatRefs, { projectId: 'p', sessionId: 's' }), { ok: true, refs: [] });
  assert.deepEqual(seen, [['pin', { boardId: 'b', item: { kind: 'note', text: 'x' } }], ['refs', { projectId: 'p', sessionId: 's' }]]);
  const broken = register({ getService: () => ({}), getExtras: () => ({ pins: { pin: () => { throw new Error('boom'); } }, sweeper: { maybeSweep() {} } }) });
  assert.deepEqual(await broken.invoke(EXTRAS.pin, {}), { ok: false, reason: 'io' });
  const off = register({ enabled: false, getService: () => ({}), getExtras: () => { throw new Error('never built'); } });
  assert.deepEqual(await off.invoke(EXTRAS.pin, {}), { ok: false, reason: 'disabled' });
  assert.deepEqual(await off.invoke(EXTRAS.chatRefs, {}), { ok: false, reason: 'disabled' });
});

test('revealFile and setAside take exactly { boardId }, reach the extras with that id only, and work over a real profile', async (t) => {
  const seen = [];
  const setAside = { reveal: async (raw) => { seen.push(['reveal', raw]); return { ok: true }; }, setAside: async (raw) => { seen.push(['aside', raw]); return { ok: true, movedTo: 'x' }; } };
  const { invoke } = register({ getService: () => ({}), getExtras: () => ({ setAside, sweeper: { maybeSweep() {} } }) });
  const boardId = `board_${'0'.repeat(8)}-0000-4000-8000-000000000001`;
  assert.deepEqual(await invoke(EXTRAS.revealFile, { boardId }), { ok: true });
  assert.deepEqual(await invoke(EXTRAS.setAside, { boardId }), { ok: true, movedTo: 'x' });
  for (const bad of [{ boardId, path: 'C:/Windows' }, { boardId, root: '/' }, { boardId: 'board_x' }, undefined, [], { file: 'index.json' }]) {
    assert.deepEqual(await invoke(EXTRAS.revealFile, bad), { ok: false, reason: 'invalid' });
    assert.deepEqual(await invoke(EXTRAS.setAside, bad), { ok: false, reason: 'invalid' });
  }
  assert.deepEqual(seen, [['reveal', { boardId }], ['aside', { boardId }]]);

  // The lazy composition: a damaged board is shown through the injected revealPath, then set aside, and the page hears of it.
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-board-ipc-aside-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const app = { getPath: () => userDataPath };
  const sent = [];
  const revealed = [];
  const backendService = { featureFlags: { project_boards: true }, projectService: { get: (id) => ({ id }) } };
  const getService = createLazyBoardService({ app, backendService, sendBridgeEvent: (name, payload) => sent.push([name, payload.kind]) });
  const getExtras = createLazyBoardExtras({ app, backendService, getService, revealPath: (filePath) => revealed.push(filePath) });
  const handlers = new Map();
  registerBoardIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, { app, backendService, authorization: { authorize: () => true }, getService, getExtras });
  const call = (channel, payload) => handlers.get(channel)({ sender: {} }, payload);
  const board = (await call(CHANNELS.create, { projectId: 'project_alpha', name: 'Plan' })).board;
  assert.deepEqual(await call(EXTRAS.revealFile, { boardId: board.id }), { ok: false, reason: 'not_read_only' });
  assert.deepEqual(await call(EXTRAS.setAside, { boardId: board.id }), { ok: false, reason: 'not_read_only' });
  const file = path.join(userDataPath, 'boards', `${board.id}.json`);
  fs.writeFileSync(file, 'not json');
  const fresh = createLazyBoardService({ app, backendService, sendBridgeEvent: (name, payload) => sent.push([name, payload.kind]) });
  const freshExtras = createLazyBoardExtras({ app, backendService, getService: fresh, revealPath: (filePath) => revealed.push(filePath) });
  const again = new Map();
  registerBoardIpc({ handle: (channel, fn) => again.set(channel, fn) }, { app, backendService, authorization: { authorize: () => true }, getService: fresh, getExtras: freshExtras });
  const call2 = (channel, payload) => again.get(channel)({ sender: {} }, payload);
  assert.deepEqual(await call2(EXTRAS.revealFile, { boardId: board.id }), { ok: true });
  assert.deepEqual(revealed, [file]);
  const moved = await call2(EXTRAS.setAside, { boardId: board.id });
  assert.equal(moved.ok, true);
  assert.match(moved.movedTo, new RegExp(`^${board.id}\\.json\\.aside-\\d+$`));
  assert.equal(fs.existsSync(path.join(userDataPath, 'boards', moved.movedTo)), true);
  assert.deepEqual((await call2(CHANNELS.list, { projectId: 'project_alpha' })).boards, []);
  assert.deepEqual(sent.at(-1), ['boards.onChanged', 'deleted']);
  backendService.featureFlags.project_boards = false;
  assert.deepEqual(await call2(EXTRAS.setAside, { boardId: board.id }), { ok: false, reason: 'disabled' });
  assert.deepEqual(await call2(EXTRAS.revealFile, { boardId: board.id }), { ok: false, reason: 'disabled' });
  await new Promise((resolve) => setImmediate(resolve)); // the sweep's turn, after the answers
});
