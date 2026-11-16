'use strict';

// Ids and file names shared by the board store, the board service and the data-lifecycle
// touchpoints (plan PROJECT_BOARD_2026-11-13, section 6.4). Tiny on purpose: the schema registry
// and the orphan-temp pass read it at startup without loading the board model.
//
// BOARD_ID_RE is the model's board id pattern (services/boards/board-model.js keeps it private);
// tests/board-store.test.js pins that the two agree, as it pins BOARD_SCHEMA_VERSION to the model's.
// Every id is checked here before it can reach path.join.

const BOARDS_DIR = 'boards';
const BOARD_SCHEMA_VERSION = 1;
const INDEX_FILE = 'index.json';
const BOARD_ID_RE = /^board_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_ID_RE = /^project_[A-Za-z0-9_-]{1,128}$/;
const GENERAL_PROJECT_ID = 'project_general';
// The suffix after `<board_id>` for each file a board owns.
const FILE_SUFFIXES = Object.freeze({ document: '.json', journal: '.journal.json', proposals: '.proposals.json' });
const BOARD_FILE_RE = /^(board_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.journal|\.proposals)?\.json$/;
// Pictures (slice B7): <userData>/board-assets/<sha256>.<ext>, shared by every board, and the small index of when each
// unreferenced picture was first seen unreferenced (services/boards/board-asset-sweep.js).
const BOARD_ASSETS_DIR = 'board-assets';
const ASSET_INDEX_FILE = 'unreferenced.json';
const ASSET_EXTENSIONS = Object.freeze(['png', 'jpg', 'webp', 'gif']);
const ASSET_ID_RE = /^[0-9a-f]{64}$/;
const ASSET_FILE_RE = /^([0-9a-f]{64})\.(png|jpg|webp|gif)$/;

function isBoardId(value) {
  return typeof value === 'string' && value.length === 42 && BOARD_ID_RE.test(value);
}

function isProjectId(value) {
  return typeof value === 'string' && value.length <= 136 && PROJECT_ID_RE.test(value);
}

/** { id, kind } for a live board file name, or null. */
function parseBoardFileName(name) {
  if (typeof name !== 'string' || name.length > 64) return null;
  const match = BOARD_FILE_RE.exec(name);
  if (!match) return null;
  const kind = match[2] === '.journal' ? 'journal' : match[2] === '.proposals' ? 'proposals' : 'document';
  return { id: match[1], kind };
}

/** True for every live file name the boards directory may hold. */
function isBoardFileName(name) {
  return name === INDEX_FILE || parseBoardFileName(name) !== null;
}

/** True for a picture's content hash (lowercase SHA-256 hex), the model's image `asset`. */
function isAssetId(value) {
  return typeof value === 'string' && value.length === 64 && ASSET_ID_RE.test(value);
}

/** { asset, ext } for a stored picture's file name, or null. */
function parseAssetFileName(name) {
  if (typeof name !== 'string' || name.length > 69) return null;
  const match = ASSET_FILE_RE.exec(name);
  return match ? { asset: match[1], ext: match[2] } : null;
}

/** True for every live file name the board-assets directory may hold. */
function isBoardAssetFileName(name) {
  return name === ASSET_INDEX_FILE || parseAssetFileName(name) !== null;
}

module.exports = {
  ASSET_EXTENSIONS,
  ASSET_INDEX_FILE,
  BOARD_ASSETS_DIR,
  isAssetId,
  isBoardAssetFileName,
  parseAssetFileName,
  BOARDS_DIR,
  BOARD_SCHEMA_VERSION,
  FILE_SUFFIXES,
  GENERAL_PROJECT_ID,
  INDEX_FILE,
  isBoardFileName,
  isBoardId,
  isProjectId,
  parseBoardFileName,
};
