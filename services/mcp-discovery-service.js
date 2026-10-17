const {
  McpConfigStore,
  configurationDigest,
  normalizedServerConfig,
  projectServerConfig,
  pendingTrust,
  normalizePrompts,
  approvedPrompts,
} = require('./mcp-config-store');
const { MCP_ERROR_CODES } = require('./backend/error-codes');
const { readinessProbeLaunch, probeMcpReadiness } = require('./mcp-readiness-probe');

const BUILTIN_SERVER = Object.freeze({
  name: 'jenny_local_tools',
  transport: 'stdio',
});

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTransport(value) {
  const token = String(value || '').trim().toLowerCase();
  return token || 'stdio';
}

function runtimeServerIdentity(value) {
  if (!isPlainObject(value)) return null;
  const name = String(value.name || '').trim();
  return name ? { name, transport: normalizeTransport(value.transport) } : null;
}

function mcpAuthSecretRef(serverName) {
  return `mcp:${serverName}`;
}

function structuredError(code, message) {
  return { ok: false, error: { code, message } };
}

function normalizeFailureMap(value) {
  const map = new Map();
  for (const entry of Array.isArray(value) ? value : []) {
    const name = String(entry?.name || '').trim();
    if (name) {
      map.set(name, {
        code: String(entry.code || '').trim(),
        message: String(entry.message || '').trim(),
      });
    }
  }
  return map;
}

function normalizeCooldownMap(value) {
  const map = new Map();
  for (const entry of Array.isArray(value) ? value : []) {
    const name = String(entry?.name || '').trim();
    if (name) {
      const remainingSeconds = Number(entry.remaining_seconds ?? entry.remainingSeconds ?? 0);
      map.set(name, {
        remaining_seconds: Number.isFinite(remainingSeconds) ? Math.max(0, remainingSeconds) : 0,
        reason: String(entry.reason || '').trim(),
      });
    }
  }
  return map;
}

function isForwardableServer(server, config) {
  if (!server || typeof server !== 'object') {
    return false;
  }
  if (server.transport === 'stdio') {
    return Boolean(String(server.command || '').trim());
  }
  if (server.transport === 'sse') {
    return config.mcp_sse_enabled === true && Boolean(String(server.url || '').trim());
  }
  return false;
}

function deriveServerNameFromToolName(toolName) {
  const parts = String(toolName || '').split('__');
  return parts.length >= 3 && parts[0] === 'mcp' ? parts[1] : '';
}

function countToolsByServer(toolsStatus = {}) {
  const counts = new Map();
  const source = isPlainObject(toolsStatus) ? toolsStatus : {};
  for (const [toolName, status] of Object.entries(source)) {
    const statusObject = isPlainObject(status) ? status : {};
    const sourceKind = String(statusObject.source_kind || statusObject.sourceKind || '').trim();
    if (sourceKind && sourceKind !== 'mcp') {
      continue;
    }
    const serverName = String(statusObject.server_name || statusObject.serverName || '').trim()
      || deriveServerNameFromToolName(toolName);
    if (!serverName) {
      continue;
    }
    counts.set(serverName, (counts.get(serverName) || 0) + 1);
  }
  return counts;
}

// Non-secret auth summary for the renderer-facing discovery payload: never
// carries `token` / `client_secret` and never resolves the secret value from
// secureStore here. `secretRef` is an opaque pointer only.
function summarizeServerAuth(auth) {
  if (!isPlainObject(auth)) {
    return null;
  }
  const kind = String(auth.kind || '').trim().toLowerCase();
  const secretRef = String(auth.secret_ref || '').trim() || null;
  const tokenUrl = String(auth.token_url || '').trim();
  const clientId = String(auth.client_id || '').trim();
  const scope = String(auth.scope || '').trim();
  if (!kind && !secretRef && !tokenUrl && !clientId && !scope) return null;
  return { kind: kind || 'bearer', secretRef, token_url: tokenUrl, client_id: clientId, scope };
}

