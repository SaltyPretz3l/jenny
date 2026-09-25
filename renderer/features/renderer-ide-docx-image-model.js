/* renderer/features/renderer-ide-docx-image-model.js - bounded OOXML image
 * insertion and resizing operations used by the preservation-first model. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeDocxImageModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
  const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
  const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

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

    function insertionBoundary(paragraph, offset) {
      const positions = context.runPositions(paragraph);
      const inside = positions.find((item) => item.start < offset && offset < item.end);
      const previous = [...positions].reverse().find((item) => item.end <= offset && item.text.length);
      const next = positions.find((item) => item.start >= offset && item.text.length);
      if (inside) {
        const right = context.splitRun(inside.run, offset - inside.start);
        return { parent: right.parentNode, reference: right };
      }
      if (previous) return context.boundaryAfter(previous.run, paragraph);
      if (next) return context.boundaryBefore(next.run, paragraph);
      return { parent: paragraph, reference: null };
    }

    function insertImage(blockId, offset, image) {
      const paragraph = context.paragraphFor(blockId);
      const mime = String(image?.mime || '').toLowerCase();
      const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' }[mime];
      const base64 = String(image?.base64 || '');
      const width = Math.max(24, Math.min(1200, Math.round(Number(image?.widthPx) || 320)));
      const height = Math.max(24, Math.min(1200, Math.round(Number(image?.heightPx) || 180)));
      if (!paragraph || !context.validRange(paragraph, offset) || !extension || !base64) return false;
      context.recordMutation();
      context.ensureRelationships();
      const documentDoc = context.getDocumentDoc();
      const relationshipId = nextRelationshipId();
      const mediaName = nextMediaName(extension);
      const relationship = context.getRelsDoc().createElementNS(REL_NS, 'Relationship');
      relationship.setAttribute('Id', relationshipId); relationship.setAttribute('Type', `${R_NS}/image`);
      relationship.setAttribute('Target', mediaName.slice('word/'.length));
      context.getRelsDoc().documentElement.appendChild(relationship);
      context.getMedia().set(mediaName, { mime, base64 });
      const drawingId = nextDrawingId();
      const run = documentDoc.createElementNS(W_NS, 'w:r');
      const drawing = documentDoc.createElementNS(W_NS, 'w:drawing');
      const inline = makeNs(documentDoc, WP_NS, 'wp', 'inline');
      const extent = makeNs(documentDoc, WP_NS, 'wp', 'extent');
      extent.setAttribute('cx', String(width * 9525)); extent.setAttribute('cy', String(height * 9525));
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
      innerExtent.setAttribute('cx', String(width * 9525)); innerExtent.setAttribute('cy', String(height * 9525));
      xfrm.append(off, innerExtent);
      const geometry = makeNs(documentDoc, A_NS, 'a', 'prstGeom');
      geometry.setAttribute('prst', 'rect'); geometry.appendChild(makeNs(documentDoc, A_NS, 'a', 'avLst'));
      spPr.append(xfrm, geometry); picture.append(nvPicPr, blipFill, spPr);
      graphicData.appendChild(picture); graphic.appendChild(graphicData);
      inline.append(extent, docPr, graphic); drawing.appendChild(inline); run.appendChild(drawing);
      const boundary = insertionBoundary(paragraph, offset);
      boundary.parent.insertBefore(run, boundary.reference);
      return true;
    }

    function resizeImage(blockId, offset, widthPx, heightPx) {
      const paragraph = context.paragraphFor(blockId);
      const item = paragraph && context.runPositions(paragraph)
        .find((entry) => entry.start === offset && context.directChild(entry.run, 'drawing'));
      const width = Math.max(24, Math.min(1200, Math.round(Number(widthPx) || 0)));
      const height = Math.max(24, Math.min(1200, Math.round(Number(heightPx) || 0)));
      if (!item || !width || !height) return false;
      context.recordMutation();
      const drawing = context.directChild(item.run, 'drawing');
      const extent = drawing.getElementsByTagNameNS(WP_NS, 'extent')[0];
      const innerExtent = drawing.getElementsByTagNameNS(A_NS, 'ext')[0];
      extent?.setAttribute('cx', String(width * 9525)); extent?.setAttribute('cy', String(height * 9525));
      innerExtent?.setAttribute('cx', String(width * 9525)); innerExtent?.setAttribute('cy', String(height * 9525));
      return true;
    }

    return { insertImage, resizeImage };
  }

  return { createImageOperations };
});
