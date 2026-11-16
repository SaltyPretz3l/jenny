'use strict';

// Team boards T1 (row 151, plan PROJECT_BOARD_2026-11-13 section 8): the one composition entry the team host calls
// for project boards. `createTeamBoards(...)` builds the host board store (board-host-store.js) over the guarded
// file layer (board-host-files.js) on `<userDataPath>/team-boards/`. Commands, routes, authorization, events and
// images come in later slices; this store takes the acting member's id and a `recheck` callback and decides no role.
//
// Every method is async, never throws for a caller error, and resolves `{ ok: true, ... }` or a
// `hostFailure(kind, reason)` with one of TEAM_BOARD_REASONS.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const durable = require('../../../services/host/durable-json');
const { assertSafeFile } = require('../../../services/host/path-guard');
const { hostFailure } = require('../../api-contract');
const { safeLogger } = require('../safe-logger');
const { BOARDS_ROOT, createBoardFiles } = require('./board-host-files');
const { LIMITS } = require('../../../services/boards/board-model');
const { ENTRIES_MAX } = require('./board-host-index');
const { createBoardHostStore } = require('./board-host-store');

const TEAM_BOARD_REASONS = Object.freeze([
  'team_board_not_found', 'team_board_invalid', 'team_board_limit', 'team_board_storage_limit', 'team_board_read_only',
  'team_board_refused', 'team_board_unavailable', 'team_board_trash_limit',
]);
// Per-project caps (owner decision 8.1): documents, journals and proposals files together; `assetBytes`, the project's
// pictures, is the picture store's (board-host-assets.js, slice T6). `boards` is how many boards a project holds,
// live and in the trash together (board-host-index.js ENTRIES_MAX); `trash` is how many of those may be deleted
// boards, which leaves room for every live one, so deleted boards never stop a create. Options may only lower them.
const TEAM_BOARD_LIMITS = Object.freeze({ storageBytes: 64 * 1024 * 1024, assetBytes: 256 * 1024 * 1024, boards: ENTRIES_MAX,
  trash: ENTRIES_MAX - LIMITS.boards_per_project });

function resolveLimits(limits = {}) {
  const resolved = { ...TEAM_BOARD_LIMITS };
  for (const [key, value] of Object.entries(limits ?? {})) {
    if (!Object.hasOwn(TEAM_BOARD_LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > TEAM_BOARD_LIMITS[key]) {
      throw new RangeError('invalid_team_board_limit');
    }
    resolved[key] = value;
  }
  return Object.freeze(resolved);
}

/**
 * userDataPath: the host profile (absolute). clock(): milliseconds. makeId(): a lowercase UUID. logger(level, event,
 * data). assertSafePath(file): throws for a path reached through a link. fileOps and limits are test seams: fileOps
 * replaces readJson, writeText or listDir; limits lowers the storage cap. onChange(change): told of every applied
 * batch ({ kind: 'applied', projectId, boardId, renamed, item }) and list change ({ kind: 'list', projectId }),
 * synchronously, inside the board's queue (slice T3, board-events.js).
 */
function createTeamBoards({
  userDataPath, clock = Date.now, makeId = () => crypto.randomUUID(), logger = null, assertSafePath = assertSafeFile,
  fileOps = {}, limits = {}, onChange = null,
} = {}) {
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) {
    throw new TypeError('createTeamBoards requires an absolute userDataPath.');
  }
  if (typeof clock !== 'function' || typeof makeId !== 'function' || typeof assertSafePath !== 'function') {
    throw new TypeError('createTeamBoards requires clock(), makeId() and a path guard.');
  }
  const log = safeLogger(logger);
  const ops = {
    readJson: fileOps.readJson || durable.readJson,
    writeText: fileOps.writeText || durable.writeText,
    listDir: fileOps.listDir || ((dir) => fs.readdirSync(dir)),
  };
  const files = createBoardFiles({ root: path.join(userDataPath, BOARDS_ROOT), guard: assertSafePath, ops, log });
  const store = createBoardHostStore({ files, clock, makeId, log, limits: resolveLimits(limits), onChange });
  const methods = {};
  for (const [name, method] of Object.entries(store)) {
    methods[name] = async (args) => {
      try {
        return await method(args);
      } catch {
        log('WARN', 'team_board.call_failed', { method: name });
        return hostFailure('unavailable', 'team_board_unavailable', '', true);
      }
    };
  }
  return Object.freeze(methods);
}

module.exports = { TEAM_BOARD_LIMITS, TEAM_BOARD_REASONS, createTeamBoards };
