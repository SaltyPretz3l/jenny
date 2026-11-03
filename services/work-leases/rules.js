'use strict';

// Pure command classifier for work leases: turns a shell command line into the work resources it
// would take (see docs/architecture/WORK_LEASES_PROTOCOL.md). No git calls, no realpath, no fs access
// except the injectable package.json reader. The rule table lives in work-lease-rules.json.

const fs = require('node:fs');
const path = require('node:path');

const MAX_COMMAND_CHARS = 65_536;
const MAX_SHELL_DEPTH = 4;
const MAX_SCRIPT_DEPTH = 3;
const MAX_SEGMENTS = 2_000;
const MAX_PACKAGE_WALK = 32;
const KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SAFE_WORD = /^[A-Za-z0-9._:+ -]{1,40}$/;
const LEX_WIN = Object.freeze({ single: false, escape: false });
const LEX_POSIX = Object.freeze({ single: true, escape: true, subshell: true });
// Segment markers: a POSIX `( ... )` runs in a subshell, so a `cd` inside it does not leak out.
const SUBSHELL_OPEN = Symbol('subshell-open');
const SUBSHELL_CLOSE = Symbol('subshell-close');
const LEX_POWERSHELL = Object.freeze({ single: true, escape: false });

// ---------------------------------------------------------------- rule table

function fail(message) {
  throw new TypeError(`Invalid work lease rule table: ${message}`);
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isWord = (value) => typeof value === 'string' && value !== '';
const isCount = (value) => Number.isSafeInteger(value) && value >= 1;
const TYPES = {
  words: (v) => Array.isArray(v) && v.length > 0 && v.every(isWord),
  list: (v) => Array.isArray(v) && v.every(isWord),
  string: isWord,
  bool: (v) => typeof v === 'boolean',
  one: (v) => v === 1,
  units: (v) => v === 'all' || isCount(v),
  capacity: (v) => v === null || isCount(v),
  nullableWord: (v) => v === null || isWord(v),
  scope: (v) => ['tree', 'repo'].includes(v),
  match: (v) => ['first', 'any'].includes(v),
  empty: (v) => ['read', 'write'].includes(v),
};

// Rule table schema. A string is a leaf type, [spec] a list, { '*': spec } a map of any keys, any other
// object a record whose keys must all be declared (a trailing ? marks a key optional).
const TABLE = {
  version: 'one',
  resources: { '*': { scope: 'scope', capacity: 'capacity' } },
  take_sets: { '*': [{ kind: 'string', units: 'units' }] },
  npm_script_name_globs: 'list',
  script_take_set: 'string',
  directory_commands: 'words',
  directory_push_commands: 'words',
  directory_pop_commands: 'words',
  shells: { cmd: 'words', powershell: 'words', posix: 'words' },
  wrappers: [{ exe: 'words', 'subcommand?': 'words', 'flags_with_value?': 'list', 'stop_flags?': 'list' }],
  dir_flags: [{ exe: 'words', flags: 'words', stop: 'list' }],
  interpreters: { '*': { module_flag: 'nullableWord', code_flags: 'list', flags_with_value: 'list' } },
  git: {
    exe: 'words',
    take_set: 'string',
    global_flags_with_value: 'list',
    write_subcommands: 'words',
    conditional: {
      '*': {
        'write_flags?': 'words', 'read_flags?': 'words', 'write_args?': 'words', 'read_args?': 'words',
        'positional_writes?': 'bool', 'empty?': 'empty',
      },
    },
  },
  rules: [{
    id: 'string', exe: 'words', 'subcommand?': 'words', 'subcommand_glob?': 'words', 'module?': 'words',
    'script?': 'words', 'flag?': 'words', 'match?': 'match', 'takes?': 'string', 'runs_script?': 'string',
  }],
};

// Validates `value` against `spec` and returns a deep-frozen copy holding only declared keys. Maps are
// prototype-less so a command named "constructor" can never hit an inherited property.
function check(value, spec, where) {
  if (typeof spec === 'string') {
    if (!TYPES[spec](value)) fail(`${where} must be a valid ${spec}`);
    return Array.isArray(value) ? Object.freeze([...value]) : value;
  }
  if (Array.isArray(spec)) {
    if (!Array.isArray(value)) fail(`${where} must be a list`);
    return Object.freeze(value.map((item, i) => check(item, spec[0], `${where}[${i}]`)));
  }
  if (!isRecord(value)) fail(`${where} must be an object`);
  const wild = spec['*'];
  const out = wild ? Object.create(null) : {};
  if (wild) {
    for (const [key, item] of Object.entries(value)) out[key] = check(item, wild, `${where}.${key}`);
    return Object.freeze(out);
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(spec, key) && !Object.hasOwn(spec, `${key}?`)) fail(`${where} has unknown key "${key}"`);
  }
  for (const [declared, sub] of Object.entries(spec)) {
    const key = declared.replace(/\?$/, '');
    if (value[key] !== undefined) out[key] = check(value[key], sub, `${where}.${key}`);
    else if (key === declared) fail(`${where}.${key} is required`);
  }
  return Object.freeze(out);
}

