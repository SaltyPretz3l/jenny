/* renderer/features/renderer-ide-docx-package.js - package-level DOCX parts
 * the pane touches outside the document model: [Content_Types].xml and the
 * document relationships a save must extend, word/settings.xml flags, and
 * the object URLs an open document's media render from. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-ide-docx-ooxml'));
    return;
  }
  root.rendererIdeDocxPackage = factory(root.rendererIdeDocxOoxml);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ooxml) {
  'use strict';

  const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
  const RELATIONSHIPS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const NUMBERING_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml';
  const NUMBERING_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering';

  function parseXml(Parser, xml) {
    const documentRef = ooxml.hasDoctype(xml) ? null : new Parser().parseFromString(String(xml || ''), 'application/xml');
    if (ooxml.hasParserError(documentRef)) {
      const error = new Error('Invalid DOCX package XML');
      error.code = 'docx_invalid';
      throw error;
    }
    return documentRef;
  }

  // Word records every edit as a revision while settings.xml turns
  // w:trackRevisions on (a bare element or any value other than false/0/off).
  function tracksRevisions(settingsXml, Parser) {
    if (!settingsXml) return false;
    try {
      const settings = parseXml(Parser, settingsXml);
      return ooxml.enabledValue(settings.getElementsByTagNameNS(ooxml.W_NS, 'trackRevisions')[0]);
    } catch (_error) {
      return false;
    }
  }

  async function patchPackageParts({ zip, zipUtils, replacements, Parser, Serializer, numbering, media }) {
    const contentName = '[Content_Types].xml';
    const relsName = 'word/_rels/document.xml.rels';
    const contentXml = zip.entries.has(contentName)
      ? await zipUtils.readEntryText(zip, contentName)
      : `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${CONTENT_TYPES_NS}"/>`;
    const relsXml = replacements.has(relsName) ? replacements.get(relsName) : zip.entries.has(relsName)
      ? await zipUtils.readEntryText(zip, relsName)
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
    replacements.set(contentName, ooxml.declarationOf(contentXml) + new Serializer().serializeToString(contentDoc).replace(/^<\?xml[^>]*\?>/, ''));
    if (numbering) replacements.set(relsName, ooxml.declarationOf(relsXml) + new Serializer().serializeToString(relsDoc).replace(/^<\?xml[^>]*\?>/, ''));
  }

  // Object URLs for the media one open document renders: created on first
  // use, revoked together when the document closes. Without
  // URL.createObjectURL (jsdom) get() returns null and the model falls back
  // to a data URI.
  function createMediaUrls(windowRef, decodeBase64) {
    const URLRef = windowRef?.URL;
    const supported = typeof URLRef?.createObjectURL === 'function' && typeof windowRef?.Blob === 'function';
    const urls = new Map();
    return {
      get(item) {
        if (!supported || !item) return null;
        if (!urls.has(item)) {
          const blob = new windowRef.Blob([decodeBase64(item.base64, windowRef)], { type: item.mime || '' });
          urls.set(item, URLRef.createObjectURL(blob));
        }
        return urls.get(item);
      },
      revoke() {
        for (const url of urls.values()) URLRef.revokeObjectURL(url);
        urls.clear();
      },
    };
  }

  return { createMediaUrls, patchPackageParts, tracksRevisions };
});
