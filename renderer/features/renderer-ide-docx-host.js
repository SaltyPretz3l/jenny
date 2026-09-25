/* renderer/features/renderer-ide-docx-host.js - preservation-first DOCX
 * editing pane for the Workspace IDE document host. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeDocxHost = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const MAX_MEDIA_BYTES = 32 * 1024 * 1024;
  const MAX_INSERT_IMAGE_BYTES = 10 * 1024 * 1024;
  const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
  const RELATIONSHIPS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const NUMBERING_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml';
  const NUMBERING_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering';

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

  function decodeBase64(base64, windowRef) {
    const binary = windowRef.atob(String(base64 || ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function encodeBase64(bytes, windowRef) {
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
    }
    return windowRef.btoa(chunks.join(''));
  }

  function mediaMime(name) {
    const extension = String(name || '').split('.').pop().toLowerCase();
    return {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      bmp: 'image/bmp', webp: 'image/webp',
    }[extension] || '';
  }

  function xmlDeclaration(xml) {
    return String(xml || '').match(/^<\?xml[^\r\n]*\?>(?:\r\n|\n|\r)?/)?.[0] || '';
  }

  function parseXml(Parser, xml) {
    const documentRef = new Parser().parseFromString(String(xml || ''), 'application/xml');
    if (!documentRef.documentElement || documentRef.documentElement.localName === 'parsererror'
      || documentRef.getElementsByTagName('parsererror').length) {
      const error = new Error('Invalid DOCX package XML');
      error.code = 'docx_invalid';
      throw error;
    }
    return documentRef;
  }

  function findBlock(blocks, id) {
    for (const block of blocks || []) {
      if (block.id === id) return block;
      if (block.type === 'table') {
        for (const row of block.rows || []) {
          for (const cell of row.cells || []) {
            const match = findBlock(cell.blocks, id);
            if (match) return match;
          }
        }
      }
    }
    return null;
  }

  function findBlockGroup(blocks, id) {
    if ((blocks || []).some((block) => block.id === id)) return blocks;
    for (const block of blocks || []) {
      if (block.type !== 'table') continue;
      for (const row of block.rows || []) {
        for (const cell of row.cells || []) {
          const match = findBlockGroup(cell.blocks, id);
          if (match) return match;
        }
      }
    }
    return null;
  }

  function createIdeDocxPane(deps) {
    const getHost = typeof deps?.getHost === 'function' ? deps.getHost : () => null;
    const onDirtyChange = typeof deps?.onDirtyChange === 'function' ? deps.onDirtyChange : () => {};
    const onSaveRequest = typeof deps?.onSaveRequest === 'function' ? deps.onSaveRequest : () => {};
    const onEdit = typeof deps?.onEdit === 'function' ? deps.onEdit : () => {};
    const log = typeof deps?.log === 'function' ? deps.log : () => {};
    const zipUtils = deps?.zipUtils || resolveModule('rendererIdeDocxZip', './renderer-ide-docx-zip');
    const modelUtils = deps?.modelUtils || resolveModule('rendererIdeDocxModel', './renderer-ide-docx-model');
    const richUtils = deps?.richUtils || resolveModule('rendererIdeDocxRich', './renderer-ide-docx-rich');
    const renderUtils = deps?.renderUtils || resolveModule('rendererIdeDocxRender', './renderer-ide-docx-render');
    const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');
    const fileInput = resolveModule('inventoryFileInput', '../inventory/file-input');
    const documents = new Map();
    const loadGenerations = new Map();

    let paneEl = null;
    let documentsEl = null;
    let notesEl = null;
    let currentPath = null;
    let disposed = false;
    let typing = null;
    let imageInsertion = null;
    let selectedImage = null;

    function toolbarButton(action, label, title) {
      if (typeof actionButton !== 'function') return '';
      return actionButton({
        plain: true,
        className: 'ide-docx-action',
        label,
        title,
        ariaLabel: title,
        ariaPressed: false,
        dataset: { 'ide-docx-action': action },
      });
    }

    function buildToolbarMarkup() {
      return '<div class="ide-docx-toolbar" role="toolbar">'
        + toolbarButton('bold', jt('ide.docx.boldShort', 'B'), jt('ide.docx.bold', 'Bold'))
        + toolbarButton('italic', jt('ide.docx.italicShort', 'I'), jt('ide.docx.italic', 'Italic'))
        + toolbarButton('underline', jt('ide.docx.underlineShort', 'U'), jt('ide.docx.underline', 'Underline'))
        + '<span class="ide-docx-toolbar-separator" aria-hidden="true"></span>'
        + toolbarButton('bullets', jt('ide.docx.bullets', 'Bullets'), jt('ide.docx.bullets', 'Bullets'))
        + toolbarButton('numbering', jt('ide.docx.numbering', 'Numbering'), jt('ide.docx.numbering', 'Numbering'))
        + '<span class="ide-docx-toolbar-separator" aria-hidden="true"></span>'
        + toolbarButton('insertImage', jt('ide.docx.insertImage', 'Insert image'), jt('ide.docx.insertImage', 'Insert image'))
        + toolbarButton('imageSmaller', '−', jt('ide.docx.imageSmaller', 'Make image smaller'))
        + toolbarButton('imageLarger', '+', jt('ide.docx.imageLarger', 'Make image larger'))
        + '<span class="ide-docx-toolbar-separator" aria-hidden="true"></span>'
        + toolbarButton('undo', jt('ide.docx.undo', 'Undo'), jt('ide.docx.undo', 'Undo'))
        + toolbarButton('redo', jt('ide.docx.redo', 'Redo'), jt('ide.docx.redo', 'Redo'))
        + '</div>';
    }

    function ensurePane() {
      if (paneEl) return paneEl;
      const host = getHost();
      const documentRef = host?.ownerDocument || null;
      if (!host || !documentRef || disposed) return null;
      paneEl = documentRef.createElement('div');
      paneEl.className = 'ide-docx-pane hidden';
      paneEl.innerHTML = buildToolbarMarkup()
        + '<div class="ide-docx-notes hidden" role="status"></div>'
        + '<div class="ide-docx-documents"></div>';
      if (typeof fileInput === 'function') paneEl.prepend(fileInput(documentRef, {
        className: 'ide-docx-image-input', accept: 'image/png,image/jpeg,image/gif,image/webp,image/bmp', hidden: true,
      }));
      notesEl = paneEl.querySelector('.ide-docx-notes');
      documentsEl = paneEl.querySelector('.ide-docx-documents');
      paneEl.addEventListener('click', handleToolbarClick);
      paneEl.addEventListener('mousedown', handleToolbarMouseDown);
      paneEl.querySelector('.ide-docx-image-input')?.addEventListener('change', handleImageInput);
      documentRef.addEventListener('selectionchange', handleSelectionChange);
      host.appendChild(paneEl);
      return paneEl;
    }

    function makeFailure(code, message) {
      const defaults = {
        document_corrupt: jt('ide.docx.corrupt', 'Could not open this Word document because it is corrupted or incomplete.'),
        document_unsupported: jt('ide.docx.unsupported', 'This Word document is not supported.'),
        document_too_large: jt('ide.docx.tooLarge', 'This Word document is too large to open.'),
      };
      return { ok: false, code, message: message || defaults[code] };
    }

    function classifyError(error) {
      if (error?.code === 'zip_too_large') return makeFailure('document_too_large');
      if (error?.code === 'zip_unsupported') return makeFailure('document_unsupported');
      return makeFailure('document_corrupt');
    }

    async function readOptionalText(zip, name) {
      return zip.entries.has(name) ? zipUtils.readEntryText(zip, name) : null;
    }

    async function readMedia(zip, windowRef) {
      const media = new Map();
      let total = 0;
      for (const name of zip.order) {
        if (!name.startsWith('word/media/')) continue;
        const mime = mediaMime(name);
        const entry = zip.entries.get(name);
        if (!mime || !entry) continue;
        if (total + entry.uncompressedSize > MAX_MEDIA_BYTES) break;
        const bytes = await zipUtils.readEntryBytes(zip, name);
        total += bytes.length;
        media.set(name, { mime, base64: encodeBase64(bytes, windowRef) });
      }
      return media;
    }

    function createContainer(path, documentRef) {
      const container = documentRef.createElement('div');
      container.className = 'ide-docx-doc hidden';
      container.setAttribute('contenteditable', 'true');
      container.setAttribute('spellcheck', 'true');
      container.dataset.path = path;
      const beforeInput = (event) => handleBeforeInput(path, event);
      const keydown = (event) => handleKeydown(path, event);
      const compositionStart = () => handleCompositionStart(path);
      const compositionEnd = (event) => handleCompositionEnd(path, event);
      const click = (event) => handleDocumentClick(path, event);
      container.addEventListener('beforeinput', beforeInput);
      container.addEventListener('keydown', keydown);
      container.addEventListener('compositionstart', compositionStart);
      container.addEventListener('compositionend', compositionEnd);
      container.addEventListener('click', click);
      documentsEl.appendChild(container);
      return { container, beforeInput, keydown, compositionStart, compositionEnd, click };
    }

    function removeRecord(record) {
      if (!record) return;
      record.container.removeEventListener('beforeinput', record.beforeInput);
      record.container.removeEventListener('keydown', record.keydown);
      record.container.removeEventListener('compositionstart', record.compositionStart);
      record.container.removeEventListener('compositionend', record.compositionEnd);
      record.container.removeEventListener('click', record.click);
      record.container.remove();
    }

    async function load(path, source) {
      const normalizedPath = String(path || '');
      const root = ensurePane();
      if (!normalizedPath || !root || typeof zipUtils.readZip !== 'function'
        || typeof modelUtils.createDocxModel !== 'function' || typeof renderUtils.renderBlocks !== 'function') {
        return makeFailure('document_unsupported');
      }
      const documentRef = root.ownerDocument;
      const windowRef = documentRef.defaultView;
      const Parser = windowRef?.DOMParser;
      const Serializer = windowRef?.XMLSerializer;
      const generation = (loadGenerations.get(normalizedPath) || 0) + 1;
      loadGenerations.set(normalizedPath, generation);
      const isCurrent = () => !disposed && loadGenerations.get(normalizedPath) === generation;
      let zip;
      let model;
      try {
        const bytes = decodeBase64(source?.base64, windowRef);
        zip = await zipUtils.readZip(bytes);
        if (!zip.entries.has('word/document.xml')) {
          return makeFailure('document_unsupported', jt('ide.docx.notWordDocument', 'not a Word document'));
        }
        const documentXml = await zipUtils.readEntryText(zip, 'word/document.xml');
        const numberingXml = await readOptionalText(zip, 'word/numbering.xml');
        const relsXml = await readOptionalText(zip, 'word/_rels/document.xml.rels');
        const media = await readMedia(zip, windowRef);
        const relatedParts = [];
        const discovered = richUtils.discoverRelatedParts?.({ documentXml, relsXml, DOMParser: Parser }) || [];
        for (const descriptor of discovered) {
          if (!zip.entries.has(descriptor.path)) continue;
          relatedParts.push({
            ...descriptor,
            xml: await zipUtils.readEntryText(zip, descriptor.path),
            relsXml: await readOptionalText(zip, descriptor.relsPath),
          });
        }
        const modelOptions = { documentXml, numberingXml, relsXml, media, relatedParts, occupiedNames: new Set(zip.entries.keys()), DOMParser: Parser, XMLSerializer: Serializer };
        model = richUtils.createCompositeDocxModel
          ? richUtils.createCompositeDocxModel({ ...modelOptions, createDocxModel: modelUtils.createDocxModel })
          : modelUtils.createDocxModel(modelOptions);
      } catch (error) {
        log('WARN', 'ide.docx_load_failed', { path: normalizedPath, code: error?.code || 'unknown' });
        return classifyError(error);
      }
      // Parsed into a candidate only: a close/dispose/newer load during the
      // parse, or a caller veto (edits arrived meanwhile), leaves the live
      // record untouched.
      if (!isCurrent() || (typeof source?.shouldCommit === 'function' && source.shouldCommit() !== true)) {
        return makeFailure('document_stale', jt('ide.docx.staleReload', 'The document changed before the reload could be applied.'));
      }
      endTyping();
      const existing = documents.get(normalizedPath);
      const wasVisible = currentPath === normalizedPath && !paneEl.classList.contains('hidden');
      if (existing?.dirty) onDirtyChange(normalizedPath, false);
      removeRecord(existing);
      const handlers = createContainer(normalizedPath, documentRef);
      const record = { path: normalizedPath, zip, model, dirty: false, ...handlers };
      documents.set(normalizedPath, record);
      renderAll(record);
      if (wasVisible) show(normalizedPath);
      return { ok: true };
    }

    function renderAll(record) {
      const documentRef = record.container.ownerDocument;
      const regions = record.model.getRegions?.() || [{ key: 'body', type: 'body', variant: 'default', blocks: record.model.getBlocks() }];
      const fragment = documentRef.createDocumentFragment();
      for (const region of regions) {
        const section = documentRef.createElement('section');
        section.className = `ide-docx-region ide-docx-region-${region.type}`;
        section.dataset.region = region.key;
        if (region.type !== 'body') {
          const label = documentRef.createElement('div');
          label.className = 'ide-docx-region-label';
          label.setAttribute('contenteditable', 'false');
          const key = region.variant === 'first' ? `firstPage${region.type[0].toUpperCase()}${region.type.slice(1)}`
            : region.variant === 'even' ? `evenPage${region.type[0].toUpperCase()}${region.type.slice(1)}` : region.type;
          const labels = {
            header: jt('ide.docx.header', 'Header'), footer: jt('ide.docx.footer', 'Footer'),
            firstPageHeader: jt('ide.docx.firstPageHeader', 'First page header'),
            firstPageFooter: jt('ide.docx.firstPageFooter', 'First page footer'),
            evenPageHeader: jt('ide.docx.evenPageHeader', 'Even page header'),
            evenPageFooter: jt('ide.docx.evenPageFooter', 'Even page footer'),
          };
          label.textContent = labels[key];
          section.appendChild(label);
        }
        section.appendChild(renderUtils.renderBlocks(documentRef, region.blocks, { listCounters: { lastNumberId: '', number: 0 } }));
        fragment.appendChild(section);
      }
      record.container.replaceChildren(fragment);
      restoreSelectedImage(record);
    }

    function paragraphElement(record, blockId) {
      return Array.from(record.container.querySelectorAll('.ide-docx-p'))
        .find((element) => element.dataset.block === blockId) || null;
    }

    function renderParagraph(record, blockId) {
      const oldParagraph = paragraphElement(record, blockId);
      const block = findBlock(record.model.getBlocks(), blockId);
      if (!oldParagraph || !block || block.type !== 'paragraph' || block.list) {
        renderAll(record);
        return;
      }
      const fragment = renderUtils.renderBlocks(record.container.ownerDocument, [block]);
      oldParagraph.replaceWith(fragment.firstChild);
      restoreSelectedImage(record);
    }

    function restoreCaret(record, point) {
      if (!point) return;
      renderUtils.setCaret(record.container.ownerDocument, paragraphElement(record, point.blockId), point.offset);
      refreshToolbar();
    }

    function setDirty(record) {
      const next = record.model.isDirty();
      if (next) onEdit(record.path);
      if (record.dirty === next) return;
      record.dirty = next;
      onDirtyChange(record.path, next);
    }

    function endTyping() {
      if (!typing) return;
      clearTimeout(typing.timer);
      typing.record.model.endTransaction();
      typing = null;
    }

    function useTypingTransaction(record, blockId) {
      const value = String(blockId || '');
      const owner = value.includes('::') ? value.split('::')[0] : 'body';
      if (typing?.record !== record || typing?.owner !== owner) endTyping();
      if (!typing) {
        record.model.beginTransaction();
        typing = { record, owner, timer: null };
      }
      clearTimeout(typing.timer);
      typing.timer = setTimeout(endTyping, 400);
    }

    function atomic(record, operation) {
      endTyping();
      record.model.beginTransaction();
      try {
        return operation();
      } finally {
        record.model.endTransaction();
      }
    }

    function currentSelection(record) {
      const selection = record.container.ownerDocument.defaultView.getSelection();
      if (!selection?.anchorNode || !record.container.contains(selection.anchorNode)
        || !record.container.contains(selection.focusNode)) return null;
      return renderUtils.resolveSelection(selection);
    }

    function orderedRange(record, resolved) {
      if (!resolved) return null;
      if (resolved.sameBlock) {
        const start = Math.min(resolved.anchor.offset, resolved.focus.offset);
        const end = Math.max(resolved.anchor.offset, resolved.focus.offset);
        return { start: { blockId: resolved.anchor.blockId, offset: start }, end: { blockId: resolved.anchor.blockId, offset: end } };
      }
      const paragraphs = Array.from(record.container.querySelectorAll('.ide-docx-p'));
      const anchorIndex = paragraphs.findIndex((item) => item.dataset.block === resolved.anchor.blockId);
      const focusIndex = paragraphs.findIndex((item) => item.dataset.block === resolved.focus.blockId);
      if (anchorIndex < 0 || focusIndex < 0) return null;
      return anchorIndex < focusIndex
        ? { start: resolved.anchor, end: resolved.focus }
        : { start: resolved.focus, end: resolved.anchor };
    }

    function deleteSelection(record, resolved) {
      const range = orderedRange(record, resolved);
      if (!range || (range.start.blockId === range.end.blockId && range.start.offset === range.end.offset)) return null;
      if (range.start.blockId === range.end.blockId) {
        record.model.deleteRange(range.start.blockId, range.start.offset, range.end.offset);
        return { point: range.start, structural: false };
      }
      const startElement = paragraphElement(record, range.start.blockId);
      const endElement = paragraphElement(record, range.end.blockId);
      if (!startElement || startElement.parentElement !== endElement?.parentElement) return null;
      const siblings = Array.from(startElement.parentElement.children);
      const startIndex = siblings.indexOf(startElement);
      const endIndex = siblings.indexOf(endElement);
      if (startIndex < 0 || endIndex <= startIndex
        || siblings.slice(startIndex, endIndex + 1).some((item) => !item.classList.contains('ide-docx-p'))) return null;
      const mergeCount = endIndex - startIndex;
      const firstText = record.model.getParagraphText(range.start.blockId);
      if (range.start.offset < firstText.length) record.model.deleteRange(range.start.blockId, range.start.offset, firstText.length);
      for (let index = 0; index < mergeCount; index += 1) {
        const blocks = record.model.getBlocks();
        const group = findBlockGroup(blocks, range.start.blockId);
        const first = group?.findIndex((block) => block.id === range.start.blockId) ?? -1;
        const next = first >= 0 ? group[first + 1] : null;
        if (!next || next.type !== 'paragraph') break;
        const keep = index === mergeCount - 1 ? range.end.offset : record.model.getParagraphText(next.id).length;
        if (keep > 0) record.model.deleteRange(next.id, 0, keep);
        record.model.mergeWithPrevious(next.id);
      }
      return { point: range.start, structural: true };
    }

    function applyInsert(record, resolved, text, coalesce) {
      if (!resolved) return;
      let result;
      const operation = () => {
        const deletion = resolved.collapsed ? null : deleteSelection(record, resolved);
        const point = deletion?.point || resolved.anchor;
        if (!point || (!resolved.sameBlock && !deletion)) return null;
        record.model.insertText(point.blockId, point.offset, text);
        return { point: { blockId: point.blockId, offset: point.offset + text.length }, structural: deletion?.structural === true };
      };
      if (resolved.collapsed && coalesce) {
        useTypingTransaction(record, resolved.anchor.blockId);
        result = operation();
      } else {
        result = atomic(record, operation);
      }
      if (!result) return;
      if (result.structural) renderAll(record);
      else renderParagraph(record, result.point.blockId);
      restoreCaret(record, result.point);
      setDirty(record);
    }

    function neighboringParagraph(record, blockId, direction) {
      const element = paragraphElement(record, blockId);
      let sibling = element?.[direction] || null;
      while (sibling && !sibling.classList.contains('ide-docx-p')) sibling = sibling[direction];
      return sibling?.dataset.block ? { id: sibling.dataset.block, length: record.model.getParagraphText(sibling.dataset.block).length } : null;
    }

    function applyDelete(record, resolved, backward) {
      if (!resolved) return;
      if (!resolved.collapsed) {
        const result = atomic(record, () => deleteSelection(record, resolved));
        if (!result) return;
        if (result.structural) renderAll(record);
        else renderParagraph(record, result.point.blockId);
        restoreCaret(record, result.point);
        setDirty(record);
        return;
      }
      const point = resolved.anchor;
      const text = record.model.getParagraphText(point.blockId);
      if (backward && point.offset > 0) {
        useTypingTransaction(record, point.blockId);
        record.model.deleteRange(point.blockId, point.offset - 1, point.offset);
        renderParagraph(record, point.blockId);
        restoreCaret(record, { blockId: point.blockId, offset: point.offset - 1 });
      } else if (!backward && point.offset < text.length) {
        useTypingTransaction(record, point.blockId);
        record.model.deleteRange(point.blockId, point.offset, point.offset + 1);
        renderParagraph(record, point.blockId);
        restoreCaret(record, point);
      } else if (backward && point.offset === 0) {
        endTyping();
        const previous = neighboringParagraph(record, point.blockId, 'previousElementSibling');
        const merged = previous ? record.model.mergeWithPrevious(point.blockId) : null;
        if (merged) {
          renderAll(record);
          restoreCaret(record, { blockId: merged, offset: previous.length });
        }
      } else if (!backward && point.offset === text.length) {
        endTyping();
        const next = neighboringParagraph(record, point.blockId, 'nextElementSibling');
        if (next && record.model.mergeWithPrevious(next.id)) {
          renderAll(record);
          restoreCaret(record, point);
        }
      }
      setDirty(record);
    }

    function applySplit(record, resolved) {
      if (!resolved) return;
      const result = atomic(record, () => {
        const deletion = resolved.collapsed ? null : deleteSelection(record, resolved);
        const point = deletion?.point || resolved.anchor;
        if (!point || (!resolved.sameBlock && !deletion)) return null;
        const newId = record.model.splitParagraph(point.blockId, point.offset);
        return newId ? { blockId: newId, offset: 0 } : null;
      });
      if (!result) return;
      renderAll(record);
      restoreCaret(record, result);
      setDirty(record);
    }

    function applyFormat(record, property) {
      endTyping();
      const resolved = currentSelection(record);
      if (!resolved || resolved.collapsed || !resolved.sameBlock) return;
      const range = orderedRange(record, resolved);
      if (record.model.toggleRunProperty(range.start.blockId, range.start.offset, range.end.offset, property) === false
        && property !== 'bold' && property !== 'italic' && property !== 'underline') return;
      renderParagraph(record, range.start.blockId);
      const paragraph = paragraphElement(record, range.start.blockId);
      renderUtils.setCaret(record.container.ownerDocument, paragraph, range.end.offset);
      setDirty(record);
      refreshToolbar();
    }

    function applyList(record, kind) {
      endTyping();
      const resolved = currentSelection(record);
      const blockId = resolved?.anchor.blockId;
      if (!blockId) return;
      const current = record.model.getListInfo(blockId)?.kind || null;
      record.model.setList(blockId, current === kind ? null : kind);
      renderAll(record);
      restoreCaret(record, resolved.anchor);
      setDirty(record);
    }

    function applyHistory(record, redo) {
      endTyping();
      const point = currentSelection(record)?.anchor || null;
      const changed = redo ? record.model.redo() : record.model.undo();
      if (!changed) return;
      renderAll(record);
      restoreCaret(record, point);
      setDirty(record);
    }

    function clearSelectedImage() {
      paneEl?.querySelectorAll('.ide-docx-img.is-selected').forEach((image) => image.classList.remove('is-selected'));
      selectedImage = null;
      refreshToolbar();
    }

    function restoreSelectedImage(record) {
      if (!selectedImage || selectedImage.path !== record.path) return;
      const paragraph = paragraphElement(record, selectedImage.blockId);
      const image = Array.from(paragraph?.querySelectorAll('.ide-docx-img') || [])
        .find((item) => Number(item.dataset.imageOffset) === selectedImage.offset);
      if (!image) {
        selectedImage = null;
        return;
      }
      image.classList.add('is-selected');
      selectedImage.width = image.width || Number(image.getAttribute('width')) || selectedImage.width;
      selectedImage.height = image.height || Number(image.getAttribute('height')) || selectedImage.height;
    }

    function handleDocumentClick(path, event) {
      const image = event.target?.closest?.('.ide-docx-img');
      const record = documents.get(path);
      if (!record || !image) {
        if (selectedImage?.path === path) clearSelectedImage();
        return;
      }
      paneEl?.querySelectorAll('.ide-docx-img.is-selected').forEach((item) => item.classList.remove('is-selected'));
      image.classList.add('is-selected');
      selectedImage = {
        path, blockId: image.closest('.ide-docx-p')?.dataset.block,
        offset: Number(image.dataset.imageOffset), width: image.width, height: image.height,
      };
      refreshToolbar();
    }

    function showImageError(message) {
      if (!notesEl) return;
      notesEl.classList.remove('hidden');
      notesEl.textContent = message;
    }

    async function imageSize(windowRef, bytes, mime) {
      if (typeof windowRef.createImageBitmap !== 'function') return { width: 320, height: 180 };
      const bitmap = await windowRef.createImageBitmap(new windowRef.Blob([bytes], { type: mime }));
      const scale = Math.min(1, 640 / bitmap.width, 720 / bitmap.height);
      const result = { width: Math.max(24, Math.round(bitmap.width * scale)), height: Math.max(24, Math.round(bitmap.height * scale)) };
      bitmap.close?.();
      return result;
    }

    async function handleImageInput(event) {
      const file = event.target?.files?.[0];
      const insertion = imageInsertion;
      imageInsertion = null;
      if (event.target) event.target.value = '';
      if (!file || !insertion) return;
      const allowed = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);
      if (!allowed.has(file.type)) {
        showImageError(jt('ide.docx.imageInvalid', 'Choose a valid PNG, JPEG, GIF, WebP, or BMP image.'));
        return;
      }
      if (!Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_INSERT_IMAGE_BYTES) {
        showImageError(jt('ide.docx.imageTooLarge', 'Choose an image smaller than 10 MiB.'));
        return;
      }
      const record = documents.get(insertion.path);
      if (!record) return;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (documents.get(insertion.path) !== record || disposed) return;
        if (!bytes.length || bytes.length > MAX_INSERT_IMAGE_BYTES) {
          showImageError(jt('ide.docx.imageTooLarge', 'Choose an image smaller than 10 MiB.'));
          return;
        }
        const size = await imageSize(record.container.ownerDocument.defaultView, bytes, file.type);
        if (documents.get(insertion.path) !== record || disposed) return;
        const added = atomic(record, () => record.model.insertImage(insertion.point.blockId, insertion.point.offset, {
          mime: file.type, base64: encodeBase64(bytes, record.container.ownerDocument.defaultView),
          widthPx: size.width, heightPx: size.height, name: file.name,
        }));
        if (!added) throw new Error('image rejected');
        selectedImage = { path: record.path, blockId: insertion.point.blockId, offset: insertion.point.offset, ...size };
        renderParagraph(record, insertion.point.blockId);
        restoreSelectedImage(record);
        restoreCaret(record, { blockId: insertion.point.blockId, offset: insertion.point.offset + 1 });
        setDirty(record);
      } catch (_error) {
        if (documents.get(insertion.path) !== record || disposed) return;
        showImageError(jt('ide.docx.imageInvalid', 'Choose a valid PNG, JPEG, GIF, WebP, or BMP image.'));
      }
    }

    function resizeSelectedImage(record, scale) {
      if (!selectedImage || selectedImage.path !== record.path) return;
      const width = Math.round(selectedImage.width * scale);
      const height = Math.round(selectedImage.height * scale);
      if (!atomic(record, () => record.model.resizeImage(selectedImage.blockId, selectedImage.offset, width, height))) return;
      selectedImage.width = Math.max(24, Math.min(1200, width));
      selectedImage.height = Math.max(24, Math.min(1200, height));
      renderParagraph(record, selectedImage.blockId);
      restoreSelectedImage(record);
      setDirty(record);
      refreshToolbar();
    }

    // IME composition (CJK and dead keys): the browser must own the DOM while
    // the candidate text is being composed, so composition input types are NOT
    // cancelled. compositionstart pins the model point, compositionend discards
    // the browser's provisional DOM by re-rendering the paragraph from the model
    // and inserts the committed text at the pinned point.
    function handleCompositionStart(path) {
      const record = documents.get(path);
      if (!record) return;
      endTyping();
      const resolved = currentSelection(record);
      if (resolved && !resolved.collapsed) applyDelete(record, resolved, true);
      const point = currentSelection(record)?.anchor || null;
      record.composition = point && resolved?.sameBlock !== false ? { point } : null;
    }

    function handleCompositionEnd(path, event) {
      const record = documents.get(path);
      if (!record) return;
      const point = record.composition?.point || null;
      record.composition = null;
      if (!point) return;
      renderParagraph(record, point.blockId);
      const text = String(event?.data || '');
      if (text) applyInsert(record, { collapsed: true, sameBlock: true, anchor: point, focus: point }, text, false);
      else restoreCaret(record, point);
    }

    function handleBeforeInput(path, event) {
      const record = documents.get(path);
      if (!record) return;
      if (event.inputType === 'insertCompositionText' || event.inputType === 'deleteCompositionText') return;
      event.preventDefault();
      const resolved = currentSelection(record);
      switch (event.inputType) {
        case 'insertText':
        case 'insertReplacementText':
          if (event.data) applyInsert(record, resolved, event.data, event.inputType === 'insertText');
          break;
        case 'insertParagraph': applySplit(record, resolved); break;
        case 'insertLineBreak': applyInsert(record, resolved, '\n', false); break;
        case 'deleteContentBackward': applyDelete(record, resolved, true); break;
        case 'deleteContentForward': applyDelete(record, resolved, false); break;
        case 'deleteByCut':
        case 'deleteContent':
          if (resolved && !resolved.collapsed) applyDelete(record, resolved, true);
          break;
        case 'insertFromPaste': {
          endTyping();
          const text = event.dataTransfer?.getData?.('text/plain') || '';
          if (text) applyInsert(record, resolved, text.replace(/\r\n?/g, '\n'), false);
          break;
        }
        case 'formatBold': applyFormat(record, 'bold'); break;
        case 'formatItalic': applyFormat(record, 'italic'); break;
        case 'formatUnderline': applyFormat(record, 'underline'); break;
        case 'historyUndo': applyHistory(record, false); break;
        case 'historyRedo': applyHistory(record, true); break;
        default: endTyping();
      }
    }

    function handleKeydown(path, event) {
      const record = documents.get(path);
      if (!record) return;
      const modifier = event.ctrlKey || event.metaKey;
      const key = String(event.key || '').toLowerCase();
      if (modifier && key === 's') {
        event.preventDefault();
        event.stopPropagation();
        endTyping();
        onSaveRequest();
      } else if (modifier && ['b', 'i', 'u'].includes(key)) {
        event.preventDefault();
        applyFormat(record, { b: 'bold', i: 'italic', u: 'underline' }[key]);
      } else if (modifier && key === 'z') {
        event.preventDefault();
        applyHistory(record, event.shiftKey);
      } else if (modifier && key === 'y') {
        event.preventDefault();
        applyHistory(record, true);
      } else if (!modifier && event.key === 'Tab') {
        event.preventDefault();
        applyInsert(record, currentSelection(record), '\t', true);
      }
    }

    function handleToolbarMouseDown(event) {
      if (event.target?.closest?.('[data-ide-docx-action]')) event.preventDefault();
    }

    function handleToolbarClick(event) {
      const button = event.target?.closest?.('[data-ide-docx-action]');
      const record = currentPath ? documents.get(currentPath) : null;
      if (!button || !record) return;
      const action = button.dataset.ideDocxAction;
      if (['bold', 'italic', 'underline'].includes(action)) applyFormat(record, action);
      else if (action === 'bullets') applyList(record, 'bullet');
      else if (action === 'numbering') applyList(record, 'number');
      else if (action === 'insertImage') {
        const point = currentSelection(record)?.anchor;
        if (point) {
          imageInsertion = { path: record.path, point };
          paneEl.querySelector('.ide-docx-image-input')?.click();
        }
      } else if (action === 'imageSmaller') resizeSelectedImage(record, 0.8);
      else if (action === 'imageLarger') resizeSelectedImage(record, 1.25);
      else if (action === 'undo') applyHistory(record, false);
      else if (action === 'redo') applyHistory(record, true);
    }

    function selectionProperty(record, resolved, property) {
      if (!resolved?.sameBlock) return false;
      const block = findBlock(record.model.getBlocks(), resolved.anchor.blockId);
      if (!block?.runs) return false;
      if (resolved.collapsed) {
        let offset = 0;
        const run = block.runs.find((item) => {
          const end = offset + item.text.length;
          const match = resolved.anchor.offset > offset && resolved.anchor.offset <= end;
          offset = end;
          return match;
        }) || block.runs[0];
        return run?.[property] === true;
      }
      const range = orderedRange(record, resolved);
      let offset = 0;
      const selected = block.runs.filter((run) => {
        const start = offset;
        offset += run.text.length;
        return run.kind === 'text' && start < range.end.offset && offset > range.start.offset;
      });
      return selected.length > 0 && selected.every((run) => run[property] === true);
    }

    function refreshToolbar() {
      if (!paneEl) return;
      const record = currentPath ? documents.get(currentPath) : null;
      const resolved = record ? currentSelection(record) : null;
      const values = {
        bold: record ? selectionProperty(record, resolved, 'bold') : false,
        italic: record ? selectionProperty(record, resolved, 'italic') : false,
        underline: record ? selectionProperty(record, resolved, 'underline') : false,
        bullets: record && resolved ? record.model.getListInfo(resolved.anchor.blockId)?.kind === 'bullet' : false,
        numbering: record && resolved ? record.model.getListInfo(resolved.anchor.blockId)?.kind === 'number' : false,
      };
      for (const button of paneEl.querySelectorAll('[data-ide-docx-action]')) {
        if (Object.hasOwn(values, button.dataset.ideDocxAction)) {
          button.setAttribute('aria-pressed', String(values[button.dataset.ideDocxAction]));
        }
        if (['imageSmaller', 'imageLarger'].includes(button.dataset.ideDocxAction)) {
          button.disabled = !selectedImage || selectedImage.path !== currentPath;
        }
        if (['bullets', 'numbering'].includes(button.dataset.ideDocxAction)) {
          button.disabled = !record || !resolved || record.model.canSetList?.(resolved.anchor.blockId) === false;
        }
      }
    }

    function handleSelectionChange() {
      refreshToolbar();
    }

    function refreshNotes(record) {
      const noteLabels = {
        fields: jt('ide.docx.note.fields', 'fields'),
        footnotes: jt('ide.docx.note.footnotes', 'footnotes'),
        comments: jt('ide.docx.note.comments', 'comments'),
        trackedChanges: jt('ide.docx.note.trackedChanges', 'tracked changes'),
        contentControls: jt('ide.docx.note.contentControls', 'content controls'),
        textBoxes: jt('ide.docx.note.textBoxes', 'text boxes'),
        math: jt('ide.docx.note.math', 'math'),
        nestedTables: jt('ide.docx.note.nestedTables', 'nested tables'),
      };
      const notes = record.model.getUnsupportedNotes();
      notesEl.classList.toggle('hidden', notes.length === 0);
      notesEl.textContent = notes.length ? jt(
        'ide.docx.preservedNotice',
        'Some content is preserved but not editable here: {items}.',
        { items: notes.map((item) => noteLabels[item] || item).join(', ') },
      ) : '';
    }

    function show(path) {
      const normalizedPath = String(path || '');
      const record = documents.get(normalizedPath);
      if (!record || !ensurePane()) return false;
      currentPath = normalizedPath;
      for (const candidate of documents.values()) candidate.container.classList.toggle('hidden', candidate !== record);
      refreshNotes(record);
      paneEl.classList.remove('hidden');
      refreshToolbar();
      return true;
    }

    function hide() {
      paneEl?.classList.add('hidden');
    }

    function close(path) {
      const normalizedPath = String(path || '');
      loadGenerations.set(normalizedPath, (loadGenerations.get(normalizedPath) || 0) + 1);
      const record = documents.get(normalizedPath);
      if (!record) return;
      if (typing?.record === record) endTyping();
      if (record.dirty) onDirtyChange(normalizedPath, false);
      if (selectedImage?.path === normalizedPath) selectedImage = null;
      documents.delete(normalizedPath);
      removeRecord(record);
      if (currentPath === normalizedPath) {
        currentPath = null;
        paneEl?.classList.add('hidden');
        if (notesEl) notesEl.textContent = '';
      }
    }

    function hasDocument(path) {
      return documents.has(String(path || ''));
    }

    function isDirty(path) {
      return documents.get(String(path || ''))?.model.isDirty() === true;
    }

    function markSaved(path) {
      const record = documents.get(String(path || ''));
      if (!record) return;
      if (typing?.record === record) endTyping();
      record.model.markSaved();
      setDirty(record);
    }

    async function patchPackageParts(record, replacements, Parser, Serializer, numbering, media) {
      const contentName = '[Content_Types].xml';
      const relsName = 'word/_rels/document.xml.rels';
      const contentXml = record.zip.entries.has(contentName)
        ? await zipUtils.readEntryText(record.zip, contentName)
        : `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${CONTENT_TYPES_NS}"/>`;
      const relsXml = replacements.has(relsName) ? replacements.get(relsName) : record.zip.entries.has(relsName)
        ? await zipUtils.readEntryText(record.zip, relsName)
        : `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELATIONSHIPS_NS}"/>`;
      const contentDoc = parseXml(Parser, contentXml);
      const relsDoc = parseXml(Parser, relsXml);
      const hasOverride = Array.from(contentDoc.getElementsByTagNameNS('*', 'Override'))
        .some((item) => item.getAttribute('PartName') === '/word/numbering.xml');
      if (numbering && !hasOverride) {
        const override = contentDoc.createElementNS(CONTENT_TYPES_NS, 'Override');
        override.setAttribute('PartName', '/word/numbering.xml');
        override.setAttribute('ContentType', NUMBERING_CONTENT_TYPE);
        contentDoc.documentElement.appendChild(override);
      }
      const relationships = Array.from(relsDoc.getElementsByTagNameNS('*', 'Relationship'));
      const hasNumbering = relationships.some((item) => item.getAttribute('Type') === NUMBERING_RELATIONSHIP);
      if (numbering && !hasNumbering) {
        const used = new Set(relationships.map((item) => item.getAttribute('Id')));
        let ordinal = 1;
        while (used.has('rId' + ordinal)) ordinal += 1;
        const relationship = relsDoc.createElementNS(RELATIONSHIPS_NS, 'Relationship');
        relationship.setAttribute('Id', 'rId' + ordinal);
        relationship.setAttribute('Type', NUMBERING_RELATIONSHIP);
        relationship.setAttribute('Target', 'numbering.xml');
        relsDoc.documentElement.appendChild(relationship);
      }
      const defaults = Array.from(contentDoc.getElementsByTagNameNS('*', 'Default'));
      for (const [name, item] of media) {
        const extension = name.split('.').at(-1).toLowerCase();
        if (defaults.some((entry) => entry.getAttribute('Extension').toLowerCase() === extension)) continue;
        const entry = contentDoc.createElementNS(CONTENT_TYPES_NS, 'Default');
        entry.setAttribute('Extension', extension); entry.setAttribute('ContentType', item.mime);
        contentDoc.documentElement.appendChild(entry); defaults.push(entry);
      }
      replacements.set(contentName, xmlDeclaration(contentXml) + new Serializer().serializeToString(contentDoc).replace(/^<\?xml[^>]*\?>/, ''));
      if (numbering) replacements.set(relsName, xmlDeclaration(relsXml) + new Serializer().serializeToString(relsDoc).replace(/^<\?xml[^>]*\?>/, ''));
    }

    async function exportBytes(path) {
      const record = documents.get(String(path || ''));
      if (!record) return null;
      if (typing?.record === record) endTyping();
      const serialized = record.model.serialize();
      const replacements = serialized.replacements || new Map([['word/document.xml', serialized['word/document.xml']]]);
      const media = serialized.media || new Map();
      if (serialized['word/numbering.xml']) replacements.set('word/numbering.xml', serialized['word/numbering.xml']);
      for (const [name, item] of media) replacements.set(name, decodeBase64(item.base64, record.container.ownerDocument.defaultView));
      if (serialized.newNumberingPart || media.size) {
        const windowRef = record.container.ownerDocument.defaultView;
        await patchPackageParts(record, replacements, windowRef.DOMParser, windowRef.XMLSerializer, serialized.newNumberingPart, media);
      }
      const bytes = await zipUtils.writeZip(record.zip, replacements);
      return encodeBase64(bytes, record.container.ownerDocument.defaultView);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      endTyping();
      const documentRef = paneEl?.ownerDocument;
      for (const path of [...documents.keys()]) close(path);
      paneEl?.removeEventListener('click', handleToolbarClick);
      paneEl?.removeEventListener('mousedown', handleToolbarMouseDown);
      documentRef?.removeEventListener('selectionchange', handleSelectionChange);
      paneEl?.remove();
      paneEl = null;
      documentsEl = null;
      notesEl = null;
      currentPath = null;
    }

    return { load, show, hide, close, hasDocument, isDirty, markSaved, exportBytes, dispose };
  }

  return { createIdeDocxPane };
});
