/* Approved MCP prompts as composer slash commands (UMD). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-composer-v2-state'), require('../inventory/chip'));
    return;
  }
  root.rendererMcpPromptSlashCommands = factory(root.rendererComposerV2State, root.inventoryChip);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (composerState, inventoryChip) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  // index.html loads the composer state script after this one: resolve it at call time.
  function stateUtils() { return composerState || globalThis.rendererComposerV2State || null; }

  function parsePromptArguments(args, prompt) {
    const definitions = Array.isArray(prompt?.arguments) ? prompt.arguments : [];
    const input = String(args || '').trim();
    const values = {};
    const invalid = argument => ({ ok: false, code: 'argument_invalid', ...(argument ? { argument } : {}) });
    // One required argument takes the rest of the line (optional ones stay unset) unless the text is pair-shaped.
    const required = definitions.filter(definition => definition.required === true);
    if (required.length === 1 && !definitions.some(definition => input.startsWith(definition.name + '="'))) {
      const name = required[0].name;
      if (!input) return { ok: false, code: 'argument_missing', argument: name };
      if (input.length > 4096) return invalid(name);
      return { ok: true, values: { [name]: input } };
    }
    let remainder = input;
    while (remainder) {
      const match = remainder.match(/^([^\s="]+)="((?:[^"\\]|\\[\s\S])*)"(?=\s|$)/);
      if (!match) return invalid();
      const name = match[1];
      if (!definitions.some(definition => definition.name === name) || Object.prototype.hasOwnProperty.call(values, name)) return invalid(name);
      const value = match[2].replace(/\\(["\\])/g, '$1');
      if (value.length > 4096) return invalid(name);
      Object.defineProperty(values, name, { value, enumerable: true });
      remainder = remainder.slice(match[0].length).trimStart();
    }
    for (const definition of definitions) {
      if (definition.required === true && !String(values[definition.name] || '').trim()) {
        return { ok: false, code: 'argument_missing', argument: definition.name };
      }
    }
    return { ok: true, values };
  }

  function getPendingPromptBlock(state, sessionContext) {
    return stateUtils()?.getPendingPromptBlock?.(state, sessionContext) || null;
  }

  // The model-facing prompt: the labelled block first, then the user's own text.
  function composePromptBlock(block, text) {
    return '[' + block.server + ' prompt: ' + block.prompt + ']\n' + block.text + (text ? '\n\n' + text : '');
  }

  function createMcpPromptSlashCommands(options = {}) {
    const { registry, state, chatInput, getMcpState, getPrompt, renderComposerState } = options;
    const log = options.log || function noop() {};
    const owned = new Map();
    const warned = new Set();
    let disposed = false, revision = 0, readAt = -Infinity, invokeSeq = 0;

    function paintChip() {
      const doc = chatInput?.ownerDocument;
      const parent = chatInput?.closest?.('.chat-pane')?.querySelector?.('.attachment-tray')
        || doc?.getElementById?.('attachmentTray') || doc?.getElementById?.('composerSkillChip')?.parentElement;
      if (!parent) return;
      // The sidebar can rebuild the tray with the same inventory chip.
      parent.querySelectorAll('[data-inv-chip="prompt_pending"]').forEach(chip => {
        if (!chip.closest('[data-prompt-chip-host]')) chip.remove();
      });
      let host = parent.querySelector('[data-prompt-chip-host]');
      const block = getPendingPromptBlock(state, options.sessionContext);
      if (!block) { host?.remove(); return; }
      if (!host) {
        host = doc.createElement('div'); host.dataset.promptChipHost = 'true'; parent.appendChild(host);
      }
      host.innerHTML = typeof inventoryChip === 'function' ? inventoryChip({ id: 'prompt_pending',
        label: jt('composer.prompts.chipLabel', '{server} · {prompt}', block), count: '×', className: 'composer-skill-chip',
        ariaLabel: jt('composer.prompts.chipRemoveLabel', 'Prompt attached: {prompt}. Remove', block),
        title: jt('composer.prompts.chipRemoveTitle', 'Remove prompt') }) : '';
      parent.classList.remove('hidden');
      host.querySelector('[data-inv-chip="prompt_pending"]')?.addEventListener('click', () => { consume(block); chatInput?.focus?.(); });
    }

    function failure(error, command, server, prompt) {
      const code = String(error?.code || 'prompt_unavailable');
      const params = { command: command.slice(1), server, argument: error?.argument };
      let message;
      if (code === 'argument_missing') {
        message = (prompt.arguments || []).filter(argument => argument.required === true).length === 1
          ? jt('composer.prompts.missingOnlyArgument', '/{command} needs {argument}: write it after the command.', params)
          : jt('composer.prompts.missingArgument', '/{command} needs {argument} too. Write it as {argument}="…".', params);
      } else if (code === 'argument_invalid') {
        message = error.argument
          ? jt('composer.prompts.invalidArgument', '/{command} did not understand {argument}. Use name="value" pairs.', params)
          : jt('composer.prompts.invalidArguments', '/{command} takes name="value" pairs, nothing else.', params);
      } else if (code === 'not_approved') message = jt('composer.prompts.notApproved', 'Approve the {server} connection\'s tools before using its prompts.', params);
      else if (code === 'server_disabled') message = jt('composer.prompts.serverOff', 'Turn the {server} connection on to use its prompts.', params);
      else if (code === 'prompt_unavailable' && error?.reason === 'prompt_content_unsupported') message = jt('composer.prompts.unsupportedContent', 'This prompt contains content Jenny cannot attach (only text is supported).');
      else message = jt('composer.prompts.unavailable', 'The {server} prompt could not be fetched.', params);
      options.showToastMessage?.(message, { tone: 'warning' });
      return { ok: false, handled: true, code };
    }

    async function invoke(command, server, prompt, invocation) {
      const parsed = parsePromptArguments(invocation.args, prompt);
      if (!parsed.ok) return failure(parsed, command, server, prompt);
      const ticket = ++invokeSeq; // a later invocation wins over an earlier fetch that resolves after it
      let result;
      try { result = await getPrompt?.({ name: server, prompt: prompt.name, arguments: parsed.values }); }
      catch (_error) { return failure(null, command, server, prompt); }
      if (result?.ok !== true) return failure(result?.error, command, server, prompt);
      if (disposed || ticket !== invokeSeq) return { ok: false, handled: true, code: disposed ? 'disposed' : 'superseded' };
      // Capture the invoking session, even if focus moved while the bridge was fetching.
      const block = stateUtils().setPendingPromptBlock(state, { server, prompt: prompt.name, text: result.text, chars: result.chars },
        { getSessionId: () => invocation.sessionId });
      paintChip(); renderComposerState?.();
      // The getter drops a block whose session no pane shows any more: no "attached" toast then.
      if (stateUtils().ensureComposerV2State(state)?.pendingPromptBlock !== block) return { ok: false, handled: true, code: 'session_changed' };
      options.showToastMessage?.(jt('composer.prompts.attached', '{server} prompt "{prompt}" attached. It goes first in your next message.', { server, prompt: prompt.name }), { tone: 'success' });
      return { ok: true, code: 'prompt_attached' };
    }

    function warnOnce(command) {
      if (warned.has(command)) return;
      warned.add(command); log('WARN', 'slash.prompt_registration_skipped', { command });
    }

    async function refresh() {
      const ticket = ++revision;
      let snapshot;
      try { snapshot = await getMcpState?.(); }
      catch (_error) { return [...owned.keys()]; }
      if (disposed || ticket !== revision) return [];
      readAt = Date.now();
      const desired = new Map();
      for (const row of Array.isArray(snapshot?.servers) ? snapshot.servers : []) {
        if (row?.enabled !== true || row.trust?.status !== 'approved') continue;
        for (const prompt of Array.isArray(row.prompts) ? row.prompts : []) {
          const command = ('/' + row.name + '-' + prompt.name).toLowerCase();
          if (desired.has(command)) { warnOnce(command); continue; }
          desired.set(command, { server: row.name, prompt });
        }
      }
      for (const [command, previous] of owned) {
        if (JSON.stringify(desired.get(command)) === JSON.stringify(previous)) continue;
        registry?.unregister?.(command); owned.delete(command);
      }
      for (const [command, entry] of desired) {
        if (owned.has(command)) continue;
        const { server, prompt } = entry;
        const definitions = Array.isArray(prompt.arguments) ? prompt.arguments : [];
        const description = String(prompt.description || '') + (definitions.length ? ' · ' + definitions.map(argument => argument.name).join(', ') : '');
        // The palette inserts a command that still needs arguments and runs one that does not.
        const action = definitions.some(argument => argument.required === true) ? 'insert' : 'run';
        if (registry?.register?.(command, description, invocation => invoke(command, server, prompt, invocation),
          { requiresSession: true, action, tag: server, clearPolicy: 'on_success' }) === true) owned.set(command, entry);
        else warnOnce(command);
      }
      for (const command of warned) if (owned.has(command) || !desired.has(command)) warned.delete(command);
      return [...owned.keys()];
    }

    function ensureScope({ maxAgeMs = 1000 } = {}) {
      return !disposed && Date.now() - readAt > maxAgeMs ? refresh() : null;
    }
    const refreshOnFocus = event => {
      if (event?.type === 'input' && !/^\/[a-z0-9_-]*$/i.test(String(chatInput?.value || ''))) return;
      ensureScope({ maxAgeMs: 1000 })?.catch(() => {});
    };
    const refreshOnMenu = event => {
      if (event.target?.closest?.('#composerTerminalShortcut')) refreshOnFocus(event);
    };
    for (const type of ['focus', 'input']) chatInput?.addEventListener?.(type, refreshOnFocus);
    chatInput?.ownerDocument?.addEventListener?.('click', refreshOnMenu, true);
    // A send attempt that captured the block owns its text from then on (a queued entry, a receipt's
    // Retry payload); a replacement block made since is not touched.
    function consume(block) {
      const utils = stateUtils();
      if (!block || utils?.ensureComposerV2State(state)?.pendingPromptBlock !== block) return false;
      utils.clearPendingPromptBlock(state); paintChip(); renderComposerState?.(); return true;
    }
    function dispose() {
      disposed = true; revision += 1;
      for (const type of ['focus', 'input']) chatInput?.removeEventListener?.(type, refreshOnFocus);
      chatInput?.ownerDocument?.removeEventListener?.('click', refreshOnMenu, true);
      for (const command of owned.keys()) registry?.unregister?.(command);
      owned.clear();
    }
    return { refresh, ensureScope, dispose, paintChip, consume };
  }

  return { parsePromptArguments, createMcpPromptSlashCommands, getPendingPromptBlock, composePromptBlock };
});
