(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); return; }
  root.rendererSettingsConversationTransfer = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback
    || ((key, fallback, params) => String(fallback).replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match));

  // Main-process transfer messages stay the English fallback; known reasons and preview
  // disclosures are translated here, unknown ones render as the main process sent them.
  function failureMessage(result) {
    const stopped = jt('settings.transfer.error.codexStopped', "Codex stopped before the request completed.");
    const messages = {
      source_busy: jt('settings.transfer.error.sourceBusy', "Wait for this conversation to settle before copying."),
      source_missing: jt('settings.transfer.error.sourceMissing', "This conversation no longer exists."),
      source_changed: jt('settings.transfer.error.sourceChanged', "The source changed after preview. Preview it again."),
      empty_source: jt('settings.transfer.error.emptySource', "This conversation has no transferable dialogue."),
      preview_expired: jt('settings.transfer.error.previewExpired', "Preview this conversation again before copying."),
      transfer_busy: jt('settings.transfer.error.transferBusy', "Wait for the current copy to finish."),
      unfinished_transfer: jt('settings.transfer.error.unfinishedTransfer', "Resolve the unfinished copy before copying again."),
      snapshot_unavailable: jt('settings.transfer.error.snapshotUnavailable', "The saved transfer snapshot is unavailable. No duplicate was created."),
      snapshot_write_failed: jt('settings.transfer.error.snapshotWriteFailed', "The transfer snapshot could not be saved."),
      snapshot_too_large: jt('settings.transfer.error.snapshotTooLarge', "This conversation exceeds the single-chat transfer limit."),
      asset_limit: jt('settings.transfer.error.assetLimit', "This chat exceeds the attachment transfer limit."),
      invalid_asset: jt('settings.transfer.error.invalidAsset', "Attachment bytes are invalid or too large."),
      unsafe_asset_path: jt('settings.transfer.error.unsafeAssetPath', "A transfer folder or file was redirected or changed."),
      invalid_request: jt('settings.transfer.error.invalidRequest', "Select a valid conversation and preview it before copying."),
      destination_missing: jt('settings.transfer.error.destinationMissing', "The copied destination no longer exists. Choose Copy again to create another."),
      destination_persist_failed: jt('settings.transfer.error.destinationPersistFailed', "The copied conversation is not durable yet. Retry the saved transfer."),
      receipt_store_unavailable: jt('settings.transfer.error.receiptStoreUnavailable', "Transfer receipts are unreadable. Restore them before copying again."),
      receipt_write_failed: jt('settings.transfer.error.receiptWriteFailed', "The transfer receipt could not be saved."),
      receipt_limit: jt('settings.transfer.error.receiptLimit', "Resolve unfinished transfers before starting another."),
      outcome_unknown: jt('settings.transfer.error.outcomeUnknown', "Codex has not confirmed this import. Retry later; no second chat was created."),
      codex_import_failed: jt('settings.transfer.error.codexImportFailed', "Codex could not import this conversation. Retry the saved copy."),
      codex_api_incompatible: jt('settings.transfer.error.codexApiIncompatible', "This Codex version cannot read or import this conversation."),
      context_outcome_unknown: jt('settings.transfer.error.contextOutcomeUnknown', "Codex did not confirm the copied image context; the images may already have been added. Check the Codex thread before copying again."),
      // An admitted import whose completion never arrived keeps its reconciliation guidance.
      codex_timeout: result?.message === 'Codex import completion is unknown. Retry to reconcile it.'
        ? jt('settings.transfer.error.importCompletionUnknown', "Codex import completion is unknown. Retry to reconcile it.")
        : jt('settings.transfer.error.codexTimeout', "Codex did not complete the request in time."),
      attachment_failed: jt('settings.transfer.error.attachmentFailed', "Session import failed while restoring image attachment."),
      codex_api_error: jt('settings.transfer.error.codexApiError', "Codex refused the transfer request."),
      codex_unavailable: jt('settings.transfer.error.codexUnavailable', "The native Codex app server could not start."),
      codex_exited: stopped, codex_invalid_output: stopped, codex_output_limit: stopped, codex_write_failed: stopped,
      disposed: jt('settings.transfer.error.disposed', "Conversation transfer is closed."),
    };
    const reason = String(result?.reason || '');
    if (Object.prototype.hasOwnProperty.call(messages, reason)) return messages[reason];
    return result?.message || jt('settings.transfer.unavailable', "Conversation transfer is unavailable.");
  }
  const PATTERNED_DISCLOSURES = [
    [/^Linked attachment unavailable or unsupported: (.*)$/s, (name) => jt('settings.transfer.warning.linkedUnavailable', "Linked attachment unavailable or unsupported: {name}", { name })],
    [/^Unsupported user attachment: (.*)$/s, (type) => jt('settings.transfer.warning.unsupportedAttachment', "Unsupported user attachment: {type}", { type })],
    [/^Unsupported history item omitted: (.*)$/s, (type) => jt('settings.transfer.warning.unsupportedItem', "Unsupported history item omitted: {type}", { type })],
    [/^Audio attachment copied as a file; playback and transcription are not replayed: (.*)$/s, (name) => jt('settings.transfer.warning.audioFile', "Audio attachment copied as a file; playback and transcription are not replayed: {name}", { name })],
    [/^Original attachment unavailable: (.*)\. Only retained conversation text will be copied\.$/s, (name) => jt('settings.transfer.warning.originalUnavailable', "Original attachment unavailable: {name}. Only retained conversation text will be copied.", { name })],
    [/^Original generated artifact not retained by session export: (.*)$/s, (name) => jt('settings.transfer.warning.artifactNotRetained', "Original generated artifact not retained by session export: {name}", { name })],
    [/^This resumes the saved snapshot from (.*)\.$/s, (time) => jt('settings.transfer.warning.resumed', "This resumes the saved snapshot from {time}.", { time })],
  ];
  function disclosure(text) {
    const value = String(text ?? '');
    switch (value) {
      case 'Original user image is unavailable or outside source storage.': return jt('settings.transfer.warning.userImageUnavailable', "Original user image is unavailable or outside source storage.");
      case 'Generated image is unavailable or unsupported.': return jt('settings.transfer.warning.generatedImageUnavailable', "Generated image is unavailable or unsupported.");
      case 'Unfinished tool activity was omitted.': return jt('settings.transfer.warning.unfinishedTool', "Unfinished tool activity was omitted.");
      case 'Pending work, questions and approvals are omitted.': return jt('settings.transfer.warning.pendingOmitted', "Pending work, questions and approvals are omitted.");
      case 'Completed tools become readable text; commands and approvals never replay.': return jt('settings.transfer.warning.toolsAsText', "Completed tools become readable text; commands and approvals never replay.");
      case 'Copied images and files appear in an attachment appendix. Sensitive conversation text is redacted.': return jt('settings.transfer.warning.attachmentAppendix', "Copied images and files appear in an attachment appendix. Sensitive conversation text is redacted.");
      case 'Original copied files are available from Open copied attachments. Jenny includes up to 12,000 characters of retained text per file.': return jt('settings.transfer.warning.retainedText', "Original copied files are available from Open copied attachments. Jenny includes up to 12,000 characters of retained text per file.");
      case 'General project (no project folder granted)': return jt('settings.transfer.destination.jenny', "General project (no project folder granted)");
      case 'New empty transfer workspace in local Codex storage (read-only)': return jt('settings.transfer.destination.codex', "New empty transfer workspace in local Codex storage (read-only)");
      default: break;
    }
    for (const [pattern, translate] of PATTERNED_DISCLOSURES) {
      const match = pattern.exec(value);
      if (match) return translate(match[1]);
    }
    return value;
  }

  function createConversationTransferController(options = {}) {
    const windowRef = options.windowRef || globalThis.window;
    const host = options.host || windowRef?.document?.getElementById('conversationTransferHost');
    const inventory = options.inventory || windowRef?.inventory;
    const getBridge = options.getBridge || (() => windowRef?.jennyShell?.conversationTransfer);
    let source = 'jenny';
    let selected = '';
    let conversations = [];
    let preview = null;
    let receipt = null;
    let pending = false;
    let disposed = false;
    let bound = false;
    let message = '';
    let failed = false;
    let generation = 0;
    const destination = () => source === 'jenny' ? 'codex' : 'jenny';
    const button = (action, label, disabled = false) => inventory.actionButton({
      id: 'transfer-' + action, label, variant: action === 'copy' ? 'primary' : 'secondary',
      disabled: pending || disabled, dataset: { 'transfer-action': action },
    });
    function render() {
      if (disposed || !host || !inventory) return;
      const focusId = windowRef.document.activeElement?.id;
      let content = '<h5>' + escapeHtml(jt('settings.transfer.title', "Conversation transfer")) + '</h5><p class="settings-copy">'
        + escapeHtml(jt('settings.transfer.description', "Copy one settled conversation between Jenny and local Codex. The source stays intact. Send the next message in the destination to continue independently.")) + '</p>';
      content += inventory.selectField({ id: 'transferSource', label: jt('artifacts.detail.source', 'Source'), value: source, disabled: pending,
        options: [{ value: 'jenny', label: 'Jenny' }, { value: 'codex', label: jt('settings.transfer.localCodex', "Local Codex") }] });
      content += '<p>' + escapeHtml(jt('uninstall.archive.destinationTitle', 'Destination')) + ': <strong>' + (destination() === 'jenny' ? 'Jenny' : jt('settings.transfer.localCodex', "Local Codex")) + '</strong></p>';
      content += button('list', jt('settings.transfer.choose', "Choose conversation"));
      if (conversations.length) {
        content += inventory.selectField({ id: 'transferConversation', label: jt('browserView.conversation', 'Conversation'), value: selected, disabled: pending,
          options: [{ value: '', label: jt('settings.transfer.select', "Select one chat") }, ...conversations.map((row) => ({
            value: row.id, label: row.title + (row.archived ? ' ' + jt('settings.transfer.archived', "(archived)") : '') + (row.busy ? ' ' + jt('settings.transfer.busy', "(busy)") : ''), disabled: row.busy,
          }))] });
        content += button('preview', jt('settings.transfer.preview', "Preview copy"), !selected);
      }
      if (preview) {
        content += '<div class="settings-field"><p><strong>' + escapeHtml(preview.title) + '</strong></p>'
          + '<p>' + escapeHtml(jt('settings.transfer.sourceWorkspace', "Source project/workspace:")) + ' ' + escapeHtml(preview.sourceWorkspace) + '</p>'
          + '<p>' + escapeHtml(jt('settings.transfer.destinationWorkspace', "Destination project/workspace:")) + ' ' + escapeHtml(disclosure(preview.destinationWorkspace)) + '</p>'
          + '<p>' + escapeHtml(jt('settings.transfer.counts', "{messages} messages · {attachments} available attachments", { messages: preview.messageCount, attachments: preview.attachmentCount })) + '</p>'
          + '<ul>' + preview.warnings.map((warning) => '<li>' + escapeHtml(disclosure(warning)) + '</li>').join('') + '</ul>';
        const dialogue = preview.dialogue.map((row) => row.role + ': ' + row.content).join('\n\n');
        content += '<details><summary>' + escapeHtml(jt('settings.transfer.dialogue', "Dialogue preview")) + '</summary><pre class="settings-copy" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:20rem;overflow:auto">'
          + escapeHtml(dialogue.slice(0, 16000)) + '</pre>'
          + (dialogue.length > 16000 ? '<p>' + escapeHtml(jt('settings.transfer.shortened', "Preview shortened; all reported messages are copied.")) + '</p>' : '') + '</details>';
        content += button('copy', receipt?.state === 'completed' ? jt('settings.transfer.existing', "Open existing copy") : jt('settings.transfer.copy', "Copy conversation"));
        if (receipt?.state === 'completed') content += button('again', jt('settings.transfer.again', "Copy again"));
        content += '</div>';
      }
      if (receipt?.state === 'completed') content += button('open', jt('settings.transfer.open', "Open destination")) + button('attachments', jt('settings.transfer.attachments', "Open copied attachments"));
      content += '<p role="status" aria-live="polite"' + (failed ? ' class="settings-field-error"' : '') + '>'
        + escapeHtml(pending ? jt('ide.changes.working', 'Working…') : message) + '</p>';
      host.innerHTML = content;
      if (focusId) windowRef.document.getElementById(focusId)?.focus?.();
    }
    async function run(task) {
      if (disposed || pending) return;
      pending = true;
      failed = false;
      message = '';
      const version = generation;
      render();
      try {
        const result = await task();
        if (disposed || version !== generation) return;
        if (!result?.ok) { failed = true; message = failureMessage(result); }
      } catch (_error) {
        if (!disposed && version === generation) {
          failed = true;
          message = jt('settings.transfer.failed', "Conversation transfer could not finish. Preview or retry the saved copy.");
        }
      } finally {
        if (!disposed && version === generation) { pending = false; render(); }
      }
    }
    async function makePreview(copyAgain) {
      const result = await getBridge()?.preview?.({ source, destination: destination(), sourceId: selected, copyAgain });
      if (disposed) return result;
      if (result?.ok) {
        preview = result;
        receipt = result.receipt;
        message = jt('settings.transfer.review', "Review the dialogue, destination workspace and attachment losses before copying.");
      }
      return result;
    }
    function onChange(event) {
      if (pending || disposed) return;
      if (event.target.id === 'transferSource') {
        source = event.target.value;
        conversations = [];
        selected = '';
      } else if (event.target.id === 'transferConversation') selected = event.target.value;
      else return;
      generation += 1;
      preview = null;
      receipt = null;
      message = '';
      failed = false;
      render();
    }
    async function openDestination() {
      const result = await getBridge()?.open?.({ operationId: receipt.operationId });
      if (!disposed && result?.ok && result.destination === 'jenny') await options.openJenny?.(result.destinationId);
      return result;
    }
    function onClick(event) {
      const target = event.target.closest?.('[data-transfer-action]');
      if (!target || target.disabled || !host.contains(target)) return;
      const action = target.dataset.transferAction;
      void run(async () => {
        if (action === 'list') {
          const result = await getBridge()?.list?.({ source });
          if (!disposed && result?.ok) {
            conversations = result.conversations;
            preview = null;
            receipt = null;
            selected = '';
            message = conversations.length ? jt('settings.transfer.chooseSettled', "Archived chats are included. Choose one settled chat.") : jt('settings.transfer.empty', "No conversations found.");
          }
          return result;
        }
        if (action === 'preview' || action === 'again') return makePreview(action === 'again');
        if (action === 'attachments') return getBridge()?.attachments?.({ operationId: receipt.operationId });
        if (action === 'open' || (action === 'copy' && receipt?.state === 'completed')) return openDestination();
        if (action === 'copy') {
          const result = await getBridge()?.copy?.({ previewToken: preview.previewToken });
          if (!disposed && result?.ok) {
            receipt = result.receipt;
            message = result.reused ? jt('settings.transfer.ready', "The existing copy is ready.") : jt('settings.transfer.copied', "Copied. Open the destination and send your next message there.");
          }
          return result;
        }
        return { ok: false };
      });
    }
    function bind() {
      if (!host || bound || disposed) return;
      bound = true;
      host.addEventListener('change', onChange);
      host.addEventListener('click', onClick);
      render();
    }
    function dispose() {
      disposed = true;
      generation += 1;
      host?.removeEventListener('change', onChange);
      host?.removeEventListener('click', onClick);
    }
    return { bind, dispose };
  }
  function bindConversationTransferSettings(windowRef, registerCleanup, openJenny) {
    const controller = createConversationTransferController({ windowRef, openJenny });
    controller.bind();
    registerCleanup(() => controller.dispose());
    return controller;
  }
  return { createConversationTransferController, bindConversationTransferSettings };
});