function loadRules(table) {
  const rules = check(table, TABLE, 'table');
  const need = (ok, message) => { if (!ok) fail(message); };
  const known = (name) => Object.hasOwn(rules.take_sets, name);
  for (const kind of Object.keys(rules.resources)) need(KIND_PATTERN.test(kind), `resource kind "${kind}" is invalid`);
  for (const [name, list] of Object.entries(rules.take_sets)) {
    need(list.length > 0, `take_sets.${name} must not be empty`);
    for (const take of list) need(Object.hasOwn(rules.resources, take.kind), `take_sets.${name} uses undeclared resource "${take.kind}"`);
  }
  need(known(rules.script_take_set) && known(rules.git.take_set), 'script_take_set and git.take_set must name declared take sets');
  const ids = new Set();
  for (const rule of rules.rules) {
    need(!ids.has(rule.id), `duplicate rule id "${rule.id}"`);
    ids.add(rule.id);
    need((rule.takes === undefined) !== (rule.runs_script === undefined), `rule "${rule.id}" needs exactly one of takes or runs_script`);
    need(rule.takes === undefined || known(rule.takes), `rule "${rule.id}" uses an undeclared take set`);
    need(!rule.script || rule.script.every((name) => name === name.toLowerCase()), `rule "${rule.id}" script names must be lowercase`);
  }
  return rules;
}

const DEFAULT_RULES = loadRules(require('./work-lease-rules.json'));

// ---------------------------------------------------------------- tokenizing

const globCache = new Map();

function globMatches(patterns, value) {
  return patterns.some((pattern) => {
    let re = globCache.get(pattern);
    if (!re) {
      re = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      globCache.set(pattern, re);
    }
    return re.test(value);
  });
}

// Splits on unquoted && || ; | & newline ( ) and backtick. A token is { value, quoted, start }.
function splitSegments(text, lex) {
  const segments = [];
  let tokens = [];
  let token = null;
  let quote = '';
  const open = (start) => { token ??= { value: '', quoted: false, start }; return token; };
  const endToken = () => { if (token) tokens.push(token); token = null; };
  const endSegment = () => { endToken(); if (tokens.length) segments.push(tokens); tokens = []; };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
      else if (quote === '"' && lex.escape && ch === '\\' && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) { i += 1; token.value += text[i]; }
      else token.value += ch;
    } else if (ch === '"' || (ch === "'" && lex.single)) {
      open(i).quoted = true;
      quote = ch;
    } else if (lex.escape && ch === '\\') {
      if (i + 1 < text.length && text[i + 1] !== '\n') { i += 1; open(i - 1).value += text[i]; }
      else if (i + 1 < text.length) i += 1;
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      endToken();
    } else if (ch === '(' || ch === ')') {
      endSegment();
      if (lex.subshell) segments.push(ch === '(' ? SUBSHELL_OPEN : SUBSHELL_CLOSE);
    } else if (ch === '\n' || ch === ';' || ch === '|' || ch === '`') {
      endSegment();
    } else if (ch === '&' && !(i > 0 && '<>'.includes(text[i - 1])) && text[i + 1] !== '>') {
      endSegment();
    } else {
      open(i).value += ch;
    }
  }
  endSegment();
  return segments;
}

function stripRedirects(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const { value, quoted } = tokens[i];
    if (!quoted && /^\d*(?:>>?|<)$/.test(value)) i += 1;
    else if (quoted || !/^\d*(?:>>?|<)&?\S+$/.test(value)) out.push(tokens[i]);
  }
  return out;
}

// ---------------------------------------------------------------- classification

// Nearest package.json at or above `dir`; any read or parse failure is null.
function defaultReadPackageJson(dir) {
  let current = path.resolve(dir);
  for (let i = 0; i < MAX_PACKAGE_WALK; i += 1) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(current, 'package.json'), 'utf8'));
      return isRecord(parsed) ? { dir: current, scripts: isRecord(parsed.scripts) ? parsed.scripts : {} } : null;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function normalizeExe(ctx, value) {
  let name = value.split(ctx.win ? /[\\/]/ : '/').pop();
  if (ctx.win) name = name.toLowerCase();
  name = name.replace(/\.(?:exe|cmd|bat|ps1)$/i, '');
  return /^(?:python[0-9.]*|pythonw[0-9.]*|py)$/.test(name) ? 'python' : name;
}

