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
      image.decoding = 'async';
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

  // Word keeps one counter per (list, level): a paragraph advances its own
  // level and restarts every deeper one, and paragraphs, tables and other
  // lists in between never interrupt it. `counters`: numId -> level counts.
  function listLabel(list, counters) {
    const numId = String(list.numId || '');
    const level = Math.max(0, Number.parseInt(list.level, 10) || 0);
    if (!counters.has(numId)) counters.set(numId, []);
    const levels = counters.get(numId);
    const start = Number.isFinite(list.start) ? list.start : 1;
    levels[level] = levels[level] === undefined ? start : levels[level] + 1;
    levels.length = level + 1;
    return list.kind === 'bullet' ? '\u2022' : `${levels[level]}.`;
  }

  // A paragraph's list identity: while it holds, the paragraph's label
  // depends only on earlier paragraphs, so a text edit can re-render it alone.
  function listKey(list) {
    return list ? `${list.kind}:${list.numId || ''}:${list.level || 0}` : '';
  }

  function renderParagraph(documentRef, block, counters) {
    const paragraph = documentRef.createElement('p');
    paragraph.className = 'ide-docx-p';
    paragraph.dataset.block = block.id;
    paragraph.dataset.style = block.styleId || '';
    paragraph.dataset.align = block.align || '';
    if (block.list) {
      paragraph.dataset.list = block.list.kind;
      paragraph.dataset.listKey = listKey(block.list);
      paragraph.dataset.listLabel = listLabel(block.list, counters);
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
    for (const block of blocks || []) {
      if (block.type === 'paragraph') {
        parent.appendChild(renderParagraph(documentRef, block, counters));
      } else if (block.type === 'table') {
        const table = documentRef.createElement('table');
        table.className = 'ide-docx-table';
        for (const rowBlock of block.rows || []) {
          const row = documentRef.createElement('tr');
          for (const cellBlock of rowBlock.cells || []) {
            const cell = documentRef.createElement('td');
            cell.className = 'ide-docx-cell';
            cell.dataset.cell = cellBlock.id;
            appendBlocks(documentRef, cell, cellBlock.blocks, counters);
            row.appendChild(cell);
          }
          table.appendChild(row);
        }
        parent.appendChild(table);
      } else {
        const other = documentRef.createElement('div');
        other.className = 'ide-docx-other';
        other.setAttribute('contenteditable', 'false');
        other.textContent = jt('ide.docx.preservedContent', 'Content preserved (not editable here)');
        parent.appendChild(other);
      }
    }
  }

  function renderBlocks(documentRef, blocks) {
    const fragment = documentRef.createDocumentFragment();
    appendBlocks(documentRef, fragment, blocks, new Map());
    return fragment;
  }

  // One section per region (body, headers, footers); the non-body ones carry
  // a label that is not part of the editable text.
  function renderRegions(documentRef, regions) {
    const fragment = documentRef.createDocumentFragment();
    for (const region of regions || []) {
      const section = documentRef.createElement('section');
      section.className = `ide-docx-region ide-docx-region-${region.type}`;
      section.dataset.region = region.key;
      if (region.type !== 'body') {
        const label = documentRef.createElement('div');
        label.className = 'ide-docx-region-label';
        label.setAttribute('contenteditable', 'false');
        const labels = {
          header: jt('ide.docx.header', 'Header'), footer: jt('ide.docx.footer', 'Footer'),
          firstheader: jt('ide.docx.firstPageHeader', 'First page header'),
          firstfooter: jt('ide.docx.firstPageFooter', 'First page footer'),
          evenheader: jt('ide.docx.evenPageHeader', 'Even page header'),
          evenfooter: jt('ide.docx.evenPageFooter', 'Even page footer'),
        };
        const variant = region.variant === 'first' || region.variant === 'even' ? region.variant : '';
        label.textContent = labels[variant + region.type];
        section.appendChild(label);
      }
      section.appendChild(renderBlocks(documentRef, region.blocks));
      fragment.appendChild(section);
    }
    return fragment;
  }

  // Block ids are positional within their container (`b<n>`, `<cell>.b<n>`,
  // `header1::b<n>`): `base` is the id up to the ordinal (`header1::`,
  // `b2.row1.c1.`, or '' for the body). Sibling walks, not children arrays:
  // indexing an HTMLCollection is linear per access in jsdom.
  function blockIdBase(blockId) {
    const match = /^(.*)b\d+$/.exec(String(blockId || ''));
    return match ? match[1] : null;
  }

  const isBlockElement = (element) => !element.classList.contains('ide-docx-region-label');

  // From `start` on, every block element takes the id its position now gives
  // it, including the cell and paragraph ids nested in a table.
  function renumberBlocks(start, base, ordinal) {
    let next = ordinal;
    for (let element = start; element; element = element.nextElementSibling) {
      if (!isBlockElement(element)) continue;
      const id = `${base}b${next}`;
      next += 1;
      if (element.classList.contains('ide-docx-p')) {
        element.dataset.block = id;
        continue;
      }
      for (const nested of element.querySelectorAll('[data-block], [data-cell]')) {
        const key = nested.dataset.block === undefined ? 'cell' : 'block';
        const value = nested.dataset[key];
        if (value.startsWith(base)) nested.dataset[key] = id + value.slice(base.length).replace(/^b\d+/, '');
      }
    }
  }

  // Enter and a merge in a plain (non-list) paragraph patch the DOM in
  // place: only the touched paragraphs re-render and later blocks take their
  // shifted ids. Each returns false before touching the DOM when a list is
  // involved or the DOM positions disagree with the ids; the caller then
  // renders everything.
  function positionOf(paragraph) {
    const base = blockIdBase(paragraph?.dataset.block);
    if (base === null || paragraph.dataset.list) return null;
    let ordinal = 1;
    for (let sibling = paragraph.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
      if (isBlockElement(sibling)) ordinal += 1;
    }
    return paragraph.dataset.block === `${base}b${ordinal}` ? { base, ordinal } : null;
  }

  function patchSplit(documentRef, paragraph, halves) {
    const position = positionOf(paragraph);
    if (!position || halves[0]?.id !== paragraph.dataset.block || halves.some((block) => !block || block.list)) return false;
    const after = paragraph.nextElementSibling;
    paragraph.replaceWith(renderBlocks(documentRef, halves));
    renumberBlocks(after, position.base, position.ordinal + 2);
    return true;
  }

  function patchMerge(paragraph, mergedId) {
    const position = positionOf(paragraph);
    const previous = paragraph?.previousElementSibling;
    if (!position || previous?.dataset.block !== mergedId || previous.dataset.list) return false;
    const after = paragraph.nextElementSibling;
    paragraph.remove();
    renumberBlocks(after, position.base, position.ordinal);
    return true;
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

  return { renderBlocks, renderRegions, patchSplit, patchMerge, resolvePoint, resolveSelection, setCaret, listKey };
});
