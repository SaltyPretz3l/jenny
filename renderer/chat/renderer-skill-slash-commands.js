/* Dynamic skill slash commands plus the send-path slash dispatch seam (UMD). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-composer-v2-state'), require('../inventory/chip'));
    return;
  }
  root.rendererSkillSlashCommands = factory(root.rendererComposerV2State || null, root.inventoryChip || null);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (composerState, inventoryChip) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const BUILT_INS = new Set(['help', 'context', 'compact', 'note']);
  const CHIP_TOKEN = 'skill_pending';
  const SPARKLE_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l1.6 4.2L14 7.5l-4.4 1.8L8 13.5 6.4 9.3 2 7.5l4.4-1.8z"/></svg>';

  function stateUtilsRef() {
    return composerState || globalThis.rendererComposerV2State || null;
  }

  function chipMarkup(skill) {
    const name = String(skill?.name || skill?.command || 'Skill');
    const ariaLabel = jt('composer.skills.attachedRemoveLabel', 'Skill attached: {name}. Remove', { name });
    // The inventory chip primitive owns the markup; without it nothing renders.
    const chip = typeof inventoryChip === 'function' ? inventoryChip : globalThis.inventoryChip;
    if (typeof chip !== 'function') return '';
    return chip({ id: CHIP_TOKEN, label: name, count: '\u00d7', iconHtml: SPARKLE_SVG,
      className: 'composer-skill-chip', ariaLabel, title: jt('composer.skills.removeTitle', 'Remove skill') });
  }

  // Renders the composer chip for the pending skill (host #composerSkillChip).
  // Called from the send-path dispatch and from renderComposerState so a
  // session switch (which drops the pending skill) also drops the chip.
  function renderSkillChip(deps) {
    const state = deps?.state;
    const doc = deps?.document || (typeof document !== 'undefined' ? document : null);
    const host = doc?.getElementById?.('composerSkillChip');
    if (!host) return null;
    const pending = stateUtilsRef()?.getPendingSkillInvocation?.(state) || null;
    if (!pending) {
      if (host.dataset.skillId) host.innerHTML = '';
      host.dataset.skillId = '';
      host.classList.add('hidden');
      return null;
    }
    if (host.dataset.skillId !== pending.id) host.innerHTML = chipMarkup(pending);
    host.dataset.skillId = pending.id;
    host.classList.remove('hidden');
    if (host.dataset.skillChipBound !== 'true') {
      host.dataset.skillChipBound = 'true';
      host.addEventListener('click', (event) => {
        if (!event.target?.closest?.('[data-inv-chip="' + CHIP_TOKEN + '"]')) return;
        stateUtilsRef()?.clearPendingSkillInvocation?.(state);
        renderSkillChip({ state, document: doc });
        doc.getElementById?.('chatInput')?.focus?.();
      });
    }
    return pending;
  }

  // Attach without touching the composer draft (palette rows, keyboard).
  function attachSkillInvocation(deps) {
    const skill = stateUtilsRef()?.setPendingSkillInvocation?.(deps?.state, deps?.skill) || null;
    if (skill) renderSkillChip(deps);
    return skill;
  }

  function cleanSkill(entry, scope) {
    const command = String(entry?.command || '').trim().toLowerCase().replace(/^\//, '');
    if (!/^[a-z][a-z0-9_-]*$/.test(command)) return null;
    const id = String(entry?.id || '').trim();
    if (!id) return null;
    return Object.freeze({
      id,
      name: String(entry?.name || command).trim() || command,
      scope: String(scope || '').trim(),
      command,
      description: String(entry?.description || '').trim(),
    });
  }

  function createSkillSlashCommands(deps) {
    const options = deps || {};
    const registry = options.registry;
    const getSkillsState = options.getSkillsState;
    const onChanged = options.onChanged;
    // Chat-scoped catalogs: the key names the chat the registry was last asked
    // for; a pushed snapshot is the open Workspace's view, so it only triggers
    // a refetch of the chat's own scope.
    const getScopeKey = typeof options.getScopeKey === 'function' ? options.getScopeKey : null;
    const log = typeof options.log === 'function' ? options.log : function noop() {};
    const owned = new Map();
    let disposed = false;
    let revision = 0;
    let unsubscribe = null;
    let requestedScope = null;
    let requestedAt = -Infinity;
    const now = typeof options.now === 'function' ? options.now : () => Date.now();

    function warnCollision(command, firstId, secondId) {
      log('WARN', 'slash.skill_command_collision', { command, firstId, secondId });
    }

    function collect(snapshot) {
      const desired = new Map();
      const scopes = Array.isArray(snapshot?.scopes) ? snapshot.scopes : [];
      for (const scope of scopes) {
        if (scope?.enabled !== true) continue;
        const entries = Array.isArray(scope.entries) ? scope.entries : [];
        for (const entry of entries) {
          if (entry?.enabled !== true) continue;
          const skill = cleanSkill(entry, scope.scope);
          if (!skill) continue;
          if (BUILT_INS.has(skill.command)) {
            warnCollision(skill.command, `builtin/${skill.command}`, skill.id);
            continue;
          }
          const prior = desired.get(skill.command);
          if (prior) {
            warnCollision(skill.command, prior.id, skill.id);
            continue;
          }
          desired.set(skill.command, skill);
        }
      }
      return desired;
    }

    function apply(snapshot) {
      if (disposed || !registry) return [];
      const desired = collect(snapshot);
      for (const [command] of owned) {
        if (!desired.has(command)) {
          registry.unregister?.('/' + command);
          owned.delete(command);
        }
      }
      for (const [command, skill] of desired) {
        const current = owned.get(command);
        if (current && JSON.stringify(current) === JSON.stringify(skill)) continue;
        if (current) registry.unregister?.('/' + command);
        const registered = registry.register?.('/' + command, skill.description, null, {
          action: 'attach',
          skill,
        }) === true;
        if (registered) owned.set(command, skill);
        else owned.delete(command);
      }
      return [...owned.values()];
    }

    async function refresh(snapshot) {
      const refreshRevision = ++revision;
      try {
        const pushed = snapshot && typeof snapshot === 'object';
        if (!pushed && getScopeKey) { requestedScope = getScopeKey(); requestedAt = now(); }
        const next = pushed
          ? snapshot
          : await Promise.resolve(typeof getSkillsState === 'function' ? getSkillsState() : null);
        if (disposed || refreshRevision !== revision) return [];
        return apply(next);
      } catch (_error) {
        if (!disposed) log('WARN', 'slash.skill_command_refresh_failed', {});
        return [];
      }
    }

    // Refetch when the focused chat changed, or when the last read is older
    // than maxAgeMs: the chat's project can be re-bound under the same session
    // id (projects.assignSession), which no renderer key observes reliably.
    // Null when the registry already reflects a fresh read.
    function ensureScope({ maxAgeMs = Infinity } = {}) {
      if (disposed || !getScopeKey) return null;
      if (getScopeKey() === requestedScope && now() - requestedAt <= maxAgeMs) return null;
      return refresh();
    }

    if (typeof onChanged === 'function') {
      unsubscribe = onChanged((snapshot) => {
        refresh(getScopeKey ? undefined : snapshot).catch(function noop() {});
      });
    }
    refresh().catch(function noop() {});

    function dispose() {
      if (disposed) return;
      disposed = true;
      revision += 1;
      if (typeof unsubscribe === 'function') unsubscribe();
      for (const command of owned.keys()) registry.unregister?.('/' + command);
      owned.clear();
    }

    return { refresh, ensureScope, dispose };
  }

  function createSendSlashDispatch(deps) {
    const options = deps || {};
    const state = options.state;
    const registry = options.registry;
    const chatInput = options.chatInput;
    const syncComposerInputHeight = options.syncComposerInputHeight || function noop() {};
    const syncComposerVisualState = options.syncComposerVisualState || function noop() {};
    const renderComposerState = options.renderComposerState || function noop() {};
    const sessionContext = options.sessionContext || null;
    // The chat this composer sends to and the project its summary names; main
    // resolves the canonical binding (project_id only counts for a draft).
    function skillsScope() {
      const sessionId = String(sessionContext?.getSessionId?.() ?? state?.currentSessionId ?? '').trim();
      const summary = sessionId && Array.isArray(state?.sessions)
        ? state.sessions.find((session) => String(session?.id || '').trim() === sessionId) : null;
      const projectId = String(summary?.project_id || '').trim();
      return { ...(sessionId ? { session_id: sessionId } : {}), ...(projectId ? { project_id: projectId } : {}) };
    }
    const scoped = typeof options.getSkillsState === 'function';
    const skillCommands = createSkillSlashCommands({
      registry,
      getSkillsState: scoped ? () => options.getSkillsState(skillsScope()) : undefined,
      getScopeKey: scoped ? () => JSON.stringify(skillsScope()) : undefined,
      onChanged: options.onSkillsChanged,
      log: options.log,
      now: options.now,
    });
    // Composer focus and opening the "/" menu re-read this chat's skills (at
    // most once per freshness window), so a chat switch or a project re-bind
    // of the same chat reaches the picker before it is read.
    const SKILLS_FRESH_MS = 1000;
    const syncSkillsScope = (event) => {
      if (event?.type === 'input' && !/^\/[a-z0-9_-]*$/i.test(String(chatInput?.value || ''))) {
        skillCommands.ensureScope()?.catch(function noop() {});
        return;
      }
      skillCommands.ensureScope({ maxAgeMs: SKILLS_FRESH_MS })?.catch(function noop() {});
    };
    if (scoped && typeof chatInput?.addEventListener === 'function') {
      chatInput.addEventListener('focus', syncSkillsScope);
      chatInput.addEventListener('input', syncSkillsScope);
    }

    function getPending() {
      return stateUtilsRef()?.getPendingSkillInvocation?.(state) || null;
    }

    function paintChip() {
      renderSkillChip({ state, document: chatInput?.ownerDocument });
    }

    function repaintInput(value, focus) {
      if (chatInput) chatInput.value = String(value || '');
      syncComposerInputHeight();
      syncComposerVisualState();
      paintChip();
      renderComposerState();
      if (focus) chatInput?.focus?.();
    }

    function dispatch(prompt, rawSettings) {
      const settings = rawSettings || {};
      if (settings.editedMessageId) return { handled: false, prompt, settings };
      const pending = getPending();
      // A queued (outbox) replay already carries the skill captured at queue
      // time in its meta; the skill pending *now* must not override it.
      let nextSettings = pending && !settings.skillInvocation && !settings.outboxDispatch
        ? { ...settings, skillInvocation: pending }
        : settings;
      const trimmed = String(prompt || '').trim();
      if (!trimmed.startsWith('/') || !registry) {
        return { handled: false, prompt, settings: nextSettings };
      }
      // A command typed right after a chat switch matches THAT chat's skills.
      const scopeSync = skillCommands.ensureScope({ maxAgeMs: SKILLS_FRESH_MS });
      if (scopeSync) return scopeSync.then(() => dispatch(prompt, rawSettings));
      const originDraft = String(chatInput?.value || '');
      const receipt = typeof registry.execute === 'function'
        ? registry.execute(trimmed)
        : { matched: registry.tryExecute?.(trimmed) === true, accepted: true, clearPolicy: 'on_success', completion: Promise.resolve({ ok: true }) };
      if (!receipt?.matched) return { handled: false, prompt, settings: nextSettings };
      if (receipt.status === 'attached' && receipt.skill) {
        const skill = attachSkillInvocation({ state, skill: receipt.skill, document: chatInput?.ownerDocument })
          || receipt.skill;
        const remainder = String(receipt.prompt || '');
        repaintInput(remainder, !remainder.trim());
        nextSettings = { ...settings, skillInvocation: skill };
        return remainder.trim()
          ? { handled: false, prompt: remainder, settings: nextSettings }
          : { handled: true, prompt: remainder, settings: nextSettings };
      }
      const completion = receipt.accepted === true
        ? Promise.resolve(receipt.completion).catch(() => ({ ok: false }))
        : Promise.resolve({ ok: false });
      return completion.then((result) => {
        const originSessionId = String(receipt.invocation?.sessionId ?? state?.currentSessionId ?? '').trim();
        const originGeneration = Number(receipt.invocation?.generation) || 0;
        const currentGeneration = Number(state?.composerSessionState?.get?.(originSessionId)?.generation) || 0;
        if (result?.ok === true && receipt.clearPolicy === 'on_success'
          && String(state?.currentSessionId || '').trim() === originSessionId
          && currentGeneration === originGeneration && String(chatInput?.value || '') === originDraft) {
          repaintInput('', false);
        }
        return { handled: true, prompt, settings: nextSettings };
      });
    }

    function clearAccepted(result, invocation, settings) {
      // A durable submission carries the skill in its captured payload, so its
      // accepted receipt (work_id, snake_case) consumes the chip too, admitted or not.
      const accepted = Boolean(result?.streamId)
        || (result?.durable === true && result?.ok === true && Boolean(result?.work_id));
      if (!accepted || settings?.editedMessageId || !invocation?.id) return false;
      // By id, not focus (split view W3-1): the send may settle after focus moved to the other pane.
      const pending = stateUtilsRef()?.ensureComposerV2State?.(state)?.pendingSkillInvocation || null;
      if (!pending || pending.id !== invocation.id) return false;
      const cleared = stateUtilsRef()?.clearPendingSkillInvocation?.(state) === true;
      if (cleared) {
        paintChip();
        renderComposerState();
      }
      return cleared;
    }

    const autocompleteUtils = options.autocompleteUtils
      || (typeof globalThis !== 'undefined' ? globalThis.rendererSlashAutocomplete : null);
    // Split view: each pane's send path owns the menu on ITS composer. A
    // second pane's textarea is not #chatInput: its menu binds that textarea,
    // keys on its session and leaves pane 0's Commands button alone.
    const ownsDocumentComposer = !chatInput || chatInput === chatInput.ownerDocument?.getElementById?.('chatInput');
    const autocomplete = autocompleteUtils?.createSlashAutocomplete?.({
      document: chatInput?.ownerDocument,
      getInput: chatInput ? () => chatInput : undefined,
      getButton: ownsDocumentComposer ? undefined : () => null,
      getSessionId: !ownsDocumentComposer && typeof sessionContext?.getSessionId === 'function'
        ? () => sessionContext.getSessionId()
        : undefined,
      registry,
      state,
      onAccept() {
        syncComposerInputHeight();
        syncComposerVisualState();
        renderComposerState();
      },
    }) || null;
    autocomplete?.attach?.();

    function dispose() {
      autocomplete?.dispose?.();
      chatInput?.removeEventListener?.('focus', syncSkillsScope);
      chatInput?.removeEventListener?.('input', syncSkillsScope);
      skillCommands.dispose();
    }

    return { dispatch, clearAccepted, dispose, refreshSkills: skillCommands.refresh };
  }

  return { attachSkillInvocation, createSendSlashDispatch, createSkillSlashCommands, renderSkillChip };
});
