const fs = require('fs');

const {
  MAX_IMAGE_SIZE_BYTES,
} = require('../attachment-service');

function resolveManagedImageAssetPath(service, assetPath) {
  const store = service.attachmentAssetStore;
  if (!store || typeof store.resolveManagedAssetRealPath !== 'function') {
    throw new Error('Image attachments must come from the app-managed local asset store.');
  }
  const managedAssetPath = store.resolveManagedAssetRealPath(assetPath, { kind: 'image' });
  if (!managedAssetPath) {
    throw new Error('Image attachments must come from the app-managed local asset store.');
  }
  if (
    typeof store.isManagedAssetPath === 'function'
    && !store.isManagedAssetPath(assetPath)
  ) {
    throw new Error('Image attachments must come from the app-managed local asset store.');
  }
  return managedAssetPath;
}

function validateImageAttachmentsForManagedSend(service, attachments) {
  for (const entry of attachments) {
    const assetPath = String(entry?.assetPath || '').trim();
    if (!assetPath) {
      throw new Error('Image attachments require a local asset path.');
    }
    const managedAssetPath = resolveManagedImageAssetPath(service, assetPath);
    let stats;
    try {
      stats = fs.statSync(managedAssetPath);
    } catch (error) {
      throw new Error(`Image attachment is unavailable: ${assetPath}`, {
        cause: error,
      });
    }
    if (!stats.isFile()) {
      throw new Error(`Image attachment must reference a file: ${assetPath}`);
    }
    if (stats.size > MAX_IMAGE_SIZE_BYTES) {
      throw new Error('Image attachment exceeds the 10 MB limit.');
    }
    if (managedAssetPath !== assetPath) {
      entry.assetPath = managedAssetPath;
    }
  }
}

module.exports = {
  validateImageAttachmentsForManagedSend,
};
