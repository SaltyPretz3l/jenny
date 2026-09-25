(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.rendererDurableSend = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || ((_key, fallback) => fallback);
  const FIELDS = { prompt: 'prompt', visiblePrompt: 'visible_prompt', preferredModel: 'preferred_model',
    reasoningEffort: 'reasoning_effort', attachments: 'attachments', planMode: 'plan_mode',
    contextPreferences: 'context_preferences', activeFileContext: 'active_file_context', mentionContents: 'mention_contents',
    toolPreferences: 'tool_preferences', approvalMode: 'approval_mode', pluginCommandInvocation: 'plugin_command_invocation', skillInvocation: 'skill_invocation' };
  function eligible(state, shell, settings, prompt, interactive) {
    return state.features?.featureFlags?.session_runtime === true && typeof shell?.sessionRuntime?.submit === 'function'
      && Boolean(String(prompt || '').trim()) && !interactive && !settings.editedMessageId
      && !settings.failureRetry && !settings.failedPayloadId && !settings.editAndRegenerate;
  }
  // The runtime's own purpose vocabulary for an ordinary Send (service.js
  // _submit stores `rootStart?.purpose || 'chat'`): it names no prompt, so a
  // row carrying it gets a neutral label instead of the word "chat".
  const FIXED_PURPOSES = ['chat'];
  const DETACHED_PREFIX = 'work:';
  // Pending states the user can act on from the strip; `running` is not one.
  const RECOVERY_STATUSES = new Set(['unconfirmed', 'withdrawing', 'paused']);
  // One session-row read per conversation per 10 seconds, whoever asks for it.
  const ROWS_MAX_AGE_MS = 10000;
  // The pause half lives in its own module (file cap): it reads this
  // controller's snapshot rows, controls work through the same fresh-revision
  // path, and owns the only notice that may say "paused".
  function createPauseRequests(deps) {
    const owner = globalThis.rendererDurableSendPause
      || (typeof require === 'function' ? require('./renderer-durable-send-pause') : null);
    if (typeof owner?.createPauseRequests === 'function') return owner.createPauseRequests(deps);
    return { pauseSession: async () => false, settleAll: async () => {}, reconcile() {}, stateFor: () => null,
      forget() {}, sessionOf: () => '', watching: () => false, hasSession: () => false, dispose() {} };
  }
  function createController({ state, shell, receipts, callbacks: c, helpers, multiStreamController, isDisposed }) {
    const pending = new Map();
    const creations = new Map();
    const admitted = new Set();
    // Snapshot rows for a session, so paused work with no pending entry (the
    // reply that was running when it was paused) still has a visible row.
    const sessionWork = new Map();
    const sessionReads = new Map();
    const detachedWithdrawing = new Set();
    let readSequence = 0;
    let disposed = false;
    let pollTimer = null;
    let pollOffset = 0;
    let polling = false;
    const closed = () => disposed || isDisposed();
    const pauses = createPauseRequests({ state, callbacks: c, closed,
      render: id => render(id), refreshSessionQueue: id => refreshSessionQueue(id),
      getSessionRows: id => sessionWork.get(id)?.rows || [],
      controlDetached: (workId, owner, invoke) => controlDetached(workId, owner, invoke),
      noticeRefusal: (source, owner) => noticeRefusal(source, owner), schedulePoll: () => schedulePoll(),
      pause: typeof shell.sessionRuntime?.pause === 'function' ? payload => shell.sessionRuntime.pause(payload) : null,
      getWork: typeof shell.sessionRuntime?.getWork === 'function' ? payload => shell.sessionRuntime.getWork(payload) : null });
    function render(sessionId) {
      if (closed()) return;
      c.renderSessions();
      if (state.currentSessionId === sessionId) { c.renderMessages(); c.renderHeader(); c.renderComposerState(); }
    }
    function retire(entry) {
      pending.delete(entry.key);
      const messages = c.getSessionMessages(entry.sessionId).filter(row => row.id !== entry.userId);
      c.setSessionMessages(entry.sessionId, messages, `session_${entry.sessionId}`);
      // Durable work remains the media owner; renderer retirement never deletes it.
      render(entry.sessionId);
    }
    function reconcileWork(work) {
      if (closed() || !['completed', 'failed', 'cancelled'].includes(work?.status)) return;
      for (const entry of pending.values()) {
        if (entry.workId !== work.work_id || entry.sessionId !== work.session_id || entry.turnId !== work.turn_id) continue;
        retire(entry);
      }
    }
    function refusalFor(source) {
      try {
        const owner = globalThis.rendererRuntimeRefusals
          || (typeof require === 'function' ? require('./renderer-runtime-refusals') : null);
        return owner?.describeRuntimeRefusal?.(source) || null;
      } catch (_error) { return null; }
    }
    function noticeRefusal(source, owner) {
      const refusal = refusalFor(source);
      if (!refusal) return null;
      c.setComposerStatusNotice(`${refusal.title} ${refusal.hint}`,
        { owner, tone: refusal.severity === 'danger' ? 'danger' : 'warning' });
      return refusal;
    }
    function orderOf(entry) {
      return Number.isSafeInteger(entry.submissionSequence) ? entry.submissionSequence : Number.MAX_SAFE_INTEGER;
    }
    function sequenceOf(row) {
      return Number.isSafeInteger(row?.submission_sequence) ? row.submission_sequence : Number.MAX_SAFE_INTEGER;
    }
    // A detached row carries no prompt: the snapshot summary has only `purpose`.
    function detachedPrompt(row) {
      const purpose = String(row?.purpose || '').trim();
      return purpose && !FIXED_PURPOSES.includes(purpose)
        ? purpose : jt('chat.runtimeQueue.pausedReply', 'Paused reply');
    }
    function listPending(sessionId) {
      const id = String(sessionId || '').trim();
      if (!id) return [];
      // Strip membership is re-derived on every read: a direct Send can be
      // overtaken (another Send admitted first), renumbered 2 -> 1 when the row
      // ahead starts running, or stalled behind work that arrived later, so the
      // submit-time stamp is only the sticky floor. `running` is never a queue
      // state (that is the direct Send itself, pending admission).
      const busy = multiStreamController?.isSessionSendBusy?.(id) === true;
      const entries = [...pending.values()].filter(entry => entry.sessionId === id)
        .sort((left, right) => orderOf(left) - orderOf(right))
        .map((entry, index) => Object.freeze({ key: entry.key, workId: entry.workId, turnId: entry.turnId,
          prompt: entry.prompt, position: entry.position, status: entry.workStatus, admitted: entry.admitted,
          queued: entry.queued === true || index > 0 || busy
            || (Number.isSafeInteger(entry.position) && entry.position > 1) || RECOVERY_STATUSES.has(entry.workStatus) }));
      const owned = new Set(entries.map(row => row.workId).filter(Boolean));
      // Paused work the composer never queued (it was running when it paused)
      // still needs a row, because Resume is the only way it ever moves again.
      const detached = (sessionWork.get(id)?.rows || [])
        .filter(row => row.status === 'paused' && !owned.has(row.work_id))
        .sort((left, right) => sequenceOf(left) - sequenceOf(right))
        .map(row => Object.freeze({ key: DETACHED_PREFIX + row.work_id, workId: row.work_id,
          turnId: String(row.turn_id || ''), prompt: detachedPrompt(row), position: null,
          status: detachedWithdrawing.has(row.work_id) ? 'withdrawing' : 'paused', admitted: true, detached: true, queued: true }));
      return detached.length ? [...entries, ...detached] : entries;
    }
    function getSessionRuntimeState(sessionId) {
      const id = String(sessionId || '').trim();
      return Object.freeze({ closing: sessionWork.get(id)?.closing === true, pause: pauses.stateFor(id) });
    }
    // ONE snapshot read serves the whole visible queue: places in line come from
    // the runtime's own submission order, never from renderer arithmetic.
    async function refreshSessionQueue(sessionId) {
      let result;
      const sequence = ++readSequence;
      try { result = await shell.sessionRuntime.getSnapshot({ session_id: sessionId, limit: 100 }); }
      catch (_error) { return false; }
      // An unavailable or cursor-stale read simply retries on the next tick;
      // reporting false lets the caller fall back to per-work reads meanwhile.
      if (closed() || result?.ok !== true || !Array.isArray(result.work)) return false;
      // A slower read never overwrites rows a newer one has already landed.
      if ((sessionWork.get(sessionId)?.sequence || 0) > sequence) return true;
      const rows = result.work.filter(row => row?.session_id === sessionId);
      // A paused turn's approval card reads the paused rows, so a change repaints.
      const pausedTurns = list => (list || []).filter(row => row.status === 'paused').map(row => row.turn_id).sort().join();
      const pausedChanged = pausedTurns(sessionWork.get(sessionId)?.rows) !== pausedTurns(rows);
      // Bounded retained state: the newest few conversations keep their rows,
      // and re-inserting moves this session to the young end of the map.
      sessionWork.delete(sessionId);
      sessionWork.set(sessionId, { rows, closing: result.closing === true, at: Date.now(), sequence });
      if (sessionWork.size > 16) sessionWork.delete(sessionWork.keys().next().value);
      for (const row of rows) reconcileWork(row);
      if (closed()) return false;
      pauses.reconcile(sessionId, rows);
      // Past one page the true place in line is unknown: say queued, not a number.
      const numbered = result.next_cursor === null || result.next_cursor === undefined;
      // Only pending rows are "in line": the running turn is the reply in
      // progress, so the first pending row behind it is the one that runs next.
      const ahead = rows.filter(row => row.status === 'pending');
      let changed = false;
      for (const entry of pending.values()) {
        if (entry.sessionId !== sessionId || !entry.workId) continue;
        const row = rows.find(item => item.work_id === entry.workId);
        if (!row) {
          // Off the first page its place in line is unknown: drop any old number.
          if (entry.position !== null) { entry.position = null; changed = true; }
          continue;
        }
        const status = entry.workStatus === 'withdrawing' ? 'withdrawing' : row.status;
        const position = numbered && row.status === 'pending'
          ? 1 + ahead.filter(item => item.submission_sequence < row.submission_sequence).length : null;
        changed = changed || entry.workStatus !== status || entry.position !== position
          || entry.revision !== row.revision || entry.submissionSequence !== row.submission_sequence;
        entry.workStatus = status; entry.position = position;
        entry.revision = row.revision; entry.submissionSequence = row.submission_sequence;
      }
      if (changed || pausedChanged) render(sessionId);
      return true;
    }
    // One in-flight read per session, no timer: the chrome asks for rows when
    // the visible session has none, and the 2-second poller stays the only clock.
    function refreshSessionRows(sessionId) {
      const id = String(sessionId || '').trim();
      if (closed() || !id || typeof shell.sessionRuntime?.getSnapshot !== 'function') return Promise.resolve(false);
      const inflight = sessionReads.get(id);
      if (inflight) return inflight;
      const cached = sessionWork.get(id);
      if (cached && Date.now() - cached.at < ROWS_MAX_AGE_MS) return Promise.resolve(true);
      const read = Promise.resolve(refreshSessionQueue(id))
        .then(covered => { if (sessionReads.get(id) === read) sessionReads.delete(id); return covered; },
          () => { if (sessionReads.get(id) === read) sessionReads.delete(id); return false; });
      sessionReads.set(id, read);
      return read;
    }
    // A lost acknowledgement is re-asked with the same immutable submission: the
    // idempotency key makes the runtime answer with the existing work, never a
    // new Send, so an unconfirmed row resolves instead of lingering forever.
    async function confirmUnacknowledged(entries) {
      if (!entries.length || typeof shell.sessionRuntime?.submit !== 'function') return;
      for (const entry of entries.slice(0, 8)) {
        let result;
        try { result = await shell.sessionRuntime.submit(entry.payload); } catch (_error) { continue; }
        if (closed()) return;
        if (result?.ok === true && result.session_id === entry.sessionId && result.work_id && result.turn_id) {
          entry.workId = result.work_id; entry.turnId = result.turn_id; entry.workStatus = 'pending'; entry.payload = null;
          render(entry.sessionId);
        } else if (result?.ok === false && result.acceptance === 'rejected') {
          retire(entry);
          noticeRefusal(result, 'runtime:refusal');
        }
      }
    }
    async function refreshPending() {
      if (closed() || polling || typeof shell.sessionRuntime?.getWork !== 'function') return;
      const rows = [...pending.values()].filter(entry => entry.workId || entry.payload);
      // An outstanding pause request is watched on the same clock: no second timer.
      const watching = pauses.watching();
      // A hidden window shows no queue; the next visible tick reads it.
      if ((!rows.length && !watching) || globalThis.document?.visibilityState === 'hidden') return;
      polling = true;
      try {
        const sessionId = String(state.currentSessionId || '').trim();
        await confirmUnacknowledged(rows.filter(entry => !entry.workId && entry.payload));
        if (closed()) return;
        const tracked = rows.filter(entry => entry.workId);
        const shared = typeof shell.sessionRuntime.getSnapshot === 'function'
          && (tracked.some(entry => entry.sessionId === sessionId)
            || pauses.hasSession(sessionId));
        const covered = shared ? await refreshSessionQueue(sessionId) : false;
        await pauses.settleAll();
        if (closed()) return;
        // Entries parked in other conversations have no visible queue, and a
        // failed snapshot read covers nothing: one bounded batch of work reads
        // still retires them.
        const batchable = covered ? tracked.filter(entry => entry.sessionId !== sessionId) : tracked;
        if (!batchable.length || closed()) return;
        const batch = Array.from({ length: Math.min(8, batchable.length) }, (_, i) => batchable[(pollOffset + i) % batchable.length]);
        pollOffset = (pollOffset + batch.length) % batchable.length;
        await Promise.all(batch.map(async entry => {
          try {
            const result = await shell.sessionRuntime.getWork({ work_id: entry.workId });
            if (!closed() && result?.ok) reconcileWork(result.work);
          } catch (_error) { /* No terminal proof: keep the pending receipt. */ }
        }));
      } finally { polling = false; }
    }
    // Durable work is never controlled at a guessed revision: read it, then act.
    async function control(key, owner, invoke) {
      const entry = pending.get(String(key || '').trim());
      if (closed() || !entry?.workId || typeof shell.sessionRuntime?.getWork !== 'function') return false;
      const previous = entry.workStatus;
      if (owner === 'runtime:withdraw') { entry.workStatus = 'withdrawing'; render(entry.sessionId); }
      try {
        const read = await shell.sessionRuntime.getWork({ work_id: entry.workId });
        if (closed()) return false;
        if (read?.ok !== true || !Number.isSafeInteger(read.work?.revision)) {
          throw Object.assign(new Error('runtime_revision_unavailable'), { refusal: read });
        }
        const result = await invoke({ work_id: entry.workId, expected_revision: read.work.revision });
        if (closed()) return false;
        if (result?.ok !== true) throw Object.assign(new Error('runtime_control_refused'), { refusal: result });
        entry.revision = read.work.revision;
        return result;
      } catch (error) {
        if (closed()) return false;
        entry.workStatus = previous;
        noticeRefusal(error?.refusal || error, owner);
        render(entry.sessionId);
        return false;
      }
    }
    async function withdraw(key) {
      if (typeof shell.sessionRuntime?.cancel !== 'function') return false;
      const id = String(key || '').trim();
      if (id.startsWith(DETACHED_PREFIX)) return discardDetached(id.slice(DETACHED_PREFIX.length));
      const result = await control(key, 'runtime:withdraw', payload => shell.sessionRuntime.cancel(payload));
      if (!result || closed()) return false;
      const entry = pending.get(String(key || '').trim());
      if (!entry) return true;
      // Nothing is withdrawn until the runtime confirms cleanup; until then the
      // row stays visible and says it is still being withdrawn.
      if (result.cleanup_confirmed === true) retire(entry); else render(entry.sessionId);
      return true;
    }
    // Durable work is never controlled at a guessed revision, whether or not
    // this renderer owns a pending entry for it.
    async function controlDetached(workId, owner, invoke) {
      if (closed() || !workId || typeof shell.sessionRuntime?.getWork !== 'function') return null;
      try {
        const read = await shell.sessionRuntime.getWork({ work_id: workId });
        if (closed()) return null;
        if (read?.ok !== true || !Number.isSafeInteger(read.work?.revision)) {
          throw Object.assign(new Error('runtime_revision_unavailable'), { refusal: read });
        }
        const result = await invoke({ work_id: workId, expected_revision: read.work.revision });
        if (closed()) return null;
        if (result?.ok !== true) throw Object.assign(new Error('runtime_control_refused'), { refusal: result });
        return result;
      } catch (error) {
        if (!closed()) noticeRefusal(error?.refusal || error, owner);
        return null;
      }
    }
    // A paused reply the composer never queued is discarded the same way a
    // queued message is withdrawn: cancel at its fresh revision. The row says
    // it is being withdrawn meanwhile and leaves only once the snapshot no
    // longer lists the work as paused, never on the renderer's say-so.
    async function discardDetached(workId) {
      if (closed() || detachedWithdrawing.has(workId)) return false;
      const sessionId = sessionOf(workId);
      detachedWithdrawing.add(workId);
      render(sessionId);
      try {
        const result = await controlDetached(workId, 'runtime:withdraw', payload => shell.sessionRuntime.cancel(payload));
        if (!result || closed()) return false;
        pauses.forget(workId, sessionId);
        await refreshSessionQueue(sessionId);
        return !closed();
      } finally {
        detachedWithdrawing.delete(workId);
        if (!closed()) render(sessionId);
      }
    }
    function sessionOf(workId) {
      for (const [sessionId, cached] of sessionWork) {
        if (cached.rows?.some(row => row.work_id === workId)) return sessionId;
      }
      return pauses.sessionOf(workId) || String(state.currentSessionId || '').trim();
    }
    async function resume(key) {
      if (typeof shell.sessionRuntime?.resume !== 'function') return false;
      const id = String(key || '').trim();
      if (id.startsWith(DETACHED_PREFIX)) {
        const workId = id.slice(DETACHED_PREFIX.length);
        const sessionId = sessionOf(workId);
        if (!await controlDetached(workId, 'runtime:resume', payload => shell.sessionRuntime.resume(payload))) return false;
        pauses.forget(workId, sessionId);
        await refreshSessionQueue(sessionId);
        if (!closed()) render(sessionId);
        return true;
      }
      const result = await control(key, 'runtime:resume', payload => shell.sessionRuntime.resume(payload));
      if (!result || closed()) return false;
      const entry = pending.get(id);
      if (entry) { entry.workStatus = 'pending'; render(entry.sessionId); }
      return true;
    }
    function schedulePoll() {
      if (closed() || pollTimer) return;
      if (![...pending.values()].some(entry => entry.workId || entry.payload)
        && !pauses.watching()) return;
      pollTimer = setTimeout(async () => {
        pollTimer = null;
        await refreshPending();
        schedulePoll();
      }, 2000);
      pollTimer?.unref?.();
    }
    async function canonicalSession(entry, context) {
      if (!context.createdOptimisticSession && !context.requestedSession?.optimistic_local && !creations.has(entry.sessionId)) return entry.sessionId;
      const origin = entry.sessionId;
      if (!creations.has(origin)) {
        const preferences = { preferred_model: context.runtimePreferences.preferredModel,
          reasoning_effort: context.runtimePreferences.reasoningEffort, run_mode: context.runModeProjection.runMode,
          plan_mode: context.runModeProjection.planMode, context_preferences: context.runtimePreferences.contextPreferences };
        const promise = Promise.resolve(shell.sessions.create({ title: helpers.clipSessionTitle(context.visiblePrompt), preferences,
          draftImageAttachments: context.acceptedAttachments.filter(image => image.kind === 'image'),
          ...(context.requestedSession?.project_id ? { projectId: context.requestedSession.project_id } : {}) })).then(result => {
          const session = result?.data;
          if (!session?.id) throw new Error('session_create_failed');
          if (!closed()) {
            c.rekeySessionState(origin, session.id); c.rekeySessionOrigin(origin, session.id);
            c.upsertSessionSummary({ ...session, optimistic_local: false, local_draft: false });
          }
          for (const row of pending.values()) if (row.sessionId === origin) row.sessionId = session.id;
          return session.id;
        });
        creations.set(origin, promise);
        promise.catch(() => creations.delete(origin));
      }
      const creation = creations.get(origin);
      try { return await creation; }
      finally { if (creations.get(origin) === creation) creations.delete(origin); }
    }
    function initial(context) {
      const { optimisticSessionId, createdOptimisticSession, visiblePrompt, acceptedAttachments, sendReceipt } = context;
      const entry = { key: `durable_${sendReceipt.id}`, sessionId: optimisticSessionId, workId: '', turnId: '',
        userId: `user_${sendReceipt.id}`, message: null, admitted: false,
        // Queue projection: the place in line stays unknown until the runtime
        // reports it, so the strip can say "queued" without inventing a number.
        prompt: String(visiblePrompt || ''), position: null, workStatus: 'pending',
        revision: 0, submissionSequence: null };
      // An idle Send is direct; only work behind an active turn or another
      // pending Send belongs in the strip. Sticky: it stays queued until admitted.
      entry.queued = multiStreamController?.isSessionSendBusy?.(entry.sessionId) === true
        || [...pending.values()].some(row => row.sessionId === entry.sessionId);
      pending.set(entry.key, entry);
      if (createdOptimisticSession) {
        const now = new Date().toISOString();
        c.upsertSessionSummary({ id: optimisticSessionId, title: helpers.clipSessionTitle(visiblePrompt),
          session_type: 'chat', created_at: now, updated_at: now, message_count: 0, optimistic_local: true, local_draft: false,
          ...(context.requestedSession?.project_id ? { project_id: context.requestedSession.project_id } : {}) }, { prepend: true });
        state.currentSessionId = optimisticSessionId; c.attachPendingOriginToSession(optimisticSessionId);
      }
      c.optimisticAppend(optimisticSessionId, 'user', visiblePrompt, { id: entry.userId,
        attachments: helpers.buildOptimisticAttachmentMetadata(acceptedAttachments),
        // The skill pill shows from Send, as on the direct path, not only once
        // the persisted message hydrates at the end of the turn.
        ...(context.skillInvocation?.id ? { skill_invocation: context.skillInvocation } : {}) });
      entry.message = c.getSessionMessages(optimisticSessionId).find(row => row.id === entry.userId);
      if (!context.preserveComposerDraft) c.syncComposerInputHeight();
      render(entry.sessionId);
      return entry;
    }
    function capturePayload(entry, context, mentionContents) {
      const normalizePath = value => String(value || '').trim().replace(/\\/g, '/');
      const snapshot = context.activeFileContextSnapshot;
      const activeFileContext = snapshot?.path && mentionContents.some(row => normalizePath(row?.path) === normalizePath(snapshot.path))
        ? null : snapshot;
      const source = { prompt: context.effectivePrompt, visiblePrompt: context.visiblePrompt,
        ...context.runtimePreferences, planMode: context.runModeProjection.planMode,
        attachments: context.acceptedAttachments, toolPreferences: context.toolPreferences, approvalMode: context.approvalMode,
        activeFileContext, mentionContents,
        ...(context.pluginCommandInvocation ? { pluginCommandInvocation: context.pluginCommandInvocation } : {}),
        ...(context.skillInvocation?.id ? { skillInvocation: { id: context.skillInvocation.id } } : {}) };
      const payload = { session_id: entry.sessionId, idempotency_key: entry.key };
      for (const [key, wire] of Object.entries(FIELDS)) if (source[key] !== undefined) payload[wire] = source[key];
      return JSON.parse(JSON.stringify(payload));
    }
    async function submitCaptured(payload) {
      // A lost acknowledgement retries the same immutable submission, never a new Send.
      try { return { result: await shell.sessionRuntime.submit(payload), retried: false }; }
      catch (_error) { return { result: await shell.sessionRuntime.submit(payload), retried: true }; }
    }
    async function send(context) {
      if (closed() || pending.size >= 128) return null;
      const entry = initial(context);
      let hold = null;
      let attempted = false;
      let payload = null;
      try {
        const snapshot = Object.hasOwn(context.settings, 'activeFileContextSnapshot') ? context.settings.activeFileContextSnapshot
          : shell.activeFileContext?.readActiveFileContextForTurn?.({ mentionedPaths: [],
            attachedPaths: context.attachedPaths, attachedNames: context.attachedNames }) || null;
        context = { ...context, activeFileContextSnapshot: snapshot ? JSON.parse(JSON.stringify(snapshot)) : null };
        const mentions = await context.mentionContentsPromise;
        if (closed()) return null;
        entry.sessionId = await canonicalSession(entry, context);
        if (closed()) return null;
        payload = capturePayload(entry, context, Array.isArray(mentions) ? mentions : []);
        const sealed = receipts.seal(context.sendReceipt, { mentionContents: payload.mention_contents, activeFileContext: payload.active_file_context });
        if (!sealed) return null;
        hold = receipts.holdForDurableSubmission(sealed);
        if (!hold) return null;
        attempted = true;
        const { result, retried } = await submitCaptured(payload);
        if (result?.ok === false && result.acceptance === 'rejected' && !retried && !entry.admitted) {
          attempted = false;
          hold(false);
          // Carry the rejection so the catch can name the reason instead of
          // reporting every refusal as one generic failure.
          throw Object.assign(new Error('submission_refused'), { result });
        }
        if (!result?.ok || result.session_id !== entry.sessionId || !result.work_id || !result.turn_id) throw new Error('acceptance_unconfirmed');
        if ((entry.workId && entry.workId !== result.work_id) || (entry.turnId && entry.turnId !== result.turn_id)) throw new Error('admission_identity_conflict');
        hold(true);
        if (closed()) return result;
        entry.workId = result.work_id; entry.turnId = result.turn_id;
        receipts.settleAccepted(sealed, { sessionId: entry.sessionId });
        if (payload.active_file_context?.path) shell.activeFileContext?.markTurnAccepted?.(payload.active_file_context.path);
        schedulePoll();
        render(entry.sessionId);
        return { ...result, sessionId: entry.sessionId, durable: true, queued: !entry.admitted };
      } catch (_error) {
        if (attempted) {
          // A transport or persistence failure is not evidence that no work exists.
          // Preserve the media owner and optimistic row; inspect the durable work list.
          hold?.(true);
          // Keep the captured submission so the poller can re-ask under the same
          // idempotency key; the strip shows the row as confirming meanwhile.
          entry.payload = payload; entry.workStatus = 'unconfirmed';
          schedulePoll();
          if (!closed()) {
            receipts.settleAccepted(context.sendReceipt, { sessionId: entry.sessionId });
            if (state.currentSessionId === entry.sessionId) c.setComposerStatusNotice(jt('runtime.ui.acceptanceUnknown', 'Acceptance is not confirmed. Check the work list before sending again.'), { owner: 'runtime:acceptance', tone: 'warning' });
          }
        } else {
          pending.delete(entry.key);
          if (!closed()) {
            const messages = c.getSessionMessages(entry.sessionId).filter(row => row.id !== entry.userId);
            c.setSessionMessages(entry.sessionId, messages, `session_${entry.sessionId}`);
            if (context.createdOptimisticSession && entry.sessionId === context.optimisticSessionId) {
              c.upsertSessionSummary({ id: entry.sessionId, local_draft: true, optimistic_local: true, message_count: messages.length });
            }
            // A wait is explained in the composer; only a decision interrupts.
            const refusal = _error?.result ? refusalFor(_error.result) : null;
            if (refusal?.severity === 'calm') {
              c.setComposerStatusNotice(`${refusal.title} ${refusal.hint}`, { owner: 'runtime:refusal', tone: 'warning' });
            } else {
              c.showComposerActionError?.(new Error(refusal?.hint
                || jt('runtime.ui.failedAction', 'The change could not be applied. Refresh and try again.')),
              refusal?.title || jt('chat.send.failedTitle', 'Send Failed'));
            }
          }
          receipts.settleFailed(context.sendReceipt, { sessionId: entry.sessionId });
        }
        render(entry.sessionId); return { durable: true, acceptanceUnknown: attempted, sessionId: entry.sessionId };
      }
    }
    function acceptAdmission(payload) {
      const receipt = payload?.runtimeAdmission || payload?.payload?.runtimeAdmission;
      if (!receipt) return true;
      if (receipt.session_id !== payload.sessionId || receipt.stream_id !== payload.streamId || receipt.turn_id !== payload.turnId
        || ['work_id', 'turn_id', 'session_id', 'stream_id', 'user_message_id', 'idempotency_key'].some(key => typeof receipt[key] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(receipt[key]))) return false;
      const started = payload.type === 'started'
        || (payload.eventKind === 'started' && payload.channel === 'control');
      if (started && admitted.has(receipt.stream_id)) return false;
      if (started) {
        admitted.add(receipt.stream_id);
        if (admitted.size > 256) admitted.delete(admitted.values().next().value);
      }
      const entry = pending.get(receipt.idempotency_key);
      if (!entry || closed()) return true;
      if (entry.sessionId !== receipt.session_id || (entry.workId && entry.workId !== receipt.work_id)
        || (entry.turnId && entry.turnId !== receipt.turn_id)) return false;
      entry.admitted = true; entry.workId = receipt.work_id; entry.turnId = receipt.turn_id;
      pending.delete(entry.key);
      helpers.adoptPersistedUserMessageIdInStore(entry.sessionId, entry.userId, receipt.user_message_id);
      const messages = c.getSessionMessages(entry.sessionId).map(row => row.id === receipt.user_message_id
        ? { ...row, turn_id: receipt.turn_id, request_id: receipt.stream_id } : row);
      c.setSessionMessages(entry.sessionId, messages, `session_${entry.sessionId}`);
      multiStreamController?.registerStream?.(entry.sessionId, receipt.stream_id);
      return true;
    }
    function mergePending(sessionId, messages) {
      const rows = Array.isArray(messages) ? messages : [];
      const additions = [...pending.values()].filter(row => row.sessionId === sessionId && row.message
        && !rows.some(message => message.id === row.userId || (row.turnId && message.role === 'user' && message.turn_id === row.turnId)));
      return additions.length ? [...rows, ...additions.map(row => row.message)] : messages;
    }
    function dispose() { disposed = true; clearTimeout(pollTimer); pending.clear(); creations.clear(); admitted.clear();
      sessionWork.clear(); sessionReads.clear(); pauses.dispose(); detachedWithdrawing.clear();
      if (state.runtimeSendController === api) state.runtimeSendController = null; }
    // Only a stream the runtime admitted through this controller can be paused.
    const ownsStream = streamId => admitted.has(String(streamId || '').trim());
    const api = { send, acceptAdmission, mergePending, refreshPending, reconcileWork, listPending,
      withdraw, resume, pauseSession: sessionId => pauses.pauseSession(sessionId),
      refreshSessionRows, getSessionRuntimeState, ownsStream,
      dispose, hasCapacity: () => pending.size < 128 };
    state.runtimeSendController = api;
    return api;
  }
  return { createController, eligible };
});
