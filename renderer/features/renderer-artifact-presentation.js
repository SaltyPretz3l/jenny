/**
 * renderer/features/renderer-artifact-presentation.js
 *
 * Shared artifact presentation model used by inline tool-result cards,
 * the artifact shelf, the catalog grid, and the review/full artifact
 * panel. Produces a normalized descriptor from either the projected
 * artifact shape (artifactType / generatedFile / image / tool) or the
 * raw tool-result metadata shape (artifact_id / artifact_kind /
 * file_name / absolute_path / language / title), so all surfaces agree
 * on kind, title, kicker, meta line, status, and action vocabulary.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererArtifactPresentation = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KIND_IMAGE = 'image';
  const KIND_FILE = 'file';
  const KIND_TOOL = 'tool';

  const ACTION_OPEN = 'open';
  const ACTION_REVEAL = 'reveal';
  // 'panel' opens the artifact review side panel beside chat. It is the
  // primary in-app action (W1-5: the legacy Studio view and its 'studio'
  // action are retired; handleArtifactAction still accepts 'studio' as a
  // routing alias to the panel for old markup).
  const ACTION_PANEL = 'panel';
  const ACTION_VOCABULARY = Object.freeze([ACTION_PANEL, ACTION_OPEN, ACTION_REVEAL]);

  const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
  const MARKDOWN_EXTENSIONS = /\.(md|markdown)$/i;
  const IMAGE_KIND_TOKENS = new Set(['image', 'screenshot', 'diagram', 'chart']);

  function str(value) {
    return value == null ? '' : String(value).trim();
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      const normalized = str(value);
      if (normalized) return normalized;
    }
    return '';
  }

  function hasKey(artifact, ...keys) {
    if (!artifact || typeof artifact !== 'object') return false;
    for (const key of keys) {
      if (artifact[key] != null && artifact[key] !== '') return true;
    }
    return false;
  }

  function detectShape(artifact) {
    if (!artifact || typeof artifact !== 'object') return 'projected';
    if (typeof artifact.artifactType === 'string' && artifact.artifactType) return 'projected';
    if (hasKey(artifact, 'artifact_kind', 'artifact_id', 'file_name', 'absolute_path', 'display_path')) {
      return 'raw';
    }
    return 'projected';
  }

  function detectKindFromProjected(artifact) {
    const type = str(artifact?.artifactType).toLowerCase();
    if (type === 'image') return KIND_IMAGE;
    if (type === 'generated_file') return KIND_FILE;
    return KIND_TOOL;
  }

  function detectKindFromRaw(artifact) {
    const kindToken = str(artifact?.artifact_kind).toLowerCase();
    if (IMAGE_KIND_TOKENS.has(kindToken)) return KIND_IMAGE;
    const fileName = str(artifact?.file_name || artifact?.display_path).toLowerCase();
    if (IMAGE_EXTENSIONS.test(fileName)) return KIND_IMAGE;
    if (kindToken === 'file' || artifact?.file_name || artifact?.absolute_path) return KIND_FILE;
    return KIND_TOOL;
  }

  function titleCase(value) {
    const normalized = str(value);
    if (!normalized) return '';
    return normalized
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (match) => match.toUpperCase());
  }

  function formatLanguageLabel(value) {
    const normalized = str(value);
    if (!normalized) return '';
    const lowered = normalized.toLowerCase();
    if (lowered === 'plaintext' || lowered === 'text') return 'Plain text';
    return titleCase(lowered);
  }

  function imageSourceLabel(sourceKind) {
    const token = str(sourceKind).toLowerCase();
    if (token === 'capture') return 'Screenshot';
    if (token === 'clipboard') return 'Clipboard';
    if (token) return 'Attachment';
    return 'Image';
  }

  function isMarkdownLanguage(value) {
    const token = str(value).toLowerCase();
    return token === 'markdown' || token === 'md';
  }

  function isMarkdownDocumentPath(value) {
    return MARKDOWN_EXTENSIONS.test(str(value));
  }

  function isProjectedMarkdownDocument(artifact) {
    const file = artifact?.generatedFile || {};
    if (typeof file.isMarkdownDocument === 'boolean') return file.isMarkdownDocument;
    return isMarkdownLanguage(file.language)
      || isMarkdownDocumentPath(file.fileName)
      || isMarkdownDocumentPath(file.displayPath);
  }

  function isRawMarkdownDocument(artifact) {
    if (typeof artifact?.is_markdown_document === 'boolean') return artifact.is_markdown_document;
    if (typeof artifact?.isMarkdownDocument === 'boolean') return artifact.isMarkdownDocument;
    return isMarkdownLanguage(artifact?.language)
      || isMarkdownDocumentPath(artifact?.file_name)
      || isMarkdownDocumentPath(artifact?.display_path);
  }

  function isSessionScopedGeneratedDisplayPath(displayPath, sessionId) {
    const normalizedPath = str(displayPath).replace(/\\/g, '/');
    const normalizedSessionId = str(sessionId).replace(/\\/g, '/');
    if (!normalizedPath || !normalizedSessionId) return false;
    if (normalizedPath.includes('\0') || normalizedPath.includes('..')) return false;
    if (/^[a-z][a-z0-9+.-]*:/iu.test(normalizedPath)) return false;
    if (normalizedPath.startsWith('/') || normalizedPath.startsWith('//')) return false;
    return normalizedPath.startsWith(`.jenny/artifacts/${normalizedSessionId}/`);
  }

  function hasLocalTrustMarker(artifact) {
    return Object.prototype.hasOwnProperty.call(artifact || {}, 'local_trusted')
      || Object.prototype.hasOwnProperty.call(artifact || {}, 'trusted_local_path');
  }

  function isLegacySessionArtifactAssetPath(assetPath, sessionId) {
    const normalizedPath = str(assetPath).replace(/\\/g, '/');
    const normalizedSessionId = str(sessionId).replace(/\\/g, '/');
    if (!normalizedPath || !normalizedSessionId) return false;
    if (normalizedPath.includes('\0') || normalizedPath.includes('..') || normalizedPath.includes('://')) return false;
    return normalizedPath.includes(`/.jenny/artifacts/${normalizedSessionId}/`)
      || normalizedPath.startsWith(`.jenny/artifacts/${normalizedSessionId}/`);
  }

  function buildProjectedPresentation(artifact) {
    const kind = detectKindFromProjected(artifact);
    const id = firstNonEmpty(artifact?.id, artifact?.generatedFile?.artifactId);
    const title = firstNonEmpty(artifact?.title, 'Untitled');
    const rawStatus = str(artifact?.status).toLowerCase();
    const statusLabel = rawStatus && !['available', 'completed'].includes(rawStatus)
      ? titleCase(rawStatus)
      : '';

    let kicker;
    let metaLine;
    let thumbnail = null;
    let callId = '';
    let isMarkdownDocument = false;

    if (kind === KIND_IMAGE) {
      const image = artifact?.image || {};
      kicker = 'Image';
      const source = imageSourceLabel(image.sourceKind);
      const w = Math.max(Number(image.width || 0), 0);
      const h = Math.max(Number(image.height || 0), 0);
      metaLine = w > 0 && h > 0 ? `${source} / ${w} x ${h}` : source;
      const assetPath = str(image.assetPath);
      thumbnail = assetPath ? { assetPath, source } : null;
    } else if (kind === KIND_FILE) {
      const file = artifact?.generatedFile || {};
      const language = str(file.language);
      const artifactKind = str(file.artifactKind);
      isMarkdownDocument = isProjectedMarkdownDocument(artifact);
      kicker = isMarkdownDocument
        ? 'Markdown Document'
        : (language
          ? formatLanguageLabel(language)
          : (artifactKind ? formatLanguageLabel(artifactKind) : 'Scratch File'));
      metaLine = firstNonEmpty(file.displayPath, file.fileName, title);
    } else {
      const tool = artifact?.tool || {};
      kicker = firstNonEmpty(tool.toolName, 'Tool');
      callId = str(tool.callId);
      metaLine = firstNonEmpty(artifact?.outputText, artifact?.previewText, tool.summary);
    }

    return {
      kind,
      id,
      title,
      kicker,
      metaLine,
      statusLabel,
      thumbnail,
      callId,
      sourceShape: 'projected',
      isMarkdownDocument: kind === KIND_FILE && isMarkdownDocument,
    };
  }

  function buildRawPresentation(artifact, options) {
    const kind = detectKindFromRaw(artifact);
    const id = firstNonEmpty(artifact?.artifact_id);
    const title = firstNonEmpty(
      artifact?.title,
      artifact?.file_name,
      artifact?.artifact_kind,
      'Artifact',
    );
    const rawStatus = str(artifact?.status).toLowerCase();
    const statusLabel = rawStatus && !['available', 'completed'].includes(rawStatus)
      ? titleCase(rawStatus)
      : '';

    let kicker;
    let metaLine;
    let thumbnail = null;
    const callId = firstNonEmpty(artifact?.call_id, artifact?.callId);
    let isMarkdownDocument = false;

    if (kind === KIND_IMAGE) {
      kicker = 'Image';
      metaLine = firstNonEmpty(artifact?.display_path, artifact?.file_name);
      const absolutePath = firstNonEmpty(artifact?.absolute_path, artifact?.absolutePath);
      const assetPath = firstNonEmpty(absolutePath, artifact?.display_path);
      const trustedLocalPath = artifact?.local_trusted === true || artifact?.trusted_local_path === true;
      const sessionScoped = isSessionScopedGeneratedDisplayPath(
        artifact?.display_path,
        options?.sessionId || artifact?.session_id || artifact?.sessionId,
      );
      const legacySessionScoped = !hasLocalTrustMarker(artifact) && absolutePath
        && isLegacySessionArtifactAssetPath(absolutePath, options?.sessionId || artifact?.session_id || artifact?.sessionId);
      thumbnail = assetPath && sessionScoped && (trustedLocalPath || legacySessionScoped)
        ? { assetPath, source: 'Image', trustedLocalPath: true }
        : null;
    } else if (kind === KIND_FILE) {
      const language = str(artifact?.language);
      isMarkdownDocument = isRawMarkdownDocument(artifact);
      kicker = isMarkdownDocument ? 'Markdown Document' : language ? formatLanguageLabel(language) : 'File';
      metaLine = firstNonEmpty(artifact?.display_path, artifact?.file_name);
    } else {
      kicker = firstNonEmpty(artifact?.artifact_kind, 'Tool');
      metaLine = firstNonEmpty(artifact?.previewText, artifact?.title);
    }

    return {
      kind,
      id,
      title,
      kicker,
      metaLine,
      statusLabel,
      thumbnail,
      callId,
      sourceShape: 'raw',
      isMarkdownDocument: kind === KIND_FILE && isMarkdownDocument,
    };
  }

  function buildArtifactPresentation(artifact, options) {
    const mode = str(options?.mode).toLowerCase() || 'generic';
    const sessionId = firstNonEmpty(options?.sessionId, artifact?.sessionId, artifact?.session_id);
    const shape = detectShape(artifact);
    const base = shape === 'raw'
      ? buildRawPresentation(artifact, { ...options, sessionId })
      : buildProjectedPresentation(artifact);
    const dataAttributes = buildDataAttributes(base, { ...options, sessionId, mode });
    const actions = buildActions(base, { ...options, sessionId, mode });
    return { ...base, mode, sessionId, dataAttributes, actions, actionVocabulary: ACTION_VOCABULARY };
  }

  function legacyTypeToken(kind) {
    if (kind === KIND_IMAGE) return 'image';
    if (kind === KIND_FILE) return 'generated_file';
    return 'tool_output';
  }

  function buildDataAttributes(base, options) {
    const attrs = {};
    if (base.id) attrs['data-artifact-id'] = base.id;
    attrs['data-artifact-kind'] = base.kind;
    attrs['data-artifact-type'] = legacyTypeToken(base.kind);
    if (base.callId) attrs['data-artifact-call-id'] = base.callId;
    if (options?.sessionId) attrs['data-session-id'] = options.sessionId;
    if (base.statusLabel) attrs['data-artifact-status'] = base.statusLabel.toLowerCase();
    return attrs;
  }

  function buildActions(base, options) {
    const mode = str(options?.mode).toLowerCase();
    if (mode !== 'inline') {
      return [];
    }
    const enabled = Boolean(base.id);
    const unavailableLabel = 'Artifact unavailable';
    return [
      // Primary in-app action: the review panel beside chat (studio retired).
      {
        name: ACTION_PANEL,
        label: 'View',
        ariaLabel: 'Open in panel',
        title: enabled ? 'Open beside chat' : unavailableLabel,
        enabled,
      },
      {
        name: ACTION_OPEN,
        label: 'Open',
        ariaLabel: 'Open',
        title: enabled ? 'Open with default app' : unavailableLabel,
        enabled,
      },
      {
        name: ACTION_REVEAL,
        label: 'Reveal',
        ariaLabel: 'Reveal in folder',
        title: enabled ? 'Reveal in folder' : unavailableLabel,
        enabled,
      },
    ];
  }

  return {
    KIND_IMAGE,
    KIND_FILE,
    KIND_TOOL,
    ACTION_PANEL,
    ACTION_OPEN,
    ACTION_REVEAL,
    ACTION_VOCABULARY,
    buildArtifactPresentation,
    detectShape,
    formatLanguageLabel,
    imageSourceLabel,
    isMarkdownLanguage,
    isMarkdownDocumentPath,
    legacyTypeToken,
  };
});
