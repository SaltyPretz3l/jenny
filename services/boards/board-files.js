'use strict';

// File cards on a project board (row 150 slice B7, plan PROJECT_BOARD_2026-11-13 section 6.1): a file card holds a
// path relative to its project's folder, and opens in the Workspace through real-path containment.
//
// - The folder comes only from the project authority's record of the board's own project (captureProject on the
//   stored board's project_id); nothing the renderer sends is a root. No folder: `no_root`.
// - The check is services/sketch/sketch-file-open.js's checkSketchPath (lexical refusals, then fs-contained's walk:
//   real paths, a link or junction anywhere on the way refuses). This file adds no containment routine of its own.
// - resolveFile({ boardId, path }): what the person dropped or picked (absolute) or typed (relative) becomes
//   { ok: true, path, title }, the path relative to the folder with forward slashes and accepted by the model, the
//   title its base name.
// - openFile({ boardId, cardId }): the path is read from the stored card, never from the request, and checked again:
//   { ok: true, relativePath, projectId }.
// - fileStatus({ boardId }): { ok: true, missing: [cardId] } for the board's file cards whose file is not there (at
//   most the model's 500 cards, one walk each; no recursion, no watching).
// Every answer resolves and none carries an absolute path. Refusals: no_root, outside, link, not_found, not_file,
// invalid, read_only, io, and the board service's own (`not_found` for a board, `disabled`).

const { checkSketchPath } = require('../sketch/sketch-file-open');
const ids = require('./board-ids');

const MAX_PATH = 1024;
const MAX_FILE_CARDS = 500;
const CARD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The board model's single-line rule for data.path (board-model.js checkPath).
// eslint-disable-next-line no-control-regex -- refusing control characters is the point.
const LINE_BAD_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const CHECK_REASONS = new Set(['no_root', 'outside', 'link', 'not_found', 'not_file']);
const BOARD_REASONS = new Set(['not_found', 'invalid', 'disabled', 'io']);

const fail = (reason) => ({ ok: false, reason });
const isPlainObject = (v) => v !== null && typeof v === 'object' && Object.prototype.toString.call(v) === '[object Object]';

function readArgs(raw, keys) {
  return isPlainObject(raw) && Object.keys(raw).every((key) => keys.includes(key)) && ids.isBoardId(raw.boardId) ? raw : null;
}

/** True for a relative path the board model takes as a file card's data.path. */
function isModelPath(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_PATH || LINE_BAD_RE.test(value)) return false;
  if (/^[\\/~]/.test(value) || /^[A-Za-z]:/.test(value)) return false;
  return value.split(/[\\/]/).every((part) => part !== '..');
}

/**
 * deps:
 *   getBoard(boardId) -> Promise<the board service's get answer>   { ok, board, readOnly } or a refusal
 *   captureProject(projectId) -> { root_path, project_id }           the project authority's record; may throw
 *   platform, resolve                                                 for tests (passed to checkSketchPath)
 */
function createBoardFiles({ getBoard, captureProject, platform, resolve } = {}) {
  const checkOptions = {};
  if (platform) checkOptions.platform = platform;
  if (resolve) checkOptions.resolve = resolve;

  async function boardOf(boardId) {
    let got;
    try { got = await getBoard(boardId); } catch (_error) { return { failure: fail('io') }; }
    if (!got || got.ok !== true) return { failure: fail(got && BOARD_REASONS.has(got.reason) ? got.reason : 'not_found') };
    if (got.readOnly || !got.board) return { failure: fail('read_only') };
    return { board: got.board };
  }

  function rootOf(board) {
    try {
      const authority = typeof captureProject === 'function' ? captureProject(board.project_id) : null;
      return authority && typeof authority.root_path === 'string' ? authority.root_path : '';
    } catch (_error) {
      return '';
    }
  }

  function check(root, rawPath) {
    let checked;
    try { checked = checkSketchPath(root, rawPath, checkOptions); } catch (_error) { return fail('not_found'); }
    if (checked && checked.ok === true && isModelPath(checked.relativePath)) return { ok: true, relativePath: checked.relativePath };
    if (checked && checked.ok === true) return fail('invalid');
    return fail(checked && CHECK_REASONS.has(checked.reason) ? checked.reason : 'not_found');
  }

  async function resolveFile(raw) {
    const args = readArgs(raw, ['boardId', 'path']);
    if (!args || typeof args.path !== 'string' || !args.path || args.path.length > MAX_PATH) return fail('invalid');
    const opened = await boardOf(args.boardId);
    if (opened.failure) return opened.failure;
    const root = rootOf(opened.board);
    if (!root) return fail('no_root');
    const checked = check(root, args.path);
    if (!checked.ok) return checked;
    return { ok: true, path: checked.relativePath, title: checked.relativePath.split('/').pop() };
  }

  async function openFile(raw) {
    // Only the two ids are read: anything else in the request (a path, a root) is ignored.
    const args = isPlainObject(raw) && ids.isBoardId(raw.boardId) ? raw : null;
    if (!args || typeof args.cardId !== 'string' || !CARD_ID_RE.test(args.cardId)) return fail('invalid');
    const opened = await boardOf(args.boardId);
    if (opened.failure) return opened.failure;
    const card = Object.prototype.hasOwnProperty.call(opened.board.cards, args.cardId) ? opened.board.cards[args.cardId] : null;
    if (!card) return fail('not_found');
    if (card.kind !== 'file' || !card.data || typeof card.data.path !== 'string') return fail('invalid');
    const root = rootOf(opened.board);
    if (!root) return fail('no_root');
    const checked = check(root, card.data.path);
    if (!checked.ok) return checked;
    return { ok: true, relativePath: checked.relativePath, projectId: opened.board.project_id };
  }

  async function fileStatus(raw) {
    const args = readArgs(raw, ['boardId']);
    if (!args) return fail('invalid');
    const opened = await boardOf(args.boardId);
    if (opened.failure) return opened.failure;
    const root = rootOf(opened.board);
    if (!root) return fail('no_root');
    const missing = [];
    const files = Object.values(opened.board.cards).filter((card) => card && card.kind === 'file').slice(0, MAX_FILE_CARDS);
    for (const card of files) {
      const checked = check(root, card.data && card.data.path);
      if (checked.ok) continue;
      if (checked.reason === 'no_root') return fail('no_root');
      missing.push(card.id);
    }
    return { ok: true, missing };
  }

  return Object.freeze({ resolveFile, openFile, fileStatus });
}

module.exports = { createBoardFiles, isModelPath };
