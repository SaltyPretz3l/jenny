'use strict';

const path = require('path');

const VALID_ARTIFACT_KINDS = new Set(['document', 'script', 'image']);

function clipText(value, maxLength = 240) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  const limit = Math.max(Number(maxLength) || 0, 24);
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3).trim()}...`;
}

function normalizeArtifactKind(value) {
  const token = String(value || '').trim().toLowerCase();
  return VALID_ARTIFACT_KINDS.has(token) ? token : 'document';
}

function normalizeArtifactStatus(value) {
  const token = String(value || '').trim().toLowerCase();
  if (token === 'missing' || token === 'error' || token === 'unavailable') {
    return token;
  }
  return 'available';
}

function normalizeLanguage(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeMimeType(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePositiveDimension(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function extensionFromDisplayPath(displayPath) {
  const token = String(displayPath || '').trim();
  return token ? path.extname(token).toLowerCase() : '';
}

function inferLanguageFromPath(displayPath) {
  const ext = extensionFromDisplayPath(displayPath);
  switch (ext) {
    case '.md':
    case '.markdown':
      return 'markdown';
    case '.mmd':
      return 'mermaid';
    case '.txt':
      return 'plaintext';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.jsx':
      return 'javascript';
    case '.ts':
      return 'typescript';
    case '.tsx':
      return 'typescript';
    case '.json':
      return 'json';
    case '.py':
      return 'python';
    case '.sh':
      return 'shell';
    case '.ps1':
      return 'powershell';
    case '.html':
    case '.htm':
      return 'html';
    case '.css':
      return 'css';
    case '.yml':
    case '.yaml':
      return 'yaml';
    case '.toml':
      return 'toml';
    case '.sql':
      return 'sql';
    default:
      return '';
  }
}

function isSafeArtifactDisplayPath(displayPath) {
  const normalized = String(displayPath || '').trim().replace(/\\/g, '/');
  if (!normalized || normalized.includes('\0') || normalized.includes('..')) {
    return false;
  }
  if (path.isAbsolute(normalized) || normalized.startsWith('//')) {
    return false;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(normalized)) {
    return false;
  }
  return true;
}

function normalizeGeneratedArtifactMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const artifactId = String(value.artifact_id || '').trim();
  const title = String(value.title || '').trim();
  const fileName = String(value.file_name || '').trim();
  const displayPath = String(value.display_path || '').trim();
  const absolutePath = String(value.absolute_path || '').trim();

  if (!artifactId || !title || !fileName || !displayPath || !absolutePath) {
    return null;
  }
  if (!isSafeArtifactDisplayPath(displayPath)) {
    return null;
  }

  const language = normalizeLanguage(value.language) || inferLanguageFromPath(displayPath);
  return {
    artifact_id: artifactId,
    artifact_kind: normalizeArtifactKind(value.artifact_kind),
    title,
    file_name: fileName,
    display_path: displayPath,
    absolute_path: absolutePath,
    language,
    mime_type: normalizeMimeType(value.mime_type || value.mimeType),
    width: normalizePositiveDimension(value.width),
    height: normalizePositiveDimension(value.height),
    editable: value.editable !== false,
    status: normalizeArtifactStatus(value.status),
  };
}

function normalizeGeneratedArtifactMetadataList(value) {
  return Array.isArray(value)
    ? value.map((entry) => normalizeGeneratedArtifactMetadata(entry)).filter(Boolean)
    : [];
}

module.exports = {
  clipText,
  inferLanguageFromPath,
  normalizeArtifactKind,
  normalizeArtifactStatus,
  normalizeGeneratedArtifactMetadata,
  normalizeGeneratedArtifactMetadataList,
  isSafeArtifactDisplayPath,
  normalizeLanguage,
  normalizeMimeType,
};
