'use strict';

// boards.* IPC (row 150, plan PROJECT_BOARD_2026-11-13 section 6.4): the project board API of
// services/boards/board-service.js behind the trusted-sender authorizer, and its push event
// boards.onChanged. The renderer sends ids and batches, never a path and never a whole document.
//
// The handlers are always registered so every call resolves: with the `project_boards` flag off
// each one answers { ok: false, reason: 'disabled' } and nothing is constructed or read. With it on,
// the store and the service are built on the first boards call (or the first project delete that
// needs them, D13) and the first call reads the disk. Desktop only: the hosted host registers nothing.
//
// boards.fetchLinkTitle is the one call that is not the service's: it reads no board and writes none, it asks
// services/boards/board-link-title.js for one web page's title (through the URL guard) and answers
// { ok: true, title } or { ok: false, reason }. It is loaded on its first call.
//
// Pictures and files (slice B7) are not the service's either, and are built on their first call with the flag on:
// boards.addAsset / readAsset over services/boards/board-assets.js (<userData>/board-assets), boards.resolveFile /
// openFile / fileStatus over services/boards/board-files.js (the folder from the project authority's record of the
// board's project, never from the renderer). addAsset refuses oversize bytes first, then a board that does not exist
// or is read-only. After any boards call with the flag on, the picture sweep (board-asset-sweep.js) is offered a
// turn: once at the first call, then at most once a day, after the call has its answer.
//
// Export and import of .jennyboard files (slice B10) are services/boards/board-transfer.js, built on the first call with
// the flag on: boards.exportFile { boardId } and boards.importFile { projectId }. The main process shows the dialog and
// does the IO; no path crosses in either direction, only a base name comes back.
//
// Pinning from the chat (slice C5): boards.pin makes one card of a chat item on a board the person picked, and
// boards.chatRefs says which boards hold cards for one chat (services/boards/board-pin.js, built with the extras).
//
// A board that loads read-only (slice B11, D20): boards.revealFile { boardId } shows its file in the system file manager and
// boards.setAside { boardId } renames its files aside in the boards folder and takes it out of the list
// (services/boards/board-set-aside.js, built with the extras; revealPath is Electron's shell.showItemInFolder unless handed in).

const { registerIpcInvokeHandlers } = require('../ipc-contract');

const ASSET_MAX_BYTES = 10 * 1024 * 1024; // the model's LIMITS.image_asset_bytes, checked before the model is loaded
const BOARD_ID_RE = /^board_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_ID_RE = /^project_[A-Za-z0-9_-]{1,128}$/;
const EXTRA_METHODS = Object.freeze(['boards.addAsset', 'boards.readAsset', 'boards.resolveFile', 'boards.openFile', 'boards.fileStatus',
  'boards.listProposals', 'boards.decideProposal', 'boards.pin', 'boards.chatRefs', 'boards.revealFile', 'boards.setAside']);
const TRANSFER_METHODS = Object.freeze(['boards.exportFile', 'boards.importFile']);

const METHODS = Object.freeze({
  'boards.list': 'list',
  'boards.create': 'create',
  'boards.get': 'get',
  'boards.apply': 'apply',
  'boards.undo': 'undo',
  'boards.redo': 'redo',
  'boards.rename': 'rename',
  'boards.duplicate': 'duplicate',
  'boards.delete': 'delete',
  'boards.restore': 'restore',
});

function createLazyBoardService({ app, backendService, sendBridgeEvent = () => {}, log = () => {} }) {
  let service = null;
  return () => {
    if (service) return service;
    const crypto = require('crypto');
    const { createBoardStore } = require('../boards/board-store');
    const { createBoardService } = require('../boards/board-service');
    service = createBoardService({
      store: createBoardStore({ userDataPath: app.getPath('userData'), logger: log }),
      makeId: () => crypto.randomUUID(),
      isEnabled: () => isBoardsEnabled(backendService),
      // Hosts without a project service (minimal embedded or test hosts) fail open, as project notes do.
      projectExists: (projectId) => (typeof backendService?.projectService?.get === 'function'
        ? Boolean(backendService.projectService.get(projectId))
        : true),
      logger: log,
    });
    service.on('changed', (payload) => sendBridgeEvent('boards.onChanged', payload));
    return service;
  };
}

function isBoardsEnabled(backendService) {
  return backendService?.featureFlags?.project_boards === true;
}

