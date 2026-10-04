'use strict';

const path = require('node:path');
const { t } = require('./i18n-main');

function createArtifactFileActions({
  artifactService, dialog, getMainWindow, clipboard, nativeImage, fs = require('node:fs'),
}) {
  async function saveAs(sessionId, artifactId) {
    const artifact = await artifactService.resolveArtifact(sessionId, artifactId);
    if (artifact.status !== 'available') return { ok: false, reason: 'artifact_unavailable' };

    const options = { defaultPath: artifact.file_name };
    const extension = path.extname(artifact.file_name).slice(1);
    if (artifact.mime_type === 'image/png') {
      options.filters = [{ name: t('main.artifacts.pngImage', 'PNG image'), extensions: ['png'] }];
    } else if (extension) {
      options.filters = [{ name: t('main.artifacts.file', 'File'), extensions: [extension] }];
    }
    const win = getMainWindow?.();
    const result = win && typeof win.isDestroyed === 'function' && !win.isDestroyed()
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    try {
      await fs.promises.copyFile(artifact.absolute_path, result.filePath);
    } catch (_error) {
      // Node's copy error names both absolute paths; keep them out of the renderer.
      return { ok: false, reason: 'copy_failed' };
    }
    return { ok: true };
  }

  async function copyImage(sessionId, artifactId) {
    const artifact = await artifactService.resolveArtifact(sessionId, artifactId);
    if (artifact.status !== 'available') return { ok: false, reason: 'artifact_unavailable' };
    if (artifact.artifact_kind !== 'image') return { ok: false, reason: 'not_an_image' };

    const image = nativeImage.createFromPath(artifact.absolute_path);
    if (image.isEmpty()) return { ok: false, reason: 'image_unreadable' };
    clipboard.writeImage(image);
    return { ok: true };
  }

  return { saveAs, copyImage };
}

module.exports = { createArtifactFileActions };
