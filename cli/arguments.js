'use strict';

// Argument grammar for `jenny` (Jenny CLI plan, decision 7): `jenny [options]
// [prompt]` plus noun-verb commands. Hot-path flags mirror the names agents
// already guess. Pure: parsing and precedence only (flags > non-secret JENNY_*
// env > <profile>/cli.json > defaults); secrets never come from any of them.

const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { DESKTOP_ONLY_TOOLS, createRunPermissionPolicy } = require('../services/cli-host/run-permission-policy');
const { assertLocalOnlyEngine, assertLocalOnlyModel } = require('../services/cli-host/local-only-providers');

const OUTPUT_FORMATS = Object.freeze(['text', 'json', 'stream-json']);
// Nouns of the noun-verb grammar; each command module validates its own verbs.
const COMMANDS = Object.freeze(['doctor', 'help', 'sessions', 'config', 'completion', 'mcp']);
const COMMAND_VERBS = Object.freeze({
  sessions: ['list', 'show', 'rm'], config: ['list', 'get', 'set'], completion: ['bash', 'zsh', 'powershell'], mcp: ['serve'],
});
// The keys <profile>/cli.json may hold, in the order `config list` prints them.
const PROFILE_CONFIG_KEYS = Object.freeze(['model', 'engine', 'output_format', 'permission_mode', 'allowed_tools', 'disallowed_tools', 'timeout_seconds']);
// `auto` is reserved by the contract and refused until the mode exists, so a
// caller never gets `ask` behaviour under a flag that promised more.
const CLI_PERMISSION_MODES = Object.freeze(['ask', 'plan']);
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_SECONDS = DEFAULT_TIMEOUT_MS / 1000;
const MAX_TIMEOUT_MS = 24 * 60 * 60_000;
const MAX_LIMIT = 1_000_000_000;
const MAX_PROMPT_CHARS = 1_000_000;

const OPTIONS = Object.freeze({
  print: { type: 'boolean', short: 'p' },
  continue: { type: 'boolean', short: 'c' },
  resume: { type: 'string', short: 'r' },
  model: { type: 'string', short: 'm' },
  engine: { type: 'string' },
  'output-format': { type: 'string' },
  'permission-mode': { type: 'string' },
  'allowed-tools': { type: 'string', multiple: true },
  'disallowed-tools': { type: 'string', multiple: true },
  'max-turns': { type: 'string' },
  'max-output-tokens': { type: 'string' },
  'max-inference-requests': { type: 'string' },
  timeout: { type: 'string' },
  cwd: { type: 'string' },
  'session-id': { type: 'string' },
  profile: { type: 'string' },
  'cancel-on-stdin-close': { type: 'boolean' },
  all: { type: 'boolean' },
  limit: { type: 'string' },
  'show-origin': { type: 'boolean' },
  thinking: { type: 'boolean' },
  'tool-output': { type: 'boolean' },
  'no-color': { type: 'boolean' },
  json: { type: 'boolean' },
  version: { type: 'boolean', short: 'V' },
  help: { type: 'boolean', short: 'h' },
});

