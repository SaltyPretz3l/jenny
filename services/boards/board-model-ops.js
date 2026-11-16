/* services/boards/board-model-ops.js – applyBatch and applyInverse for project boards (UMD)
 *
 * Plan PROJECT_BOARD_2026-11-13 sections 6.2 and 6.3. A batch { batch_id, board_id, actor, ops[] } is
 * applied atomically; the thirteen operations are the keys of HANDLERS below.
 *
 * - `place` bumps geo_rev and is last write wins; `edit` carries the content_rev it was made against
 *   and is refused `stale` (with the current item) when that moved. `remove` wins over an edit.
 * - Removing a card removes its connectors; removing a group releases its cards. These derived
 *   operations go into the applied batch, before the removal, so a replay and the inverse agree.
 * - An item added without coordinates is placed (board-placement.js); a group that grows gets a group.place.
 * - The inverse carries the revision each inverse operation expects; applyInverse skips an operation
 *   whose item moved on (content_rev for edits and removals, geo_rev for moves) or that something
 *   else now refers to, so undo never removes another person's work.
 *
 * Exports a factory: board-model.js calls it with its validation core and the placement module.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.jennyBoardModelOps = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var hasOwn = Object.prototype.hasOwnProperty;

  return function createOps(core, placement) {
    var LIMITS = core.LIMITS;
    var FIELD_MAX = core.FIELD_MAX;
    var REMOVALS = { 'card.remove': true, 'connector.remove': true, 'group.remove': true };
    // Removals are never refused for size (select-all delete on a full board), but a batch stays bounded.
    var TOTAL_OPS_MAX = LIMITS.batch_ops + LIMITS.cards + LIMITS.connectors + LIMITS.groups;
    var CARD_PLACE = { x: core.isCoord, y: core.isCoord, w: core.isSize, h: core.isSize, z: core.isZ };
    var GROUP_PLACE = { x: core.isCoord, y: core.isCoord, w: core.isSize, h: core.isSize };
    var CONNECTOR_EDIT = {
      label: function (v) { return core.isLine(v, FIELD_MAX.label, true); },
      style: function (v) { return core.oneOf(v, core.STYLES); },
      tone: core.isTone,
      ends: function (v) { return core.oneOf(v, core.ENDS); },
    };
    var GROUP_EDIT = { title: function (v) { return core.isLine(v, FIELD_MAX.title, false); }, tone: core.isTone };
    var bad = core.bad, fail = core.fail, find = core.find, keysError = core.keysError, optionalRev = core.optionalRev;
    var readGeometry = core.readGeometry, readRevs = core.readRevs, imageSize = core.imageSize, readFields = core.readFields;

    /* ---------------------------------------------------------------- working copy */

    function begin(board, actor, now, authority) {
      var w = {
        board: board, actor: actor, now: now, authority: authority, name: board.name, nextAlias: board.next_alias,
        cards: Object.assign({}, board.cards), connectors: Object.assign({}, board.connectors), groups: Object.assign({}, board.groups),
        aliases: Object.create(null), removed: Object.create(null), byCard: null, maxZ: null, run: { col: null },
        applied: [], inverse: [], grows: false,
      };
      w.counts = { cards: Object.keys(w.cards).length, connectors: Object.keys(w.connectors).length, groups: Object.keys(w.groups).length };
      [w.cards, w.groups].forEach(function (map) {
        for (var id in map) if (hasOwn.call(map, id) && map[id].alias) w.aliases[map[id].alias] = id;
      });
      return w;
    }

    function exists(w, id) { return Boolean(core.own(w.cards, id) || core.own(w.connectors, id) || core.own(w.groups, id)); }

    function linkConnector(w, con, on) {
      if (!w.byCard) return;
      [con.from, con.to].forEach(function (cardId) {
        if (on) (w.byCard[cardId] = w.byCard[cardId] || Object.create(null))[con.id] = true;
        else if (w.byCard[cardId]) delete w.byCard[cardId][con.id];
      });
    }

    function connectorsOf(w, cardId) {
      if (!w.byCard) {
        w.byCard = Object.create(null);
        for (var id in w.connectors) if (hasOwn.call(w.connectors, id)) linkConnector(w, w.connectors[id], true);
      }
      return w.byCard[cardId] ? Object.keys(w.byCard[cardId]).sort() : [];
    }

    function groupHasCards(w, groupId) {
      for (var id in w.cards) if (hasOwn.call(w.cards, id) && w.cards[id].group_id === groupId) return true;
      return false;
    }

    function nextZ(w) {
      if (w.maxZ === null) {
        w.maxZ = -1;
        for (var id in w.cards) if (hasOwn.call(w.cards, id)) w.maxZ = Math.max(w.maxZ, w.cards[id].z);
      }
      return w.maxZ + 1;
    }

    function noteZ(w, z) { if (w.maxZ !== null && z > w.maxZ) w.maxZ = z; }

    function takeAlias(w, letter, given, restore) {
      var hasGiven = given !== undefined && given !== null;
      var parts = hasGiven ? core.aliasParts(given) : null;
      if (hasGiven && (!parts || parts.letter !== letter)) {
        if (!w.authority) return bad('alias');
        parts = null; // the authority ignores a malformed alias
      }
      if (parts && (!w.authority || restore)) {
        if (!w.aliases[given]) {
          if (parts.n >= w.nextAlias) w.nextAlias = parts.n + 1;
          return given;
        }
        if (!w.authority) return fail('exists', { detail: 'alias' });
      }
      if (!w.authority) return null;
      if (w.nextAlias > core.ALIAS_MAX) return fail('limit', { limit: 'aliases' });
      var alias = letter + w.nextAlias;
      w.nextAlias += 1;
      return alias;
    }

    function record(w, applied, inverse) {
      w.applied.push(applied);
      w.inverse.push(inverse);
    }

    /* ---------------------------------------------------------------- cards */

    function cardAdd(w, op, anchorId) {
      var e = keysError(op, ['op', 'card', 'restore']);
      if (e) return e;
      var c = op.card;
      if (!core.isObj(c) || (op.restore !== undefined && typeof op.restore !== 'boolean')) return bad('card');
      if ((e = keysError(c, core.CARD_KEYS))) return e;
      var restore = op.restore === true;
      if (!core.isUuid(c.id)) return bad('card.id');
      if (exists(w, c.id)) return fail('exists');
      if (!core.oneOf(c.kind, core.CARD_KINDS)) return bad('card.kind');
      var data = core.checkData(c.kind, c.data, false);
      if (!data.ok) return data;
      var groupId = null;
      if (c.group_id !== undefined && c.group_id !== null) {
        if (!core.isUuid(c.group_id)) return bad('card.group_id');
        if (core.own(w.groups, c.group_id)) groupId = c.group_id;
        else if (!restore) return fail('missing_target', { detail: 'group' }); // a restore whose group went comes back ungrouped
      }
      var geo = readGeometry(c, c.kind === 'image' ? imageSize(data.data) : placement.DEFAULT_SIZES[c.kind]);
      if (geo.error) return geo.error;
      var z = c.z === undefined ? nextZ(w) : c.z;
      var revs = readRevs(c, restore);
      if (!core.isZ(z) || !revs) return bad('card.z/revs');
      if (w.counts.cards >= LIMITS.cards) return fail('limit', { limit: 'cards' });
      var alias = takeAlias(w, core.ALIAS_LETTER[c.kind], c.alias, restore);
      if (alias && alias.ok === false) return alias;
      var spot = geo.place ? placement.placeOne(w, { w: geo.w, h: geo.h, group_id: groupId, near: anchorId }) : { x: geo.x, y: geo.y, grow: null };
      var card = {
        id: c.id, alias: alias, kind: c.kind, x: spot.x, y: spot.y, w: geo.w, h: geo.h, z: z, group_id: groupId,
        geo_rev: revs.geo_rev, content_rev: revs.content_rev,
        created_by: restore && core.isToken(c.created_by) ? c.created_by : w.actor, updated_by: w.actor,
        created_at: restore && core.isIso(c.created_at) ? c.created_at : w.now, updated_at: w.now, data: data.data,
      };
      w.cards[card.id] = card;
      w.counts.cards++;
      noteZ(w, z);
      if (alias) w.aliases[alias] = card.id;
      delete w.removed[card.id];
      w.grows = true;
      var applied = { op: 'card.add', card: core.copy(card) };
      if (restore) applied.restore = true;
      record(w, applied, { op: 'card.remove', id: card.id, content_rev: card.content_rev });
      if (spot.grow) groupPlace(w, { op: 'group.place', id: spot.grow.id, w: spot.grow.w, h: spot.grow.h });
      return null;
    }

    function cardEdit(w, op) {
      var e = keysError(op, ['op', 'id', 'content_rev', 'data']);
      if (e) return e;
      var found = find(w.cards, op.id);
      if (found.error) return found.error;
      var c = found.item;
      if (!core.isRev(op.content_rev)) return bad('content_rev');
      if (op.content_rev !== c.content_rev) return fail('stale', { current: core.copy(c) });
      if (!core.isObj(op.data)) return bad('data');
      if ((e = keysError(op.data, core.DATA_KEYS[c.kind]))) return e;
      var merged = core.checkData(c.kind, Object.assign({}, c.data, op.data), false);
      if (!merged.ok) return merged;
      var next = Object.assign({}, c, { data: merged.data, content_rev: c.content_rev + 1, updated_by: w.actor, updated_at: w.now });
      w.cards[c.id] = next;
      w.grows = true;
      record(w, { op: 'card.edit', id: c.id, content_rev: op.content_rev, data: core.copy(op.data) },
        { op: 'card.edit', id: c.id, content_rev: next.content_rev, data: core.copy(c.data) });
      return null;
    }

    function cardPlace(w, op) {
      var e = keysError(op, ['op', 'id', 'x', 'y', 'w', 'h', 'z', 'geo_rev']);
      if (e) return e;
      if (!optionalRev(op.geo_rev)) return bad('geo_rev');
      var found = find(w.cards, op.id);
      if (found.error) return found.error;
      var c = found.item;
      var f = readFields(op, CARD_PLACE, c);
      if (f.error) return f.error;
      var next = Object.assign({}, c, f.set, { geo_rev: c.geo_rev + 1, updated_by: w.actor, updated_at: w.now });
      w.cards[c.id] = next;
      if (f.set.z !== undefined) noteZ(w, f.set.z);
      record(w, Object.assign({ op: 'card.place', id: c.id }, f.set), Object.assign({ op: 'card.place', id: c.id }, f.prev, { geo_rev: next.geo_rev }));
      return null;
    }

    function cardRemove(w, op) {
      var e = keysError(op, ['op', 'id', 'content_rev']);
      if (e) return e;
      if (!optionalRev(op.content_rev)) return bad('content_rev');
      if (core.isUuid(op.id) && w.removed[op.id] && !core.own(w.cards, op.id)) return null; // already removed in this batch
      var found = find(w.cards, op.id);
      if (found.error) return found.error;
      var c = found.item;
      connectorsOf(w, c.id).forEach(function (cid) { dropConnector(w, w.connectors[cid]); });
      delete w.cards[c.id];
      w.counts.cards--;
      if (c.alias && w.aliases[c.alias] === c.id) delete w.aliases[c.alias];
      w.removed[c.id] = true;
      record(w, { op: 'card.remove', id: c.id }, { op: 'card.add', card: core.copy(c), restore: true });
      return null;
    }

    /* ---------------------------------------------------------------- connectors */

    function dropConnector(w, con) {
      delete w.connectors[con.id];
      w.counts.connectors--;
      linkConnector(w, con, false);
      w.removed[con.id] = true;
      record(w, { op: 'connector.remove', id: con.id }, { op: 'connector.add', connector: core.copy(con), restore: true });
    }

    function connectorAdd(w, op) {
      var e = keysError(op, ['op', 'connector', 'restore']);
      if (e) return e;
      var c = op.connector;
      if (!core.isObj(c) || (op.restore !== undefined && typeof op.restore !== 'boolean')) return bad('connector');
      if ((e = keysError(c, core.CONNECTOR_KEYS))) return e;
      var restore = op.restore === true;
      if (!core.isUuid(c.id)) return bad('connector.id');
      if (exists(w, c.id)) return fail('exists');
      if (!core.isUuid(c.from) || !core.isUuid(c.to) || c.from === c.to) return bad('connector ends');
      if (!core.own(w.cards, c.from) || !core.own(w.cards, c.to)) return fail('missing_target');
      var con = {
        id: c.id, from: c.from, to: c.to, label: c.label === undefined ? '' : c.label, style: c.style === undefined ? 'solid' : c.style,
        tone: c.tone === undefined ? null : c.tone, ends: c.ends === undefined ? 'end' : c.ends,
        content_rev: restore && c.content_rev !== undefined ? c.content_rev : 0,
      };
      if (!CONNECTOR_EDIT.label(con.label) || !CONNECTOR_EDIT.style(con.style) || !core.isTone(con.tone) || !CONNECTOR_EDIT.ends(con.ends) || !core.isRev(con.content_rev)) {
        return bad('connector fields');
      }
      if (w.counts.connectors >= LIMITS.connectors) return fail('limit', { limit: 'connectors' });
      w.connectors[con.id] = con;
      w.counts.connectors++;
      linkConnector(w, con, true);
      delete w.removed[con.id];
      w.grows = true;
      var applied = { op: 'connector.add', connector: core.copy(con) };
      if (restore) applied.restore = true;
      record(w, applied, { op: 'connector.remove', id: con.id, content_rev: con.content_rev });
      return null;
    }

    function connectorEdit(w, op) {
      var e = keysError(op, ['op', 'id', 'content_rev', 'label', 'style', 'tone', 'ends']);
      if (e) return e;
      var found = find(w.connectors, op.id);
      if (found.error) return found.error;
      var con = found.item;
      if (!core.isRev(op.content_rev)) return bad('content_rev');
      if (op.content_rev !== con.content_rev) return fail('stale', { current: core.copy(con) });
      var f = readFields(op, CONNECTOR_EDIT, con);
      if (f.error) return f.error;
      var next = Object.assign({}, con, f.set, { content_rev: con.content_rev + 1 });
      w.connectors[con.id] = next;
      w.grows = true;
      record(w, Object.assign({ op: 'connector.edit', id: con.id, content_rev: op.content_rev }, f.set),
        Object.assign({ op: 'connector.edit', id: con.id, content_rev: next.content_rev }, f.prev));
      return null;
    }

    function connectorRemove(w, op) {
      var e = keysError(op, ['op', 'id', 'content_rev']);
      if (e) return e;
      if (!optionalRev(op.content_rev)) return bad('content_rev');
      if (core.isUuid(op.id) && w.removed[op.id] && !core.own(w.connectors, op.id)) return null;
      var found = find(w.connectors, op.id);
      if (found.error) return found.error;
      dropConnector(w, found.item);
      return null;
    }

    /* ---------------------------------------------------------------- groups and board */

    function groupAdd(w, op) {
      var e = keysError(op, ['op', 'group', 'restore']);
      if (e) return e;
      var g = op.group;
      if (!core.isObj(g) || (op.restore !== undefined && typeof op.restore !== 'boolean')) return bad('group');
      if ((e = keysError(g, core.GROUP_KEYS))) return e;
      var restore = op.restore === true;
      if (!core.isUuid(g.id)) return bad('group.id');
      if (exists(w, g.id)) return fail('exists');
      if (!GROUP_EDIT.title(g.title)) return bad('group.title');
      var tone = g.tone === undefined ? null : g.tone;
      var geo = readGeometry(g, placement.DEFAULT_SIZES.group);
      if (geo.error) return geo.error;
      var revs = readRevs(g, restore);
      if (!core.isTone(tone) || !revs) return bad('group.tone/revs');
      if (w.counts.groups >= LIMITS.groups) return fail('limit', { limit: 'groups' });
      var alias = takeAlias(w, core.ALIAS_LETTER.group, g.alias, restore);
      if (alias && alias.ok === false) return alias;
      var spot = geo.place ? placement.placeOne(w, { w: geo.w, h: geo.h }) : { x: geo.x, y: geo.y };
      var group = { id: g.id, alias: alias, title: g.title, x: spot.x, y: spot.y, w: geo.w, h: geo.h, tone: tone,
        geo_rev: revs.geo_rev, content_rev: revs.content_rev };
      w.groups[group.id] = group;
      w.counts.groups++;
      if (alias) w.aliases[alias] = group.id;
      delete w.removed[group.id];
      w.grows = true;
      var applied = { op: 'group.add', group: core.copy(group) };
      if (restore) applied.restore = true;
      record(w, applied, { op: 'group.remove', id: group.id, content_rev: group.content_rev });
      return null;
    }

    function groupEdit(w, op) {
      var e = keysError(op, ['op', 'id', 'content_rev', 'title', 'tone']);
      if (e) return e;
      var found = find(w.groups, op.id);
      if (found.error) return found.error;
      var g = found.item;
      if (!core.isRev(op.content_rev)) return bad('content_rev');
      if (op.content_rev !== g.content_rev) return fail('stale', { current: core.copy(g) });
      var f = readFields(op, GROUP_EDIT, g);
      if (f.error) return f.error;
      var next = Object.assign({}, g, f.set, { content_rev: g.content_rev + 1 });
      w.groups[g.id] = next;
      w.grows = true;
      record(w, Object.assign({ op: 'group.edit', id: g.id, content_rev: op.content_rev }, f.set),
        Object.assign({ op: 'group.edit', id: g.id, content_rev: next.content_rev }, f.prev));
      return null;
    }

    function groupPlace(w, op) {
      var e = keysError(op, ['op', 'id', 'x', 'y', 'w', 'h', 'geo_rev']);
      if (e) return e;
      if (!optionalRev(op.geo_rev)) return bad('geo_rev');
      var found = find(w.groups, op.id);
      if (found.error) return found.error;
      var g = found.item;
      var f = readFields(op, GROUP_PLACE, g);
      if (f.error) return f.error;
      var next = Object.assign({}, g, f.set, { geo_rev: g.geo_rev + 1 });
      w.groups[g.id] = next;
      record(w, Object.assign({ op: 'group.place', id: g.id }, f.set), Object.assign({ op: 'group.place', id: g.id }, f.prev, { geo_rev: next.geo_rev }));
      return null;
    }

    function groupRemove(w, op) {
      var e = keysError(op, ['op', 'id', 'content_rev']);
      if (e) return e;
      if (!optionalRev(op.content_rev)) return bad('content_rev');
      if (core.isUuid(op.id) && w.removed[op.id] && !core.own(w.groups, op.id)) return null;
      var found = find(w.groups, op.id);
      if (found.error) return found.error;
      var g = found.item;
      Object.keys(w.cards).sort().forEach(function (id) {
        if (w.cards[id].group_id === g.id) groupAssign(w, { op: 'group.assign', card_id: id, group_id: null });
      });
      delete w.groups[g.id];
      w.counts.groups--;
      if (g.alias && w.aliases[g.alias] === g.id) delete w.aliases[g.alias];
      w.removed[g.id] = true;
      record(w, { op: 'group.remove', id: g.id }, { op: 'group.add', group: core.copy(g), restore: true });
      return null;
    }

    function groupAssign(w, op) {
      var e = keysError(op, ['op', 'card_id', 'group_id', 'geo_rev']);
      if (e) return e;
      if (!optionalRev(op.geo_rev)) return bad('geo_rev');
      var found = find(w.cards, op.card_id);
      if (found.error) return found.error;
      var c = found.item;
      if (op.group_id !== null) {
        var g = find(w.groups, op.group_id);
        if (g.error) return g.error;
      }
      var next = Object.assign({}, c, { group_id: op.group_id, geo_rev: c.geo_rev + 1, updated_by: w.actor, updated_at: w.now });
      w.cards[c.id] = next;
      w.grows = true;
      record(w, { op: 'group.assign', card_id: c.id, group_id: op.group_id },
        { op: 'group.assign', card_id: c.id, group_id: c.group_id, geo_rev: next.geo_rev });
      return null;
    }

    function boardRename(w, op) {
      var e = keysError(op, ['op', 'name', 'expect']);
      if (e) return e;
      if (!core.isLine(op.name, FIELD_MAX.name, false)) return bad('name');
      if (op.expect !== undefined && !core.isLine(op.expect, FIELD_MAX.name, false)) return bad('expect');
      var prev = w.name;
      w.name = op.name;
      w.grows = true;
      record(w, { op: 'board.rename', name: op.name }, { op: 'board.rename', name: prev, expect: op.name });
      return null;
    }

    var HANDLERS = {
      'card.add': cardAdd, 'card.edit': cardEdit, 'card.place': cardPlace, 'card.remove': cardRemove,
      'connector.add': connectorAdd, 'connector.edit': connectorEdit, 'connector.remove': connectorRemove,
      'group.add': groupAdd, 'group.edit': groupEdit, 'group.place': groupPlace, 'group.remove': groupRemove,
      'group.assign': groupAssign, 'board.rename': boardRename,
    };

    function applyOp(w, op, anchorId) {
      if (!core.isObj(op) || typeof op.op !== 'string' || !hasOwn.call(HANDLERS, op.op)) return bad('op');
      return HANDLERS[op.op](w, op, anchorId);
    }

    /* ---------------------------------------------------------------- batches */

    function withIndex(result, index) {
      result.op_index = index;
      return result;
    }

    function checkBatch(board, batch) {
      if (!core.isObj(board) || !core.isObj(board.cards) || !core.isObj(board.connectors) || !core.isObj(board.groups) || !Array.isArray(board.recent_batches)) {
        return bad('board');
      }
      if (!core.isObj(batch)) return bad('batch');
      var e = keysError(batch, ['batch_id', 'board_id', 'actor', 'now', 'ops']);
      if (e) return e;
      if (!core.isToken(batch.batch_id)) return bad('batch_id');
      if (batch.board_id !== board.id) return bad('board_id');
      if (!core.isToken(batch.actor)) return bad('actor');
      if (batch.now !== undefined && !core.isIso(batch.now)) return bad('now');
      if (!Array.isArray(batch.ops) || batch.ops.length === 0) return bad('ops');
      if (batch.ops.length > TOTAL_OPS_MAX) return fail('limit', { limit: 'batch_ops' });
      return null;
    }

    /** Where each unplaced card.add goes: the other end of the first connector.add that names it. */
    function findAnchors(ops) {
      var pending = Object.create(null);
      var anchors = Object.create(null);
      ops.forEach(function (op) {
        if (core.isObj(op) && op.op === 'card.add' && core.isObj(op.card) && op.card.x === undefined && core.isUuid(op.card.id)) pending[op.card.id] = true;
      });
      ops.forEach(function (op) {
        if (!core.isObj(op) || op.op !== 'connector.add' || !core.isObj(op.connector)) return;
        var from = op.connector.from;
        var to = op.connector.to;
        if (core.isUuid(from) && core.isUuid(to)) {
          if (pending[from] && !anchors[from]) anchors[from] = to;
          if (pending[to] && !anchors[to]) anchors[to] = from;
        }
      });
      return anchors;
    }

    function sizeError(w, board, batchId) {
      if (!w.grows) return null;
      var next = finish(w, batchId, w.now).board;
      var bytes = core.boardBytes(next);
      if (bytes <= LIMITS.document_bytes || bytes <= core.boardBytes(board)) return null;
      return fail('limit', { limit: 'document_bytes' });
    }

    function finish(w, batchId, now) {
      var board = w.board;
      var ring = board.recent_batches.concat([batchId]);
      if (ring.length > core.RECENT_BATCHES) ring = ring.slice(ring.length - core.RECENT_BATCHES);
      var next = {
        schema_version: board.schema_version, id: board.id, project_id: board.project_id, name: w.name, rev: board.rev + 1,
        next_alias: w.nextAlias, created_at: board.created_at, updated_at: now, recent_batches: ring,
        cards: w.cards, connectors: w.connectors, groups: w.groups,
      };
      return {
        board: next,
        applied: { batch_id: batchId, board_id: board.id, actor: w.actor, now: now, ops: w.applied },
        inverse: { batch_id: ('undo:' + batchId).slice(0, 200), board_id: board.id, actor: w.actor, ops: w.inverse.slice().reverse() },
      };
    }

    function applyBatchInner(board, batch, context) {
      var err = checkBatch(board, batch);
      if (err) return withIndex(err, -1);
      if (board.recent_batches.indexOf(batch.batch_id) >= 0) return { ok: true, duplicate: true, board: board, applied: null, inverse: null };
      var authority = context.authority === true;
      var now = !authority && core.isIso(batch.now) ? batch.now : context.now;
      if (!core.isIso(now)) return withIndex(bad('context.now'), -1);
      var additions = 0;
      batch.ops.forEach(function (op) { if (!(core.isObj(op) && REMOVALS[op.op] === true)) additions++; });
      if (context.replay !== true && additions > LIMITS.batch_ops) return withIndex(fail('limit', { limit: 'batch_ops' }), -1);
      var w = begin(board, batch.actor, now, authority);
      var anchors = findAnchors(batch.ops);
      var lastAddition = -1;
      for (var i = 0; i < batch.ops.length; i++) {
        var op = batch.ops[i];
        var addId = core.isObj(op) && op.op === 'card.add' && core.isObj(op.card) && core.isUuid(op.card.id) ? op.card.id : null;
        var res = applyOp(w, op, addId ? anchors[addId] : undefined);
        if (res) return withIndex(res, i);
        if (REMOVALS[op.op] !== true) lastAddition = i;
      }
      var big = sizeError(w, board, batch.batch_id);
      if (big) return withIndex(big, lastAddition);
      var out = finish(w, batch.batch_id, now);
      return { ok: true, board: out.board, applied: out.applied, inverse: out.inverse };
    }

    /** Applies a batch atomically. context: { now, authority, replay }; replay: an applied batch, derived operations included. */
    function applyBatch(board, batch, context) {
      try {
        return applyBatchInner(board, batch, core.isObj(context) ? context : {});
      } catch (e) {
        return withIndex(bad('unreadable'), -1);
      }
    }

    function revMoved(map, id, field, expected, reason) {
      var item = core.own(map, id);
      if (!item) return 'missing_target';
      return expected !== undefined && item[field] !== expected ? reason : null;
    }

    /** Why undo must leave this inverse operation alone, or null to try it. */
    function skipReason(w, op) {
      if (!core.isObj(op)) return null;
      switch (op.op) {
        case 'card.edit': return revMoved(w.cards, op.id, 'content_rev', op.content_rev, 'changed');
        case 'card.place': return revMoved(w.cards, op.id, 'geo_rev', op.geo_rev, 'moved');
        case 'group.assign': return revMoved(w.cards, op.card_id, 'geo_rev', op.geo_rev, 'moved');
        case 'connector.edit':
        case 'connector.remove': return revMoved(w.connectors, op.id, 'content_rev', op.content_rev, 'changed');
        case 'group.edit': return revMoved(w.groups, op.id, 'content_rev', op.content_rev, 'changed');
        case 'group.place': return revMoved(w.groups, op.id, 'geo_rev', op.geo_rev, 'moved');
        case 'card.remove':
          return revMoved(w.cards, op.id, 'content_rev', op.content_rev, 'changed') || (connectorsOf(w, op.id).length ? 'referenced' : null);
        case 'group.remove':
          return revMoved(w.groups, op.id, 'content_rev', op.content_rev, 'changed') || (groupHasCards(w, op.id) ? 'referenced' : null);
        case 'board.rename': return op.expect !== undefined && op.expect !== w.name ? 'changed' : null;
        default: return null;
      }
    }

    function targetId(op) {
      if (!core.isObj(op)) return null;
      var candidates = [op.id, op.card_id, core.isObj(op.card) && op.card.id, core.isObj(op.connector) && op.connector.id, core.isObj(op.group) && op.group.id];
      for (var i = 0; i < candidates.length; i++) if (core.isUuid(candidates[i])) return candidates[i];
      return null;
    }

    function applyInverseInner(board, inverse, context) {
      var err = checkBatch(board, inverse);
      if (err) return withIndex(err, -1);
      var batchId = context.batch_id !== undefined ? context.batch_id : inverse.batch_id;
      if (!core.isToken(batchId)) return withIndex(bad('batch_id'), -1);
      if (board.recent_batches.indexOf(batchId) >= 0) return { ok: true, duplicate: true, board: board, applied: null, inverse: null, skipped: [] };
      if (!core.isIso(context.now)) return withIndex(bad('context.now'), -1);
      var w = begin(board, inverse.actor, context.now, context.authority === true);
      var skipped = [];
      var steps = core.inverseSteps();
      inverse.ops.forEach(function (raw, i) {
        var op = steps.read(w, raw);
        var reason = skipReason(w, op);
        if (!reason) {
          var res = applyOp(w, op, undefined);
          if (res) reason = res.reason; else steps.took(op);
        }
        if (reason) skipped.push({ op_index: i, op: core.isObj(op) && hasOwn.call(HANDLERS, op.op) ? op.op : null, id: targetId(op), reason: reason });
      });
      if (!w.applied.length) {
        return { ok: true, board: board, applied: { batch_id: batchId, board_id: board.id, actor: w.actor, now: w.now, ops: [] }, inverse: null, skipped: skipped };
      }
      var big = sizeError(w, board, batchId);
      if (big) return withIndex(big, -1);
      var out = finish(w, batchId, w.now);
      return { ok: true, board: out.board, applied: out.applied, inverse: out.inverse, skipped: skipped };
    }

    /**
     * Undo: applies an inverse from applyBatch, operation by operation, skipping (with a reason) each
     * one whose item moved on or is now referred to. context: { now, authority, batch_id? }; pass a
     * fresh batch_id per undo or redo so the duplicate ring does not swallow a later one. The returned
     * `inverse` is the redo.
     */
    function applyInverse(board, inverse, context) {
      try {
        return applyInverseInner(board, inverse, core.isObj(context) ? context : {});
      } catch (e) {
        return withIndex(bad('unreadable'), -1);
      }
    }

    return { applyBatch: applyBatch, applyInverse: applyInverse };
  };
});
