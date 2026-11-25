'use strict';

/* services/computer-use/parse-input.js: what the model sent to `computer`, checked (row 196).
 * `args.params` is what the helper operation takes beyond the guard and the scale. Split from
 * computer-use-service.js; nothing here talks to the helper. */

const fmt = require('./result-format');

const HELPER_TIMEOUT_MS = 10000;
const POINT_LIMIT = 100000;
const BUTTONS = new Set(['left', 'right', 'middle']);
const MODIFIERS = ['shift', 'ctrl', 'alt'];
const INPUT_OPS = Object.freeze({
  click: 'input.click', drag: 'input.drag', move: 'input.move', scroll: 'input.scroll', type: 'input.type', key: 'input.key',
});
const POINTER_ACTIONS = new Set(['click', 'drag', 'move', 'scroll']);
// The helper's key names (`check::KEYS` in native/jenny-computer), and the common names a model uses for them.
const NAMED_KEYS = new Set(['enter', 'esc', 'tab', 'space', 'backspace', 'delete', 'insert', 'home', 'end', 'pageup', 'pagedown',
  'up', 'down', 'left', 'right', 'minus', 'equals', 'comma', 'period', 'slash', 'semicolon', 'quote', 'backquote',
  'bracketleft', 'bracketright', 'backslash']);
const KEY_ALIASES = Object.freeze({
  return: 'enter', escape: 'esc', del: 'delete', ins: 'insert', pgup: 'pageup', pgdn: 'pagedown', page_up: 'pageup',
  page_down: 'pagedown', arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right', spacebar: 'space',
  control: 'ctrl', ctl: 'ctrl',
});
const KEY_LIST = 'a-z, 0-9, f1-f12, enter, esc, tab, space, backspace, delete, insert, home, end, pageup, pagedown, up, down, left, right';

function whole(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function coordinate(value) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= POINT_LIMIT ? Math.round(value) : null;
}

function boundedText(value, maxChars) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= maxChars ? text : null;
}

/** Validate what the model sent. `args.params` is what the helper operation takes beyond the guard and the scale. */
function parseInput(input) {
  const bad = (message) => ({ ok: false, message });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('The computer tool needs an action.');
  const action = input.action;
  if (!fmt.ACTIONS.includes(action)) return bad(`Unknown action. Use one of: ${fmt.ACTIONS.join(', ')}.`);
  const args = { action };
  if (action === 'open' || action === 'focus') {
    args.name = boundedText(input.name, 120);
    return args.name ? { ok: true, args } : bad(`${action} needs a program name of 1 to 120 characters.`);
  }
  if (action === 'wait') {
    const seconds = input.seconds;
    if (typeof seconds !== 'number' || !(seconds >= 0.5 && seconds <= 10)) return bad('wait needs seconds from 0.5 to 10.');
    return { ok: true, args: { ...args, seconds } };
  }
  if (!INPUT_OPS[action]) return { ok: true, args };
  args.op = INPUT_OPS[action];
  args.pointer = POINTER_ACTIONS.has(action);
  const point = { x: coordinate(input.x), y: coordinate(input.y) };
  if (args.pointer && (point.x === null || point.y === null)) return bad(`${action} needs x and y as numbers in the picture's pixels.`);
  const button = input.button === undefined ? 'left' : input.button;
  const count = input.count === undefined ? 1 : whole(input.count, 1, 3);
  const modifiers = input.modifiers === undefined ? [] : input.modifiers;
  if ((action === 'click' || action === 'drag') && !BUTTONS.has(button)) return bad('button must be left, right or middle.');
  if (action === 'click' && count === null) return bad('count must be 1, 2 or 3.');
  if ((action === 'click' || action === 'drag') && (!Array.isArray(modifiers) || modifiers.length > 6
    || modifiers.some((item) => !MODIFIERS.includes(item)))) return bad('modifiers may hold shift, ctrl and alt.');
  const mods = MODIFIERS.filter((item) => Array.isArray(modifiers) && modifiers.includes(item));
  if (action === 'click') args.params = { point, button, count, modifiers: mods };
  else if (action === 'move') args.params = { point };
  else if (action === 'drag') {
    const to = { x: coordinate(input.to_x), y: coordinate(input.to_y) };
    if (to.x === null || to.y === null) return bad('drag needs to_x and to_y as numbers in the picture\'s pixels.');
    args.params = { from: point, to, button, modifiers: mods };
  } else if (action === 'scroll') {
    const dy = input.dy === undefined ? 0 : whole(input.dy, -20, 20);
    const dx = input.dx === undefined ? 0 : whole(input.dx, -20, 20);
    if (dy === null || dx === null || (dy === 0 && dx === 0)) return bad('scroll needs dy or dx, whole numbers from -20 to 20, not both 0.');
    args.params = { point, dy, dx };
  } else if (action === 'type') {
    if (typeof input.text !== 'string' || input.text.length < 1 || input.text.length > 2000) return bad('type needs text of 1 to 2000 characters.');
    // Saved history drops a computer type's text by its shape (no `ref`): a `ref` here is refused, never typed.
    if (input.ref !== undefined) return bad('type takes text only.');
    args.params = { text: input.text };
  } else {
    const chord = boundedText(input.chord, 40);
    const hold = input.hold_ms === undefined ? 0 : whole(input.hold_ms, 0, 2000);
    if (!chord) return bad('key needs a chord such as ctrl+s.');
    if (hold === null) return bad('hold_ms must be a whole number from 0 to 2000.');
    const named = normaliseChord(chord);
    if (named.error) return bad(named.error);
    args.params = { chord: named.chord, hold_ms: hold };
  }
  return { ok: true, args };
}

function isKey(name) {
  return /^[a-z0-9]$/.test(name) || /^f([1-9]|1[0-2])$/.test(name) || NAMED_KEYS.has(name);
}

/** A chord in the helper's names, or why not. A modifier alone is refused: tapping Alt moves the focus to a menu bar. */
function normaliseChord(text) {
  const parts = text.toLowerCase().split('+').map((part) => part.trim())
    .map((part) => (Object.hasOwn(KEY_ALIASES, part) ? KEY_ALIASES[part] : part));
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (MODIFIERS.includes(key)) return { error: `A modifier cannot be pressed alone; add a key, such as ${key}+f.` };
  if (!isKey(key)) return { error: `Unknown key "${key.slice(0, 20)}". Keys: ${KEY_LIST}.` };
  if (mods.some((mod) => !MODIFIERS.includes(mod)) || new Set(mods).size !== mods.length) {
    return { error: 'Put only ctrl, shift or alt before the key, each once, such as ctrl+shift+s.' };
  }
  return { chord: parts.join('+') };
}

function helperTimeoutMs(args) {
  if (args.op === 'input.type') {
    // The helper's real cost: 6 ms a character, 40 ms after Enter or Tab, and a field check (up to 500 ms) every 32.
    const text = args.params.text;
    const breaks = (text.match(/[\n\t]/g) || []).length;
    return HELPER_TIMEOUT_MS + text.length * 20 + breaks * 60 + Math.ceil(text.length / 32) * 600;
  }
  if (args.op === 'input.key') return HELPER_TIMEOUT_MS + args.params.hold_ms;
  return HELPER_TIMEOUT_MS;
}

module.exports = { HELPER_TIMEOUT_MS, parseInput, helperTimeoutMs };
