/* renderer/inventory/board-card.js
 *
 * One card on the board canvas. The primitive renders a positioned, focusable
 * element with a header (kind glyph and title), a body slot and a meta line, and
 * mirrors states as data attributes the style sheet reads. It never rebuilds the
 * body node, so a caller may append its own picture to [data-card-body]. Every
 * prop is untrusted: text goes in through textContent, ids through setAttribute.
 * With `rich` (a note), the text is drawn by note-markup.js instead: bold, italics,
 * code, lists and web links as nodes it builds itself, never as markup. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./note-markup')); return; }
  root.inventoryBoardCard = factory(root.inventoryNoteMarkup);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (noteMarkup) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d) { return d; };
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var KINDS = ['note', 'file', 'image', 'link', 'chat', 'diagram', 'group'];
  var TONES = ['amber', 'blue', 'green', 'red'];
  var SIDES = ['n', 'e', 's', 'w'];
  var STATES = ['selected', 'ghost', 'missing', 'locked'];
  var NAME_LIMIT = 120;
  var GLYPHS = {
    note: 'M6 4h9l3 3v13H6z M9 11h6 M9 15h6',
    file: 'M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z',
    image: 'M5 5h14v14H5z M8 15l3-3 3 3 2-2 3 3 M9 9h.01',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
    chat: 'M5 6h14v10H10l-4 3v-3H5z',
    diagram: 'M4 5h6v5H4z M14 14h6v5h-6z M7 10v4h7 M14 16h-4',
    group: 'M4 6h16v12H4z M4 10h6',
  };
  // Each jt() call is written out with literal arguments: the string ledger's scanner reads them.
  var KIND_LABELS = {
    note: function () { return jt('inventory.board.card.kind.note', 'Note'); },
    file: function () { return jt('inventory.board.card.kind.file', 'File'); },
    image: function () { return jt('inventory.board.card.kind.image', 'Image'); },
    link: function () { return jt('inventory.board.card.kind.link', 'Link'); },
    chat: function () { return jt('inventory.board.card.kind.chat', 'Chat'); },
    diagram: function () { return jt('inventory.board.card.kind.diagram', 'Diagram'); },
    group: function () { return jt('inventory.board.card.kind.group', 'Group'); },
  };
  var SIDE_LABELS = {
    n: function () { return jt('inventory.board.card.connect.n', 'Connect from the top edge'); },
    e: function () { return jt('inventory.board.card.connect.e', 'Connect from the right edge'); },
    s: function () { return jt('inventory.board.card.connect.s', 'Connect from the bottom edge'); },
    w: function () { return jt('inventory.board.card.connect.w', 'Connect from the left edge'); },
  };

  var applied = new WeakMap(); // element -> the props last applied

  function str(value) { return typeof value === 'string' ? value : (value === null || value === undefined ? '' : String(value)); }
  function num(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
  function normalize(props) {
    var source = props || {};
    var kind = KINDS.indexOf(source.kind) >= 0 ? source.kind : 'note';
    return {
      id: str(source.id), kind: kind,
      x: num(source.x), y: num(source.y), w: num(source.w), h: num(source.h), z: num(source.z),
      title: str(source.title), text: str(source.text), meta: str(source.meta),
      tone: TONES.indexOf(source.tone) >= 0 ? source.tone : '',
      selected: source.selected === true, ghost: source.ghost === true, missing: source.missing === true, locked: source.locked === true,
      resizable: source.resizable === true, connectable: source.connectable === true,
      rich: source.rich === true && Boolean(noteMarkup),
    };
  }
  function setAttr(el, name, value) { if (el.getAttribute(name) !== value) el.setAttribute(name, value); }
  function setFlag(el, name, on) {
    if (on) { if (!el.hasAttribute(name)) el.setAttribute(name, ''); } else if (el.hasAttribute(name)) el.removeAttribute(name);
  }
  function setText(el, value) { if (el.textContent !== value) el.textContent = value; }
  function setHidden(el, hidden) { if (el.hidden !== hidden) el.hidden = hidden; }
  function setPx(el, prop, value) {
    var next = value === null ? '' : value + 'px';
    if (el.style[prop] !== next) el.style[prop] = next;
  }
  function find(card, selector) { return card.querySelector(selector); }

  function accessibleName(next) {
    var named = next.title.trim() || (next.rich ? noteMarkup.plain(next.text) : next.text).split(/\r\n|\r|\n/).map(function (line) { return line.trim(); }).filter(Boolean)[0] || '';
    var high = named.charCodeAt(NAME_LIMIT - 2); // a cut never leaves half of a surrogate pair
    if (named.length > NAME_LIMIT) named = named.slice(0, high >= 0xd800 && high <= 0xdbff ? NAME_LIMIT - 2 : NAME_LIMIT - 1) + '…';
    return named || KIND_LABELS[next.kind]();
  }

  function glyph(doc, kind) {
    var svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'inv-board-card-glyph');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', GLYPHS[kind]);
    svg.appendChild(path);
    return svg;
  }
  function part(doc, tag, className, attr) {
    var el = doc.createElement(tag);
    el.className = className;
    if (attr) el.setAttribute(attr, '');
    return el;
  }
  function button(doc, className, attr, value, text) {
    var el = doc.createElement('button');
    el.type = 'button';
    el.className = className;
    el.setAttribute(attr, value);
    el.setAttribute('aria-label', text);
    el.title = text;
    return el;
  }

  function build(doc) {
    var card = doc.createElement('div');
    card.className = 'inv-board-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'group');
    var head = part(doc, 'div', 'inv-board-card-head');
    head.appendChild(part(doc, 'span', 'inv-board-card-kind'));
    head.appendChild(part(doc, 'span', 'inv-board-card-title', 'data-card-title'));
    var missing = part(doc, 'span', 'inv-board-card-missing', 'data-card-missing');
    missing.textContent = jt('inventory.board.card.missing', 'Missing file');
    missing.hidden = true;
    head.appendChild(missing);
    card.appendChild(head);
    return card;
  }

  function ensureBody(doc, card, wanted) {
    var body = find(card, '[data-card-body]');
    var meta = find(card, '[data-card-meta]');
    if (!wanted) {
      if (body) body.remove();
      if (meta) meta.remove();
      return;
    }
    if (!body) {
      body = part(doc, 'div', 'inv-board-card-body', 'data-card-body');
      var text = part(doc, 'div', 'inv-board-card-text', 'data-card-text');
      text.hidden = true;
      body.appendChild(text);
      card.appendChild(body);
    }
    if (!meta) {
      meta = part(doc, 'p', 'inv-board-card-meta', 'data-card-meta');
      meta.hidden = true;
      card.appendChild(meta);
    }
  }
  function ensureResize(doc, card, wanted) {
    var grip = find(card, '[data-card-resize]');
    if (wanted && !grip) card.appendChild(button(doc, 'inv-board-card-grip', 'data-card-resize', '', jt('inventory.board.card.resize', 'Resize card')));
    else if (!wanted && grip) grip.remove();
  }
  function ensurePorts(doc, card, wanted) {
    var ports = card.querySelectorAll('[data-card-connect]');
    if (!wanted) { ports.forEach(function (port) { port.remove(); }); return; }
    if (ports.length) return;
    SIDES.forEach(function (side) {
      card.appendChild(button(doc, 'inv-board-card-port', 'data-card-connect', side, SIDE_LABELS[side]()));
    });
  }

  function update(card, props) {
    var doc = card.ownerDocument;
    var next = normalize(props);
    var prev = applied.get(card) || {};
    var changed = function (key) { return prev[key] !== next[key]; };

    if (changed('id')) setAttr(card, 'data-card-id', next.id);
    if (changed('kind')) {
      setAttr(card, 'data-card-kind', next.kind);
      var old = card.querySelector('.inv-board-card-kind');
      var fresh = glyph(doc, next.kind);
      old.replaceChildren(fresh);
      ensureBody(doc, card, next.kind !== 'group');
    }
    if (changed('x')) setPx(card, 'left', next.x === null ? 0 : next.x);
    if (changed('y')) setPx(card, 'top', next.y === null ? 0 : next.y);
    if (changed('w')) setPx(card, 'width', next.w);
    if (changed('h')) setPx(card, 'height', next.h);
    if (changed('z') || changed('kind')) {
      // A group stacks behind every other card.
      var zIndex = next.kind === 'group' ? '0' : String(Math.max(1, Math.floor(next.z === null ? 1 : next.z)));
      if (card.style.zIndex !== zIndex) card.style.zIndex = zIndex;
    }
    if (changed('title')) {
      var title = find(card, '[data-card-title]');
      setText(title, next.title);
      setHidden(title, next.title === '');
    }
    if (next.kind !== 'group') {
      if (changed('text') || changed('kind') || changed('rich')) {
        var text = find(card, '[data-card-text]');
        if (next.rich) text.replaceChildren(noteMarkup.render(doc, next.text)); else setText(text, next.text);
        setHidden(text, next.text === '');
      }
      if (changed('meta') || changed('kind')) {
        var meta = find(card, '[data-card-meta]');
        setText(meta, next.meta);
        setHidden(meta, next.meta === '');
      }
    }
    if (changed('title') || changed('text') || changed('kind') || changed('rich')) setAttr(card, 'aria-label', accessibleName(next));
    STATES.forEach(function (state) { if (changed(state)) setFlag(card, 'data-' + state, next[state]); });
    if (changed('missing')) setHidden(find(card, '[data-card-missing]'), !next.missing);
    if (changed('tone')) { if (next.tone) setAttr(card, 'data-tone', next.tone); else card.removeAttribute('data-tone'); }
    if (changed('resizable')) ensureResize(doc, card, next.resizable);
    if (changed('connectable')) ensurePorts(doc, card, next.connectable);
    applied.set(card, next);
    return card;
  }

  function boardCard(props, options) {
    var doc = (options && options.document) || globalThis.document;
    return update(build(doc), props);
  }
  /** The slot a card kind draws its picture into, made on first use. update() never touches what is inside. */
  function media(card) {
    var body = find(card, '[data-card-body]');
    if (!body) return null;
    var slot = find(card, '[data-card-media]');
    if (!slot) {
      slot = part(card.ownerDocument, 'div', 'inv-board-card-media', 'data-card-media');
      body.insertBefore(slot, body.firstChild);
    }
    return slot;
  }
  boardCard.update = update;
  boardCard.media = media;
  return boardCard;
});
