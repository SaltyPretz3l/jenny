'use strict';

// `jenny mcp serve` (Jenny CLI plan, decision 11; owner stop 2026-10-18:
// read-only). A Model Context Protocol server over stdio (one JSON-RPC 2.0
// object per line) that exposes Jenny to another agent as four coarse,
// read-only tools: `jenny_ask` runs one turn under the policy fixed at
// launch (the same ceiling and headless decider as print mode; nothing ever
// prompts and nothing can widen it per call), `jenny_sessions_list` and
// `jenny_session_read` read this workspace's sessions, `jenny_status` reports
// the launch configuration. The profile lock is held for the server's
// lifetime; the sidecar starts on the first ask; asks run one at a time.

const readline = require('node:readline');
const Ajv = require('ajv');
const { acquireCliProfile, CLI_PROFILE_ERROR_CODES } = require('../services/cli-host/profile-lock');
const { createCliHost, hostComposition } = require('../services/cli-host/host');
const { CLI_ERROR_CODES, HOST_ERROR_CODES } = require('../services/backend/error-codes');
const { API_VERSION } = require('../services/backend/sidecar-client');
const { CLI_CONTRACT, CLI_VERSION, EXIT_CODES } = require('./exit-codes');
const { CLOSE_TIMEOUT_MS, createTurnSignals, killSidecar, runTurn, withTimeout } = require('./print');
const { collectSession, collectSessions } = require('./sessions');
const { hostLaunchOptions, lockOptions, resolveCliRuntime } = require('../services/cli-host/runtime-layout');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_LIMIT = 1_000_000_000;
const JSONRPC = Object.freeze({ PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 });

const count = { type: 'integer', minimum: 1, maximum: MAX_LIMIT };
const sessionId = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_.:-]+$' };
const TOOLS = Object.freeze([
  {
    name: 'jenny_ask',
    title: 'Ask Jenny',
    description: 'Run one prompt through the local Jenny runtime under the permission policy fixed when the server started. Returns the answer text and the cli.v1 result (subtype, exit_code, session_id, usage, permission_denials). Nothing prompts: a tool outside the launch policy is denied and ends the turn.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['prompt'],
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 1_000_000 },
        session_id: { ...sessionId, description: 'Continue this session of the current workspace.' },
        continue: { type: 'boolean', description: 'Continue the most recent session of the current workspace.' },
        max_turns: count, max_output_tokens: count,
        timeout_seconds: { type: 'number', exclusiveMinimum: 0, maximum: 86400 },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'jenny_sessions_list',
    title: 'List Jenny sessions',
    description: 'Sessions of the current workspace (all: every workspace of the profile), newest first.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { all: { type: 'boolean' }, limit: count } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'jenny_session_read',
    title: 'Read a Jenny session',
    description: 'A session summary and its last messages (limit, default 50).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['session_id'], properties: { session_id: sessionId, limit: count } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'jenny_status',
    title: 'Jenny status',
    description: 'Versions, engine, model, the permission policy fixed at launch, profile and workspace, and whether the engine has started.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
]);

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map(TOOLS.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]));

