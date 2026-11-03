/* renderer/features/renderer-panel-code-actions.js - text actions shared by the
 * chat side panel's file preview and Changes diffs: clean copy (code text only,
 * one line per row), Ctrl+A scoped to the body, a floating "Ask Jenny" chip over
 * a selection, and a body context menu. Rows are read from the DOM contract:
 * file `[data-preview-line] > code`, diff `.diff-line[data-old-line|data-new-line]
 * .diff-content`; meta and gap rows carry neither attribute and are skipped.
 * Adapter hooks get the anchoring row (the row under the pointer, else the
 * selection's first row, else null) so one attachment can serve a page of
 * several files: getPath(rowEl), copyDiff(rowEl), openInIde(line, rowEl),
 * openFileAtLine(line, rowEl), getLanguageId(rowEl). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererPanelCodeActions = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const SPARK = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4z" fill="currentColor"/></svg>';
  const ROW_SELECTORS = {
    file: '[data-preview-line]',
    diff: '.diff-line[data-new-line], .diff-line[data-old-line]',
  };
  const TEXT_SELECTORS = { file: 'code', diff: '.diff-content' };
  // Range.compareBoundaryPoints modes.
  const START_TO_START = 0;
  const END_TO_END = 2;

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) return globalRef[globalName];
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return {};
  }

  function interpolate(template, params) {
    return params ? String(template).replace(/\{(\w+)\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match)) : template;
  }

  function markerOf(rowEl) {
    if (rowEl.classList.contains('diff-line-add')) return '+';
    if (rowEl.classList.contains('diff-line-remove')) return '-';
    return ' ';
  }

  // A removed row has no new line, so its old line stands in.
  function describeRow(rowEl, kind, textEl) {
    if (kind === 'file') return { line: Number(rowEl.dataset.previewLine), marker: '', text: textEl.textContent };
    const line = rowEl.hasAttribute('data-new-line') ? rowEl.dataset.newLine : rowEl.dataset.oldLine;
    return { line: Number(line), marker: markerOf(rowEl), text: textEl.textContent };
  }

  // The new side of a diff names the range; the old side only when every row is a removal.
  function lineRange(rows) {
    const kept = rows.filter((row) => row.marker !== '-');
    const lines = (kept.length ? kept : rows).map((row) => row.line);
    return { startLine: Math.min(...lines), endLine: Math.max(...lines) };
  }

  // The part of a row's code text inside the range.
  function clippedText(range, textEl) {
    const part = textEl.ownerDocument.createRange();
    part.selectNodeContents(textEl);
    if (range.compareBoundaryPoints(START_TO_START, part) > 0) part.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset);
    return part.toString();
  }

  function readSelection(selection, bodyEl, kind) {
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!bodyEl.contains(range.commonAncestorContainer)) return null;
    const rows = [];
    const pieces = [];
    let firstRowEl = null;
    for (const rowEl of bodyEl.querySelectorAll(ROW_SELECTORS[kind])) {
      if (!range.intersectsNode(rowEl)) continue;
      const textEl = rowEl.querySelector(TEXT_SELECTORS[kind]);
      if (!textEl) continue;
      const piece = clippedText(range, textEl);
      // A range ending in the next row's gutter touches that row without selecting any of it; so does
      // a triple-click range ending at the start of a blank row.
      if (!piece && (textEl.textContent || (rows.length && rowEl.contains(range.endContainer)))) continue;
      // A page of several files keeps the reference to the file the selection starts in.
      if (firstRowEl && rowEl.closest('.file-diff') !== firstRowEl.closest('.file-diff')) break;
      firstRowEl = firstRowEl || rowEl;
      rows.push(describeRow(rowEl, kind, textEl));
      pieces.push(piece);
    }
    if (!rows.length) return null;
    return { ...lineRange(rows), rows, text: pieces.join('\n'), firstRowEl };
  }

  function formatCopyText(rows, { withLineNumbers = false } = {}) {
    return rows.map((row) => (withLineNumbers ? `${row.line}  ${row.text}` : row.text)).join('\n');
  }

  function formatAskReference({ path, startLine, endLine, kind, languageId, rows } = {}) {
    if (!rows || !rows.length) return `\`${path}\` `;
    const range = Number.isFinite(startLine) && Number.isFinite(endLine) ? { startLine, endLine } : lineRange(rows);
    const label = range.startLine === range.endLine ? `${range.startLine}` : `${range.startLine}-${range.endLine}`;
    const body = rows.map((row) => (kind === 'diff' ? row.marker + row.text : row.text)).join('\n');
    const language = kind === 'diff' ? 'diff' : (languageId || '');
    const longestRun = Math.max(2, ...(body.match(/`+/g) || []).map((run) => run.length));
    const fence = '`'.repeat(longestRun + 1);
    return `\`${path}:${label}\`\n${fence}${language}\n${body}\n${fence}\n`;
  }

  function createPanelCodeActions(deps = {}) {
    const documentRef = deps.documentRef;
    const jt = typeof deps.jt === 'function' ? deps.jt : interpolate;
    const log = typeof deps.log === 'function' ? deps.log : () => {};
    const contextMenu = deps.contextMenu || resolveModule('inventoryContextMenu', '../inventory/context-menu');
    const actionButton = deps.actionButton || resolveModule('inventoryActionButton', '../inventory/action-button');
    const writeClipboard = deps.writeClipboard;
    const insertIntoComposer = deps.insertIntoComposer;
    const showToast = typeof deps.showToast === 'function' ? deps.showToast : () => {};
    const attachments = new Set();

    function copyText(text) {
      return Promise.resolve().then(() => writeClipboard(text)).catch((error) => {
        log('warn', 'panel_code.copy_failed', { message: String(error?.message || error) });
        showToast(jt('panelCode.copyFailed', 'Couldn’t copy'));
      });
    }

    function askJenny(adapter, selection, anchorEl) {
      const text = formatAskReference({
        path: adapter.getPath(anchorEl),
        startLine: selection?.startLine,
        endLine: selection?.endLine,
        kind: adapter.kind,
        languageId: adapter.getLanguageId?.(anchorEl),
        rows: selection?.rows,
      });
      if (insertIntoComposer({ text }) === false) showToast(jt('panelCode.noComposer', 'Open a chat to ask Jenny'));
    }

    function attach(bodyEl, adapter) {
      const kind = adapter.kind;
      const addedTabindex = !bodyEl.hasAttribute('tabindex');
      if (addedTabindex) bodyEl.setAttribute('tabindex', '0');
      const currentSelection = () => readSelection(documentRef.getSelection(), bodyEl, kind);

      const onCopy = (event) => {
        const selection = currentSelection();
        if (!selection) return;
        event.clipboardData.setData('text/plain', selection.text);
        event.preventDefault();
      };

      // The body's code text only; a body without code rows (rendered markdown) selects whole.
      const selectAll = () => {
        const textEls = [...bodyEl.querySelectorAll(ROW_SELECTORS[kind])]
          .map((rowEl) => rowEl.querySelector(TEXT_SELECTORS[kind]))
          .filter(Boolean);
        const range = documentRef.createRange();
        if (textEls.length) {
          range.setStart(textEls[0], 0);
          const last = textEls[textEls.length - 1];
          range.setEnd(last, last.childNodes.length);
        } else {
          range.selectNodeContents(bodyEl);
        }
        const selection = documentRef.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      };

      function buildMenuItems(ctx) {
        const { selection, line, anchorEl } = ctx;
        const items = [
          {
            label: jt('panelCode.copy', 'Copy'),
            disabled: !selection,
            action: () => copyText(selection.text),
          },
          {
            label: jt('panelCode.copyWithLineNumbers', 'Copy with line numbers'),
            disabled: !selection,
            action: () => copyText(formatCopyText(selection.rows, { withLineNumbers: true })),
          },
          {
            label: jt('panelCode.copyPath', 'Copy path'),
            action: () => copyText(ctx.path),
          },
        ];
        if (kind === 'diff' && adapter.copyDiff) {
          items.push({
            label: jt('panelCode.copyDiff', 'Copy diff'),
            action: () => Promise.resolve(adapter.copyDiff(anchorEl)).then((text) => (text ? copyText(text) : undefined)),
          });
        }
        items.push({
          label: selection ? jt('panelCode.askJenny', 'Ask Jenny') : jt('panelCode.askAboutFile', 'Ask Jenny about this file'),
          action: () => askJenny(adapter, selection, anchorEl),
        });
        if (adapter.openInIde) {
          items.push({
            label: line ? jt('panelCode.openInIdeAtLine', 'Open in IDE at line {line}', { line }) : jt('panelCode.openInIde', 'Open in IDE'),
            action: () => adapter.openInIde(line, anchorEl),
          });
        }
        if (adapter.openFileAtLine) {
          items.push({
            label: line ? jt('panelCode.viewFileAtLine', 'View file at line {line}', { line }) : jt('panelCode.viewFile', 'View file'),
            action: () => adapter.openFileAtLine(line, anchorEl),
          });
        }
        return items.concat(adapter.extraMenuItems?.(ctx) || []);
      }

      function openMenu(anchorX, anchorY, pointerRow) {
        const selection = currentSelection();
        const rowEl = pointerRow || null;
        const line = rowEl
          ? describeRow(rowEl, kind, rowEl.querySelector(TEXT_SELECTORS[kind]) || rowEl).line
          : (selection ? selection.rows[0].line : null);
        const anchorEl = rowEl || selection?.firstRowEl || null;
        const ctx = { kind, path: adapter.getPath(anchorEl), selection, line, anchorEl };
        contextMenu.show({
          items: buildMenuItems(ctx),
          anchorX,
          anchorY,
          ariaLabel: jt('panelCode.menuLabel', 'Code actions'),
          restoreFocusTo: bodyEl,
        });
      }

      const onContextMenu = (event) => {
        event.preventDefault();
        openMenu(event.clientX, event.clientY, event.target.closest?.(ROW_SELECTORS[kind]));
      };

      const onKeydown = (event) => {
        const key = String(event.key || '');
        if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && key.toLowerCase() === 'a') {
          event.preventDefault();
          selectAll();
          return;
        }
        if (key === 'ContextMenu' || (key === 'F10' && event.shiftKey)) {
          event.preventDefault();
          const box = bodyEl.getBoundingClientRect();
          openMenu(box.left + 8, box.top + 8, null);
        }
      };

      bodyEl.addEventListener('copy', onCopy);
      bodyEl.addEventListener('contextmenu', onContextMenu);
      bodyEl.addEventListener('keydown', onKeydown);

      // The chip lives in the body's positioned ancestor, beside the selection; a body attached while
      // hidden has none yet, so the host is settled again when the chip shows.
      let chipHost = bodyEl.offsetParent || bodyEl.parentElement;
      const chipEl = documentRef.createElement('div');
      chipEl.className = 'panel-code-ask';
      chipEl.hidden = true;
      const askLabel = jt('panelCode.askAboutSelection', 'Ask Jenny about the selected code');
      chipEl.innerHTML = typeof actionButton === 'function' ? actionButton({
        plain: true,
        className: 'panel-code-ask-button',
        ariaLabel: askLabel,
        title: askLabel,
        dataset: { 'panel-code-ask': 'true' },
        trustedHtml: `${SPARK}<span>${actionButton.escapeHtml(jt('panelCode.askJenny', 'Ask Jenny'))}</span>`,
      }) : '';
      chipHost.appendChild(chipEl);

      const hideChip = () => {
        chipEl.hidden = true;
      };

      // Never over the selected text: below the selection's last row at its end point, or above its first
      // row when the visible host has no room below. The end point's own box is preferred; the range's
      // rects (one per row) stand in when the end sits on an element boundary and has no box.
      function positionChip(range) {
        if (bodyEl.offsetParent && bodyEl.offsetParent !== chipHost) {
          chipHost = bodyEl.offsetParent;
          chipHost.appendChild(chipEl);
        }
        const rowRects = range.getClientRects?.() || [];
        const end = range.cloneRange?.();
        end?.collapse(false);
        const endRects = end?.getClientRects?.() || [];
        const last = endRects[endRects.length - 1] || rowRects[rowRects.length - 1];
        const first = rowRects[0] || last;
        if (!last) return;
        const host = chipHost.getBoundingClientRect();
        const height = chipEl.offsetHeight;
        const visibleBottom = Math.min(host.bottom, documentRef.defaultView?.innerHeight || host.bottom);
        const fitsBelow = last.bottom + height + 6 <= visibleBottom;
        const viewportTop = fitsBelow ? last.bottom + 6 : first.top - height - 6;
        const top = Math.max(4, viewportTop - host.top + chipHost.scrollTop);
        const left = Math.min(Math.max(4, last.right - host.left + chipHost.scrollLeft - chipEl.offsetWidth / 2), Math.max(4, host.width - chipEl.offsetWidth - 4));
        chipEl.style.top = `${top}px`;
        chipEl.style.left = `${left}px`;
      }

      // A mouse selection in progress shows no chip (it would chase the pointer over the text); it shows
      // on release. Keyboard selections show at once.
      let pointerSelecting = false;
      // The chip only needs a live range inside the body; reading the rows waits for copy, click or menu.
      const onSelectionChange = () => {
        const selection = documentRef.getSelection();
        const range = selection && selection.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : null;
        if (pointerSelecting || !range || !bodyEl.contains(range.commonAncestorContainer)) {
          hideChip();
          return;
        }
        chipEl.hidden = false;
        positionChip(range);
      };
      const onBodyMousedown = (event) => {
        if (event.button === 0) pointerSelecting = true;
      };
      const onMouseup = () => {
        if (!pointerSelecting) return;
        pointerSelecting = false;
        onSelectionChange();
      };
      // Every scroll in the app reaches the captured listener; only one that moves the body matters.
      const onScroll = (event) => {
        if (chipEl.hidden || !event.target?.contains?.(bodyEl)) return;
        onSelectionChange();
      };

      // Keeps the text selected while the chip is pressed.
      const onChipMousedown = (event) => event.preventDefault();
      const onChipClick = (event) => {
        if (!event.target.closest?.('.panel-code-ask-button')) return;
        // The body selection goes first: clearing it once the composer has focus can drop its caret.
        const selection = currentSelection();
        documentRef.getSelection().removeAllRanges();
        hideChip();
        askJenny(adapter, selection, selection?.firstRowEl || null);
      };

      // The panel's scroller is an ancestor: follow any scroll, captured, so the chip stays on the text.
      documentRef.addEventListener('selectionchange', onSelectionChange);
      documentRef.addEventListener('scroll', onScroll, true);
      bodyEl.addEventListener('mousedown', onBodyMousedown);
      documentRef.addEventListener('mouseup', onMouseup, true);
      chipEl.addEventListener('mousedown', onChipMousedown);
      chipEl.addEventListener('click', onChipClick);

      const detach = () => {
        if (!attachments.delete(detach)) return;
        bodyEl.removeEventListener('copy', onCopy);
        bodyEl.removeEventListener('contextmenu', onContextMenu);
        bodyEl.removeEventListener('keydown', onKeydown);
        documentRef.removeEventListener('scroll', onScroll, true);
        bodyEl.removeEventListener('mousedown', onBodyMousedown);
        documentRef.removeEventListener('mouseup', onMouseup, true);
        documentRef.removeEventListener('selectionchange', onSelectionChange);
        chipEl.remove();
        if (addedTabindex) bodyEl.removeAttribute('tabindex');
      };
      attachments.add(detach);
      return detach;
    }

    return {
      attach,
      dispose() {
        for (const detach of [...attachments]) detach();
      },
    };
  }

  return { createPanelCodeActions, readSelection, formatAskReference, formatCopyText };
});
