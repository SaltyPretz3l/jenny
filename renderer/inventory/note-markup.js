/* renderer/inventory/note-markup.js - the small part of Markdown a board note is drawn with (UMD, global
 * inventoryNoteMarkup; row 150 slice B12, owner decision D21).
 *
 * What is read, and nothing else:
 *   **bold**   *italics* or _italics_   `code`   [label](https://address)   a bare http(s) address
 *   lines that start with "- ", "* " or "+ " (a bullet list) or "1. " or "1) " (a numbered list); two spaces of
 *   indent per level, three levels
 * There is no HTML, no picture, no heading, no table and no escape character: everything else stays the characters
 * that were written. A note with none of the marks is drawn as one text node, exactly as before this file existed.
 *
 * Every word of a note is untrusted (a person, a model's proposal or an imported file wrote it):
 * - parse() makes plain data; render() builds nodes with createElement and createTextNode only. No markup string
 *   is ever given to the page, so nothing a note says can become an element, an attribute or a script.
 * - The elements are a closed set: strong, em, code, a, ul, ol, li. The only attributes come from this file.
 * - A link opens only an http or https address that the URL parser accepts and that names no user or password.
 *   Its href and its tooltip are the parsed address, so what is shown on hover is what opens. It is drawn with
 *   target _blank, rel noopener noreferrer and tabindex -1; the board decides what a click does.
 * - A mark never reaches across a line, nesting stops at three levels, and a text over MAX_CHARS is drawn plain.
 *   A mark opens only at the start of a word and closes only at the end of one, so snake_case, 2*3*4 and a * b
 *   stay as written. One pass finds the pieces and one pairs the marks: the work grows with the length, not faster.
 *
 * plain(text) is the same text without the marks (a card's accessible name). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); return; }
  root.inventoryNoteMarkup = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_CHARS = 20000;
  var MAX_DEPTH = 3;
  var MAX_LABEL = 300;
  var MAX_URL = 2000;
  var MAX_LIST_START = 999999999;
  var WORD_RE = /[\p{L}\p{N}_]/u;
  var SPACE_RE = /\s/;
  var BULLET_RE = /^( {0,6})[-*+][ \t]+(\S.*)$/;
  var NUMBER_RE = /^( {0,6})(\d{1,9})[.)][ \t]+(\S.*)$/;
  var BARE_URL_RE = /^https?:\/\/[^\s<>"'`]+/i;
  var URL_TAIL_RE = /[.,;:!?)\]}*_]+$/;

  function isWord(ch) { return typeof ch === 'string' && ch !== '' && WORD_RE.test(ch); }
  function isSpace(ch) { return typeof ch !== 'string' || ch === '' || SPACE_RE.test(ch); }

  // A space, a control character or a line separator anywhere in an address.
  function hasControl(value) {
    for (var i = 0; i < value.length; i += 1) {
      var code = value.charCodeAt(i);
      if (code <= 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true;
    }
    return false;
  }

  /** The address a link may open, as the URL parser wrote it, or '' when it may not. */
  function safeHref(value) {
    var raw = typeof value === 'string' ? value : '';
    if (!raw || raw.length > MAX_URL || !/^https?:\/\//i.test(raw) || hasControl(raw)) return '';
    var url;
    try { url = new URL(raw); } catch (_error) { return ''; }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) return '';
    return url.href.length > MAX_URL ? '' : url.href;
  }

  // [label](address) at `at`, or null.
  function linkAt(line, at) {
    var close = line.indexOf(']', at + 1);
    if (close <= at + 1 || close - at - 1 > MAX_LABEL || line[close + 1] !== '(') return null;
    var label = line.slice(at + 1, close);
    if (label.indexOf('[') >= 0 || !label.trim()) return null;
    var end = line.indexOf(')', close + 2);
    if (end < 0 || end - close - 2 > MAX_URL) return null;
    var href = safeHref(line.slice(close + 2, end));
    return href ? { label: label, href: href, end: end + 1 } : null;
  }

  // A bare http(s) address at `at`, or null. What ends a sentence is not part of it.
  function bareUrlAt(line, at) {
    if (isWord(line[at - 1])) return null;
    var match = BARE_URL_RE.exec(line.slice(at, at + MAX_URL + 1));
    if (!match || match[0].length > MAX_URL) return null; // never a part of a longer address
    var text = match[0].replace(URL_TAIL_RE, '');
    var href = safeHref(text);
    return href ? { text: text, href: href, end: at + text.length } : null;
  }

  // A run of * or _ at `at` as marks: [] when it is no mark. `open` when it stands at the start of a word, `close` at the end.
  function marksAt(line, at) {
    var ch = line[at];
    var n = 1;
    while (line[at + n] === ch) n += 1;
    var open = !isWord(line[at - 1]) && !isSpace(line[at + n]);
    var close = !isSpace(line[at - 1]) && !isWord(line[at + n]);
    if ((!open && !close) || n > 3 || (ch === '_' && n !== 1)) return { length: n, marks: [] };
    var names = n === 1 ? [ch] : (n === 2 ? ['**'] : (close && !open ? ['*', '**'] : ['**', '*']));
    return { length: n, marks: names.map(function (mark) { return { t: 'mark', mark: mark, open: open, close: close }; }) };
  }

  function depthOf(node) {
    if (!node.c) return 0;
    return 1 + node.c.reduce(function (most, child) { return Math.max(most, depthOf(child)); }, 0);
  }
  // Marks that found no partner are the characters they were; neighbouring text becomes one piece.
  function settle(nodes) {
    var out = [];
    nodes.forEach(function (node) {
      var piece = node.t === 'mark' ? { t: 'text', v: node.mark } : node;
      var last = out[out.length - 1];
      if (piece.t === 'text' && last && last.t === 'text') last.v += piece.v; else out.push(piece.t === 'text' ? { t: 'text', v: piece.v } : piece);
    });
    return out;
  }

  /** One line's inline nodes: { t: 'text' | 'code', v } and { t: 'strong' | 'em' | 'link', c, href? }. */
  function inline(line, depth, inLink) {
    // First the pieces: text, code, links and marks, left to right.
    var pieces = [];
    var buffer = '';
    var flush = function () { if (buffer) { pieces.push({ t: 'text', v: buffer }); buffer = ''; } };
    var i = 0;
    while (i < line.length) {
      var ch = line[i];
      var found = null;
      if (ch === '`') {
        var end = line.indexOf('`', i + 1);
        if (end > i + 1) found = { nodes: [{ t: 'code', v: line.slice(i + 1, end) }], end: end + 1 };
      } else if (ch === '[' && !inLink && depth < MAX_DEPTH) {
        var link = linkAt(line, i);
        if (link) found = { nodes: [{ t: 'link', href: link.href, c: inline(link.label, depth + 1, true) }], end: link.end };
      } else if ((ch === 'h' || ch === 'H') && !inLink && depth < MAX_DEPTH) {
        var bare = bareUrlAt(line, i);
        if (bare) found = { nodes: [{ t: 'link', href: bare.href, c: [{ t: 'text', v: bare.text }] }], end: bare.end };
      } else if (ch === '*' || ch === '_') {
        var run = marksAt(line, i);
        if (run.marks.length) found = { nodes: run.marks, end: i + run.length };
        else { buffer += line.slice(i, i + run.length); i += run.length; continue; }
      }
      if (found) { flush(); found.nodes.forEach(function (node) { pieces.push(node); }); i = found.end; } else { buffer += ch; i += 1; }
    }
    flush();
    // Then the pairs: a closing mark takes the nearest open mark of its kind; what stands between becomes its content.
    var out = [];
    var open = []; // places in `out` of the marks still open
    pieces.forEach(function (piece) {
      if (piece.t !== 'mark') { out.push(piece); return; }
      if (piece.close) {
        for (var s = open.length - 1; s >= 0; s -= 1) {
          var at = open[s];
          if (out[at].mark !== piece.mark) continue;
          var node = { t: piece.mark === '**' ? 'strong' : 'em', c: settle(out.slice(at + 1)) };
          if (!node.c.length || depth + depthOf(node) > MAX_DEPTH) break; // too deep: the marks stay characters
          out.length = at;
          out.push(node);
          open.length = s;
          return;
        }
      }
      if (piece.open) open.push(out.length);
      out.push(piece);
    });
    return settle(out);
  }

  /** The blocks of a note: { type: 'text', lines: [inline nodes] } and { type: 'list', ordered, start, items: [{ depth, c }] }. */
  function parse(text) {
    var source = typeof text === 'string' ? text : '';
    if (source.length > MAX_CHARS) return [{ type: 'text', lines: source.split('\n').map(function (line) { return [{ t: 'text', v: line }]; }) }];
    var blocks = [];
    var last = null;
    source.split('\n').forEach(function (line) {
      var bullet = BULLET_RE.exec(line);
      var number = bullet ? null : NUMBER_RE.exec(line);
      if (bullet || number) {
        var ordered = Boolean(number);
        if (!last || last.type !== 'list' || last.ordered !== ordered) {
          last = { type: 'list', ordered: ordered, start: ordered ? Math.min(MAX_LIST_START, Number(number[2])) : 1, items: [] };
          blocks.push(last);
        }
        var match = bullet || number;
        last.items.push({ depth: Math.min(MAX_DEPTH - 1, Math.floor(match[1].length / 2)), c: inline(match[match.length - 1], 0, false) });
        return;
      }
      if (!last || last.type !== 'text') { last = { type: 'text', lines: [] }; blocks.push(last); }
      last.lines.push(inline(line, 0, false));
    });
    return blocks;
  }

  function appendInline(doc, parent, nodes, state) {
    nodes.forEach(function (node) {
      if (node.t === 'text') { state.text += node.v; return; }
      flushText(doc, parent, state);
      var el;
      if (node.t === 'code') {
        el = doc.createElement('code');
        el.className = 'inv-note-code';
        el.appendChild(doc.createTextNode(node.v));
      } else if (node.t === 'link') {
        el = doc.createElement('a');
        el.className = 'inv-note-link';
        el.setAttribute('href', node.href);
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
        el.setAttribute('tabindex', '-1');
        el.setAttribute('title', node.href);
        el.setAttribute('data-note-link', '');
        fill(doc, el, node.c);
      } else {
        el = doc.createElement(node.t === 'strong' ? 'strong' : 'em');
        fill(doc, el, node.c);
      }
      parent.appendChild(el);
    });
  }
  function flushText(doc, parent, state) {
    if (state.text) { parent.appendChild(doc.createTextNode(state.text)); state.text = ''; }
  }
  function fill(doc, parent, nodes) {
    var state = { text: '' };
    appendInline(doc, parent, nodes, state);
    flushText(doc, parent, state);
  }

  /** The note as nodes, in a fragment. Line breaks stay "\n" in the text (the card keeps white-space: pre-wrap). */
  function render(doc, text) {
    var fragment = doc.createDocumentFragment();
    var blocks = parse(text);
    var state = { text: '' };
    blocks.forEach(function (block, index) {
      if (block.type === 'text') {
        block.lines.forEach(function (line, n) {
          if (n > 0) state.text += '\n';
          appendInline(doc, fragment, line, state);
        });
        // A list is a block, so the break before it draws itself; a blank line the person left there needs one more
        // (a line break at the very end of a run of text draws nothing).
        if (index < blocks.length - 1 && block.lines[block.lines.length - 1].length === 0) state.text += '\n';
        return;
      }
      flushText(doc, fragment, state);
      var list = doc.createElement(block.ordered ? 'ol' : 'ul');
      list.className = 'inv-note-list';
      if (block.ordered && block.start !== 1) list.setAttribute('start', String(block.start));
      block.items.forEach(function (item) {
        var li = doc.createElement('li');
        if (item.depth > 0) li.setAttribute('data-depth', String(item.depth));
        fill(doc, li, item.c);
        list.appendChild(li);
      });
      fragment.appendChild(list);
    });
    flushText(doc, fragment, state);
    return fragment;
  }

  function plainInline(nodes) {
    return nodes.map(function (node) { return node.t === 'text' || node.t === 'code' ? node.v : plainInline(node.c); }).join('');
  }
  /** The note without its marks, line for line. */
  function plain(text) {
    return parse(text).map(function (block) {
      return (block.type === 'text' ? block.lines : block.items.map(function (item) { return item.c; })).map(plainInline).join('\n');
    }).join('\n');
  }

  return { MAX_CHARS: MAX_CHARS, parse: parse, render: render, plain: plain, safeHref: safeHref };
});
