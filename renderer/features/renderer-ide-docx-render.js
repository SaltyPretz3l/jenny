/* renderer/features/renderer-ide-docx-render.js - pure DOCX block DOM rendering
 * and selection/model offset mapping for the Workspace IDE DOCX pane. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeDocxRender = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  function runLength(element) {
    if (!element || element.classList?.contains('ide-docx-empty')) {
      return 0;
    }
    if (element.classList?.contains('ide-docx-img')
      || element.classList?.contains('ide-docx-img-missing')) {
      return 1;
    }
    return element.textContent?.length || 0;
  }

  function paragraphChildren(paragraph) {
    return Array.from(paragraph?.children || []).filter((child) => (
      child.classList.contains('ide-docx-run')
      || child.classList.contains('ide-docx-img')
      || child.classList.contains('ide-docx-img-missing')
      || child.classList.contains('ide-docx-empty')
    ));
  }

  function renderRun(documentRef, run) {
    if (run.kind === 'image') {
      if (!run.src) {
        const missing = documentRef.createElement('span');
        missing.className = 'ide-docx-img-missing';
        missing.dataset.run = run.id;
        missing.setAttribute('contenteditable', 'false');
        missing.textContent = jt('ide.docx.imageUnsupported', '[image]');
        return missing;
      }
      const image = documentRef.createElement('img');
      image.className = 'ide-docx-img';
      image.dataset.run = run.id;
      image.src = run.src;
      image.alt = run.alt || '';
      image.draggable = false;
      image.setAttribute('contenteditable', 'false');
      if (Number(run.widthPx) > 0) image.width = Number(run.widthPx);
      if (Number(run.heightPx) > 0) image.height = Number(run.heightPx);
      return image;
    }
    const span = documentRef.createElement('span');
    span.className = 'ide-docx-run';
    span.dataset.run = run.id;
    span.classList.toggle('is-bold', run.bold === true);
    span.classList.toggle('is-italic', run.italic === true);
    span.classList.toggle('is-underline', run.underline === true);
    span.classList.toggle('is-strike', run.strike === true);
    span.classList.toggle('is-super', run.superscript === true);
    span.appendChild(documentRef.createTextNode(run.text || ''));
    return span;
  }

  function renderParagraph(documentRef, block, state) {
    const paragraph = documentRef.createElement('p');
    paragraph.className = 'ide-docx-p';
    paragraph.dataset.block = block.id;
    paragraph.dataset.style = block.styleId || '';
    paragraph.dataset.align = block.align || '';
    if (block.list) {
      paragraph.dataset.list = block.list.kind;
      if (block.list.kind === 'bullet') {
        paragraph.dataset.listLabel = '\u2022';
        state.lastNumberId = '';
      } else {
        const numId = String(block.list.numId || '');
        if (state.lastNumberId !== numId) {
          state.number = Number.isFinite(block.list.start) ? block.list.start : 1;
        } else {
          state.number += 1;
        }
        state.lastNumberId = numId;
        paragraph.dataset.listLabel = `${state.number}.`;
      }
    } else {
      state.lastNumberId = '';
      state.number = 0;
    }
    let runOffset = 0;
    for (const run of block.runs || []) {
      if (run.kind === 'image' || run.text) {
        const element = renderRun(documentRef, run);
        if (run.kind === 'image') element.dataset.imageOffset = String(runOffset);
        paragraph.appendChild(element);
      }
      runOffset += run.text?.length || 0;
    }
    if (!paragraph.childNodes.length) {
      const line = documentRef.createElement('br');
      line.className = 'ide-docx-empty';
      paragraph.appendChild(line);
    }
    return paragraph;
  }

  function appendBlocks(documentRef, parent, blocks, counters) {
    const state = counters || { lastNumberId: '', number: 0 };
    for (const block of blocks || []) {
      if (block.type === 'paragraph') {
        parent.appendChild(renderParagraph(documentRef, block, state));
      } else if (block.type === 'table') {
        state.lastNumberId = '';
        state.number = 0;
        const table = documentRef.createElement('table');
        table.className = 'ide-docx-table';
        for (const rowBlock of block.rows || []) {
          const row = documentRef.createElement('tr');
          for (const cellBlock of rowBlock.cells || []) {
            const cell = documentRef.createElement('td');
            cell.className = 'ide-docx-cell';
            cell.dataset.cell = cellBlock.id;
            appendBlocks(documentRef, cell, cellBlock.blocks, { lastNumberId: '', number: 0 });
            row.appendChild(cell);
          }
          table.appendChild(row);
        }
        parent.appendChild(table);
      } else {
        state.lastNumberId = '';
        state.number = 0;
        const other = documentRef.createElement('div');
        other.className = 'ide-docx-other';
        other.setAttribute('contenteditable', 'false');
        other.textContent = jt('ide.docx.preservedContent', 'Content preserved (not editable here)');
        parent.appendChild(other);
      }
    }
  }

  function renderBlocks(documentRef, blocks, options = {}) {
    const fragment = documentRef.createDocumentFragment();
    const counters = options.listCounters || { lastNumberId: '', number: 0 };
    appendBlocks(documentRef, fragment, blocks, counters);
    return fragment;
  }

  function ownerElement(node) {
    return node?.nodeType === 1 ? node : node?.parentElement || null;
  }

  function closestParagraph(node) {
    const element = ownerElement(node);
    return element?.closest?.('.ide-docx-p') || null;
  }

  function offsetBefore(paragraph, target) {
    let offset = 0;
    for (const child of paragraphChildren(paragraph)) {
      if (child === target) break;
      offset += runLength(child);
    }
    return offset;
  }

  function resolvePoint(domNode, domOffset) {
    const paragraph = closestParagraph(domNode);
    if (!paragraph?.dataset.block) return null;
    const element = ownerElement(domNode);
    const locked = element?.closest?.('[contenteditable="false"]');
    if (locked && paragraph.contains(locked)) {
      return { blockId: paragraph.dataset.block, offset: offsetBefore(paragraph, locked) + runLength(locked) };
    }
    const children = paragraphChildren(paragraph);
    if (domNode === paragraph) {
      const count = Math.max(0, Math.min(Number(domOffset) || 0, paragraph.childNodes.length));
      let offset = 0;
      for (let index = 0; index < count; index += 1) {
        offset += runLength(paragraph.childNodes[index]);
      }
      return { blockId: paragraph.dataset.block, offset };
    }
    const run = element?.closest?.('.ide-docx-run, .ide-docx-img, .ide-docx-img-missing');
    if (!run || !paragraph.contains(run)) return null;
    let offset = offsetBefore(paragraph, run);
    if (run.classList.contains('ide-docx-run')) {
      if (domNode.nodeType === 3) {
        offset += Math.max(0, Math.min(Number(domOffset) || 0, domNode.nodeValue?.length || 0));
      } else if (domNode === run) {
        const count = Math.max(0, Math.min(Number(domOffset) || 0, run.childNodes.length));
        for (let index = 0; index < count; index += 1) {
          offset += run.childNodes[index].textContent?.length || 0;
        }
      }
    } else {
      offset += runLength(run);
    }
    return { blockId: paragraph.dataset.block, offset };
  }

  function resolveSelection(selection) {
    if (!selection || selection.rangeCount === 0) return null;
    const anchor = resolvePoint(selection.anchorNode, selection.anchorOffset);
    const focus = resolvePoint(selection.focusNode, selection.focusOffset);
    if (!anchor || !focus) return null;
    return {
      anchor,
      focus,
      collapsed: selection.isCollapsed,
      sameBlock: anchor.blockId === focus.blockId,
    };
  }

  function setCaret(documentRef, paragraph, requestedOffset) {
    if (!paragraph) return false;
    const selection = documentRef.defaultView?.getSelection?.() || documentRef.getSelection?.();
    if (!selection) return false;
    const children = paragraphChildren(paragraph);
    const total = children.reduce((sum, child) => sum + runLength(child), 0);
    const target = Math.max(0, Math.min(Number(requestedOffset) || 0, total));
    let position = 0;
    let node = paragraph;
    let offset = paragraph.childNodes.length;
    for (const child of children) {
      const length = runLength(child);
      const childIndex = Array.prototype.indexOf.call(paragraph.childNodes, child);
      if (child.classList.contains('ide-docx-run') && target <= position + length) {
        const textNode = child.firstChild || child;
        node = textNode;
        offset = Math.max(0, Math.min(target - position, textNode.nodeValue?.length || 0));
        break;
      }
      if (length === 1 && target <= position) {
        node = paragraph;
        offset = childIndex;
        break;
      }
      if (length === 1 && target === position + 1) {
        node = paragraph;
        offset = childIndex + 1;
        break;
      }
      position += length;
    }
    const range = documentRef.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  return { renderBlocks, resolvePoint, resolveSelection, setCaret };
});
