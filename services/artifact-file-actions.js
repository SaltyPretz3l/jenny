'use strict';

const path = require('node:path');
const { t } = require('./i18n-main');
const { createArtifactOpenWith } = require('./artifact-open-with');

const { RASTER_IMAGE_MIMES: RASTER_EXTENSIONS } = require('./artifact-workspace-service');

function createArtifactFileActions({
  artifactService, dialog, getMainWindow, clipboard, nativeImage, fs = require('node:fs'),
  openWithAdapter = createArtifactOpenWith(),
}) {
  const app = require('electron').app;
  const dispose = () => openWithAdapter.dispose?.();
  app?.once?.('before-quit', dispose);
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
    // The dialog can stay open a long time: re-check the managed path right before the copy.
    let current;
    try { current = await artifactService.resolveArtifact(sessionId, artifactId); } catch (_error) { current = null; }
    if (current?.status !== 'available' || current.absolute_path !== artifact.absolute_path) {
      return { ok: false, reason: 'artifact_unavailable' };
    }

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

  function capabilities() { return openWithAdapter.capabilities(); }

  async function openWith(sessionId, artifactId) {
    if (!(await capabilities()).openWith) return { ok: false, reason: 'unsupported' };
    // This service seam validates session authority and realpath containment,
    // including scratch-directory junctions. Renderer paths are never accepted.
    const artifact = await artifactService.resolveArtifact(sessionId, artifactId);
    if (artifact.status !== 'available') return { ok: false, reason: 'artifact_unavailable' };
    const actualExtension = path.extname(artifact.absolute_path || '').toLowerCase();
    if (artifact.artifact_kind !== 'image' || RASTER_EXTENSIONS.get(actualExtension) !== artifact.mime_type) {
      return { ok: false, reason: 'not_an_image' };
    }
    const win = getMainWindow?.();
    const handle = win && !win.isDestroyed?.() ? win.getNativeWindowHandle?.() : null;
    const parent = handle ? (handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString() : '0';
    try { return await openWithAdapter.openWith(artifact.absolute_path, parent); }
    catch (_error) { return { ok: false, reason: 'open_with_failed' }; }
  }

  return { saveAs, copyImage, capabilities, openWith, dispose: () => { app?.removeListener?.('before-quit', dispose); dispose(); } };
}

module.exports = { createArtifactFileActions };
