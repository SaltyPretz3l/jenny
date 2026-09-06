/* renderer/chat/renderer-composer-v2-state.js - Composer V2 in-memory state surface. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shell/renderer-settings-support'));
    return;
  }
  root.rendererComposerV2State = factory(root.rendererSettingsSupport);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (settingsSupport) {
  'use strict';

  const COMPOSER_LIFECYCLE = Object.freeze({
    IDLE: 'idle',
    DRAFTING: 'drafting',
    QUEUED: 'queued',
    SENDING: 'sending',
    FAILED: 'failed',
  });

  const ALLOWED_LIFECYCLE_TRANSITIONS = Object.freeze({
    idle: new Set(['idle', 'drafting']),
    drafting: new Set(['drafting', 'queued', 'sending', 'failed', 'idle']),
    queued: new Set(['queued', 'sending', 'drafting', 'idle']),
    sending: new Set(['sending', 'drafting', 'failed', 'idle']),
    failed: new Set(['failed', 'drafting', 'idle']),
  });

  const COMPOSER_LIFECYCLE_VALUES = new Set(Object.values(COMPOSER_LIFECYCLE));
  const RUN_MODE_ORDER = Object.freeze(['ask', 'auto', 'plan']);
  const normalizeRunMode = settingsSupport.normalizeRunMode;
  const UNSAFE_JSON_CLONE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

  function ensureUi(state) {
    if (!state || typeof state !== 'object') return null;
    if (!state.ui || typeof state.ui !== 'object') {
      state.ui = {};
    }
    return state.ui;
  }

  function normalizeSessionId(sessionId) {
    return String(sessionId || '').trim();
  }

  function cloneJsonLike(value, seen = new WeakSet()) {
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return null;
    seen.add(value);

    let clone;
    if (Array.isArray(value)) {
      clone = value.map((entry) => cloneJsonLike(entry, seen));
    } else {
      clone = {};
      for (const [key, entry] of Object.entries(value)) {
        if (UNSAFE_JSON_CLONE_KEYS.has(key)) continue;
        clone[key] = cloneJsonLike(entry, seen);
      }
    }
    seen.delete(value);
    return clone;
  }

  function normalizeLifecycle(value) {
    const token = String(value || '').trim().toLowerCase();
    return COMPOSER_LIFECYCLE_VALUES.has(token) ? token : '';
  }

  function projectRunMode(value, options) {
    const runMode = normalizeRunMode(value, options);
    return {
      runMode,
      approvalMode: runMode === 'auto' ? 'auto_run' : 'prompt',
      planMode: runMode === 'plan',
    };
  }

  function nextRunMode(value) {
    const currentIndex = RUN_MODE_ORDER.indexOf(normalizeRunMode(value));
    return RUN_MODE_ORDER[(currentIndex + 1) % RUN_MODE_ORDER.length];
  }

  function ensureComposerV2State(state) {
    const ui = ensureUi(state);
    if (!ui) return null;
    if (!ui.composerV2 || typeof ui.composerV2 !== 'object') {
      ui.composerV2 = {
        modeListeners: new Map(),
        globalListeners: new Set(),
        draftsBySession: new Map(),
        lifecycleBySession: new Map(),
        toolToggleState: new Map(),
        availableToolCategories: new Map(),
        toolCategoryMeta: new Map(),
        sessionOverrideCategories: new Set(),
        pendingSkillInvocation: null,
        pendingSkillInvocationSessionId: '',
      };
      return ui.composerV2;
    }
    if (!(ui.composerV2.modeListeners instanceof Map)) {
      ui.composerV2.modeListeners = new Map();
    }
    if (!(ui.composerV2.globalListeners instanceof Set)) {
      ui.composerV2.globalListeners = new Set();
    }
    if (!(ui.composerV2.draftsBySession instanceof Map)) {
      ui.composerV2.draftsBySession = new Map();
    }
    if (!(ui.composerV2.lifecycleBySession instanceof Map)) {
      ui.composerV2.lifecycleBySession = new Map();
    }
    if (!(ui.composerV2.toolToggleState instanceof Map)) {
      ui.composerV2.toolToggleState = new Map();
    }
    if (!(ui.composerV2.availableToolCategories instanceof Map)) {
      ui.composerV2.availableToolCategories = new Map();
    }
    if (!(ui.composerV2.toolCategoryMeta instanceof Map)) {
      ui.composerV2.toolCategoryMeta = new Map();
    }
    if (!(ui.composerV2.sessionOverrideCategories instanceof Set)) {
      ui.composerV2.sessionOverrideCategories = new Set();
    }
    return ui.composerV2;
  }

  function normalizeSkillInvocation(value) {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string') return null;
    return Object.fromEntries(
      ['id', 'name', 'scope', 'command']
        .filter((key) => typeof value[key] === 'string')
        .map((key) => [key, value[key]])
    );
  }

  function getPendingSkillInvocation(state) {
    const composer = ensureComposerV2State(state);
    const pending = normalizeSkillInvocation(composer?.pendingSkillInvocation);
    if (!pending) return null;
    // A pending skill belongs to the session that attached it; switching
    // sessions drops it so another chat's turn is never steered by it.
    if (String(composer.pendingSkillInvocationSessionId || '') !== normalizeSessionId(state?.currentSessionId)) {
      composer.pendingSkillInvocation = null;
      composer.pendingSkillInvocationSessionId = '';
      return null;
    }
    return pending;
  }

  function setPendingSkillInvocation(state, invocation) {
    const composer = ensureComposerV2State(state);
    const normalized = normalizeSkillInvocation(invocation);
    if (!composer || !normalized) return null;
    composer.pendingSkillInvocation = normalized;
    composer.pendingSkillInvocationSessionId = normalizeSessionId(state?.currentSessionId);
    return { ...normalized };
  }

  function clearPendingSkillInvocation(state) {
    const composer = ensureComposerV2State(state);
    if (!composer || !composer.pendingSkillInvocation) return false;
    composer.pendingSkillInvocation = null;
    composer.pendingSkillInvocationSessionId = '';
    return true;
  }

  function getLifecycleForSession(state, sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) return COMPOSER_LIFECYCLE.IDLE;
    const composer = ensureComposerV2State(state);
    const lifecycle = normalizeLifecycle(composer?.lifecycleBySession?.get?.(normalizedSessionId));
    return lifecycle || COMPOSER_LIFECYCLE.IDLE;
  }

  function setLifecycleForSession(state, sessionId, nextLifecycle, options = {}) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const previous = getLifecycleForSession(state, normalizedSessionId);
    const lifecycle = normalizeLifecycle(nextLifecycle);
    const reason = lifecycle ? 'illegal_transition' : 'invalid_lifecycle';
    const allowed = lifecycle && ALLOWED_LIFECYCLE_TRANSITIONS[previous]?.has(lifecycle);
    if (!normalizedSessionId || !allowed) {
      const rejected = {
        ok: false,
        previous,
        lifecycle: lifecycle || String(nextLifecycle || '').trim().toLowerCase(),
        reason,
      };
      if (typeof options.log === 'function') {
        options.log({
          sessionId: normalizedSessionId,
          previous,
          lifecycle: rejected.lifecycle,
          reason,
        });
      }
      return rejected;
    }
    const composer = ensureComposerV2State(state);
    if (lifecycle === COMPOSER_LIFECYCLE.IDLE) {
      composer.lifecycleBySession.delete(normalizedSessionId);
    } else {
      composer.lifecycleBySession.set(normalizedSessionId, lifecycle);
    }
    return { ok: true, previous, lifecycle };
  }

  function normalizeDraftEntry(sessionId, draft) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId || !draft || typeof draft !== 'object') return null;
    const createdAt = Number(draft.createdAt || 0);
    const source = String(draft.source || '').trim() || 'inline';
    return {
      sessionId: normalizedSessionId,
      prompt: String(draft.prompt || ''),
      attachments: cloneJsonLike(Array.isArray(draft.attachments) ? draft.attachments : []),
      runtimePreferences: draft.runtimePreferences ? cloneJsonLike(draft.runtimePreferences) : null,
      createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now(),
      source,
      meta: draft.meta && typeof draft.meta === 'object' ? cloneJsonLike(draft.meta) : {},
    };
  }

  function setDraftForSession(state, sessionId, draft) {
    const normalizedDraft = normalizeDraftEntry(sessionId, draft);
    const composer = ensureComposerV2State(state);
    if (!composer || !normalizedDraft) return null;
    composer.draftsBySession.set(normalizedDraft.sessionId, normalizedDraft);
    return cloneJsonLike(normalizedDraft);
  }

  function getDraftForSession(state, sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) return null;
    const composer = ensureComposerV2State(state);
    const draft = composer?.draftsBySession?.get?.(normalizedSessionId);
    return draft ? cloneJsonLike(draft) : null;
  }

  function clearDraftForSession(state, sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) return false;
    const composer = ensureComposerV2State(state);
    return composer?.draftsBySession?.delete?.(normalizedSessionId) === true;
  }

  // Send-path preference resolution: a queued-send snapshot replays its frozen
  // model/effort, but run mode is session state — spec §4(a): the new mode
  // applies from the next request, so dispatch re-reads it live (from the
  // target session's summary when it exists, else the current preferences).
  function resolveSendRuntimePreferences({ snapshot, session, current, clone }) {
    const frozen = snapshot && typeof snapshot === 'object' ? snapshot : null;
    const copy = clone(frozen || current());
    if (frozen) {
      const live = session && typeof session === 'object'
        ? { runMode: session.run_mode, planMode: session.plan_mode === true, prePlanRunMode: session.pre_plan_run_mode }
        : current();
      copy.runMode = live.runMode;
      copy.planMode = live.planMode === true;
      copy.prePlanRunMode = live.prePlanRunMode;
    }
    return copy;
  }

  return {
    COMPOSER_LIFECYCLE,
    RUN_MODE_ORDER,
    clearDraftForSession,
    clearPendingSkillInvocation,
    cloneJsonLike,
    ensureComposerV2State,
    getDraftForSession,
    getLifecycleForSession,
    getPendingSkillInvocation,
    nextRunMode,
    normalizeDraftEntry,
    normalizeRunMode,
    projectRunMode,
    resolveSendRuntimePreferences,
    setDraftForSession,
    setLifecycleForSession,
    setPendingSkillInvocation,
  };
});