function usage() {
  return [
    'Usage: jenny [options] [prompt]              (no prompt on a terminal starts the interactive loop)',
    '       jenny sessions list [--all] [--limit <n>] [--json]',
    '       jenny sessions show <session-id> [--limit <n>] [--json]',
    '       jenny sessions rm <session-id> [--json]',
    '       jenny config list [--show-origin] [--json]',
    '       jenny config get <key> [--json]',
    '       jenny config set <key> <value> [--json]   (an empty value removes the key)',
    '       jenny mcp serve [run options]              (a read-only MCP server over stdio)',
    '       jenny completion bash|zsh|powershell',
    '       jenny doctor [--json]',
    '       jenny help',
    '',
    'Options:',
    '  -p, --print                 Run one prompt non-interactively and exit (the prompt may come from stdin)',
    '  -c, --continue              Continue the most recent session in this profile',
    '  -r, --resume <session-id>   Continue the given session',
    '  -m, --model <name>          Model to use (default: the engine’s active model)',
    '      --engine <type>         Local engine: ollama, vllm, openai-compatible (loopback only), replay',
    '      --output-format <f>     text | json | stream-json (default: text)',
    '      --permission-mode <m>   ask | plan (default: ask; auto is not available yet)',
    '      --allowed-tools <ids>   Pre-allow tool ids or tool:action pairs (comma separated; simple globs like read_*; repeatable)',
    '      --disallowed-tools <ids> Refuse tool ids for this run (joined with JENNY_DISALLOWED_TOOLS and cli.json)',
    '      --max-turns <n>         Inference requests allowed in this run',
    '      --max-output-tokens <n> Output tokens allowed in this run',
    '      --max-inference-requests <n>',
    '      --timeout <seconds>     Cancel the run after this long (default: 600)',
    '      --cwd <dir>             Workspace root (default: the current directory)',
    '      --session-id <id>       Use this session id (same as --resume)',
    '      --profile <dir>         CLI profile directory (default: JENNY_PROFILE or the per-user jenny-cli folder)',
    '      --cancel-on-stdin-close Treat the caller closing a piped stdin as a cancel (prompt given as an argument)',
    '      --all                   sessions list: every workspace in the profile, not only this one',
    '      --limit <n>             sessions list: at most n sessions; sessions show: the last n messages',
    '      --show-origin           config list: which layer set each value (flag, env, file, default)',
    '      --json                  Machine-readable output for read commands, doctor and -V',
    '      --thinking              Include thinking frames (stream-json)',
    '      --tool-output           Include tool output frames (stream-json)',
    '      --no-color              Disable colour on stderr',
    '  -V, --version               Print versions',
    '  -h, --help                  Show this help',
    '',
    'Exit codes: 0 ok, 1 runtime error, 2 usage, 3 policy denial, 4 decision required, 5 budget or timeout,',
    '            6 engine or profile unavailable, 75 profile busy, 130 interrupted, 143 terminated.',
  ].join('\n');
}

function usageError(reason, message) {
  return Object.assign(new Error(message), { reason, usage: true });
}

function parseCount(value, name) {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (!/^\d{1,12}$/u.test(text)) throw usageError('invalid_number', `--${name} needs a positive integer.`);
  const number = Number(text);
  if (number < 1 || number > MAX_LIMIT) throw usageError('invalid_number', `--${name} must be between 1 and ${MAX_LIMIT}.`);
  return number;
}

function parseTimeoutMs(value) {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (!/^\d{1,7}(?:\.\d{1,3})?$/u.test(text)) throw usageError('invalid_timeout', '--timeout needs seconds, for example 120 or 0.5.');
  const ms = Math.round(Number(text) * 1000);
  if (ms < 1 || ms > MAX_TIMEOUT_MS) throw usageError('invalid_timeout', '--timeout must be between 0.001 and 86400 seconds.');
  return ms;
}

function splitToolList(values) {
  if (!values) return undefined;
  const list = (Array.isArray(values) ? values : [values])
    .flatMap((entry) => String(entry).split(/[,\s]+/u)).map((entry) => entry.trim()).filter(Boolean);
  return list.length ? list : [];
}

function oneOf(value, allowed, name) {
  if (value === undefined) return undefined;
  const text = String(value).trim().toLowerCase();
  if (!allowed.includes(text)) throw usageError(`invalid_${name.replace(/-/gu, '_')}`, `--${name} must be one of ${allowed.join(', ')}.`);
  return text;
}

function permissionMode(value, name) {
  if (value !== undefined && String(value).trim().toLowerCase() === 'auto') {
    throw usageError('permission_mode_unavailable', `--${name} auto is not available yet; use ask or plan.`);
  }
  return oneOf(value, CLI_PERMISSION_MODES, name);
}

function identifier(value, name) {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(text)) throw usageError(`invalid_${name.replace(/-/gu, '_')}`, `--${name} is not a valid id.`);
  return text;
}

