/* renderer/features/renderer-ide-docx-model.js - preservation-first OOXML
 * document model. Callers own package extraction and inject the XML DOM APIs. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-ide-docx-image-model'));
    return;
  }
  root.rendererIdeDocxModel = factory(root.rendererIdeDocxImageModel);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (imageUtils) {
  'use strict';

  const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
  const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const XML_NS = 'http://www.w3.org/XML/1998/namespace';
  const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const PROPERTY_NAMES = { bold: 'b', italic: 'i', underline: 'u', strike: 'strike' };
  const RPR_ORDER = [
    'rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike',
    'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden',
    'color', 'spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect',
    'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout',
    'specVanish', 'oMath',
  ];
  function elementChildren(node) {
    return Array.from(node?.childNodes || []).filter((child) => child.nodeType === 1);
  }

  function isW(node, name) {
    return Boolean(node && node.namespaceURI === W_NS && node.localName === name);
  }
  function directChild(node, name) {
    return elementChildren(node).find((child) => isW(child, name)) || null;
  }
  function wAttr(node, name) {
    return node?.getAttributeNS(W_NS, name) ?? node?.getAttribute(`w:${name}`) ?? '';
  }
  function makeW(doc, name) {
    return doc.createElementNS(W_NS, `w:${name}`);
  }
  function declarationOf(xml) {
    return String(xml || '').match(/^<\?xml[^\r\n]*\?>(?:\r\n|\n|\r)?/)?.[0] || '';
  }

  function invalidError() {
    const error = new Error('Invalid DOCX document XML');
    error.code = 'docx_invalid';
    return error;
  }

  function hasParserError(doc) {
    return !doc?.documentElement
      || doc.documentElement.localName === 'parsererror'
      || doc.getElementsByTagName('parsererror').length > 0;
  }

  function nearestParagraph(node) {
    let current = node?.parentNode;
    while (current) {
      if (isW(current, 'p')) {
        return current;
      }
      current = current.parentNode;
    }
    return null;
  }

  function directRunProperty(run, name) {
    const rPr = directChild(run, 'rPr');
    return rPr ? directChild(rPr, name) : null;
  }

  function enabledValue(element, underline = false) {
    if (!element) {
      return false;
    }
    const value = wAttr(element, 'val').toLowerCase();
    if (underline && value === 'none') {
      return false;
    }
    return !['0', 'false', 'off', 'no'].includes(value);
  }

  function runText(run) {
    let text = '';
    for (const child of elementChildren(run)) {
      if (isW(child, 't')) {
        text += child.textContent || '';
      } else if (isW(child, 'tab')) {
        text += '\t';
      } else if (isW(child, 'br')) {
        text += '\n';
      } else if (isW(child, 'drawing')) {
        text += '\uFFFC';
      }
    }
    return text;
  }

  function paragraphRuns(paragraph) {
    return Array.from(paragraph.getElementsByTagNameNS(W_NS, 'r'))
      .filter((run) => nearestParagraph(run) === paragraph);
  }

  function runPositions(paragraph) {
    let offset = 0;
    return paragraphRuns(paragraph).map((run) => {
      const text = runText(run);
      const entry = { run, text, start: offset, end: offset + text.length };
      offset = entry.end;
      return entry;
    });
  }

  function payloadLength(node) {
    if (isW(node, 't')) {
      return (node.textContent || '').length;
    }
    return isW(node, 'tab') || isW(node, 'br') || isW(node, 'drawing') ? 1 : 0;
  }

  function cloneRunProperties(run, target) {
    const rPr = directChild(run, 'rPr');
    if (rPr) {
      target.appendChild(rPr.cloneNode(true));
    }
  }

  function splitRun(run, offset) {
    const right = run.cloneNode(false);
    cloneRunProperties(run, right);
    let position = 0;
    for (const child of [...run.childNodes]) {
      if (isW(child, 'rPr')) {
        continue;
      }
      const length = child.nodeType === 1 ? payloadLength(child) : 0;
      if (isW(child, 't') && position < offset && offset < position + length) {
        const value = child.textContent || '';
        const cut = offset - position;
        child.textContent = value.slice(0, cut);
        setTextSpace(child, child.textContent);
        const rightText = child.cloneNode(false);
        rightText.textContent = value.slice(cut);
        setTextSpace(rightText, rightText.textContent);
        right.appendChild(rightText);
      } else if (position >= offset) {
        right.appendChild(child);
      }
      position += length;
    }
    run.parentNode.insertBefore(right, run.nextSibling);
    return right;
  }

  function setTextSpace(textNode, value) {
    if (/^\s|\s$/.test(value)) {
      textNode.setAttributeNS(XML_NS, 'xml:space', 'preserve');
    } else {
      textNode.removeAttributeNS(XML_NS, 'space');
    }
  }

  function appendTextPayload(doc, run, value) {
    let buffer = '';
    function flush() {
      if (!buffer) {
        return;
      }
      const textNode = makeW(doc, 't');
      textNode.textContent = buffer;
      setTextSpace(textNode, buffer);
      run.appendChild(textNode);
      buffer = '';
    }
    for (const character of value) {
      if (character === '\t' || character === '\n') {
        flush();
        run.appendChild(makeW(doc, character === '\t' ? 'tab' : 'br'));
      } else {
        buffer += character;
      }
    }
    flush();
  }

  function significantSibling(node, direction) {
    let sibling = node?.[direction] || null;
    while (sibling && sibling.nodeType === 3 && !sibling.nodeValue.trim()) {
      sibling = sibling[direction];
    }
    return sibling;
  }

  function boundaryAfter(run, paragraph) {
    let node = run;
    while (node.parentNode !== paragraph && !significantSibling(node, 'nextSibling')) {
      node = node.parentNode;
    }
    return { parent: node.parentNode, reference: significantSibling(node, 'nextSibling') };
  }

  function boundaryBefore(run, paragraph) {
    let node = run;
    while (node.parentNode !== paragraph && !significantSibling(node, 'previousSibling')) {
      node = node.parentNode;
    }
    return { parent: node.parentNode, reference: node };
  }

  function removeRunSlice(run, start, end) {
    let position = 0;
    for (const child of [...run.childNodes]) {
      if (child.nodeType !== 1 || isW(child, 'rPr')) {
        continue;
      }
      const length = payloadLength(child);
      const cutStart = Math.max(start, position);
      const cutEnd = Math.min(end, position + length);
      if (cutStart < cutEnd && isW(child, 't')) {
        const value = child.textContent || '';
        child.textContent = value.slice(0, cutStart - position) + value.slice(cutEnd - position);
        if (!child.textContent) {
          child.remove();
        } else {
          setTextSpace(child, child.textContent);
        }
      } else if (cutStart < cutEnd && length === 1) {
        child.remove();
      }
      position += length;
    }
    if (!elementChildren(run).some((child) => !isW(child, 'rPr'))) {
      run.remove();
    }
  }

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
    const parseDocument = (xml) => {
      const parsed = parser().parseFromString(String(xml || ''), 'application/xml');
      const body = Array.from(parsed.getElementsByTagNameNS(W_NS, 'body'))[0];
      if (hasParserError(parsed) || !body) {
        throw invalidError();
      }
      return parsed;
    };
    const parseNumbering = (xml) => {
      if (!xml) {
        return null;
      }
      const parsed = parser().parseFromString(String(xml), 'application/xml');
      return hasParserError(parsed) ? null : parsed;
    };

    documentDoc = parseDocument(options.documentXml);
    numberingDoc = parseNumbering(options.numberingXml);
    const hadNumberingPart = options.numberingXml !== null && options.numberingXml !== undefined;
    let relsDeclaration = declarationOf(options.relsXml);
    let relsDoc = parseNumbering(options.relsXml);
    let media = options.media instanceof Map ? new Map(options.media) : new Map();
    const initialMediaNames = new Set(media.keys());

    function relsXml() {
      return relsDoc ? serializeDom(relsDoc, relsDeclaration) : null;
    }

    function mediaSignature() {
      return JSON.stringify(Array.from(media.entries()).sort(([left], [right]) => left.localeCompare(right)));
    }

    function documentXml() {
      return serializeDom(documentDoc, documentDeclaration);
    }

    function numberingXml() {
      return numberingDoc ? serializeDom(numberingDoc, numberingDeclaration) : null;
    }

    const initialNumbering = numberingXml();
    const initialRels = relsXml();
    let savedDocument = documentXml();
    let savedNumbering = initialNumbering;
    let savedRels = relsXml();
    let savedMedia = mediaSignature();
    const undoStack = [];
    const redoStack = [];
    let transactionDepth = 0;
    let transactionRecorded = false;
    let mutationVersion = 0;

    function snapshot() {
      return {
        documentXml: documentXml(), numberingXml: numberingXml(), relsXml: relsXml(),
        media: Array.from(media.entries()).map(([name, value]) => [name, { ...value }]),
      };
    }

    function recordMutation() {
      mutationVersion += 1;
      if (!transactionDepth || !transactionRecorded) {
        undoStack.push(snapshot());
        if (undoStack.length > 200) {
          undoStack.shift();
        }
        redoStack.length = 0;
        if (transactionDepth) {
          transactionRecorded = true;
        }
      }
    }

    function restore(state) {
      documentDeclaration = declarationOf(state.documentXml);
      numberingDeclaration = declarationOf(state.numberingXml);
      documentDoc = parseDocument(state.documentXml);
      numberingDoc = parseNumbering(state.numberingXml);
      relsDeclaration = declarationOf(state.relsXml);
      relsDoc = parseNumbering(state.relsXml);
      media = new Map(state.media || []);
    }

    function relationshipTarget(id) {
      if (!relsDoc || !id) {
        return '';
      }
      const relationship = Array.from(relsDoc.getElementsByTagNameNS('*', 'Relationship'))
        .find((item) => item.getAttribute('Id') === id);
      if (!relationship || relationship.getAttribute('TargetMode') === 'External') {
        return '';
      }
      const segments = `word/${relationship.getAttribute('Target') || ''}`.split('/');
      const normalized = [];
      for (const segment of segments) {
        if (segment === '..') {
          normalized.pop();
        } else if (segment && segment !== '.') {
          normalized.push(segment);
        }
      }
      return normalized.join('/');
    }

    function ensureRelationships() {
      if (relsDoc) return;
      relsDeclaration = XML_DECL;
      relsDoc = parser().parseFromString(`<Relationships xmlns="${REL_NS}"/>`, 'application/xml');
    }


    function imageSnapshot(run, id) {
      const drawing = directChild(run, 'drawing');
      const blip = drawing?.getElementsByTagNameNS(A_NS, 'blip')[0] || null;
      const extent = drawing?.getElementsByTagNameNS(WP_NS, 'extent')[0] || null;
      const docPr = drawing?.getElementsByTagNameNS(WP_NS, 'docPr')[0] || null;
      const target = relationshipTarget(blip?.getAttributeNS(R_NS, 'embed') || '');
      const source = media.get(target);
      return {
        id,
        kind: 'image',
        src: source ? `data:${source.mime};base64,${source.base64}` : '',
        alt: docPr?.getAttribute('descr') || docPr?.getAttribute('title') || docPr?.getAttribute('name') || '',
        widthPx: Math.round(Number(extent?.getAttribute('cx') || 0) / 9525),
        heightPx: Math.round(Number(extent?.getAttribute('cy') || 0) / 9525),
        text: '\uFFFC',
      };
    }

    function runSnapshot(run, id) {
      if (directChild(run, 'drawing')) {
        return imageSnapshot(run, id);
      }
      const vertical = directRunProperty(run, 'vertAlign');
      return {
        id,
        kind: 'text',
        text: runText(run),
        bold: enabledValue(directRunProperty(run, 'b')),
        italic: enabledValue(directRunProperty(run, 'i')),
        underline: enabledValue(directRunProperty(run, 'u'), true),
        strike: enabledValue(directRunProperty(run, 'strike')),
        superscript: wAttr(vertical, 'val') === 'superscript',
      };
    }

    function listInfoFor(paragraph) {
      const numPr = directChild(directChild(paragraph, 'pPr'), 'numPr');
      const numId = wAttr(directChild(numPr, 'numId'), 'val');
      if (!numPr || !numId) {
        return null;
      }
      const level = Number.parseInt(wAttr(directChild(numPr, 'ilvl'), 'val') || '0', 10) || 0;
      let format = '';
      let start;
      if (numberingDoc) {
        const num = Array.from(numberingDoc.getElementsByTagNameNS(W_NS, 'num'))
          .find((item) => wAttr(item, 'numId') === numId);
        const abstractId = wAttr(directChild(num, 'abstractNumId'), 'val');
        const abstract = Array.from(numberingDoc.getElementsByTagNameNS(W_NS, 'abstractNum'))
          .find((item) => wAttr(item, 'abstractNumId') === abstractId);
        const definition = Array.from(abstract?.getElementsByTagNameNS(W_NS, 'lvl') || [])
          .find((item) => Number.parseInt(wAttr(item, 'ilvl') || '0', 10) === level);
        format = wAttr(directChild(definition, 'numFmt'), 'val');
        const rawStart = wAttr(directChild(definition, 'start'), 'val');
        if (rawStart !== '') {
          start = Number.parseInt(rawStart, 10);
        }
      }
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
      const runs = paragraphRuns(paragraph).map((run, index) => runSnapshot(run, `${id}.r${index + 1}`));
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

    function collectBlocks() {
      const paragraphById = new Map();
      const idByParagraph = new Map();
      function blockFor(element, id) {
        if (isW(element, 'p')) {
          paragraphById.set(id, element);
          idByParagraph.set(element, id);
          return paragraphSnapshot(element, id);
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
              let blockIndex = 0;
              const blocks = [];
              for (const child of elementChildren(cell)) {
                if (isW(child, 'tcPr')) {
                  continue;
                }
                blockIndex += 1;
                blocks.push(blockFor(child, `${cellId}.b${blockIndex}`));
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
      return { blocks, paragraphById, idByParagraph };
    }

    function paragraphFor(blockId) {
      return collectBlocks().paragraphById.get(blockId) || null;
    }

    function validRange(paragraph, start, end = start) {
      const length = runPositions(paragraph).at(-1)?.end || 0;
      return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start && end <= length;
    }

    function insertText(blockId, offset, text) {
      const paragraph = paragraphFor(blockId);
      const value = String(text ?? '');
      if (!paragraph || !validRange(paragraph, offset) || !value) {
        return false;
      }
      const positions = runPositions(paragraph);
      const inside = positions.find((item) => item.start < offset && offset < item.end);
      const previous = [...positions].reverse().find((item) => item.end <= offset && item.text.length);
      const next = positions.find((item) => item.start >= offset && item.text.length);
      const source = inside?.run || previous?.run || next?.run || directChild(directChild(paragraph, 'pPr'), 'rPr');
      recordMutation();
      let boundary;
      if (inside) {
        const right = splitRun(inside.run, offset - inside.start);
        boundary = { parent: right.parentNode, reference: right };
      } else if (previous) {
        boundary = boundaryAfter(previous.run, paragraph);
      } else if (next) {
        boundary = boundaryBefore(next.run, paragraph);
      } else {
        boundary = { parent: paragraph, reference: null };
      }
      const run = makeW(documentDoc, 'r');
      if (source) {
        if (isW(source, 'rPr')) {
          run.appendChild(source.cloneNode(true));
        } else {
          cloneRunProperties(source, run);
        }
      }
      appendTextPayload(documentDoc, run, value);
      boundary.parent.insertBefore(run, boundary.reference);
      return true;
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
      recordMutation();
      for (const item of affected) {
        removeRunSlice(item.run, Math.max(start, item.start) - item.start, Math.min(end, item.end) - item.start);
      }
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

    function liftBoundary(paragraph, boundary) {
      let { container, reference } = boundary;
      while (container !== paragraph) {
        const wrapper = container;
        const parent = wrapper.parentNode;
        const rightWrapper = wrapper.cloneNode(false);
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
      return collectBlocks().idByParagraph.get(newParagraph) || null;
    }

    function mergeWithPrevious(blockId) {
      const index = collectBlocks();
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
        const next = elementChildren(rPr).find((child) => {
          const childOrder = RPR_ORDER.indexOf(child.localName);
          return childOrder >= 0 && childOrder > order;
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
      level.append(numFmt, lvlText, lvlJc, pPr);
      abstract.appendChild(level);
      root.insertBefore(abstract, nums[0] || null);
      const num = makeW(numberingDoc, 'num');
      num.setAttributeNS(W_NS, 'w:numId', numId);
      const abstractRef = makeW(numberingDoc, 'abstractNumId');
      abstractRef.setAttributeNS(W_NS, 'w:val', abstractId);
      num.appendChild(abstractRef);
      root.appendChild(num);
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
      if (!paragraph || !['bullet', 'number', null].includes(kind)) {
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
        ['trackedChanges', has(W_NS, 'ins') || has(W_NS, 'del')],
        ['contentControls', has(W_NS, 'sdt')],
        ['textBoxes', has(W_NS, 'txbxContent')],
        ['math', has('*', 'oMath')],
        ['nestedTables', nestedTable],
      ];
      return checks.filter(([, present]) => present).map(([name]) => name);
    }

    const imageOperations = imageUtils?.createImageOperations?.({
      getDocumentDoc: () => documentDoc,
      getRelsDoc: () => relsDoc,
      getMedia: () => media,
      ensureRelationships,
      paragraphFor,
      validRange,
      runPositions,
      splitRun,
      boundaryAfter,
      boundaryBefore,
      directChild,
      recordMutation,
      mediaPrefix: options.mediaPrefix,
      occupiedNames: options.occupiedNames,
    }) || { insertImage: () => false, resizeImage: () => false };

    return {
      getBlocks() {
        return collectBlocks().blocks;
      },
      getParagraphText(blockId) {
        const paragraph = paragraphFor(blockId);
        return paragraph ? runPositions(paragraph).map((item) => item.text).join('') : '';
      },
      insertText,
      insertImage: imageOperations.insertImage,
      resizeImage: imageOperations.resizeImage,
      deleteRange,
      splitParagraph,
      mergeWithPrevious,
      toggleRunProperty,
      setList,
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
        return true;
      },
      redo() {
        if (!redoStack.length) {
          return false;
        }
        undoStack.push(snapshot());
        restore(redoStack.pop());
        return true;
      },
      canUndo() {
        return undoStack.length > 0;
      },
      canRedo() {
        return redoStack.length > 0;
      },
      getMutationVersion() {
        return mutationVersion;
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
        return documentXml() !== savedDocument || numberingXml() !== savedNumbering
          || relsXml() !== savedRels || mediaSignature() !== savedMedia;
      },
      markSaved() {
        savedDocument = documentXml();
        savedNumbering = numberingXml();
        savedRels = relsXml();
        savedMedia = mediaSignature();
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
        result.media = new Map(Array.from(media).filter(([name]) => !initialMediaNames.has(name)));
        return result;
      },
      getUnsupportedNotes,
    };
  }

  return { createDocxModel, W_NS };
});
