/* renderer/chat/renderer-unified-diff-parse.js
 * Pure parser: one file's unified diff text -> the hunk shape
 * renderer-file-diff-view.js renders ({ oldStart, oldLines, newStart, newLines, lines }
 * with every line keeping its ' ' / '+' / '-' marker).
 *
 * Bounded on purpose (the text arrives from a git read of the working tree, so a
 * file can be arbitrarily large or hostile): at most MAX_LINES body lines,
 * MAX_HUNKS hunks and MAX_LINE_LENGTH characters per line; anything past a cap
 * is dropped and `truncated` says so. Header lines before the first hunk
 * (diff --git, index, mode, ---/+++) are skipped, "\ No newline at end of file"
 * markers are dropped (they annotate the previous line, they are not content),
 * and "Binary files ... differ" / "GIT binary patch" report `binary`.
 * A hunk ends when its declared old/new line counts are consumed, so a removed
 * line that begins with "-- " can never be mistaken for the next file header.
 * Malformed input never throws: unparseable text yields no hunks.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererUnifiedDiffParse = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_LINES = 5000;
  const MAX_HUNKS = 200;
  const MAX_LINE_LENGTH = 2000;
  const MAX_TEXT_LENGTH = 1000000;
  const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const BINARY_MARKER = /^(?:Binary files .* differ|GIT binary patch)$/;

  function toCount(value, fallback) {
    if (value === undefined) return fallback;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
  }

  function clampLine(line) {
    return line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) : line;
  }

  /**
   * @param {string} text unified diff for one file
   * @param {{maxLines?: number, maxHunks?: number}} [options]
   * @returns {{hunks: Array, binary: boolean, truncated: boolean}}
   */
  function parseUnifiedDiff(text, options) {
    const settings = options || {};
    const maxLines = Number.isSafeInteger(settings.maxLines) && settings.maxLines > 0 ? Math.min(settings.maxLines, MAX_LINES) : MAX_LINES;
    const maxHunks = Number.isSafeInteger(settings.maxHunks) && settings.maxHunks > 0 ? Math.min(settings.maxHunks, MAX_HUNKS) : MAX_HUNKS;
    const result = { hunks: [], binary: false, truncated: false };
    if (typeof text !== 'string' || !text) return result;
    let source = text;
    if (source.length > MAX_TEXT_LENGTH) {
      source = source.slice(0, MAX_TEXT_LENGTH);
      result.truncated = true;
    }
    const rows = source.split('\n');
    // A trailing newline leaves one empty string that is not a content line.
    if (rows.length && rows[rows.length - 1] === '') rows.pop();

    let hunk = null;
    let remainingOld = 0;
    let remainingNew = 0;
    let bodyLines = 0;

    for (let index = 0; index < rows.length; index += 1) {
      let row = rows[index];
      if (row.endsWith('\r')) row = row.slice(0, -1);
      const header = HUNK_HEADER.exec(row);
      if (header) {
        if (result.hunks.length >= maxHunks) { result.truncated = true; break; }
        remainingOld = toCount(header[2], 1);
        remainingNew = toCount(header[4], 1);
        hunk = {
          oldStart: toCount(header[1], 0),
          oldLines: remainingOld,
          newStart: toCount(header[3], 0),
          newLines: remainingNew,
          lines: [],
        };
        result.hunks.push(hunk);
        continue;
      }
      if (!hunk) {
        if (BINARY_MARKER.test(row)) result.binary = true;
        continue;
      }
      if (row.charAt(0) === '\\') continue; // "\ No newline at end of file"
      if (remainingOld <= 0 && remainingNew <= 0) {
        if (BINARY_MARKER.test(row)) result.binary = true;
        continue; // between hunks or the next file's header lines
      }
      const marker = row.charAt(0);
      if (marker === '+' || marker === '-' || marker === ' ' || row === '') {
        if (bodyLines >= maxLines) { result.truncated = true; break; }
        // Some tools strip the trailing space of an empty context line.
        const line = row === '' ? ' ' : clampLine(row);
        hunk.lines.push(line);
        bodyLines += 1;
        if (marker === '+') remainingNew -= 1;
        else if (marker === '-') remainingOld -= 1;
        else { remainingOld -= 1; remainingNew -= 1; }
        continue;
      }
      // Anything else inside a hunk is malformed: end the hunk, keep what parsed.
      remainingOld = 0;
      remainingNew = 0;
    }
    return result;
  }

  return { parseUnifiedDiff, MAX_LINES, MAX_HUNKS, MAX_LINE_LENGTH };
});
