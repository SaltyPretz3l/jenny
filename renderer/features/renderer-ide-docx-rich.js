/* renderer/features/renderer-ide-docx-rich.js - composes the main OOXML
 * document with editable first/default/even header and footer parts. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeDocxRich = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

  function parseXml(Parser, xml) {
    const doc = new Parser().parseFromString(String(xml || ''), 'application/xml');
    if (!doc.documentElement || doc.documentElement.localName === 'parsererror'
      || doc.getElementsByTagName('parsererror').length) return null;
    return doc;
  }

  function declarationOf(xml) {
    return String(xml || '').match(/^<\?xml[^\r\n]*\?>(?:\r\n|\n|\r)?/)?.[0] || '';
  }

  function resolvePartPath(basePath, target) {
    const raw = String(target || '').replaceAll('\\', '/');
    const source = raw.startsWith('/') ? raw.slice(1) : `${basePath.slice(0, basePath.lastIndexOf('/') + 1)}${raw}`;
    const parts = [];
    for (const part of source.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') parts.pop();
      else parts.push(part);
    }
    const resolved = parts.join('/');
    return resolved.startsWith('word/') ? resolved : '';
  }

  function relationshipsPath(partPath) {
    const slash = partPath.lastIndexOf('/');
    return `${partPath.slice(0, slash)}/_rels/${partPath.slice(slash + 1)}.rels`;
  }

  function discoverRelatedParts({ documentXml, relsXml, DOMParser }) {
    const documentDoc = parseXml(DOMParser, documentXml);
    const relsDoc = parseXml(DOMParser, relsXml);
    if (!documentDoc || !relsDoc) return [];
    const relationships = new Map(Array.from(relsDoc.getElementsByTagNameNS('*', 'Relationship'))
      .filter((item) => item.getAttribute('TargetMode') !== 'External')
      .map((item) => [item.getAttribute('Id'), item.getAttribute('Target')]));
    const result = [];
    for (const type of ['header', 'footer']) {
      for (const reference of documentDoc.getElementsByTagNameNS(W_NS, type + 'Reference')) {
        const id = reference.getAttributeNS(R_NS, 'id') || reference.getAttribute('r:id');
        const path = resolvePartPath('word/document.xml', relationships.get(id));
        const variant = reference.getAttributeNS(W_NS, 'type') || reference.getAttribute('w:type') || 'default';
        if (!path || result.some((item) => item.path === path)) continue;
        result.push({ key: `${type}${result.length + 1}`, type, variant, path, relsPath: relationshipsPath(path) });
      }
    }
    return result;
  }

  function copyRootAttributes(source, target) {
    for (const attribute of Array.from(source.attributes || [])) {
      if (attribute.namespaceURI) target.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
      else if (attribute.name === 'xmlns') target.setAttributeNS(XMLNS_NS, 'xmlns', attribute.value);
      else target.setAttribute(attribute.name, attribute.value);
    }
  }

  function wrapPartXml(xml, Parser, Serializer) {
    const source = parseXml(Parser, xml);
    if (!source) return null;
    const wrapped = parseXml(Parser, `<w:document xmlns:w="${W_NS}"><w:body/></w:document>`);
    copyRootAttributes(source.documentElement, wrapped.documentElement);
    const body = wrapped.getElementsByTagNameNS(W_NS, 'body')[0];
    for (const child of Array.from(source.documentElement.childNodes)) {
      body.appendChild(wrapped.importNode(child, true));
    }
    return {
      xml: declarationOf(xml) + new Serializer().serializeToString(wrapped),
      declaration: declarationOf(xml),
      root: source.documentElement.cloneNode(false),
    };
  }

  function unwrapPartXml(xml, wrapped, Parser, Serializer) {
    const source = parseXml(Parser, xml);
    const output = source.implementation.createDocument(wrapped.root.namespaceURI, wrapped.root.nodeName, null);
    copyRootAttributes(wrapped.root, output.documentElement);
    const body = source.getElementsByTagNameNS(W_NS, 'body')[0];
    for (const child of Array.from(body?.childNodes || [])) {
      output.documentElement.appendChild(output.importNode(child, true));
    }
    return wrapped.declaration + new Serializer().serializeToString(output);
  }

  function prefixBlock(block, prefix) {
    const result = { ...block, id: `${prefix}::${block.id}` };
    if (block.type === 'table') {
      result.rows = block.rows.map((row) => ({
        ...row, id: `${prefix}::${row.id}`,
        cells: row.cells.map((cell) => ({
          ...cell, id: `${prefix}::${cell.id}`,
          blocks: cell.blocks.map((item) => prefixBlock(item, prefix)),
        })),
      }));
    }
    return result;
  }

  function createCompositeDocxModel(options) {
    const createModel = options.createDocxModel;
    const Parser = options.DOMParser;
    const Serializer = options.XMLSerializer;
    const parts = [];
    const body = {
      key: 'body', type: 'body', variant: 'default', path: 'word/document.xml',
      model: createModel({ ...options, mediaPrefix: 'body' }),
    };
    parts.push(body);
    for (const descriptor of options.relatedParts || []) {
      const wrapped = wrapPartXml(descriptor.xml, Parser, Serializer);
      if (!wrapped) continue;
      parts.push({
        ...descriptor, wrapped,
        model: createModel({
          documentXml: wrapped.xml, numberingXml: options.numberingXml, relsXml: descriptor.relsXml,
          media: options.media, DOMParser: Parser, XMLSerializer: Serializer,
          occupiedNames: options.occupiedNames,
          mediaPrefix: descriptor.key,
        }),
      });
    }
    const byKey = new Map(parts.map((part) => [part.key, part]));
    const undoKeys = [];
    const redoKeys = [];
    const touchedParts = new Set();
    let transactionDepth = 0;
    let transactionPart = null;

    function route(blockId) {
      const value = String(blockId || '');
      const marker = value.indexOf('::');
      if (marker < 0) return { part: body, id: value };
      return { part: byKey.get(value.slice(0, marker)), id: value.slice(marker + 2) };
    }

    function mutate(method, blockId, ...args) {
      const target = route(blockId);
      if (!target.part || typeof target.part.model[method] !== 'function') return false;
      if (transactionPart && transactionPart !== target.part) return false;
      const model = target.part.model;
      const before = model.getMutationVersion();
      if (transactionDepth && !transactionPart) model.beginTransaction();
      const result = model[method](target.id, ...args);
      if (model.getMutationVersion() !== before) {
        touchedParts.add(target.part.key);
        if (transactionDepth) transactionPart = target.part;
        else {
          undoKeys.push(target.part.key);
          redoKeys.length = 0;
        }
      } else if (transactionDepth && !transactionPart) {
        model.endTransaction();
      }
      return result;
    }

    function getRegions() {
      const order = { header: 0, body: 1, footer: 2 };
      return [...parts].sort((left, right) => order[left.type] - order[right.type]).map((part) => ({
        key: part.key,
        type: part.type,
        variant: part.variant,
        blocks: part.key === 'body' ? part.model.getBlocks() : part.model.getBlocks().map((block) => prefixBlock(block, part.key)),
      }));
    }

    function history(redo) {
      const source = redo ? redoKeys : undoKeys;
      const target = redo ? undoKeys : redoKeys;
      const key = source.pop();
      const part = byKey.get(key);
      if (!part || !(redo ? part.model.redo() : part.model.undo())) return false;
      target.push(key);
      return true;
    }

    return {
      getRegions,
      getBlocks: () => getRegions().flatMap((region) => region.blocks),
      getParagraphText(blockId) { const target = route(blockId); return target.part?.model.getParagraphText(target.id) || ''; },
      getListInfo(blockId) { const target = route(blockId); return target.part?.model.getListInfo(target.id) || null; },
      insertText: (id, ...args) => mutate('insertText', id, ...args),
      insertImage: (id, ...args) => mutate('insertImage', id, ...args),
      resizeImage: (id, ...args) => mutate('resizeImage', id, ...args),
      deleteRange: (id, ...args) => mutate('deleteRange', id, ...args),
      splitParagraph(id, ...args) {
        const result = mutate('splitParagraph', id, ...args);
        const target = route(id);
        return result && target.part?.key !== 'body' ? `${target.part.key}::${result}` : result;
      },
      mergeWithPrevious(id, ...args) {
        const result = mutate('mergeWithPrevious', id, ...args);
        const target = route(id);
        return result && target.part?.key !== 'body' ? `${target.part.key}::${result}` : result;
      },
      toggleRunProperty: (id, ...args) => mutate('toggleRunProperty', id, ...args),
      canSetList: (id) => route(id).part === body,
      setList: (id, ...args) => route(id).part === body && mutate('setList', id, ...args),
      beginTransaction() { transactionDepth += 1; },
      endTransaction() {
        if (transactionDepth > 0) transactionDepth -= 1;
        if (!transactionDepth && transactionPart) {
          transactionPart.model.endTransaction();
          undoKeys.push(transactionPart.key);
          redoKeys.length = 0;
          transactionPart = null;
        }
      },
      undo: () => history(false),
      redo: () => history(true),
      canUndo: () => undoKeys.length > 0,
      canRedo: () => redoKeys.length > 0,
      isDirty: () => parts.some((part) => part.model.isDirty()),
      markSaved() { for (const part of parts) part.model.markSaved(); },
      getUnsupportedNotes: () => Array.from(new Set(parts.flatMap((part) => part.model.getUnsupportedNotes()))),
      serialize() {
        const replacements = new Map();
        let newNumberingPart = false;
        const media = new Map();
        for (const part of parts) {
          if (part.key !== 'body' && !touchedParts.has(part.key)) continue;
          const value = part.model.serialize();
          const xml = part.wrapped
            ? unwrapPartXml(value['word/document.xml'], part.wrapped, Parser, Serializer)
            : value['word/document.xml'];
          replacements.set(part.path, xml);
          if (part.key === 'body' && value['word/numbering.xml']) replacements.set('word/numbering.xml', value['word/numbering.xml']);
          if (value['word/_rels/document.xml.rels']) replacements.set(part.relsPath || 'word/_rels/document.xml.rels', value['word/_rels/document.xml.rels']);
          for (const [name, item] of value.media || []) media.set(name, item);
          newNumberingPart ||= part.key === 'body' && value.newNumberingPart === true;
        }
        return { replacements, media, newNumberingPart };
      },
    };
  }

  return { createCompositeDocxModel, discoverRelatedParts };
});