function safeWord(value) {
  return typeof value === 'string' && SAFE_WORD.test(value) ? value : '';
}

function resolveDir(ctx, dir, target) {
  if (!target || target === '-' || /^~|[$%]/.test(target)) return dir;
  return ctx.path.resolve(dir, target);
}

function emit(ctx, setName, dir, ruleId, label) {
  if (!ctx.label) ctx.label = ctx.hint || label;
  for (const take of ctx.rules.take_sets[setName]) {
    const resource = ctx.rules.resources[take.kind];
    const key = `${take.kind}\0${dir}`;
    const prev = ctx.takes.get(key);
    if (!prev) {
      ctx.takes.set(key, { kind: take.kind, scope: resource.scope, dir, units: take.units, capacity: resource.capacity, rule: ruleId });
    } else if (prev.units !== 'all' && (take.units === 'all' || take.units > prev.units)) {
      prev.units = take.units;
    }
  }
}

// Returns the wrapped command's tokens, null when `args` is not a wrapper call, or STOP.
const STOP = Symbol('stop');
function unwrap(spec, args) {
  let needSub = Boolean(spec.subcommand);
  let i = 0;
  for (; i < args.length; i += 1) {
    const value = args[i].value;
    if (value.startsWith('-') && value !== '-') {
      if (spec.stop_flags?.includes(value)) return STOP;
      if (spec.flags_with_value?.includes(value)) i += 1;
    } else if (needSub) {
      if (!spec.subcommand.includes(value)) return null;
      needSub = false;
    } else {
      break;
    }
  }
  return needSub ? null : args.slice(i);
}

function extractDirFlags(ctx, spec, args, dir) {
  const out = [args[0]];
  let current = dir;
  for (let i = 1; i < args.length; i += 1) {
    const value = args[i].value;
    if (spec.stop.includes(value)) { out.push(...args.slice(i)); break; }
    const eq = value.indexOf('=');
    const name = eq > 0 ? value.slice(0, eq) : value;
    if (value.startsWith('-') && spec.flags.includes(name)) {
      if (eq > 0) current = resolveDir(ctx, current, value.slice(eq + 1));
      else if (i + 1 < args.length) { i += 1; current = resolveDir(ctx, current, args[i].value); }
    } else {
      out.push(args[i]);
    }
  }
  return { args: out, dir: current };
}

function splitArgs(values, info, collectFlags) {
  let rest = false;
  for (const value of values) {
    if (!rest && value === '--') rest = true;
    else if (!rest && value.length > 1 && value[0] === '-') { if (collectFlags) info.flags.push(value); }
    else if (value[0] !== '+' || value.length === 1 || rest) info.pos.push(value);
  }
}

function parseInvocation(ctx, exe, args) {
  const values = args.map((token) => token.value);
  const info = { exe, flags: [], pos: [], module: '', script: '' };
  const interp = ctx.rules.interpreters[exe];
  if (!interp) {
    splitArgs(values, info, true);
    return info;
  }
  const modFlag = interp.module_flag;
  let i = 0;
  for (; i < values.length; i += 1) {
    const value = values[i];
    if (!value.startsWith('-') || value === '-') break;
    if (interp.code_flags.includes(value)) return info;
    if (modFlag && value.startsWith(modFlag) && value[1] !== '-') {
      info.module = value.length > modFlag.length ? value.slice(modFlag.length) : values[++i] ?? '';
      i += 1;
      break;
    }
    info.flags.push(value);
    if (interp.flags_with_value.includes(value)) i += 1;
  }
  if (!info.module && i < values.length) {
    info.script = values[i].split(ctx.win ? /[\\/]/ : '/').pop();
    i += 1;
  }
  splitArgs(values.slice(i), info, false);
  return info;
}

function matchSubcommand(rule, pos) {
  const starts = rule.match === 'any' ? pos.map((_, index) => index) : [0];
  for (const start of starts) {
    for (const entry of rule.subcommand ?? []) {
      const parts = entry.split(' ');
      if (parts.every((part, offset) => pos[start + offset] === part)) return entry;
    }
    if (rule.subcommand_glob && pos[start] !== undefined && globMatches(rule.subcommand_glob, pos[start])) return pos[start];
  }
  return null;
}

