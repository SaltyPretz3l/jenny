/* renderer/shared/conversation-format-utils.js – F4/F5/F6 conversation export/copy formatters (UMD).
 *
 * Pure formatters that turn an in-memory list of chat messages (and optionally
 * the per-session turn_event audit trail) into Markdown / plain text / JSON
 * suitable for clipboard or file output. No DOM access, no IPC.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.conversationFormatUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SKIPPED_KINDS_DEFAULT = new Set(['question_batch', 'interactive_round_recap']);
  const EXPORT_FORMAT_VERSION = 1;

  function normalizeString(value) {
    return String(value == null ? '' : value);
  }

  function formatTimestamp(value) {
    if (value == null || value === '') return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return normalizeString(value);
    }
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    const hh = String(date.getUTCHours()).padStart(2, '0');
    const mn = String(date.getUTCMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mn}Z`;
  }

  function shortTimestamp(value) {
    if (value == null || value === '') return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const hh = String(date.getUTCHours()).padStart(2, '0');
    const mn = String(date.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mn}`;
  }

  function escapeMarkdownToken(value) {
    // Escape only characters that would break a header line interpolation.
    return normalizeString(value).replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
  }

  function roleLabel(role) {
    const normalized = normalizeString(role).toLowerCase();
    if (normalized === 'assistant') return 'Jenny';
    if (normalized === 'user') return 'You';
    if (normalized === 'system') return 'System';
    if (normalized === 'tool') return 'Tool';
    if (normalized.length) return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    return 'Message';
  }

  function isSkippedKind(message, skippedKinds) {
    const kind = normalizeString(message && message.kind).trim();
    if (!kind) return false;
    return skippedKinds.has(kind);
  }

  function collectAttachmentNames(message) {
    const attachments = Array.isArray(message && message.attachments) ? message.attachments : [];
    const names = [];
    for (const attachment of attachments) {
      if (!attachment || typeof attachment !== 'object') continue;
      const name = normalizeString(
        attachment.displayName || attachment.fileName || attachment.id
      ).trim();
      if (name) names.push(name);
    }
    return names;
  }

  function collectReasoningEntries(message) {
    const reasoning = message && message.reasoning;
    if (!reasoning || typeof reasoning !== 'object') return [];
    const entries = Array.isArray(reasoning.entries) ? reasoning.entries : [];
    const lines = [];
    for (const entry of entries) {
      const text = normalizeString(entry && entry.text).trim();
      if (text) lines.push(text);
    }
    return lines;
  }

  function resolveContentString(message) {
    if (!message || typeof message !== 'object') return '';
    const segments = Array.isArray(message.visible_segments) ? message.visible_segments : [];
    if (segments.length) {
      const joined = segments
        .map((segment) => normalizeString(segment && segment.text))
        .filter((text) => text.length > 0)
        .join('');
      if (joined) return joined;
    }
    return normalizeString(message.content);
  }

  function buildMarkdown(messages, options) {
    const opts = (options && typeof options === 'object') ? options : {};
    const includeReasoning = opts.includeReasoning === true;
    const includeAttachmentNames = opts.includeAttachmentNames !== false;
    const skippedKinds = opts.includeKinds && opts.includeKinds instanceof Set
      ? new Set([...SKIPPED_KINDS_DEFAULT].filter((kind) => !opts.includeKinds.has(kind)))
      : SKIPPED_KINDS_DEFAULT;
    const list = Array.isArray(messages) ? messages : [];

    const sections = [];
    for (const message of list) {
      if (!message || typeof message !== 'object') continue;
      if (isSkippedKind(message, skippedKinds)) continue;

      const role = escapeMarkdownToken(roleLabel(message.role));
      const ts = escapeMarkdownToken(formatTimestamp(message.timestamp || message.finalizedAt));
      const header = ts ? `## ${role} · ${ts}` : `## ${role}`;
      const lines = [header, ''];

      if (includeReasoning) {
        const reasoning = collectReasoningEntries(message);
        if (reasoning.length) {
          for (const block of reasoning) {
            for (const inner of block.split(/\n/)) {
              lines.push(`> ${inner}`);
            }
            lines.push('>');
          }
          // Trim the trailing blockquote separator.
          while (lines.length && lines[lines.length - 1] === '>') {
            lines.pop();
          }
          lines.push('');
        }
      }

      const content = resolveContentString(message);
      if (content) {
        lines.push(content);
      }

      if (includeAttachmentNames) {
        const names = collectAttachmentNames(message);
        if (names.length) {
          lines.push('');
          lines.push(`**Attachments:** ${names.join(', ')}`);
        }
      }

      sections.push(lines.join('\n').replace(/\n+$/, ''));
    }

    return sections.join('\n\n');
  }

  function buildPlainText(messages, options) {
    const opts = (options && typeof options === 'object') ? options : {};
    const includeAttachmentNames = opts.includeAttachmentNames !== false;
    const skippedKinds = opts.includeKinds && opts.includeKinds instanceof Set
      ? new Set([...SKIPPED_KINDS_DEFAULT].filter((kind) => !opts.includeKinds.has(kind)))
      : SKIPPED_KINDS_DEFAULT;
    const list = Array.isArray(messages) ? messages : [];

    const sections = [];
    for (const message of list) {
      if (!message || typeof message !== 'object') continue;
      if (isSkippedKind(message, skippedKinds)) continue;

      const role = roleLabel(message.role);
      const tsShort = shortTimestamp(message.timestamp || message.finalizedAt);
      const prefix = tsShort ? `[${role} ${tsShort}]` : `[${role}]`;
      const content = resolveContentString(message);
      const lines = [prefix];
      if (content) lines.push(content);

      if (includeAttachmentNames) {
        const names = collectAttachmentNames(message);
        if (names.length) {
          lines.push(`Attachments: ${names.join(', ')}`);
        }
      }

      sections.push(lines.join('\n'));
    }

    return sections.join('\n\n');
  }

  function extractEventMessageIds(event) {
    if (!event || typeof event !== 'object') return [];
    const ids = [];
    const candidates = [
      event.primary_message_id,
      event.primaryMessageId,
      event.message_id,
      event.messageId,
      event.payload && event.payload.message_id,
      event.payload && event.payload.messageId,
      event.payload && event.payload.primary_message_id,
      event.payload && event.payload.primaryMessageId,
    ];
    for (const candidate of candidates) {
      const normalized = normalizeString(candidate).trim();
      if (normalized) ids.push(normalized);
    }
    if (Array.isArray(event.source_message_ids)) {
      for (const candidate of event.source_message_ids) {
        const normalized = normalizeString(candidate).trim();
        if (normalized) ids.push(normalized);
      }
    }
    return ids;
  }

  function buildJson(turnEvents, sessionMeta, options) {
    const opts = (options && typeof options === 'object') ? options : {};
    const meta = (sessionMeta && typeof sessionMeta === 'object') ? sessionMeta : {};
    const events = Array.isArray(turnEvents) ? turnEvents : [];

    const explicitScope = normalizeString(opts.scope).toLowerCase();
    const messageIdScope = Array.isArray(opts.messageIdScope)
      ? opts.messageIdScope.map((id) => normalizeString(id).trim()).filter(Boolean)
      : [];
    const scope = explicitScope === 'all' || messageIdScope.length === 0 ? 'all' : 'selected';

    let filteredEvents = events;
    if (scope === 'selected') {
      const scopeSet = new Set(messageIdScope);
      filteredEvents = events.filter((event) => {
        const ids = extractEventMessageIds(event);
        if (!ids.length) return false;
        return ids.some((id) => scopeSet.has(id));
      });
    }

    const payload = {
      format: 'jenny-turn-event-log',
      format_version: EXPORT_FORMAT_VERSION,
      exported_at: new Date().toISOString(),
      session: {
        id: normalizeString(meta.id || meta.sessionId).trim(),
        title: normalizeString(meta.title).trim(),
        created_at: normalizeString(meta.created_at || meta.createdAt).trim(),
      },
      scope,
      messageIdScope,
      turnEvents: filteredEvents,
    };

    return JSON.stringify(payload, null, 2);
  }

  return {
    buildMarkdown,
    buildPlainText,
    buildJson,
    formatTimestamp,
    shortTimestamp,
    roleLabel,
    escapeMarkdownToken,
    EXPORT_FORMAT_VERSION,
  };
});
