'use strict';

// The .jennyboard format (row 150 slice B10, plan PROJECT_BOARD_2026-11-13): one UTF-8 JSON file that holds a board's
// content and its pictures, for export and import. Pure: no fs, no Electron, no clock, no randomness (time and new ids
// come in as arguments). board-transfer.js does the file IO and the dialogs.
//
//   { "format": "jennyboard", "version": 1, "exported_at": "<ISO>",
//     "board": { "name", "next_alias", "cards": {...}, "connectors": {...}, "groups": {...} },
//     "assets": [ { "ext": "png|jpg|webp|gif", "base64": "..." } ] }
//
// unpack reads a hostile file. It refuses rather than repairs: the text is size-checked before JSON.parse, depth and
// node count are bounded after it, every key not listed above is refused (`unknown_key`), and normalizeBoard is the
// one authority on the board itself. Only the board's content and its pictures are read: the board that comes out is
// built the way a duplicate is (board-service.js `_copyBoard`): a new board id and project handed in, rev 0, no
// recent batches, every item under a new id with its references rewritten and the same aliases; then the owner
// wrote every card now, and every revision starts where a fresh item's does (0, as the model's readRevs gives a
// card that is not a restore). `next_alias` is one past the highest short name the board holds, whatever the file
// says: no chat has named this new board's items, and a file's own number can sit at the ceiling, where nothing
// could be added to the board again (a board whose highest short name is the ceiling itself is refused, `limit`).
// Pictures come out as decoded bytes only: the asset store decides their type and hash
// from the content when they are added, so an image card naming a picture that was not stored stays on the board.

const model = require('./board-model');

const { LIMITS } = model;
const FORMAT = 'jennyboard';
const VERSION = 1;
const PACKAGE_MAX_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 16; // a board document is 6 levels deep; anything past this is not one
const MAX_NODES = 60000; // every object, array and value: a full board is about 25,000
const TOP_KEYS = Object.freeze(['format', 'version', 'exported_at', 'board', 'assets']);
const BOARD_KEYS = Object.freeze(['name', 'next_alias', 'cards', 'connectors', 'groups']);
const ASSET_KEYS = Object.freeze(['ext', 'base64']);
const EXTENSIONS = Object.freeze(['png', 'jpg', 'webp', 'gif']);
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const ISO_MAX = 40;
const ALIAS_CEILING = 999999999; // the model's ALIAS_MAX: the highest number a short name carries
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const fail = (reason, extra) => (extra ? { ok: false, reason, ...extra } : { ok: false, reason });
const isPlainObject = (v) => v !== null && typeof v === 'object' && Object.prototype.toString.call(v) === '[object Object]';
const extraKey = (obj, keys) => Object.keys(obj).some((key) => !keys.includes(key));
const missingKey = (obj, keys) => keys.some((key) => !Object.prototype.hasOwnProperty.call(obj, key));
const base64Length = (bytes) => Math.ceil(bytes / 3) * 4;

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

/** Walks parsed JSON without stringifying it: 'depth' past MAX_DEPTH, 'nodes' past MAX_NODES, else null. */
function boundedShape(value) {
  let nodes = 0;
  const stack = [[value, 0]];
  while (stack.length) {
    const [item, depth] = stack.pop();
    nodes += 1;
    if (depth > MAX_DEPTH) return 'depth';
    if (nodes > MAX_NODES) return 'nodes';
    if (item !== null && typeof item === 'object') {
      for (const key of Object.keys(item)) stack.push([item[key], depth + 1]);
    }
  }
  return null;
}

/**
 * pack({ board, assets: [{ ext, bytes }], now: ISO }) -> { ok: true, text } | { ok: false, reason }.
 * `board` is a normalized board; only its five content keys go out. A picture given twice goes once.
 */
function pack({ board, assets = [], now } = {}) {
  try {
    const read = model.normalizeBoard(board);
    if (!read.ok) return fail('invalid');
    const b = read.board;
    if (!Array.isArray(assets) || assets.length > LIMITS.cards) return fail('asset');
    let estimate = model.boardBytes(b);
    const pictures = [];
    for (const asset of assets) {
      const bytes = asset && asBytes(asset.bytes);
      if (!bytes || !EXTENSIONS.includes(asset.ext) || bytes.byteLength < 1 || bytes.byteLength > LIMITS.image_asset_bytes) return fail('asset');
      estimate += base64Length(bytes.byteLength) + 32;
      if (estimate > PACKAGE_MAX_BYTES) return fail('too_large');
      pictures.push({ ext: asset.ext, bytes });
    }
    const seen = new Set();
    const out = [];
    for (const picture of pictures) {
      const base64 = Buffer.from(picture.bytes.buffer, picture.bytes.byteOffset, picture.bytes.byteLength).toString('base64');
      if (seen.has(base64)) continue;
      seen.add(base64);
      out.push({ ext: picture.ext, base64 });
    }
    const value = { format: FORMAT, version: VERSION, exported_at: typeof now === 'string' ? now : new Date(0).toISOString(),
      board: { name: b.name, next_alias: b.next_alias, cards: b.cards, connectors: b.connectors, groups: b.groups }, assets: out };
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text, 'utf8') > PACKAGE_MAX_BYTES) return fail('too_large');
    return { ok: true, text };
  } catch (_error) {
    return fail('invalid');
  }
}

