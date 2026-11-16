(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/artifact-figure'), require('../inventory/action-button'));
    return;
  }
  root.rendererTranscriptAttachmentsUtils = factory(root.inventoryArtifactFigure || null, null);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (inventoryArtifactFigure, inventoryActionButtonModule) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  // Marks under a sent prompt: a quiet caption line, a 12 px icon and a few words each.
  const SKILL_ICON = '<svg class="message-mark-icon message-mark-icon--fill" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l1.6 4.2L14 7.5l-4.4 1.8L8 13.5 6.4 9.3 2 7.5l4.4-1.8z"/></svg>';
  const IMAGE_ICON = '<svg class="message-mark-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2"/><path d="m2.5 11 3.5-3.5 3 3 2-2 2.5 2.5"/></svg>';
  const BOARD_ICON = '<svg class="message-mark-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2"/><rect x="4.5" y="5" width="3" height="3" rx=".6"/><rect x="9" y="7.5" width="2.5" height="3.5" rx=".6"/></svg>';
  // "{name} board", except a name that already ends in the whole word ("New board") stands alone.
  function boardMarkLabel(boardName) {
    if (/(^|[^\p{L}\p{N}_])board$/iu.test(String(boardName).trim())) return boardName;
    return jt('chat.messageMark.board', '{name} board', { name: boardName });
  }
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

  // "640 B", "4.2 KB", "18 KB", "1.3 MB"; '' when unknown.
  function formatAttachmentSize(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '';
    if (value < 1024) return `${Math.round(value)} B`;
    const kb = value / 1024;
    if (kb < 10) return `${kb.toFixed(1)} KB`;
    if (kb < 1024) return `${Math.round(kb)} KB`;
    return `${(kb / 1024).toFixed(1)} MB`;
  }

  // A text file's type word: letters and digits, at most 4, upper case.
  function attachmentTypeLabel(attachment) {
    const raw = String(attachment?.extension || '').trim() || (String(attachment?.displayName || '').match(/\.([A-Za-z0-9]+)$/) || [])[1] || '';
    return raw.replace(/^\./, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase();
  }

  function createTranscriptAttachmentsRenderer(deps) {
    const { escapeHtml } = deps || {};

    function actionButtonRef() {
      return inventoryActionButtonModule || (typeof globalThis.inventoryActionButton === 'function' ? globalThis.inventoryActionButton : null);
    }

    function unavailableMedia(kind) {
      const label = kind === 'audio' ? jt('chat.attachments.audioUnavailable', 'Audio unavailable') : jt('artifacts.image.unavailable', 'Image unavailable');
      return `<div class="message-attachment-card message-attachment-unavailable" role="status">${escapeHtml(label)}</div>`;
    }

    function markSpan(kind, icon, labelHtml, title) {
      return `<span class="message-mark" data-message-mark="${kind}" title="${escapeHtml(title)}">${icon}<span class="message-mark-label">${labelHtml}</span></span>`;
    }

    // Order: what the person chose (skill, /image), then where it came from (board).
    function renderMarks(message) {
      const marks = [];
      const skill = message?.skill_invocation;
      const skillName = String(skill?.name || '').trim();
      if (skillName) {
        const command = String(skill?.command || '').trim();
        marks.push(markSpan('skill', SKILL_ICON,
          `<span class="sr-only">${escapeHtml(jt('chat.messageMark.skillPrefix', 'Skill:'))} </span>${escapeHtml(command ? jt('chat.messageMark.skill', '/{command}', { command }) : skillName)}`,
          jt('chat.messageMark.skillTitle', 'Sent with the {name} skill', { name: skillName })));
      }
      if (message?.role === 'user' && message?.image_prompt_pin) {
        marks.push(markSpan('image', IMAGE_ICON, escapeHtml(jt('chat.messageMark.image', 'Drawn as written')),
          jt('chat.messageMark.imageTitle', 'The prompt went to the image model unchanged')));
      }
      // Named once the Board page has shown the board in this run. renderer-board-block-row.js reads
      // data-message-mark="board" to tell a board turn: keep it on both forms.
      if (message?.role === 'user' && message?.board_id) {
        const boardId = String(message.board_id);
        const boardName = String(globalThis.rendererChatSurfaceLiveUtils?.boardNameOf?.(boardId) || '');
        const makeButton = actionButtonRef();
        if (boardName && makeButton) {
          marks.push(makeButton({
            plain: true,
            className: 'message-mark message-mark--link',
            title: jt('chat.messageMark.boardOpenTitle', 'Open this board'),
            dataset: { 'message-mark': 'board', 'board-id': boardId },
            trustedHtml: `${BOARD_ICON}<span class="message-mark-label">${escapeHtml(boardMarkLabel(boardName))}</span>`,
          }));
        } else {
          marks.push(markSpan('board', BOARD_ICON, escapeHtml(jt('chat.messageMark.boardUnnamed', 'From a board')),
            jt('chat.messageMark.boardUnnamedTitle', 'Sent with the board beside it')));
        }
      }
      return marks.length ? `<div class="message-marks">${marks.join('')}</div>` : '';
    }

    function renderTextFile(attachment) {
      const name = String(attachment?.displayName || '').trim() || jt('chat.attachments.attachment', 'Attachment');
      const type = attachmentTypeLabel(attachment);
      const meta = [type, formatAttachmentSize(attachment?.sizeBytes)].filter(Boolean);
      if (attachment?.truncated) meta.push(jt('chat.attachments.firstPartOnly', 'first part only'));
      const metaText = meta.length ? meta.join(' · ') : jt('chat.attachments.textAttachment', 'text attachment');
      return `<div class="message-file" title="${escapeHtml(name)}"><svg class="message-file-icon" viewBox="0 0 30 36" aria-hidden="true"><path class="message-file-icon-sheet" d="M4 1.5h15l7.5 7.5v24a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-29.5a2 2 0 0 1 2-2z"/><path class="message-file-icon-fold" d="M19 1.5V9h7.5"/>${type ? `<text x="14.5" y="27" text-anchor="middle" font-size="7.5">${escapeHtml(type)}</text>` : ''}</svg>`
        + `<span class="message-file-copy"><span class="message-file-name" dir="auto">${escapeHtml(name)}</span><span class="message-file-meta">${escapeHtml(metaText)}</span></span></div>`;
    }

    function renderFile(attachment) {
      const isImage = String(attachment?.kind || '').trim() === 'image';
      const isAudio = String(attachment?.kind || '').trim() === 'audio';
      const mediaUrl = isImage || isAudio ? toFileAssetUrl(attachment?.assetPath) : '';
      if (isImage) {
        if (!mediaUrl) {
          return unavailableMedia('image');
        }
        const name = attachment.displayName || jt('artifacts.image.attachment', 'Image attachment');
        return inventoryArtifactFigure ? inventoryArtifactFigure.renderSourceFigure({
          kind: 'attachment', id: String(attachment.id || '').trim(), sessionId: '', src: mediaUrl, alt: name, caption: name,
          labels: {
            viewAria: jt('chat.artifactFigure.viewAria', 'View {title}', { title: name }),
            unavailable: jt('chat.artifactFigure.unavailable', 'Image unavailable'),
            copy: jt('chat.artifactFigure.copyImage', 'Copy image'),
            saveAs: jt('chat.artifactFigure.saveAs', 'Save as…'),
            actions: jt('chat.artifactFigure.actions', 'Image actions'),
          },
        }) : unavailableMedia('image');
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
            <div class="message-attachment-label">${escapeHtml(attachment.displayName || jt('chat.attachments.audioAttachment', 'Audio attachment'))}</div>
            <div class="message-attachment-meta">${escapeHtml(
              attachment.transcriptStatus === 'complete'
                ? jt('chat.attachments.voiceTranscriptReady', 'voice attachment - transcript ready')
                : attachment.transcriptStatus === 'error'
                  ? jt('chat.attachments.voiceTranscriptFailed', 'voice attachment - transcript failed')
                  : jt('chat.attachments.voiceAttachment', 'voice attachment')
            )}</div>
          </div>
        `;
      }
      return renderTextFile(attachment);
    }

    function renderMessageAttachments(message) {
      const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
      const marks = renderMarks(message);
      if (!attachments.length && !marks) {
        return '';
      }
      const files = attachments.length ? `<div class="message-files">${attachments.map(renderFile).join('')}</div>` : '';
      return `<div class="message-attachments">${marks}${files}</div>`;
    }

    return {
      renderMessageAttachments,
    };
  }

  return {
    createTranscriptAttachmentsRenderer,
    toFileAssetUrl,
  };
});