function normalizeRuntimeServers(status = {}, configuredServers = []) {
  const seen = new Set();
  const rows = [];
  const runtimeRows = Array.isArray(status.mcp_servers) ? status.mcp_servers : [];
  const candidates = [BUILTIN_SERVER, ...configuredServers, ...runtimeRows];
  for (const entry of candidates) {
    const normalized = runtimeServerIdentity(entry);
    if (!normalized || seen.has(normalized.name)) {
      continue;
    }
    seen.add(normalized.name);
    rows.push({
      name: normalized.name,
      transport: normalized.transport,
      url: ['sse', 'http'].includes(normalized.transport) ? String(entry.url || '').trim() : '',
      command: normalized.transport === 'stdio' ? String(entry.command || '').trim() : '',
      args: normalized.transport === 'stdio' && Array.isArray(entry.args) ? [...entry.args] : [],
      auth: ['sse', 'http'].includes(normalized.transport) ? summarizeServerAuth(entry.auth) : null,
    });
  }
  for (const name of Array.isArray(status.mcp_servers_connected) ? status.mcp_servers_connected : []) {
    const token = String(name || '').trim();
    if (token && !seen.has(token)) {
      seen.add(token);
      rows.push({ name: token, transport: 'stdio', url: '', command: '', args: [], auth: null });
    }
  }
  for (const failure of Array.isArray(status.mcp_servers_failed) ? status.mcp_servers_failed : []) {
    const token = String(failure?.name || '').trim();
    if (token && !seen.has(token)) {
      seen.add(token);
      rows.push({ name: token, transport: 'stdio', url: '', command: '', args: [], auth: null });
    }
  }
  return rows;
}

function buildDiscoveryState({ backendStatus = {}, configuredServers = [], sseEnabled = false,
  configStatus = {} }) {
  const connected = new Set(
    (Array.isArray(backendStatus.mcp_servers_connected) ? backendStatus.mcp_servers_connected : [])
      .map((name) => String(name || '').trim())
      .filter(Boolean)
  );
  const failures = normalizeFailureMap(backendStatus.mcp_servers_failed);
  const cooldowns = normalizeCooldownMap(backendStatus.mcp_server_cooldowns);
  const toolCounts = countToolsByServer(backendStatus.tools_status);
  const servers = normalizeRuntimeServers(backendStatus, configuredServers).map((server) => {
    const configured = configuredServers.find((row) => row.name === server.name) || null;
    let status = 'configured';
    if (failures.has(server.name)) {
      status = 'failed';
    } else if (cooldowns.has(server.name)) {
      status = 'cooldown';
    } else if (connected.has(server.name)) {
      status = 'running';
    }
    const failure = failures.get(server.name) || null;
    const cooldown = cooldowns.get(server.name) || null;
    const prompts = server.name === BUILTIN_SERVER.name ? [] : approvedPrompts(configured);
    return {
      name: server.name,
      transport: server.transport,
      status,
      toolsCount: toolCounts.get(server.name) || 0,
      prompts,
      promptsCount: prompts.length,
      failure,
      cooldown,
      url: server.url || '',
      command: server.command || '',
      args: server.args || [],
      auth: server.auth || null,
      builtin: server.name === BUILTIN_SERVER.name,
      enabled: server.name === BUILTIN_SERVER.name || configured?.enabled === true,
      trust: configured?.trust || null,
      readOnlyAutoAllow: server.name !== BUILTIN_SERVER.name && configured?.read_only_auto_allow === true,
    };
  });
  return {
    servers,
    sseEnabled: sseEnabled === true,
    schemaVersion: configStatus.schemaVersion || 1,
    readOnly: configStatus.readOnly === true,
    remediationReason: String(configStatus.reason || ''),
    migrated: configStatus.migrated === true,
  };
}

