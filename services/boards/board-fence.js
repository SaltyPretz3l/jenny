/* services/boards/board-fence.js – fenced `board` blocks in a reply (UMD, global jennyBoardFence)
 *
 * Plan PROJECT_BOARD_2026-11-13 sections 7.3 and 7.4. A model proposes board changes in a fenced code block
 * tagged `board`. Two readers need to find those blocks in a reply's text:
 *
 *   - history: whenever earlier replies are sent to a model or a summarizer, each board block is replaced by
 *     one fixed line (stubBoardBlocks), so a model that was never shown a board does not learn the grammar or
 *     old card names from history, and the bytes are the same whichever page sends the conversation;
 *   - the proposal reader (slice C3): the closed blocks of one reply, in order (boardBlockBodies), and the
 *     reply's `sketch` blocks with the name after the tag (sketchBlocks), since a board block's
 *     `diagram <name>` line takes its drawing from the fence tagged `sketch <name>`.
 *
 * The scanner follows the fence rules of the chat's markdown: an opening fence is up to three spaces, then
 * three or more backticks or tildes, then the tag; it closes on a line of the same character at least as
 * long, with nothing after it. Every fence is tracked, so a `board` line inside another code block is text of
 * that block, and a board block cannot be closed by a shorter fence inside it. An unclosed board fence runs to
 * the end of the text: history replaces it too, the proposal reader ignores it (`closed: false`).
 *
 * Pure: no Electron, DOM or network import.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.jennyBoardFence = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var BOARD_HISTORY_STUB = '[board changes proposed]';
  var OPEN_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)([^\n]*)$/;
  var CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
  var MAX_SCAN_CHARS = 4 * 1024 * 1024;

  /**
   * Every fenced block tagged `board` in `text`, in order:
   * { start, end, bodyStart, bodyEnd, closed }. `start` is the first character of the opening fence line and
   * `end` is just past the closing fence line (without its line break), or the end of the text when unclosed.
   */
  function findBoardFences(text) { return findFences(text, 'board'); }

  /** The same for any tag; each entry also carries `info`, the rest of the opening line after the tag. */
  function findFences(text, tag) {
    var found = [];
    if (typeof text !== 'string' || text.length > MAX_SCAN_CHARS || text.toLowerCase().indexOf(tag) < 0) return found;
    var open = null; // { char, length, board, info, start, bodyStart }
    var lineStart = 0;
    while (lineStart <= text.length) {
      var newline = text.indexOf('\n', lineStart);
      var lineEnd = newline < 0 ? text.length : newline;
      var contentEnd = lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
      var line = text.slice(lineStart, contentEnd);
      var m;
      if (open) {
        m = CLOSE_RE.exec(line);
        if (m && m[1].charAt(0) === open.char && m[1].length >= open.length) {
          if (open.board) found.push({ start: open.start, end: contentEnd, bodyStart: open.bodyStart, bodyEnd: lineStart, closed: true, info: open.info });
          open = null;
        }
      } else {
        m = OPEN_RE.exec(line);
        // A backtick fence's info string cannot hold a backtick (that is inline code, not a fence).
        if (m && !(m[1].charAt(0) === '`' && m[3].indexOf('`') >= 0)) {
          open = { char: m[1].charAt(0), length: m[1].length, board: m[2].toLowerCase() === tag, info: m[3].trim(), start: lineStart, bodyStart: newline < 0 ? text.length : newline + 1 };
        }
      }
      if (newline < 0) break;
      lineStart = newline + 1;
    }
    if (open && open.board) found.push({ start: open.start, end: text.length, bodyStart: open.bodyStart, bodyEnd: text.length, closed: false, info: open.info });
    return found;
  }

  /** `text` with every board block, closed or not, replaced by the one fixed history line. */
  function stubBoardBlocks(text) {
    if (typeof text !== 'string') return text;
    var fences = findBoardFences(text);
    if (!fences.length) return text;
    var out = '';
    var at = 0;
    for (var i = 0; i < fences.length; i++) {
      out += text.slice(at, fences[i].start) + BOARD_HISTORY_STUB;
      at = fences[i].end;
    }
    return out + text.slice(at);
  }

  /** The bodies of the closed board blocks, in order; one identical to an earlier one counts once (plan 7.4). */
  function boardBlockBodies(text) {
    var seen = Object.create(null);
    var bodies = [];
    findBoardFences(text).forEach(function (fence) {
      if (!fence.closed) return;
      var body = text.slice(fence.bodyStart, fence.bodyEnd).replace(/\r\n/g, '\n').replace(/\n$/, '');
      if (seen[body]) return;
      seen[body] = true;
      bodies.push(body);
    });
    return bodies;
  }

  /** The closed `sketch` blocks of a reply, in order: { name, body }. `name` is the word after the tag, '' when none. */
  function sketchBlocks(text) {
    return findFences(text, 'sketch').filter(function (fence) { return fence.closed; }).map(function (fence) {
      var name = fence.info.split(/\s+/)[0] || '';
      return { name: /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) ? name : '', body: text.slice(fence.bodyStart, fence.bodyEnd).replace(/\r\n/g, '\n').replace(/\n$/, '') };
    });
  }

  return { BOARD_HISTORY_STUB: BOARD_HISTORY_STUB, findBoardFences: findBoardFences, stubBoardBlocks: stubBoardBlocks, boardBlockBodies: boardBlockBodies, sketchBlocks: sketchBlocks };
});
