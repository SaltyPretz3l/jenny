'use strict';

/**
 * services/boards/board-proposal-reader.js: a reply's `board` blocks as a list of proposed changes
 * (plan PROJECT_BOARD_2026-11-13 sections 7.4 and 7.5; slice C3).
 *
 * Pure: no IO, no clock. The caller (board-proposals.js) hands in the board as it stands, the closed
 * `board` blocks of one reply, the reply's `sketch` blocks, the aliases that were sent whole in that
 * turn, and the result of the file check for every `file` line. What comes back is data for a person
 * to accept or reject; nothing here changes a board.
 *
 *   readProposal({ board, bodies, sketches, sentWhole, files, makeId, limit })
 *     -> { changes: [change], overflow }
 *
 * A change is { n, line, type, class, state, reason, summary, ... } where
 *   type    note | link | file | group | diagram | connect | append | move | tidy | edit | redraw | remove
 *   class   addition (applied together by "Accept additions"), edit or removal (each needs its own accept, D16)
 *   state   pending, or refused with a reason: the line is kept and shown struck through
 * and the rest is what applying it needs: `ops` (model operations with fresh ids), or `append`, `move`,
 * `tidy` (built against the board as it stands when the change is accepted), plus `target` (the id and
 * content revision the change was written against) for an edit, a redraw or a removal.
 *
 * What a small model gets wrong, and how it is read (nothing else is guessed):
 *   - A new item named like an alias the board does not have (`note n9 ...`) is a new item; the name is
 *     its temporary name inside that block, as `as <name>` is.
 *   - `as <name>` that nothing in the block uses goes back into the text ("ship it as planned") unless
 *     the name repeats a word of the text or looks made up (a digit, `_` or `-`).
 *   - `in g7` where no such group exists goes back into a note's text; other kinds are refused.
 *   - A line that restates the board (the same card, the same connection, `board`, `selected`, the
 *     count of cards not shown) is ignored without a word. A block repeated in the reply counts once.
 *   - One `diagram <name>` line with no `sketch <name>` fence and exactly one unnamed `sketch` fence
 *     in the reply are paired; a first line of that fence that only repeats the name is dropped.
 */

const model = require('./board-model');

const TITLE_MAX = 200; // the model's FIELD_MAX.title (not exported)

const LINE_MAX = 300;
const SHOWN_MAX = 400;
const MADE_UP_RE = /[0-9_-]/;
const hasOwn = Object.prototype.hasOwnProperty;

function own(map, key) { return map && typeof key === 'string' && hasOwn.call(map, key) ? map[key] : undefined; }
function clip(text, max) { const s = String(text == null ? '' : text); return s.length > max ? `${s.slice(0, max - 1)}…` : s; }
function firstLine(text) { return clip(String(text || '').split('\n')[0], 80); }

/** The board's items by alias: { cards: { n3: card }, groups: { g1: group } }. */
function byAlias(board) {
  const cards = Object.create(null);
  const groups = Object.create(null);
  for (const id of Object.keys(board.cards || {})) { const c = board.cards[id]; if (c && c.alias) cards[c.alias] = c; }
  for (const id of Object.keys(board.groups || {})) { const g = board.groups[id]; if (g && g.alias) groups[g.alias] = g; }
  return { cards, groups };
}

function cardLabel(card) {
  const d = card.data || {};
  const text = card.kind === 'note' ? d.text : card.kind === 'file' ? d.path : card.kind === 'link' ? d.title || d.url
    : card.kind === 'image' ? d.alt : d.title;
  return firstLine(text) || card.alias || card.kind;
}

/** The raw source line of a statement, for the review list. */
function sourceLines(body) { return body.split(/\r\n|\r|\n/); }

/** Every `file` path the blocks name, so the caller can check them before reading (the check is async). */
function filePaths(bodies) {
  const out = [];
  for (const body of dedupe(bodies)) {
    for (const stmt of model.parseBoardText(body).statements) {
      if (stmt.kind === 'file' && typeof stmt.path === 'string' && !out.includes(stmt.path)) out.push(stmt.path);
    }
  }
  return out;
}