class McpDiscoveryService {
  constructor({
    userDataPath,
    backendService = null,
    configStore = null,
    now = () => new Date().toISOString(),
    log = () => {},
    readinessProbe = probeMcpReadiness,
  } = {}) {
    if (!userDataPath) {
      throw new Error('userDataPath is required for McpDiscoveryService.');
    }
    this.userDataPath = userDataPath;
    this.configStore = configStore || new McpConfigStore({ userDataPath, log });
    this.configPath = this.configStore.configPath;
    this.backendService = backendService || null;
    this.now = now;
    this.log = typeof log === 'function' ? log : () => {};
    this.lastInspections = new Map();
    this.readiness = new Map();
    this.readinessProbe = readinessProbe;
    this.inspectionControllers = new Map();
  }

  setBackendService(backendService) {
    this.backendService = backendService || null;
  }

  _loadConfig() {
    return this.configStore.getState().document;
  }

  // The Electron side forwards `mcp_sse_enabled: true` only when the user
  // config gate (mcp-servers.json `mcp_sse_enabled`) is on. The sidecar's
  // `_parse_mcp_servers` hard-raises (CMP-MCP-0002) if an sse/http server
  // arrives while that gate is false, so the forwarding filter and the
  // forwarded gate value both read the same `sseEnabled`.
  getSidecarConfig() {
    const config = this._loadConfig();
    const sseEnabled = config.mcp_sse_enabled === true;
    const supportedServers = config.mcp_servers.filter((server) =>
      server.enabled === true
      && server.trust?.status === 'approved'
      && server.trust.configuration_digest === configurationDigest(server)
      && isForwardableServer(server, config)
    );
    if (!supportedServers.length && !sseEnabled) {
      return {};
    }
    return {
      mcp_servers: supportedServers.map((server) => ({
        ...projectServerConfig(server),
        approved_tools_digest: server.trust.advertised_tools_digest,
      })),
      mcp_sse_enabled: sseEnabled,
    };
  }

  getState() {
    this._invalidateToolSurfaceDrift();
    const storeState = this.configStore.getState();
    const config = storeState.document;
    const backendStatus = this.backendService?.currentStatus || {};
    const state = buildDiscoveryState({
      backendStatus,
      configuredServers: config.mcp_servers,
      sseEnabled: config.mcp_sse_enabled === true,
      configStatus: storeState,
    });
    for (const row of state.servers) {
      row.readiness = readinessProbeLaunch(row) ? this.readiness.get(row.name) || null : null;
    }
    return state;
  }

  async refresh() {
    if (this.backendService && typeof this.backendService.refreshManagedConfig === 'function') {
      await this.backendService.refreshManagedConfig('mcp_discovery_refresh');
    }
    return this.getState();
  }

  _invalidateToolSurfaceDrift() {
    const failures = Array.isArray(this.backendService?.currentStatus?.mcp_servers_failed)
      ? this.backendService.currentStatus.mcp_servers_failed : [];
    const drifted = new Set(failures
      .filter((failure) => failure?.code === MCP_ERROR_CODES.TOOL_SURFACE_CHANGED)
      .map((failure) => String(failure?.name || '').trim()).filter(Boolean));
    if (!drifted.size) return;
    const state = this.configStore.getState();
    if (state.readOnly || !state.document.mcp_servers.some((row) => (
      drifted.has(row.name) && (row.enabled || row.trust?.status === 'approved')
    ))) return;
    const result = this.configStore.update((document) => ({ ...document,
      mcp_servers: document.mcp_servers.map((row) => drifted.has(row.name) ? {
        ...projectServerConfig(row), enabled: false,
        trust: pendingTrust(row, row.trust?.advertised_tools_digest),
      } : row),
    }));
    if (result.ok) this.log('WARN', 'mcp.trust.tool_surface_changed', {
      server_count: drifted.size,
    });
  }

  async createServer(payload = {}) {
    const normalized = normalizedServerConfig(payload.server || payload);
    if (!normalized.ok) return structuredError(normalized.reason, 'The MCP server definition is invalid.');
    const existing = this._loadConfig().mcp_servers.some((row) => row.name === normalized.value.name);
    if (existing) return structuredError('duplicate_server_identity', 'An MCP server with that name already exists.');
    const result = this.configStore.update((document) => ({ ...document,
      mcp_servers: [...document.mcp_servers, {
        ...normalized.value, enabled: false, trust: pendingTrust(normalized.value),
      }],
    }));
    return this._afterMutation(result, 'mcp_server_created');
  }

