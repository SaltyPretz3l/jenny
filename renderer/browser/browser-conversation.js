/* Hosted browser conversation lifecycle controller. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./browser-snapshots'));
    return;
  }
  root.jennyBrowserConversation = factory(root.jennyBrowserSnapshots);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (snapshotModule) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };


  function text(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
  }

  function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  class BrowserConversationController {
    constructor(options = {}) {
      this.bridge = options.bridge || null;
      this.getState = options.getState || (() => ({}));
      this.getRoot = options.getRoot || (() => null);
      this.getGeneration = options.getGeneration || (() => 0);
      this.bumpGeneration = options.bumpGeneration || (() => {});
      this.isDisposed = options.isDisposed || (() => false);
      this.render = options.render || (() => {});
      this.command = options.command || (async () => null);
      this.resetAssets = options.resetAssets || (() => {});
      this.setError = options.setError || (() => {});
      this.getClientId = options.getClientId || (() => '');
      this.normalizeReason = options.normalizeReason;
      this.recoverFromEpoch = options.recoverFromEpoch || (() => {});
      this.snapshots = new snapshotModule.BrowserSnapshots(this);
      this.heartbeatTimer = null;
      this.heartbeatPending = null;
      this.controlVersion = 0;
      this.resumeRecoveryPending = false;
      this.visibilityTarget = options.visibilityTarget || this.getRoot()?.ownerDocument
        || (typeof document !== 'undefined' ? document : null);
      this.focusTarget = options.focusTarget || this.visibilityTarget?.defaultView
        || (typeof window !== 'undefined' ? window : null);
      this._onVisibilityChange = () => {
        if (this.visibilityTarget?.visibilityState === 'hidden') {
          this.prepareForResume();
          this.stopHeartbeat();
          return;
        }
        void this.resumeControl();
      };
      this._onFocus = () => { void this.resumeControl(); };
      this.visibilityTarget?.addEventListener?.('visibilitychange', this._onVisibilityChange);
      this.focusTarget?.addEventListener?.('focus', this._onFocus);
    }

    _emptyControl() {
      return { owned: false, ownerClientId: '', generation: 0, expiresAt: 0 };
    }

    _capture() {
      return { generation: this.getGeneration(), sessionId: this.getState().selectedSessionId };
    }

    _current(capture) {
      return !this.isDisposed() && capture.generation === this.getGeneration()
        && capture.sessionId === this.getState().selectedSessionId;
    }

    _captureControl() {
      return { ...this._capture(), controlVersion: this.controlVersion };
    }

    _currentControl(capture) {
      return this._current(capture) && capture.controlVersion === this.controlVersion;
    }

    async loadSessions() {
      const result = await this.command('sessions.list', { params: {} }, { quiet: true });
      const state = this.getState();
      if (!result?.ok || this.isDisposed()) return;
      state.sessions = Array.isArray(result.sessions) ? result.sessions : [];
      if (!state.selectedSessionId || !state.sessions.some((session) => session.session_id === state.selectedSessionId)) {
        this.bumpGeneration();
        this.snapshots.reset();
        this.resetAssets();
        this.syncControlFromSnapshot({ control: null });
        state.selectedSessionId = text(state.sessions[0]?.session_id);
        state.snapshot = null;
        state.liveProjection = null;
        state.activeStreamId = '';
      }
      if (state.selectedSessionId) await this.loadSnapshot(state.selectedSessionId);
      if (!this.isDisposed()) this.render();
    }

    loadSnapshot(sessionId, options) {
      return this.snapshots.load(sessionId, options);
    }

    syncControlFromSnapshot(snapshot) {
      const control = snapshot?.control;
      const state = this.getState();
      if (!isRecord(control)) {
        if (state.control?.ownerClientId || state.control?.generation) this.controlVersion += 1;
        state.control = this._emptyControl();
        this.stopHeartbeat();
        return;
      }
      const ownerClientId = text(control.client_id || control.owner_client_id);
      const generation = Number.isSafeInteger(control.generation)
        ? control.generation : state.control?.generation || 0;
      if (ownerClientId !== state.control?.ownerClientId || generation !== state.control?.generation) {
        this.controlVersion += 1;
      }
      state.control.ownerClientId = ownerClientId;
      state.control.owned = Boolean(ownerClientId && ownerClientId === this.getClientId());
      state.control.generation = generation;
      if (Number.isFinite(control.expires_at)) state.control.expiresAt = control.expires_at;
      if (!state.control.owned) this.stopHeartbeat();
      else this.startHeartbeat();
    }

    applyControlEvent(event) {
      const state = this.getState();
      const ownerClientId = text(event?.client_id);
      const generation = Number.isSafeInteger(event?.generation)
        ? event.generation : state.control?.generation || 0;
      if (ownerClientId !== state.control?.ownerClientId || generation !== state.control?.generation) {
        this.controlVersion += 1;
      }
      state.control.ownerClientId = ownerClientId;
      state.control.owned = Boolean(ownerClientId && ownerClientId === this.getClientId());
      state.control.generation = generation;
      if (Number.isFinite(event?.expires_at)) state.control.expiresAt = event.expires_at;
      if (!state.control.owned) this.stopHeartbeat();
      else this.startHeartbeat();
    }

    startHeartbeat() {
      if (this.heartbeatTimer !== null) return;
      if (this.getState().control?.owned) {
        this.heartbeatTimer = setInterval(() => { void this.heartbeat(); }, 15_000);
      }
    }

    stopHeartbeat() {
      if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    prepareForResume() {
      if (this.getState().control?.owned) this.resumeRecoveryPending = true;
    }

    async resumeControl() {
      if (this.isDisposed()) return;
      const state = this.getState();
      if (state.control?.owned) {
        this.startHeartbeat();
        return this.heartbeat({ recoverExpired: true });
      }
      if (!this.resumeRecoveryPending || !state.selectedSessionId) return;
      this.resumeRecoveryPending = false;
      return this.acquireControl(false, { quiet: true });
    }

    heartbeat(options = {}) {
      if (this.heartbeatPending) return this.heartbeatPending;
      const pending = this._heartbeat(options).finally(() => {
        if (this.heartbeatPending === pending) this.heartbeatPending = null;
      });
      this.heartbeatPending = pending;
      return pending;
    }

    async _heartbeat({ recoverExpired = false } = {}) {
      const capture = this._captureControl();
      const state = this.getState();
      if (!state.control.owned || !state.selectedSessionId || this.isDisposed()) return;
      const result = await this.command('control.heartbeat', {
        sessionId: state.selectedSessionId,
        controlGeneration: state.control.generation,
        params: {},
      }, { quiet: true });
      if (!this._current(capture)) return;
      if (result?.ok && result.lease && this._currentControl(capture)) {
        this.resumeRecoveryPending = false;
        this.applyControlEvent({ ...result.lease, client_id: this.getClientId() });
      } else if (result?.error?.reason === 'control_lease_required') {
        this.stopHeartbeat();
        if (state.control?.owned) this.syncControlFromSnapshot({ control: null });
        if (recoverExpired) {
          this.resumeRecoveryPending = false;
          await this.acquireControl(false, { quiet: true });
        } else this.setError(jt("browserConversation.controlWasReleasedByAnotherBrowser", "Control was released by another browser."));
      }
    }

    async selectSession(sessionId) {
      const normalized = text(sessionId);
      const state = this.getState();
      if (!normalized || normalized === state.selectedSessionId) return;
      this.stopHeartbeat();
      this.bumpGeneration();
      this.snapshots.reset();
      state.controlBusy = false;
      state.pendingDecisionKey = '';
      this.resetAssets();
      state.selectedSessionId = normalized;
      state.snapshot = null;
      state.liveProjection = null;
      state.activeStreamId = '';
      state.control = this._emptyControl();
      this.render();
      await this.loadSnapshot(normalized);
    }

    async loadOlder() {
      const state = this.getState();
      const cursor = text(state.snapshot?.next_before_message_id);
      if (cursor && state.selectedSessionId) {
        await this.loadSnapshot(state.selectedSessionId, {
          beforeMessageId: cursor,
          maxMessages: 40,
        });
      }
    }

    async createSession() {
      const capture = this._capture();
      const result = await this.command('sessions.create', { params: { title: jt("ide.chatDock.newChat", "New chat") } });
      if (!this._current(capture)) return;
      const state = this.getState();
      if (!result?.ok || !result.session?.session_id) return;
      state.sessions = [
        ...state.sessions.filter((item) => item.session_id !== result.session.session_id),
        result.session,
      ];
      this.bumpGeneration();
      this.resetAssets();
      state.selectedSessionId = result.session.session_id;
      state.snapshot = null;
      state.draft = '';
      this.render();
      await this.loadSnapshot(state.selectedSessionId);
    }

    startRename(sessionId) {
      const state = this.getState();
      if (text(sessionId) !== state.selectedSessionId || !state.control.owned) return;
      state.editingSessionId = text(sessionId);
      this.render();
      const input = this.getRoot()?.querySelector('.browser-session--editing .inv-text-field-control');
      input?.focus?.();
      input?.select?.();
    }

    async saveRename(sessionId) {
      const capture = this._capture();
      const state = this.getState();
      const input = this.getRoot()?.querySelector('.browser-session--editing .inv-text-field-control');
      const title = text(input?.value).trim();
      if (!title || text(sessionId) !== state.selectedSessionId || !state.control.owned) return;
      const result = await this.command('sessions.rename', {
        sessionId,
        controlGeneration: state.control.generation,
        expectedRevision: text(state.snapshot?.session?.revision),
        params: { title },
      });
      if (!this._current(capture)) return;
      if (result?.ok) {
        state.sessions = state.sessions.map((item) => item.session_id === sessionId ? result.session : item);
        state.editingSessionId = '';
        this.render();
      }
    }

    async deleteSession(sessionId) {
      const capture = this._capture();
      const id = text(sessionId);
      const state = this.getState();
      if (!id || id !== state.selectedSessionId || !state.control.owned) return;
      const result = await this.command('sessions.delete', {
        sessionId: id,
        controlGeneration: state.control.generation,
        expectedRevision: text(state.snapshot?.session?.revision),
        params: {},
      });
      if (!this._current(capture)) return;
      if (!result?.ok) return;
      state.sessions = state.sessions.filter((item) => item.session_id !== id);
      if (state.selectedSessionId === id) {
        this.stopHeartbeat();
        this.bumpGeneration();
        this.resetAssets();
        state.selectedSessionId = text(state.sessions[0]?.session_id);
        state.snapshot = null;
        state.liveProjection = null;
        state.activeStreamId = '';
        if (state.selectedSessionId) await this.loadSnapshot(state.selectedSessionId);
      }
      this.render();
    }

    async acquireControl(takeover, commandOptions = {}) {
      const capture = this._captureControl();
      const state = this.getState();
      if (!state.selectedSessionId || state.controlBusy) return;
      state.controlBusy = true;
      this.render();
      const result = await this.command('control.acquire', {
        sessionId: state.selectedSessionId,
        params: { takeover: takeover === true },
      }, commandOptions);
      if (!this._current(capture)) return;
      if (result?.ok && isRecord(result.lease) && this._currentControl(capture)) {
        this.resumeRecoveryPending = false;
        this.applyControlEvent({ ...result.lease, client_id: this.getClientId() });
      }
      state.controlBusy = false;
      this.render();
    }

    async releaseControl() {
      const capture = this._capture();
      const state = this.getState();
      if (!state.selectedSessionId || !state.control.owned || state.controlBusy) return;
      state.controlBusy = true;
      this.render();
      const result = await this.command('control.release', {
        sessionId: state.selectedSessionId,
        controlGeneration: state.control.generation,
        params: {},
      });
      if (!this._current(capture)) return;
      if (result?.ok) {
        this.resumeRecoveryPending = false;
        this.stopHeartbeat();
        state.control = this._emptyControl();
      }
      state.controlBusy = false;
      this.render();
    }

    async send() {
      const capture = this._capture();
      const state = this.getState();
      const prompt = text(state.draft).trim();
      if (!prompt || !state.control.owned || !state.selectedSessionId || state.activeStreamId
        || state.snapshotPending || state.snapshotUnavailable) return;
      const queued = Array.isArray(state.attachments) ? state.attachments : [];
      if (queued.some((item) => item.status === 'uploading')) {
        this.setError(jt("browserConversation.waitForAttachmentsToFinishUploading", "Wait for attachments to finish uploading."));
        return;
      }
      if (queued.some((item) => item.status === 'error' || !text(item.attachment?.id))) {
        this.setError(jt("browserConversation.removeOrRetryTheFailedAttachmentBeforeSending", "Remove or retry the failed attachment before sending."));
        return;
      }
      const attachmentIds = queued.map((item) => text(item.attachment?.id)).filter(Boolean);
      const result = await this.command('chat.send', {
        sessionId: state.selectedSessionId,
        controlGeneration: state.control.generation,
        expectedRevision: text(state.snapshot?.session?.revision),
        params: { prompt, ...(attachmentIds.length ? { attachment_ids: attachmentIds } : {}) },
      });
      if (!this._current(capture)) return;
      if (result?.ok && result.accepted === true && text(result.stream_id)) {
        state.activeStreamId = result.stream_id;
        state.draft = '';
        state.attachments = [];
        state.statusMessage = jt("app.jennyIsWorking", "Jenny is working…");
        void this.loadSnapshot(state.selectedSessionId);
        this.render();
      }
    }

    async cancel() {
      const capture = this._capture();
      const state = this.getState();
      const streamId = text(state.activeStreamId || state.snapshot?.active_turn?.stream_id);
      if (!streamId || !state.control.owned) return;
      state.composerMode = 'cancel';
      const result = await this.command('chat.cancel', {
        sessionId: state.selectedSessionId,
        controlGeneration: state.control.generation,
        expectedRevision: text(state.snapshot?.session?.revision),
        params: { stream_id: streamId },
      });
      if (!this._current(capture)) return;
      if (!result?.ok) state.composerMode = 'send';
      this.render();
    }

    async resolveApproval(action, approved) {
      const capture = this._capture();
      const state = this.getState();
      const approvalId = text(action?.dataset?.approvalId);
      const streamId = text(action?.dataset?.streamId);
      if (!approvalId || !streamId || !state.control.owned) return;
      state.pendingDecisionKey = `approval:${approvalId}`;
      this.render();
      await this.command('approval.resolve', {
        sessionId: state.selectedSessionId,
        controlGeneration: state.control.generation,
        expectedRevision: text(state.snapshot?.session?.revision),
        params: {
          stream_id: streamId,
          approval_id: approvalId,
          decision_revision: text(action.dataset.decisionRevision),
          approved: approved === true,
        },
      });
      if (!this._current(capture)) return;
      state.pendingDecisionKey = '';
      await this.loadSnapshot(state.selectedSessionId);
      this.render();
    }

    questionAnswers() {
      const blocks = Array.from(this.getRoot()?.querySelectorAll?.('[data-question-block]') || []);
      return blocks.map((block) => {
        const questionId = text(block.dataset.questionBlock);
        const checked = Array.from(block.querySelectorAll('[data-question-option-id]:checked'))
          .map((input) => text(input.dataset.questionOptionId))
          .filter(Boolean);
        const multiInput = block.querySelector('[data-question-multi="true"]');
        const answerControl = block.querySelector('[data-question-id]');
        let answer;
        if (checked.length || multiInput) {
          answer = checked.length
            ? checked
            : text(multiInput?.value).split(/[\n,]/).map((value) => value.trim()).filter(Boolean).slice(0, 8);
        } else {
          const value = text(answerControl?.value);
          answer = value === '__other__' ? '' : value;
        }
        const other = text(block.querySelector('[data-question-other-for]')?.value).trim();
        return { question_id: questionId, answer, ...(other ? { other } : {}) };
      }).filter((answer) => answer.question_id);
    }

    async answerQuestions(action) {
      const capture = this._capture();
      const state = this.getState();
      const questionRef = text(action?.dataset?.questionRef);
      const streamId = text(action?.dataset?.streamId);
      if (!questionRef || !streamId || !state.control.owned) return;
      const answers = this.questionAnswers();
      if (!answers.length) return;
      state.pendingDecisionKey = `questions:${questionRef}`;
      this.render();
      await this.command('questions.answer', {
        sessionId: state.selectedSessionId,
        controlGeneration: state.control.generation,
        expectedRevision: text(state.snapshot?.session?.revision),
        params: { stream_id: streamId, question_ref: questionRef, answers },
      });
      if (!this._current(capture)) return;
      state.pendingDecisionKey = '';
      await this.loadSnapshot(state.selectedSessionId);
      this.render();
    }

    async declineQuestions(action) {
      const capture = this._capture();
      const state = this.getState();
      const questionRef = text(action?.dataset?.questionRef);
      const streamId = text(action?.dataset?.streamId);
      if (!questionRef || !streamId || !state.control.owned) return;
      state.pendingDecisionKey = `questions:${questionRef}`;
      this.render();
      await this.command('questions.decline', {
        sessionId: state.selectedSessionId,
        controlGeneration: state.control.generation,
        expectedRevision: text(state.snapshot?.session?.revision),
        params: { stream_id: streamId, question_ref: questionRef },
      });
      if (!this._current(capture)) return;
      state.pendingDecisionKey = '';
      await this.loadSnapshot(state.selectedSessionId);
      this.render();
    }

    reset() {
      this.snapshots.reset();
      this.stopHeartbeat();
      this.heartbeatPending = null;
      this.resumeRecoveryPending = false;
    }

    dispose() {
      this.reset();
      this.visibilityTarget?.removeEventListener?.('visibilitychange', this._onVisibilityChange);
      this.focusTarget?.removeEventListener?.('focus', this._onFocus);
    }

    handleEvent(event) {
      if (this.isDisposed() || !isRecord(event)) return;
      if (this.snapshots.buffer(event)) return;
      if (event.event_type === 'resync_required') {
        void this.recoverFromEpoch(text(event.boot_epoch));
        return;
      }
      const state = this.getState();
      const sessionId = text(event.session_id);
      if (sessionId && state.selectedSessionId && sessionId !== state.selectedSessionId) {
        if (event.event_type === 'session_changed') void this.loadSessions();
        return;
      }
      if (event.event_type === 'session_changed') {
        void this.loadSessions();
        if (sessionId === state.selectedSessionId) void this.loadSnapshot(sessionId);
        return;
      }
      if (event.event_type === 'control_changed') {
        this.applyControlEvent(event);
        this.render();
        return;
      }
      if (event.event_type === 'chat_stream') {
        this.applyStreamEvent(event.event || {});
        return;
      }
      if (event.event_type === 'decision_changed') {
        void this.loadSnapshot(state.selectedSessionId);
      }
    }

    applyStreamEvent(event) {
      const streamId = text(event.stream_id);
      if (!streamId) return;
      const state = this.getState();
      const terminal = ['complete', 'error', 'cancelled', 'canceled', 'failed'].includes(text(event.type));
      if (terminal) {
        state.liveProjection = null;
        state.activeStreamId = '';
        void this.loadSnapshot(state.selectedSessionId);
        this.render();
        return;
      }
      const current = isRecord(state.liveProjection) && text(state.liveProjection.stream_id) === streamId
        ? {
          ...state.liveProjection,
          reasoning: Array.isArray(state.liveProjection.reasoning)
            ? state.liveProjection.reasoning.map((entry) => ({ ...entry }))
            : [],
        }
        : { stream_id: streamId, session_id: state.selectedSessionId, assistant_text: '', reasoning: [] };
      if (event.type === 'stream_reset') {
        current.assistant_text = '';
        current.reasoning = [];
      } else if (event.type === 'thinking_status') {
        current.thinking_status = text(event.text || event.status);
      } else if (event.type === 'delta') {
        current.assistant_text = text(
          event.aggregate,
          `${text(current.assistant_text)}${text(event.content)}`,
        ).slice(0, 262144);
        current.current_segment_text = current.assistant_text;
      }
      if (Array.isArray(event.reasoning)) {
        for (const entry of event.reasoning) {
          const entryId = text(entry?.id);
          if (!entryId) continue;
          const index = current.reasoning.findIndex((item) => text(item?.id) === entryId);
          if (index >= 0) current.reasoning[index] = { ...current.reasoning[index], ...entry };
          else current.reasoning.push({ ...entry });
        }
      }
      current.phase = text(event.type);
      state.liveProjection = current;
      state.activeStreamId = streamId;
      if (['started', 'tool_use', 'tool_approval_needed', 'tool_result', 'message_updated', 'question_batch', 'context_compacted'].includes(text(event.type))) {
        void this.loadSnapshot(state.selectedSessionId);
      }
      this.render();
    }
  }


  return { BrowserConversationController };
});
