/* Hosted browser asset lifecycle controller.
 *
 * Attachments, canonical full messages, and generated artifacts all cross an
 * authenticated HTTP boundary and can outlive a render. This controller owns
 * their bounded queues, abort handles, and Blob URL retention. The host app
 * supplies state and lifecycle callbacks so no browser transcript is persisted
 * here.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.jennyBrowserAssets = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };


  const ATTACHMENT_MIME_TYPES = Object.freeze(new Set([
    'image/png', 'image/jpeg', 'image/webp', 'text/plain',
  ]));
  const MAX_ATTACHMENT_COUNT = 8;
  const MAX_IMAGE_COUNT = 4;
  const MAX_IMAGE_TOTAL_BYTES = 5 * 1024 * 1024;
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  const MAX_TEXT_BYTES = 1_000_000;
  const MAX_ARTIFACT_PREVIEW_BYTES = 4 * 1024 * 1024;

  function text(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
  }

  function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  class BrowserAssetsController {
    constructor(options = {}) {
      this.bridge = options.bridge || null;
      this.view = options.view || null;
      this.BrowserBridgeError = options.BrowserBridgeError || Error;
      this.normalizeReason = options.normalizeReason;
      this.getState = options.getState || (() => ({}));
      this.getRoot = options.getRoot || (() => (typeof document !== 'undefined' ? document : null));
      this.getSessionGeneration = options.getSessionGeneration || (() => 0);
      this.isDisposed = options.isDisposed || (() => false);
      this.render = options.render || (() => {});
      this.setError = options.setError || (() => {});
      this.nextAttachmentId = 0;
      this.attachmentUploads = new Map();
      this.attachmentDownloads = new Map();
      this.fullMessageLoads = new Map();
      this.fullMessageControllers = new Map();
      this.attachmentUrls = new Map();
      this.artifactDownloads = new Map();
      this.artifactUrls = new Map();
    }

    _error(message, details = {}) {
      return new this.BrowserBridgeError(message, details);
    }

    _attachmentFileName(file) {
      return text(file?.name).split(/[\\/]/).pop().trim().slice(0, 255) || 'attachment';
    }

    _attachmentFingerprint(file) {
      return [this._attachmentFileName(file), text(file?.type).toLowerCase(), Number(file?.size) || 0, Number(file?.lastModified) || 0].join('|');
    }

    attachmentLimit(file, count, imageCount, imageBytes) {
      const mimeType = text(file?.type).toLowerCase();
      const size = Number(file?.size);
      if (!ATTACHMENT_MIME_TYPES.has(mimeType)) return jt("browserAssets.thisFileTypeIsNotSupported", "This file type is not supported.");
      if (!Number.isSafeInteger(size) || size < 0) return jt("browserAssets.thisFileHasAnInvalidSize", "This file has an invalid size.");
      const limit = mimeType === 'text/plain' ? MAX_TEXT_BYTES : MAX_IMAGE_BYTES;
      if (size > limit) return jt("browserAssets.thisFileIsLargerThanTheValueMibLimit", "This file is larger than the {value1} MiB limit.", { value1: String(Math.round(limit / 1024 / 1024)) });
      if (count >= MAX_ATTACHMENT_COUNT) return jt("browserAssets.youCanAttachUpTo8Files", "You can attach up to 8 files.");
      if (mimeType !== 'text/plain' && imageCount >= MAX_IMAGE_COUNT) return jt("browserAssets.youCanAttachUpTo4Images", "You can attach up to 4 images.");
      if (mimeType !== 'text/plain' && imageBytes + size > MAX_IMAGE_TOTAL_BYTES) return jt("browserAssets.theSelectedImagesExceedThe5MibTotalLimit", "The selected images exceed the 5 MiB total limit.");
      return '';
    }

    async queueFiles(files) {
      const state = this.getState();
      if (!state.control?.owned || !state.selectedSessionId) return;
      const sessionId = state.selectedSessionId;
      const generation = this.getSessionGeneration();
      const queue = Array.isArray(state.attachments) ? state.attachments : [];
      state.attachments = queue;
      let imageCount = queue.filter((item) => text(item.mimeType || item.file?.type).toLowerCase() !== 'text/plain').length;
      let imageBytes = queue.reduce((total, item) => text(item.mimeType || item.file?.type).toLowerCase() === 'text/plain' ? total : total + (Number(item.sizeBytes) || 0), 0);
      for (const file of Array.isArray(files) ? files : []) {
        if (this.isDisposed() || sessionId !== this.getState().selectedSessionId || generation !== this.getSessionGeneration()) break;
        const fingerprint = this._attachmentFingerprint(file);
        if (!fingerprint || this.getState().attachments.some((item) => item.fingerprint === fingerprint)) continue;
        const reason = this.attachmentLimit(file, this.getState().attachments.length, imageCount, imageBytes);
        if (reason) {
          this.setError(reason);
          continue;
        }
        const item = {
          clientId: `attachment_${++this.nextAttachmentId}`,
          file,
          fingerprint,
          displayName: this._attachmentFileName(file),
          mimeType: text(file.type).toLowerCase(),
          sizeBytes: Number(file.size),
          sessionId,
          generation,
          status: 'uploading',
          attachment: null,
          error: '',
        };
        state.attachments = [...this.getState().attachments, item];
        if (item.mimeType !== 'text/plain') {
          imageCount += 1;
          imageBytes += item.sizeBytes;
        }
        this.render();
        await this.uploadAttachmentItem(item);
      }
    }

    async uploadAttachmentItem(item) {
      if (!item || this.isDisposed() || item.generation !== this.getSessionGeneration()) return;
      const controller = new AbortController();
      this.attachmentUploads.set(item.clientId, controller);
      try {
        const result = await this.bridge.uploadAttachment(item.file, { displayName: item.displayName, signal: controller.signal });
        const state = this.getState();
        const current = state.attachments.find((candidate) => candidate.clientId === item.clientId);
        if (this.isDisposed() || item.generation !== this.getSessionGeneration() || item.sessionId !== state.selectedSessionId || !current) return;
        if (!isRecord(result?.attachment) || !text(result.attachment.id)) throw this._error('invalid_attachment_response', { code: 'invalid_server_response' });
        current.attachment = { ...result.attachment };
        current.status = 'uploaded';
        current.error = '';
        this.render();
      } catch (error) {
        const current = this.getState().attachments.find((candidate) => candidate.clientId === item.clientId);
        if (!current || this.isDisposed() || item.generation !== this.getSessionGeneration()) return;
        current.status = 'error';
        current.error = this.normalizeReason(error);
        this.setError(jt("browserAssets.couldNotUploadValueValue", "Could not upload {value1}. {value2}", { value1: String(item.displayName), value2: String(current.error) }));
      } finally {
        if (this.attachmentUploads.get(item.clientId) === controller) this.attachmentUploads.delete(item.clientId);
      }
    }

    removeAttachment(clientId) {
      const id = text(clientId);
      if (!id) return;
      this.attachmentUploads.get(id)?.abort?.();
      this.attachmentUploads.delete(id);
      const state = this.getState();
      state.attachments = state.attachments.filter((item) => item.clientId !== id);
      this.render();
    }

    async retryAttachment(clientId) {
      const item = this.getState().attachments.find((candidate) => candidate.clientId === text(clientId));
      if (!item || item.status !== 'error' || item.generation !== this.getSessionGeneration()) return;
      item.status = 'uploading';
      item.error = '';
      this.render();
      await this.uploadAttachmentItem(item);
    }

    clearAttachmentQueue() {
      for (const controller of this.attachmentUploads.values()) controller.abort();
      this.attachmentUploads.clear();
      if (this.getState().attachments) this.getState().attachments = [];
    }

    abortFullMessageLoads() {
      for (const controller of this.fullMessageControllers.values()) controller.abort();
      this.fullMessageControllers.clear();
      this.fullMessageLoads.clear();
    }

    abortAttachmentDownloads() {
      for (const controller of this.attachmentDownloads.values()) controller.abort();
      this.attachmentDownloads.clear();
    }

    revokeAttachmentUrls() {
      for (const record of this.attachmentUrls.values()) {
        if (record.timer) clearTimeout(record.timer);
        try { URL.revokeObjectURL(record.url); } catch (_error) { /* best effort */ }
      }
      this.attachmentUrls.clear();
    }

    async openAttachment(attachmentId) {
      const id = text(attachmentId);
      const state = this.getState();
      const sessionId = text(state.selectedSessionId);
      const generation = this.getSessionGeneration();
      if (!id || !sessionId || this.isDisposed() || typeof this.bridge?.downloadAttachment !== 'function') return;
      const controller = new AbortController();
      const key = `${sessionId}:${id}`;
      this.attachmentDownloads.get(key)?.abort?.();
      this.attachmentDownloads.set(key, controller);
      try {
        const result = await this.bridge.downloadAttachment(sessionId, id, { signal: controller.signal });
        if (this.isDisposed() || generation !== this.getSessionGeneration() || sessionId !== this.getState().selectedSessionId) return;
        const blob = result?.blob;
        if (!blob || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') throw this._error('invalid_attachment_response', { code: 'invalid_server_response' });
        const prior = this.attachmentUrls.get(key);
        if (prior) {
          if (prior.timer) clearTimeout(prior.timer);
          try { URL.revokeObjectURL(prior.url); } catch (_error) { /* best effort */ }
        }
        const url = URL.createObjectURL(blob);
        const timer = setTimeout(() => {
          const current = this.attachmentUrls.get(key);
          if (current?.url !== url) return;
          try { URL.revokeObjectURL(url); } catch (_error) { /* best effort */ }
          this.attachmentUrls.delete(key);
        }, 60_000);
        this.attachmentUrls.set(key, { url, timer });
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.download = this.attachmentDisplayName(id);
        link.click();
      } catch (error) {
        if (!this.isDisposed() && generation === this.getSessionGeneration()) this.setError(jt("browserAssets.couldNotOpenAttachmentValue", "Could not open attachment. {value1}", { value1: String(this.normalizeReason(error)) }));
      } finally {
        if (this.attachmentDownloads.get(key) === controller) this.attachmentDownloads.delete(key);
      }
    }

    attachmentDisplayName(attachmentId) {
      const messages = Array.isArray(this.getState().snapshot?.messages) ? this.getState().snapshot.messages : [];
      for (const message of messages) {
        for (const attachment of (Array.isArray(message?.attachments) ? message.attachments : [])) {
          if (text(attachment?.id) === text(attachmentId)) return this._attachmentFileName({ name: attachment.display_name });
        }
      }
      return 'attachment';
    }

    async loadFullMessage(messageId) {
      const id = text(messageId);
      const state = this.getState();
      const sessionId = text(state.selectedSessionId);
      const generation = this.getSessionGeneration();
      if (!id || !sessionId || this.isDisposed() || typeof this.bridge?.fetchFullMessage !== 'function') return;
      if (this.fullMessageLoads.has(id)) return this.fullMessageLoads.get(id);
      const controller = new AbortController();
      this.fullMessageControllers.set(id, controller);
      const promise = (async () => {
        try {
          const result = await this.bridge.fetchFullMessage(sessionId, id, { signal: controller.signal });
          if (this.isDisposed() || generation !== this.getSessionGeneration() || sessionId !== this.getState().selectedSessionId) return;
          const incoming = result?.message;
          if (!isRecord(incoming)) throw this._error('invalid_message_response', { code: 'invalid_server_response' });
          const messages = Array.isArray(this.getState().snapshot?.messages) ? this.getState().snapshot.messages : [];
          const index = messages.findIndex((message) => text(message?.id) === id);
          if (index < 0) return;
          const merged = { ...messages[index], ...incoming, full_message_available: false };
          if (Array.isArray(messages[index]?.turn_events) && !Array.isArray(incoming.turn_events)) merged.turn_events = messages[index].turn_events;
          this.getState().snapshot = { ...this.getState().snapshot, messages: messages.map((message, candidateIndex) => candidateIndex === index ? merged : message) };
          this.render();
        } catch (error) {
          if (!this.isDisposed() && generation === this.getSessionGeneration()) this.setError(jt("browserAssets.couldNotLoadTheFullMessageValue", "Could not load the full message. {value1}", { value1: String(this.normalizeReason(error)) }));
        } finally {
          if (this.fullMessageLoads.get(id) === promise) this.fullMessageLoads.delete(id);
          if (this.fullMessageControllers.get(id) === controller) this.fullMessageControllers.delete(id);
        }
      })();
      this.fullMessageLoads.set(id, promise);
      return promise;
    }

    trackArtifactUrl(key, blob) {
      if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') throw this._error('invalid_artifact_response', { code: 'invalid_server_response' });
      const prior = this.artifactUrls.get(key);
      if (prior) {
        if (prior.timer) clearTimeout(prior.timer);
        try { URL.revokeObjectURL(prior.url); } catch (_error) { /* best effort */ }
      }
      const url = URL.createObjectURL(blob);
      const timer = setTimeout(() => {
        const current = this.artifactUrls.get(key);
        if (current?.url !== url) return;
        try { URL.revokeObjectURL(url); } catch (_error) { /* best effort */ }
        this.artifactUrls.delete(key);
      }, 60_000);
      this.artifactUrls.set(key, { url, timer });
      return url;
    }

    async downloadArtifact(artifactId, options = {}) {
      const id = text(artifactId);
      const state = this.getState();
      const sessionId = text(state.selectedSessionId);
      const generation = this.getSessionGeneration();
      const ref = this.view?.artifactRefForId?.(state.snapshot, id);
      if (!ref || !sessionId || this.isDisposed() || typeof this.bridge?.downloadArtifact !== 'function') return;
      const key = `${sessionId}:${id}:${options.preview === true ? 'preview' : 'download'}`;
      const controller = new AbortController();
      this.artifactDownloads.get(key)?.abort?.();
      this.artifactDownloads.set(key, controller);
      try {
        const result = await this.bridge.downloadArtifact(sessionId, id, { signal: controller.signal });
        if (this.isDisposed() || generation !== this.getSessionGeneration() || sessionId !== this.getState().selectedSessionId) return;
        if (!result?.blob || !Number.isSafeInteger(Number(result.blob.size)) || Number(result.blob.size) < 0) throw this._error('invalid_artifact_response', { code: 'invalid_server_response' });
        if (options.preview === true) {
          await this.view?.renderArtifactPreview?.(this.getRoot()?.querySelector?.('[data-artifact-previews]'), {
            id,
            ref,
            result,
            sessionId,
            isCurrent: () => !this.isDisposed() && generation === this.getSessionGeneration() && sessionId === this.getState().selectedSessionId,
            trackUrl: (urlKey, blob) => this.trackArtifactUrl(urlKey, blob),
          });
          return;
        }
        const url = this.trackArtifactUrl(key, result.blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = this.view?.artifactDownloadName?.(result.contentDisposition, ref) || 'artifact';
        link.rel = 'noopener noreferrer';
        link.click();
      } catch (error) {
        if (!this.isDisposed() && generation === this.getSessionGeneration()) this.setError(jt("browserAssets.couldNotOpenArtifactValue", "Could not open artifact. {value1}", { value1: String(this.normalizeReason(error)) }));
      } finally {
        if (this.artifactDownloads.get(key) === controller) this.artifactDownloads.delete(key);
      }
    }

    abortArtifactDownloads() {
      for (const controller of this.artifactDownloads.values()) controller.abort();
      this.artifactDownloads.clear();
    }

    revokeArtifactUrls() {
      for (const record of this.artifactUrls.values()) {
        if (record.timer) clearTimeout(record.timer);
        try { URL.revokeObjectURL(record.url); } catch (_error) { /* best effort */ }
      }
      this.artifactUrls.clear();
    }

    reset() {
      this.clearAttachmentQueue();
      this.abortAttachmentDownloads();
      this.abortFullMessageLoads();
      this.revokeAttachmentUrls();
      this.abortArtifactDownloads();
      this.revokeArtifactUrls();
    }
  }

  return {
    ATTACHMENT_MIME_TYPES,
    MAX_ATTACHMENT_COUNT,
    MAX_IMAGE_COUNT,
    MAX_IMAGE_TOTAL_BYTES,
    MAX_IMAGE_BYTES,
    MAX_TEXT_BYTES,
    MAX_ARTIFACT_PREVIEW_BYTES,
    BrowserAssetsController,
  };
});