  async updateServer(payload = {}) {
    const name = String(payload.name || '').trim();
    const rows = this._loadConfig().mcp_servers;
    const index = rows.findIndex((row) => row.name === name);
    if (index === -1) return structuredError('server_not_found', 'The MCP server was not found.');
    const update = payload.server || payload.value || {};
    const previous = rows[index];
    const merged = { ...update,
      init_timeout_seconds: update.init_timeout_seconds === undefined
        ? previous.init_timeout_seconds : update.init_timeout_seconds,
    };
    // The editor does not carry the hand-edited row extensions; an edit keeps
    // them unless it sets them or moves the row off stdio (stdio-only keys).
    const staysStdio = String(update.transport || 'stdio').trim().toLowerCase() === 'stdio';
    for (const key of ['inspect_timeout_seconds', 'read_only_auto_allow', 'env', 'memory_limit_mb',
      'max_processes', 'request_timeout_seconds']) {
      if (update[key] === undefined && previous[key] !== undefined
        && (staysStdio || key === 'inspect_timeout_seconds' || key === 'read_only_auto_allow')) {
        merged[key] = previous[key];
      }
    }
    const auth = update.auth === undefined ? previous.auth : update.auth;
    if (isPlainObject(auth)) {
      // A stored credential only follows an edit to the same destination: a new
      // auth kind, URL origin or token URL must be re-entered, never re-sent.
      const origin = (value) => { try { return new URL(String(value || '')).origin; } catch (_error) { return ''; } };
      const sameDestination = auth.kind === previous.auth?.kind
        && origin(merged.url ?? previous.url) === origin(previous.url)
        && (auth.token_url ?? previous.auth?.token_url) === previous.auth?.token_url;
      merged.auth = sameDestination ? { ...previous.auth, ...auth } : { ...auth };
      if (!sameDestination) delete merged.auth.secret_ref;
    } else if (update.auth !== undefined) merged.auth = update.auth;
    const normalized = normalizedServerConfig(merged);
    if (!name || !normalized.ok) return structuredError(normalized.reason || 'invalid_server_name', 'The MCP server definition is invalid.');
    if (rows.some((row, rowIndex) => rowIndex !== index && row.name === normalized.value.name)) {
      return structuredError('duplicate_server_identity', 'An MCP server with that name already exists.');
    }
    this._cancelInspection(name);
    if (normalized.value.name !== name) this._cancelInspection(normalized.value.name);
    const result = this.configStore.update((document) => ({ ...document,
      mcp_servers: document.mcp_servers.map((row) => row.name === name ? {
        ...normalized.value, enabled: false, trust: pendingTrust(normalized.value),
      } : row),
    }));
    this.lastInspections.delete(name);
    this.readiness.delete(name);
    return this._afterMutation(result, 'mcp_server_updated');
  }

  async removeServer(payload = {}) {
    const name = String(payload.name || payload.serverName || '').trim();
    if (!name) return structuredError('invalid_server_name', 'A server name is required.');
    if (!this._loadConfig().mcp_servers.some((row) => row.name === name)) {
      return structuredError('server_not_found', 'The MCP server was not found.');
    }
    this._cancelInspection(name);
    const result = this.configStore.update((document) => ({ ...document,
      mcp_servers: document.mcp_servers.filter((row) => row.name !== name),
    }));
    this.lastInspections.delete(name);
    this.readiness.delete(name);
    return this._afterMutation(result, 'mcp_server_removed');
  }