function rpcError(code, message, data) {
  return Object.assign(new Error(message), { rpc: { code, message, ...(data !== undefined ? { data } : {}) } });
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

// Frames go nowhere in MCP mode (the result is the tool result); only the
// diagnostics reach stderr.
function silentOutput(stderr) {
  return { frame: () => {}, diagnostic: (message) => { try { stderr.write(`${message}\n`); } catch (_error) { /* closed */ } } };
}

async function runMcpServe({ settings, stdin, stdout, stderr, appVersion = '', runtime = resolveCliRuntime({ root: ROOT }), logger = null }) {
  const log = logger || ((level, event, data) => {
    if (level === 'ERROR' || level === 'WARN') { try { stderr.write(`[${level.toLowerCase()}] ${event} ${JSON.stringify(data || {}).slice(0, 400)}\n`); } catch (_error) { /* closed */ } }
  });
  const diagnostic = (message) => { try { stderr.write(`${message}\n`); } catch (_error) { /* closed */ } };
  const send = (message) => { try { stdout.write(`${JSON.stringify(message)}\n`); } catch (_error) { /* closed */ } };

  let held;
  const inFlight = new Map();
  let serverLockLost = null;
  try {
    held = await acquireCliProfile({ userDataPath: settings.profilePath, ...lockOptions(runtime), onLost: (error) => {
      serverLockLost = error;
      diagnostic('[lock] the profile lock was lost: the server is stopping');
      for (const signals of inFlight.values()) signals.lockLost(error);
      shutdown(EXIT_CODES.ENGINE_UNAVAILABLE);
    } });
  } catch (error) {
    diagnostic(error?.message || 'The profile could not be acquired.');
    if (error?.code === CLI_PROFILE_ERROR_CODES.BUSY) return EXIT_CODES.PROFILE_BUSY;
    return error?.code === HOST_ERROR_CODES.CONFLICT ? EXIT_CODES.USAGE : EXIT_CODES.ENGINE_UNAVAILABLE;
  }
  let host;
  try {
    // The sidecar starts on the first ask; until then a source-route
    // executable only has to be a path.
    host = createCliHost({ profilePath: settings.profilePath, workspaceRoot: settings.workspaceRoot,
      ...hostLaunchOptions(runtime, { placeholderPython: true }), engine: { type: settings.engine, model: settings.model },
      permissions: { allowedTools: settings.allowedTools, disallowedTools: settings.disallowedTools, permissionMode: settings.permissionMode },
      logger: log });
  } catch (error) {
    held.release();
    diagnostic(error?.message || 'The host could not be composed.');
    return error?.reason === 'invalid_python_executable' ? EXIT_CODES.ENGINE_UNAVAILABLE : EXIT_CODES.USAGE;
  }
  const { backend, runPolicy } = hostComposition(host);

  let started = null;
  const ensureStarted = () => {
    started ||= host.start().catch((error) => { started = null; throw error; });
    return started;
  };

  // One ask at a time per profile; a queued ask that is cancelled before it
  // starts never runs.
  let queue = Promise.resolve();
  const ask = (args, id) => {
    const signals = createTurnSignals();
    inFlight.set(id, signals);
    const run = queue.then(async () => {
      if (signals.cancelled() || signals.lost()) return null;
      // The installed route has no interpreter; a refused packaged binary
      // surfaces through the start below with the resolver's reason.
      if (runtime.mode === 'source' && !runtime.pythonExecutable) {
        throw rpcError(JSONRPC.INTERNAL, 'The sidecar Python was not found. Run `jenny doctor`.');
      }
      await ensureStarted();
      const turnSettings = {
        ...settings,
        sessionId: typeof args.session_id === 'string' ? args.session_id : null,
        continue: args.continue === true && typeof args.session_id !== 'string',
        budgets: {
          max_turns: args.max_turns ?? null,
          max_inference_requests: args.max_turns ?? null,
          max_output_tokens: args.max_output_tokens ?? null,
          timeout_ms: typeof args.timeout_seconds === 'number' ? Math.round(args.timeout_seconds * 1000) : settings.budgets.timeout_ms,
        },
      };
      const { payload } = await runTurn({ host, settings: turnSettings, prompt: args.prompt, output: silentOutput(stderr), signals, appVersion, logger: log });
      return payload;
    });
    queue = run.then(() => {}, () => {});
    return run.finally(() => inFlight.delete(id));
  };

  const tools = {
    jenny_status: async () => ({
      versions: { cli: CLI_VERSION, contract: CLI_CONTRACT, app: appVersion || 'unknown', sidecar_api: API_VERSION },
      engine: settings.engine, model: settings.model, permission_mode: runPolicy.permissionMode,
      allowed_tools: [...runPolicy.allowedTools], disallowed_tools: [...runPolicy.disallowedTools],
      profile: settings.profilePath, cwd: settings.workspaceRoot, engine_started: started !== null, mode: 'read',
    }),
    jenny_sessions_list: async (args) => collectSessions(backend.sessionStore, host.workspaceProject('mcp_sessions_list').project_id,
      { all: args.all === true, ...(args.limit ? { limit: args.limit } : {}) }),
    jenny_session_read: async (args) => {
      const read = collectSession(backend.sessionStore, args.session_id, host.workspaceProject('mcp_session_read').project_id,
        args.limit ? { limit: args.limit } : {});
      if (!read) throw rpcError(JSONRPC.INVALID_PARAMS, `Session ${args.session_id} does not exist in this profile.`);
      return read;
    },
    jenny_ask: ask,
  };

  function toolResult(name, payload) {
    if (name === 'jenny_ask') {
      const text = payload.result || (payload.is_error ? `[${payload.subtype}] exit ${payload.exit_code}${payload.error_code ? ` ${payload.error_code}` : ''}` : '');
      return { content: [{ type: 'text', text }], structuredContent: payload, isError: payload.is_error === true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: false };
  }

  async function handle(request) {
    const { method, params } = request;
    if (method === 'initialize') {
      const asked = isRecord(params) && typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'jenny', title: 'Jenny', version: CLI_VERSION },
        instructions: 'Jenny runs a local model with bounded tools. jenny_ask runs one turn under the policy fixed at launch; it never prompts and a tool outside that policy ends the turn as denied. Sessions are scoped to the workspace the server was started in.',
      };
    }
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools: TOOLS.map((tool) => ({ ...tool })) };
    if (method === 'tools/call') {
      if (!isRecord(params) || typeof params.name !== 'string' || !Object.hasOwn(tools, params.name)) {
        throw rpcError(JSONRPC.INVALID_PARAMS, `Unknown tool ${isRecord(params) ? String(params.name).slice(0, 60) : ''}`.trim());
      }
      const args = params.arguments === undefined ? {} : params.arguments;
      const validate = validators.get(params.name);
      if (!isRecord(args) || !validate(args)) {
        throw rpcError(JSONRPC.INVALID_PARAMS, `Invalid arguments for ${params.name}`, (validate.errors || []).map((entry) => `${entry.instancePath} ${entry.message}`));
      }
      try {
        const payload = await tools[params.name](args, request.id);
        if (payload === null) return null; // cancelled before it ran: no response
        return toolResult(params.name, payload);
      } catch (error) {
        if (error?.rpc) throw error;
        return { content: [{ type: 'text', text: String(error?.message || 'The tool failed.').slice(0, 2000) }], isError: true };
      }
    }
    throw rpcError(JSONRPC.METHOD_NOT_FOUND, `Method not found: ${String(method).slice(0, 80)}`);
  }

  function onNotification(message) {
    if (message.method === 'notifications/cancelled' && isRecord(message.params)) {
      const signals = inFlight.get(message.params.requestId);
      if (signals) {
        signals.cancel('SIGINT');
        cancelled.add(message.params.requestId);
      }
    }
    // notifications/initialized and anything else need no action.
  }

  const cancelled = new Set();
  let closing = null;
  let exitCode = EXIT_CODES.OK;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  function shutdown(code) {
    if (closing) return closing;
    exitCode = code;
    closing = (async () => {
      for (const signals of inFlight.values()) signals.cancel('SIGTERM');
      await withTimeout(queue, CLOSE_TIMEOUT_MS, () => null);
      await withTimeout(host.close(), CLOSE_TIMEOUT_MS, () => { killSidecar(backend); return null; });
      held.release();
      resolveDone();
    })();
    return closing;
  }

  const onSignal = () => { diagnostic('[signal] stopping the server'); shutdown(EXIT_CODES.OK); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const lines = readline.createInterface({ input: stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (closing) return;
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) { send({ jsonrpc: '2.0', id: null, error: { code: JSONRPC.INVALID_REQUEST, message: 'Message too large' } }); return; }
    let message;
    try { message = JSON.parse(line); } catch (_error) {
      send({ jsonrpc: '2.0', id: null, error: { code: JSONRPC.PARSE, message: 'Parse error' } });
      return;
    }
    if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      send({ jsonrpc: '2.0', id: isRecord(message) && (typeof message.id === 'string' || typeof message.id === 'number') ? message.id : null,
        error: { code: JSONRPC.INVALID_REQUEST, message: 'Invalid request' } });
      return;
    }
    if (message.id === undefined || message.id === null) { onNotification(message); return; }
    const id = message.id;
    handle(message).then((result) => {
      if (result === null || cancelled.has(id)) { cancelled.delete(id); return; }
      send({ jsonrpc: '2.0', id, result });
    }, (error) => {
      if (cancelled.has(id)) { cancelled.delete(id); return; }
      const rpc = error?.rpc || { code: JSONRPC.INTERNAL, message: String(error?.message || 'Internal error').slice(0, 400) };
      send({ jsonrpc: '2.0', id, error: rpc });
    });
  });
  lines.on('close', () => { if (!serverLockLost) shutdown(EXIT_CODES.OK); });
  diagnostic(`[mcp] jenny ${CLI_VERSION} serving ${TOOLS.length} read-only tools on stdio (engine ${settings.engine}, policy ${runPolicy.permissionMode}, allowed ${runPolicy.allowedTools.join(',') || '(none)'})`);

  await done;
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  lines.close();
  return exitCode;
}

module.exports = { PROTOCOL_VERSIONS, TOOLS, runMcpServe };
