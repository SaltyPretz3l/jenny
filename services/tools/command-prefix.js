'use strict';

// Row 103 (security review item 2, owner pick B 2026-11-02): what an "Always
// allow" on a run_command card may cover. A plain `program subcommand ...`
// command is saved as its program + subcommand prefix (any arguments); a
// command with no safe prefix is saved as its exact text; a chained,
// redirected or substituted command can only be allowed once.
//
// Mirrored exactly by sidecar/ai/tools/command_prefix.py; both are driven by
// tests/fixtures/command-prefix-cases.json.

// Same bound as tool-permission-migrations.js MAX_MATCH_TEXT_CHARS (counted
// in code points so the Python mirror agrees).
const MAX_COMMAND_CHARS = 1_024;
// Anywhere in the text, even inside quotes: chaining, redirection,
// substitution, cmd.exe escapes and variable expansion.
const UNSCOPED_CHARACTERS = Object.freeze(new Set(['&', '|', ';', '<', '>', '`', '$', '(', ')', '^', '%', '!']));
// Shells, launchers and interpreters: their second word is another program or
// a script, so "any arguments" would mean any command. Always exact.
const WRAPPER_PROGRAMS = Object.freeze([
  'bash', 'builtin', 'busybox', 'call', 'cmd', 'command', 'csh', 'dash', 'doas', 'env', 'eval',
  'exec', 'fish', 'ionice', 'ksh', 'nice', 'nohup', 'powershell', 'pwsh', 'runas', 'setsid',
  'sh', 'ssh', 'scp', 'start', 'stdbuf', 'su', 'sudo', 'taskset', 'tcsh', 'time', 'timeout',
  'watch', 'wsl', 'xargs', 'zsh',
  'bun', 'cscript', 'deno', 'java', 'lua', 'mshta', 'node', 'nodejs', 'osascript', 'perl',
  'php', 'py', 'python', 'python3', 'pythonw', 'regsvr32', 'rscript', 'ruby', 'rundll32',
  'ts-node', 'tsx', 'wscript',
]);
const WRAPPER_SET = new Set(WRAPPER_PROGRAMS);
const RUNNER_SUBCOMMANDS = Object.freeze(new Set(['run', 'exec', 'x', 'dlx', 'tool']));
const PROGRAM_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const WORD_RE = /^[A-Za-z][A-Za-z0-9:_-]*$/u;
const EXECUTABLE_SUFFIX_RE = /\.(?:exe|cmd|bat|com)$/iu;
// A versioned interpreter (python3.12, node20, perl5) is still that interpreter.
const VERSION_SUFFIX_RE = /[0-9.]+$/u;
const TRIM_CHARACTERS = new Set([' ', '\t', '\n', '\r', '\v', '\f']);
const SEPARATORS = new Set([' ', '\t']);

