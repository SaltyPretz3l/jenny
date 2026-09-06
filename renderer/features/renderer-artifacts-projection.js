(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererArtifactsProjection = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const IMAGE_FILTER = 'image';
  const TOOL_OUTPUT_FILTER = 'tool_output';
  const GENERATED_FILE_FILTER = 'generated_file';
  const TOOL_PREVIEW_MAX_CHARS = 240;
  const REDACTED_PATH_TOKEN = '[redacted:path]';

  function isGeneratedFile(artifact) { return artifact?.artifactType === GENERATED_FILE_FILTER; }
  function isImageArtifact(artifact) { return artifact?.artifactType === IMAGE_FILTER; }

  function normalizeArtifactFilter(value) {
    const token = String(value || '').trim().toLowerCase();
    if ([IMAGE_FILTER, TOOL_OUTPUT_FILTER, GENERATED_FILE_FILTER].includes(token)) {
      return token;
    }
    return 'all';
  }

  function prettyPrintJson(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return '';
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch (_) {
      return trimmed;
    }
  }

  function inferGeneratedArtifactLanguage(entry) {
    const displayPath = String(entry?.display_path || entry?.displayPath || entry?.file_name || entry?.fileName || '').trim().toLowerCase();
    if (displayPath.endsWith('.mmd') || displayPath.endsWith('.mermaid')) return 'mermaid';
    if (displayPath.endsWith('.html') || displayPath.endsWith('.htm')) return 'html';
    if (displayPath.endsWith('.svg')) return 'svg';
    if (displayPath.endsWith('.vl.json') || displayPath.endsWith('.vega.json') || displayPath.endsWith('.chart.json')) return 'chart';
    return '';
  }

  function generatedFileKindTokens(artifact) {
    const file = artifact?.generatedFile || {};
    return {
      language: String(file.language || '').trim().toLowerCase(),
      mime: String(file.mimeType || '').trim().toLowerCase(),
      pathToken: String(file.displayPath || file.fileName || '').trim().toLowerCase(),
    };
  }

  function isHtmlGeneratedArtifact(artifact) {
    if (!artifact || !isGeneratedFile(artifact)) return false;
    const { language, mime, pathToken } = generatedFileKindTokens(artifact);
    if (language === 'html' || language === 'htm') return true;
    if (mime === 'text/html' || mime === 'application/xhtml+xml') return true;
    return pathToken.endsWith('.html') || pathToken.endsWith('.htm');
  }

  function isSvgGeneratedArtifact(artifact) {
    if (!artifact || !isGeneratedFile(artifact)) return false;
    const { language, mime, pathToken } = generatedFileKindTokens(artifact);
    if (language === 'svg') return true;
    if (mime === 'image/svg+xml') return true;
    return pathToken.endsWith('.svg');
  }

  function isChartGeneratedArtifact(artifact) {
    if (!artifact || !isGeneratedFile(artifact)) return false;
    const { language, pathToken } = generatedFileKindTokens(artifact);
    if (['chart', 'vega', 'vega-lite', 'vegalite'].includes(language)) return true;
    return pathToken.endsWith('.vl.json') || pathToken.endsWith('.vega.json') || pathToken.endsWith('.chart.json');
  }

  // HTML Artifact Preview (artifact_html_preview) routing predicate. Behavior-
  // preserving on its own: the flag gates RENDERING (renderer-artifact-html-
  // preview-render.js), not this classification. `source` is the artifact's
  // loaded content — needed because an svg's executability is a content
  // property (an svg carrying <script> executes; inert svg markup stays on the
  // WS2 strict-DOMPurify inline path).
  function isExecutableHtmlArtifact(artifact, source) {
    if (isHtmlGeneratedArtifact(artifact)) return true;
    if (!isSvgGeneratedArtifact(artifact)) return false;
    return /<script[\s>/]/i.test(String(source || ''));
  }

  function isMarkdownLanguage(value) {
    const token = String(value || '').trim().toLowerCase();
    return token === 'markdown' || token === 'md';
  }

  function isMarkdownPath(value) {
    const token = String(value || '').trim().toLowerCase();
    return token.endsWith('.md') || token.endsWith('.markdown');
  }

  function isMarkdownGeneratedArtifact(artifact) {
    if (!artifact || !isGeneratedFile(artifact)) return false;
    const file = artifact.generatedFile || {};
    if (typeof file.isMarkdownDocument === 'boolean') return file.isMarkdownDocument;
    if (isMarkdownLanguage(file.language)) return true;
    return isMarkdownPath(file.fileName) || isMarkdownPath(file.displayPath);
  }

  function isMermaidGeneratedArtifact(artifact) {
    if (!artifact || !isGeneratedFile(artifact)) return false;
    const language = String(artifact?.generatedFile?.language || '').trim().toLowerCase();
    if (language === 'mermaid') return true;
    const pathToken = String(artifact?.generatedFile?.displayPath || artifact?.generatedFile?.fileName || '').trim().toLowerCase();
    return pathToken.endsWith('.mmd') || pathToken.endsWith('.mermaid');
  }

  function extractMermaidSourceFromToolArtifact(artifact) {
    if (!artifact || String(artifact.artifactType || '').trim() !== TOOL_OUTPUT_FILTER) return '';
    const toolName = String(artifact?.tool?.toolName || '').trim().toLowerCase();
    const output = String(artifact.outputText || '').trim();
    if (!output) return '';
    if (output.startsWith('{')) {
      try {
        const parsed = JSON.parse(output);
        if (parsed && typeof parsed === 'object' && typeof parsed.mermaid === 'string' && parsed.mermaid.trim()) {
          return String(parsed.mermaid).trim();
        }
      } catch (_) {
        /* fall through */
      }
    }
    if (toolName === 'mermaid_generate' || toolName === 'mermaid') {
      return output;
    }
    if (/^(flowchart|sequenceDiagram|classDiagram|stateDiagram-v2|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart)\b/m.test(output)) {
      return output;
    }
    return '';
  }

  function clipPreviewText(value, maxLength) {
    const limit = Math.max(Number(maxLength) || 0, 24);
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3).trim()}...`;
  }

  function buildImagePreviewText(attachment) {
    const sourceKind = String(attachment?.sourceKind || '').trim().toLowerCase();
    const sourceLabel = sourceKind === 'capture' ? 'Screenshot' : sourceKind === 'clipboard' ? 'Pasted image' : 'Image attachment';
    const width = Math.max(Number(attachment?.width || 0), 0);
    const height = Math.max(Number(attachment?.height || 0), 0);
    return width > 0 && height > 0 ? `${sourceLabel} - ${width} x ${height}` : sourceLabel;
  }

  function buildGeneratedImagePreviewText(metadata) {
    const sourceKind = String(metadata?.source_kind || '').trim().toLowerCase();
    const sourceLabel = sourceKind === 'capture' ? 'Screenshot' : sourceKind === 'clipboard' ? 'Pasted image' : 'Image';
    const width = Math.max(Number(metadata?.width || 0), 0);
    const height = Math.max(Number(metadata?.height || 0), 0);
    return width > 0 && height > 0 ? `${sourceLabel} - ${width} x ${height}` : sourceLabel;
  }

  function buildToolPreviewText(toolResult) {
    const outputText = String(toolResult?.output_text || '').trim();
    if (!outputText) {
      return toolResult?.is_error ? 'Tool finished with an error and no output.' : 'Tool finished with no output.';
    }
    return clipPreviewText(outputText, TOOL_PREVIEW_MAX_CHARS);
  }

  function isInternalDiagnosticToolResult(toolResult, toolName) {
    const normalizedToolName = String(toolName || toolResult?.tool_name || '').trim().toLowerCase();
    const metadata = toolResult?.metadata && typeof toolResult.metadata === 'object'
      ? toolResult.metadata
      : {};
    const resultKind = String(metadata.result_kind || metadata.kind || '').trim().toLowerCase();
    return normalizedToolName === 'inspect_harness' || resultKind === 'harness_snapshot';
  }

  function buildGeneratedArtifactPreviewText(metadata) {
    if (String(metadata?.artifact_kind || '').trim().toLowerCase() === 'image') {
      return buildGeneratedImagePreviewText(metadata);
    }
    const displayPath = String(metadata?.display_path || '').trim();
    const language = String(metadata?.language || '').trim();
    const isMarkdownDocument = typeof metadata?.is_markdown_document === 'boolean'
      ? metadata.is_markdown_document
      : isMarkdownLanguage(language) || isMarkdownPath(displayPath) || isMarkdownPath(metadata?.file_name);
    if (isMarkdownDocument) {
      return displayPath ? `${displayPath} - Markdown document` : 'Markdown document';
    }
    if (displayPath && language) return `${displayPath} - ${language}`;
    if (displayPath) return displayPath;
    if (language) return `${language} scratch artifact`;
    return 'Generated scratch artifact';
  }

  function getArtifactTimestamp(sourceMessage) {
    return String(sourceMessage?.finalizedAt || sourceMessage?.timestamp || '').trim();
  }

  function formatArtifactTimestamp(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return 'Unknown time';
    const parsed = new Date(normalized);
    if (Number.isNaN(parsed.valueOf())) return normalized;
    return parsed.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function formatArtifactStatus(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return 'Unknown';
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  function formatLanguageLabel(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return 'Plain text';
    if (normalized.toLowerCase() === 'plaintext' || normalized.toLowerCase() === 'text') return 'Plain text';
    return normalized.replace(/[_-]+/g, ' ').replace(/\b\w/g, (match) => match.toUpperCase());
  }

  function sortArtifactsNewestFirst(artifacts) {
    return [...(Array.isArray(artifacts) ? artifacts : [])].sort((left, right) => {
      const byTimestamp = String(right?.timestamp || '').trim().localeCompare(String(left?.timestamp || '').trim());
      return byTimestamp !== 0 ? byTimestamp : String(right?.id || '').localeCompare(String(left?.id || ''));
    });
  }

  function countByType(artifacts) {
    const counts = { [GENERATED_FILE_FILTER]: 0, [IMAGE_FILTER]: 0, [TOOL_OUTPUT_FILTER]: 0 };
    for (const artifact of artifacts) {
      if (artifact.artifactType in counts) counts[artifact.artifactType]++;
    }
    return counts;
  }

  function filterArtifacts(artifacts, filterValue) {
    const normalizedFilter = normalizeArtifactFilter(filterValue);
    if (normalizedFilter === 'all') return [...(Array.isArray(artifacts) ? artifacts : [])];
    return (Array.isArray(artifacts) ? artifacts : []).filter((artifact) => String(artifact?.artifactType || '').trim() === normalizedFilter);
  }

  // Deletion is a client-side fact layered on top of the message-derived
  // artifact list: buildArtifactsFromMessages re-derives from persisted
  // messages every time, which know nothing about a since-deleted on-disk
  // file, so a naive rebuild resurrects the just-deleted entry. deletedIds
  // carries `${sessionId}::${artifactId}` keys (written by
  // renderer-artifacts-surface-controller.js#deleteSelectedArtifact).
  function filterDeletedArtifacts(artifacts, deletedIds, sessionId) {
    const list = Array.isArray(artifacts) ? artifacts : [];
    if (!Array.isArray(deletedIds) || !deletedIds.length) return list;
    const key = String(sessionId || '').trim();
    const deletedIdSet = new Set(deletedIds);
    return list.filter((artifact) => !deletedIdSet.has(`${key}::${String(artifact?.id || '')}`));
  }

  function normalizeGeneratedArtifactMetadata(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const artifactId = String(entry.artifact_id || '').trim();
    if (!artifactId) return null;
    const language = String(entry.language || '').trim() || inferGeneratedArtifactLanguage(entry);
    const hasLocalTrustMarker = Object.prototype.hasOwnProperty.call(entry, 'local_trusted')
      || Object.prototype.hasOwnProperty.call(entry, 'trusted_local_path');
    return {
      artifact_id: artifactId,
      artifact_kind: String(entry.artifact_kind || 'document').trim().toLowerCase() || 'document',
      title: String(entry.title || '').trim() || 'Generated artifact',
      file_name: String(entry.file_name || '').trim(),
      display_path: String(entry.display_path || '').trim(),
      absolute_path: String(entry.absolute_path || '').trim(),
      language,
      mime_type: String(entry.mime_type || entry.mimeType || '').trim().toLowerCase(),
      width: Math.max(Number(entry.width || 0), 0),
      height: Math.max(Number(entry.height || 0), 0),
      source_kind: String(entry.source_kind || entry.sourceKind || '').trim().toLowerCase(),
      editable: entry.editable !== false,
      status: String(entry.status || 'available').trim().toLowerCase() || 'available',
      local_trust_present: hasLocalTrustMarker,
      local_trusted: entry.local_trusted === true || entry.trusted_local_path === true,
      is_markdown_document: isMarkdownLanguage(language)
        || isMarkdownPath(entry.file_name)
        || isMarkdownPath(entry.display_path),
    };
  }

  function isSafeSessionArtifactDisplayPath(displayPath, sessionId) {
    const normalizedSessionId = String(sessionId || '').trim();
    const normalized = String(displayPath || '').trim().replace(/\\/g, '/');
    if (!normalizedSessionId || !normalized) return false;
    if (normalized.includes('\0') || normalized.includes('..')) return false;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(normalized)) return false;
    if (normalized.startsWith('/') || normalized.startsWith('//')) return false;
    return normalized.startsWith(`.jenny/artifacts/${normalizedSessionId}/`);
  }

  function isLegacySessionArtifactAbsolutePath(absolutePath, sessionId) {
    const normalizedSessionId = String(sessionId || '').trim();
    const normalized = String(absolutePath || '').trim().replace(/\\/g, '/');
    if (!normalizedSessionId || !normalized) return false;
    if (normalized.includes('\0') || normalized.includes('..') || normalized.includes('://')) return false;
    return normalized.includes(`/.jenny/artifacts/${normalizedSessionId}/`)
      || normalized.startsWith(`.jenny/artifacts/${normalizedSessionId}/`);
  }

  function resolveTrustedGeneratedImageAssetPath(metadata, sessionId) {
    const absolutePath = String(metadata?.absolute_path || '').trim();
    if (!absolutePath || absolutePath === REDACTED_PATH_TOKEN) return '';
    if (!isSafeSessionArtifactDisplayPath(metadata?.display_path, sessionId)) return '';
    return (metadata?.local_trusted === true
      || (metadata?.local_trust_present !== true && isLegacySessionArtifactAbsolutePath(absolutePath, sessionId)))
      ? absolutePath
      : '';
  }

  function canResolveRedactedGeneratedImage(metadata, sessionId) {
    return String(metadata?.absolute_path || '').trim() === REDACTED_PATH_TOKEN
      && (metadata?.local_trust_present !== true || metadata?.local_trusted === true)
      && isSafeSessionArtifactDisplayPath(metadata?.display_path, sessionId);
  }

  function artifactDedupKey(artifact, index) {
    const artifactType = String(artifact?.artifactType || '').trim();
    if (artifactType === GENERATED_FILE_FILTER) {
      const artifactId = String(artifact?.generatedFile?.artifactId || artifact?.id || '').trim();
      if (artifactId) return `generated:${artifactId}`;
    }
    const callId = String(artifact?.tool?.callId || '').trim();
    if (callId) return `tool:${callId}`;
    const artifactId = String(artifact?.id || '').trim();
    if (artifactId) return `artifact:${artifactId}`;
    return `row:${index}`;
  }

  function dedupeProjectedArtifacts(artifacts) {
    const source = Array.isArray(artifacts) ? artifacts : [];
    if (!source.length) return [];
    const latestIndexByKey = new Map();
    source.forEach((artifact, index) => {
      latestIndexByKey.set(artifactDedupKey(artifact, index), index);
    });
    return source.filter((artifact, index) => latestIndexByKey.get(artifactDedupKey(artifact, index)) === index);
  }

  function buildArtifactsFromMessages(messages, options = {}) {
    const sessionId = String(options.sessionId || '').trim();
    const list = Array.isArray(messages) ? messages : [];
    const toolCallsById = new Map();
    for (const message of list) {
      const callId = String(message?.tool_call?.call_id || '').trim();
      if (callId) {
        toolCallsById.set(callId, {
          toolCall: message.tool_call,
          sourceMessageId: String(message?.id || '').trim(),
        });
      }
    }

    const artifacts = [];
    for (const message of list) {
      const sourceMessageId = String(message?.id || '').trim();
      const timestamp = getArtifactTimestamp(message);
      const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
      for (const attachment of attachments) {
        if (String(attachment?.kind || '').trim() !== 'image') continue;
        const attachmentId = String(attachment?.id || '').trim();
        artifacts.push({
          id: `artifact_image_${sessionId}_${sourceMessageId}_${attachmentId || artifacts.length}`,
          sessionId,
          sourceMessageId,
          sourceKind: 'message_attachment',
          artifactType: IMAGE_FILTER,
          title: String(attachment?.displayName || 'Image attachment').trim() || 'Image attachment',
          previewText: buildImagePreviewText(attachment),
          timestamp,
          status: String(attachment?.assetPath || '').trim() ? 'available' : 'missing',
          image: {
            id: attachmentId,
            displayName: String(attachment?.displayName || '').trim(),
            mimeType: String(attachment?.mimeType || '').trim(),
            assetPath: String(attachment?.assetPath || '').trim(),
            width: Math.max(Number(attachment?.width || 0), 0),
            height: Math.max(Number(attachment?.height || 0), 0),
            sourceKind: String(attachment?.sourceKind || '').trim(),
          },
        });
      }
      if (String(message?.kind || '').trim() !== 'tool_result' || !message?.tool_result) continue;
      const toolResult = message.tool_result;
      const callId = String(toolResult?.call_id || '').trim();
      const pairedToolContext = callId ? toolCallsById.get(callId) || null : null;
      const pairedToolCall = pairedToolContext?.toolCall || null;
      const toolName = String(toolResult?.tool_name || pairedToolCall?.tool_name || 'Tool').trim() || 'Tool';
      const artifactSourceMessageId = String(pairedToolContext?.sourceMessageId || sourceMessageId).trim() || sourceMessageId;
      const normalizedGeneratedArtifacts = (Array.isArray(toolResult?.generated_artifacts) ? toolResult.generated_artifacts : [])
        .map(normalizeGeneratedArtifactMetadata)
        .filter(Boolean);
      if (normalizedGeneratedArtifacts.length) {
        for (const metadata of normalizedGeneratedArtifacts) {
          if (metadata.artifact_kind === IMAGE_FILTER) {
            const assetPath = resolveTrustedGeneratedImageAssetPath(metadata, sessionId);
            const canResolveViaArtifactRead = !assetPath && canResolveRedactedGeneratedImage(metadata, sessionId);
            artifacts.push({
              id: metadata.artifact_id,
              sessionId,
              sourceMessageId: artifactSourceMessageId,
              sourceKind: 'generated_artifact',
              artifactType: IMAGE_FILTER,
              title: metadata.title,
              previewText: buildGeneratedArtifactPreviewText(metadata),
              timestamp,
              status: (assetPath || canResolveViaArtifactRead) ? metadata.status : 'missing',
              image: {
                id: metadata.artifact_id,
                artifactId: metadata.artifact_id,
                displayName: metadata.title,
                mimeType: metadata.mime_type,
                assetPath,
                requiresArtifactRead: canResolveViaArtifactRead,
                width: metadata.width,
                height: metadata.height,
                sourceKind: metadata.source_kind,
              },
              tool: {
                callId,
                toolName,
                summary: String(toolResult?.summary || pairedToolCall?.summary || toolName).trim(),
                isError: Boolean(toolResult?.is_error),
              },
            });
          } else {
            artifacts.push({
              id: metadata.artifact_id,
              sessionId,
              sourceMessageId: artifactSourceMessageId,
              sourceKind: 'generated_artifact',
              artifactType: GENERATED_FILE_FILTER,
              title: metadata.title,
              previewText: buildGeneratedArtifactPreviewText(metadata),
              timestamp,
              status: metadata.status,
              generatedFile: {
                artifactId: metadata.artifact_id,
                artifactKind: metadata.artifact_kind,
                title: metadata.title,
                fileName: metadata.file_name,
                displayPath: metadata.display_path,
                absolutePath: metadata.absolute_path,
                language: metadata.language,
                mimeType: metadata.mime_type,
                editable: metadata.editable === true,
                status: metadata.status,
                isMarkdownDocument: metadata.is_markdown_document === true,
              },
              tool: {
                callId,
                toolName,
                summary: String(toolResult?.summary || pairedToolCall?.summary || toolName).trim(),
                isError: Boolean(toolResult?.is_error),
              },
            });
          }
        }
        continue;
      }
      if (isInternalDiagnosticToolResult(toolResult, toolName)) {
        continue;
      }
      artifacts.push({
        id: `artifact_tool_${sessionId}_${sourceMessageId}_${callId || artifacts.length}`,
        sessionId,
        sourceMessageId: artifactSourceMessageId,
        sourceKind: 'tool_result',
        artifactType: TOOL_OUTPUT_FILTER,
        title: String(toolResult?.summary || pairedToolCall?.summary || toolName).trim() || toolName,
        previewText: buildToolPreviewText(toolResult),
        timestamp,
        status: toolResult?.is_error ? 'error' : 'completed',
        tool: {
          callId,
          toolName,
          summary: String(toolResult?.summary || pairedToolCall?.summary || toolName).trim(),
          isError: Boolean(toolResult?.is_error),
        },
        outputText: String(toolResult?.output_text || '').trim(),
        // File-mutation tools (write_file/edit_file) carry a structured diff +
        // target path in metadata; thread them through so the panel can render
        // the actual change instead of the byte-count receipt.
        filePath: String(toolResult?.metadata?.path || '').trim(),
        diff: toolResult?.metadata?.diff && typeof toolResult.metadata.diff === 'object' ? toolResult.metadata.diff : null,
      });
    }
    return sortArtifactsNewestFirst(dedupeProjectedArtifacts(artifacts));
  }

  return {
    IMAGE_FILTER,
    TOOL_OUTPUT_FILTER,
    GENERATED_FILE_FILTER,
    isGeneratedFile,
    isImageArtifact,
    normalizeArtifactFilter,
    prettyPrintJson,
    inferGeneratedArtifactLanguage,
    isMarkdownGeneratedArtifact,
    isMermaidGeneratedArtifact,
    isHtmlGeneratedArtifact,
    isSvgGeneratedArtifact,
    isChartGeneratedArtifact,
    isExecutableHtmlArtifact,
    extractMermaidSourceFromToolArtifact,
    clipPreviewText,
    buildImagePreviewText,
    buildToolPreviewText,
    isInternalDiagnosticToolResult,
    buildGeneratedArtifactPreviewText,
    getArtifactTimestamp,
    formatArtifactTimestamp,
    formatArtifactStatus,
    formatLanguageLabel,
    sortArtifactsNewestFirst,
    countByType,
    filterArtifacts,
    filterDeletedArtifacts,
    normalizeGeneratedArtifactMetadata,
    canResolveRedactedGeneratedImage,
    buildArtifactsFromMessages,
  };
});