  async checkReadiness({ name } = {}) {
    const server = this._loadConfig().mcp_servers.find((row) => row.name === name);
    if (!readinessProbeLaunch(server)) {
      return structuredError('readiness_unavailable', 'This connection has no readiness check.');
    }
    const digest = configurationDigest(server);
    const inspection = this.lastInspections.get(name);
    if (server.trust?.status !== 'approved' && inspection?.configurationDigest !== digest) {
      return structuredError('readiness_unconsented', 'Test the connection first.');
    }
    const readiness = await this.readinessProbe({ server: projectServerConfig(server) });
    // A row edited or re-created while the probe ran keeps no result from the old command.
    const current = this._loadConfig().mcp_servers.find((row) => row.name === name);
    if (current && configurationDigest(current) === digest) this.readiness.set(name, readiness);
    this.log('INFO', 'mcp.readiness.checked', { server_name: name,
      healthy: readiness.healthy, reason: readiness.reason });
    return { ok: true, readiness };
  }

  async getPrompt(payload = {}) {
    const client = this.backendService?.sidecarClient;
    if (!client?.connected || typeof client.request !== 'function') {
      return structuredError('sidecar_unavailable', 'The local runtime is unavailable.');
    }
    const { name, prompt, arguments: args } = payload || {};
    const server = this._loadConfig().mcp_servers.find((row) => row.name === name);
    if (name !== BUILTIN_SERVER.name && !server) {
      return structuredError('server_not_found', 'The MCP server was not found.');
    }
    if (name === BUILTIN_SERVER.name || server.enabled !== true) {
      return structuredError('server_disabled', 'The MCP server is disabled.');
    }
    if (server.trust?.status !== 'approved' || server.trust.configuration_digest !== configurationDigest(server)) {
      return structuredError('not_approved', 'Approve this MCP server configuration first.');
    }
    const definition = approvedPrompts(server).find((row) => row.name === prompt);
    if (!definition) return structuredError('prompt_unknown', 'The prompt is not approved.');
    if (!isPlainObject(args) || ![Object.prototype, null].includes(Object.getPrototypeOf(args))) {
      return structuredError('argument_invalid', 'Prompt arguments must be an object.');
    }
    for (const [argument, value] of Object.entries(args)) {
      if (!definition.arguments.some((row) => row.name === argument)
        || typeof value !== 'string' || value.length > 4096) {
        const error = structuredError('argument_invalid', 'A prompt argument is invalid.');
        error.error.argument = argument.slice(0, 64);
        return error;
      }
    }
    for (const argument of definition.arguments) {
      if (argument.required && (!Object.hasOwn(args, argument.name) || !args[argument.name].trim())) {
        const error = structuredError('argument_missing', 'A required prompt argument is missing.');
        error.error.argument = argument.name;
        return error;
      }
    }
    let reason = 'request_failed';
    try {
      const result = await client.request('mcp.prompt_get', {
        accept_version: require('./backend/sidecar-client').API_VERSION,
        server: name, name: prompt, arguments: args,
      }, { timeoutMs: (server.request_timeout_seconds || 60) * 1000 + 5000 });
      if (result?.ok === true && typeof result.text === 'string') {
        const text = result.text.slice(0, 16000);
        const chars = Number.isInteger(result.chars) && result.chars >= 0 ? result.chars : text.length;
        return { ok: true, server: name, prompt, text, chars };
      }
      const allowed = ['params_invalid', 'mcp_unavailable', 'prompt_failed', 'prompt_cancelled',
        'prompt_content_unsupported', 'prompt_result_invalid', 'too_many_prompts'];
      if (result?.ok === true) reason = 'prompt_result_invalid';
      else reason = allowed.includes(result?.failure?.reason) ? result.failure.reason : 'failed';
    } catch (_error) { /* Request failures expose no transport diagnostics. */ }
    this.log('WARN', 'mcp.prompt.failed', { server_name: name, prompt, reason });
    const error = structuredError('prompt_unavailable', 'The prompt could not be fetched.');
    error.error.reason = reason;
    return error;
  }