function parseArguments(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw usageError('invalid_arguments', String(error?.message || 'Invalid arguments.'));
  }
  const { values, positionals } = parsed;
  const command = COMMANDS.includes(positionals[0]) ? positionals[0] : null;
  const rest = command ? positionals.slice(1) : positionals;
  if ((command === 'doctor' && rest.length) || (command === 'help' && rest.length > 1)) {
    throw usageError('unexpected_argument', `jenny ${command} takes no further arguments.`);
  }
  if (command && COMMAND_VERBS[command] && !COMMAND_VERBS[command].includes(rest[0])) {
    throw usageError('unknown_verb', `jenny ${command} needs one of: ${COMMAND_VERBS[command].join(', ')}.`);
  }
  const prompt = command ? '' : rest.join(' ').trim();
  if (prompt.length > MAX_PROMPT_CHARS) throw usageError('prompt_too_long', 'The prompt is too long.');
  const model = values.model === undefined ? undefined : String(values.model).trim();
  if (model !== undefined && (!model || model.length > 240)) throw usageError('invalid_model', '--model needs a model name.');
  const sessionId = identifier(values['session-id'], 'session-id');
  const resume = identifier(values.resume, 'resume');
  if (sessionId && resume && sessionId !== resume) throw usageError('conflicting_session', '--session-id and --resume disagree.');
  if (values.continue && (sessionId || resume)) throw usageError('conflicting_session', '--continue cannot be combined with a session id.');
  return Object.freeze({
    command,
    commandArgs: Object.freeze(command ? rest.map((entry) => String(entry)) : []),
    prompt,
    help: values.help === true,
    version: values.version === true,
    json: values.json === true,
    flags: Object.freeze({
      print: values.print === true,
      continue: values.continue === true,
      sessionId: sessionId || resume,
      model,
      engine: values.engine === undefined ? undefined : String(values.engine).trim().toLowerCase(),
      outputFormat: oneOf(values['output-format'], OUTPUT_FORMATS, 'output-format'),
      permissionMode: permissionMode(values['permission-mode'], 'permission-mode'),
      allowedTools: splitToolList(values['allowed-tools']),
      disallowedTools: splitToolList(values['disallowed-tools']),
      maxTurns: parseCount(values['max-turns'], 'max-turns'),
      maxOutputTokens: parseCount(values['max-output-tokens'], 'max-output-tokens'),
      maxInferenceRequests: parseCount(values['max-inference-requests'], 'max-inference-requests'),
      timeoutMs: parseTimeoutMs(values.timeout),
      cwd: values.cwd === undefined ? undefined : String(values.cwd),
      profile: values.profile === undefined ? undefined : String(values.profile),
      cancelOnStdinClose: values['cancel-on-stdin-close'] === true,
      all: values.all === true,
      limit: parseCount(values.limit, 'limit'),
      showOrigin: values['show-origin'] === true,
      thinking: values.thinking === true,
      toolOutput: values['tool-output'] === true,
      noColor: values['no-color'] === true,
    }),
  });
}

function defaultProfilePath(env, platform = process.platform, homedir = os.homedir()) {
  const configured = String(env.JENNY_PROFILE || '').trim();
  if (configured) return configured;
  if (platform === 'win32') return path.join(String(env.APPDATA || path.join(homedir, 'AppData', 'Roaming')), 'jenny-cli');
  return path.join(homedir, '.jenny-cli');
}

function readEnv(env) {
  const text = (name) => { const value = String(env[name] || '').trim(); return value || undefined; };
  return {
    model: text('JENNY_MODEL'),
    engine: text('JENNY_ENGINE')?.toLowerCase(),
    outputFormat: text('JENNY_OUTPUT_FORMAT') ? oneOf(text('JENNY_OUTPUT_FORMAT'), OUTPUT_FORMATS, 'output-format') : undefined,
    permissionMode: text('JENNY_PERMISSION_MODE') ? permissionMode(text('JENNY_PERMISSION_MODE'), 'permission-mode') : undefined,
    allowedTools: splitToolList(text('JENNY_ALLOWED_TOOLS')),
    disallowedTools: splitToolList(text('JENNY_DISALLOWED_TOOLS')),
    timeoutMs: parseTimeoutMs(text('JENNY_TIMEOUT')),
    noColor: Boolean(text('NO_COLOR')),
  };
}

// <profile>/cli.json: only non-secret keys, each validated like its flag.
function readProfileConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  const out = {};
  if (typeof config.model === 'string' && config.model.trim()) out.model = config.model.trim().slice(0, 240);
  if (typeof config.engine === 'string' && config.engine.trim()) out.engine = config.engine.trim().toLowerCase();
  if (typeof config.output_format === 'string') out.outputFormat = oneOf(config.output_format, OUTPUT_FORMATS, 'output-format');
  if (typeof config.permission_mode === 'string') out.permissionMode = permissionMode(config.permission_mode, 'permission-mode');
  if (Array.isArray(config.allowed_tools)) out.allowedTools = splitToolList(config.allowed_tools);
  if (Array.isArray(config.disallowed_tools)) out.disallowedTools = splitToolList(config.disallowed_tools);
  if (config.timeout_seconds !== undefined) out.timeoutMs = parseTimeoutMs(config.timeout_seconds);
  return out;
}

function pick(key, ...layers) {
  for (const layer of layers) {
    if (layer && layer[key] !== undefined) return layer[key];
  }
  return undefined;
}

