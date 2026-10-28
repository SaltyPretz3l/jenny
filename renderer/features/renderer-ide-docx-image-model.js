/* renderer/features/renderer-ide-docx-image-model.js - bounded OOXML image
 * insertion and resizing operations used by the preservation-first model. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-ide-docx-ooxml'));
    return;
  }
  root.rendererIdeDocxImageModel = factory(root.rendererIdeDocxOoxml);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ooxml) {
  'use strict';

  const { W_NS, R_NS, WP_NS, A_NS, REL_NS, elementChildren, isW, payloadLength, runPositions } = ooxml;
  const PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
  const INSERTED_MEDIA_BUDGET = 64 * 1024 * 1024;
  const EMU_PER_PX = 9525;
  // The one image-type table: MIME -> part extension (picker accept list, the
  // host's allow-list and the extension -> MIME lookup all derive from it).
  const IMAGE_TYPES = Object.freeze({
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp',
  });

  function clampImagePx(value, fallback = 0) {
    return Math.max(24, Math.min(1200, Math.round(Number(value) || fallback)));
  }

  function setExtent(element, width, height) {
    element?.setAttribute('cx', String(width * EMU_PER_PX));
    element?.setAttribute('cy', String(height * EMU_PER_PX));
  }

  function mediaTarget(relationship) {
    if (relationship.getAttribute('TargetMode') === 'External') return '';
    const target = relationship.getAttribute('Target') || '';
    const segments = (target.startsWith('/') ? target.slice(1) : `word/${target}`).split('/');
    const parts = [];
    for (const segment of segments) {
      if (segment === '..') parts.pop();
      else if (segment && segment !== '.') parts.push(segment);
    }
    return parts.join('/');
  }

  // Media payloads have one owner. Snapshots retain only the names they can
  // restore; the document-wide budget counts payloads a new edit would keep.
  function createMediaRetention(media, resources) {
    const inserted = new Set();
    const fingerprints = new WeakMap();
    const stores = resources.mediaStores;

    function referenced(documentDoc, relsDoc, removeUnused = false) {
      if (!inserted.size && !removeUnused) return new Set();
      const ids = new Set();
      for (const element of documentDoc.getElementsByTagName('*')) {
        for (const attribute of element.attributes) {
          if (attribute.namespaceURI === R_NS) ids.add(attribute.value);
        }
      }
      const names = new Set();
      for (const relationship of Array.from(relsDoc?.getElementsByTagNameNS('*', 'Relationship') || [])) {
        const name = mediaTarget(relationship);
        if (ids.has(relationship.getAttribute('Id'))) names.add(name);
        else if (removeUnused && inserted.has(name)) relationship.remove();
      }
      return names;
    }

    function prune(documentDoc, relsDoc, snapshots) {
      if (!inserted.size) return;
      const reachable = referenced(documentDoc, relsDoc, true);
      for (const state of snapshots) {
        for (const name of state.mediaNames) reachable.add(name);
      }
      for (const name of inserted) {
        if (!reachable.has(name)) {
          media.delete(name);
          inserted.delete(name);
        }
      }
    }

    // Payloads a new edit keeps: current content plus undo. A new edit clears
    // redo, so redo-only payloads do not count against the insert budget.
    function insertedLength(documentDoc, relsDoc, snapshots) {
      const reachable = referenced(documentDoc, relsDoc);
      for (const state of snapshots) {
        for (const name of state.mediaNames) reachable.add(name);
      }
      let length = 0;
      for (const name of inserted) if (reachable.has(name)) length += media.get(name).base64.length;
      return length;
    }

    function identity(value) {
      let cached = fingerprints.get(value);
      if (!cached || cached.base64 !== value.base64 || cached.mime !== value.mime) {
        const base64 = String(value.base64 || '');
        let hash = 2166136261;
        for (let index = 0; index < base64.length; index += 1) {
          hash = Math.imul(hash ^ base64.charCodeAt(index), 16777619) >>> 0;
        }
        cached = { base64: value.base64, mime: value.mime, key: `${value.mime}:${base64.length}:${hash}` };
        fingerprints.set(value, cached);
      }
      return cached.key;
    }

    function identities(documentDoc, relsDoc) {
      const reachable = referenced(documentDoc, relsDoc);
      return new Map(Array.from(media).filter(([name]) => !inserted.has(name) || reachable.has(name))
        .map(([name, value]) => [name, identity(value)]));
    }

    function matches(saved, documentDoc, relsDoc) {
      const current = identities(documentDoc, relsDoc);
      return current.size === saved.size && Array.from(current).every(([name, key]) => saved.get(name) === key);
    }

    function exported(documentDoc, relsDoc) {
      const reachable = referenced(documentDoc, relsDoc);
      return new Map(Array.from(media).filter(([name]) => inserted.has(name) && reachable.has(name)));
    }

    const store = {
      referenced, prune, identities, matches, exported, insertedLength,
      add(name, value) { inserted.add(name); media.set(name, value); },
      canInsert(length) {
        for (const item of stores) item.reclaim();
        return stores.reduce((total, item) => total + item.keptLength(), length) <= INSERTED_MEDIA_BUDGET;
      },
    };
    stores.push(store);
    return store;
  }

  function makeNs(doc, namespace, prefix, name) {
    return doc.createElementNS(namespace, `${prefix}:${name}`);
  }

  function createImageOperations(context) {
    function nextRelationshipId() {
      context.ensureRelationships();
      const used = new Set(Array.from(context.getRelsDoc().getElementsByTagNameNS('*', 'Relationship'))
        .map((item) => item.getAttribute('Id')));
      let ordinal = 1;
      while (used.has('rId' + ordinal)) ordinal += 1;
      return 'rId' + ordinal;
    }

    function nextMediaName(extension) {
      const media = context.getMedia();
      const prefix = String(context.mediaPrefix || 'body').replace(/[^a-z0-9_-]/gi, '-');
      let ordinal = 1;
      let name = `word/media/jenny-${prefix}-image-${ordinal}.${extension}`;
      while (media.has(name) || context.occupiedNames?.has(name)) {
        ordinal += 1;
        name = `word/media/jenny-${prefix}-image-${ordinal}.${extension}`;
      }
      return name;
    }

    function nextDrawingId() {
      const ids = Array.from(context.getDocumentDoc().getElementsByTagNameNS(WP_NS, 'docPr'))
        .map((item) => Number.parseInt(item.getAttribute('id'), 10)).filter(Number.isFinite);
      return String((ids.length ? Math.max(...ids) : 0) + 1);
    }

    function insertImage(blockId, offset, image) {
      const paragraph = context.paragraphFor(blockId);
      const mime = String(image?.mime || '').toLowerCase();
      const extension = IMAGE_TYPES[mime];
      const base64 = String(image?.base64 || '');
      const width = clampImagePx(image?.widthPx, 320);
      const height = clampImagePx(image?.heightPx, 180);
      if (!paragraph || !context.validRange(paragraph, offset) || !extension || !base64) return false;
      if (!context.mediaRetention.canInsert(base64.length)) return false;
      context.recordMutation();
      context.ensureRelationships();
      const documentDoc = context.getDocumentDoc();
      const relationshipId = nextRelationshipId();
      const mediaName = nextMediaName(extension);
      const relationship = context.getRelsDoc().createElementNS(REL_NS, 'Relationship');
      relationship.setAttribute('Id', relationshipId); relationship.setAttribute('Type', `${R_NS}/image`);
      relationship.setAttribute('Target', mediaName.slice('word/'.length));
      context.getRelsDoc().documentElement.appendChild(relationship);
      context.mediaRetention.add(mediaName, { mime, base64 });
      const drawingId = nextDrawingId();
      const run = documentDoc.createElementNS(W_NS, 'w:r');
      const drawing = documentDoc.createElementNS(W_NS, 'w:drawing');
      const inline = makeNs(documentDoc, WP_NS, 'wp', 'inline');
      const extent = makeNs(documentDoc, WP_NS, 'wp', 'extent');
      setExtent(extent, width, height);
      const docPr = makeNs(documentDoc, WP_NS, 'wp', 'docPr');
      docPr.setAttribute('id', drawingId); docPr.setAttribute('name', String(image?.name || `Picture ${drawingId}`).slice(0, 255));
      const graphic = makeNs(documentDoc, A_NS, 'a', 'graphic');
      const graphicData = makeNs(documentDoc, A_NS, 'a', 'graphicData');
      graphicData.setAttribute('uri', PIC_NS);
      const picture = makeNs(documentDoc, PIC_NS, 'pic', 'pic');
      const nvPicPr = makeNs(documentDoc, PIC_NS, 'pic', 'nvPicPr');
      const cNvPr = makeNs(documentDoc, PIC_NS, 'pic', 'cNvPr');
      cNvPr.setAttribute('id', drawingId); cNvPr.setAttribute('name', String(image?.name || mediaName.split('/').at(-1)).slice(0, 255));
      nvPicPr.append(cNvPr, makeNs(documentDoc, PIC_NS, 'pic', 'cNvPicPr'));
      const blipFill = makeNs(documentDoc, PIC_NS, 'pic', 'blipFill');
      const blip = makeNs(documentDoc, A_NS, 'a', 'blip');
      blip.setAttributeNS(R_NS, 'r:embed', relationshipId);
      const stretch = makeNs(documentDoc, A_NS, 'a', 'stretch');
      stretch.appendChild(makeNs(documentDoc, A_NS, 'a', 'fillRect')); blipFill.append(blip, stretch);
      const spPr = makeNs(documentDoc, PIC_NS, 'pic', 'spPr');
      const xfrm = makeNs(documentDoc, A_NS, 'a', 'xfrm');
      const off = makeNs(documentDoc, A_NS, 'a', 'off'); off.setAttribute('x', '0'); off.setAttribute('y', '0');
      const innerExtent = makeNs(documentDoc, A_NS, 'a', 'ext');
      setExtent(innerExtent, width, height);
      xfrm.append(off, innerExtent);
      const geometry = makeNs(documentDoc, A_NS, 'a', 'prstGeom');
      geometry.setAttribute('prst', 'rect'); geometry.appendChild(makeNs(documentDoc, A_NS, 'a', 'avLst'));
      spPr.append(xfrm, geometry); picture.append(nvPicPr, blipFill, spPr);
      graphicData.appendChild(picture); graphic.appendChild(graphicData);
      inline.append(extent, docPr, graphic); drawing.appendChild(inline); run.appendChild(drawing);
      const boundary = context.insertionBoundary(paragraph, offset);
      boundary.parent.insertBefore(run, boundary.reference);
      return true;
    }

    // The drawing at a paragraph offset, also when its run holds text or
    // other drawings before it (`add_run('Caption ').add_picture(...)`).
    function drawingAt(paragraph, offset) {
      const item = paragraph && runPositions(paragraph).find((entry) => entry.start <= offset && offset < entry.end);
      let position = item?.start;
      for (const child of item ? elementChildren(item.run) : []) {
        if (position === offset && isW(child, 'drawing')) return child;
        position += payloadLength(child);
        if (position > offset) break;
      }
      return null;
    }

    function resizeImage(blockId, offset, widthPx, heightPx) {
      const drawing = drawingAt(context.paragraphFor(blockId), offset);
      const width = clampImagePx(widthPx);
      const height = clampImagePx(heightPx);
      if (!drawing) return false;
      context.recordMutation();
      setExtent(drawing.getElementsByTagNameNS(WP_NS, 'extent')[0], width, height);
      // The shape size is a:xfrm/a:ext; an a:blip or a:graphicData extension
      // list also holds a:ext elements, which must never gain cx/cy.
      const transform = drawing.getElementsByTagNameNS(A_NS, 'xfrm')[0];
      setExtent(Array.from(transform?.childNodes || []).find((child) => child.namespaceURI === A_NS && child.localName === 'ext'), width, height);
      return true;
    }

    return { insertImage, resizeImage };
  }

  return { createImageOperations, createMediaRetention, mediaTarget, IMAGE_TYPES };
});
