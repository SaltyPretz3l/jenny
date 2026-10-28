/* renderer/features/renderer-ide-command-registry.js - Workspace IDE command registry
 * and keymap table (row 82, VS Code parity; plan docs/plans/IDE_VSCODE_PARITY_2026-10-26.md
 * section 5.1).
 *
 * One table of commands: each has an id, a palette label and group, optional chords in
 * VS Code spelling, a `when(ctx)` guard and a `run`. The IDE keydown dispatcher resolves
 * chords through resolveChord(); the command palette lists rows through list(); feature
 * modules register their own commands and never edit the dispatcher. Monaco-side bindings
 * for the same chords are the dispatcher's job (editorHost.addEditorAction), not this
 * module's: it owns no DOM and no editor. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeCommandRegistry = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MODIFIER_ORDER = ['ctrl', 'alt', 'shift'];
  const CHORD_PREFIXES = Object.freeze(['ctrl+k']);
  const KEY_ALIASES = Object.freeze({
    ' ': 'space',
    'arrowup': 'up',
    'arrowdown': 'down',
    'arrowleft': 'left',
    'arrowright': 'right',
    'escape': 'escape',
    'esc': 'escape',
    '`': '`',
    'backquote': '`',
    'backslash': '\\',
    'comma': ',',
    'period': '.',
    'slash': '/',
    'minus': '-',
    'equal': '=',
  });
  const CODE_KEYS = Object.freeze({
    Backquote: '`',
    Backslash: '\\',
    Comma: ',',
    Period: '.',
    Slash: '/',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Quote: "'",
    Semicolon: ';',
  });
  const DISPLAY = Object.freeze({
    ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', escape: 'Esc', space: 'Space',
    up: '↑', down: '↓', left: '←', right: '→',
    pageup: 'PageUp', pagedown: 'PageDown', '`': '`',
  });

  function normalizeKeyName(key) {
    const raw = String(key || '').trim().toLowerCase();
    if (!raw) return '';
    if (Object.prototype.hasOwnProperty.call(KEY_ALIASES, raw)) return KEY_ALIASES[raw];
    return raw;
  }

  /* 'Ctrl+Shift+P' / 'ctrl+k ctrl+w' -> canonical lower-case, modifiers ordered
   * ctrl alt shift, steps space-joined. Returns '' for an empty or malformed chord. */
  function normalizeChord(chord) {
    const steps = String(chord || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!steps.length) return '';
    const out = [];
    for (const step of steps) {
      const plusKey = step.length > 2 && step.endsWith('++');
      const parts = (plusKey ? step.slice(0, -2) : step).split('+');
      const mods = new Set();
      let key = plusKey ? '+' : '';
      for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i];
        if (part === '') { key = ''; break; }
        if (part === 'cmd' || part === 'meta' || part === 'control' || part === 'ctrl') { mods.add('ctrl'); continue; }
        if (part === 'alt' || part === 'option') { mods.add('alt'); continue; }
        if (part === 'shift') { mods.add('shift'); continue; }
        key = normalizeKeyName(part);
      }
      if (!key) return '';
      out.push(MODIFIER_ORDER.filter((m) => mods.has(m)).concat([key]).join('+'));
    }
    return out.join(' ');
  }

  /* A single key step from a DOM KeyboardEvent, in the same canonical spelling. The
   * step ignores a lone modifier press. Letters come from event.key so layouts hold;
   * punctuation falls back to event.code so Shift does not change the key name. */
  function stepFromEvent(event) {
    if (!event) return '';
    const key = String(event.key || '');
    if (!key || key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta') return '';
    const mods = [];
    if (event.ctrlKey || event.metaKey) mods.push('ctrl');
    if (event.altKey) mods.push('alt');
    if (event.shiftKey) mods.push('shift');
    let name = normalizeKeyName(key);
    const code = String(event.code || '');
    if (Object.prototype.hasOwnProperty.call(CODE_KEYS, code)) name = CODE_KEYS[code];
    else if (/^Digit\d$/.test(code) && !/^\d$/.test(name)) name = code.slice(5);
    else if (/^Key[A-Z]$/.test(code) && !/^[a-z]$/.test(name)) name = code.slice(3).toLowerCase();
    if (!name) return '';
    return mods.concat([name]).join('+');
  }

  function displayChord(chord) {
    const canonical = normalizeChord(chord);
    if (!canonical) return '';
    return canonical.split(' ').map((step) => step.split('+').map((part) => {
      if (Object.prototype.hasOwnProperty.call(DISPLAY, part)) return DISPLAY[part];
      if (part.length === 1) return part.toUpperCase();
      if (/^f\d{1,2}$/.test(part)) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    }).join('+')).join(' ');
  }

  function createIdeCommandRegistry() {
    const commands = new Map();
    const chordIndex = new Map();

    function rebuildChords() {
      chordIndex.clear();
      for (const command of commands.values()) {
        for (const chord of command.keys) {
          if (!chordIndex.has(chord)) chordIndex.set(chord, command.id);
        }
      }
    }

    function register(command) {
      if (!command || typeof command !== 'object') throw new TypeError('command required');
      const id = String(command.id || '').trim();
      if (!/^ide:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new TypeError('command id must look like ide:verb-object');
      if (typeof command.run !== 'function') throw new TypeError('command.run must be a function');
      const keys = (Array.isArray(command.keys) ? command.keys : []).map(normalizeChord).filter(Boolean);
      const entry = Object.freeze({
        id,
        label: String(command.label || id),
        group: String(command.group || 'Workspace'),
        description: command.description == null ? '' : String(command.description),
        hint: command.hint != null ? String(command.hint) : (keys.length ? displayChord(keys[0]) : ''),
        keys: Object.freeze(keys),
        when: typeof command.when === 'function' ? command.when : inIde,
        run: command.run,
      });
      commands.set(id, entry);
      rebuildChords();
      return () => unregister(id);
    }

    function unregister(id) {
      const removed = commands.delete(String(id || ''));
      if (removed) rebuildChords();
      return removed;
    }

    function get(id) {
      return commands.get(String(id || '')) || null;
    }

    function allows(entry, ctx) {
      try {
        return Boolean(entry.when(ctx || {}));
      } catch (_err) {
        return false;
      }
    }

    function list(opts) {
      const ctx = (opts && opts.ctx) || {};
      const rows = [];
      for (const entry of commands.values()) {
        if (!allows(entry, ctx)) continue;
        rows.push({
          id: entry.id,
          group: entry.group,
          label: entry.label,
          description: entry.description,
          hint: entry.hint || null,
          run: () => run(entry.id, ctx),
        });
      }
      return rows;
    }

    function run(id, ctx) {
      const entry = commands.get(String(id || ''));
      if (!entry || !allows(entry, ctx)) return false;
      entry.run(ctx || {});
      return true;
    }

    function bindings() {
      const out = [];
      for (const [chord, id] of chordIndex) out.push({ chord, id });
      return out;
    }

    /* Resolve a keydown against the table. `pending` is the first step of a two-step
     * chord the caller is holding (or null). Returns { id } for a bound command whose
     * `when` allows it, { pending } when the step opens a chord, or null. */
    function resolveChord(event, pending, ctx) {
      const step = stepFromEvent(event);
      if (!step) return null;
      if (pending) {
        const id = chordIndex.get(pending + ' ' + step);
        if (id && allows(commands.get(id), ctx)) return { id };
        return null;
      }
      const direct = chordIndex.get(step);
      if (direct && allows(commands.get(direct), ctx)) return { id: direct };
      if (CHORD_PREFIXES.indexOf(step) !== -1) {
        for (const chord of chordIndex.keys()) {
          if (chord.indexOf(step + ' ') === 0) return { pending: step };
        }
      }
      return null;
    }

    return Object.freeze({ register, unregister, get, list, run, bindings, resolveChord });
  }

  // The IDE `when` base: a direct call (no context) or the IDE view active.
  function inIde(ctx) {
    return !ctx || ctx.activeView === 'ide';
  }

  // A command run that never escapes the palette or the keydown dispatcher: a throw or a
  // rejected promise is logged (ide.command_ignored_error), and logging itself never throws.
  function logIgnoredCommandError(appendClientLog, site, error) {
    try { appendClientLog('DEBUG', 'ide.command_ignored_error', { site, error: String(error?.message || error || '') }); } catch (_error) { /* logging must not throw */ }
  }

  function guardCommand(appendClientLog, site, fn) {
    const log = (error) => logIgnoredCommandError(appendClientLog, site, error);
    return (ctx) => {
      try {
        const result = fn(ctx);
        if (result && typeof result.catch === 'function') result.catch(log);
      } catch (error) {
        log(error);
      }
    };
  }

  return Object.freeze({
    createIdeCommandRegistry,
    inIde,
    guardCommand,
    logIgnoredCommandError,
    normalizeChord,
    stepFromEvent,
    displayChord,
    CHORD_PREFIXES,
  });
});
