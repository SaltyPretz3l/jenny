/* Dynamic skill slash commands plus the send-path slash dispatch seam (UMD). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-composer-v2-state'), require('../inventory/chip'));
    return;
  }
  root.rendererSkillSlashCommands = factory(root.rendererComposerV2State || null, root.inventoryChip || null);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (composerState, inventoryChip) {
  'use strict';

  const BUILT_INS = new Set(['help', 'context', 'compact', 'note']);
  const CHIP_TOKEN = 'skill_pending';
  const SPARKLE_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l1.6 4.2L14 7.5l-4.4 1.8L8 13.5 6.4 9.3 2 7.5l4.4-1.8z"/></svg>';

  function stateUtilsRef() {
    return composerState || globalThis.rendererComposerV2State || null;
  }

  function chipMarkup(skill) {
    const name = String(skill?.name || skill?.command || 'Skill');
    const ariaLabel = 'Skill attached: ' + name + '. Remove';
    // The inventory chip primitive owns the markup; without it nothing renders.
    const chip = typeof inventoryChip === 'function' ? inventoryChip : globalThis.inventoryChip;
    if (typeof chip !== 'function') return '';
    return chip({ id: CHIP_TOKEN, label: name, count: '\u00d7', iconHtml: SPARKLE_SVG,
      className: 'composer-skill-chip', ariaLabel, title: 'Remove skill' });
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
    const log = typeof options.log === 'function' ? options.log : function noop() {};
    const owned = new Map();
    let disposed = false;
    let revision = 0;
    let unsubscribe = null;

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
        const next = snapshot && typeof snapshot === 'object'
          ? snapshot
          : await Promise.resolve(typeof getSkillsState === 'function' ? getSkillsState() : null);
        if (disposed || refreshRevision !== revision) return [];
        return apply(next);
      } catch (_error) {
        if (!disposed) log('WARN', 'slash.skill_command_refresh_failed', {});
        return [];
      }
    }

    if (typeof onChanged === 'function') {
      unsubscribe = onChanged((snapshot) => { refresh(snapshot).catch(function noop() {}); });
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

    return { refresh, dispose };
  }

  function createSendSlashDispatch(deps) {
    const options = deps || {};
    const state = options.state;
    const registry = options.registry;
    const chatInput = options.chatInput;
    const syncComposerInputHeight = options.syncComposerInputHeight || function noop() {};
    const syncComposerVisualState = options.syncComposerVisualState || function noop() {};
    const renderComposerState = options.renderComposerState || function noop() {};
    const selectSlashCommand = options.selectSlashCommand || function noop() {};
    const submitPrompt = options.submitPrompt || function noop() {};
    const skillCommands = createSkillSlashCommands({
      registry,
      getSkillsState: options.getSkillsState,
      onChanged: options.onSkillsChanged,
      log: options.log,
    });

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
      if (!result?.streamId || settings?.editedMessageId || !invocation?.id) return false;
      const pending = getPending();
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
    const autocomplete = autocompleteUtils?.createSlashAutocomplete?.({
      document: chatInput?.ownerDocument,
      registry,
      onAccept(entry, commandPrompt) {
        return entry.action === 'insert'
          ? selectSlashCommand(entry.name, entry.action)
          : submitPrompt(commandPrompt);
      },
    }) || null;
    autocomplete?.attach?.();

    function dispose() {
      autocomplete?.dispose?.();
      skillCommands.dispose();
    }

    return { dispatch, clearAccepted, dispose, refreshSkills: skillCommands.refresh };
  }

  return { attachSkillInvocation, createSendSlashDispatch, createSkillSlashCommands, renderSkillChip };
});
