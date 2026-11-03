/* services/workspace-terminal-tail.js - main-side, bounded, ANSI-stripped tail
 * of one Workspace IDE terminal's output (row 94 P4: terminal_read). The xterm
 * scrollback lives only in the renderer; this keeps the last maxChars of plain
 * text per live pty so main can answer "what did the terminal say" without a
 * renderer round trip, even for a hidden or scrolled-out terminal.
 *
 * Escape sequences are removed by the renderer's incremental stripper
 * (renderer/shared/ansi-stream-utils.js is UMD, so main requires it directly),
 * which survives CSI/OSC sequences split across pty chunks. Line model: CRLF
 * and LF end a line (a CR at the end of one chunk waits for the next chunk to
 * decide); a bare CR discards the partial line so progress bars overwrite;
 * backspace deletes one char; other C0 controls except tab are dropped.
 * Bound: each complete line costs max(1, length) chars plus the partial line;
 * past maxChars the oldest lines drop and truncated sticks until clear(). No
 * persistence. */

'use strict';

const { createAnsiStreamStripper } = require('../renderer/shared/ansi-stream-utils');

const DEFAULT_MAX_CHARS = 65536;
const DEFAULT_READ_LINES = 80;
const MAX_READ_LINES = 200;
// C0 controls handled specially or dropped (everything below space except tab, plus DEL).
const CONTROL_RE = /[\u0000-\u0008\u000a-\u001f\u007f]/g; // eslint-disable-line no-control-regex

function clampLines(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_READ_LINES;
  return Math.max(1, Math.min(MAX_READ_LINES, n));
}

function lineCost(line) {
  return Math.max(1, line.length);
}

function createTerminalTail({ maxChars = DEFAULT_MAX_CHARS } = {}) {
  const cap = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : DEFAULT_MAX_CHARS;
  const stripper = createAnsiStreamStripper();
  let lines = []; // complete lines; lines[head..] are live (head avoids O(n) shift)
  let head = 0;
  let linesChars = 0;
  let partial = '';
  let pendingCr = false;
  let truncated = false;

  function appendText(text) {
    if (!text) return;
    partial += text;
    if (partial.length > cap) {
      partial = partial.slice(-cap);
      truncated = true;
    }
  }

  function endLine() {
    lines.push(partial);
    linesChars += lineCost(partial);
    partial = '';
  }

  function handleControl(ch) {
    if (pendingCr) {
      pendingCr = false;
      if (ch === '\n') { endLine(); return; }
      partial = ''; // bare CR: back to the line start, the next text overwrites
    }
    if (ch === '\r') pendingCr = true;
    else if (ch === '\n') endLine();
    else if (ch === '\b') partial = partial.slice(0, -1);
    // every other C0 control is dropped
  }

  function appendRun(text) {
    if (!text) return;
    if (pendingCr) { pendingCr = false; partial = ''; }
    appendText(text);
  }

  function enforceBound() {
    while (head < lines.length && linesChars + partial.length > cap) {
      linesChars -= lineCost(lines[head]);
      lines[head] = undefined;
      head += 1;
      truncated = true;
    }
    if (head > 1024 && head * 2 > lines.length) {
      lines = lines.slice(head);
      head = 0;
    }
  }

  function push(data) {
    const text = stripper.push(data);
    let last = 0;
    CONTROL_RE.lastIndex = 0;
    for (let match = CONTROL_RE.exec(text); match; match = CONTROL_RE.exec(text)) {
      appendRun(text.slice(last, match.index));
      handleControl(match[0]);
      last = match.index + 1;
    }
    appendRun(text.slice(last));
    enforceBound();
  }

  function read({ lines: wanted } = {}) {
    const n = clampLines(wanted ?? DEFAULT_READ_LINES);
    const live = lines.length - head;
    const total = live + (partial ? 1 : 0);
    const fromComplete = Math.min(live, partial ? n - 1 : n);
    const out = lines.slice(lines.length - fromComplete);
    if (partial) out.push(partial);
    return { lines: out, truncated: truncated || total > out.length };
  }

  function clear() {
    stripper.reset();
    lines = [];
    head = 0;
    linesChars = 0;
    partial = '';
    pendingCr = false;
    truncated = false;
  }

  return {
    push,
    read,
    clear,
    get size() { return linesChars + partial.length; },
  };
}

module.exports = {
  DEFAULT_MAX_CHARS,
  MAX_READ_LINES,
  createTerminalTail,
};