// The picture store, the sweep, the file checks and Jenny's proposals, built once on the first call that needs them.
function createLazyBoardExtras({
  app, backendService, getService, log = () => {}, revealPath = (filePath) => require('electron').shell.showItemInFolder(filePath),
}) {
  let extras = null;
  return () => {
    if (extras) return extras;
    const { createBoardStore } = require('../boards/board-store');
    const { createBoardAssetStore } = require('../boards/board-assets');
    const { createBoardAssetSweeper } = require('../boards/board-asset-sweep');
    const { createBoardFiles } = require('../boards/board-files');
    const { createBoardProposals } = require('../boards/board-proposals');
    const { createBoardPins, createPictureResolver } = require('../boards/board-pin');
    const { createBoardSetAside } = require('../boards/board-set-aside');
    const userDataPath = app.getPath('userData');
    const assets = createBoardAssetStore({ userDataPath, logger: log });
    extras = {
      assets,
      sweeper: createBoardAssetSweeper({
        assets, store: createBoardStore({ userDataPath, logger: log }), logger: log,
        getRedoInverses: () => getService().redoInverses(),
      }),
      files: createBoardFiles({
        getBoard: (boardId) => getService().get({ boardId }),
        captureProject: (projectId) => backendService.projectAuthority.captureProject(projectId),
      }),
    };
    // Proposals change a board only through the service; the service itself is still built on first use.
    extras.proposals = createBoardProposals({
      service: { get: (raw) => getService().get(raw), apply: (raw) => getService().apply(raw), emit: (...args) => getService().emit(...args) },
      store: createBoardStore({ userDataPath, logger: log }), getFiles: () => extras.files, logger: log,
    });
    extras.pins = createBoardPins({
      service: { list: (raw) => getService().list(raw), get: (raw) => getService().get(raw), apply: (raw) => getService().apply(raw) },
      getFiles: () => extras.files, getAssets: () => extras.assets, resolvePicture: createPictureResolver(backendService),
    });
    // The real service (its queue and index), built on first use like the rest.
    extras.setAside = createBoardSetAside({ store: createBoardStore({ userDataPath, logger: log }), service: getService, revealPath, logger: log });
    return extras;
  };
}