function matchRule(rule, info) {
  if (!rule.exe.includes(info.exe)) return null;
  if (rule.module && !rule.module.includes(info.module)) return null;
  if (rule.script && !rule.script.includes(info.script.toLowerCase())) return null;
  if (rule.flag && !info.flags.some((flag) => rule.flag.includes(flag))) return null;
  let sub = '';
  if (rule.subcommand || rule.subcommand_glob) {
    sub = matchSubcommand(rule, info.pos);
    if (sub === null) return null;
  }
  // What the rule discriminated on, for the label.
  const flag = rule.flag ? info.flags.find((f) => rule.flag.includes(f)) : '';
  const detail = rule.module ? `-m ${info.module}` : sub || (rule.script ? info.script : flag);
  return { sub, detail: safeWord(detail) };
}

function runScript(ctx, name, dir, scope, label, mustExist) {
  if (!name) return;
  let pkg = null;
  try { pkg = ctx.readPackageJson(dir); } catch { /* an unreadable package.json classifies by name only */ }
  const scripts = isRecord(pkg?.scripts) ? pkg.scripts : null;
  if (mustExist && typeof scripts?.[name] !== 'string') return;
  const root = typeof pkg?.dir === 'string' && pkg.dir ? ctx.path.resolve(dir, pkg.dir) : dir;
  const prevHint = ctx.hint;
  ctx.hint ||= label;
  if (scripts && scope.stack.length < MAX_SCRIPT_DEPTH && !scope.stack.includes(name)) {
    const next = { ...scope, stack: [...scope.stack, name] };
    for (const key of [`pre${name}`, name, `post${name}`]) {
      if (typeof scripts[key] === 'string') classifyText(ctx, scripts[key], root, next);
    }
  }
  if (globMatches(ctx.rules.npm_script_name_globs, name)) {
    emit(ctx, ctx.rules.script_take_set, root, 'npm-script-name', label);
  }
  ctx.hint = prevHint;
}

function flagHit(flag, list) {
  const eq = flag.indexOf('=');
  const name = eq > 0 ? flag.slice(0, eq) : flag;
  if (list.includes(name)) return true;
  return /^-[A-Za-z0-9]{2,}$/.test(name) && [...name.slice(1)].some((ch) => list.includes(`-${ch}`));
}

function gitWrites(spec, args) {
  const { flags, pos } = { flags: [], pos: [] };
  splitArgs(args, { flags, pos }, true);
  const hit = (list) => Boolean(list) && flags.some((flag) => flagHit(flag, list));
  if (hit(spec.write_flags)) return true;
  if (hit(spec.read_flags)) return false;
  if (spec.write_args) return pos.length > 0 && spec.write_args.includes(pos[0]);
  if (spec.read_args) return pos.length > 0 ? !spec.read_args.includes(pos[0]) : spec.empty !== 'read';
  return spec.positional_writes && pos.length > 0;
}

function runGit(ctx, args, dir) {
  const git = ctx.rules.git;
  const values = args.map((token) => token.value);
  let current = dir;
  let i = 0;
  for (; i < values.length; i += 1) {
    const value = values[i];
    if (value === '-C') { i += 1; if (i < values.length) current = resolveDir(ctx, current, values[i]); }
    else if (git.global_flags_with_value.includes(value)) i += 1;
    else if (!value.startsWith('-')) break;
  }
  const sub = values[i];
  if (!sub) return;
  const spec = git.conditional[sub];
  if (git.write_subcommands.includes(sub) || (spec && gitWrites(spec, values.slice(i + 1)))) {
    emit(ctx, git.take_set, current, `git:${safeWord(sub) || 'write'}`, `git ${safeWord(sub)}`.trim());
  }
}

// Shell wrappers: classify the inner command line. Returns true when the inner line consumed the
// rest of the outer text (cmd /c and powershell -Command take everything after the flag).
function runShell(ctx, kind, args, dir, text, scope) {
  if (scope.shell >= MAX_SHELL_DEPTH) return false;
  let index;
  if (kind === 'cmd') index = args.findIndex((t) => /^\/c$/i.test(t.value));
  else if (kind === 'powershell') index = args.findIndex((t) => t.value.length >= 2 && t.value[0] === '-' && '-command'.startsWith(t.value.toLowerCase()));
  else index = args.findIndex((t) => /^-[A-Za-z]*c[A-Za-z]*$/.test(t.value));
  const target = index < 0 ? undefined : args[index + 1];
  if (!target) return false;
  const lex = kind === 'cmd' ? LEX_WIN : kind === 'powershell' ? LEX_POWERSHELL : LEX_POSIX;
  const restOfLine = kind !== 'posix' && !target.quoted;
  const inner = restOfLine ? text.slice(target.start) : target.value;
  classifyText(ctx, inner, dir, { ...scope, shell: scope.shell + 1, lex });
  return restOfLine;
}

