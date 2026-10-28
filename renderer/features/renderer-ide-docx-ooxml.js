/* renderer/features/renderer-ide-docx-ooxml.js - stateless WordprocessingML
 * helpers shared by the DOCX model: namespaces, element lookup, run text and
 * offsets, run splitting and slicing, and insertion boundaries. No document
 * state lives here; renderer-ide-docx-model.js owns parts, history and caches. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeDocxOoxml = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
  const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const XML_NS = 'http://www.w3.org/XML/1998/namespace';

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

  function hasDoctype(xml) {
    return /<!DOCTYPE/i.test(String(xml || ''));
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

  function fieldCharType(run) {
    return wAttr(directChild(run, 'fldChar'), 'fldCharType');
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

  return {
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
    cloneRunProperties,
    splitRun,
    setTextSpace,
    appendTextPayload,
    significantSibling,
    boundaryAfter,
    boundaryBefore,
    removeRunSlice,
  };
});