  async testServer(payload = {}) {
    const name = String(payload.name || payload.serverName || '').trim();
    this.lastInspections.delete(name);
    const config = this._loadConfig();
    const server = config.mcp_servers.find((row) => row.name === name);
    if (!server) return structuredError('server_not_found', 'The MCP server was not found.');
    // An explicit Test is the user's consent to one inspection connection, so
    // the document gate does not apply here. It is turned on when an approved
    // SSE server is enabled (D2) and governs live registration; requiring it
    // here would block the first approval.
    const client = this.backendService?.sidecarClient;
    if (!client?.connected || typeof client.request !== 'function') {
      return structuredError('sidecar_unavailable', 'MCP inspection is unavailable until the local runtime is ready.');
    }
    if (server.transport === 'stdio' && payload.confirmed !== true) {
      return { ok: false, confirmation_required: true, command: server.command, args: [...server.args] };
    }
    this._cancelInspection(name);
    const controller = new AbortController();
    this.inspectionControllers.set(name, controller);
    try {
      const inspectionServer = projectServerConfig(server);
      const secretRef = String(inspectionServer.auth?.secret_ref || '').trim();
      if (secretRef) {
        const secureStore = this._secureStore();
        try {
          const secret = secureStore?.getMcpAuthToken?.(secretRef) || '';
          if (secret) inspectionServer.auth = {
            ...inspectionServer.auth,
            ...(inspectionServer.auth.kind === 'oauth_client_credentials'
              ? { client_secret: secret } : { token: secret }),
          };
        } catch (_error) { /* probe will return a sanitized auth failure */ }
      }
      const result = await client.request('mcp.inspect', {
        accept_version: require('./backend/sidecar-client').API_VERSION,
        server: inspectionServer,
        mcp_sse_enabled: true,
        confirmed_stdio: server.transport !== 'stdio' || payload.confirmed === true,
      }, { timeoutMs: (server.inspect_timeout_seconds || 15) * 1000 + 5000, signal: controller.signal });
      if (!result?.ok || !/^[a-f0-9]{64}$/.test(String(result.tools_digest || ''))) return result;
      const promptsDigest = String(result.prompts_digest || '');
      const validPromptsDigest = promptsDigest === '' || /^[a-f0-9]{64}$/.test(promptsDigest);
      const prompts = normalizePrompts(result.prompts);
      this.lastInspections.set(name, {
        configurationDigest: configurationDigest(server),
        toolsDigest: result.tools_digest,
        promptsDigest: validPromptsDigest ? promptsDigest : '',
        prompts: validPromptsDigest && prompts.ok ? prompts.value : [],
      });
      if (readinessProbeLaunch(server)) {
        // The readiness result is advisory: a probe failure never undoes a successful Test.
        try { await this.checkReadiness({ name }); } catch (error) {
          this.log('WARN', 'mcp.readiness.failed', { server_name: name, error_name: error?.name || 'Error' });
        }
      }
      return result;
    } catch (error) {
      this.log('WARN', 'mcp.inspect.failed', { server_name: name, error_name: error?.name || 'Error' });
      return structuredError('inspect_unavailable', 'MCP inspection did not complete.');
    } finally {
      if (this.inspectionControllers.get(name) === controller) {
        this.inspectionControllers.delete(name);
      }
    }
  }

  _cancelInspection(name) {
    const controller = this.inspectionControllers.get(name);
    if (!controller) return false;
    this.inspectionControllers.delete(name);
    controller.abort(new Error('MCP inspection cancelled.'));
    return true;
  }

  dispose() {
    for (const name of [...this.inspectionControllers.keys()]) this._cancelInspection(name);
    this.lastInspections.clear();
  }

  async approveServer(payload = {}) {
    const name = String(payload.name || payload.serverName || '').trim();
    const inspected = this.lastInspections.get(name);
    const server = this._loadConfig().mcp_servers.find((row) => row.name === name);
    if (!server || !inspected || inspected.configurationDigest !== configurationDigest(server)) {
      return structuredError('inspection_required', 'Test this exact server configuration before approving it.');
    }
    const result = this.configStore.update((document) => ({ ...document,
      mcp_servers: document.mcp_servers.map((row) => row.name === name ? { ...row,
        enabled: false,
        prompts: inspected.prompts?.length ? inspected.prompts : undefined,
        trust: { status: 'approved', configuration_digest: inspected.configurationDigest,
          advertised_tools_digest: inspected.toolsDigest, advertised_prompts_digest: inspected.promptsDigest,
          reviewed_at: this.now() },
      } : row),
    }));
    return this._afterMutation(result, 'mcp_server_approved');
  }

