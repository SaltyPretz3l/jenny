(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererArtifactsRender = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const documentRef = typeof globalThis !== 'undefined' ? globalThis.document || null : null;
  const presentation = (function resolvePresentation() {
    if (typeof globalThis !== 'undefined' && globalThis.rendererArtifactPresentation) {
      return globalThis.rendererArtifactPresentation;
    }
    if (typeof require === 'function') {
      try { return require('./renderer-artifact-presentation'); } catch (_error) { /* not available */ }
    }
    return null;
  })();
  const documentRender = (function resolveDocumentRender() {
    if (typeof globalThis !== 'undefined' && globalThis.rendererArtifactDocumentRender) {
      return globalThis.rendererArtifactDocumentRender;
    }
    if (typeof require === 'function') {
      try { return require('./renderer-artifact-document-render'); } catch (_error) { /* not available */ }
    }
    return null;
  })();


  function presentArtifact(artifact, mode) {
    if (presentation && typeof presentation.buildArtifactPresentation === 'function') {
      return presentation.buildArtifactPresentation(artifact, { mode });
    }
    return null;
  }
  const CATALOG_TOOL_PREVIEW_LIMIT = 84;
  const CATALOG_PATH_PREVIEW_LIMIT = 52;
  const CATALOG_PREVIEW_TEXT_LIMIT = 92;

  function renderDetailMeta(items, stacked, escapeHtml) {
    const content = (Array.isArray(items) ? items : [])
      .filter(Boolean)
      .map((item) => {
        const label = typeof item === 'object' && item && 'label' in item
          ? String(item.label || '').trim()
          : '';
        const value = typeof item === 'object' && item && 'value' in item
          ? String(item.value || '').trim()
          : String(item || '').trim();
        if (!value) return '';
        return (
          `<div class="artifact-detail-meta-item${stacked ? ' artifact-detail-meta-item-stacked' : ''}">`
          + (label ? `<span class="artifact-detail-meta-label">${escapeHtml(label)}</span>` : '')
          + `<span class="artifact-detail-meta-value">${escapeHtml(value)}</span>`
          + '</div>'
        );
      })
      .filter(Boolean)
      .join('');
    return content || '<div class="context-empty-state">No detail metadata</div>';
  }

  function renderProvenanceTimeline(target, artifact, deps) {
    const {
      escapeHtml,
      formatArtifactTimestamp,
      isGeneratedFile,
      isImageArtifact,
      formatLanguageLabel,
    } = deps;
    if (!target) return;
    if (!artifact) {
      target.innerHTML = '';
      return;
    }
    const entries = [];
    if (artifact.timestamp) {
      entries.push({ label: 'Created', detail: formatArtifactTimestamp(artifact.timestamp) });
    }
    if (isGeneratedFile(artifact)) {
      const file = artifact.generatedFile || {};
      if (artifact.tool?.toolName) entries.push({ label: 'Tool', detail: artifact.tool.toolName });
      if (file.displayPath || file.fileName) entries.push({ label: 'File', detail: file.displayPath || file.fileName });
      if (file.language) entries.push({ label: 'Language', detail: formatLanguageLabel(file.language) });
      if (file.artifactKind && file.artifactKind !== 'document') entries.push({ label: 'Kind', detail: file.artifactKind });
    } else if (isImageArtifact(artifact)) {
      const image = artifact.image || {};
      if (image.sourceKind) {
        const sourceLabel = image.sourceKind === 'capture'
          ? 'Screenshot'
          : image.sourceKind === 'clipboard'
            ? 'Pasted image'
            : 'Attachment';
        entries.push({ label: 'Source', detail: sourceLabel });
      }
      if (image.width > 0 && image.height > 0) {
        entries.push({ label: 'Dimensions', detail: `${image.width} x ${image.height}` });
      }
    } else {
      if (artifact.tool?.toolName) entries.push({ label: 'Tool', detail: artifact.tool.toolName });
      if (artifact.tool?.isError) entries.push({ label: 'Status', detail: 'Error' });
    }
    if (artifact.sourceMessageId) {
      entries.push({ label: 'Source', detail: `Message ${artifact.sourceMessageId.slice(0, 8)}...` });
    }
    target.innerHTML = entries.map((entry, index) =>
      `<div class="provenance-entry" data-provenance-step="${escapeHtml(String(index + 1))}">`
      + `<span class="provenance-entry-label">${escapeHtml(entry.label)}</span>`
      + `<span class="provenance-entry-detail">${escapeHtml(entry.detail)}</span>`
      + '</div>'
    ).join('') || '<div class="context-empty-state">No provenance data</div>';
  }

  function setDetailNote(surface, text, isError) {
    if (!surface?.detailNote) return;
    surface.detailNote.textContent = text;
    surface.detailNote.classList.toggle('detail-note-error', Boolean(isError));
  }

  function renderMermaidModeButton(mode, active, label, disabled, escapeHtml) {
    return `<button class="artifact-preview-mermaid-toggle${active ? ' active' : ''}" type="button" data-artifact-mermaid-mode="${escapeHtml(mode)}"${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`;
  }

  function renderArtifactViewModeButton(kind, mode, active, label, disabled, escapeHtml) {
    return `<button class="artifact-preview-mermaid-toggle${active ? ' active' : ''}" type="button" data-artifact-view-kind="${escapeHtml(kind)}" data-artifact-view-mode="${escapeHtml(mode)}"${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`;
  }

  function renderMermaidGeneratedArtifact(surface, artifact, file, editable, deps) {
    const {
      state,
      escapeHtml,
      ensureEditor,
      getPreferredEditorValue,
      renderMermaidPreviewIntoHost,
      setDetailNote: setDetailNoteImpl,
    } = deps;
    const mermaidSource = getPreferredEditorValue();
    const sourceHtml = mermaidSource
      ? `<pre class="artifact-preview-pre artifact-preview-mermaid-source">${escapeHtml(mermaidSource)}</pre>`
      : '';
    const editMode = state.artifacts.mermaidViewMode === 'edit';
    const toolbar = state.features?.featureFlags?.artifact_panel_v3 === true ? '' : (
      '<div class="artifact-preview-mermaid-toolbar">'
      + renderMermaidModeButton('preview', !editMode, 'Preview', state.artifacts.loading, escapeHtml)
      + renderMermaidModeButton('edit', editMode, editable ? 'Edit Source' : 'View Source', state.artifacts.loading, escapeHtml)
      + '</div>'
    );
    if (state.artifacts.lastError) {
      setDetailNoteImpl(surface, state.artifacts.lastError, true);
    } else if (state.artifacts.loading) {
      setDetailNoteImpl(surface, 'Loading artifact...');
    } else if (editable) {
      setDetailNoteImpl(
        surface,
        editMode
          ? 'Editing Mermaid source. Save writes back to the session scratch file.'
          : 'Mermaid preview with source and edit access below.'
      );
    } else {
      setDetailNoteImpl(surface, 'Read-only Mermaid artifact. You can inspect the source below.');
    }

    surface.previewContent.classList.remove('hidden');
    if (editMode) {
      surface.previewContent.innerHTML = toolbar + '<div class="artifacts-empty">Editing Mermaid source below. Switch back to Preview to re-render the diagram.</div>';
      surface.editorShell.classList.remove('hidden');
      ensureEditor(surface.key)?.setDocument({
        value: mermaidSource,
        language: file?.language || 'plaintext',
        readOnly: !editable || state.artifacts.loading || Boolean(state.artifacts.lastError),
      }).catch(() => {});
      return;
    }

    surface.editorShell.classList.add('hidden');
    if (!mermaidSource.trim()) {
      surface.previewContent.innerHTML = toolbar + '<div class="artifacts-empty">Preview unavailable. Mermaid source is empty.</div>';
      return;
    }

    const hostId = `${surface.key}-generated-mermaid-preview-${String(artifact.id || 'preview').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}`;
    surface.previewContent.innerHTML = (
      toolbar + '<div class="artifact-preview-mermaid-shell">'
      + `<div class="artifact-preview-mermaid-host" id="${escapeHtml(hostId)}">`
      + '<div class="artifacts-empty">Rendering Mermaid preview...</div>'
      + '</div>'
      + '</div>'
      + sourceHtml
    );
    const host = documentRef ? documentRef.getElementById(hostId) : null;
    const previewStarted = renderMermaidPreviewIntoHost(
      host,
      mermaidSource,
      `artifact-mermaid-svg-${String(hostId || '').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase() || 'preview'}`
    );
    if (!previewStarted) {
      surface.previewContent.innerHTML = toolbar + '<div class="artifacts-empty">Preview unavailable. Mermaid source is shown below.</div>'
        + sourceHtml;
    }
  }

  function buildMarkdownArtifactDocumentHtml(input, deps) {
    if (documentRender && typeof documentRender.buildMarkdownArtifactDocumentHtml === 'function') {
      return documentRender.buildMarkdownArtifactDocumentHtml(input, deps);
    }
    const escapeHtml = typeof deps?.escapeHtml === 'function'
      ? deps.escapeHtml
      : (value) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    return `<pre class="artifact-preview-pre">${escapeHtml(input?.content || '')}</pre>`;
  }

  function decorateMarkdownArtifactDocument(container, options) {
    if (documentRender && typeof documentRender.decorateMarkdownArtifactDocument === 'function') {
      documentRender.decorateMarkdownArtifactDocument(container, options);
    }
  }

  function readArtifactDocumentCodeBlockText(copyButton) {
    if (documentRender && typeof documentRender.readCodeBlockText === 'function') {
      return documentRender.readCodeBlockText(copyButton);
    }
    return '';
  }

  function buildMarkdownArtifactDocumentSignature(input) {
    if (documentRender && typeof documentRender.buildMarkdownArtifactDocumentSignature === 'function') {
      return documentRender.buildMarkdownArtifactDocumentSignature(input);
    }
    return JSON.stringify(input || {});
  }

  function setActiveOutlineItem(documentNode, activeId) {
    if (documentRender && typeof documentRender.setActiveOutlineItem === 'function') {
      documentRender.setActiveOutlineItem(documentNode, activeId);
    }
  }

  function escapeCssUrl(url) {
    return String(url || '')
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'");
  }

  function catalogTypeIcon(type) {
    if (type === 'generated_file') return 'draft';
    if (type === 'image') return 'image';
    return 'terminal';
  }

  function buildCatalogBadges(artifact, deps) {
    const { escapeHtml, formatArtifactStatus, formatLanguageLabel } = deps;
    const badges = [];
    if (artifact.artifactType === 'generated_file') {
      badges.push('File');
      const language = String(artifact?.generatedFile?.language || '').trim();
      if (language) badges.push(formatLanguageLabel(language));
    } else if (artifact.artifactType === 'image') {
      badges.push('Image');
      const sourceKind = String(artifact?.image?.sourceKind || '').trim().toLowerCase();
      if (sourceKind === 'capture') badges.push('Screenshot');
      else if (sourceKind === 'clipboard') badges.push('Clipboard');
      else if (sourceKind) badges.push('Attachment');
    } else {
      badges.push('Tool');
      if (artifact?.tool?.toolName) badges.push(String(artifact.tool.toolName).trim());
    }
    if (artifact.status && !['available', 'completed'].includes(String(artifact.status).trim().toLowerCase())) {
      badges.push(formatArtifactStatus(artifact.status));
    }
    return badges
      .filter(Boolean)
      .map((label) => `<span class="catalog-entry-badge">${escapeHtml(String(label))}</span>`)
      .join('');
  }

  function renderCatalogMedia(artifact, deps) {
    const { escapeHtml, clipPreviewText, prettyPrintJson, toFileAssetUrl, formatLanguageLabel } = deps;
    const icon = catalogTypeIcon(artifact.artifactType);
    if (artifact.artifactType === 'image') {
      const assetPath = String(artifact?.image?.assetPath || '').trim();
      const assetUrl = assetPath ? String(toFileAssetUrl(assetPath) || '').trim() : '';
      if (assetUrl) {
        return (
          '<span class="catalog-entry-media catalog-entry-media-image" aria-hidden="true">'
          + `<span class="catalog-entry-image-thumb" style="background-image: url('${escapeHtml(escapeCssUrl(assetUrl))}');"></span>`
          + '</span>'
        );
      }
      return (
        '<span class="catalog-entry-media catalog-entry-media-image catalog-entry-media-fallback" aria-hidden="true">'
        + `<span class="catalog-entry-icon material-symbols-outlined">${icon}</span>`
        + `<span class="catalog-entry-media-label">${artifact?.image?.requiresArtifactRead === true ? 'Image preview' : 'Image unavailable'}</span>`
        + '</span>'
      );
    }
    if (artifact.artifactType === 'generated_file') {
      const file = artifact.generatedFile || {};
      const language = String(file.language || '').trim();
      const label = language ? formatLanguageLabel(language) : 'Scratch file';
      const fileName = String(file.fileName || artifact.title || 'artifact').trim();
      const displayPath = String(file.displayPath || '').trim();
      return (
        '<span class="catalog-entry-media catalog-entry-media-file" aria-hidden="true">'
        + `<span class="catalog-entry-file-label">${escapeHtml(label)}</span>`
        + `<span class="catalog-entry-file-name">${escapeHtml(fileName)}</span>`
        + `<span class="catalog-entry-file-path">${escapeHtml(clipPreviewText(displayPath, CATALOG_PATH_PREVIEW_LIMIT))}</span>`
        + '</span>'
      );
    }
    const output = prettyPrintJson(artifact.outputText || artifact.previewText || '');
    return (
      '<span class="catalog-entry-media catalog-entry-media-tool" aria-hidden="true">'
      + `<span class="catalog-entry-tool-label">${escapeHtml(String(artifact?.tool?.toolName || 'Tool'))}</span>`
      + `<code class="catalog-entry-tool-snippet">${escapeHtml(clipPreviewText(output, CATALOG_TOOL_PREVIEW_LIMIT))}</code>`
      + '</span>'
    );
  }

  function buildCatalogMetaLine(artifact, deps) {
    const { formatArtifactTimestamp, escapeHtml, clipPreviewText } = deps;
    const created = escapeHtml(formatArtifactTimestamp(artifact.timestamp));
    if (artifact.artifactType === 'generated_file') {
      const file = artifact.generatedFile || {};
      const descriptor = file.displayPath
        ? clipPreviewText(file.displayPath, CATALOG_PATH_PREVIEW_LIMIT + 8)
        : file.fileName || artifact.previewText || 'Generated scratch artifact';
      return `${created} &middot; ${escapeHtml(descriptor)}`;
    }
    if (artifact.artifactType === 'image') {
      return `${created} &middot; ${escapeHtml(String(artifact.previewText || 'Image attachment'))}`;
    }
    const preview = clipPreviewText(artifact.outputText || artifact.previewText || '', CATALOG_PATH_PREVIEW_LIMIT + 4);
    return `${created} &middot; ${escapeHtml(preview || 'Tool output')}`;
  }

  function renderCatalogEntry(artifact, selected, deps) {
    const { escapeHtml, clipPreviewText } = deps;
    const pres = presentArtifact(artifact, 'catalog');
    const kindToken = pres ? pres.kind : 'tool';
    const artifactType = pres ? pres.dataAttributes['data-artifact-type'] : String(artifact.artifactType || 'artifact');
    const title = pres ? pres.title : String(artifact.title || '');
    const previewText = clipPreviewText(artifact.previewText || artifact.outputText || '', CATALOG_PREVIEW_TEXT_LIMIT);
    return `
      <button
        type="button"
        class="catalog-entry catalog-entry-${escapeHtml(String(artifactType))}${selected ? ' catalog-entry-selected' : ''}"
        data-artifact-select="${escapeHtml(artifact.id)}"
        data-artifact-kind="${escapeHtml(kindToken)}"
        aria-pressed="${selected ? 'true' : 'false'}"
        aria-selected="${selected ? 'true' : 'false'}"
      >
        ${renderCatalogMedia(artifact, deps)}
        <span class="catalog-entry-main">
          <span class="catalog-entry-topline">
            <span class="catalog-entry-badges">${buildCatalogBadges(artifact, deps)}</span>
          </span>
          <span class="catalog-entry-title">${escapeHtml(title)}</span>
          <span class="catalog-entry-preview">${escapeHtml(previewText || 'Open this artifact to inspect it on stage.')}</span>
          <span class="catalog-entry-meta">${buildCatalogMetaLine(artifact, deps)}</span>
        </span>
      </button>
    `;
  }

  function renderArtifactCard(artifact, deps) {
    return renderCatalogEntry(artifact, deps?.selected === true, deps);
  }

  return {
    renderDetailMeta,
    renderProvenanceTimeline,
    setDetailNote,
    buildMarkdownArtifactDocumentHtml,
    buildMarkdownArtifactDocumentSignature,
    decorateMarkdownArtifactDocument,
    readArtifactDocumentCodeBlockText,
    setActiveOutlineItem,
    renderMermaidGeneratedArtifact,
    renderMermaidModeButton,
    renderArtifactViewModeButton,
    renderCatalogEntry,
    renderArtifactCard,
  };
});
