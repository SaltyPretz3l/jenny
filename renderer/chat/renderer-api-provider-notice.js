/* renderer/chat/renderer-api-provider-notice.js
 *
 * Row 78 first-use notice (variant N1): before the first message leaves for an
 * API-key provider, a dialog says what that provider receives; Send records the
 * acknowledgement per provider in settings (apiProviders.acknowledgeNotice) and
 * the dialog never shows for it again. The send boundary
 * (renderer-send-utils startPromptSend) asks here beside the Auto-run gate: a
 * plain `true` when nothing needs asking keeps the send synchronous, a Promise
 * only while the dialog is due.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererApiProviderNotice = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MODEL_PREFIX = 'api-provider/';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t)
    || globalThis.jennyI18nFallback
    || function (key, fallback, params) {
      if (!params) return fallback;
      return String(fallback).replace(/\{(\w+)\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
      ));
    };

  function instanceIdOf(modelId) {
    const text = String(modelId || '').trim();
    if (!text.startsWith(MODEL_PREFIX)) return '';
    const rest = text.slice(MODEL_PREFIX.length);
    const slash = rest.indexOf('/');
    return slash > 0 ? rest.slice(0, slash) : '';
  }

  function createApiProviderNotice(options = {}) {
    const getBridge = typeof options.getBridge === 'function'
      ? options.getBridge : () => globalThis.jennyShell?.apiProviders || null;
    const createDialog = typeof options.createDialog === 'function' ? options.createDialog : () => {
      const factory = globalThis.rendererIdeConfirmDialog?.createIdeConfirmDialog;
      const helpOverlayFactory = globalThis.inventoryHelpOverlay?.createHelpOverlay;
      if (typeof factory !== 'function' || typeof helpOverlayFactory !== 'function') return null;
      return factory({
        document: globalThis.document,
        actionButton: globalThis.inventoryActionButton,
        helpOverlayFactory,
        hostId: 'apiProviderNoticeOverlay',
      });
    };
    let instances = new Map();
    let loaded = null;
    let subscribed = false;
    let dialog = null;
    let inFlight = null;

    function adopt(raw) {
      if (!raw || !Array.isArray(raw.instances)) return;
      instances = new Map(raw.instances.map((instance) => [instance.id, instance]));
    }

    function load() {
      if (loaded) return loaded;
      const bridge = getBridge();
      if (!subscribed && typeof bridge?.onChanged === 'function') {
        subscribed = true;
        try { bridge.onChanged(adopt); } catch (_error) { /* a later getState still answers */ }
      }
      loaded = Promise.resolve(bridge?.getState?.()).then(adopt, () => { loaded = null; });
      return loaded;
    }

    async function ask(instanceId) {
      // An instance the state did not answer for (a failed read) still asks: the notice fails closed.
      const instance = instances.get(instanceId) || { id: instanceId, label: instanceId, noticeAcknowledgedAt: null };
      if (instance.noticeAcknowledgedAt) return true;
      dialog = dialog || createDialog();
      // Without the dialog the message stays here: the notice is the consent.
      if (!dialog) return false;
      const confirmed = await dialog.confirm({
        title: jt('apiProviders.notice.title', 'Send to {provider}?', { provider: instance.label }),
        message: jt('apiProviders.notice.body', '{provider} receives your messages, the files you attach and tool results while you use its models. Your key and chats stay on this device; Jenny asks once per provider.', { provider: instance.label }),
        confirmLabel: jt('apiProviders.notice.send', 'Send'),
        cancelLabel: jt('common.cancel', 'Cancel'),
      });
      if (confirmed !== true) return false;
      const result = await getBridge()?.acknowledgeNotice?.({ instanceId });
      if (result?.ok !== true) return false;
      instances.set(instanceId, { ...instance, noticeAcknowledgedAt: new Date().toISOString() });
      return true;
    }

    // `true` when the model is not a provider model or the provider was acknowledged.
    function confirmFirstSend(modelId) {
      const instanceId = instanceIdOf(modelId);
      if (!instanceId) return true;
      const known = instances.get(instanceId);
      if (known && known.noticeAcknowledgedAt) return true;
      if (inFlight) return inFlight.then(() => confirmFirstSend(modelId));
      inFlight = Promise.resolve(known ? null : load())
        .then(() => ask(instanceId))
        .catch(() => false)
        .finally(() => { inFlight = null; });
      return inFlight;
    }

    return { confirmFirstSend, load };
  }

  let shared = null;
  function confirmFirstSend(modelId) {
    shared = shared || createApiProviderNotice();
    return shared.confirmFirstSend(modelId);
  }

  // Warm the cache once the page is up, so an acknowledged provider answers synchronously.
  if (typeof globalThis.addEventListener === 'function' && globalThis.document) {
    globalThis.addEventListener('DOMContentLoaded', () => {
      shared = shared || createApiProviderNotice();
      void shared.load();
    }, { once: true });
  }

  return { confirmFirstSend, createApiProviderNotice, instanceIdOf };
});
