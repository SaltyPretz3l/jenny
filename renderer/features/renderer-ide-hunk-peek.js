/* renderer/features/renderer-ide-hunk-peek.js - row 82 G2 quick diff peek
 * (docs/plans/IDE_VSCODE_PARITY_2026-10-26.md 6.2): clicking a git change bar in the
 * editor gutter opens an inventory popover under the change with the lines HEAD had
 * there and VS Code's peek actions:
 *
 *   Revert Change    one undoable model edit putting HEAD's lines back (nothing is
 *                    written to disk; the buffer becomes dirty like any edit)
 *   Stage Change     reads the staged copy, diffs it against the buffer, keeps only
 *                    the blocks under this change and stages them with
 *                    `git apply --cached` (the main-side validator refuses anything
 *                    but one in-root single-file text patch); an edit or a root
 *                    switch while the staged copy is read cancels it (cleanup G4)
 *   Previous / Next  move to the neighbouring change (wrapping)
 *
 * The gutter module (renderer-ide-gutter-decorations.js) owns the HEAD baseline and
 * hands this module getChangeBlocks(path); every action re-reads the blocks against
 * the current buffer, so a stale peek never edits the wrong lines. A coarse block (the
 * diff degraded on a large file) says Revert and Stage act on all of it (G5). The pure
 * helpers (blockAtLine, lineSpliceEdit, buildStagePatch) are exported for unit tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-ide-hunk-apply-utils'),
      require('./renderer-ide-gutter-decorations'),
      require('../inventory/popover'),
      require('../inventory/action-button'),
      require('../shared/string-utils')
    );
    return;
  }
  root.rendererIdeHunkPeek = factory(
    root.rendererIdeHunkApplyUtils,
    root.rendererIdeGutterDecorations,
    root.inventoryPopover,
    root.inventoryActionButton,
    root.stringUtils
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (hunkUtils, gutterUtils, popover, actionButton, stringUtils) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = stringUtils.escapeHtml;
  function noop() {}

  const CONTEXT_LINES = 3;
  const MAX_SHOWN_LINES = 200;
  const NO_NEWLINE = '\\ No newline at end of file';
  const POPOVER_ID = 'ide-hunk-peek';

  const lf = (text) => String(text == null ? '' : text).replace(/\r\n?/g, '\n');

  // Pure: the change block under a gutter line (anchorLine..endLine), else null.
  function blockAtLine(blocks, line) {
    return (blocks || []).find((block) => line >= block.anchorLine && line <= block.endLine) || null;
  }

  // Pure: the Monaco edit replacing buffer lines [start0, start0 + count) with
  // `replacement` (Monaco-aligned line arrays, so deleting or inserting whole lines
  // also moves the line breaks around them).
  function lineSpliceEdit(model, start0, count, replacement, eol) {
    const lineCount = model.getLineCount();
    const maxCol = (line) => model.getLineMaxColumn(line);
    const range = (sl, sc, el, ec) => ({ startLineNumber: sl, startColumn: sc, endLineNumber: el, endColumn: ec });
    const text = replacement.join(eol);
    if (count > 0 && replacement.length > 0) {
      return { range: range(start0 + 1, 1, start0 + count, maxCol(start0 + count)), text };
    }
    if (count > 0) {
      if (start0 + count < lineCount) return { range: range(start0 + 1, 1, start0 + count + 1, 1), text: '' };
      if (start0 > 0) return { range: range(start0, maxCol(start0), start0 + count, maxCol(start0 + count)), text: '' };
      return { range: range(1, 1, lineCount, maxCol(lineCount)), text: '' };
    }
    if (start0 < lineCount) return { range: range(start0 + 1, 1, start0 + 1, 1), text: text + eol };
    return { range: range(lineCount, maxCol(lineCount), lineCount, maxCol(lineCount)), text: eol + text };
  }

  // Content lines of one side, the last one keyed apart when the side has no final
  // newline, so a newline-only difference still diffs as a changed last line.
  function sideOf(text) {
    const split = hunkUtils.splitLines(lf(text));
    const keys = split.lines.map((line, index) => (index === split.lines.length - 1 && !split.finalNewline ? `${line}\u0000` : line));
    return { ...split, keys };
  }

  function overlaps(block, start0, count) {
    const new0 = block.newStart0;
    if (count > 0 && block.newCount > 0) return new0 < start0 + count && start0 < new0 + block.newCount;
    if (count > 0) return start0 <= new0 && new0 <= start0 + count;
    return new0 <= start0 && start0 <= new0 + block.newCount;
  }

  /**
   * Pure: a unified diff that stages, on top of the index copy, only the buffer
   * changes under the buffer range [start0, start0 + count) (the peeked HEAD block).
   * Context comes from the index side (unselected changes stay unstaged); a CRLF
   * index keeps CRLF lines; a missing final newline gets git's marker line.
   * @returns {{ patch: string, blocks: number }} patch '' when nothing differs there.
   */
  function buildStagePatch(path, indexText, bufferText, start0, count) {
    const oldSide = sideOf(indexText);
    const newSide = sideOf(bufferText);
    const cr = /\r\n/.test(String(indexText || '')) ? '\r' : '';
    const oldLen = oldSide.lines.length;
    const newLen = newSide.lines.length;
    const blocks = gutterUtils.diffChangeBlocks(oldSide.keys, newSide.keys);
    let picked = blocks.filter((block) => overlaps(block, start0, count));
    // A gutter block on Monaco's trailing '' line (a final-newline or trailing blank-line
    // change) sits one line past the content-line blocks here: take the block ending at EOF.
    if (!picked.length && start0 + count >= newLen) {
      picked = blocks.filter((block) => block.newStart0 + block.newCount === newLen || block.oldStart0 + block.oldCount === oldLen);
    }
    if (!picked.length) return { patch: '', blocks: 0 };
    // The last line of a side with no final newline carries no CR either.
    const crOf = (index, len, side) => (index === len - 1 && !side.finalNewline ? '' : cr);
    const groups = [];
    for (const block of picked) {
      const from = Math.max(0, block.oldStart0 - CONTEXT_LINES);
      const to = Math.min(oldLen, block.oldStart0 + block.oldCount + CONTEXT_LINES);
      const last = groups[groups.length - 1];
      if (last && from <= last.to) { last.to = Math.max(last.to, to); last.blocks.push(block); } else groups.push({ from, to, blocks: [block] });
    }
    const out = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
    let delta = 0;
    for (const group of groups) {
      const body = [];
      let oldCount = 0;
      let newCount = 0;
      const emitOld = (prefix, index) => {
        body.push(prefix + oldSide.lines[index] + crOf(index, oldLen, oldSide));
        if (index === oldLen - 1 && !oldSide.finalNewline) body.push(NO_NEWLINE);
      };
      const groupDelta = delta;
      let i = group.from;
      let next = 0; // group.blocks is in old-line order
      while (i < group.to || (next < group.blocks.length && group.blocks[next].oldStart0 === i)) {
        const block = group.blocks[next];
        if (block && block.oldStart0 === i) {
          for (let j = 0; j < block.oldCount; j += 1) emitOld('-', block.oldStart0 + j);
          for (let j = 0; j < block.newCount; j += 1) {
            const index = block.newStart0 + j;
            body.push(`+${newSide.lines[index]}${crOf(index, newLen, newSide)}`);
            if (index === newLen - 1 && !newSide.finalNewline) body.push(NO_NEWLINE);
          }
          oldCount += block.oldCount;
          newCount += block.newCount;
          delta += block.newCount - block.oldCount;
          i += block.oldCount;
          next += 1;
          continue;
        }
        emitOld(' ', i);
        oldCount += 1;
        newCount += 1;
        i += 1;
      }
      const oldStart = oldCount === 0 ? group.from : group.from + 1;
      const newStart = newCount === 0 ? group.from + groupDelta : group.from + groupDelta + 1;
      out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body);
    }
    return { patch: `${out.join('\n')}\n`, blocks: picked.length };
  }

  function createIdeHunkPeek(deps) {
    const options = deps || {};
    const editorHost = options.editorHost || null;
    const gitClient = options.gitClient || null;
    const getDom = typeof options.getDom === 'function' ? options.getDom : () => ({});
    const getChangeBlocks = typeof options.getChangeBlocks === 'function' ? options.getChangeBlocks : () => null;
    const refreshGit = typeof options.refreshGit === 'function' ? options.refreshGit : noop;
    const toast = typeof options.showToastMessage === 'function' ? options.showToastMessage : noop;
    const appendClientLog = typeof options.appendClientLog === 'function' ? options.appendClientLog : noop;
    const getRootEpoch = typeof options.getRootEpoch === 'function' ? options.getRootEpoch : () => 0;

    let popEl = null;
    let current = null; // { path, line }
    let busy = false;
    let disposed = false;

    const button = (action, label, extra) => actionButton({
      label, size: 'sm', variant: extra === 'primary' ? 'primary' : 'ghost', className: 'ide-hunk-peek-action',
      dataset: { 'ide-hunk-peek-action': action },
    });

    function lookup(path, line) {
      const memo = getChangeBlocks(path);
      const blocks = memo && Array.isArray(memo.blocks) ? memo.blocks : [];
      const block = blockAtLine(blocks, line);
      return block ? { blocks, block, index: blocks.indexOf(block) } : null;
    }

    function linesMarkup(block) {
      if (!block.oldLines.length) {
        return `<p class="ide-hunk-peek-note">${escapeHtml(jt('ide.hunkPeek.addedNote', 'These lines are new: the last commit has nothing here.'))}</p>`;
      }
      const shown = block.oldLines.slice(0, MAX_SHOWN_LINES)
        .map((line) => `<span class="ide-hunk-peek-line">${escapeHtml(line) || ' '}</span>`).join('');
      const more = block.oldLines.length > MAX_SHOWN_LINES
        ? `<p class="ide-hunk-peek-note">${escapeHtml(jt('ide.hunkPeek.moreLines', 'The rest of this change is not shown.'))}</p>`
        : '';
      return `<p class="ide-hunk-peek-label">${escapeHtml(jt('ide.hunkPeek.headLabel', 'In the last commit'))}</p>`
        + `<pre class="ide-hunk-peek-lines">${shown}</pre>${more}`;
    }

    function place(editor, block) {
      const host = getDom().ideEditorStage;
      const node = editor?.getDomNode?.();
      if (!host || !node || typeof host.getBoundingClientRect !== 'function') return;
      const visible = editor.getScrolledVisiblePosition?.({ lineNumber: block.endLine, column: 1 }) || { top: 0, height: 0 };
      const hostRect = host.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const layout = editor.getLayoutInfo?.() || {};
      const top = nodeRect.top - hostRect.top + (Number(visible.top) || 0) + (Number(visible.height) || 0);
      const start = nodeRect.left - hostRect.left + (Number(layout.decorationsLeft) || 0);
      popEl.style.setProperty('inset-block-start', `${Math.max(0, Math.round(top))}px`);
      popEl.style.setProperty('inset-inline-start', `${Math.max(0, Math.round(start))}px`);
    }

    function handleClick(event) {
      const target = event.target && event.target.closest ? event.target.closest('[data-ide-hunk-peek-action]') : null;
      if (!target) return;
      event.preventDefault();
      const action = target.getAttribute('data-ide-hunk-peek-action');
      if (action === 'revert') revert();
      else if (action === 'stage') void stage();
      else if (action === 'next') move(1);
      else if (action === 'previous') move(-1);
      else close();
    }

    function openAt(path, line) {
      if (disposed || !editorHost) return false;
      const found = lookup(path, line);
      const host = getDom().ideEditorStage;
      if (!found || !host) { close(); return false; }
      close();
      const { block, blocks, index } = found;
      const title = jt('ide.hunkPeek.title', 'Change {index} of {total}', { index: index + 1, total: blocks.length });
      const body = `<div class="ide-hunk-peek-head"><span class="ide-hunk-peek-title">${escapeHtml(title)}</span>`
        + `<span class="ide-hunk-peek-actions">${button('revert', jt('ide.hunkPeek.revert', 'Revert Change'))}`
        + `${button('stage', jt('ide.hunkPeek.stage', 'Stage Change'), 'primary')}`
        + `${button('previous', jt('ide.hunkPeek.previous', 'Previous Change'))}${button('next', jt('ide.hunkPeek.next', 'Next Change'))}`
        + `${button('close', jt('ide.hunkPeek.close', 'Close'))}</span></div>`
        + (block.coarse ? `<p class="ide-hunk-peek-note ide-hunk-peek-coarse">${escapeHtml(jt('ide.hunkPeek.coarseNote', 'This change covers a large region; Revert and Stage act on all of it.'))}</p>` : '')
        + linesMarkup(block);
      host.insertAdjacentHTML('beforeend', popover({ id: POPOVER_ID, className: 'ide-hunk-peek', ariaLabel: title, trustedHtml: body }));
      popEl = host.querySelector(`[data-inv-popover="${POPOVER_ID}"]`);
      if (!popEl) return false;
      popover.initPopoverHandlers(host);
      popEl.addEventListener('click', handleClick);
      // Escape or a click away: give the caret back only when focus was in the peek.
      popEl.addEventListener('inv-popover-toggle', (event) => {
        if (event.detail && event.detail.open === false && popEl) teardown(popEl.contains(popEl.ownerDocument.activeElement));
      });
      current = { path, line: block.anchorLine };
      const editor = editorHost.editorFor?.(path) || null;
      place(editor, block);
      // The editor is the "trigger": clicks inside it (the gutter bar that opened the
      // peek) are not click-aways; edits and scrolls close the peek instead.
      popover.open(popEl, { trigger: editor?.getDomNode?.() || null, focus: false });
      // Focus after Monaco finishes its own mousedown (which refocuses the editor).
      const opened = popEl;
      setTimeout(() => { if (popEl === opened) opened.querySelector('[data-ide-hunk-peek-action]')?.focus?.(); }, 0);
      return true;
    }

    function teardown(refocus) {
      const el = popEl;
      popEl = null;
      current = null;
      if (el) el.remove();
      if (refocus) editorHost?.editorFor?.(editorHost.getActivePath?.())?.focus?.();
    }

    function close() {
      teardown(false);
    }

    function move(direction) {
      if (!current) return;
      const found = lookup(current.path, current.line);
      if (!found) { close(); return; }
      const { blocks, index } = found;
      const next = blocks[(index + direction + blocks.length) % blocks.length];
      const path = current.path;
      editorHost.revealPosition?.(path, next.anchorLine, 1);
      openAt(path, next.anchorLine);
    }

    function revert() {
      if (!current) return false;
      const found = lookup(current.path, current.line);
      const model = editorHost.getModel?.(current.path) || null;
      if (!found || !model || typeof model.pushEditOperations !== 'function') { close(); return false; }
      const { block } = found;
      const edit = lineSpliceEdit(model, block.newStart0, block.newCount, block.oldLines, model.getEOL?.() || '\n');
      const editor = editorHost.editorFor?.(current.path) || null;
      editor?.pushUndoStop?.();
      model.pushEditOperations([], [edit], () => null);
      editor?.pushUndoStop?.();
      close();
      return true;
    }

    async function stage() {
      if (!current || busy || !gitClient) return false;
      const { path, line } = current;
      const found = lookup(path, line);
      if (!found) { close(); return false; }
      busy = true;
      // The buffer and the root this stage was asked for; checked again after the read.
      const model = editorHost.getModel?.(path) || null;
      const version = model?.getVersionId?.();
      const epoch = getRootEpoch();
      try {
        const index = await Promise.resolve(gitClient.getFileAtIndex({ path })).catch(() => null);
        if (disposed) return false;
        if (editorHost.getModel?.(path) !== model || model?.getVersionId?.() !== version || getRootEpoch() !== epoch) {
          toast(jt('ide.hunkPeek.changedRetry', 'The file changed while staging; try again.'));
          return false;
        }
        if (!index || index.ok !== true) { toast(jt('ide.hunkPeek.readFailed', 'Couldn’t read the staged copy of this file.')); return false; }
        if (index.found !== true) {
          toast(index.reason === 'unmerged'
            ? jt('ide.hunkPeek.unmerged', 'This file has merge conflicts. Resolve them before staging a change.')
            : jt('ide.hunkPeek.notTracked', 'This file isn’t tracked yet. Stage the whole file from Source Control.'));
          return false;
        }
        const fresh = lookup(path, line);
        if (!fresh) { close(); return false; }
        const built = buildStagePatch(path, index.content, editorHost.getValue(path), fresh.block.newStart0, fresh.block.newCount);
        if (!built.patch) { toast(jt('ide.hunkPeek.alreadyStaged', 'This change is already staged.')); return false; }
        const res = await Promise.resolve(gitClient.applyPatch({ patch: built.patch, cached: true })).catch(() => null);
        if (disposed) return false;
        if (!res || res.ok !== true) {
          appendClientLog('WARN', 'ide.hunk_stage_failed', { reason: String(res?.reason || res?.code || '') });
          toast(jt('ide.hunkPeek.stageFailed', 'Couldn’t stage this change. Stage the file from Source Control instead.'));
          return false;
        }
        toast(jt('ide.hunkPeek.staged', 'Change staged.'));
        close();
        await refreshGit();
        return true;
      } finally {
        busy = false;
      }
    }

    return {
      openAt,
      close,
      revert,
      stage,
      next: () => move(1),
      previous: () => move(-1),
      isOpen: () => Boolean(popEl),
      dispose() { disposed = true; close(); },
    };
  }

  return { createIdeHunkPeek, blockAtLine, lineSpliceEdit, buildStagePatch };
});
