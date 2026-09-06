/* renderer/chat/renderer-chat-bulk-actions-utils.js
 * Implements copy, export, and truncate actions for selected chat messages.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../shared/string-utils'),
      require('./renderer-chat-message-edit-utils')
    );
    return;
  }
  root.rendererChatBulkActionsUtils = factory(
    root.stringUtils,
    root.rendererChatMessageEditUtils
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils, messageEditUtils) {
  'use strict';

  var MAX_RECOMMENDED_EXPORT_BYTES = 5 * 1024 * 1024;
  var MAX_HARD_EXPORT_BYTES = 250 * 1024 * 1024;

  function noopFn() { /* no-op */ }

  var normalizeId = stringUtils && typeof stringUtils.normalizeId === 'function'
    ? stringUtils.normalizeId
    : function (value) { return String(value || '').trim(); };

  var purgeChatSessionCaches = messageEditUtils && typeof messageEditUtils.purgeChatSessionCaches === 'function'
    ? messageEditUtils.purgeChatSessionCaches
    : noopFn;

  function byteLength(content) {
    if (content == null) return 0;
    return new TextEncoder().encode(String(content)).length;
  }

  function sanitizeFilenameSlug(title) {
    var raw = String(title || '').trim().toLowerCase();
    if (!raw) return 'untitled-session';
    var slug = raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) return 'untitled-session';
    return slug.slice(0, 60);
  }

  function isoDateOnly() {
    var d = new Date();
    var yyyy = d.getUTCFullYear();
    var mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    var dd = String(d.getUTCDate()).padStart(2, '0');
    return yyyy + '-' + mm + '-' + dd;
  }

  function pickSelectedMessages(allMessages, selectedIds) {
    if (!Array.isArray(allMessages) || !allMessages.length) return [];
    if (!Array.isArray(selectedIds) || !selectedIds.length) return [];
    var set = new Set(selectedIds.map(normalizeId).filter(Boolean));
    if (!set.size) return [];
    var picked = [];
    for (var i = 0; i < allMessages.length; i += 1) {
      var message = allMessages[i];
      if (!message || typeof message !== 'object') continue;
      var id = normalizeId(message.id);
      if (id && set.has(id)) picked.push(message);
    }
    return picked;
  }

  function findEarliestSelectedMessage(allMessages, selectedIds) {
    if (!Array.isArray(allMessages) || !allMessages.length) return null;
    if (!Array.isArray(selectedIds) || !selectedIds.length) return null;
    var set = new Set(selectedIds.map(normalizeId).filter(Boolean));
    if (!set.size) return null;
    for (var i = 0; i < allMessages.length; i += 1) {
      var message = allMessages[i];
      if (!message || typeof message !== 'object') continue;
      var id = normalizeId(message.id);
      if (id && set.has(id)) return message;
    }
    return null;
  }

  function pluralizeMessage(count) {
    return count + (count === 1 ? ' message' : ' messages');
  }

  function createBulkActionsController(deps) {
    var settings = deps || {};
    if (!settings.state || typeof settings.state !== 'object') {
      throw new TypeError('createBulkActionsController requires `state`.');
    }
    var state = settings.state;
    var jennyShellSessions = settings.jennyShellSessions || null;
    var jennyShellDialog = settings.jennyShellDialog || null;
    var jennyShellClipboard = settings.jennyShellClipboard || null;
    var getCurrentSessionId = typeof settings.getCurrentSessionId === 'function'
      ? settings.getCurrentSessionId : function () { return ''; };
    var getCurrentSessionMessages = typeof settings.getCurrentSessionMessages === 'function'
      ? settings.getCurrentSessionMessages : function () { return []; };
    var getCurrentSessionTurnEvents = typeof settings.getCurrentSessionTurnEvents === 'function'
      ? settings.getCurrentSessionTurnEvents : function () { return []; };
    var getCurrentSessionMeta = typeof settings.getCurrentSessionMeta === 'function'
      ? settings.getCurrentSessionMeta : function () { return {}; };
    var selectionController = settings.selectionController || null;
    var conversationFormatUtils = settings.conversationFormatUtils
      || (typeof globalThis !== 'undefined' ? globalThis.conversationFormatUtils : null);
    var renderAll = typeof settings.renderAll === 'function' ? settings.renderAll : noopFn;
    var appendClientLog = typeof settings.appendClientLog === 'function'
      ? settings.appendClientLog : noopFn;
    var showToastMessage = typeof settings.showToastMessage === 'function'
      ? settings.showToastMessage : noopFn;
    var clearProjectionContextCacheForSession =
      typeof settings.clearProjectionContextCacheForSession === 'function'
        ? settings.clearProjectionContextCacheForSession : noopFn;
    var confirmDelete = typeof settings.confirmDelete === 'function'
      ? settings.confirmDelete
      : function defaultConfirm() { return Promise.resolve(true); };
    var pendingDeleteOperation = null;
    var disposed = false;

    function getSelectedIds() {
      if (!selectionController || typeof selectionController.getSelectedMessageIds !== 'function') {
        return [];
      }
      var ids = selectionController.getSelectedMessageIds() || [];
      return Array.isArray(ids) ? ids : [];
    }

    function refreshActionBarCount() {
      if (selectionController && typeof selectionController.syncActionBar === 'function') {
        try { selectionController.syncActionBar(); } catch (_e) { /* ignore */ }
      }
    }

    function ensureFormatUtils(action) {
      if (conversationFormatUtils
        && typeof conversationFormatUtils.buildMarkdown === 'function'
        && typeof conversationFormatUtils.buildPlainText === 'function'
        && typeof conversationFormatUtils.buildJson === 'function') {
        return conversationFormatUtils;
      }
      showToastMessage('Conversation export helpers are not available.', { tone: 'danger', title: action });
      return null;
    }

    function thresholdGuard(content, action) {
      var bytes = byteLength(content);
      if (bytes > MAX_HARD_EXPORT_BYTES) {
        showToastMessage(
          'Selected content exceeds 250 MB — refusing to export. Narrow the selection.',
          { tone: 'danger', title: action }
        );
        return { ok: false, bytes };
      }
      if (bytes > MAX_RECOMMENDED_EXPORT_BYTES) {
        showToastMessage(
          'Selected content is larger than 5 MB. The export may take a moment.',
          { tone: 'warning', title: action }
        );
      }
      return { ok: true, bytes };
    }

    function writeToClipboard(text, action, successMessage) {
      if (!jennyShellClipboard || typeof jennyShellClipboard.writeText !== 'function') {
        showToastMessage('Clipboard bridge is not available.', { tone: 'danger', title: action });
        return Promise.resolve(false);
      }
      return Promise.resolve()
        .then(function () { return jennyShellClipboard.writeText(String(text || '')); })
        .then(function () {
          showToastMessage(successMessage, { tone: 'success', title: action });
          appendClientLog('INFO', 'chat.bulk_copy', { action, length: String(text || '').length });
          return true;
        })
        .catch(function (error) {
          appendClientLog('ERROR', 'chat.bulk_copy_failed', {
            action,
            message: (error && error.message) || String(error),
          });
          showToastMessage('Copy failed: ' + ((error && error.message) || String(error)), {
            tone: 'danger',
            title: action,
          });
          return false;
        });
    }

    function runCopy(options) {
      var action = options.action;
      var builderName = options.builder;
      var formatLabel = options.formatLabel;
      var ids = getSelectedIds();
      if (!ids.length) return Promise.resolve(false);
      var utils = ensureFormatUtils(action);
      if (!utils) return Promise.resolve(false);
      var selected = pickSelectedMessages(getCurrentSessionMessages(), ids);
      if (!selected.length) return Promise.resolve(false);
      var content = utils[builderName](selected);
      var guard = thresholdGuard(content, action);
      if (!guard.ok) return Promise.resolve(false);
      return writeToClipboard(
        content,
        action,
        'Copied ' + pluralizeMessage(selected.length) + ' as ' + formatLabel + '.'
      );
    }

    function copyAsMarkdown() {
      return runCopy({ action: 'Copy as Markdown', builder: 'buildMarkdown', formatLabel: 'Markdown' });
    }

    function copyAsPlainText() {
      return runCopy({ action: 'Copy as text', builder: 'buildPlainText', formatLabel: 'plain text' });
    }

    function saveFile(payload, action) {
      if (!jennyShellDialog || typeof jennyShellDialog.saveFile !== 'function') {
        showToastMessage('Save-file bridge is not available.', { tone: 'danger', title: action });
        return Promise.resolve(null);
      }
      return Promise.resolve()
        .then(function () { return jennyShellDialog.saveFile(payload); })
        .then(function (result) {
          if (!result || result.canceled) {
            appendClientLog('INFO', 'chat.bulk_export_canceled', { action });
            return result || { canceled: true };
          }
          showToastMessage('Saved to ' + result.path, { tone: 'success', title: action });
          appendClientLog('INFO', 'chat.bulk_export', {
            action,
            path: result.path,
            bytesWritten: result.bytesWritten || 0,
          });
          return result;
        })
        .catch(function (error) {
          appendClientLog('ERROR', 'chat.bulk_export_failed', {
            action,
            message: (error && error.message) || String(error),
          });
          showToastMessage(
            'Export failed: ' + ((error && error.message) || String(error)),
            { tone: 'danger', title: action }
          );
          return null;
        });
    }

    function buildDefaultName(extension) {
      var meta = getCurrentSessionMeta() || {};
      var slug = sanitizeFilenameSlug(meta.title || meta.id || '');
      return 'jenny-' + slug + '-' + isoDateOnly() + '.' + extension;
    }

    function runExport(options) {
      var action = options.action;
      var extension = options.extension;
      var format = options.format;
      var buildContent = options.buildContent;
      var ids = getSelectedIds();
      if (!ids.length) return Promise.resolve(null);
      var utils = ensureFormatUtils(action);
      if (!utils) return Promise.resolve(null);
      var content = buildContent(utils, ids);
      if (content == null) return Promise.resolve(null);
      var guard = thresholdGuard(content, action);
      if (!guard.ok) return Promise.resolve(null);
      return saveFile({
        defaultName: buildDefaultName(extension),
        content,
        format,
      }, action);
    }

    function exportMarkdown() {
      return runExport({
        action: 'Export Markdown',
        extension: 'md',
        format: 'markdown',
        buildContent: function (utils, ids) {
          var selected = pickSelectedMessages(getCurrentSessionMessages(), ids);
          return selected.length ? utils.buildMarkdown(selected) : null;
        },
      });
    }

    function exportPlainText() {
      return runExport({
        action: 'Export plain text',
        extension: 'txt',
        format: 'plain',
        buildContent: function (utils, ids) {
          var selected = pickSelectedMessages(getCurrentSessionMessages(), ids);
          return selected.length ? utils.buildPlainText(selected) : null;
        },
      });
    }

    function exportTurnEventJson() {
      return runExport({
        action: 'Export turn-event JSON',
        extension: 'json',
        format: 'json',
        buildContent: function (utils, ids) {
          var meta = getCurrentSessionMeta() || {};
          return utils.buildJson(
            getCurrentSessionTurnEvents() || [],
            meta,
            { messageIdScope: ids, scope: 'selected' }
          );
        },
      });
    }

    function exportSessionJsonPortable() {
      var sessionId = normalizeId(getCurrentSessionId());
      if (!sessionId) return Promise.resolve(null);
      if (!jennyShellSessions || typeof jennyShellSessions.exportSession !== 'function') {
        showToastMessage('Session export bridge is not available.', {
          tone: 'danger', title: 'Export Session JSON',
        });
        return Promise.resolve(null);
      }
      var selectedIds = getSelectedIds();
      if (selectedIds.length) {
        try {
          showToastMessage(
            'Session JSON exports the whole session, not just the selection.',
            { tone: 'info', title: 'Export Session JSON' }
          );
        } catch (_) { /* best-effort */ }
      }
      return Promise.resolve()
        .then(function () { return jennyShellSessions.exportSession(sessionId); })
        .then(function (jsonString) {
          if (!jsonString) {
            showToastMessage('Session export returned no data.', {
              tone: 'danger', title: 'Export Session JSON',
            });
            return null;
          }
          var guard = thresholdGuard(jsonString, 'Export Session JSON');
          if (!guard.ok) return null;
          return saveFile({
            defaultName: buildDefaultName('json'),
            content: jsonString,
            format: 'session-json',
          }, 'Export Session JSON');
        })
        .catch(function (error) {
          appendClientLog('ERROR', 'chat.session_export_failed', {
            message: (error && error.message) || String(error),
          });
          showToastMessage('Export failed: ' + ((error && error.message) || String(error)), {
            tone: 'danger', title: 'Export Session JSON',
          });
          return null;
        });
    }

    function invalidateRendererCachesForSession(sessionId) {
      purgeChatSessionCaches(state, sessionId, clearProjectionContextCacheForSession);
    }

    function setBulkTruncateCommitting(value) {
      if (!state.ui || typeof state.ui !== 'object') {
        state.ui = {};
      }
      state.ui.bulkTruncateCommitting = value === true;
      refreshActionBarCount();
    }

    function deleteFromHere() {
      if (disposed) return Promise.resolve(null);
      if (pendingDeleteOperation) return pendingDeleteOperation;
      var ids = getSelectedIds();
      if (!ids.length) return Promise.resolve(null);
      var sessionId = normalizeId(getCurrentSessionId());
      if (!sessionId) return Promise.resolve(null);
      if (!jennyShellSessions || typeof jennyShellSessions.editAndTruncate !== 'function') {
        showToastMessage('Truncate bridge is not available.', {
          tone: 'danger', title: 'Delete from here',
        });
        return Promise.resolve(null);
      }
      var messages = getCurrentSessionMessages() || [];
      var earliest = findEarliestSelectedMessage(messages, ids);
      if (!earliest) return Promise.resolve(null);
      var earliestId = normalizeId(earliest.id);
      if (!earliestId) return Promise.resolve(null);
      var earliestIndex = Array.isArray(messages)
        ? messages.findIndex(function (message) { return normalizeId(message && message.id) === earliestId; })
        : -1;
      var truncateCount = earliestIndex >= 0 ? Math.max(messages.length - earliestIndex, 1) : 1;
      var promptText = 'Delete '
        + pluralizeMessage(truncateCount)
        + ' from the earliest selected message onward? '
        + String(ids.length)
        + ' selected messages. This removes the earliest selected row and all later history, including unselected trailing messages.';
      setBulkTruncateCommitting(true);
      pendingDeleteOperation = Promise.resolve()
        .then(function () { return confirmDelete(promptText); })
        .then(function (confirmed) {
          if (!confirmed) {
            appendClientLog('INFO', 'chat.bulk_delete_canceled', { sessionId, earliestId });
            return null;
          }
          return Promise.resolve()
            .then(function () { return jennyShellSessions.editAndTruncate(sessionId, earliestId, {}); })
            .then(function (summary) {
              if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
                throw new Error('Truncate failed to apply on the backend.');
              }
              if (disposed) return summary;
              invalidateRendererCachesForSession(sessionId);
              appendClientLog('INFO', 'chat.bulk_delete', {
                sessionId,
                earliestId,
                selectedCount: ids.length,
                truncatedCount: truncateCount,
              });
              if (selectionController && typeof selectionController.exitSelectMode === 'function') {
                try { selectionController.exitSelectMode(); } catch (_e) { /* ignore */ }
              }
              showToastMessage('Deleted ' + pluralizeMessage(truncateCount)
                + ' from the earliest selection onward (' + ids.length + ' selected).', {
                tone: 'success', title: 'Delete from here',
              });
              try { renderAll(); } catch (_e) { /* ignore */ }
              return summary;
            });
        })
        .catch(function (error) {
          if (disposed) return null;
          appendClientLog('ERROR', 'chat.bulk_delete_failed', {
            sessionId,
            earliestId,
            message: (error && error.message) || String(error),
          });
          showToastMessage('Delete failed: ' + ((error && error.message) || String(error)), {
            tone: 'danger', title: 'Delete from here',
          });
          return null;
        })
        .finally(function () {
          pendingDeleteOperation = null;
          if (!disposed) setBulkTruncateCommitting(false);
        });
      return pendingDeleteOperation;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (state.ui && typeof state.ui === 'object') state.ui.bulkTruncateCommitting = false;
    }

    return {
      copyAsMarkdown,
      copyAsPlainText,
      exportMarkdown,
      exportPlainText,
      exportTurnEventJson,
      exportSessionJsonPortable,
      deleteFromHere,
      dispose,
      refreshActionBarCount,
      _internal: {
        sanitizeFilenameSlug,
        byteLength,
        pickSelectedMessages,
        findEarliestSelectedMessage,
        MAX_RECOMMENDED_EXPORT_BYTES,
        MAX_HARD_EXPORT_BYTES,
      },
    };
  }

  return {
    createBulkActionsController,
    sanitizeFilenameSlug,
    byteLength,
    pickSelectedMessages,
    findEarliestSelectedMessage,
    MAX_RECOMMENDED_EXPORT_BYTES,
    MAX_HARD_EXPORT_BYTES,
  };
});