// Returns { dir, stop, push?, pop? } for one segment; `dir` is the directory for following segments.
function runSegment(ctx, tokens, dir, text, scope) {
  const rules = ctx.rules;
  let args = tokens;
  let current = dir;
  for (let guard = 0; guard < 16 && args.length > 0; guard += 1) {
    if (ASSIGNMENT.test(args[0].value)) { args = args.slice(1); continue; }
    const exe = normalizeExe(ctx, args[0].value);
    const lcExe = exe.toLowerCase();
    const dirSpec = rules.dir_flags.find((spec) => spec.exe.includes(exe));
    if (dirSpec) ({ args, dir: current } = extractDirFlags(ctx, dirSpec, args, current));
    const wrapper = rules.wrappers.find((spec) => spec.exe.includes(exe));
    const inner = wrapper ? unwrap(wrapper, args.slice(1)) : null;
    if (inner === STOP) break;
    if (inner) { args = inner; continue; }
    const push = rules.directory_push_commands.includes(lcExe);
    if (push || rules.directory_commands.includes(lcExe)) {
      const target = args.slice(1).map((t) => t.value).find((v) => !/^(?:\/d|-[A-Za-z]+)$/i.test(v));
      return { dir: resolveDir(ctx, current, target), stop: false, push };
    }
    if (rules.directory_pop_commands.includes(lcExe)) return { dir: current, stop: false, pop: true };
    const shell = Object.keys(rules.shells).find((kind) => rules.shells[kind].includes(lcExe));
    if (shell) return { dir: current, stop: runShell(ctx, shell, args.slice(1), current, text, scope) };
    if (rules.git.exe.includes(exe)) runGit(ctx, args.slice(1), current);
    else runRules(ctx, exe, args.slice(1), current, scope);
    break;
  }
  return { dir: current, stop: false };
}

function runRules(ctx, exe, args, dir, scope) {
  const info = parseInvocation(ctx, exe, args);
  for (const rule of ctx.rules.rules) {
    const matched = matchRule(rule, info);
    if (!matched) continue;
    let label = `${exe} ${matched.detail}`.trim();
    if (rule.takes) {
      emit(ctx, rule.takes, dir, rule.id, label);
    } else {
      const arg = rule.runs_script === '$arg' ? info.pos[matched.sub.split(' ').length] : undefined;
      const name = rule.runs_script === '$arg' ? arg
        : rule.runs_script === '$subcommand' ? info.pos[0] : rule.runs_script;
      if (rule.runs_script === '$arg') label = `${label} ${safeWord(arg)}`.trim();
      runScript(ctx, name, dir, scope, label, rule.runs_script === '$subcommand');
    }
    return;
  }
}

function classifyText(ctx, text, startDir, scope) {
  let dir = startDir;
  const subshells = [];
  const pushed = [];
  for (const tokens of splitSegments(text, scope.lex)) {
    if (tokens === SUBSHELL_OPEN) { subshells.push(dir); continue; }
    if (tokens === SUBSHELL_CLOSE) { if (subshells.length) dir = subshells.pop(); continue; }
    ctx.budget -= 1;
    if (ctx.budget < 0) return;
    const out = runSegment(ctx, stripRedirects(tokens), dir, text, scope);
    if (out.stop) return;
    if (out.push) pushed.push(dir);
    dir = out.pop ? (pushed.length ? pushed.pop() : dir) : out.dir;
  }
}

function classifyCommand(command, options) {
  if (!isRecord(options) || typeof options.cwd !== 'string' || !options.cwd) {
    throw new TypeError('classifyCommand requires options.cwd');
  }
  const win = (options.platform ?? process.platform) === 'win32';
  const ctx = {
    win,
    path: win ? path.win32 : path.posix,
    rules: options.rules ?? DEFAULT_RULES,
    readPackageJson: options.readPackageJson ?? defaultReadPackageJson,
    takes: new Map(),
    label: '',
    hint: '',
    budget: MAX_SEGMENTS,
  };
  if (typeof command === 'string' && command.trim()) {
    try {
      const scope = { shell: 0, stack: [], lex: win ? LEX_WIN : LEX_POSIX };
      classifyText(ctx, command.slice(0, MAX_COMMAND_CHARS), ctx.path.resolve(options.cwd), scope);
    } catch {
      ctx.takes.clear();
      ctx.label = '';
    }
  }
  return Object.freeze({
    label: ctx.label,
    takes: Object.freeze([...ctx.takes.values()].map((take) => Object.freeze(take))),
  });
}

module.exports = Object.freeze({ classifyCommand, loadRules, DEFAULT_RULES });