// The top level and the board: every listed key present, nothing else.
function readEnvelope(value) {
  if (!isPlainObject(value) || value.format !== FORMAT) return fail('format');
  if (Number.isInteger(value.version) && value.version > VERSION) return fail('version');
  if (value.version !== VERSION) return fail('format');
  if (extraKey(value, TOP_KEYS)) return fail('unknown_key');
  if (missingKey(value, TOP_KEYS) || typeof value.exported_at !== 'string' || value.exported_at.length > ISO_MAX || !ISO_RE.test(value.exported_at)) return fail('format');
  if (!isPlainObject(value.board) || !Array.isArray(value.assets)) return fail('format');
  if (extraKey(value.board, BOARD_KEYS)) return fail('unknown_key');
  if (missingKey(value.board, BOARD_KEYS)) return fail('invalid');
  return null;
}

// The pictures: decoded bytes, each within the per-picture cap, all within the store's total.
function readAssets(list) {
  if (list.length > LIMITS.cards) return fail('limit', { limit: 'cards' });
  const pictures = [];
  let total = 0;
  for (const entry of list) {
    if (!isPlainObject(entry)) return fail('asset');
    if (extraKey(entry, ASSET_KEYS)) return fail('unknown_key');
    const { ext, base64 } = entry;
    if (typeof ext !== 'string' || typeof base64 !== 'string' || !EXTENSIONS.includes(ext)) return fail('asset');
    if (base64.length === 0 || base64.length % 4 !== 0 || base64.length > base64Length(LIMITS.image_asset_bytes) || !BASE64_RE.test(base64)) return fail('asset');
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.byteLength < 1 || bytes.byteLength > LIMITS.image_asset_bytes) return fail('asset');
    total += bytes.byteLength;
    if (total > LIMITS.image_assets_total_bytes) return fail('limit', { limit: 'image_assets_total_bytes' });
    pictures.push({ ext, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
  }
  return { ok: true, pictures };
}

const modelRefusal = (read) => (read.reason === 'limit' ? fail('limit', read.limit ? { limit: read.limit } : undefined) : fail('invalid'));

// A fresh board from a validated one: new ids with references rewritten, the owner's authorship, fresh revisions,
// and the next short name counted from the items it holds.
function freshCopy(source, { makeId, now }) {
  let top = 0;
  for (const item of [...Object.values(source.cards), ...Object.values(source.groups)]) {
    if (item.alias !== null) top = Math.max(top, Number(item.alias.slice(1)));
  }
  const fresh = new Map();
  const idFor = (old) => {
    if (!fresh.has(old)) fresh.set(old, makeId());
    return fresh.get(old);
  };
  const groups = {};
  for (const group of Object.values(source.groups)) groups[idFor(group.id)] = { ...group, id: idFor(group.id), geo_rev: 0, content_rev: 0 };
  const cards = {};
  for (const card of Object.values(source.cards)) {
    cards[idFor(card.id)] = { ...card, id: idFor(card.id), group_id: card.group_id === null ? null : idFor(card.group_id), data: { ...card.data },
      geo_rev: 0, content_rev: 0, created_by: 'owner', updated_by: 'owner', created_at: now, updated_at: now };
  }
  const connectors = {};
  for (const con of Object.values(source.connectors)) connectors[idFor(con.id)] = { ...con, id: idFor(con.id), from: idFor(con.from), to: idFor(con.to), content_rev: 0 };
  return { ...source, next_alias: top + 1, cards, connectors, groups };
}

/**
 * unpack(text, { makeId, now, projectId, newBoardId, name }) -> { ok: true, board, pictures: [{ ext, bytes }] }
 * | { ok: false, reason }. Reasons: too_large, not_json, format, version, unknown_key, invalid, asset, limit.
 * `name`, when given, replaces the file's board name (the caller makes it unique).
 */
function unpack(text, { makeId, now, projectId, newBoardId, name } = {}) {
  try {
    if (typeof text !== 'string') return fail('not_json');
    if (text.length > PACKAGE_MAX_BYTES || Buffer.byteLength(text, 'utf8') > PACKAGE_MAX_BYTES) return fail('too_large');
    let value;
    try { value = JSON.parse(text); } catch (_error) { return fail('not_json'); }
    if (boundedShape(value)) return fail('limit');
    const envelope = readEnvelope(value);
    if (envelope) return envelope;
    const assets = readAssets(value.assets);
    if (!assets.ok) return assets;
    if (typeof makeId !== 'function') return fail('invalid');
    const file = value.board;
    // First read: the file's content as a document with this project's fresh frame. normalizeBoard decides.
    const first = model.normalizeBoard({ schema_version: model.SCHEMA_VERSION, id: newBoardId, project_id: projectId,
      name: name === undefined ? file.name : name, rev: 0, next_alias: file.next_alias, created_at: now, updated_at: now,
      recent_batches: [], cards: file.cards, connectors: file.connectors, groups: file.groups });
    if (!first.ok) return modelRefusal(first);
    const second = model.normalizeBoard(freshCopy(first.board, { makeId, now }));
    if (!second.ok) return modelRefusal(second);
    if (second.board.next_alias > ALIAS_CEILING) return fail('limit', { limit: 'aliases' });
    return { ok: true, board: second.board, pictures: assets.pictures };
  } catch (_error) {
    return fail('invalid');
  }
}

module.exports = { EXTENSIONS, FORMAT, PACKAGE_MAX_BYTES, VERSION, pack, unpack };
