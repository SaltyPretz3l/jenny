/* renderer/features/renderer-ide-hunk-apply-utils.js - pure line-splice math for
 * per-hunk accept/reject on the Workspace IDE diff review tab. No DOM, no I/O,
 * no side effects.
 *
 * Operates entirely in EOL-normalized (LF) space: the structured-diff pipeline
 * (sidecar/ai/tools/builtins/structured_diff.py) computes hunks
 * over LF-normalized text, so callers normalize both sides to LF, apply
 * decisions here, then restore the file's detected EOL before writing.
 *
 * Hunk shape (sidecar structured_diff.py wire shape, mirrored by the change ledger's
 * normalizeHunks): { oldStart, oldLines, newStart, newLines, lines[] }, where
 * each `lines` entry is prefixed:
 *   ' '  context line  (present in BOTH the old and the new/modified side)
 *   '+'  added line    (present only in the new/modified side)
 *   '-'  removed line  (present only in the old side)
 *   '\'  the "\ No newline at end of file" marker - flags that the adjacent
 *        content line is the last line of its side and carries no trailing
 *        newline. It applies to the immediately preceding content line: after a
 *        '+' it marks the new side, after a '-' the old side, after a context
 *        line BOTH sides.
 *
 * Model: the MODIFIED text (Jenny's version / what is on disk now) is the base.
 * The old-side lines come from the hunks themselves, so the pre-change original
 * is recoverable from M + full hunks without a separate snapshot. ACCEPTING a
 * hunk keeps the modified lines; REJECTING restores the old lines. The result
 * is built in a single left-to-right pass over the modified line array,
 * splicing each hunk's modified-side region with its old-side lines when
 * rejected. Decisions are always applied against the immutable base M, so
 * rejecting one hunk never shifts the coordinates used for the others.
 *
 * Safety: each hunk's modified-side region is VERIFIED against the base text
 * before it is spliced. If the text has diverged from what the hunk recorded
 * (an external edit since the diff was captured), that hunk is reported as a
 * conflict and left untouched rather than corrupting the file.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeHunkApplyUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const NO_NEWLINE_PREFIX = '\\';

  // Split LF text into content lines plus whether the file ends with a newline.
  // The trailing '' that String.split leaves after a final '\n' is dropped and
  // recorded as finalNewline, so joinLines is an exact inverse.
  function splitLines(text) {
    const str = String(text == null ? '' : text);
    if (str === '') {
      return { lines: [], finalNewline: false };
    }
    const finalNewline = str.endsWith('\n');
    const lines = str.split('\n');
    if (finalNewline) {
      lines.pop();
    }
    return { lines, finalNewline };
  }

  function joinLines(lines, finalNewline) {
    if (!lines.length) {
      return '';
    }
    return lines.join('\n') + (finalNewline ? '\n' : '');
  }

  // Decompose a hunk's unified-diff lines into its old-side and new-side content
  // arrays (prefixes stripped) plus the per-side no-trailing-newline flags.
  function parseHunkSides(hunk) {
    const rawLines = Array.isArray(hunk && hunk.lines) ? hunk.lines : [];
    const oldLines = [];
    const newLines = [];
    let oldNoNewline = false;
    let newNoNewline = false;
    let prevPrefix = '';
    for (const raw of rawLines) {
      const entry = String(raw == null ? '' : raw);
      const prefix = entry.charAt(0);
      if (prefix === NO_NEWLINE_PREFIX) {
        if (prevPrefix === '+') {
          newNoNewline = true;
        } else if (prevPrefix === '-') {
          oldNoNewline = true;
        } else if (prevPrefix === ' ') {
          oldNoNewline = true;
          newNoNewline = true;
        }
        continue; // marker line carries no content and does not advance prevPrefix
      }
      const content = entry.slice(1);
      if (prefix === '+') {
        newLines.push(content);
      } else if (prefix === '-') {
        oldLines.push(content);
      } else {
        // ' ' context (and any unexpected prefix, treated as shared content).
        oldLines.push(content);
        newLines.push(content);
      }
      prevPrefix = prefix;
    }
    return { oldLines, newLines, oldNoNewline, newNoNewline };
  }

  // 0-based start of a hunk's region in the new/modified file. jsdiff uses
  // 1-based newStart; a zero-length new range (a pure deletion that empties the
  // file) can report newStart 0, which clamps to 0.
  function hunkNewStart0(hunk) {
    const newStart = Number(hunk && hunk.newStart) || 0;
    return newStart > 0 ? newStart - 1 : 0;
  }

  // True when the base text holds exactly `expected` at [start0, start0+len).
  function regionMatches(baseLines, start0, expected) {
    if (start0 < 0 || start0 + expected.length > baseLines.length) {
      return false;
    }
    for (let i = 0; i < expected.length; i += 1) {
      if (baseLines[start0 + i] !== expected[i]) {
        return false;
      }
    }
    return true;
  }

  function normalizeRejected(rejected, count) {
    const set = new Set();
    const source = rejected instanceof Set
      ? rejected
      : (Array.isArray(rejected) ? rejected : []);
    for (const value of source) {
      // Only real numbers / numeric strings are indices: null, booleans, and
      // objects all coerce to surprising numbers (Number(null) === 0), so a
      // stray value must never silently select hunk 0.
      if (typeof value !== 'number' && typeof value !== 'string') {
        continue;
      }
      const index = Number(value);
      if (Number.isInteger(index) && index >= 0 && index < count) {
        set.add(index);
      }
    }
    return set;
  }

  /**
   * Apply per-hunk accept/reject decisions to a modified (LF) text.
   *
   * @param {string} modifiedText  The new/modified side, EOL-normalized to LF.
   * @param {Array}  hunks         jsdiff-shaped hunks (the change ledger's normalizeHunks output).
   * @param {Object} [options]
   * @param {number[]|Set<number>} [options.rejected]  Indices (into hunks) to reject.
   *        Anything not listed is accepted (kept as the modified text).
   * @returns {{ text: string, conflicts: number[], finalNewline: boolean }}
   *   text       - the LF result of the decisions.
   *   conflicts  - indices of hunks asked to be rejected that could not be
   *                safely spliced (region diverged / out of order); those hunks
   *                are left as the modified text.
   *   finalNewline - whether `text` ends with a newline.
   */
  function applyHunkDecisions(modifiedText, hunks, options = {}) {
    const { lines: baseLines, finalNewline: baseFinalNewline } = splitLines(modifiedText);
    const list = Array.isArray(hunks) ? hunks : [];
    const rejectedSet = normalizeRejected(options && options.rejected, list.length);

    // Process hunks in new-file order so the single pass is monotonic.
    const order = list
      .map((_hunk, index) => index)
      .sort((a, b) => hunkNewStart0(list[a]) - hunkNewStart0(list[b]));

    const result = [];
    const conflicts = [];
    let cursor = 0;
    let finalNewline = baseFinalNewline;

    for (const index of order) {
      const hunk = list[index];
      const sides = parseHunkSides(hunk);
      const start0 = hunkNewStart0(hunk);
      const regionLen = sides.newLines.length;
      // A zero-length new side (a whole-file deletion: the new file is empty)
      // would "verify" against ANY base because an empty slice always matches;
      // require the base to genuinely be empty from start0 on, so old lines are
      // never merged into unrelated/diverged content.
      const verified = regionMatches(baseLines, start0, sides.newLines)
        && (regionLen > 0 || baseLines.length === start0);

      // Emit untouched modified lines up to this hunk's start.
      if (start0 > cursor) {
        for (let i = cursor; i < start0; i += 1) {
          result.push(baseLines[i]);
        }
        cursor = start0;
      }

      // An out-of-order/overlapping hunk, or one whose modified-side region no
      // longer matches the base, cannot be safely spliced. Leave the modified
      // text in place for that region (flag a conflict only if it was rejected).
      if (start0 < cursor || !verified) {
        if (rejectedSet.has(index)) {
          conflicts.push(index);
        }
        continue;
      }

      if (rejectedSet.has(index)) {
        for (const line of sides.oldLines) {
          result.push(line);
        }
        cursor = start0 + regionLen;
        if (cursor >= baseLines.length) {
          // This hunk reaches EOF: the file's last line is now the old side.
          finalNewline = !sides.oldNoNewline;
        }
      } else {
        for (let i = 0; i < regionLen; i += 1) {
          result.push(baseLines[start0 + i]);
        }
        cursor = start0 + regionLen;
      }
    }

    // Trailing untouched modified lines (the EOF region is shared, so the file's
    // trailing-newline state follows the modified base here).
    if (cursor < baseLines.length) {
      for (let i = cursor; i < baseLines.length; i += 1) {
        result.push(baseLines[i]);
      }
      finalNewline = baseFinalNewline;
    }

    return { text: joinLines(result, finalNewline), conflicts, finalNewline };
  }

  // True when every hunk's modified side is present in `modifiedText` exactly
  // where the hunk says it is - i.e. the text IS the version the hunks were
  // computed against ("Jenny's version"). Callers use this to decide whether
  // per-hunk decisions are safe: if the file has diverged (an external edit, or
  // a prior partial reject already on disk) the hunks no longer line up and
  // per-hunk must be withheld in favour of whole-file revert.
  function hunksMatchBase(modifiedText, hunks) {
    const { lines } = splitLines(modifiedText);
    const list = Array.isArray(hunks) ? hunks : [];
    for (const hunk of list) {
      const sides = parseHunkSides(hunk);
      const start0 = hunkNewStart0(hunk);
      if (!regionMatches(lines, start0, sides.newLines)) {
        return false;
      }
      if (sides.newLines.length === 0 && lines.length !== start0) {
        return false;
      }
    }
    return true;
  }

  return {
    applyHunkDecisions,
    hunksMatchBase,
    // Exposed for focused unit tests.
    splitLines,
    joinLines,
    parseHunkSides,
  };
});
