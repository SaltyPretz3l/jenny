(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTranscriptAttachmentsUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createTranscriptAttachmentsRenderer(deps) {
    const { escapeHtml } = deps || {};

    function isLocalAttachmentAssetPath(raw) {
      const normalized = String(raw || '').trim();
      if (!normalized) return false;
      if (/^\\\\/.test(normalized)) return false;
      if (/^\/\//.test(normalized)) return false;
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized) && !/^[a-zA-Z]:[\\/]/.test(normalized)) {
        return false;
      }
      if (/^[a-zA-Z]:[\\/]/.test(normalized)) return true;
      if (/^\//.test(normalized)) return true;
      return false;
    }
    function toFileAssetUrl(assetPath) {
      const normalized = String(assetPath || '').trim();
      if (!normalized) {
        return '';
      }
      if (!isLocalAttachmentAssetPath(normalized)) {
        return '';
      }
      const withForwardSlashes = normalized.replace(/\\/g, '/');
      const prefixed = withForwardSlashes.startsWith('/') ? withForwardSlashes : `/${withForwardSlashes}`;
      try {
        const fileUrl = new URL('file:///');
        fileUrl.pathname = prefixed;
        return fileUrl.toString();
      } catch (_error) {
        const encodedPath = prefixed
          .split('/')
          .map((segment, index) => {
            if (!segment) return '';
            if (index === 1 && /^[A-Za-z]:$/.test(segment)) return segment;
            return encodeURIComponent(segment);
          })
          .join('/');
        return `file://${encodedPath}`;
      }
    }

    function unavailableMedia(kind) {
      const label = kind === 'audio' ? 'Audio unavailable' : 'Image unavailable';
      return `<div class="message-attachment-card message-attachment-unavailable" role="status">${escapeHtml(label)}</div>`;
    }

    function renderMessageAttachments(message) {
      const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
      const skillName = String(message?.skill_invocation?.name || '').trim();
      if (!attachments.length && !skillName) {
        return '';
      }
      return `
        <div class="message-attachments">
          ${skillName ? `<span class="message-skill-pill">${escapeHtml(skillName)}</span>` : ''}
          ${attachments
            .map((attachment) => {
              const isImage = String(attachment?.kind || '').trim() === 'image';
              const isAudio = String(attachment?.kind || '').trim() === 'audio';
              const mediaUrl = isImage || isAudio ? toFileAssetUrl(attachment?.assetPath) : '';
              if (isImage) {
                if (!mediaUrl) {
                  return unavailableMedia('image');
                }
                return `
                  <figure class="message-attachment-card message-attachment-image">
                    <img
                      class="message-attachment-image-preview"
                      src="${escapeHtml(mediaUrl)}"
                      alt="${escapeHtml(attachment.displayName || 'Image attachment')}"
                    >
                    <figcaption class="message-attachment-caption">${escapeHtml(attachment.displayName || 'Image attachment')}</figcaption>
                  </figure>
                `;
              }
              if (isAudio) {
                if (!mediaUrl) {
                  return unavailableMedia('audio');
                }
                return `
                  <div class="message-attachment-card message-attachment-audio">
                    <audio
                      class="message-attachment-audio-player"
                      controls
                      preload="metadata"
                      src="${escapeHtml(mediaUrl)}"
                    ></audio>
                    <div class="message-attachment-label">${escapeHtml(attachment.displayName || 'Audio attachment')}</div>
                    <div class="message-attachment-meta">${escapeHtml(
                      attachment.transcriptStatus === 'complete'
                        ? 'voice attachment - transcript ready'
                        : attachment.transcriptStatus === 'error'
                          ? 'voice attachment - transcript failed'
                          : 'voice attachment'
                    )}</div>
                  </div>
                `;
              }
              return `
                <div class="message-attachment-card">
                  <div class="message-attachment-label">${escapeHtml(attachment.displayName || 'Attachment')}</div>
                  <div class="message-attachment-meta">${escapeHtml(attachment.truncated ? 'truncated text attachment' : 'text attachment')}</div>
                </div>
              `;
            })
            .join('')}
        </div>
      `;
    }

    return {
      renderMessageAttachments,
    };
  }

  return {
    createTranscriptAttachmentsRenderer,
  };
});
