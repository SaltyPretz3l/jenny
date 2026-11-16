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
  const IMAGE_TYPES = { png: 'PNG', jpg: 'JPEG', jpeg: 'JPEG', webp: 'WebP', gif: 'GIF', bmp: 'BMP' };
  const MIME_TYPES = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/jpg': 'JPEG', 'image/webp': 'WebP', 'image/gif': 'GIF', 'image/bmp': 'BMP' };

  /* The message's time as the origin line shows it: the clock time on the same calendar day as now,
   * the short date and time on any other day; '' when the message carries no usable time. */
  function messageTime(message, now) {
    const raw = message?.timestamp ?? message?.createdAt ?? message?.created_at;
    const date = raw === undefined || raw === null || raw === '' ? null : new Date(raw);
    if (!date || Number.isNaN(date.getTime())) return '';
    const sameDay = date.toDateString() === now.toDateString();
    const tag = globalThis.jennyI18n?.tag?.();
    const clock = globalThis.jennyI18n?.timeOptions?.() || {};
    return sameDay ? date.toLocaleTimeString(tag, { hour: 'numeric', minute: '2-digit', ...clock })
      : date.toLocaleString(tag, { ...clock, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  // Literal keys, one call each, so the string ledger can see them.
  const ORIGINS = {
    attachedByYou: (time) => (time ? jt('imageViewer.originAttachedByYou', 'Attached by you · {time}', { time }) : jt('imageViewer.originAttachedByYouNoTime', 'Attached by you')),
    attached: (time) => (time ? jt('imageViewer.originAttached', 'Attached · {time}', { time }) : jt('imageViewer.originAttachedNoTime', 'Attached')),
    generated: (time) => (time ? jt('imageViewer.originGenerated', 'Generated · {time}', { time }) : jt('imageViewer.originGeneratedNoTime', 'Generated')),
    python: (time) => (time ? jt('imageViewer.originPython', 'From Python · {time}', { time }) : jt('imageViewer.originPythonNoTime', 'From Python')),
    tool: (time) => (time ? jt('imageViewer.originTool', 'From a tool · {time}', { time }) : jt('imageViewer.originToolNoTime', 'From a tool')),
  };
  const origin = (name, time) => ORIGINS[name](time);

  const baseName = (path) => text(path).split(/[\\/]/).pop();
  /* Type, byte size and file name of an attached or tool image, present values only. */
  function sourceDetails(record, fileName, assetPath) {
    const extension = baseName(assetPath).split('.').slice(1).pop()?.toLowerCase();
    const type = MIME_TYPES[text(record?.mimeType ?? record?.mime_type).toLowerCase()] || IMAGE_TYPES[extension] || '';
    const bytes = Number(record?.sizeBytes ?? record?.size_bytes);
    const details = { ...(type ? { type } : {}), ...(Number.isFinite(bytes) && bytes > 0 ? { bytes } : {}), ...(fileName ? { fileName } : {}) };
    return Object.keys(details).length ? { details } : {};
  }

  function listSessionImages(messages, { sessionId, deletedArtifactIds, toFileUrl, now } = {}) {
    const deleted = new Set(Array.isArray(deletedArtifactIds) ? deletedArtifactIds : []);
    const items = [];
    const seen = new Set();
    const today = now instanceof Date ? now : new Date();
    const add = (item) => {
      if (seen.has(item.key)) return;
      seen.add(item.key);
      items.push(item);
    };
    for (const message of Array.isArray(messages) ? messages : []) {
      const time = messageTime(message, today);
      const where = message?.id === undefined || message?.id === null || message?.id === '' ? {} : { messageId: String(message.id) };
      for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
        const id = text(attachment?.id);
        const src = text(attachment?.kind) === 'image' && id ? toFileUrl(attachment.assetPath) : '';
        if (!src) continue;
        add({ kind: 'source', key: `attachment:${id}`, sessionId, src,
          title: text(attachment.displayName) || jt('artifacts.image.attachment', 'Image attachment'),
          ref: { kind: 'attachment', id }, ...where, origin: origin(message.role === 'user' ? 'attachedByYou' : 'attached', time),
          ...sourceDetails(attachment, text(attachment.displayName), attachment.assetPath) });
      }
      const toolResult = message?.kind === 'tool_result' ? message.tool_result : null;
      if (!toolResult) continue;
      for (const artifact of Array.isArray(toolResult.generated_artifacts) ? toolResult.generated_artifacts : []) {
        const artifactId = text(artifact?.artifact_id);
        if (!artifactId || text(artifact.artifact_kind).toLowerCase() !== 'image') continue;
        if ((text(artifact.status).toLowerCase() || 'available') !== 'available' || deleted.has(`${sessionId}::${artifactId}`)) continue;
        const details = figure.generationDetails(toolResult, artifact);
        add({ kind: 'artifact', key: `artifact:${artifactId}`, sessionId, artifactId,
          title: text(artifact.title || artifact.file_name), ...where, origin: origin('generated', time), ...(details ? { details } : {}) });
      }
      for (const ref of Array.isArray(toolResult.trusted_attachment_refs) ? toolResult.trusted_attachment_refs : []) {
        const id = text(ref?.id);
        const src = TOOL_IMAGE_KINDS.has(text(ref?.kind)) && id ? toFileUrl(ref.asset_path) : '';
        if (!src) continue;
        add({ kind: 'source', key: `tool:${id}`, sessionId, src,
          title: jt('chat.toolDetail.pythonOutputImageAlt', 'Python output image'), ref: { kind: 'tool', id }, ...where,
          origin: origin(text(toolResult.tool_name).toLowerCase().includes('python') ? 'python' : 'tool', time),
          ...sourceDetails(ref, baseName(ref.asset_path), ref.asset_path) });
      }
    }
    return items;
  }

  return { listSessionImages };
});
