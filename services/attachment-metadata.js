// Read-side attachment metadata layer; its collectors define which managed files
// retention and session-delete treat as referenced.

const { createAttachmentId } = require('./attachment-asset-store');

function normalizeSourceKind(value, fallback = 'file') {
  const token = String(value || '').trim().toLowerCase();
  return token || fallback;
}

function normalizeDurationMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.max(Math.trunc(parsed), 0);
}

function normalizeTranscriptStatus(value, fallback = '') {
  const token = String(value || '').trim().toLowerCase();
  if (token === 'complete' || token === 'pending' || token === 'error') {
    return token;
  }
  return fallback;
}

// C4 provenance allowlist (C11): the eight contract keys, bounded — no prompt, no paths.
function normalizeGeneratedProvenance(value, sourceKind = 'image_generation') {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const seed = Number(value.seed);
  const provenance = { seed: Number.isFinite(seed) ? seed : 0 };
  const stringKeys = ['model_id', 'model_revision', 'quant', 'app_version'];
  if (sourceKind === 'plugin_generation') {
    stringKeys.push('publisher_id', 'plugin_id', 'plugin_version',
      'provider_contribution_id', 'operation_id');
  }
  for (const key of stringKeys) {
    provenance[key] = String(value[key] == null ? '' : value[key]).slice(0, 200);
  }
  for (const key of ['width', 'height', 'steps']) {
    provenance[key] = Number(value[key]) > 0 ? Math.trunc(Number(value[key])) : 0;
  }
  return provenance;
}

function normalizeAttachmentMetadata(entry) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const kind = String(source.kind || 'text').trim().toLowerCase() || 'text';
  const displayName = String(source.displayName || '').trim() || 'Attachment';
  const id = String(
    source.id || createAttachmentId(kind === 'image' ? 'image' : kind === 'audio' ? 'audio' : 'attachment')
  );
  if (kind === 'image') {
    const assetPath = String(source.assetPath || '').trim();
    if (!assetPath) { return null; }
    const sourceKind = normalizeSourceKind(source.sourceKind, 'file');
    // C11: only generated images keep bounded C4 provenance (ADR-0003: metadata
    // only) plus the bounded preview derivative path the transcript renders.
    const generated = source.generated === true
      || sourceKind === 'image_generation' || sourceKind === 'plugin_generation';
    const provenance = generated ? normalizeGeneratedProvenance(source.provenance, sourceKind) : null;
    const previewAssetPath = generated ? String(source.previewAssetPath || '').trim() : '';
    return {
      id,
      kind: 'image',
      displayName,
      mimeType: String(source.mimeType || '').trim(),
      sizeBytes: Math.max(Number(source.sizeBytes || 0), 0),
      width: Math.max(Number(source.width || 0), 0),
      height: Math.max(Number(source.height || 0), 0),
      assetPath,
      sourceKind,
      ...(generated ? { generated: true, ...(previewAssetPath ? { previewAssetPath } : {}), ...(provenance ? { provenance } : {}) } : {}),
    };
  }
  if (kind === 'audio') {
    const assetPath = String(source.assetPath || '').trim();
    if (!assetPath) {
      return null;
    }
    const transcriptText = String(source.transcriptText || '').trim();
    const transcriptStatus = normalizeTranscriptStatus(
      source.transcriptStatus,
      transcriptText ? 'complete' : 'pending'
    );
    return {
      id,
      kind: 'audio',
      displayName,
      mimeType: String(source.mimeType || '').trim(),
      sizeBytes: Math.max(Number(source.sizeBytes || 0), 0),
      durationMs: normalizeDurationMs(source.durationMs),
      assetPath,
      sourceKind: normalizeSourceKind(source.sourceKind, 'file'),
      transcriptText,
      transcriptStatus: transcriptStatus || (transcriptText ? 'complete' : 'pending'),
      transcriptLanguage: String(source.transcriptLanguage || '').trim().toLowerCase(),
    };
  }
  return {
    id,
    kind: 'text',
    displayName,
    promptName: String(source.promptName || '').trim(),
    extension: String(source.extension || '').trim().toLowerCase(),
    sizeBytes: Math.max(Number(source.sizeBytes || 0), 0),
    truncated: Boolean(source.truncated || source.budgetTruncated),
  };
}

function normalizeAttachmentMetadataList(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => normalizeAttachmentMetadata(entry))
    .filter(Boolean);
}

function isTextAttachment(entry) {
  return String(entry?.kind || 'text').trim().toLowerCase() === 'text';
}

function isImageAttachment(entry) {
  return String(entry?.kind || '').trim().toLowerCase() === 'image';
}

function isAudioAttachment(entry) {
  return String(entry?.kind || '').trim().toLowerCase() === 'audio';
}

function hasAssetAttachment(entry) {
  const assetPath = String(entry?.assetPath || '').trim();
  return Boolean(assetPath) && (isImageAttachment(entry) || isAudioAttachment(entry));
}

function collectAssetPaths(entries) {
  // These feed retention references and session-delete cleanup; omitting previews
  // both deletes live files and leaks dead ones.
  return normalizeAttachmentMetadataList(entries)
    .filter((entry) => hasAssetAttachment(entry))
    .flatMap((entry) => entry.previewAssetPath
      ? [entry.assetPath, entry.previewAssetPath]
      : [entry.assetPath]);
}

function collectImageAssetPaths(entries) {
  return normalizeAttachmentMetadataList(entries)
    .filter((entry) => isImageAttachment(entry))
    .flatMap((entry) => entry.previewAssetPath
      ? [entry.assetPath, entry.previewAssetPath]
      : [entry.assetPath]);
}

module.exports = {
  normalizeSourceKind,
  normalizeDurationMs,
  normalizeTranscriptStatus,
  normalizeGeneratedProvenance,
  normalizeAttachmentMetadata,
  normalizeAttachmentMetadataList,
  isTextAttachment,
  isImageAttachment,
  isAudioAttachment,
  hasAssetAttachment,
  collectAssetPaths,
  collectImageAssetPaths,
};
