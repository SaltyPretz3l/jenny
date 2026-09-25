'use strict';

const path = require('node:path');
const { createRejectedEntry } = require('../attachment-service');
const { readToolResultAttachment } = require('../backend/tool-result-attachments');
const { t } = require('../i18n-main');
const { ensureSessionAttachmentAuthority } = require('../projects/session-attachment-authority');
const IMAGE_DROP_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

function createAttachmentIpcHandlers({ backendService, shellConfigService, dialog, getMainWindow,
  prepareAttachmentEntries, attachmentAssetStore, processRef, isChildPath, log }) {
  function captureImport(scope) {
    const owner = backendService?.projectAuthority ? ensureSessionAttachmentAuthority(backendService) : null;
    return { owner, token: owner?.captureImportScope(scope?.session_id || '') };
  }
  function publishImport(captured, result) {
    const images = (result?.accepted || []).filter(entry => entry.kind === 'image');
    try {
      if (images.length && backendService?.projectAuthority && !captured.owner) {
        throw new Error(t('main.attachments.assetUnavailable', 'attachment asset is unavailable'));
      }
      captured.owner?.registerImportedImages(captured.token, result.accepted);
      return result;
    } catch (error) {
      // Only this operation's freshly imported assets are eligible for cleanup.
      attachmentAssetStore?.deleteAssets(images.map(entry => entry.assetPath));
      throw error;
    }
  }
  return {
    'attachments.pick': async (_, scope = {}) => {
      const captured = captureImport(scope);
      const result = await dialog.showOpenDialog(getMainWindow(), {
        title: t('main.dialog.attachments.title', 'Select attachments'),
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: t('main.dialog.attachments.supportedFiles', 'Supported attachments'),
            extensions: [
              'txt', 'md', 'markdown', 'js', 'cjs', 'mjs', 'ts', 'tsx', 'jsx', 'json', 'css', 'html',
              'htm', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'py', 'rb', 'go', 'rs', 'java', 'kt',
              'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'php', 'sh', 'ps1', 'sql', 'csv', 'log',
              'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp',
            ],
          },
          { name: t('main.dialog.attachments.allFiles', 'All files'), extensions: ['*'] },
        ],
      });
      if (result.canceled) {
        return { accepted: [], rejected: [] };
      }
      return publishImport(captured, prepareAttachmentEntries(result.filePaths, {
        cwd: processRef.cwd(),
        assetStore: attachmentAssetStore,
      }));
    },
    'attachments.prepare': (_, filePaths, scope = {}) => {
      const captured = captureImport(scope);
      const allowedRoots = [];
      const authorityOwner = backendService?.projectAuthority;
      const sessionId = String(scope?.session_id || '').trim();
      let authority = null;
      if (authorityOwner && sessionId) {
        try { authority = authorityOwner.captureSession(sessionId); } catch {
          // An unavailable filesystem scope denies text reads. Explicit image
          // imports need only session receipt ownership, not a reachable root.
        }
      }
      const workspaceRoot = authorityOwner ? authority?.root_path : shellConfigService.getState().toolsWorkspaceRoot;
      const assertAuthority = authority ? () => {
        const current = authorityOwner.captureSession(sessionId);
        if (current.project_id !== authority.project_id) throw new Error(t('error.project.stale', 'Project access changed. Review the project before trying again.'));
        authorityOwner.requireCurrent(authority);
      } : null;
      if (workspaceRoot) {
        allowedRoots.push(workspaceRoot);
      }
      const safePaths = [];
      const rejectedOutsideRoots = [];
      for (const filePath of Array.isArray(filePaths) ? filePaths : []) {
        if (
          IMAGE_DROP_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase())
          || allowedRoots.some((root) => isChildPath(root, filePath))
        ) {
          safePaths.push(filePath);
          continue;
        }
        // Filtered paths must still produce a rejected entry: dropping them
        // silently makes the whole drag-drop surface look like a no-op.
        rejectedOutsideRoots.push(createRejectedEntry(
          filePath,
          authorityOwner
            ? workspaceRoot
              ? t('main.attachments.outsideProject', 'File is outside this session’s project folder, so it cannot be attached.')
              : t('main.attachments.projectRootRequired', 'Bind a project folder before attaching dropped text files.')
            : workspaceRoot
            ? 'File is outside the tools workspace root, so it cannot be attached.'
            : 'Set a tools workspace root in Settings before attaching dropped files.'
        ));
      }
      const prepared = prepareAttachmentEntries(safePaths, {
        cwd: workspaceRoot || processRef.cwd(),
        assetStore: attachmentAssetStore,
        ...(authorityOwner ? { textRoot: workspaceRoot || null, assertAuthority } : {}),
      });
      return publishImport(captured, {
        ...prepared,
        rejected: [...rejectedOutsideRoots, ...(prepared.rejected || [])],
      });
    },
    'attachments.saveImageAsset': (_, payload, scope = {}) => {
      const captured = captureImport(scope);
      const byteLength = payload?.bytes?.byteLength ?? payload?.bytes?.length ?? null;
      const bytesKind = payload?.bytes == null ? 'missing' : (Buffer.isBuffer(payload.bytes) ? 'buffer' : (ArrayBuffer.isView(payload.bytes) ? 'view' : (payload.bytes instanceof ArrayBuffer ? 'arraybuffer' : (Array.isArray(payload.bytes) ? 'array' : typeof payload.bytes))));
      if (!attachmentAssetStore) {
        if (typeof log === 'function') { log('WARN', 'attachments.save_image_asset', { ok: false, reason: 'store_unavailable', bytesKind, byteLength, mimeType: payload?.mimeType || '', sourceKind: payload?.sourceKind || '' }); }
        throw new Error('Image attachments are unavailable.');
      }
      try {
        const result = attachmentAssetStore.saveImageBuffer(payload?.bytes, {
          mimeType: payload?.mimeType, displayName: payload?.displayName,
          sourceKind: payload?.sourceKind, captureMeta: payload?.captureMeta,
        });
        publishImport(captured, { accepted: [result], rejected: [] });
        if (typeof log === 'function') { log('INFO', 'attachments.save_image_asset', { ok: true, bytesKind, byteLength, mimeType: payload?.mimeType || '', sourceKind: payload?.sourceKind || '', id: result?.id || '' }); }
        return result;
      } catch (error) {
        if (typeof log === 'function') { log('WARN', 'attachments.save_image_asset', { ok: false, bytesKind, byteLength, mimeType: payload?.mimeType || '', sourceKind: payload?.sourceKind || '', message: error?.message || String(error) }); }
        throw error;
      }
    },
    'attachments.saveAudioAsset': (_, payload) => {
      if (!attachmentAssetStore) {
        throw new Error('Audio attachments are unavailable.');
      }
      return attachmentAssetStore.saveAudioBuffer(payload?.bytes, {
        mimeType: payload?.mimeType,
        displayName: payload?.displayName,
        sourceKind: payload?.sourceKind,
        durationMs: payload?.durationMs,
        transcriptText: payload?.transcriptText,
        transcriptStatus: payload?.transcriptStatus,
        transcriptLanguage: payload?.transcriptLanguage,
      });
    },
    'attachments.releaseAssets': (_, assetPaths) => {
      if (!attachmentAssetStore) {
        return { deletedCount: 0, deletedPaths: [] };
      }
      const result = attachmentAssetStore.deleteAssets(assetPaths);
      backendService?.sessionAttachmentAuthority?.revokeAssetPaths(result.deletedPaths || []);
      return result;
    },
    // Bounded ID-based read of a tool-result attachment previously
    // ingested into the managed asset store from a live sidecar tool.result.
    'attachments.readToolResultAsset': (_, payload) => {
      if (!backendService) {
      return { ok: false, reason: t('main.backend.serviceUnavailable', 'backend service unavailable') };
      }
      return readToolResultAttachment(backendService, payload?.attachment_id || payload,
        { sessionId: payload?.session_id || '' });
    },
  };
}

module.exports = { createAttachmentIpcHandlers };
