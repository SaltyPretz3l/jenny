/* services/boards/board-model.js – the project board document model (UMD)
 *
 * One pure module holds every rule for a project board (plan PROJECT_BOARD_2026-11-13, sections 6.1
 * to 6.3, 6.6, 7.2 and 7.4). The renderer uses it for optimistic apply, the Electron main process as
 * the local truth and the team host as the shared truth, so it must give the same answer in all three.
 * No DOM, no Electron, no IO, no clock, no randomness: time and new ids come in as arguments. Inputs
 * are never mutated, and untrusted input yields { ok: false, reason } instead of a throw.
 *
 *   board     { schema_version, id: board_<uuid>, project_id, name, rev, next_alias, created_at,
 *               updated_at, recent_batches[], cards{}, connectors{}, groups{} }
 *   card      { id, alias, kind, x, y, w, h, z, group_id, geo_rev, content_rev,
 *               created_by, updated_by, created_at, updated_at, data }
 *   connector { id, from, to, label, style: solid|dashed, tone, ends: none|end|both, content_rev }
 *   group     { id, alias, title, x, y, w, h, tone, geo_rev, content_rev }
 *
 * `recent_batches` (at most 32 batch ids) makes a resent batch a harmless duplicate.
 * This file holds the shape, validation, normalizeBoard, createBoard and the journal helper, and
 * re-exports board-model-ops.js (applyBatch, applyInverse), board-placement.js (placeNewCards) and
 * board-text.js (boardToText, parseBoardText) so callers require one file. In a browser, load those
 * three before this one; it reads their globals.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./board-placement'), require('./board-model-ops'), require('./board-text'));
    return;
  }
  root.jennyBoardModel = factory(root.jennyBoardPlacement, root.jennyBoardModelOps, root.jennyBoardText);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (placement, createOps, boardText) {
  'use strict';

  var SCHEMA_VERSION = 1;
  var LIMITS = Object.freeze({
    boards_per_project: 20,
    cards: 500,
    connectors: 1000,
    groups: 50,
    note_chars: 4000,
    diagram_chars: 16384,
    diagram_lines: 400,
    diagram_nodes: 120,
    document_bytes: 2 * 1024 * 1024,
    image_asset_bytes: 10 * 1024 * 1024,
    image_assets_total_bytes: 200 * 1024 * 1024,
    journal_batches: 200,
    journal_bytes: 1024 * 1024,
    proposals: 20,
    proposals_bytes: 512 * 1024,
    batch_ops: 200,
    proposal_ops: 40,
  });
  var CARD_KINDS = Object.freeze(['note', 'file', 'image', 'link', 'chat', 'diagram']);
  var ALIAS_LETTER = Object.freeze({ note: 'n', file: 'f', image: 'i', link: 'l', chat: 'c', diagram: 'd', group: 'g' });
  var FIELD_MAX = Object.freeze({ name: 200, title: 200, label: 200, alt: 1000, path: 1024, url: 2048, excerpt: 400 });
  var DATA_KEYS = Object.freeze({
    note: Object.freeze(['text', 'tone']),
    file: Object.freeze(['path', 'title']),
    image: Object.freeze(['asset', 'width', 'height', 'alt']),
    link: Object.freeze(['url', 'title']),
    chat: Object.freeze(['session_id', 'message_id', 'title', 'excerpt']),
    diagram: Object.freeze(['scene', 'title']),
  });
  var BOARD_KEYS = ['schema_version', 'id', 'project_id', 'name', 'rev', 'next_alias', 'created_at', 'updated_at',
    'recent_batches', 'cards', 'connectors', 'groups'];
  var CARD_KEYS = ['id', 'alias', 'kind', 'x', 'y', 'w', 'h', 'z', 'group_id', 'geo_rev', 'content_rev',
    'created_by', 'updated_by', 'created_at', 'updated_at', 'data'];
  var CONNECTOR_KEYS = ['id', 'from', 'to', 'label', 'style', 'tone', 'ends', 'content_rev'];
  var GROUP_KEYS = ['id', 'alias', 'title', 'x', 'y', 'w', 'h', 'tone', 'geo_rev', 'content_rev'];
  var STYLES = ['solid', 'dashed'];
  var ENDS = ['none', 'end', 'both'];
  var RECENT_BATCHES = 32;
  // A place is never refused and may lengthen numbers, so a stored board can sit a little past the cap.
  var DOCUMENT_SLACK_BYTES = 64 * 1024;
  var COORD_MAX = 1e6;
  var SIZE_MIN = 8;
  var SIZE_MAX = 1e6;
  var Z_MAX = 1e9;
  var IMAGE_DIM_MAX = 100000;
  var ALIAS_MAX = 999999999;
  var DIAGRAM_KEYWORDS = { title: 1, dir: 1, group: 1, step: 1, end: 1, part: 1 };

  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  var BOARD_ID_RE = /^board_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  var PROJECT_ID_RE = /^project_[A-Za-z0-9_-]{1,128}$/;
  var TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,199}$/;
  var ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
  var TONE_RE = /^[a-z][a-z0-9-]{0,23}$/;
  var SHA256_RE = /^[0-9a-f]{64}$/;
  var ALIAS_RE = /^([nfilcdg])([1-9][0-9]{0,8})$/;
  // Single-line fields refuse every control and line separator; note-like text keeps \n and \t only.
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point.
  var LINE_BAD_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point.
  var TEXT_BAD_RE =/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/;
  var URL_RE = /^https?:\/\/[^\s/?#]+\S*$/i;
  var DIAGRAM_ARROW_RE = /(^|\s)(<->|-->|->)(\s|$)/;
  var hasOwn = Object.prototype.hasOwnProperty;

  /* ------------------------------------------------------------------ primitives */

  function own(map, key) {
    return map && typeof key === 'string' && hasOwn.call(map, key) ? map[key] : undefined;
  }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isUuid(v) { return typeof v === 'string' && v.length === 36 && UUID_RE.test(v); }
  function isToken(v) { return typeof v === 'string' && v.length <= 200 && TOKEN_RE.test(v); }
  function isIso(v) { return typeof v === 'string' && v.length <= 30 && ISO_RE.test(v); }
  function isRev(v) { return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0; }
  function isCoord(v) { return typeof v === 'number' && isFinite(v) && Math.abs(v) <= COORD_MAX; }
  function isSize(v) { return typeof v === 'number' && isFinite(v) && v >= SIZE_MIN && v <= SIZE_MAX; }
  function isZ(v) { return typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= Z_MAX; }
  function isTone(v) { return v === null || (typeof v === 'string' && v.length <= 24 && TONE_RE.test(v)); }
  function isLine(v, max, allowEmpty) {
    return typeof v === 'string' && v.length <= max && (allowEmpty || v.length > 0) && !LINE_BAD_RE.test(v);
  }
  function isText(v, max) { return typeof v === 'string' && v.length <= max && !TEXT_BAD_RE.test(v); }
  function oneOf(v, list) { return typeof v === 'string' && list.indexOf(v) >= 0; }

  function fail(reason, extra) {
    var out = { ok: false, reason: reason };
    if (extra) for (var k in extra) if (hasOwn.call(extra, k)) out[k] = extra[k];
    return out;
  }
  function bad(detail, limit) { return limit ? fail('invalid', { detail: detail, limit: limit }) : fail('invalid', { detail: detail }); }

  /** The first key of obj that is not in allowed, or null. */
  function onlyKeys(obj, allowed) {
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) if (allowed.indexOf(keys[i]) < 0) return keys[i];
    return null;
  }
  function exactKeys(obj, keys) { return Object.keys(obj).length === keys.length && onlyKeys(obj, keys) === null; }

  function aliasParts(alias) {
    if (typeof alias !== 'string' || alias.length > 10) return null;
    var m = ALIAS_RE.exec(alias);
    return m ? { letter: m[1], n: Number(m[2]) } : null;
  }

  function utf8Length(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }
  /** UTF-8 bytes of the stored JSON document, the measure behind the 2 MiB limit. */
  function boardBytes(board) { return utf8Length(JSON.stringify(board)); }
  function copy(value) { return JSON.parse(JSON.stringify(value)); }

  /* ------------------------------------------------------------------ card data */

  function checkPath(p) {
    if (!isLine(p, FIELD_MAX.path, false) || /^[\\/~]/.test(p) || /^[A-Za-z]:/.test(p)) return false;
    var parts = p.split(/[\\/]/);
    for (var i = 0; i < parts.length; i++) if (parts[i] === '..') return false;
    return true;
  }

  /** A rough node count for a sketch scene: lines that are not keywords, arrows or comments. */
  function countDiagramNodes(scene) {
    var n = 0;
    var lines = scene.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (!t || t.charAt(0) === '#' || t.slice(0, 2) === '//') continue;
      var first = t.split(/\s/)[0];
      if (hasOwn.call(DIAGRAM_KEYWORDS, first) || DIAGRAM_ARROW_RE.test(t)) continue;
      n++;
    }
    return n;
  }

  function dataField(data, key, fallback) { return data[key] === undefined ? fallback : data[key]; }

  /** Validates a card's data for its kind; `strict` (stored documents) requires every key. */
  function checkData(kind, data, strict) {
    if (!isObj(data)) return bad('data');
    var keys = DATA_KEYS[kind];
    var extra = onlyKeys(data, keys);
    if (extra !== null) return bad('data.' + extra);
    if (strict && Object.keys(data).length !== keys.length) return bad('data keys');
    var title = dataField(data, 'title', '');
    if (kind !== 'note' && kind !== 'image' && !isLine(title, FIELD_MAX.title, true)) return bad('data.title');
    var out;
    if (kind === 'note') {
      var text = dataField(data, 'text', '');
      if (typeof text !== 'string') return bad('data.text');
      if (text.length > LIMITS.note_chars) return bad('data.text', 'note_chars');
      if (!isText(text, LIMITS.note_chars)) return bad('data.text');
      var tone = dataField(data, 'tone', null);
      if (!isTone(tone)) return bad('data.tone');
      out = { text: text, tone: tone };
    } else if (kind === 'file') {
      if (!checkPath(data.path)) return bad('data.path');
      out = { path: data.path, title: title };
    } else if (kind === 'image') {
      var alt = dataField(data, 'alt', '');
      if (typeof data.asset !== 'string' || !SHA256_RE.test(data.asset)) return bad('data.asset');
      if (!Number.isInteger(data.width) || data.width < 1 || data.width > IMAGE_DIM_MAX) return bad('data.width');
      if (!Number.isInteger(data.height) || data.height < 1 || data.height > IMAGE_DIM_MAX) return bad('data.height');
      if (!isLine(alt, FIELD_MAX.alt, true)) return bad('data.alt');
      out = { asset: data.asset, width: data.width, height: data.height, alt: alt };
    } else if (kind === 'link') {
      if (!isLine(data.url, FIELD_MAX.url, false) || !URL_RE.test(data.url)) return bad('data.url');
      out = { url: data.url, title: title };
    } else if (kind === 'chat') {
      var messageId = dataField(data, 'message_id', null);
      var excerpt = dataField(data, 'excerpt', '');
      if (!isToken(data.session_id)) return bad('data.session_id');
      if (messageId !== null && !isToken(messageId)) return bad('data.message_id');
      if (!isText(excerpt, FIELD_MAX.excerpt)) return bad('data.excerpt');
      out = { session_id: data.session_id, message_id: messageId, title: title, excerpt: excerpt };
    } else {
      var scene = dataField(data, 'scene', '');
      if (typeof scene !== 'string') return bad('data.scene');
      if (scene.length > LIMITS.diagram_chars) return bad('data.scene', 'diagram_chars');
      if (!isText(scene, LIMITS.diagram_chars)) return bad('data.scene');
      if (scene.split('\n').length > LIMITS.diagram_lines) return bad('data.scene', 'diagram_lines');
      if (countDiagramNodes(scene) > LIMITS.diagram_nodes) return bad('data.scene', 'diagram_nodes');
      out = { scene: scene, title: title };
    }
    return { ok: true, data: out };
  }

  /* ------------------------------------------------------------------ operation fields (used by board-model-ops.js) */

  function readGeometry(item, size) {
    var hasX = item.x !== undefined;
    if (hasX !== (item.y !== undefined)) return { error: bad('x and y go together') };
    if (hasX && !(isCoord(item.x) && isCoord(item.y))) return { error: bad('x/y') };
    var w = item.w === undefined ? size.w : item.w;
    var h = item.h === undefined ? size.h : item.h;
    if (!isSize(w) || !isSize(h)) return { error: bad('w/h') };
    return { place: !hasX, x: item.x, y: item.y, w: w, h: h };
  }

  function readRevs(item, restore) {
    if (!restore) return { geo_rev: 0, content_rev: 0 };
    var geo = item.geo_rev === undefined ? 0 : item.geo_rev;
    var content = item.content_rev === undefined ? 0 : item.content_rev;
    return isRev(geo) && isRev(content) ? { geo_rev: geo, content_rev: content } : null;
  }

  function imageSize(data) {
    var w = Math.max(8, Math.min(320, data.width));
    return { w: w, h: Math.min(1e6, Math.max(8, Math.round((data.height * w) / data.width))) };
  }

  /** Reads the optional fields of a place or edit op: { set, prev, count } or { error }. */
  function readFields(op, rules, item) {
    var out = { set: {}, prev: {}, count: 0 };
    for (var name in rules) {
      if (!hasOwn.call(rules, name) || op[name] === undefined) continue;
      if (!rules[name](op[name])) return { error: bad(name) };
      out.set[name] = op[name];
      out.prev[name] = item[name];
      out.count++;
    }
    return out.count ? out : { error: bad('nothing to change') };
  }

  function find(map, id) {
    if (!isUuid(id)) return { error: bad('id') };
    var item = own(map, id);
    return item ? { item: item } : { error: fail('missing_target') };
  }

  function keysError(op, allowed) {
    var extra = onlyKeys(op, allowed);
    return extra === null ? null : bad('op.' + String(extra).slice(0, 40));
  }

  function optionalRev(v) { return v === undefined || isRev(v); }

  /* ------------------------------------------------------------------ stored document */

  function checkRevs(raw) { return isRev(raw.geo_rev) && isRev(raw.content_rev); }
  function checkBox(raw) { return isCoord(raw.x) && isCoord(raw.y) && isSize(raw.w) && isSize(raw.h); }
  function aliasFits(alias, letter) {
    if (alias === null) return true;
    var parts = aliasParts(alias);
    return Boolean(parts && parts.letter === letter);
  }

  function readGroup(raw, key) {
    if (!isObj(raw) || !exactKeys(raw, GROUP_KEYS)) return bad('group keys');
    if (!isUuid(raw.id) || raw.id !== key) return bad('group.id');
    if (!aliasFits(raw.alias, 'g')) return bad('group.alias');
    if (!isLine(raw.title, FIELD_MAX.title, false) || !checkBox(raw) || !isTone(raw.tone) || !checkRevs(raw)) return bad('group fields');
    return { ok: true, item: { id: raw.id, alias: raw.alias, title: raw.title, x: raw.x, y: raw.y, w: raw.w, h: raw.h,
      tone: raw.tone, geo_rev: raw.geo_rev, content_rev: raw.content_rev } };
  }

  function readCard(raw, key, groups) {
    if (!isObj(raw) || !exactKeys(raw, CARD_KEYS)) return bad('card keys');
    if (!isUuid(raw.id) || raw.id !== key) return bad('card.id');
    if (!oneOf(raw.kind, CARD_KINDS)) return bad('card.kind');
    if (!aliasFits(raw.alias, ALIAS_LETTER[raw.kind])) return bad('card.alias');
    if (!checkBox(raw) || !isZ(raw.z) || !checkRevs(raw)) return bad('card geometry');
    if (raw.group_id !== null && !own(groups, raw.group_id)) return bad('card.group_id: missing group');
    if (!isToken(raw.created_by) || !isToken(raw.updated_by) || !isIso(raw.created_at) || !isIso(raw.updated_at)) return bad('card authorship');
    var data = checkData(raw.kind, raw.data, true);
    if (!data.ok) return data;
    return { ok: true, item: { id: raw.id, alias: raw.alias, kind: raw.kind, x: raw.x, y: raw.y, w: raw.w, h: raw.h, z: raw.z,
      group_id: raw.group_id, geo_rev: raw.geo_rev, content_rev: raw.content_rev, created_by: raw.created_by,
      updated_by: raw.updated_by, created_at: raw.created_at, updated_at: raw.updated_at, data: data.data } };
  }

  function readConnector(raw, key, cards) {
    if (!isObj(raw) || !exactKeys(raw, CONNECTOR_KEYS)) return bad('connector keys');
    if (!isUuid(raw.id) || raw.id !== key) return bad('connector.id');
    if (!own(cards, raw.from) || !own(cards, raw.to) || raw.from === raw.to) return bad('connector ends');
    if (!isLine(raw.label, FIELD_MAX.label, true) || !oneOf(raw.style, STYLES) || !oneOf(raw.ends, ENDS) || !isTone(raw.tone) || !isRev(raw.content_rev)) {
      return bad('connector fields');
    }
    return { ok: true, item: { id: raw.id, from: raw.from, to: raw.to, label: raw.label, style: raw.style, tone: raw.tone,
      ends: raw.ends, content_rev: raw.content_rev } };
  }

  function readMap(rawMap, limitName, reader, context, out, seen) {
    if (!isObj(rawMap)) return bad(limitName);
    var keys = Object.keys(rawMap);
    if (keys.length > LIMITS[limitName]) return fail('limit', { limit: limitName });
    for (var i = 0; i < keys.length; i++) {
      if (!isUuid(keys[i])) return bad(limitName + ' key');
      if (seen[keys[i]]) return bad('duplicate id');
      var r = reader(rawMap[keys[i]], keys[i], context);
      if (!r.ok) return r;
      seen[keys[i]] = true;
      out[keys[i]] = r.item;
    }
    return null;
  }

  function checkAliases(board) {
    var used = Object.create(null);
    var maps = [board.cards, board.groups];
    for (var m = 0; m < maps.length; m++) {
      for (var id in maps[m]) {
        if (!hasOwn.call(maps[m], id) || maps[m][id].alias === null) continue;
        var alias = maps[m][id].alias;
        if (used[alias] || aliasParts(alias).n >= board.next_alias) return bad('alias ' + alias);
        used[alias] = true;
      }
    }
    return null;
  }

  function normalizeInner(value) {
    if (!isObj(value)) return bad('board');
    var sv = value.schema_version;
    if (typeof sv === 'number' && Number.isInteger(sv) && sv > SCHEMA_VERSION) return fail('newer_schema');
    if (sv !== SCHEMA_VERSION) return bad('schema_version');
    var extra = onlyKeys(value, BOARD_KEYS);
    if (extra !== null) return bad('unknown key ' + String(extra).slice(0, 40));
    if (typeof value.id !== 'string' || !BOARD_ID_RE.test(value.id)) return bad('id');
    if (typeof value.project_id !== 'string' || !PROJECT_ID_RE.test(value.project_id)) return bad('project_id');
    if (!isLine(value.name, FIELD_MAX.name, false)) return bad('name');
    if (!isRev(value.rev) || !Number.isInteger(value.next_alias) || value.next_alias < 1 || value.next_alias > ALIAS_MAX + 1) return bad('rev');
    if (!isIso(value.created_at) || !isIso(value.updated_at)) return bad('timestamps');
    var ring = value.recent_batches;
    if (!Array.isArray(ring) || ring.length > RECENT_BATCHES || !ring.every(isToken)) return bad('recent_batches');
    var board = { schema_version: SCHEMA_VERSION, id: value.id, project_id: value.project_id, name: value.name, rev: value.rev,
      next_alias: value.next_alias, created_at: value.created_at, updated_at: value.updated_at, recent_batches: ring.slice(),
      cards: {}, connectors: {}, groups: {} };
    var seen = Object.create(null);
    var err = readMap(value.groups, 'groups', readGroup, null, board.groups, seen) ||
      readMap(value.cards, 'cards', readCard, board.groups, board.cards, seen) ||
      readMap(value.connectors, 'connectors', readConnector, board.cards, board.connectors, seen) ||
      checkAliases(board);
    if (err) return err;
    if (boardBytes(board) > LIMITS.document_bytes + DOCUMENT_SLACK_BYTES) return fail('limit', { limit: 'document_bytes' });
    return { ok: true, board: board };
  }

  /** Reads a stored or received document. Never throws; a document that breaks a rule is refused. */
  function normalizeBoard(value) {
    try {
      return normalizeInner(value);
    } catch (e) {
      return bad('unreadable');
    }
  }

  /** A new, empty board. input: { id: board_<uuid>, project_id, name, now (ISO time) }. */
  function createBoard(input) {
    try {
      var o = isObj(input) ? input : {};
      if (typeof o.id !== 'string' || !BOARD_ID_RE.test(o.id)) return bad('id');
      if (typeof o.project_id !== 'string' || !PROJECT_ID_RE.test(o.project_id)) return bad('project_id');
      if (!isLine(o.name, FIELD_MAX.name, false)) return bad('name');
      if (!isIso(o.now)) return bad('now');
      return { ok: true, board: { schema_version: SCHEMA_VERSION, id: o.id, project_id: o.project_id, name: o.name, rev: 0,
        next_alias: 1, created_at: o.now, updated_at: o.now, recent_batches: [], cards: {}, connectors: {}, groups: {} } };
    } catch (e) {
      return bad('unreadable');
    }
  }

  /* ------------------------------------------------------------------ undo journal */

  /**
   * Adds one entry ({ batch_id, inverse, ... }) to an undo journal (an array, oldest first), keeping at
   * most caps.batches entries and caps.bytes UTF-8 bytes of JSON, oldest dropped first. An entry whose
   * inverse alone is over the byte cap is not stored: { ok: false, reason: 'too_large', undoable: false },
   * so the caller can ask "this cannot be undone" before applying.
   */
  function pushJournal(journal, entry, caps) {
    var list = Array.isArray(journal) ? journal.slice() : [];
    try {
      var c = isObj(caps) ? caps : {};
      var maxN = Number.isInteger(c.batches) && c.batches > 0 ? c.batches : LIMITS.journal_batches;
      var maxB = Number.isInteger(c.bytes) && c.bytes > 0 ? c.bytes : LIMITS.journal_bytes;
      if (!isObj(entry)) return fail('invalid', { undoable: false, journal: list, dropped: 0 });
      var inverseBytes = utf8Length(JSON.stringify(entry.inverse === undefined ? null : entry.inverse));
      var entryBytes = utf8Length(JSON.stringify(entry));
      if (inverseBytes > maxB || entryBytes > maxB) return fail('too_large', { undoable: false, journal: list, dropped: 0, bytes: entryBytes });
      list.push(entry);
      var sizes = list.map(function (e) { return utf8Length(JSON.stringify(e)); });
      var total = sizes.reduce(function (a, b) { return a + b; }, 0);
      var dropped = 0;
      while (list.length > maxN || total > maxB) {
        total -= sizes.shift();
        list.shift();
        dropped++;
      }
      return { ok: true, undoable: true, journal: list, dropped: dropped, bytes: total };
    } catch (e) {
      return fail('invalid', { undoable: false, journal: list, dropped: 0 });
    }
  }

  /* ------------------------------------------------------------------ undo of one batch */

  var REV_FIELD = { 'card.edit': 'content_rev', 'card.remove': 'content_rev', 'connector.edit': 'content_rev', 'connector.remove': 'content_rev',
    'group.edit': 'content_rev', 'group.remove': 'content_rev', 'card.place': 'geo_rev', 'group.assign': 'geo_rev', 'group.place': 'geo_rev' };

  /**
   * A batch may touch one item more than once (a card joins a group and is placed; a group grows twice). Each inverse step
   * names the revision its own step left, so once undo has put back the last step on an item, the earlier steps of the same
   * batch would look as if someone else had moved it. `read` gives such a step the item's revision as it stands; `took` notes
   * that a step on the item was put back. A step whose item really was changed by someone else is still skipped: the first
   * step on it is compared as it is.
   */
  function inverseSteps() {
    var ours = {};
    var idOf = function (op) { return op.op === 'group.assign' ? op.card_id : op.id; };
    var keyOf = function (op) {
      var field = isObj(op) && typeof op.op === 'string' && hasOwn.call(REV_FIELD, op.op) ? REV_FIELD[op.op] : null;
      return field && typeof idOf(op) === 'string' ? idOf(op) + '|' + field : null;
    };
    return {
      read: function (w, op) {
        var key = keyOf(op);
        if (!key || ours[key] !== true) return op;
        var map = op.op.indexOf('connector.') === 0 ? w.connectors : op.op === 'group.assign' || op.op.indexOf('card.') === 0 ? w.cards : w.groups;
        var item = own(map, idOf(op));
        if (!item) return op;
        var copy = Object.assign({}, op);
        copy[REV_FIELD[op.op]] = item[REV_FIELD[op.op]];
        return copy;
      },
      took: function (op) { var key = keyOf(op); if (key) ours[key] = true; },
    };
  }

  /* ------------------------------------------------------------------ assembly */

  var core = {
    LIMITS: LIMITS, CARD_KINDS: CARD_KINDS, ALIAS_LETTER: ALIAS_LETTER, FIELD_MAX: FIELD_MAX, DATA_KEYS: DATA_KEYS,
    CARD_KEYS: CARD_KEYS, CONNECTOR_KEYS: CONNECTOR_KEYS, GROUP_KEYS: GROUP_KEYS, STYLES: STYLES, ENDS: ENDS,
    RECENT_BATCHES: RECENT_BATCHES, ALIAS_MAX: ALIAS_MAX, own: own, isObj: isObj, isUuid: isUuid, isToken: isToken,
    isIso: isIso, isRev: isRev, isCoord: isCoord, isSize: isSize, isZ: isZ, isTone: isTone, isLine: isLine, oneOf: oneOf,
    fail: fail, bad: bad, onlyKeys: onlyKeys, aliasParts: aliasParts, boardBytes: boardBytes, copy: copy, checkData: checkData,
    readGeometry: readGeometry, readRevs: readRevs, imageSize: imageSize, readFields: readFields, find: find,
    keysError: keysError, optionalRev: optionalRev, inverseSteps: inverseSteps,
  };
  var ops = createOps(core, placement);

  function placeNewCards(board, adds) {
    try {
      return placement.placeNewCards(board, adds);
    } catch (e) {
      return bad('unreadable');
    }
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    LIMITS: LIMITS,
    CARD_KINDS: CARD_KINDS,
    ALIAS_LETTER: ALIAS_LETTER,
    TEXT_BUDGET: boardText.TEXT_BUDGET,
    isToken: isToken, isIso: isIso, isLine: isLine,
    createBoard: createBoard,
    normalizeBoard: normalizeBoard,
    applyBatch: ops.applyBatch,
    applyInverse: ops.applyInverse,
    placeNewCards: placeNewCards,
    boardToText: boardText.boardToText,
    parseBoardText: boardText.parseBoardText,
    pushJournal: pushJournal,
    boardBytes: boardBytes,
  };
});
