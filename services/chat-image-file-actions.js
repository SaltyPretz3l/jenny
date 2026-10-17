'use strict';

// Copy / Save as / Show in folder for chat images that are not artifacts:
// user-attached images (message.attachments[]) and tool-output images
// (tool_result.trusted_attachment_refs[]). The renderer names an image by
// session + { kind, id } only; the path is resolved here from the persisted
// session through the managed asset store and never leaves the main process.

const path = require('node:path');
const { t } = require('./i18n-main');
const { MIME_TO_IMAGE_EXTENSION } = require('./attachment-asset-store');
const { resolveToolResultAttachmentPath } = require('./backend/tool-result-attachments');

const REF_KINDS = new Set(['attachment', 'tool']);
const INVALID = Object.freeze({ ok: false, reason: 'invalid_request' });
const UNAVAILABLE = Object.freeze({ ok: false, reason: 'image_unavailable' });

function boundedString(value, maxChars) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= maxChars;
}

function validRequest(sessionId, ref) {
  return boundedString(sessionId, 128) && ref && typeof ref === 'object'
    && REF_KINDS.has(ref.kind) && boundedString(ref.id, 256);
}

function sessionMessages(service, sessionId) {
  const store = service?.sessionStore;
  try {
    const messages = typeof store?.peekSessionMessages === 'function'
      ? store.peekSessionMessages(sessionId)
      : typeof store?.getSessionMessages === 'function'
        ? store.getSessionMessages(sessionId)
        : [];
    return Array.isArray(messages) ? messages : [];
  } catch (_error) {
    return [];
  }
}

function resolveAttachmentImage(service, sessionId, id) {
  for (const message of sessionMessages(service, sessionId)) {
    const entry = (Array.isArray(message?.attachments) ? message.attachments : [])
      .find((candidate) => String(candidate?.id || '').trim() === id);
    if (!entry) continue;
    const mimeType = String(entry.mimeType || entry.mime_type || '').trim().toLowerCase();
    if (String(entry.kind || '').trim().toLowerCase() !== 'image' && !mimeType.startsWith('image/')) return null;
    const store = service?.attachmentAssetStore;
    const managedPath = typeof store?.resolveManagedAssetRealPath === 'function'
      ? store.resolveManagedAssetRealPath(String(entry.assetPath || entry.asset_path || '').trim(), { kind: 'image' })
      : '';
    return managedPath
      ? { path: managedPath, mimeType, displayName: String(entry.displayName || entry.display_name || '').trim() }
      : null;
  }
  return null;
}

function resolveImage(service, sessionId, ref) {
  const id = ref.id.trim();
  if (ref.kind === 'attachment') return resolveAttachmentImage(service, sessionId.trim(), id);
  const resolved = resolveToolResultAttachmentPath(service, sessionId, id);
  return resolved.ok ? { path: resolved.path, mimeType: String(resolved.mimeType || '').toLowerCase(), displayName: '' } : null;
}

// Basename only, with Windows-reserved and control characters replaced.
function sanitizeFileName(value) {
  // eslint-disable-next-line no-control-regex -- control characters are not valid in file names.
  return path.basename(String(value || '').replaceAll('\\', '/')).replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, '_')
    .trim().slice(0, 200);
}

function createChatImageFileActions({
  service, dialog, getMainWindow, clipboard, nativeImage,
  shell, fs = require('node:fs'),
}) {
  async function withImage(sessionId, ref, action) {
    if (!validRequest(sessionId, ref)) return INVALID;
    const image = resolveImage(service, sessionId, ref);
    return image ? action(image) : UNAVAILABLE;
  }

  const copyImage = (sessionId, ref) => withImage(sessionId, ref, (image) => {
    const native = nativeImage.createFromPath(image.path);
    if (native.isEmpty()) return { ok: false, reason: 'image_unreadable' };
    clipboard.writeImage(native);
    return { ok: true };
  });

  const saveAs = (sessionId, ref) => withImage(sessionId, ref, async (image) => {
    const extension = (MIME_TO_IMAGE_EXTENSION.get(image.mimeType) || path.extname(image.path).toLowerCase() || '.png')
      .slice(1);
    let fileName = sanitizeFileName(image.displayName);
    if (fileName && !path.extname(fileName)) fileName = `${fileName}.${extension}`;
    const options = {
      defaultPath: fileName || `image-${sanitizeFileName(ref.id.trim())}.${extension}`,
      filters: [extension === 'png'
        ? { name: t('main.artifacts.pngImage', 'PNG image'), extensions: ['png'] }
        : { name: t('main.artifacts.file', 'File'), extensions: [extension] }],
    };
    const win = getMainWindow?.();
    const result = win && typeof win.isDestroyed === 'function' && !win.isDestroyed()
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    // The dialog can stay open a long time: re-check containment right before the copy.
    if (resolveImage(service, sessionId, ref)?.path !== image.path) return UNAVAILABLE;
    try {
      await fs.promises.copyFile(image.path, result.filePath);
    } catch (_error) {
      // Node's copy error names both absolute paths; keep them out of the renderer.
      return { ok: false, reason: 'copy_failed' };
    }
    return { ok: true };
  });

  const reveal = (sessionId, ref) => withImage(sessionId, ref, (image) => {
    shell.showItemInFolder(image.path);
    return { ok: true };
  });

  return { copyImage, saveAs, reveal };
}

module.exports = { createChatImageFileActions };