// The export and import of .jennyboard files, built once on the first call that needs them. The dialogs are Electron's,
// owned by the focused window, unless a dialog is handed in (tests).
function createLazyBoardTransfer({ app, getService, getExtras, dialog = null, log = () => {} }) {
  let transfer = null;
  return () => {
    if (transfer) return transfer;
    const { createBoardTransfer } = require('../boards/board-transfer');
    let dialogs = dialog;
    if (!dialogs) {
      const electron = require('electron');
      const owner = () => { try { return electron.BrowserWindow.getFocusedWindow() || null; } catch { return null; } };
      const show = (method) => (options) => (owner() ? electron.dialog[method](owner(), options) : electron.dialog[method](options));
      dialogs = { showSaveDialog: show('showSaveDialog'), showOpenDialog: show('showOpenDialog') };
    }
    const userDataPath = app.getPath('userData');
    transfer = createBoardTransfer({
      getService, getAssets: () => getExtras().assets, dialog: dialogs, logger: log, protectedRoots: () => [userDataPath],
    });
    return transfer;
  };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && Object.prototype.toString.call(v) === '[object Object]';
const byteLengthOf = (bytes) => (bytes instanceof Uint8Array || bytes instanceof ArrayBuffer ? bytes.byteLength : -1);

function extraHandlers({ getService, getExtras }) {
  const isBoard = (raw, keys) => isPlainObject(raw) && Object.keys(raw).every((key) => keys.includes(key))
    && typeof raw.boardId === 'string' && BOARD_ID_RE.test(raw.boardId);
  return {
    'boards.addAsset': async (raw) => {
      if (!isBoard(raw, ['boardId', 'bytes'])) return { ok: false, reason: 'invalid' };
      const size = byteLengthOf(raw.bytes);
      if (size < 0) return { ok: false, reason: 'invalid' };
      if (size > ASSET_MAX_BYTES) return { ok: false, reason: 'too_large' };
      const board = await getService().get({ boardId: raw.boardId });
      if (!board || board.ok !== true) return { ok: false, reason: board && board.reason ? board.reason : 'not_found' };
      if (board.readOnly) return { ok: false, reason: 'read_only' };
      return getExtras().assets.add(raw.bytes);
    },
    'boards.readAsset': async (raw) => (isBoard(raw, ['boardId', 'asset']) ? getExtras().assets.read(raw.asset) : { ok: false, reason: 'invalid' }),
    'boards.resolveFile': (raw) => getExtras().files.resolveFile(raw),
    'boards.openFile': (raw) => getExtras().files.openFile(raw),
    'boards.fileStatus': (raw) => getExtras().files.fileStatus(raw),
    // Jenny's proposed changes (slice C3): the list for a board, and one decision. The ids are checked again by the module.
    'boards.listProposals': async (raw) => (isBoard(raw, ['boardId']) ? getExtras().proposals.list(raw) : { ok: false, reason: 'invalid' }),
    'boards.decideProposal': async (raw) => (isBoard(raw, ['boardId', 'proposalId', 'action', 'n']) ? getExtras().proposals.decide(raw) : { ok: false, reason: 'invalid' }),
    'boards.pin': (raw) => getExtras().pins.pin(raw),
    'boards.chatRefs': (raw) => getExtras().pins.chatRefs(raw),
    // Read-only boards (slice B11): exactly { boardId }; the module reads the id only and the store builds the path.
    'boards.revealFile': async (raw) => (isBoard(raw, ['boardId']) ? getExtras().setAside.reveal({ boardId: raw.boardId }) : { ok: false, reason: 'invalid' }),
    'boards.setAside': async (raw) => (isBoard(raw, ['boardId']) ? getExtras().setAside.setAside({ boardId: raw.boardId }) : { ok: false, reason: 'invalid' }),
  };
}

function registerBoardIpc(ipcMain, {
  app,
  backendService,
  sendBridgeEvent = () => {},
  authorization,
  log = () => {},
  isEnabled = () => isBoardsEnabled(backendService),
  getService = createLazyBoardService({ app, backendService, sendBridgeEvent, log }),
  fetchLinkTitle = (request) => require('../boards/board-link-title').fetchLinkTitle(request),
  getExtras = createLazyBoardExtras({ app, backendService, getService, log }),
  getTransfer = createLazyBoardTransfer({ app, getService, getExtras, log }),
}) {
  const handlers = {};
  // The sweep's turn never changes an answer: a sweeper that cannot be built is skipped.
  const offerSweep = () => { try { getExtras().sweeper.maybeSweep(); } catch { /* skipped this call */ } };
  const guarded = (body) => async (_event, raw) => {
    let enabled;
    try { enabled = Boolean(isEnabled()); } catch { enabled = false; }
    if (!enabled) return { ok: false, reason: 'disabled' };
    let answer;
    try {
      answer = await body(raw);
    } catch {
      answer = { ok: false, reason: 'io' };
    }
    offerSweep();
    return answer && typeof answer === 'object' ? answer : { ok: false, reason: 'io' };
  };
  for (const [methodPath, serviceMethod] of Object.entries(METHODS)) {
    handlers[methodPath] = guarded((raw) => getService()[serviceMethod](raw));
  }
  const extras = extraHandlers({ getService, getExtras });
  for (const methodPath of EXTRA_METHODS) handlers[methodPath] = guarded(extras[methodPath]);
  // The request is checked before the transfer is built: one id, nothing else.
  const only = (raw, key, pattern) => isPlainObject(raw) && Object.keys(raw).length === 1 && typeof raw[key] === 'string' && pattern.test(raw[key]);
  handlers['boards.exportFile'] = guarded((raw) => (only(raw, 'boardId', BOARD_ID_RE) ? getTransfer().exportFile({ boardId: raw.boardId }) : { ok: false, reason: 'invalid' }));
  handlers['boards.importFile'] = guarded((raw) => (only(raw, 'projectId', PROJECT_ID_RE) ? getTransfer().importFile({ projectId: raw.projectId }) : { ok: false, reason: 'invalid' }));
  handlers['boards.fetchLinkTitle'] = async (_event, raw) => {
    try {
      if (!isEnabled()) return { ok: false, reason: 'disabled' };
      return await fetchLinkTitle(raw);
    } catch {
      return { ok: false, reason: 'failed' };
    }
  };
  // What the Board page has selected, for the board text of a turn sent from its docked chat (slice C2,
  // services/boards/board-turn-context.js). Card ids only, kept in memory; nothing is built until the first call.
  let selection = null;
  handlers['boards.setSelection'] = async (_event, raw) => {
    try {
      if (!isEnabled()) return { ok: false, reason: 'disabled' };
      if (!selection) selection = require('../boards/board-turn-context').createBoardSelection();
      return selection.set(raw);
    } catch {
      return { ok: false, reason: 'invalid' };
    }
  };
  if (backendService && typeof backendService === 'object') {
    backendService.boardSelection = { get: (boardId) => (selection && isEnabled() ? selection.get(boardId) : []) };
    // The reply of a turn sent from a board is read here when it ends (services/boards/board-proposal-turn.js).
    backendService.boardProposals = {
      record: async (args) => (isEnabled() ? getExtras().proposals.record(args) : { ok: false, reason: 'disabled' }),
    applyAuto: async (args) => (isEnabled() ? getExtras().proposals.applyAuto(args) : { ok: false, reason: 'disabled' }),
    };
  }
  const channels = registerIpcInvokeHandlers(ipcMain, handlers, authorization);
  // The project delete hook (services/projects/application-execution-composition.js) moves a deleted
  // project's boards to General through this; null while the flag is off.
  const getEnabledService = () => (isEnabled() ? getService() : null);
  if (backendService && typeof backendService === 'object') backendService.getBoardService = getEnabledService;
  return { channels, getService: getEnabledService };
}

module.exports = {
  EXTRA_METHODS, METHODS, TRANSFER_METHODS, createLazyBoardExtras, createLazyBoardService, createLazyBoardTransfer, isBoardsEnabled, registerBoardIpc,
};