  async setServerEnabled(payload = {}) {
    const name = String(payload.name || payload.serverName || '').trim();
    const enabled = payload.enabled === true;
    const server = this._loadConfig().mcp_servers.find((row) => row.name === name);
    if (!server) return structuredError('server_not_found', 'The MCP server was not found.');
    if (enabled && server.trust?.status !== 'approved') {
      return structuredError('trust_review_required', 'Approve the discovered MCP tool surface before enabling this server.');
    }
    const result = this.configStore.update((document) => ({ ...document,
      mcp_sse_enabled: document.mcp_sse_enabled || (enabled && server.transport === 'sse'),
      mcp_servers: document.mcp_servers.map((row) => row.name === name ? { ...row, enabled } : row),
    }));
    return this._afterMutation(result, enabled ? 'mcp_server_enabled' : 'mcp_server_disabled');
  }

  async _afterMutation(result, reason) {
    if (!result.ok) return structuredError(result.reason || 'write_failed', 'The MCP configuration was not changed.');
    if (this.backendService && typeof this.backendService.refreshManagedConfig === 'function') {
      try { await this.backendService.refreshManagedConfig(reason); } catch (error) {
        this.log('WARN', 'mcp.config.runtime_refresh_failed', { reason, error_name: error?.name || 'Error' });
        return { ...structuredError(MCP_ERROR_CODES.SERVER_FAILED,
          'The MCP configuration was saved, but application is pending. The previous runtime configuration may still be active.'),
          saved: true, runtimeApplied: false, state: this.getState() };
      }
    }
    return { ok: true, state: this.getState() };
  }

  // --- mcpAuth: SECURITY-load-bearing. Every method below must return only
  // presence booleans / non-secret refs to the renderer. Never call
  // `secureStore.getMcpAuthToken` from here (or anywhere on a renderer-facing
  // path) — only `hasMcpAuthToken` (presence-only) is used.

  _secureStore() {
    return this.backendService?.secureStore || null;
  }

  _mcpAuthServerRows() {
    const config = this._loadConfig();
    return config.mcp_servers.map((server) => ({
      name: server.name,
      hasAuthBlock: Boolean(isPlainObject(server.auth)),
      kind: isPlainObject(server.auth) ? (String(server.auth.kind || '').trim() || 'bearer') : '',
      secretRef: isPlainObject(server.auth) ? String(server.auth.secret_ref || '').trim() || null : null,
    }));
  }

  async getMcpAuthStatus() {
    const secureStore = this._secureStore();
    const store = secureStore && typeof secureStore.getStatus === 'function'
      ? secureStore.getStatus()
      : { status: 'unavailable', recoveryTitle: '', recoveryHint: '' };
    // Only probe presence when the store reports ready: hasMcpAuthToken
    // throws via _assertAppReady while safeStorage is not ready, whereas
    // this status payload must degrade to disabled-editor + recoveryHint.
    const storeReady = store && store.status === 'ready';
    const servers = this._mcpAuthServerRows().map((row) => {
      const configured = Boolean(
        storeReady
        && row.secretRef
        && secureStore
        && typeof secureStore.hasMcpAuthToken === 'function'
        && secureStore.hasMcpAuthToken(row.secretRef)
      );
      return {
        name: row.name,
        hasAuthBlock: row.hasAuthBlock,
        kind: row.kind,
        secretRef: row.secretRef,
        configured,
      };
    });
    return {
      loaded: true,
      store: {
        status: String(store.status || 'unavailable'),
        recoveryTitle: String(store.recoveryTitle || ''),
        recoveryHint: String(store.recoveryHint || ''),
      },
      servers,
    };
  }

