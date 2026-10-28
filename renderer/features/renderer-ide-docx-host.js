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

  const packageUtils = resolveModule('rendererIdeDocxPackage', './renderer-ide-docx-package');

  // Native Uint8Array base64 where the engine has it (shared with the PDF pane).
  const { decodeBase64, encodeBase64 } = resolveModule('rendererBytesBase64', '../shared/bytes-base64');

  // UTF-16 length of the code point that ends (backward) or starts at `offset`,
  // so Backspace/Delete never strands half of a surrogate pair.
  function codePointLength(text, offset, backward) {
    const index = backward ? offset - 2 : offset;
    const high = text.charCodeAt(index);
    const low = text.charCodeAt(index + 1);
    return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? 2 : 1;
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
    const imageTypes = resolveModule('rendererIdeDocxImageModel', './renderer-ide-docx-image-model').IMAGE_TYPES || {};
    const mimeByExtension = Object.fromEntries(Object.entries(imageTypes).map(([mime, extension]) => [extension, mime]));
    mimeByExtension.jpeg = 'image/jpeg';
    const imageInvalidMessage = () => jt('ide.docx.imageInvalid', 'Choose a valid PNG, JPEG, GIF, WebP, or BMP image.');
    const imageTooLargeMessage = () => jt('ide.docx.imageTooLarge', 'Choose an image smaller than 10 MiB.');
    const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');
    const fileInput = resolveModule('inventoryFileInput', '../inventory/file-input');
    const documents = new Map();
    const loadGenerations = new Map();
    let generationCounter = 0;

    let paneEl = null;
    let documentsEl = null;
    let notesEl = null;
    let reviewEl = null;
    let currentPath = null;
    let disposed = false;
    let typing = null;
    let imageInsertion = null;
    let selectedImage = null;

    function toolbarButton(action, label, title) {
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
        + '<div class="ide-docx-notes ide-docx-review-lock hidden" role="status"><span class="ide-docx-review-lock-text"></span>'
        + actionButton({
          plain: true, className: 'ide-docx-action ide-docx-review-unlock', label: jt('ide.docx.reviewEditAnyway', 'Edit anyway'),
          dataset: { 'ide-docx-action': 'editAnyway' },
        }) + '</div>'
        + '<div class="ide-docx-documents"></div>';
      paneEl.prepend(fileInput(documentRef, {
        className: 'ide-docx-image-input', accept: Object.keys(imageTypes).join(','), hidden: true,
      }));
      notesEl = paneEl.querySelector('.ide-docx-notes');
      reviewEl = paneEl.querySelector('.ide-docx-review-lock');
      reviewEl.querySelector('.ide-docx-review-lock-text').textContent = jt('ide.docx.reviewLocked',
        'This document tracks changes. Edits made here are not recorded as revisions, so reviewers will not see them as changes.');
      documentsEl = paneEl.querySelector('.ide-docx-documents');
      paneEl.addEventListener('click', handleToolbarClick);
      paneEl.addEventListener('mousedown', handleToolbarMouseDown);
      paneEl.querySelector('.ide-docx-image-input')?.addEventListener('change', handleImageInput);
      documentRef.addEventListener('selectionchange', refreshToolbar);
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
      return makeFailure({ zip_too_large: 'document_too_large', zip_unsupported: 'document_unsupported' }[error?.code] || 'document_corrupt');
    }

    async function readOptionalText(zip, name) {
      return zip.entries.has(name) ? zipUtils.readEntryText(zip, name) : null;
    }

    async function readMedia(zip) {
      const media = new Map();
      let total = 0;
      for (const name of zip.order) {
        if (!name.startsWith('word/media/')) continue;
        const mime = mimeByExtension[name.split('.').pop().toLowerCase()] || '';
        const entry = zip.entries.get(name);
        if (!mime || !entry) continue;
        if (total + entry.uncompressedSize > MAX_MEDIA_BYTES) break;
        const bytes = await zipUtils.readEntryBytes(zip, name);
        total += bytes.length;
        media.set(name, { mime, base64: encodeBase64(bytes) });
      }
      return media;
    }

    function createContainer(path, documentRef) {
      const container = documentRef.createElement('div');
      container.className = 'ide-docx-doc hidden';
      container.setAttribute('contenteditable', 'true');
      container.setAttribute('spellcheck', 'true');
      container.dataset.path = path;
      const listeners = {
        beforeinput: (event) => handleBeforeInput(path, event),
        keydown: (event) => handleKeydown(path, event),
        compositionstart: () => handleCompositionStart(path),
        compositionend: (event) => handleCompositionEnd(path, event),
        click: (event) => handleDocumentClick(path, event),
      };
      for (const [type, listener] of Object.entries(listeners)) container.addEventListener(type, listener);
      documentsEl.appendChild(container);
      return { container, listeners };
    }

    function removeRecord(record) {
      if (!record) return;
      for (const [type, listener] of Object.entries(record.listeners)) record.container.removeEventListener(type, listener);
      record.container.remove();
      record.mediaUrls.revoke();
    }

    async function load(path, source) {
      const normalizedPath = String(path || '');
      const root = ensurePane();
      if (!normalizedPath || !root) return makeFailure('document_unsupported');
      const documentRef = root.ownerDocument;
      const windowRef = documentRef.defaultView;
      const Parser = windowRef?.DOMParser;
      const Serializer = windowRef?.XMLSerializer;
      const generation = ++generationCounter;
      loadGenerations.set(normalizedPath, generation);
      const isCurrent = () => !disposed && loadGenerations.get(normalizedPath) === generation;
      const mediaUrls = packageUtils.createMediaUrls(windowRef, decodeBase64);
      let zip;
      let model;
      let reviewed;
      try {
        const bytes = decodeBase64(source?.base64);
        zip = await zipUtils.readZip(bytes);
        if (!zip.entries.has('word/document.xml')) {
          return makeFailure('document_unsupported', jt('ide.docx.notWordDocument', 'not a Word document'));
        }
        const documentXml = await zipUtils.readEntryText(zip, 'word/document.xml');
        const numberingXml = await readOptionalText(zip, 'word/numbering.xml');
        const relsXml = await readOptionalText(zip, 'word/_rels/document.xml.rels');
        const settingsXml = await readOptionalText(zip, 'word/settings.xml');
        const media = await readMedia(zip);
        const relatedParts = [];
        const discovered = richUtils.discoverRelatedParts({ documentXml, relsXml, DOMParser: Parser });
        for (const descriptor of discovered) {
          if (!zip.entries.has(descriptor.path)) continue;
          relatedParts.push({
            ...descriptor,
            xml: await zipUtils.readEntryText(zip, descriptor.path),
            relsXml: await readOptionalText(zip, descriptor.relsPath),
          });
        }
        model = richUtils.createCompositeDocxModel({
          documentXml, numberingXml, relsXml, media, mediaUrl: mediaUrls.get, relatedParts, occupiedNames: new Set(zip.entries.keys()),
          DOMParser: Parser, XMLSerializer: Serializer, createDocxModel: modelUtils.createDocxModel,
        });
        reviewed = packageUtils.tracksRevisions(settingsXml, Parser) || model.getUnsupportedNotes().includes('trackedChanges');
      } catch (error) {
        mediaUrls.revoke();
        log('WARN', 'ide.docx_load_failed', { path: normalizedPath, code: error?.code || 'unknown' });
        return classifyError(error);
      }
      // Parsed into a candidate only: a close/dispose/newer load during the
      // parse, or a caller veto (edits arrived meanwhile), leaves the live
      // record untouched.
      if (!isCurrent() || (typeof source?.shouldCommit === 'function' && source.shouldCommit() !== true)) {
        if (isCurrent() && !documents.has(normalizedPath)) loadGenerations.delete(normalizedPath);
        mediaUrls.revoke();
        return makeFailure('document_stale', jt('ide.docx.staleReload', 'The document changed before the reload could be applied.'));
      }
      endTyping();
      const existing = documents.get(normalizedPath);
      const wasVisible = currentPath === normalizedPath && !paneEl.classList.contains('hidden');
      if (existing?.dirty) onDirtyChange(normalizedPath, false);
      removeRecord(existing);
      const handlers = createContainer(normalizedPath, documentRef);
      // A document under review opens read-only until the user opts in; the
      // opt-in lasts for this open document, across reloads, and is never stored.
      const reviewOptIn = existing?.reviewOptIn === true;
      const record = {
        path: normalizedPath, zip, model, mediaUrls, dirty: false, stateVersion: model.getStateVersion(),
        locked: reviewed && !reviewOptIn, reviewOptIn, ...handlers,
      };
      record.container.setAttribute('contenteditable', String(!record.locked));
      documents.set(normalizedPath, record);
      renderAll(record);
      if (wasVisible) show(normalizedPath);
      return { ok: true };
    }

    function renderAll(record) {
      record.container.replaceChildren(renderUtils.renderRegions(record.container.ownerDocument, record.model.getRegions()));
      restoreSelectedImage(record);
    }

    function paragraphElement(record, blockId) {
      const id = String(blockId ?? '').replace(/["\\]/g, '\\$&');
      return record.container.querySelector(`.ide-docx-p[data-block="${id}"]`);
    }

    // A list paragraph whose list identity is unchanged keeps its label, which
    // depends only on earlier paragraphs; a list change re-renders everything.
    function renderParagraph(record, blockId) {
      const oldParagraph = paragraphElement(record, blockId);
      const block = record.model.getBlock(blockId);
      if (!oldParagraph || !block || (oldParagraph.dataset.listKey || '') !== renderUtils.listKey(block.list)) {
        renderAll(record);
        return;
      }
      const paragraph = renderUtils.renderBlocks(record.container.ownerDocument, [block]).firstChild;
      if (block.list) paragraph.dataset.listLabel = oldParagraph.dataset.listLabel;
      oldParagraph.replaceWith(paragraph);
      if (selectedImage?.blockId === blockId) restoreSelectedImage(record);
    }

    function restoreCaret(record, point) {
      if (!point) return;
      renderUtils.setCaret(record.container.ownerDocument, paragraphElement(record, point.blockId), point.offset);
      refreshToolbar();
    }

    function syncDirty(record) {
      const next = record.model.isDirty();
      if (record.dirty === next) return;
      record.dirty = next;
      onDirtyChange(record.path, next);
    }

    // Every real model change is an edit (the save path fences on it), even
    // one that undoes back to the saved state. While a typing burst keeps an
    // already-dirty document dirty, the full dirty comparison waits for the
    // burst to end (endTyping) instead of serializing on every keystroke.
    function setDirty(record) {
      const version = record.model.getStateVersion();
      if (version === record.stateVersion) return;
      record.stateVersion = version;
      onEdit(record.path);
      if (record.dirty && typing?.record === record) return;
      syncDirty(record);
    }

    function endTyping() {
      if (!typing) return;
      const { record } = typing;
      clearTimeout(typing.timer);
      typing = null;
      record.model.endTransaction();
      if (documents.get(record.path) === record) syncDirty(record);
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
      const anchor = paragraphElement(record, resolved.anchor.blockId);
      const focus = paragraphElement(record, resolved.focus.blockId);
      if (!anchor || !focus) return null;
      return anchor.compareDocumentPosition(focus) & 4 /* DOCUMENT_POSITION_FOLLOWING */
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
      // Block ids are positional among siblings: after each merge the next
      // paragraph takes over the id the first follower had.
      const nextId = siblings[startIndex + 1].dataset.block;
      for (let index = 0; index < mergeCount; index += 1) {
        const keep = index === mergeCount - 1 ? range.end.offset : record.model.getParagraphText(nextId).length;
        if (keep > 0) record.model.deleteRange(nextId, 0, keep);
        if (!record.model.mergeWithPrevious(nextId)) break;
      }
      return { point: range.start, structural: true };
    }

    // The selected image is tracked by (block, offset): a text edit in its
    // paragraph shifts that offset and a cross-paragraph edit renumbers blocks,
    // so either one drops the selection instead of retargeting a neighbour.
    function dropImageSelection(record, resolved) {
      if (selectedImage?.path !== record.path) return;
      if (!resolved.sameBlock || selectedImage.blockId === resolved.anchor.blockId) clearSelectedImage();
    }

    function applyInsert(record, resolved, text, coalesce) {
      if (!resolved) return;
      dropImageSelection(record, resolved);
      let result;
      const operation = () => {
        const deletion = resolved.collapsed ? null : deleteSelection(record, resolved);
        const point = deletion?.point || resolved.anchor;
        if (!point || (!resolved.sameBlock && !deletion)) return null;
        // The model drops characters XML cannot carry: the caret follows what it inserted.
        const inserted = record.model.insertText(point.blockId, point.offset, text) || 0;
        return { point: { blockId: point.blockId, offset: point.offset + inserted }, structural: deletion?.structural === true };
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
        dropImageSelection(record, resolved);
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
      const inBlock = backward ? point.offset > 0 : point.offset < text.length;
      if (inBlock) dropImageSelection(record, resolved);
      if (backward && point.offset > 0) {
        const step = codePointLength(text, point.offset, true);
        useTypingTransaction(record, point.blockId);
        record.model.deleteRange(point.blockId, point.offset - step, point.offset);
        renderParagraph(record, point.blockId);
        restoreCaret(record, { blockId: point.blockId, offset: point.offset - step });
      } else if (!backward && point.offset < text.length) {
        useTypingTransaction(record, point.blockId);
        record.model.deleteRange(point.blockId, point.offset, point.offset + codePointLength(text, point.offset, false));
        renderParagraph(record, point.blockId);
        restoreCaret(record, point);
      } else if (backward && point.offset === 0) {
        endTyping();
        const previous = neighboringParagraph(record, point.blockId, 'previousElementSibling');
        const element = paragraphElement(record, point.blockId);
        const merged = previous ? record.model.mergeWithPrevious(point.blockId) : null;
        if (merged) {
          patchOrRenderAll(record, renderUtils.patchMerge(element, merged), merged);
          restoreCaret(record, { blockId: merged, offset: previous.length });
        }
      } else if (!backward && point.offset === text.length) {
        endTyping();
        const next = neighboringParagraph(record, point.blockId, 'nextElementSibling');
        const element = next && paragraphElement(record, next.id);
        const merged = next ? record.model.mergeWithPrevious(next.id) : null;
        if (merged) {
          patchOrRenderAll(record, renderUtils.patchMerge(element, merged), merged);
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
        return newId ? { blockId: newId, offset: 0, from: point.blockId, structural: deletion?.structural === true } : null;
      });
      if (!result) return;
      const halves = [record.model.getBlock(result.from), record.model.getBlock(result.blockId)];
      patchOrRenderAll(record, !result.structural
        && renderUtils.patchSplit(record.container.ownerDocument, paragraphElement(record, result.from), halves));
      restoreCaret(record, result);
      setDirty(record);
    }

    // Enter and paragraph merges patch the DOM in place where the renderer
    // can (plain paragraphs); anything else re-renders the whole document.
    // Images outside the patched paragraphs keep their elements, so the
    // selected one is followed to its renumbered paragraph.
    function patchOrRenderAll(record, patched, mergedId) {
      if (!patched) {
        renderAll(record);
        return;
      }
      if (selectedImage?.path === record.path) {
        const image = record.container.querySelector('.ide-docx-img.is-selected');
        if (image) selectedImage.blockId = image.closest('.ide-docx-p')?.dataset.block;
        else selectedImage = null;
      }
      if (mergedId) renderParagraph(record, mergedId);
    }

    function applyFormat(record, property) {
      endTyping();
      const resolved = currentSelection(record);
      if (!resolved || resolved.collapsed || !resolved.sameBlock) return;
      const range = orderedRange(record, resolved);
      record.model.toggleRunProperty(range.start.blockId, range.start.offset, range.end.offset, property);
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
      // Attribute reads: image.width right after a re-render forces a layout.
      selectedImage.width = Number(image.getAttribute('width')) || selectedImage.width;
      selectedImage.height = Number(image.getAttribute('height')) || selectedImage.height;
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
      if (!Object.hasOwn(imageTypes, file.type)) {
        showImageError(imageInvalidMessage());
        return;
      }
      if (!Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_INSERT_IMAGE_BYTES) {
        showImageError(imageTooLargeMessage());
        return;
      }
      const record = documents.get(insertion.path);
      if (!record) return;
      const stale = () => documents.get(insertion.path) !== record || disposed;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (stale()) return;
        if (!bytes.length || bytes.length > MAX_INSERT_IMAGE_BYTES) {
          showImageError(imageTooLargeMessage());
          return;
        }
        const size = await imageSize(record.container.ownerDocument.defaultView, bytes, file.type);
        if (stale()) return;
        const added = atomic(record, () => record.model.insertImage(insertion.point.blockId, insertion.point.offset, {
          mime: file.type, base64: encodeBase64(bytes),
          widthPx: size.width, heightPx: size.height, name: file.name,
        }));
        if (!added) throw new Error('image rejected');
        selectedImage = { path: record.path, blockId: insertion.point.blockId, offset: insertion.point.offset, ...size };
        renderParagraph(record, insertion.point.blockId);
        restoreCaret(record, { blockId: insertion.point.blockId, offset: insertion.point.offset + 1 });
        setDirty(record);
      } catch (_error) {
        if (stale()) return;
        showImageError(imageInvalidMessage());
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
      if (!record || record.locked) return;
      endTyping();
      const resolved = currentSelection(record);
      if (resolved && !resolved.collapsed) applyDelete(record, resolved, true);
      const point = currentSelection(record)?.anchor || null;
      record.composition = point && resolved?.sameBlock !== false ? { point } : null;
    }

    function handleCompositionEnd(path, event) {
      const record = documents.get(path);
      if (!record || record.locked) return;
      const point = record.composition?.point || null;
      record.composition = null;
      if (!point) return;
      renderParagraph(record, point.blockId);
      const text = String(event?.data || '');
      if (text) applyInsert(record, { collapsed: true, sameBlock: true, anchor: point, focus: point }, text, false);
      else restoreCaret(record, point);
    }

    // The range the browser says an input acts on (a spellcheck replacement,
    // a word or line delete, a drop), mapped to model points; the live
    // selection when the event carries none.
    function targetSelection(record, event) {
      const range = event.getTargetRanges?.()[0];
      if (!range) return currentSelection(record);
      const anchor = renderUtils.resolvePoint(range.startContainer, range.startOffset);
      const focus = renderUtils.resolvePoint(range.endContainer, range.endOffset);
      if (!anchor || !focus || !record.container.contains(range.startContainer)
        || !record.container.contains(range.endContainer)) return null;
      return { anchor, focus, collapsed: range.collapsed, sameBlock: anchor.blockId === focus.blockId };
    }

    function handleBeforeInput(path, event) {
      const record = documents.get(path);
      if (!record) return;
      if (record.locked) {
        event.preventDefault();
        return;
      }
      if (event.inputType === 'insertCompositionText' || event.inputType === 'deleteCompositionText') return;
      event.preventDefault();
      const resolved = currentSelection(record);
      switch (event.inputType) {
        case 'insertText':
          if (event.data) applyInsert(record, resolved, event.data, true);
          break;
        case 'insertReplacementText': {
          // Spellcheck corrections carry their text in dataTransfer and their
          // range in the target ranges, not in data and the caret.
          const text = event.data || event.dataTransfer?.getData?.('text/plain') || '';
          if (text) applyInsert(record, targetSelection(record, event), text, false);
          break;
        }
        case 'deleteWordBackward':
        case 'deleteWordForward':
        case 'deleteSoftLineBackward':
        case 'deleteSoftLineForward':
        case 'deleteHardLineBackward':
        case 'deleteHardLineForward':
        case 'deleteByDrag': {
          const target = targetSelection(record, event);
          if (target && !target.collapsed) applyDelete(record, target, true);
          else applyDelete(record, resolved, !event.inputType.endsWith('Forward'));
          break;
        }
        case 'insertFromDrop': {
          endTyping();
          const text = event.dataTransfer?.getData?.('text/plain') || '';
          if (text) applyInsert(record, targetSelection(record, event), text.replace(/\r\n?/g, '\n'), false);
          break;
        }
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
      } else if (record.locked) {
        // Under the review lock only Save passes through.
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

    function unlockForEditing(record) {
      record.locked = false;
      record.reviewOptIn = true;
      record.container.setAttribute('contenteditable', 'true');
      refreshNotes(record);
      refreshToolbar();
      record.container.focus?.();
    }

    function handleToolbarMouseDown(event) {
      if (event.target?.closest?.('[data-ide-docx-action]')) event.preventDefault();
    }

    function handleToolbarClick(event) {
      const button = event.target?.closest?.('[data-ide-docx-action]');
      const record = currentPath ? documents.get(currentPath) : null;
      if (!button || !record) return;
      const action = button.dataset.ideDocxAction;
      if (action === 'editAnyway') unlockForEditing(record);
      else if (record.locked) return;
      else if (['bold', 'italic', 'underline'].includes(action)) applyFormat(record, action);
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

    function selectionProperty(record, resolved, block, property) {
      if (!resolved?.sameBlock || !block?.runs) return false;
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

    // Also the document-wide selectionchange listener: it fires for every
    // selection in the app, so it returns early unless this pane is showing.
    function refreshToolbar() {
      if (!paneEl || paneEl.classList.contains('hidden')) return;
      const record = currentPath ? documents.get(currentPath) : null;
      const resolved = record ? currentSelection(record) : null;
      const block = resolved?.sameBlock ? record.model.getBlock(resolved.anchor.blockId) : null;
      const listKind = resolved ? record.model.getListInfo(resolved.anchor.blockId)?.kind : null;
      const values = {
        bold: selectionProperty(record, resolved, block, 'bold'),
        italic: selectionProperty(record, resolved, block, 'italic'),
        underline: selectionProperty(record, resolved, block, 'underline'),
        bullets: listKind === 'bullet',
        numbering: listKind === 'number',
      };
      for (const button of paneEl.querySelectorAll('.ide-docx-toolbar [data-ide-docx-action]')) {
        const action = button.dataset.ideDocxAction;
        if (Object.hasOwn(values, action)) button.setAttribute('aria-pressed', String(values[action]));
        let disabled = record?.locked === true;
        if (['imageSmaller', 'imageLarger'].includes(action)) disabled ||= !selectedImage || selectedImage.path !== currentPath;
        if (['bullets', 'numbering'].includes(action)) {
          disabled ||= !record || !resolved || record.model.canSetList?.(resolved.anchor.blockId) === false;
        }
        button.disabled = disabled;
      }
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
      reviewEl.classList.toggle('hidden', !record.locked);
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
      loadGenerations.delete(normalizedPath);
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
      syncDirty(record);
    }

    async function exportBytes(path) {
      const record = documents.get(String(path || ''));
      if (!record) return null;
      if (typing?.record === record) endTyping();
      const windowRef = record.container.ownerDocument.defaultView;
      const { replacements, media, newNumberingPart } = record.model.serialize();
      for (const [name, item] of media) replacements.set(name, decodeBase64(item.base64));
      if (newNumberingPart || media.size) {
        await packageUtils.patchPackageParts({
          zip: record.zip, zipUtils, replacements, Parser: windowRef.DOMParser, Serializer: windowRef.XMLSerializer,
          numbering: newNumberingPart, media,
        });
      }
      const bytes = await zipUtils.writeZip(record.zip, replacements);
      return encodeBase64(bytes);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      endTyping();
      const documentRef = paneEl?.ownerDocument;
      for (const path of [...documents.keys()]) close(path);
      loadGenerations.clear();
      paneEl?.removeEventListener('click', handleToolbarClick);
      paneEl?.removeEventListener('mousedown', handleToolbarMouseDown);
      documentRef?.removeEventListener('selectionchange', refreshToolbar);
      paneEl?.remove();
      paneEl = null;
      documentsEl = null;
      notesEl = null;
      reviewEl = null;
      currentPath = null;
    }

    return { load, show, hide, close, hasDocument, isDirty, markSaved, exportBytes, dispose };
  }

  return { createIdeDocxPane };
});