function trimCommand(text) {
  let start = 0;
  let end = text.length;
  while (start < end && TRIM_CHARACTERS.has(text[start])) start += 1;
  while (end > start && TRIM_CHARACTERS.has(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

function isControlCharacter(character) {
  const code = character.codePointAt(0);
  return (code < 0x20 && character !== '\t') || code === 0x7f;
}

// Whitespace-separated tokens with simple single/double quote grouping (the
// quotes themselves are dropped). Null when a quote is left open.
function tokenize(text) {
  const tokens = [];
  let current = '';
  let inToken = false;
  let quote = '';
  for (const character of text) {
    if (quote) {
      if (character === quote) quote = '';
      else current += character;
    } else if (character === '"' || character === '\'') {
      quote = character;
      inToken = true;
    } else if (SEPARATORS.has(character)) {
      if (inToken) tokens.push(current);
      current = '';
      inToken = false;
    } else {
      current += character;
      inToken = true;
    }
  }
  if (quote) return null;
  if (inToken) tokens.push(current);
  return tokens;
}

// The pre-checks every derivation and every match runs: null means the
// command can only be allowed once.
function analyzeCommand(command) {
  if (typeof command !== 'string') return null;
  const text = trimCommand(command);
  if (!text || [...text].length > MAX_COMMAND_CHARS) return null;
  for (const character of text) {
    if (UNSCOPED_CHARACTERS.has(character) || isControlCharacter(character)) return null;
  }
  const tokens = tokenize(text);
  return tokens && tokens.length ? { text, tokens } : null;
}

function normalizeProgram(token) {
  if (!PROGRAM_RE.test(token)) return null;
  return token.toLowerCase().replace(EXECUTABLE_SUFFIX_RE, '');
}

function isWrapperProgram(program) {
  return WRAPPER_SET.has(program) || WRAPPER_SET.has(program.replace(VERSION_SUFFIX_RE, ''));
}

// The normalized prefix tokens for an analyzed command, or null when it has
// no safe prefix (exact scope).
function prefixTokens(tokens) {
  const program = normalizeProgram(tokens[0]);
  if (!program || isWrapperProgram(program)) return null;
  const subcommand = tokens[1];
  if (subcommand === undefined || !WORD_RE.test(subcommand)) return null;
  if (!RUNNER_SUBCOMMANDS.has(subcommand)) return [program, subcommand];
  const target = tokens[2];
  // `uv tool run X` would make the runner itself the saved target.
  if (target === undefined || !WORD_RE.test(target) || RUNNER_SUBCOMMANDS.has(target)) return null;
  return [program, subcommand, target];
}

/**
 * @param {unknown} command
 * @returns {{scope:'none'}|{scope:'exact', command:string}|{scope:'prefix', prefix:string}}
 */
function deriveCommandScope(command) {
  const analyzed = analyzeCommand(command);
  if (!analyzed) return { scope: 'none' };
  const prefix = prefixTokens(analyzed.tokens);
  return prefix
    ? { scope: 'prefix', prefix: prefix.join(' ') }
    : { scope: 'exact', command: analyzed.text };
}

// A stored prefix is valid only when it is its own derivation.
function isCanonicalCommandPrefix(value) {
  if (typeof value !== 'string') return false;
  const derived = deriveCommandScope(value);
  return derived.scope === 'prefix' && derived.prefix === value;
}

function isCanonicalCommandExact(value) {
  return typeof value === 'string' && deriveCommandScope(value).scope !== 'none'
    && trimCommand(value) === value;
}

function commandMatchesPrefix(command, prefix) {
  if (!isCanonicalCommandPrefix(prefix)) return false;
  const analyzed = analyzeCommand(command);
  if (!analyzed) return false;
  const expected = prefix.split(' ');
  if (analyzed.tokens.length < expected.length) return false;
  if (normalizeProgram(analyzed.tokens[0]) !== expected[0]) return false;
  return expected.every((token, index) => index === 0 || analyzed.tokens[index] === token);
}

function commandMatchesExact(command, exact) {
  if (!isCanonicalCommandExact(exact)) return false;
  const analyzed = analyzeCommand(command);
  return Boolean(analyzed) && analyzed.text === exact;
}

/**
 * Validates the optional command match keys of a policy rule.
 * Returns {} when the rule names neither key, null when the keys are invalid
 * (both present, a non-canonical value, or a rule not scoped to run_command
 * alone), else { command_prefix } or { command_exact }.
 */
function normalizeCommandMatchKeys(match, { toolId = '', action = null, pathPrefix = null } = {}) {
  const source = match && typeof match === 'object' ? match : {};
  const prefix = source.command_prefix ?? null;
  const exact = source.command_exact ?? null;
  if (prefix === null && exact === null) return {};
  if (prefix !== null && exact !== null) return null;
  if (toolId !== 'run_command' || action || pathPrefix) return null;
  if (prefix !== null) return isCanonicalCommandPrefix(prefix) ? { command_prefix: prefix } : null;
  return isCanonicalCommandExact(exact) ? { command_exact: exact } : null;
}

module.exports = {
  commandMatchesExact,
  commandMatchesPrefix,
  deriveCommandScope,
  isCanonicalCommandExact,
  isCanonicalCommandPrefix,
  MAX_COMMAND_CHARS,
  normalizeCommandMatchKeys,
  RUNNER_SUBCOMMANDS,
  WRAPPER_PROGRAMS,
};