  // Read-modify-write backfill of `secret_ref: "mcp:<serverName>"` into a
  // server's existing `auth` block ONLY — never writes `token` /
  // `client_secret`, never touches any other key in the file. Returns the
  // resolved secretRef, or throws if the server/auth block cannot be found
  // (caller has already validated presence before calling this).
  _backfillSecretRef(serverName) {
    const server = this._loadConfig().mcp_servers.find((entry) => entry.name === serverName);
    if (!server || !isPlainObject(server.auth)) {
      throw new Error('mcpAuth: server auth block not found for backfill.');
    }
    const secretRef = mcpAuthSecretRef(serverName);
    const result = this.configStore.update((document) => ({ ...document,
      mcp_servers: document.mcp_servers.map((entry) => entry.name === serverName ? {
        ...projectServerConfig(entry), enabled: false,
        auth: { ...entry.auth, secret_ref: secretRef },
        trust: pendingTrust({ ...entry, auth: { ...entry.auth, secret_ref: secretRef } }),
      } : entry),
    }));
    if (!result.ok) throw new Error('mcpAuth: secret reference backfill failed.');
    return secretRef;
  }

  async setMcpAuthToken({ serverName, value } = {}) {
    const name = String(serverName || '').trim();
    const textValue = String(value || '').trim();
    if (!name) {
      return structuredError('invalid_server_name', 'A server name is required.');
    }
    if (!textValue) {
      return structuredError('invalid_value', 'A non-empty secret value is required.');
    }
    const row = this._mcpAuthServerRows().find((entry) => entry.name === name);
    if (!row || !row.hasAuthBlock) {
      return structuredError('no_auth_block', `Server "${name}" has no auth block configured.`);
    }
    const secureStore = this._secureStore();
    if (!secureStore || typeof secureStore.setMcpAuthToken !== 'function') {
      return structuredError('unavailable', 'MCP auth is unavailable.');
    }
    let secretRef = row.secretRef;
    if (!secretRef) {
      secretRef = this._backfillSecretRef(name);
    }
    secureStore.setMcpAuthToken(secretRef, textValue);
    if (this.backendService && typeof this.backendService.refreshManagedConfig === 'function') {
      try {
        await this.backendService.refreshManagedConfig('mcp_auth_token_updated');
      } catch (error) {
        try {
          console.warn('mcpAuth.set: managed config refresh failed after token save.', {
            serverName: name,
            errorName: error?.name || 'Error',
          });
        } catch (_logError) {
          void _logError;
        }
      }
    }
    const status = await this.getMcpAuthStatus();
    return { ok: true, ...status };
  }

  async deleteMcpAuthToken({ serverName } = {}) {
    const name = String(serverName || '').trim();
    if (!name) {
      return structuredError('invalid_server_name', 'A server name is required.');
    }
    const row = this._mcpAuthServerRows().find((entry) => entry.name === name);
    if (!row || !row.secretRef) {
      const status = await this.getMcpAuthStatus();
      return { ok: true, ...status };
    }
    const secureStore = this._secureStore();
    if (!secureStore || typeof secureStore.deleteMcpAuthToken !== 'function') {
      return structuredError('unavailable', 'MCP auth is unavailable.');
    }
    secureStore.deleteMcpAuthToken(row.secretRef);
    if (this.backendService && typeof this.backendService.refreshManagedConfig === 'function') {
      try {
        await this.backendService.refreshManagedConfig('mcp_auth_token_updated');
      } catch (error) {
        try {
          console.warn('mcpAuth.delete: managed config refresh failed after token delete.', {
            serverName: name,
            errorName: error?.name || 'Error',
          });
        } catch (_logError) {
          void _logError;
        }
      }
    }
    const status = await this.getMcpAuthStatus();
    return { ok: true, ...status };
  }
}

module.exports = {
  McpDiscoveryService,
  buildDiscoveryState,
};
