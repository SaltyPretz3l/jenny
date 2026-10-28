/* renderer/features/renderer-ide-docx-model.js - preservation-first OOXML
 * document model. Callers own package extraction and inject the XML DOM APIs. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-ide-docx-image-model'), require('./renderer-ide-docx-ooxml'));
    return;
  }
  root.rendererIdeDocxModel = factory(root.rendererIdeDocxImageModel, root.rendererIdeDocxOoxml);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (imageUtils, ooxml) {
  'use strict';

  const {
    W_NS, R_NS, WP_NS, A_NS, REL_NS,
    elementChildren,
    isW,
    directChild,
    wAttr,
    makeW,
    declarationOf,
    invalidError,
    hasDoctype,
    hasParserError,
    nearestParagraph,
    directRunProperty,
    enabledValue,
    runText,
    fieldCharType,
    paragraphRuns,
    runPositions,
    payloadLength,
    splitRun,
    setTextSpace,
    appendTextPayload,
    significantSibling,
    boundaryAfter,
    boundaryBefore,
    removeRunSlice,
  } = ooxml;

  const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const PROPERTY_NAMES = { bold: 'b', italic: 'i', underline: 'u', strike: 'strike' };
  const HISTORY_BYTE_BUDGET = 32 * 1024 * 1024;
  const RPR_ORDER = [
    'rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike',
    'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden',
    'color', 'spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect',
    'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout',
    'specVanish', 'oMath',
  ];
  // Characters XML 1.0 cannot carry (C0 controls except tab/newline, lone
  // surrogates, U+FFFE/U+FFFF): pasted terminal or PDF text often has them.
  const INVALID_XML_TEXT = /[^\t\n\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;
  // Revision markers new text never inherits: ins/del/moveFrom/moveTo are
  // valid only in a paragraph mark's rPr (CT_ParaRPr); rPrChange is a run's
  // own recorded format change.
  const REVISION_PROPERTIES = new Set(['ins', 'del', 'moveFrom', 'moveTo', 'rPrChange']);
  const REVISION_WRAPPERS = new Set(['ins', 'del', 'moveFrom', 'moveTo']);
  function createDocxModel(options) {
    const Parser = options?.DOMParser;
    const Serializer = options?.XMLSerializer;
    if (typeof Parser !== 'function' || typeof Serializer !== 'function') {
      throw invalidError();
    }

    let documentDeclaration = declarationOf(options.documentXml);
    let numberingDeclaration = declarationOf(options.numberingXml);
    let documentDoc;
    let numberingDoc = null;
    const parser = () => new Parser();
    const serializeDom = (doc, declaration) => {
      const xml = new Serializer().serializeToString(doc).replace(/^<\?xml[^>]*\?>/, '');
      return declaration + xml;
    };
    // Per-part XML cache: every DOM mutation path invalidates its parts after the change.
    const xmlCache = new Map();
    // Derived lookups, rebuilt lazily: the block index (positional ids ->
    // elements), block snapshots, relationship targets and numbering formats.
    // Every DOM change goes through recordMutation()/invalidate(), which drop them.
    let blockIndex = null;
    let blockSnapshots = null;
    let relationshipTargets = null;
    let numberingFormats = null;
    let notesCache = null;
    const dropBlockCaches = () => { blockIndex = null; blockSnapshots = null; notesCache = null; };
    const invalidate = (...parts) => {
      const targets = parts.length ? parts : ['document', 'numbering', 'rels'];
      for (const part of targets) xmlCache.delete(part);
      dropBlockCaches();
      if (targets.includes('rels')) relationshipTargets = null;
      if (targets.includes('numbering')) numberingFormats = null;
    };
    const cachedXml = (part, doc, declaration) => {
      if (doc && !xmlCache.has(part)) xmlCache.set(part, serializeDom(doc, declaration));
      return doc ? xmlCache.get(part) : null;
    };
    // OOXML parts never carry a DTD; refusing one keeps entity expansion out.
    const parseDocument = (xml) => {
      if (hasDoctype(xml)) throw invalidError();
      const parsed = parser().parseFromString(String(xml || ''), 'application/xml');
      const body = Array.from(parsed.getElementsByTagNameNS(W_NS, 'body'))[0];
      if (hasParserError(parsed) || !body) {
        throw invalidError();
      }
      return parsed;
    };
    const parsePart = (xml) => {
      if (!xml || hasDoctype(xml)) {
        return null;
      }
      const parsed = parser().parseFromString(String(xml), 'application/xml');
      return hasParserError(parsed) ? null : parsed;
    };

    documentDoc = parseDocument(options.documentXml);
    numberingDoc = parsePart(options.numberingXml);
    const hadNumberingPart = options.numberingXml !== null && options.numberingXml !== undefined;
    // A numbering part that exists but does not parse is never replaced: a
    // fresh one would drop every list definition the document relies on.
    const numberingUnreadable = hadNumberingPart && !numberingDoc;
    let relsDeclaration = declarationOf(options.relsXml);
    let relsDoc = parsePart(options.relsXml);
    const media = options.media instanceof Map ? new Map(options.media) : new Map();
    const resources = options.resources || { stacks: [], sequence: 0, mediaStores: [] };
    const mediaRetention = imageUtils.createMediaRetention(media, resources);

    function relsXml() {
      return cachedXml('rels', relsDoc, relsDeclaration);
    }

    function documentXml() {
      return cachedXml('document', documentDoc, documentDeclaration);
    }

    function numberingXml() {
      return cachedXml('numbering', numberingDoc, numberingDeclaration);
    }

    const initialNumbering = numberingXml();
    const initialRels = relsXml();
    let savedDocument = documentXml();
    let savedNumbering = initialNumbering;
    let savedRels = relsXml();
    let savedMedia = mediaRetention.identities(documentDoc, relsDoc);
    // stateVersion moves on every edit and every undo/redo restore; isDirty is
    // free while it equals the saved version and memoized per version otherwise.
    let stateVersion = 0;
    let savedStateVersion = 0;
    let dirtyMemo = null;
    const undoStack = [];
    const redoStack = [];
    resources.stacks.push(undoStack, redoStack);
    const relationshipCount = () => relsDoc?.getElementsByTagNameNS('*', 'Relationship').length || 0;
    mediaRetention.reclaim = () => {
      const before = relationshipCount();
      mediaRetention.prune(documentDoc, relsDoc, [...undoStack, ...redoStack]);
      if (relationshipCount() !== before) invalidate('rels');
    };
    mediaRetention.keptLength = () => mediaRetention.insertedLength(documentDoc, relsDoc, undoStack);
    let transactionDepth = 0;
    let transactionRecorded = false;
    let mutationVersion = 0;

    function snapshot() {
      const state = {
        documentXml: documentXml(), numberingXml: numberingXml(), relsXml: relsXml(),
        mediaNames: mediaRetention.referenced(documentDoc, relsDoc), ordinal: resources.sequence++,
      };
      state.bytes = state.documentXml.length + (state.numberingXml?.length || 0) + (state.relsXml?.length || 0);
      return state;
    }

    function trimHistory() {
      const states = resources.stacks.flat();
      let bytes = states.reduce((sum, state) => sum + state.bytes, 0);
      // The newest snapshot was just recorded: one level always survives a large document.
      const newest = Math.max(...states.map((state) => state.ordinal));
      while (bytes > HISTORY_BYTE_BUDGET) {
        const candidates = resources.stacks.filter((stack) => stack.length && stack[0].ordinal !== newest);
        if (!candidates.length) break;
        const oldest = candidates.reduce((left, right) => left[0].ordinal < right[0].ordinal ? left : right);
        bytes -= oldest.shift().bytes;
      }
      for (const store of resources.mediaStores) store.reclaim();
    }

    function recordMutation() {
      mutationVersion += 1;
      stateVersion += 1;
      dropBlockCaches();
      if (!transactionDepth || !transactionRecorded) {
        undoStack.push(snapshot());
        if (undoStack.length > 200) {
          undoStack.shift();
        }
        // A new edit abandons redo in every part before applying the shared
        // byte budget, so doomed snapshots cannot evict useful undo states.
        for (let index = 1; index < resources.stacks.length; index += 2) {
          resources.stacks[index].length = 0;
        }
        trimHistory();
        if (transactionDepth) {
          transactionRecorded = true;
        }
      }
    }

    function restore(state) {
      documentDeclaration = declarationOf(state.documentXml);
      numberingDeclaration = declarationOf(state.numberingXml);
      documentDoc = parseDocument(state.documentXml);
      numberingDoc = parsePart(state.numberingXml);
      relsDeclaration = declarationOf(state.relsXml);
      relsDoc = parsePart(state.relsXml);
      stateVersion += 1;
      invalidate();
    }

    function relationshipTarget(id) {
      if (!relsDoc || !id) {
        return '';
      }
      relationshipTargets ||= new Map(Array.from(relsDoc.getElementsByTagNameNS('*', 'Relationship'))
        .map((item) => [item.getAttribute('Id'), imageUtils.mediaTarget(item)]));
      return relationshipTargets.get(id) || '';
    }

    function ensureRelationships() {
      if (relsDoc) return;
      relsDeclaration = XML_DECL;
      relsDoc = parser().parseFromString(`<Relationships xmlns="${REL_NS}"/>`, 'application/xml');
    }


    // One source per media payload object: the host's object URL when it
    // provides one (options.mediaUrl), else a data URI built once.
    const mediaSources = new WeakMap();
    function mediaSource(item) {
      if (!item) return '';
      if (!mediaSources.has(item)) {
        mediaSources.set(item, options.mediaUrl?.(item) || `data:${item.mime};base64,${item.base64}`);
      }
      return mediaSources.get(item);
    }

    function imageSnapshot(drawing, id) {
      const blip = drawing?.getElementsByTagNameNS(A_NS, 'blip')[0] || null;
      const extent = drawing?.getElementsByTagNameNS(WP_NS, 'extent')[0] || null;
      const docPr = drawing?.getElementsByTagNameNS(WP_NS, 'docPr')[0] || null;
      const target = relationshipTarget(blip?.getAttributeNS(R_NS, 'embed') || '');
      return {
        id,
        kind: 'image',
        src: mediaSource(media.get(target)),
        alt: docPr?.getAttribute('descr') || docPr?.getAttribute('title') || docPr?.getAttribute('name') || '',
        widthPx: Math.round(Number(extent?.getAttribute('cx') || 0) / 9525),
        heightPx: Math.round(Number(extent?.getAttribute('cy') || 0) / 9525),
        text: '\uFFFC',
      };
    }

    function textSnapshot(run, id, text) {
      const vertical = directRunProperty(run, 'vertAlign');
      return {
        id,
        kind: 'text',
        text,
        bold: enabledValue(directRunProperty(run, 'b')),
        italic: enabledValue(directRunProperty(run, 'i')),
        underline: enabledValue(directRunProperty(run, 'u'), true),
        strike: enabledValue(directRunProperty(run, 'strike')),
        superscript: wAttr(vertical, 'val') === 'superscript',
      };
    }

    // A run is one snapshot item unless it mixes drawings with text (python-docx
    // writes `add_run('Caption ').add_picture(...)`): then each drawing and each
    // text stretch is its own item, so snapshot offsets match runText() offsets.
    function runSnapshots(run, id) {
      if (!directChild(run, 'drawing')) {
        return [textSnapshot(run, id, runText(run))];
      }
      const items = [];
      let text = '';
      const flush = () => {
        if (text) items.push(textSnapshot(run, `${id}.${items.length + 1}`, text));
        text = '';
      };
      for (const child of elementChildren(run)) {
        if (isW(child, 'drawing')) {
          flush();
          items.push(imageSnapshot(child, `${id}.${items.length + 1}`));
        } else {
          text += runText({ childNodes: [child] });
        }
      }
      flush();
      return items.length === 1 && items[0].kind === 'image' ? [{ ...items[0], id }] : items;
    }

    // `${numId}:${level}` -> { format, start }, built once per numbering revision.
    function numberingFormat(numId, level) {
      if (!numberingDoc) return {};
      if (!numberingFormats) {
        numberingFormats = new Map();
        const abstracts = new Map();
        for (const item of numberingDoc.getElementsByTagNameNS(W_NS, 'abstractNum')) {
          if (!abstracts.has(wAttr(item, 'abstractNumId'))) abstracts.set(wAttr(item, 'abstractNumId'), item);
        }
        for (const num of numberingDoc.getElementsByTagNameNS(W_NS, 'num')) {
          const abstract = abstracts.get(wAttr(directChild(num, 'abstractNumId'), 'val'));
          for (const definition of abstract?.getElementsByTagNameNS(W_NS, 'lvl') || []) {
            const key = `${wAttr(num, 'numId')}:${Number.parseInt(wAttr(definition, 'ilvl') || '0', 10)}`;
            if (numberingFormats.has(key)) continue;
            const rawStart = wAttr(directChild(definition, 'start'), 'val');
            const start = rawStart === '' ? undefined : Number.parseInt(rawStart, 10);
            numberingFormats.set(key, { format: wAttr(directChild(definition, 'numFmt'), 'val'), start });
          }
        }
      }
      return numberingFormats.get(`${numId}:${level}`) || {};
    }

    function listInfoFor(paragraph) {
      const numPr = directChild(directChild(paragraph, 'pPr'), 'numPr');
      const numId = wAttr(directChild(numPr, 'numId'), 'val');
      if (!numPr || !numId) {
        return null;
      }
      const level = Number.parseInt(wAttr(directChild(numPr, 'ilvl'), 'val') || '0', 10) || 0;
      const { format = '', start } = numberingFormat(numId, level);
      const result = { kind: format === 'bullet' ? 'bullet' : 'number', numId, level };
      if (Number.isFinite(start)) {
        result.start = start;
      }
      return result;
    }

    function paragraphSnapshot(paragraph, id) {
      const pPr = directChild(paragraph, 'pPr');
      const styleId = wAttr(directChild(pPr, 'pStyle'), 'val');
      const alignment = wAttr(directChild(pPr, 'jc'), 'val');
      const align = ['left', 'center', 'right', 'both'].includes(alignment) ? alignment : '';
      const runs = paragraphRuns(paragraph).flatMap((run, index) => runSnapshots(run, `${id}.r${index + 1}`));
      return {
        id,
        type: 'paragraph',
        styleId,
        align,
        list: listInfoFor(paragraph),
        runs,
        text: runs.map((run) => run.text).join(''),
      };
    }

    // Visits every body block in document order with its positional id.
    function walkBlocks(visit) {
      function blockFor(element, id) {
        if (isW(element, 'p')) {
          return visit.paragraph(element, id);
        }
        if (isW(element, 'tbl')) {
          let rowIndex = 0;
          const rows = elementChildren(element).filter((child) => isW(child, 'tr')).map((row) => {
            rowIndex += 1;
            const rowId = `${id}.row${rowIndex}`;
            let cellIndex = 0;
            const cells = elementChildren(row).filter((child) => isW(child, 'tc')).map((cell) => {
              cellIndex += 1;
              const cellId = `${rowId}.c${cellIndex}`;
              let cellBlockIndex = 0;
              const blocks = [];
              for (const child of elementChildren(cell)) {
                if (isW(child, 'tcPr')) {
                  continue;
                }
                cellBlockIndex += 1;
                blocks.push(blockFor(child, `${cellId}.b${cellBlockIndex}`));
              }
              return { id: cellId, blocks };
            });
            return { id: rowId, cells };
          });
          return { id, type: 'table', rows };
        }
        return { id, type: 'other', name: element.localName };
      }
      const body = documentDoc.getElementsByTagNameNS(W_NS, 'body')[0];
      let ordinal = 0;
      const blocks = [];
      for (const child of elementChildren(body)) {
        if (isW(child, 'sectPr')) {
          continue;
        }
        ordinal += 1;
        blocks.push(blockFor(child, `b${ordinal}`));
      }
      return blocks;
    }

    function indexBlocks() {
      if (!blockIndex) {
        const paragraphById = new Map();
        const idByParagraph = new Map();
        walkBlocks({
          paragraph(element, id) {
            paragraphById.set(id, element);
            idByParagraph.set(element, id);
            return null;
          },
        });
        blockIndex = { paragraphById, idByParagraph };
      }
      return blockIndex;
    }

    function collectBlocks() {
      blockSnapshots ||= walkBlocks({ paragraph: paragraphSnapshot });
      return blockSnapshots;
    }

    function paragraphFor(blockId) {
      return indexBlocks().paragraphById.get(blockId) || null;
    }

    // Leaves every field the run's text sits in when an insertion lands right
    // after a field result: text typed at the end of `PAGE`'s "1" must follow
    // the field's `end` run, or Word's next field update erases it.
    function afterFieldResults(paragraph, run) {
      const runs = paragraphRuns(paragraph);
      let depth = 0;
      let index = 0;
      for (; index < runs.length; index += 1) {
        const type = fieldCharType(runs[index]);
        if (type === 'begin') depth += 1;
        else if (type === 'end' && depth) depth -= 1;
        if (runs[index] === run) break;
      }
      let last = run;
      for (index += 1; depth && index < runs.length && !runText(runs[index]); index += 1) {
        const type = fieldCharType(runs[index]);
        if (type === 'begin') break;
        if (type === 'end') {
          depth -= 1;
          last = runs[index];
        }
      }
      return last;
    }

    // Where new content goes at `offset`, and the run whose properties it takes.
    function insertionBoundary(paragraph, offset) {
      const positions = runPositions(paragraph);
      const inside = positions.find((item) => item.start < offset && offset < item.end);
      if (inside) {
        const right = splitRun(inside.run, offset - inside.start);
        return { parent: right.parentNode, reference: right, source: inside.run };
      }
      const previous = positions.findLast((item) => item.end <= offset && item.text.length);
      if (previous) {
        return { ...boundaryAfter(afterFieldResults(paragraph, previous.run), paragraph), source: previous.run };
      }
      const next = positions.find((item) => item.start >= offset && item.text.length);
      if (next) {
        return { ...boundaryBefore(next.run, paragraph), source: next.run };
      }
      return { parent: paragraph, reference: null, source: directChild(directChild(paragraph, 'pPr'), 'rPr') };
    }

    function validRange(paragraph, start, end = start) {
      const length = runPositions(paragraph).at(-1)?.end || 0;
      return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start && end <= length;
    }

    function insertText(blockId, offset, text) {
      const paragraph = paragraphFor(blockId);
      const value = String(text ?? '').replace(/\r\n?/g, '\n').replace(INVALID_XML_TEXT, '');
      if (!paragraph || !validRange(paragraph, offset) || !value) {
        return false;
      }
      recordMutation();
      const boundary = insertionBoundary(paragraph, offset);
      const run = makeW(documentDoc, 'r');
      const sourceRPr = isW(boundary.source, 'rPr') ? boundary.source : directChild(boundary.source, 'rPr');
      if (sourceRPr) {
        // New text takes the formatting, never a revision: a paragraph mark's
        // rPr holds markers a run rPr cannot, and a run's rPrChange records
        // someone else's earlier format change.
        const rPr = sourceRPr.cloneNode(true);
        for (const child of elementChildren(rPr)) {
          if (child.namespaceURI === W_NS && REVISION_PROPERTIES.has(child.localName)) child.remove();
        }
        run.appendChild(rPr);
      }
      appendTextPayload(documentDoc, run, value);
      boundary.parent.insertBefore(run, boundary.reference);
      // The caller places the caret by what was inserted, not by what it sent.
      return value.length;
    }

    function deleteRange(blockId, start, end) {
      const paragraph = paragraphFor(blockId);
      if (!paragraph || !validRange(paragraph, start, end) || start === end) {
        return false;
      }
      // Zero-length runs (footnote references, field characters, bookmarks,
      // empty runs) carry no visible text, so a text deletion never removes
      // them: they stay in place and the visible slices around them go.
      const affected = runPositions(paragraph).filter((item) => item.text && item.start < end && item.end > start);
      // Only a removed drawing can orphan media: plain Backspace skips the DOM-wide scan.
      const removesDrawing = affected.some((item) => directChild(item.run, 'drawing')
        && item.text.slice(Math.max(start, item.start) - item.start, end - item.start).includes('\uFFFC'));
      recordMutation();
      for (const item of affected) {
        removeRunSlice(item.run, Math.max(start, item.start) - item.start, Math.min(end, item.end) - item.start);
      }
      if (removesDrawing) mediaRetention.reclaim();
      return true;
    }

    function splitBoundary(paragraph, offset) {
      const positions = runPositions(paragraph);
      const inside = positions.find((item) => item.start < offset && offset < item.end);
      if (inside) {
        const right = splitRun(inside.run, offset - inside.start);
        return { container: right.parentNode, reference: right };
      }
      if (offset === 0) {
        const pPr = directChild(paragraph, 'pPr');
        return { container: paragraph, reference: pPr ? pPr.nextSibling : paragraph.firstChild };
      }
      const next = positions.find((item) => item.start >= offset && item.text.length);
      if (!next) {
        return { container: paragraph, reference: null };
      }
      const boundary = boundaryBefore(next.run, paragraph);
      return { container: boundary.parent, reference: boundary.reference };
    }

    // Annotation ids (revisions, comments, bookmarks) share one id space.
    function nextAnnotationId() {
      let maximum = 0;
      for (const element of documentDoc.getElementsByTagNameNS(W_NS, '*')) {
        const value = Number.parseInt(element.getAttributeNS(W_NS, 'id'), 10);
        if (Number.isFinite(value) && value > maximum) maximum = value;
      }
      return String(maximum + 1);
    }

    function liftBoundary(paragraph, boundary) {
      let { container, reference } = boundary;
      while (container !== paragraph) {
        const wrapper = container;
        const parent = wrapper.parentNode;
        const rightWrapper = wrapper.cloneNode(false);
        if (wrapper.namespaceURI === W_NS && REVISION_WRAPPERS.has(wrapper.localName) && wrapper.hasAttributeNS(W_NS, 'id')) {
          rightWrapper.setAttributeNS(W_NS, 'w:id', nextAnnotationId());
        }
        let moving = reference;
        while (moving) {
          const next = moving.nextSibling;
          rightWrapper.appendChild(moving);
          moving = next;
        }
        if (rightWrapper.childNodes.length) {
          parent.insertBefore(rightWrapper, wrapper.nextSibling);
          reference = rightWrapper;
        } else {
          reference = wrapper.nextSibling;
        }
        container = parent;
      }
      return reference;
    }

    function splitParagraph(blockId, offset) {
      const paragraph = paragraphFor(blockId);
      if (!paragraph || !validRange(paragraph, offset)) {
        return null;
      }
      recordMutation();
      const reference = liftBoundary(paragraph, splitBoundary(paragraph, offset));
      const newParagraph = makeW(documentDoc, 'p');
      const pPr = directChild(paragraph, 'pPr');
      if (pPr) {
        newParagraph.appendChild(pPr.cloneNode(true));
        // A section break belongs to its section's last paragraph, which is now the right half.
        directChild(pPr, 'sectPr')?.remove();
      }
      let moving = reference;
      while (moving) {
        const next = moving.nextSibling;
        if (moving !== pPr) {
          newParagraph.appendChild(moving);
        }
        moving = next;
      }
      paragraph.parentNode.insertBefore(newParagraph, paragraph.nextSibling);
      dropBlockCaches();
      return indexBlocks().idByParagraph.get(newParagraph) || null;
    }

    function mergeWithPrevious(blockId) {
      const index = indexBlocks();
      const paragraph = index.paragraphById.get(blockId);
      const previous = paragraph?.previousElementSibling;
      let previousPPr = directChild(previous, 'pPr');
      // A section break on the previous paragraph separates two sections; merging would fold them.
      if (!paragraph || !isW(previous, 'p') || directChild(previousPPr, 'sectPr')) {
        return null;
      }
      const previousId = index.idByParagraph.get(previous);
      recordMutation();
      const sectPr = directChild(directChild(paragraph, 'pPr'), 'sectPr');
      if (sectPr) {
        if (!previousPPr) {
          previousPPr = makeW(documentDoc, 'pPr');
          previous.insertBefore(previousPPr, previous.firstChild);
        }
        previousPPr.insertBefore(sectPr, directChild(previousPPr, 'pPrChange'));
      }
      for (const child of [...paragraph.childNodes]) {
        if (!isW(child, 'pPr')) {
          previous.appendChild(child);
        }
      }
      paragraph.remove();
      return previousId || null;
    }

    function ensureRunProperty(run, name, enabled) {
      let rPr = directChild(run, 'rPr');
      if (!enabled) {
        directChild(rPr, name)?.remove();
        if (rPr && !elementChildren(rPr).length) {
          rPr.remove();
        }
        return;
      }
      if (!rPr) {
        rPr = makeW(documentDoc, 'rPr');
        run.insertBefore(rPr, run.firstChild);
      }
      let property = directChild(rPr, name);
      if (!property) {
        property = makeW(documentDoc, name);
        const order = RPR_ORDER.indexOf(name);
        // rPrChange must stay the last child (CT_RPr schema order).
        const next = elementChildren(rPr).find((child) => {
          const childOrder = RPR_ORDER.indexOf(child.localName);
          return (childOrder >= 0 && childOrder > order) || isW(child, 'rPrChange');
        });
        rPr.insertBefore(property, next || null);
      }
      if (name === 'u') {
        property.setAttributeNS(W_NS, 'w:val', 'single');
      } else {
        property.removeAttributeNS(W_NS, 'val');
      }
    }

    function toggleRunProperty(blockId, start, end, prop) {
      const paragraph = paragraphFor(blockId);
      const name = PROPERTY_NAMES[prop];
      if (!paragraph || !name || !validRange(paragraph, start, end) || start === end) {
        return false;
      }
      const selected = runPositions(paragraph).filter((item) => (
        item.start < end && item.end > start && item.text && !directChild(item.run, 'drawing')
      ));
      if (!selected.length) {
        return false;
      }
      const newState = !selected.every((item) => enabledValue(directRunProperty(item.run, name), name === 'u'));
      recordMutation();
      const endEntry = runPositions(paragraph).find((item) => item.start < end && end < item.end);
      if (endEntry) {
        splitRun(endEntry.run, end - endEntry.start);
      }
      const startEntry = runPositions(paragraph).find((item) => item.start < start && start < item.end);
      if (startEntry) {
        splitRun(startEntry.run, start - startEntry.start);
      }
      for (const item of runPositions(paragraph)) {
        if (item.start >= start && item.end <= end && item.text && !directChild(item.run, 'drawing')) {
          ensureRunProperty(item.run, name, newState);
        }
      }
      return newState;
    }

    function ensureNumbering() {
      if (numberingDoc) {
        return;
      }
      numberingDeclaration = XML_DECL;
      numberingDoc = parser().parseFromString(`<w:numbering xmlns:w="${W_NS}"/>`, 'application/xml');
      invalidate('numbering');
    }

    function nextNumericId(elements, attribute, floor = -1) {
      return String(elements.reduce((maximum, element) => {
        const value = Number.parseInt(wAttr(element, attribute), 10);
        return Number.isFinite(value) ? Math.max(maximum, value) : maximum;
      }, floor) + 1);
    }

    function findNumberId(kind) {
      if (!numberingDoc) {
        return '';
      }
      const format = kind === 'bullet' ? 'bullet' : 'decimal';
      const abstracts = Array.from(numberingDoc.getElementsByTagNameNS(W_NS, 'abstractNum'));
      const abstract = abstracts.find((item) => {
        const level = Array.from(item.getElementsByTagNameNS(W_NS, 'lvl'))
          .find((candidate) => (wAttr(candidate, 'ilvl') || '0') === '0');
        return wAttr(directChild(level, 'numFmt'), 'val') === format;
      });
      if (!abstract) {
        return '';
      }
      const abstractId = wAttr(abstract, 'abstractNumId');
      const num = Array.from(numberingDoc.getElementsByTagNameNS(W_NS, 'num'))
        .find((item) => wAttr(directChild(item, 'abstractNumId'), 'val') === abstractId);
      return wAttr(num, 'numId');
    }

    function addNumbering(kind) {
      ensureNumbering();
      const root = numberingDoc.documentElement;
      const abstracts = Array.from(numberingDoc.getElementsByTagNameNS(W_NS, 'abstractNum'));
      const nums = Array.from(numberingDoc.getElementsByTagNameNS(W_NS, 'num'));
      const abstractId = nextNumericId(abstracts, 'abstractNumId');
      const numId = nextNumericId(nums, 'numId', 0);
      const abstract = makeW(numberingDoc, 'abstractNum');
      abstract.setAttributeNS(W_NS, 'w:abstractNumId', abstractId);
      const level = makeW(numberingDoc, 'lvl');
      level.setAttributeNS(W_NS, 'w:ilvl', '0');
      // w:start defaults to 0 when omitted, so Word would number "0., 1., ...".
      const start = makeW(numberingDoc, 'start');
      start.setAttributeNS(W_NS, 'w:val', '1');
      const numFmt = makeW(numberingDoc, 'numFmt');
      numFmt.setAttributeNS(W_NS, 'w:val', kind === 'bullet' ? 'bullet' : 'decimal');
      const lvlText = makeW(numberingDoc, 'lvlText');
      lvlText.setAttributeNS(W_NS, 'w:val', kind === 'bullet' ? '\u2022' : '%1.');
      const lvlJc = makeW(numberingDoc, 'lvlJc');
      lvlJc.setAttributeNS(W_NS, 'w:val', 'left');
      const pPr = makeW(numberingDoc, 'pPr');
      const ind = makeW(numberingDoc, 'ind');
      ind.setAttributeNS(W_NS, 'w:left', '720');
      ind.setAttributeNS(W_NS, 'w:hanging', '360');
      pPr.appendChild(ind);
      level.append(start, numFmt, lvlText, lvlJc, pPr);
      abstract.appendChild(level);
      // Schema order: numPicBullet*, abstractNum*, num*, numIdMacAtCleanup?.
      const trailer = directChild(root, 'numIdMacAtCleanup');
      root.insertBefore(abstract, nums[0] || trailer);
      const num = makeW(numberingDoc, 'num');
      num.setAttributeNS(W_NS, 'w:numId', numId);
      const abstractRef = makeW(numberingDoc, 'abstractNumId');
      abstractRef.setAttributeNS(W_NS, 'w:val', abstractId);
      num.appendChild(abstractRef);
      root.insertBefore(num, trailer);
      invalidate('numbering');
      return numId;
    }

    function ensureParagraphProperties(paragraph) {
      let pPr = directChild(paragraph, 'pPr');
      if (!pPr) {
        pPr = makeW(documentDoc, 'pPr');
        paragraph.insertBefore(pPr, paragraph.firstChild);
      }
      return pPr;
    }

    function insertNumProperties(pPr, numPr) {
      const allowedBefore = new Set(['pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl']);
      let reference = elementChildren(pPr).find((child) => !allowedBefore.has(child.localName)) || null;
      pPr.insertBefore(numPr, reference);
    }

    function setList(blockId, kind) {
      const paragraph = paragraphFor(blockId);
      if (!paragraph || !['bullet', 'number', null].includes(kind) || (kind && numberingUnreadable)) {
        return false;
      }
      const pPr = directChild(paragraph, 'pPr');
      const existing = directChild(pPr, 'numPr');
      if (kind === null) {
        if (!existing) {
          return false;
        }
        recordMutation();
        existing.remove();
        return true;
      }
      let numId = findNumberId(kind);
      const existingInfo = listInfoFor(paragraph);
      if (numId && existingInfo?.kind === kind && existingInfo.numId === numId && existingInfo.level === 0) {
        return false;
      }
      recordMutation();
      if (!numId) {
        numId = addNumbering(kind);
      }
      const properties = ensureParagraphProperties(paragraph);
      directChild(properties, 'numPr')?.remove();
      const numPr = makeW(documentDoc, 'numPr');
      const ilvl = makeW(documentDoc, 'ilvl');
      ilvl.setAttributeNS(W_NS, 'w:val', '0');
      const numIdElement = makeW(documentDoc, 'numId');
      numIdElement.setAttributeNS(W_NS, 'w:val', numId);
      numPr.append(ilvl, numIdElement);
      insertNumProperties(properties, numPr);
      return true;
    }

    function getUnsupportedNotes() {
      notesCache ||= unsupportedNotes();
      return notesCache;
    }

    function unsupportedNotes() {
      const has = (namespace, name) => documentDoc.getElementsByTagNameNS(namespace, name).length > 0;
      const nestedTable = Array.from(documentDoc.getElementsByTagNameNS(W_NS, 'tbl')).some((table) => {
        let parent = table.parentNode;
        while (parent) {
          if (isW(parent, 'tc')) {
            return true;
          }
          parent = parent.parentNode;
        }
        return false;
      });
      const checks = [
        ['fields', has(W_NS, 'fldSimple') || has(W_NS, 'fldChar')],
        ['footnotes', has(W_NS, 'footnoteReference')],
        ['comments', has(W_NS, 'commentRangeStart')],
        ['trackedChanges', ['ins', 'del', 'moveFrom', 'moveTo', 'rPrChange', 'pPrChange'].some((name) => has(W_NS, name))],
        ['contentControls', has(W_NS, 'sdt')],
        ['textBoxes', has(W_NS, 'txbxContent')],
        ['math', has('*', 'oMath')],
        ['nestedTables', nestedTable],
      ];
      return checks.filter(([, present]) => present).map(([name]) => name);
    }

    const imageOperations = imageUtils.createImageOperations({
      getDocumentDoc: () => documentDoc,
      getRelsDoc: () => relsDoc,
      getMedia: () => media,
      mediaRetention,
      ensureRelationships,
      paragraphFor,
      validRange,
      insertionBoundary,
      recordMutation,
      mediaPrefix: options.mediaPrefix,
      occupiedNames: options.occupiedNames,
    });
    // recordMutation() runs before a mutator's DOM change, so invalidate once the public mutator returns.
    const mutating = (method, ...parts) => (...args) => {
      const version = mutationVersion;
      try { return method(...args); } finally { if (mutationVersion !== version) invalidate(...parts); }
    };

    return {
      getBlocks() {
        return collectBlocks();
      },
      // One paragraph's snapshot without snapshotting the whole document.
      getBlock(blockId) {
        const paragraph = paragraphFor(blockId);
        return paragraph ? paragraphSnapshot(paragraph, blockId) : null;
      },
      getParagraphText(blockId) {
        const paragraph = paragraphFor(blockId);
        return paragraph ? runPositions(paragraph).map((item) => item.text).join('') : '';
      },
      insertText: mutating(insertText, 'document'),
      insertImage: mutating(imageOperations.insertImage, 'document', 'rels'),
      resizeImage: mutating(imageOperations.resizeImage, 'document'),
      deleteRange: mutating(deleteRange, 'document'),
      splitParagraph: mutating(splitParagraph, 'document'),
      mergeWithPrevious: mutating(mergeWithPrevious, 'document'),
      toggleRunProperty: mutating(toggleRunProperty, 'document'),
      setList: mutating(setList, 'document'),
      getListInfo(blockId) {
        const paragraph = paragraphFor(blockId);
        return paragraph ? listInfoFor(paragraph) : null;
      },
      undo() {
        if (!undoStack.length) {
          return false;
        }
        redoStack.push(snapshot());
        restore(undoStack.pop());
        trimHistory();
        return true;
      },
      redo() {
        if (!redoStack.length) {
          return false;
        }
        undoStack.push(snapshot());
        restore(redoStack.pop());
        trimHistory();
        return true;
      },
      canUndo() {
        return undoStack.length > 0;
      },
      canRedo() {
        return redoStack.length > 0;
      },
      getHistoryCounts() {
        return { undo: undoStack.length, redo: redoStack.length };
      },
      getMutationVersion() {
        return mutationVersion;
      },
      getStateVersion() {
        return stateVersion;
      },
      beginTransaction() {
        transactionDepth += 1;
      },
      endTransaction() {
        if (transactionDepth > 0) {
          transactionDepth -= 1;
        }
        if (!transactionDepth) {
          transactionRecorded = false;
        }
      },
      isDirty() {
        if (stateVersion === savedStateVersion) return false;
        if (dirtyMemo?.version !== stateVersion) {
          dirtyMemo = {
            version: stateVersion,
            value: documentXml() !== savedDocument || numberingXml() !== savedNumbering
              || relsXml() !== savedRels || !mediaRetention.matches(savedMedia, documentDoc, relsDoc),
          };
        }
        return dirtyMemo.value;
      },
      markSaved() {
        savedStateVersion = stateVersion;
        dirtyMemo = null;
        savedDocument = documentXml();
        savedNumbering = numberingXml();
        savedRels = relsXml();
        savedMedia = mediaRetention.identities(documentDoc, relsDoc);
      },
      serialize() {
        const currentNumbering = numberingXml();
        const result = {
          'word/document.xml': documentXml(),
          newNumberingPart: !hadNumberingPart && Boolean(currentNumbering),
        };
        if (currentNumbering && currentNumbering !== initialNumbering) {
          result['word/numbering.xml'] = currentNumbering;
        }
        if (relsXml() !== initialRels) {
          result['word/_rels/document.xml.rels'] = relsXml();
        }
        result.media = mediaRetention.exported(documentDoc, relsDoc);
        return result;
      },
      getUnsupportedNotes,
    };
  }

  return { createDocxModel, W_NS };
});
