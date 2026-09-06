/* renderer/shell/renderer-slash-command-registry.js — UMD
 * Client-side slash command registry and built-in command catalog. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSlashCommandRegistryUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const COMMAND_NAME_PATTERN = /^\/[a-z][a-z0-9_-]*$/;

  function noop() {}

  function parseCommandPrompt(prompt) {
    const trimmed = String(prompt || '').trim();
    if (!trimmed.startsWith('/')) return null;
    const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    if (!match) return null;
    const name = String(match[1] || '').toLowerCase();
    if (!COMMAND_NAME_PATTERN.test(name)) return null;
    return {
      name,
      args: String(match[2] || '').trim(),
    };
  }

  function normalizeCommandResult(value) {
    if (value == null || value === true) return { ok: true, code: 'completed' };
    if (value === false) return { ok: false, code: 'rejected' };
    if (typeof value !== 'object' || Array.isArray(value)) return { ok: true, code: 'completed' };
    if (value.ok === true) return { ...value, ok: true, code: String(value.code || 'completed') };
    if (value.ok === false) return { ...value, ok: false, code: String(value.code || 'failed') };
    if (value.accepted === false) {
      return { ok: false, handled: value.handled === true, code: String(value.reason || 'rejected') };
    }
    if (value.error) return { ok: false, handled: value.handled === true, code: 'failed' };
    if (value.ignored === true) return { ok: false, handled: true, code: String(value.reason || 'superseded') };
    if (value.activity?.state === 'error') {
      return { ok: false, handled: true, code: String(value.activity.reason || 'failed') };
    }
    return { ...value, ok: true, code: String(value.code || 'completed') };
  }

  function buildCommandInsertion(currentValue, commandName, selectionStart, selectionEnd) {
    const command = String(commandName || '').trim().toLowerCase();
    const value = String(currentValue || '');
    if (!COMMAND_NAME_PATTERN.test(command)) {
      return { ok: false, code: 'invalid_command', value, selectionStart, selectionEnd };
    }
    const firstToken = String(value.trimStart().match(/^\S+/)?.[0] || '').toLowerCase();
    if (firstToken === command) {
      return { ok: true, code: 'already_present', value, selectionStart, selectionEnd };
    }
    if (firstToken.startsWith('/')) {
      return { ok: false, code: 'command_conflict', value, selectionStart, selectionEnd };
    }
    const prefix = command + ' ';
    const start = Number.isInteger(selectionStart) ? selectionStart : value.length;
    const end = Number.isInteger(selectionEnd) ? selectionEnd : start;
    return {
      ok: true,
      code: 'inserted',
      value: prefix + value,
      selectionStart: Math.max(start, 0) + prefix.length,
      selectionEnd: Math.max(end, 0) + prefix.length,
    };
  }

  function createSlashCommandRegistry(deps) {
    const options = deps || {};
    const state = options.state || {};
    const optimisticAppend = options.optimisticAppend || noop;
    const renderAll = options.renderAll || noop;
    const appendClientLog = options.appendClientLog || noop;
    const showToastMessage = options.showToastMessage || noop;
    const commands = new Map();
    const pending = new Map();

    function register(name, description, handler, registrationOptions) {
      const normalizedName = String(name || '').trim().toLowerCase();
      const config = registrationOptions || {};
      const action = config.action === 'insert' ? 'insert' : config.action === 'attach' ? 'attach' : 'run';
      if (!COMMAND_NAME_PATTERN.test(normalizedName) || (action !== 'attach' && typeof handler !== 'function')) {
        appendClientLog('WARN', 'slash.registration_rejected', {
          command: COMMAND_NAME_PATTERN.test(normalizedName) ? normalizedName : '',
          reason: COMMAND_NAME_PATTERN.test(normalizedName) ? 'invalid_handler' : 'invalid_name',
        });
        return false;
      }
      if (commands.has(normalizedName)) {
        appendClientLog('WARN', 'slash.registration_rejected', {
          command: normalizedName,
          reason: 'duplicate',
        });
        return false;
      }
      const skill = action === 'attach' && config.skill && typeof config.skill === 'object'
        ? Object.freeze(Object.fromEntries(
            ['id', 'name', 'scope', 'command']
              .filter((key) => typeof config.skill[key] === 'string')
              .map((key) => [key, config.skill[key]])
          ))
        : null;
      commands.set(normalizedName, Object.freeze({
        description: String(description || '').trim(),
        handler,
        requiresSession: config.requiresSession === undefined ? action !== 'attach' : config.requiresSession !== false,
        action,
        skill,
        clearPolicy: action === 'attach' || config.clearPolicy === 'never' ? 'never' : 'on_success',
        concurrency: 'drop_while_running',
      }));
      return true;
    }

    function unregister(name) {
      return commands.delete(String(name || '').trim().toLowerCase());
    }

    function listCommands() {
      const hasSession = Boolean(String(state.currentSessionId || '').trim());
      return [...commands.entries()].map(([name, entry]) => {
        const available = !entry.requiresSession || hasSession;
        return {
          name,
          description: entry.description,
          action: entry.action,
          actionLabel: entry.action === 'insert' ? 'Insert' : entry.action === 'attach' ? 'Attach' : 'Run',
          ...(entry.skill ? { skill: entry.skill } : {}),
          requiresSession: entry.requiresSession,
          clearPolicy: entry.clearPolicy,
          concurrency: entry.concurrency,
          available,
          unavailableReason: available ? '' : 'Start a conversation first.',
        };
      });
    }

    function getSessionGeneration(sessionId) {
      return Number(state.composerSessionState?.get?.(String(sessionId || '').trim())?.generation) || 0;
    }

    function isKnownSession(sessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      return normalizedSessionId === String(state.currentSessionId || '').trim()
        || state.composerSessionState?.has?.(normalizedSessionId)
        || (Array.isArray(state.sessions) && state.sessions.some((session) => String(session?.id || '').trim() === normalizedSessionId));
    }

    function injectOutput(content, commandName, invocation) {
      const sessionId = String(invocation?.sessionId || state.currentSessionId || '').trim();
      if (!sessionId) return false;
      if (invocation && (!isKnownSession(sessionId) || getSessionGeneration(sessionId) !== Number(invocation.generation))) {
        showToastMessage('That command finished after its conversation changed, so its result was not added.', {
          title: 'Command Result Not Added',
          tone: 'warning',
        });
        appendClientLog('INFO', 'slash.output_dropped', { command: commandName, reason: 'stale_invocation' });
        return false;
      }
      optimisticAppend(sessionId, 'assistant', content, {
        kind: 'slash_command_output',
        slash_command: commandName,
        finalizedAt: new Date().toISOString(),
      });
      renderAll();
      return true;
    }

    function settledReceipt(commandName, status, result, entry, invocation) {
      return Object.freeze({
        matched: true,
        accepted: false,
        status,
        command: commandName,
        clearPolicy: entry?.clearPolicy || 'never',
        invocation: invocation || null,
        completion: Promise.resolve(Object.freeze(result)),
      });
    }

    function execute(prompt) {
      const parsed = parseCommandPrompt(prompt);
      const entry = parsed ? commands.get(parsed.name) : null;
      if (!parsed || !entry) {
        return Object.freeze({
          matched: false,
          accepted: false,
          status: 'passthrough',
          command: parsed?.name || '',
          clearPolicy: 'never',
          invocation: null,
          completion: Promise.resolve(Object.freeze({ ok: false, code: 'passthrough' })),
        });
      }

      const sessionId = String(state.currentSessionId || '').trim();
      const invocation = Object.freeze({
        sessionId,
        generation: getSessionGeneration(sessionId),
        args: parsed.args,
      });
      if (entry.action === 'attach') {
        return Object.freeze({
          matched: true,
          accepted: true,
          status: 'attached',
          command: parsed.name,
          skill: entry.skill,
          prompt: parsed.args,
          clearPolicy: 'never',
          invocation,
          completion: Promise.resolve(Object.freeze({ ok: true, code: 'attached' })),
        });
      }
      if (entry.requiresSession && !sessionId) {
        showToastMessage('Start a conversation first.', { title: 'No Active Session', tone: 'warning' });
        appendClientLog('WARN', 'slash.command_blocked', { command: parsed.name, reason: 'no_session' });
        return settledReceipt(parsed.name, 'blocked', { ok: false, handled: true, code: 'no_session' }, entry, invocation);
      }

      const pendingKey = (entry.requiresSession ? sessionId : 'global') + ':' + parsed.name;
      if (pending.has(pendingKey)) {
        showToastMessage('That command is already running.', { title: 'Command in progress', tone: 'warning' });
        appendClientLog('INFO', 'slash.command_busy', { command: parsed.name, sessionId });
        return settledReceipt(parsed.name, 'busy', { ok: false, handled: true, code: 'busy' }, entry, invocation);
      }

      const startedAt = Date.now();
      appendClientLog('INFO', 'slash.command_started', { command: parsed.name, sessionId });
      const completion = Promise.resolve()
        .then(() => entry.handler(invocation))
        .then(normalizeCommandResult)
        .catch(() => ({ ok: false, code: 'exception' }))
        .then((result) => {
          const durationMs = Math.max(Date.now() - startedAt, 0);
          if (result.ok) {
            appendClientLog('INFO', 'slash.command_completed', {
              command: parsed.name,
              sessionId,
              durationMs,
              code: result.code,
            });
          } else {
            if (result.handled !== true) {
              showToastMessage('The command could not be completed.', { title: 'Command Failed', tone: 'warning' });
            }
            appendClientLog('WARN', 'slash.command_failed', {
              command: parsed.name,
              sessionId,
              durationMs,
              code: String(result.code || 'failed'),
            });
          }
          return Object.freeze(result);
        })
        .finally(() => pending.delete(pendingKey));
      pending.set(pendingKey, completion);
      return Object.freeze({
        matched: true,
        accepted: true,
        status: 'started',
        command: parsed.name,
        clearPolicy: entry.clearPolicy,
        invocation,
        completion,
      });
    }

    function tryExecute(prompt) {
      return execute(prompt).matched;
    }

    return { register, unregister, execute, tryExecute, listCommands, injectOutput, isPending: (key) => pending.has(key) };
  }

  function registerBuiltInSlashCommands(options) {
    const config = options || {};
    const registry = config.registry;
    if (!registry || typeof registry.register !== 'function') return false;
    const showToastMessage = config.showToastMessage || noop;
    const contextHandler = config.contextHandler || (() => ({ ok: false, code: 'unavailable' }));
    const noteHandler = config.noteHandler || (() => ({ ok: false, code: 'unavailable' }));

    registry.register('/help', 'List available slash commands', (invocation) => {
      const entries = registry.listCommands();
      const skillEntries = entries.filter((entry) => entry.action === 'attach');
      const commandEntries = entries.filter((entry) => entry.action !== 'attach');
      const lines = [];
      if (skillEntries.length) {
        lines.push('Skills', '');
        const maxSkillLen = Math.max(0, ...skillEntries.map((entry) => entry.name.length));
        for (const entry of skillEntries) {
          lines.push(`  ${entry.name.padEnd(maxSkillLen + 2)}${entry.skill?.name || 'Skill'} \u2014 ${entry.description} [Attach]`);
        }
        lines.push('');
      }
      lines.push('Commands', '');
      const maxLen = Math.max(0, ...commandEntries.map((entry) => entry.name.length));
      for (const entry of commandEntries) {
        const availability = entry.available ? '' : ' — ' + entry.unavailableReason;
        lines.push(`  ${entry.name.padEnd(maxLen + 2)}${entry.description} [${entry.actionLabel}]${availability}`);
      }
      if (invocation.sessionId) registry.injectOutput(lines.join('\n'), '/help', invocation);
      else {
        const available = entries.filter((entry) => entry.available).map((entry) => entry.name);
        const unavailable = entries.filter((entry) => !entry.available).map((entry) => entry.name);
        const summary = ['Available now: ' + available.join(', ')];
        if (unavailable.length) summary.push('Start a conversation for: ' + unavailable.join(', '));
        showToastMessage(summary.join('. ') + '.', { title: 'Commands', tone: 'info' });
      }
      return { ok: true, code: 'help_shown' };
    }, { requiresSession: false });

    registry.register('/context', 'Show context window usage', contextHandler);
    registry.register('/compact', 'Compact this session context now', async (invocation) => {
      const result = await config.compact?.(invocation.sessionId);
      if (!result || result.accepted !== true) {
        return { ok: false, handled: true, code: String(result?.reason || 'compaction_unavailable') };
      }
      if (!result.activity || result.activity.pending === true || result.activity.state !== 'success') {
        return {
          ok: false,
          handled: true,
          code: String(result.reason || result.activity?.reason || 'compaction_failed'),
        };
      }
      return { ok: true, code: String(result.activity?.reason || 'compaction_completed') };
    });
    registry.register('/note', 'Save text to your Home scratchpad', noteHandler, {
      requiresSession: false,
      action: 'insert',
    });
    return true;
  }

  return {
    COMMAND_NAME_PATTERN,
    buildCommandInsertion,
    createSlashCommandRegistry,
    normalizeCommandResult,
    parseCommandPrompt,
    registerBuiltInSlashCommands,
  };
});
