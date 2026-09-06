/* renderer/chat/renderer-diff-hunks-render.js
 * Shared escaped-HTML unified-diff hunk renderer. Lifted out of
 * renderer-transcript-tool-calls.js so the in-row collapsed diff
 * (tool-result row) and the code-review rail render byte-identical
 * markup. Consumers pass their own escapeHtml so the rendering stays
 * pure and free of DOM/global dependencies.
 *
 * Hunk shape (from sidecar/ai/tools/builtins/structured_diff.py in LF-normalized space):
 *   { oldStart, oldLines, newStart, newLines, lines: ['<prefix><text>', ...] }
 * Each line starts with '+' (addition), '-' (deletion), ' ' (context),
 * or '\\' (meta — typically "\\ No newline at end of file"). Anything
 * else falls through to the meta branch.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'));
    return;
  }
  root.rendererDiffHunksRender = factory(root.stringUtils || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils) {
  const defaultEscape = typeof stringUtils.escapeHtml === 'function'
    ? stringUtils.escapeHtml
    : function fallbackEscape(value) { return String(value == null ? '' : value); };

  function renderDiffHunks(hunks, escapeHtml) {
    if (!Array.isArray(hunks) || hunks.length === 0) {
      return '';
    }
    const escape = typeof escapeHtml === 'function' ? escapeHtml : defaultEscape;
    return hunks.map(function renderHunk(hunk, hunkIdx) {
      const oldStart = Number(hunk?.oldStart) || 0;
      const oldLines = Number(hunk?.oldLines) || 0;
      const newStart = Number(hunk?.newStart) || 0;
      const newLines = Number(hunk?.newLines) || 0;
      const hunkHeader = `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`;
      let oldLine = oldStart;
      let newLine = newStart;
      const rawLines = Array.isArray(hunk?.lines) ? hunk.lines : [];
      const linesHtml = rawLines.map(function renderLine(line) {
        const text = String(line || '');
        const marker = text.charAt(0);
        const content = text.slice(1);
        let lineClass;
        let gutterOld;
        let gutterNew;
        let markerChar;
        if (marker === '+') {
          lineClass = 'diff-line-add';
          gutterOld = '';
          gutterNew = String(newLine++);
          markerChar = '+';
        } else if (marker === '-') {
          lineClass = 'diff-line-remove';
          gutterOld = String(oldLine++);
          gutterNew = '';
          markerChar = '-';
        } else if (marker === ' ' || text === '') {
          lineClass = 'diff-line-context';
          gutterOld = String(oldLine++);
          gutterNew = String(newLine++);
          markerChar = ' ';
        } else {
          return `<div class="diff-line diff-line-meta"><span class="diff-gutter diff-gutter-old"></span><span class="diff-gutter diff-gutter-new"></span><span class="diff-marker"></span><span class="diff-content">${escape(text)}</span></div>`;
        }
        return `<div class="diff-line ${lineClass}"><span class="diff-gutter diff-gutter-old">${escape(gutterOld)}</span><span class="diff-gutter diff-gutter-new">${escape(gutterNew)}</span><span class="diff-marker">${markerChar}</span><span class="diff-content">${escape(content)}</span></div>`;
      }).join('');
      const separator = hunkIdx > 0 ? '<div class="diff-hunk-separator">...</div>' : '';
      return `${separator}<div class="diff-hunk"><div class="diff-hunk-header">${escape(hunkHeader)}</div>${linesHtml}</div>`;
    }).join('');
  }

  return { renderDiffHunks };
});
