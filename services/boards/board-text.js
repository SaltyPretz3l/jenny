/* services/boards/board-text.js – a project board as text, and the line parser (UMD)
 *
 * Plan PROJECT_BOARD_2026-11-13 sections 7.2 and 7.4. `boardToText` writes exactly the grammar the
 * model writes back, so a model that copies what it sees is correct:
 *
 *   board Auth redesign
 *   group g1 Open questions
 *   note n3 Do we keep refresh tokens? in g1
 *     | Mobile needs them for offline use.
 *   file f2 src/auth/session.ts in g1
 *   n3 -> f2 blocks
 *   selected n3 f2
 *
 * Every line of a card's content after its first starts with two spaces and "| ", so card text can
 * never start a statement (the parser also takes "| " with no indent). No coordinates go either way. Over the budget, selected cards are sent
 * whole first (up to the 24,000-character ceiling), then the cards nearest them; a cut card ends with
 * `...(+N not shown)` and the cards left out are counted on one line.
 *
 * `parseBoardText` turns lines into typed statements with per-line errors and stops there: resolving
 * aliases, temporary names and "sent whole" against a board belongs to the proposal reader.
 * Loaded directly by board-model.js, which re-exports both functions.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.jennyBoardText = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TEXT_BUDGET = Object.freeze({ default: 6000, min: 2000, max: 24000 });
  var OMIT_RESERVE = 40;
  var HEAD_TITLE_MIN = 20;
  var MAX_PARSE_CHARS = 1024 * 1024;
  var MAX_LINE_CHARS = 20000;
  var MAX_SELECTED = 2000;
  var CONT = '  | ';
  var NAME = '[A-Za-z](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?';
  var NAME_RE = new RegExp('^' + NAME + '$');
  var ARROW_RE = new RegExp('^(' + NAME + ')\\s*(<->|-->|->)\\s*(' + NAME + ')(?:\\s+(.*))?$');
  var AS_RE = new RegExp('^(?:(.*\\S)\\s+)?as\\s+(' + NAME + ')$');
  var IN_RE = new RegExp('^(?:(.*\\S)\\s+)?in\\s+(' + NAME + ')$');
  var MOVE_RE = new RegExp('^(' + NAME + ')\\s+in\\s+(' + NAME + ')$');
  var CONT_RE = /^[ \t]*\| ?(.*)$/; // the indent is optional on the way in: small models drop it, and no statement starts with "|"
  var CUT_RE = /\.\.\.\(\+(\d{1,3}(?:,\d{3})*) not shown\)$/;
  var OMITTED_RE = /^\.\.\.\(\+(\d{1,3}(?:,\d{3})*) cards? not shown\)$/;
  var URL_RE = /^https?:\/\/[^\s/?#]+\S*$/i;
  var GROUP_ALIAS_RE = /^g[1-9][0-9]*$/;
  var CARD_ALIAS_RE = { note: /^n[1-9][0-9]*$/, file: /^f[1-9][0-9]*$/, link: /^l[1-9][0-9]*$/, image: /^i[1-9][0-9]*$/,
    chat: /^c[1-9][0-9]*$/, diagram: /^d[1-9][0-9]*$/ };
  var CONT_FIELD = { note: 'text', append: 'text', edit: 'text', chat: 'excerpt', diagram: 'scene' };
  var ARROWS = { '->': { style: 'solid', ends: 'end' }, '-->': { style: 'dashed', ends: 'end' }, '<->': { style: 'solid', ends: 'both' } };
  var hasOwn = Object.prototype.hasOwnProperty;

  function own(map, key) { return map && typeof key === 'string' && hasOwn.call(map, key) ? map[key] : undefined; }
  function values(map) {
    var out = [];
    for (var k in map) if (hasOwn.call(map, k)) out.push(map[k]);
    return out;
  }
  function aliasNum(alias) { return alias ? Number(alias.slice(1)) : Infinity; }
  function commas(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function linesLength(lines) { return lines.reduce(function (n, l) { return n + l.length + 1; }, 0); }
  function arrowOf(con) { return con.ends === 'both' ? '<->' : con.style === 'dashed' ? '-->' : '->'; }

  /* ------------------------------------------------------------------ board to text */

  /** A card as { head, inline, content, tail }: inline content puts its first line on the head line. */
  function cardParts(card, board, selected) {
    var d = card.data || {};
    var g = card.group_id ? own(board.groups, card.group_id) : null;
    var tail = g && g.alias ? ' in ' + g.alias : '';
    var head = card.kind + ' ' + card.alias;
    var titled = function (t) { return head + (t ? ' ' + t : ''); };
    switch (card.kind) {
      case 'note': return { head: head, inline: true, content: d.text || '', tail: tail };
      case 'file': return { head: head + ' ' + d.path, inline: false, content: '', tail: tail };
      case 'link': return { head: head + ' ' + d.url + (d.title ? ' ' + d.title : ''), inline: false, content: '', tail: tail };
      case 'image': return { head: titled(d.alt), inline: false, content: '', tail: tail };
      case 'chat': return { head: titled(d.title), inline: false, content: d.excerpt || '', tail: tail };
      default: return { head: titled(d.title), inline: false, content: selected ? d.scene || '' : '', tail: tail };
    }
  }

  function partsLines(p, content) {
    var lines = content === '' ? [] : content.split('\n');
    var out;
    if (p.inline) {
      var first = lines.length ? lines.shift() : '';
      out = [p.head + (first ? ' ' + first : '') + p.tail];
    } else {
      out = [p.head + p.tail];
    }
    for (var i = 0; i < lines.length; i++) out.push(CONT + lines[i]);
    return out;
  }

  /** The longest cut of a card's content that fits in `allowance` characters, or null. */
  function cutLines(p, allowance) {
    var content = p.content;
    if (!content) return null;
    var render = function (keep) { return partsLines(p, content.slice(0, keep) + '...(+' + commas(content.length - keep) + ' not shown)'); };
    if (linesLength(render(0)) > allowance) return null;
    var lo = 0;
    var hi = content.length - 1;
    while (lo < hi) {
      var mid = Math.ceil((lo + hi) / 2);
      if (linesLength(render(mid)) <= allowance) lo = mid;
      else hi = mid - 1;
    }
    var code = content.charCodeAt(lo - 1);
    if (lo > 0 && code >= 0xd800 && code <= 0xdbff) lo -= 1; // never split a surrogate pair
    return render(lo);
  }

  /** Whether a card listed in full gives its full content (an image's bytes and an unselected diagram's scene never go). */
  function sentWhole(card, selected) {
    if (card.kind === 'image') return false;
    return card.kind !== 'diagram' || selected;
  }

  function readingOrder(groupIndex, groupCount) {
    var rank = function (c) { var i = c.group_id ? groupIndex[c.group_id] : undefined; return i === undefined ? groupCount : i; };
    return function (a, b) {
      return rank(a) - rank(b) || a.y - b.y || a.x - b.x || aliasNum(a.alias) - aliasNum(b.alias) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    };
  }

  function selectionOf(cards, selected) {
    var set = Object.create(null);
    if (!Array.isArray(selected)) return set;
    var byName = Object.create(null);
    cards.forEach(function (c) {
      byName[c.id] = c.id;
      if (c.alias) byName[c.alias] = c.id;
    });
    selected.slice(0, MAX_SELECTED).forEach(function (s) { if (typeof s === 'string' && byName[s]) set[byName[s]] = true; });
    return set;
  }

  /** Selected cards first, then the rest by distance to the nearest selected card. */
  function priority(cards, sel) {
    var chosen = cards.filter(function (c) { return sel[c.id]; });
    var rest = cards.filter(function (c) { return !sel[c.id]; });
    if (!chosen.length) return cards.slice();
    var centre = function (c) { return { x: c.x + c.w / 2, y: c.y + c.h / 2 }; };
    var points = chosen.map(centre);
    var dist = new Map();
    rest.forEach(function (c, i) {
      var p = centre(c);
      var best = Infinity;
      points.forEach(function (q) { best = Math.min(best, (p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y)); });
      dist.set(c, { d: best, i: i }); // the reading order breaks ties
    });
    rest.sort(function (a, b) { return dist.get(a).d - dist.get(b).d || dist.get(a).i - dist.get(b).i; });
    return chosen.concat(rest);
  }

  /**
   * The board's name and its groups, one line each. Cards are cut to fit the budget but these lines are not, so once they
   * would take half of it (a name and fifty titles of 200 characters are 10,000) every title is cut to the same length.
   */
  function headLines(board, groups, budget) {
    var build = function (max) {
      var clip = function (t) {
        if (t.length <= max) return t;
        var end = max - 1;
        var code = t.charCodeAt(end - 1);
        return t.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end) + '…'; // never split a surrogate pair
      };
      return ['board ' + clip(board.name)].concat(groups.map(function (g) { return 'group ' + g.alias + ' ' + clip(g.title); }));
    };
    var head = build(Infinity);
    var room = Math.floor(budget / 2);
    return linesLength(head) <= room ? head : build(Math.max(HEAD_TITLE_MIN, Math.floor(room / (groups.length + 1)) - 12));
  }

  function render(board, opts) {
    var b = opts.budget;
    var budget = typeof b === 'number' && isFinite(b) ? Math.min(TEXT_BUDGET.max, Math.max(TEXT_BUDGET.min, Math.floor(b))) : TEXT_BUDGET.default;
    var groups = values(board.groups).filter(function (g) { return g.alias; });
    groups.sort(function (x, y) { return aliasNum(x.alias) - aliasNum(y.alias); });
    var groupIndex = Object.create(null);
    groups.forEach(function (g, i) { groupIndex[g.id] = i; });
    var cards = values(board.cards).sort(readingOrder(groupIndex, groups.length));
    var position = new Map();
    cards.forEach(function (c, i) { position.set(c.id, i); });
    var sel = selectionOf(cards, opts.selected);
    var head = headLines(board, groups, budget);
    var selectedAliases = cards.filter(function (c) { return sel[c.id] && c.alias; }).map(function (c) { return c.alias; });
    var used = linesLength(head) + (selectedAliases.length ? ('selected ' + selectedAliases.join(' ')).length + 1 : 0) + OMIT_RESERVE;
    var byCard = Object.create(null);
    values(board.connectors).forEach(function (con) {
      (byCard[con.from] = byCard[con.from] || []).push(con);
      (byCard[con.to] = byCard[con.to] || []).push(con);
    });
    var conLine = function (con) {
      return board.cards[con.from].alias + ' ' + arrowOf(con) + ' ' + board.cards[con.to].alias + (con.label ? ' ' + con.label : '');
    };
    var included = new Map();
    var shownCons = [];
    var whole = [];
    var omitted = [];
    priority(cards, sel).forEach(function (card) {
      if (!card.alias) { omitted.push(card.id); return; }
      var limit = sel[card.id] ? TEXT_BUDGET.max : budget;
      var cons = (byCard[card.id] || []).filter(function (con) { return included.has(con.from === card.id ? con.to : con.from); });
      var conCost = linesLength(cons.map(conLine));
      var parts = cardParts(card, board, sel[card.id]);
      var lines = partsLines(parts, parts.content);
      var isWhole = used + linesLength(lines) + conCost <= limit;
      if (!isWhole) lines = cutLines(parts, limit - used - conCost);
      if (!lines) { omitted.push(card.alias); return; }
      included.set(card.id, lines);
      used += linesLength(lines) + conCost;
      shownCons = shownCons.concat(cons);
      if (isWhole && sentWhole(card, sel[card.id])) whole.push(card.alias);
    });
    var out = head.slice();
    cards.forEach(function (c) { if (included.has(c.id)) out = out.concat(included.get(c.id)); });
    shownCons.sort(function (x, y) {
      return position.get(x.from) - position.get(y.from) || position.get(x.to) - position.get(y.to) || (x.id < y.id ? -1 : 1);
    });
    shownCons.forEach(function (con) { out.push(conLine(con)); });
    var shownSelected = selectedAliases.filter(function (a) { return omitted.indexOf(a) < 0; });
    if (shownSelected.length) out.push('selected ' + shownSelected.join(' '));
    if (omitted.length) out.push('...(+' + commas(omitted.length) + ' cards not shown)');
    return { text: out.join('\n'), sent_whole: whole, omitted: omitted };
  }

  /**
   * The board as text (plan 7.2). options: { selected: [card ids or aliases], budget: characters,
   * default 6,000, clamped to 2,000..24,000 }. Returns { text, sent_whole: [aliases whose full content
   * is in the text], omitted: [aliases left out, or ids for cards that have no alias yet] }.
   */
  function boardToText(board, options) {
    try {
      return render(board, options && typeof options === 'object' ? options : {});
    } catch (e) {
      return { text: '', sent_whole: [], omitted: [] };
    }
  }

  /* ------------------------------------------------------------------ text to statements */

  function error(line, reason, raw) { return { line: line, kind: 'error', reason: reason, raw: raw }; }

  function splitHead(line) {
    var sp = line.search(/\s/);
    return sp < 0 ? { head: line, rest: '' } : { head: line.slice(0, sp), rest: line.slice(sp).trim() };
  }

  /** Strips a trailing `as <name>` (only for an item without an alias) and `in <group>`, in either order. */
  function splitTail(body, allowAs, allowIn, groupNames) {
    var out = { body: body, as: null, group: null };
    for (var pass = 0; pass < 2; pass++) {
      var m = allowAs && out.as === null ? AS_RE.exec(out.body) : null;
      if (m) { out.as = m[2]; out.body = m[1] || ''; continue; }
      m = allowIn && out.group === null ? IN_RE.exec(out.body) : null;
      if (m && (GROUP_ALIAS_RE.test(m[2]) || groupNames[m[2]] === true)) { out.group = m[2]; out.body = m[1] || ''; continue; }
      break;
    }
    return out;
  }

  function withTail(stmt, t) {
    if (t.group) stmt.group = t.group;
    if (t.as) stmt.as = t.as;
    return stmt;
  }

  function groupStatement(rest, no, line, groupNames) {
    var first = splitHead(rest).head;
    var alias = GROUP_ALIAS_RE.test(first) ? first : null;
    var t = splitTail(alias ? splitHead(rest).rest : rest, alias === null, false, groupNames);
    if (!t.body && !alias) return error(no, 'missing_text', line);
    if (t.as) groupNames[t.as] = true;
    var stmt = { line: no, kind: 'group' };
    if (alias) stmt.alias = alias;
    stmt.title = t.body;
    return withTail(stmt, t);
  }

  function cardStatement(kind, rest, no, line, groupNames) {
    var first = splitHead(rest);
    var alias = CARD_ALIAS_RE[kind].test(first.head) ? first.head : null;
    var body = alias && kind !== 'diagram' ? first.rest : rest;
    var t = splitTail(body, alias === null, true, groupNames);
    var stmt = { line: no, kind: kind };
    if (alias) stmt.alias = alias;
    var m;
    if (kind === 'note') {
      if (!t.body && !alias) return error(no, 'missing_text', line);
      stmt.text = t.body;
    } else if (kind === 'file') {
      if (!t.body) return error(no, 'missing_path', line);
      stmt.path = t.body;
    } else if (kind === 'link') {
      m = /^(\S+)(?:\s+(.*))?$/.exec(t.body);
      if (!m || !URL_RE.test(m[1])) return error(no, 'bad_url', line);
      stmt.url = m[1];
      stmt.title = m[2] || '';
    } else if (kind === 'image') {
      if (!t.body && !alias) return error(no, 'missing_text', line);
      stmt.alt = t.body;
    } else if (kind === 'chat') {
      if (!t.body && !alias) return error(no, 'missing_text', line);
      stmt.title = t.body;
      stmt.excerpt = '';
    } else {
      m = /^(\S+)(?:\s+(.*))?$/.exec(t.body);
      if (!m || !NAME_RE.test(m[1])) return error(no, 'missing_name', line);
      stmt.name = m[1];
      stmt.title = m[2] || '';
      stmt.scene = '';
    }
    return withTail(stmt, t);
  }

  function statement(line, no, groupNames) {
    var parts = splitHead(line);
    var rest = parts.rest;
    var m;
    switch (parts.head) {
      case 'board':
        return rest ? { line: no, kind: 'board', name: rest } : error(no, 'missing_name', line);
      case 'group':
        return groupStatement(rest, no, line, groupNames);
      case 'note': case 'file': case 'link': case 'image': case 'chat': case 'diagram':
        return cardStatement(parts.head, rest, no, line, groupNames);
      case 'selected': {
        var names = rest ? rest.split(/\s+/) : [];
        return names.every(function (n) { return NAME_RE.test(n); }) ? { line: no, kind: 'selected', names: names } : error(no, 'bad_name', line);
      }
      case 'append': case 'edit': {
        var target = splitHead(rest);
        if (!NAME_RE.test(target.head)) return error(no, 'bad_name', line);
        if (!target.rest) return error(no, 'missing_text', line);
        return { line: no, kind: parts.head, target: target.head, text: target.rest };
      }
      case 'move':
        m = MOVE_RE.exec(rest);
        return m ? { line: no, kind: 'move', target: m[1], group: m[2] } : error(no, 'expected_move', line);
      case 'remove':
        return NAME_RE.test(rest) ? { line: no, kind: 'remove', target: rest } : error(no, 'bad_name', line);
      case 'tidy':
        if (!rest) return { line: no, kind: 'tidy', group: null };
        return NAME_RE.test(rest) ? { line: no, kind: 'tidy', group: rest } : error(no, 'bad_name', line);
      default:
        break;
    }
    if ((m = OMITTED_RE.exec(line))) return { line: no, kind: 'omitted', cards: Number(m[1].replace(/,/g, '')) };
    if ((m = ARROW_RE.exec(line))) {
      return { line: no, kind: 'connect', from: m[1], to: m[3], arrow: m[2], style: ARROWS[m[2]].style, ends: ARROWS[m[2]].ends, label: m[4] || '' };
    }
    return error(no, 'unknown', line);
  }

  function stripCut(stmt) {
    var field = { note: 'text', chat: 'excerpt', diagram: 'scene' }[stmt.kind];
    var m = field ? CUT_RE.exec(stmt[field]) : null;
    if (!m) return;
    stmt[field] = stmt[field].slice(0, m.index);
    stmt.cut = Number(m[1].replace(/,/g, ''));
  }

  /**
   * Board text (7.2) or a `board` block's lines (7.4) as statements: one per logical line,
   * { line, kind, ...fields } or { line, kind: 'error', reason, raw }. A continuation line ("  | ")
   * joins the note, chat, diagram, append or edit above it and can never start a statement.
   */
  function parseBoardText(text) {
    if (typeof text !== 'string') return { statements: [] };
    if (text.length > MAX_PARSE_CHARS) return { statements: [error(1, 'too_large', '')] };
    var lines = text.split(/\r\n|\r|\n/);
    var out = [];
    var open = null;
    var groupNames = Object.create(null);
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var no = i + 1;
      if (raw.length > MAX_LINE_CHARS) {
        out.push(error(no, 'line_too_long', raw.slice(0, 200)));
        open = null;
        continue;
      }
      var cont = CONT_RE.exec(raw);
      if (cont) {
        if (!open) { out.push(error(no, 'continuation_without_statement', raw)); continue; }
        open.stmt[open.field] = open.started ? open.stmt[open.field] + '\n' + cont[1] : cont[1];
        open.started = true;
        continue;
      }
      var line = raw.trim();
      open = null;
      if (!line) continue;
      var stmt = statement(line, no, groupNames);
      out.push(stmt);
      var field = hasOwn.call(CONT_FIELD, stmt.kind) ? CONT_FIELD[stmt.kind] : null;
      if (field) open = { stmt: stmt, field: field, started: field === 'text' };
    }
    out.forEach(stripCut);
    return { statements: out };
  }

  return {
    TEXT_BUDGET: TEXT_BUDGET,
    boardToText: boardToText,
    parseBoardText: parseBoardText,
  };
});