function dedupe(bodies) {
  const seen = new Set();
  return (Array.isArray(bodies) ? bodies : []).filter((body) => {
    if (typeof body !== 'string' || !body.trim() || seen.has(body)) return false;
    seen.add(body);
    return true;
  });
}

/** The scene for `diagram <name>`: the fence of that name, else the statement's own lines, else the one unnamed pair. */
function sceneFor(stmt, sketches, pairing) {
  const named = sketches.find((s) => s.name && s.name === stmt.name);
  if (named) return named.body;
  if (stmt.scene) return stmt.scene;
  if (pairing && pairing.name === stmt.name) {
    const lines = pairing.body.split('\n');
    if (lines.length > 1 && lines[0].trim() === stmt.name) lines.shift();
    return lines.join('\n');
  }
  return '';
}

function readBlock(ctx, body, blockIndex) {
  const { board, index, sentWhole, files, makeId, sketches, pairing } = ctx;
  const statements = model.parseBoardText(body).statements;
  const raw = sourceLines(body);
  const lineOf = (stmt) => clip((raw[stmt.line - 1] || '').trim(), LINE_MAX);
  const temps = Object.create(null); // temporary name -> { type: 'card' | 'group', id, kind, label, change }
  const used = Object.create(null);
  const out = [];
  const order = (stmt) => blockIndex * 100000 + stmt.line;

  function push(stmt, type, cls, fields) {
    const change = Object.assign({ order: order(stmt), line: lineOf(stmt), type, class: cls, state: 'pending', reason: '', summary: {} }, fields);
    out.push(change);
    return change;
  }
  function refuse(stmt, type, cls, reason, summary) {
    return push(stmt, type, cls, { state: 'refused', reason, summary: summary || {} });
  }
  /** A name in the block: a temporary name first, then the board's alias. */
  function lookup(name) {
    const temp = own(temps, name);
    if (temp) { used[name] = true; return temp; }
    const card = own(index.cards, name);
    if (card) return { type: 'card', id: card.id, kind: card.kind, label: cardLabel(card), card };
    const group = own(index.groups, name);
    if (group) return { type: 'group', id: group.id, label: group.title, group };
    return null;
  }
  function declare(name, entry) { if (name && !own(temps, name)) temps[name] = entry; }

  // Pass 0: groups, so a card may say `in <name>` whichever comes first.
  for (const stmt of statements) {
    if (stmt.kind !== 'group') continue;
    if (stmt.alias && own(index.groups, stmt.alias)) continue; // the board's own line, restated
    if (!stmt.title) { refuse(stmt, 'group', 'addition', 'missing_text'); continue; }
    const id = makeId();
    const change = push(stmt, 'group', 'addition', { summary: { title: stmt.title }, ops: [{ op: 'group.add', group: { id, title: stmt.title } }], asName: stmt.as || '' });
    declare(stmt.as || stmt.alias, { type: 'group', id, label: stmt.title, change });
  }

  // Pass 1: cards.
  for (const stmt of statements) {
    if (!model.CARD_KINDS.includes(stmt.kind)) continue;
    const kind = stmt.kind;
    const existing = stmt.alias ? own(index.cards, stmt.alias) : null;
    if (existing && kind !== 'diagram') {
      const same = kind !== 'note' || stmt.cut !== undefined || stmt.text === (existing.data && existing.data.text);
      if (!same) refuse(stmt, 'note', 'addition', 'exists', { target: stmt.alias });
      continue;
    }
    if (kind === 'image' || kind === 'chat') { refuse(stmt, kind, 'addition', 'unsupported'); continue; }
    if (kind === 'diagram') { readDiagram(stmt, existing); continue; }

    let text = kind === 'note' ? stmt.text : '';
    let groupId = null;
    let groupName = '';
    if (stmt.group) {
      const found = lookup(stmt.group);
      if (found && found.type === 'group') { groupId = found.id; groupName = stmt.group; }
      else if (kind === 'note') text = `${text} in ${stmt.group}`.trim();
      else { refuse(stmt, kind, 'addition', 'unknown_group', { group: stmt.group }); continue; }
    }
    const id = makeId();
    const card = { id, kind };
    if (groupId) card.group_id = groupId;
    let summary;
    let label;
    if (kind === 'note') {
      if (!text) { refuse(stmt, 'note', 'addition', 'missing_text'); continue; }
      card.data = { text };
      summary = { text: clip(text, SHOWN_MAX), group: groupName };
      label = firstLine(text);
    } else if (kind === 'link') {
      card.data = { url: stmt.url, title: stmt.title || '' };
      summary = { url: clip(stmt.url, SHOWN_MAX), title: stmt.title || '', group: groupName };
      label = stmt.title || stmt.url;
    } else {
      const checked = files instanceof Map ? files.get(stmt.path) : null;
      if (!checked || checked.ok !== true) {
        refuse(stmt, 'file', 'addition', checked && typeof checked.reason === 'string' ? checked.reason : 'not_found', { path: clip(stmt.path, SHOWN_MAX) });
        continue;
      }
      card.data = { path: checked.path, title: checked.title || '' };
      summary = { path: checked.path, group: groupName };
      label = checked.path;
    }
    const change = push(stmt, kind, 'addition', { summary, ops: [{ op: 'card.add', card }], asName: stmt.as || '' });
    declare(stmt.as || stmt.alias, { type: 'card', id, kind, label: clip(label, 80), change });
  }

  function readDiagram(stmt, existing) {
    const scene = sceneFor(stmt, sketches, pairing);
    if (existing) {
      if (existing.kind !== 'diagram') { refuse(stmt, 'diagram', 'addition', 'exists', { target: stmt.alias }); return; }
      const title = stmt.title || (existing.data && existing.data.title) || '';
      const sameScene = !scene || scene === (existing.data && existing.data.scene);
      if (sameScene && title === ((existing.data && existing.data.title) || '')) return; // restated
      const summary = { target: stmt.alias, title, lines: scene ? scene.split('\n').length : 0 };
      if (!sentWhole.has(stmt.alias)) { refuse(stmt, 'redraw', 'edit', 'not_sent_whole', summary); return; }
      const data = sameScene ? { title } : { scene, title };
      push(stmt, 'redraw', 'edit', { summary, target: { id: existing.id, content_rev: existing.content_rev },
        ops: [{ op: 'card.edit', id: existing.id, content_rev: existing.content_rev, data }] });
      return;
    }
    const summary = { title: stmt.title || stmt.name, lines: scene ? scene.split('\n').length : 0 };
    if (!scene.trim()) { refuse(stmt, 'diagram', 'addition', 'no_drawing', summary); return; }
    let groupId = null;
    if (stmt.group) {
      const found = lookup(stmt.group);
      if (!found || found.type !== 'group') { refuse(stmt, 'diagram', 'addition', 'unknown_group', summary); return; }
      groupId = found.id;
    }
    const id = makeId();
    const card = { id, kind: 'diagram', data: { scene, title: stmt.title || '' } };
    if (groupId) card.group_id = groupId;
    const change = push(stmt, 'diagram', 'addition', { summary, ops: [{ op: 'card.add', card }], asName: stmt.as || '' });
    declare(stmt.as || stmt.name, { type: 'card', id, kind: 'diagram', label: clip(summary.title, 80), change });
  }

  // Pass 2: everything that names an item.
  const connected = new Set();
  for (const stmt of statements) {
    switch (stmt.kind) {
      case 'error': refuse(stmt, 'unknown', 'addition', stmt.reason || 'unknown'); break;
      case 'connect': readConnect(stmt); break;
      case 'append': readAppend(stmt); break;
      case 'edit': readEdit(stmt); break;
      case 'move': readMove(stmt); break;
      case 'remove': readRemove(stmt); break;
      case 'tidy': readTidy(stmt); break;
      default: break; // board, selected, omitted: the board's own lines
    }
  }

  function readConnect(stmt) {
    const from = lookup(stmt.from);
    const to = lookup(stmt.to);
    const summary = { from: from ? from.label : stmt.from, to: to ? to.label : stmt.to, label: stmt.label || '', arrow: stmt.arrow };
    if (!from || !to) { refuse(stmt, 'connect', 'addition', 'unknown_name', summary); return; }
    if (from.type !== 'card' || to.type !== 'card') { refuse(stmt, 'connect', 'addition', 'not_a_card', summary); return; }
    if (from.id === to.id) { refuse(stmt, 'connect', 'addition', 'invalid', summary); return; }
    const key = `${from.id}>${to.id}>${stmt.label || ''}`;
    if (connected.has(key)) return;
    connected.add(key);
    const cons = board.connectors || {};
    for (const id of Object.keys(cons)) {
      const con = cons[id];
      const sameWay = con.from === from.id && con.to === to.id;
      const otherWay = con.from === to.id && con.to === from.id && (con.ends === 'both' || stmt.ends === 'both');
      if ((sameWay || otherWay) && (con.label || '') === (stmt.label || '')) return; // the board's own line, restated
    }
    push(stmt, 'connect', 'addition', { summary,
      ops: [{ op: 'connector.add', connector: { id: makeId(), from: from.id, to: to.id, label: stmt.label || '', style: stmt.style, ends: stmt.ends } }] });
  }

  function existingCard(stmt, type, cls) {
    const found = lookup(stmt.target);
    if (!found || !found.card) {
      refuse(stmt, type, cls, found ? 'not_on_board' : 'unknown_name', { target: stmt.target });
      return null;
    }
    return found.card;
  }

  function readAppend(stmt) {
    const card = existingCard(stmt, 'append', 'addition');
    if (!card) return;
    const summary = { target: card.alias, label: cardLabel(card), text: clip(stmt.text, SHOWN_MAX) };
    if (card.kind !== 'note') { refuse(stmt, 'append', 'addition', 'not_a_note', summary); return; }
    push(stmt, 'append', 'addition', { summary, append: { id: card.id, text: stmt.text } });
  }

  // `edit <group> <new title>` renames a group. Its title is always sent whole, so there is no sent-whole rule here.
  function readRetitle(stmt, group) {
    const title = String(stmt.text || '').trim();
    const summary = { target: group.alias, before: group.title, after: clip(title, TITLE_MAX) };
    if (!title) { refuse(stmt, 'edit', 'edit', 'missing_text', { target: group.alias }); return; }
    if (/[\r\n]/.test(title) || title.length > TITLE_MAX) { refuse(stmt, 'edit', 'edit', 'invalid', summary); return; }
    if (title === group.title) return;
    push(stmt, 'edit', 'edit', { summary, target: { id: group.id, content_rev: group.content_rev, group: true },
      ops: [{ op: 'group.edit', id: group.id, content_rev: group.content_rev, title }] });
  }

  function readEdit(stmt) {
    const named = lookup(stmt.target);
    if (named && named.group) { readRetitle(stmt, named.group); return; }
    const card = existingCard(stmt, 'edit', 'edit');
    if (!card) return;
    const before = (card.data && card.data.text) || '';
    const summary = { target: card.alias, before: clip(before, model.LIMITS.note_chars), after: clip(stmt.text, model.LIMITS.note_chars) };
    if (card.kind !== 'note') { refuse(stmt, 'edit', 'edit', 'not_a_note', { target: card.alias }); return; }
    if (stmt.text === before) return;
    if (!sentWhole.has(card.alias)) { refuse(stmt, 'edit', 'edit', 'not_sent_whole', summary); return; }
    push(stmt, 'edit', 'edit', { summary, target: { id: card.id, content_rev: card.content_rev },
      ops: [{ op: 'card.edit', id: card.id, content_rev: card.content_rev, data: { text: stmt.text } }] });
  }

  // `move` and `tidy` change where a person's cards sit, so each waits for its own accept (D16): class `edit`.
  function readMove(stmt) {
    const card = existingCard(stmt, 'move', 'edit');
    if (!card) return;
    const group = lookup(stmt.group);
    const summary = { target: card.alias, label: cardLabel(card), group: group && group.type === 'group' ? group.label : stmt.group };
    if (!group || group.type !== 'group') { refuse(stmt, 'move', 'edit', 'unknown_group', summary); return; }
    if (card.group_id === group.id) return;
    push(stmt, 'move', 'edit', { summary, move: { id: card.id, group_id: group.id } });
  }

  function readRemove(stmt) {
    const found = lookup(stmt.target);
    if (!found || (!found.card && !found.group)) {
      refuse(stmt, 'remove', 'removal', found ? 'not_on_board' : 'unknown_name', { target: stmt.target });
      return;
    }
    if (found.card) {
      push(stmt, 'remove', 'removal', { summary: { target: found.card.alias, kind: found.card.kind, label: cardLabel(found.card) },
        target: { id: found.card.id, content_rev: found.card.content_rev }, ops: [{ op: 'card.remove', id: found.card.id }] });
      return;
    }
    push(stmt, 'remove', 'removal', { summary: { target: found.group.alias, kind: 'group', label: found.group.title },
      target: { id: found.group.id, content_rev: found.group.content_rev, group: true }, ops: [{ op: 'group.remove', id: found.group.id }] });
  }

  function readTidy(stmt) {
    if (!stmt.group) { push(stmt, 'tidy', 'edit', { summary: { group: '' }, tidy: { group_id: null } }); return; }
    const group = lookup(stmt.group);
    if (!group || group.type !== 'group') { refuse(stmt, 'tidy', 'edit', 'unknown_group', { group: stmt.group }); return; }
    push(stmt, 'tidy', 'edit', { summary: { group: group.label }, tidy: { group_id: group.id } });
  }

  // An `as <name>` nothing used was probably prose: put it back, unless it reads as a made-up name.
  for (const change of out) {
    const name = change.asName;
    delete change.asName;
    if (!name || used[name] || change.state !== 'pending' || MADE_UP_RE.test(name)) continue;
    const op = change.ops && change.ops[0];
    const holder = op && op.op === 'card.add' && op.card.kind === 'note' ? op.card.data : op && op.op === 'group.add' ? op.group : null;
    const field = holder && (op.op === 'group.add' ? 'title' : 'text');
    if (!holder) continue;
    const words = String(holder[field]).toLowerCase().split(/[^a-z0-9]+/);
    if (words.includes(name.toLowerCase())) continue;
    holder[field] = `${holder[field]} as ${name}`;
    if (field === 'text') change.summary.text = clip(holder[field], SHOWN_MAX); else change.summary.title = holder[field];
  }
  return out;
}

