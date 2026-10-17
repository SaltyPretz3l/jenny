/* renderer/chat/renderer-session-image-list.js
 * The image viewer's gallery: every viewable image in one chat (attached,
 * generated, tool output) in timeline order, built from the session's messages.
 * The chat timeline is virtualized, so this never reads the DOM.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/artifact-figure'));
    return;
  }
  root.rendererSessionImageList = factory(root.inventoryArtifactFigure);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (figure) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const TOOL_IMAGE_KINDS = new Set(['image', 'chart']);
  const text = (value) => String(value ?? '').trim();

  function listSessionImages(messages, { sessionId, deletedArtifactIds, toFileUrl } = {}) {
    const deleted = new Set(Array.isArray(deletedArtifactIds) ? deletedArtifactIds : []);
    const items = [];
    const seen = new Set();
    const add = (item) => {
      if (seen.has(item.key)) return;
      seen.add(item.key);
      items.push(item);
    };
    for (const message of Array.isArray(messages) ? messages : []) {
      for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
        const id = text(attachment?.id);
        const src = text(attachment?.kind) === 'image' && id ? toFileUrl(attachment.assetPath) : '';
        if (!src) continue;
        add({ kind: 'source', key: `attachment:${id}`, sessionId, src,
          title: text(attachment.displayName) || jt('artifacts.image.attachment', 'Image attachment'),
          ref: { kind: 'attachment', id } });
      }
      const toolResult = message?.kind === 'tool_result' ? message.tool_result : null;
      if (!toolResult) continue;
      for (const artifact of Array.isArray(toolResult.generated_artifacts) ? toolResult.generated_artifacts : []) {
        const artifactId = text(artifact?.artifact_id);
        if (!artifactId || text(artifact.artifact_kind).toLowerCase() !== 'image') continue;
        if ((text(artifact.status).toLowerCase() || 'available') !== 'available' || deleted.has(`${sessionId}::${artifactId}`)) continue;
        const details = figure.generationDetails(toolResult, artifact);
        add({ kind: 'artifact', key: `artifact:${artifactId}`, sessionId, artifactId,
          title: text(artifact.title || artifact.file_name), ...(details ? { details } : {}) });
      }
      for (const ref of Array.isArray(toolResult.trusted_attachment_refs) ? toolResult.trusted_attachment_refs : []) {
        const id = text(ref?.id);
        const src = TOOL_IMAGE_KINDS.has(text(ref?.kind)) && id ? toFileUrl(ref.asset_path) : '';
        if (!src) continue;
        add({ kind: 'source', key: `tool:${id}`, sessionId, src,
          title: jt('chat.toolDetail.pythonOutputImageAlt', 'Python output image'), ref: { kind: 'tool', id } });
      }
    }
    return items;
  }

  return { listSessionImages };
});