const LAYER_NAMES = Object.freeze(['flag', 'env', 'file']);

// The layer a value came from, for `config list --show-origin`.
function originOf(key, layers) {
  const index = layers.findIndex((layer) => layer && layer[key] !== undefined);
  return index >= 0 ? LAYER_NAMES[index] : 'default';
}

// A desktop-only tool is pre-allowed by the invocation that runs it, never by
// an ambient environment or a file on disk.
function refuseAmbientDesktopOnly(layer, source) {
  const named = (layer.allowedTools || []).find((selector) => DESKTOP_ONLY_TOOLS.includes(selector.split(':', 1)[0]));
  if (named) throw usageError('desktop_only_requires_flag', `${source} may not pre-allow "${named}"; pass --allowed-tools ${named} on the command line.`);
}

// Flags win over env, env over the profile file, the file over defaults. The
// result is the complete run configuration the init frame echoes. Disallows
// are the one setting every layer contributes to: a refusal anywhere holds.
function resolveSettings({ flags, env = {}, profileConfig = {}, cwd = process.cwd() }) {
  const fromEnv = readEnv(env);
  const fromFile = readProfileConfig(profileConfig);
  refuseAmbientDesktopOnly(fromEnv, 'JENNY_ALLOWED_TOOLS');
  refuseAmbientDesktopOnly(fromFile, 'cli.json allowed_tools');
  const layers = [flags, fromEnv, fromFile];
  const maxInferenceRequests = pick('maxInferenceRequests', flags) ?? pick('maxTurns', flags) ?? null;
  const allowedTools = pick('allowedTools', ...layers) || [];
  const disallowedTools = [...new Set(layers.flatMap((layer) => layer.disallowedTools || []))];
  const disallowedOrigins = LAYER_NAMES.filter((name, index) => (layers[index].disallowedTools || []).length);
  const permissionMode = pick('permissionMode', ...layers) || 'ask';
  const origins = Object.freeze({
    model: originOf('model', layers),
    engine: originOf('engine', layers),
    output_format: originOf('outputFormat', layers),
    permission_mode: originOf('permissionMode', layers),
    allowed_tools: originOf('allowedTools', layers),
    disallowed_tools: disallowedOrigins.length ? disallowedOrigins.join('+') : 'default',
    timeout_seconds: originOf('timeoutMs', layers),
    profile: flags.profile ? 'flag' : (String(env.JENNY_PROFILE || '').trim() ? 'env' : 'default'),
    cwd: flags.cwd ? 'flag' : 'default',
  });
  const engine = pick('engine', ...layers) || 'ollama';
  const model = pick('model', ...layers) || '';
  // The same validation the composition applies, surfaced as a usage error
  // before any profile is touched: selectors, and the local-only engine and
  // model (an openai-compatible URL is checked against the profile later).
  try {
    createRunPermissionPolicy({ allowedTools, disallowedTools, permissionMode });
    assertLocalOnlyEngine(engine);
    assertLocalOnlyModel(engine, model);
  } catch (error) {
    throw usageError(String(error?.reason || 'invalid_permissions'), String(error?.message || 'Invalid tool selectors.'));
  }
  return Object.freeze({
    profilePath: path.resolve(flags.profile || defaultProfilePath(env)),
    workspaceRoot: path.resolve(cwd, flags.cwd || '.'),
    model,
    engine,
    outputFormat: pick('outputFormat', ...layers) || 'text',
    permissionMode,
    allowedTools,
    disallowedTools,
    budgets: Object.freeze({
      max_turns: flags.maxTurns ?? null,
      max_output_tokens: flags.maxOutputTokens ?? null,
      max_inference_requests: maxInferenceRequests,
      timeout_ms: pick('timeoutMs', ...layers) ?? DEFAULT_TIMEOUT_MS,
    }),
    thinking: flags.thinking === true,
    toolOutput: flags.toolOutput === true,
    color: !(flags.noColor || fromEnv.noColor),
    sessionId: flags.sessionId || null,
    continue: flags.continue === true,
    cancelOnStdinClose: flags.cancelOnStdinClose === true,
    origins,
  });
}

module.exports = {
  CLI_PERMISSION_MODES, COMMANDS, COMMAND_VERBS, DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_SECONDS, OPTIONS, OUTPUT_FORMATS,
  PROFILE_CONFIG_KEYS, defaultProfilePath, parseArguments, resolveSettings, usage, usageError,
};