/** See the file header. */
function readProposal(input) {
  const board = input && input.board;
  if (!board || typeof board !== 'object' || !board.cards || !board.groups) return { changes: [], overflow: 0 };
  const bodies = dedupe(input.bodies);
  const sketches = (Array.isArray(input.sketches) ? input.sketches : []).filter((s) => s && typeof s.body === 'string');
  const limit = Number.isInteger(input.limit) && input.limit > 0 ? input.limit : model.LIMITS.proposal_ops;
  const ctx = {
    board, index: byAlias(board), sketches, files: input.files, makeId: input.makeId,
    sentWhole: new Set(Array.isArray(input.sentWhole) ? input.sentWhole : []), pairing: null,
  };
  // The one unnamed pair (7.4): exactly one diagram line without a fence of its name, exactly one fence without a name.
  const orphans = [];
  bodies.forEach((body) => model.parseBoardText(body).statements.forEach((stmt) => {
    if (stmt.kind === 'diagram' && !stmt.scene && !sketches.some((s) => s.name && s.name === stmt.name)) orphans.push(stmt.name);
  }));
  const unnamed = sketches.filter((s) => !s.name);
  if (orphans.length === 1 && unnamed.length === 1) ctx.pairing = { name: orphans[0], body: unnamed[0].body };
  let changes = [];
  bodies.forEach((body, i) => { changes = changes.concat(readBlock(ctx, body, i)); });
  changes.sort((a, b) => a.order - b.order);
  const overflow = Math.max(0, changes.length - limit);
  changes = changes.slice(0, limit);
  changes.forEach((change, i) => { change.n = i + 1; delete change.order; });
  return { changes, overflow };
}

module.exports = { readProposal, filePaths, LINE_MAX };
