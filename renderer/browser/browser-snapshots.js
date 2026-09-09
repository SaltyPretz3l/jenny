/* Serializes canonical snapshots with the later events on the SSE stream. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.jennyBrowserSnapshots = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };


  const MAX_BUFFER_BYTES = 1024 * 1024;
  const MAX_BUFFER_EVENTS = 256;

  class BrowserSnapshots {
    constructor(owner) {
      this.owner = owner;
      this.pending = null;
      this.failureMessage = '';
    }

    reset() {
      this.pending?.abort.abort();
      this.pending = null;
      this.owner.getState().snapshotPending = false;
    }

    buffer(event) {
      const pending = this.pending;
      if (!pending) return false;
      if (pending.overflow) return true;
      const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if (pending.events.length >= MAX_BUFFER_EVENTS || pending.bytes + bytes > MAX_BUFFER_BYTES) {
        pending.overflow = true;
        pending.events = [];
      } else {
        pending.events.push(event);
        pending.bytes += bytes;
      }
      return true;
    }

    load(sessionId, { beforeMessageId = '', maxMessages = 40 } = {}) {
      const owner = this.owner;
      if (!sessionId || owner.isDisposed()) return Promise.resolve(null);
      const key = `${owner.getGeneration()}:${sessionId}:${beforeMessageId}`;
      if (this.pending?.key === key) return this.pending.promise;
      this.reset();
      const pending = { key, generation: owner.getGeneration(), sessionId,
        abort: new AbortController(), events: [], bytes: 0, overflow: false };
      this.pending = pending;
      owner.getState().snapshotPending = true;
      pending.promise = this._load(pending, beforeMessageId, maxMessages);
      return pending.promise;
    }

    async _load(pending, beforeMessageId, maxMessages) {
      const owner = this.owner;
      const isCurrent = () => this.pending === pending && !owner.isDisposed()
        && pending.generation === owner.getGeneration()
        && pending.sessionId === owner.getState().selectedSessionId;
      let snapshotCursor = -1;
      let accepted = false;
      try {
        const result = await owner.command('sessions.snapshot', {
          sessionId: pending.sessionId, signal: pending.abort.signal,
          expectedRevision: owner.getState().snapshot?.session?.revision || '',
          params: { max_messages: maxMessages,
            ...(beforeMessageId ? { before_message_id: beforeMessageId } : {}) },
        }, { quiet: true });
        if (!isCurrent()) return result;
        if (!result?.ok) {
          this.failureMessage = jt("browserSnapshots.theConversationCouldNotBeRefreshedUseReloadConversation", "The conversation could not be refreshed. Use Reload conversation to retry.");
          owner.setError(this.failureMessage);
          return result;
        }
        if (pending.overflow) throw new Error('Live updates exceeded recovery capacity. Reload to reconnect.');
        const snapshot = result.snapshot || result;
        if (!snapshot?.session || snapshot.session.session_id !== pending.sessionId) {
          throw new Error('The conversation snapshot was invalid.');
        }
        snapshotCursor = Number.isSafeInteger(snapshot.cursor) && snapshot.cursor >= 0 ? snapshot.cursor : 0;
        const state = owner.getState();
        const previous = state.snapshot;
        if (beforeMessageId && previous?.session?.session_id === pending.sessionId) {
          const messages = new Map();
          for (const message of [...(snapshot.messages || []), ...(previous.messages || [])]) {
            if (message?.id) messages.set(message.id, message);
          }
          state.snapshot = { ...snapshot, messages: [...messages.values()] };
        } else state.snapshot = snapshot;
        state.planMode = state.snapshot.session.plan_mode === true;
        state.liveProjection = snapshot.live_projection || null;
        state.activeStreamId = snapshot.active_turn?.stream_id || '';
        owner.syncControlFromSnapshot(snapshot);
        if (owner.bridge && (!snapshot.boot_epoch || snapshot.boot_epoch === owner.bridge.bootEpoch)) {
          owner.bridge.cursor = Math.max(owner.bridge.cursor || 0, snapshotCursor);
        }
        if (this.failureMessage && state.error === this.failureMessage) state.error = '';
        this.failureMessage = '';
        state.snapshotUnavailable = false;
        accepted = true;
        return result;
      } catch (error) {
        if (isCurrent()) {
          owner.syncControlFromSnapshot({ control: null });
          this.failureMessage = owner.normalizeReason(error);
          owner.setError(this.failureMessage);
        }
        return null;
      } finally {
        if (isCurrent()) {
          this.pending = null;
          owner.getState().snapshotPending = false;
          owner.getState().snapshotUnavailable = !accepted;
          if (pending.overflow) {
            owner.bridge?.closeEvents?.();
            owner.syncControlFromSnapshot({ control: null });
          } else {
            for (const event of pending.events) {
              if (!accepted || event.cursor > snapshotCursor
                || ['session_changed', 'resync_required'].includes(event.event_type)) owner.handleEvent(event);
            }
          }
          owner.render();
        }
      }
    }
  }

  return { BrowserSnapshots };
});
