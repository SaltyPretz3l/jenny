const {
  McpConfigStore,
  configurationDigest,
  normalizedServerConfig,
  pendingTrust,
} = require('./mcp-config-store');
const { MCP_ERROR_CODES } = require('./backend/error-codes');

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

// Non-secret auth shape forwarded downstream. `secret_ref` is an opaque
// pointer into safeStorage (or similar); the actual bearer token / client
// secret is resolved later (MCP HTTP Transport Step 5) and is NEVER read
// from mcp-servers.json here. If the on-disk config carries a literal
// `token` or `client_secret`, it is intentionally dropped below.
function normalizeConfiguredServerAuth(value) {
  if (!isPlainObject(value)) {
    return null;
  }
  const kind = String(value.kind || '').trim().toLowerCase();
  const auth = {};
  if (kind) {
    auth.kind = kind;
  }
  const secretRef = String(value.secret_ref || '').trim();
  if (secretRef) {
    auth.secret_ref = secretRef;
  }
  const tokenUrl = String(value.token_url || '').trim();
  if (tokenUrl) {
    auth.token_url = tokenUrl;
  }
  const clientId = String(value.client_id || '').trim();
  if (clientId) {
    auth.client_id = clientId;
  }
  const scope = String(value.scope || '').trim();
  if (scope) {
    auth.scope = scope;
  }
  // SECURITY: `token` / `client_secret` are never copied from the on-disk
  // json into the forwarded shape, even if present in the source file.
  return Object.keys(auth).length ? auth : null;
}

function normalizeConfiguredServer(value) {
  if (!isPlainObject(value)) {
    return null;
  }
  const name = String(value.name || '').trim();
  if (!name) {
    return null;
  }
  const transport = normalizeTransport(value.transport);
  const row = {
    name,
    transport,
  };
  if (transport === 'stdio') {
    row.command = String(value.command || '').trim();
    row.args = Array.isArray(value.args)
      ? [...value.args]
      : [];
  }
  if (transport === 'sse' || transport === 'http') {
    row.url = String(value.url || '').trim();
    const initTimeoutSeconds = Number(value.init_timeout_seconds);
    if (Number.isFinite(initTimeoutSeconds) && initTimeoutSeconds > 0) {
      row.init_timeout_seconds = initTimeoutSeconds;
    }
    const auth = normalizeConfiguredServerAuth(value.auth);
    if (auth) {
      row.auth = auth;
    }
  }
  return row;
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
// carries `token` / `client_secret` (normalizeConfiguredServerAuth already
// stripped those upstream) and never resolves the secret value from
// secureStore here. `secretRef` is an opaque pointer only.
function summarizeServerAuth(auth) {
  if (!isPlainObject(auth)) {
    return null;
  }
  const kind = String(auth.kind || '').trim() || 'bearer';
  const secretRef = String(auth.secret_ref || '').trim() || null;
  return { kind, secretRef,
    token_url: String(auth.token_url || '').trim(), client_id: String(auth.client_id || '').trim(),
    scope: String(auth.scope || '').trim() };
}

function normalizeRuntimeServers(status = {}, configuredServers = []) {
  const seen = new Set();
  const rows = [];
  const runtimeRows = Array.isArray(status.mcp_servers) ? status.mcp_servers : [];
  const candidates = [BUILTIN_SERVER, ...configuredServers, ...runtimeRows];
  for (const entry of candidates) {
    const normalized = normalizeConfiguredServer(entry);
    if (!normalized || seen.has(normalized.name)) {
      continue;
    }
    seen.add(normalized.name);
    rows.push({
      name: normalized.name,
      transport: normalized.transport,
      url: normalized.url || '',
      command: normalized.command || '',
      args: Array.isArray(normalized.args) ? [...normalized.args] : [],
      auth: summarizeServerAuth(normalized.auth),
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
    return {
      name: server.name,
      transport: server.transport,
      status,
      toolsCount: toolCounts.get(server.name) || 0,
      failure,
      cooldown,
      url: server.url || '',
      command: server.command || '',
      args: server.args || [],
      auth: server.auth || null,
      enabled: configured?.enabled === true,
      trust: configured?.trust || null,
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
    this.inspectionControllers = new Map();
  }

  setBackendService(backendService) {
    this.backendService = backendService || null;
  }

  _loadConfig() {
    return this.configStore.getState().document;
  }

  // DECIDED gate design (MCP HTTP Transport Step 1): the Electron side only
  // forwards `mcp_sse_enabled: true` when BOTH the user config gate
  // (mcp-servers.json `mcp_sse_enabled`) AND the `mcp_http_transport`
  // internal flag are on. The sidecar's `_parse_mcp_servers` hard-raises
  // (CMP-MCP-0002) if an sse/http server arrives while its own single
  // `mcp_sse_enabled` gate is false, so the forwarding filter and the
  // forwarded gate value must move together — hence `effectiveSseEnabled`
  // is threaded into both the `isForwardableServer` filter and the
  // response's `mcp_sse_enabled`. Callers that omit `httpTransportEnabled`
  // (or pass false) get exactly today's no-flag behavior.
  getSidecarConfig({ httpTransportEnabled = false } = {}) {
    const config = this._loadConfig();
    const effectiveSseEnabled = config.mcp_sse_enabled === true && httpTransportEnabled === true;
    const effectiveConfig = { ...config, mcp_sse_enabled: effectiveSseEnabled };
    const supportedServers = config.mcp_servers.filter((server) =>
      server.enabled === true
      && server.trust?.status === 'approved'
      && server.trust.configuration_digest === configurationDigest(server)
      && isForwardableServer(server, effectiveConfig)
    );
    if (!supportedServers.length && effectiveSseEnabled !== true) {
      return {};
    }
    return {
      mcp_servers: supportedServers.map((server) => ({
        ...normalizeConfiguredServer(server),
        approved_tools_digest: server.trust.advertised_tools_digest,
      })),
      mcp_sse_enabled: effectiveSseEnabled,
    };
  }

  getState() {
    this._invalidateToolSurfaceDrift();
    const storeState = this.configStore.getState();
    const config = storeState.document;
    const backendStatus = this.backendService?.currentStatus || {};
    return buildDiscoveryState({
      backendStatus,
      configuredServers: config.mcp_servers,
      sseEnabled: config.mcp_sse_enabled === true,
      configStatus: storeState,
    });
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
        ...row, enabled: false,
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
    const normalized = normalizedServerConfig(payload.server || payload.value || {});
    if (!name || !normalized.ok) return structuredError(normalized.reason || 'invalid_server_name', 'The MCP server definition is invalid.');
    const rows = this._loadConfig().mcp_servers;
    const index = rows.findIndex((row) => row.name === name);
    if (index === -1) return structuredError('server_not_found', 'The MCP server was not found.');
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
    return this._afterMutation(result, 'mcp_server_removed');
  }

  async testServer(payload = {}) {
    const name = String(payload.name || payload.serverName || '').trim();
    this.lastInspections.delete(name);
    const server = this._loadConfig().mcp_servers.find((row) => row.name === name);
    if (!server) return structuredError('server_not_found', 'The MCP server was not found.');
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
      const inspectionServer = normalizeConfiguredServer(server);
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
        confirmed_stdio: server.transport !== 'stdio' || payload.confirmed === true,
      }, { timeoutMs: 20_000, signal: controller.signal });
      if (!result?.ok || !/^[a-f0-9]{64}$/.test(String(result.tools_digest || ''))) return result;
      this.lastInspections.set(name, {
        configurationDigest: configurationDigest(server),
        toolsDigest: result.tools_digest,
      });
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
        trust: { status: 'approved', configuration_digest: inspected.configurationDigest,
          advertised_tools_digest: inspected.toolsDigest, reviewed_at: this.now() },
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
      mcp_servers: document.mcp_servers.map((row) => row.name === name ? { ...row, enabled } : row),
    }));
    return this._afterMutation(result, enabled ? 'mcp_server_enabled' : 'mcp_server_disabled');
  }

  async _afterMutation(result, reason) {
    if (!result.ok) return structuredError(result.reason || 'write_failed', 'The MCP configuration was not changed.');
    if (this.backendService && typeof this.backendService.refreshManagedConfig === 'function') {
      try { await this.backendService.refreshManagedConfig(reason); } catch (error) {
        this.log('WARN', 'mcp.config.runtime_refresh_failed', { reason, error_name: error?.name || 'Error' });
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
        ...entry, enabled: false,
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
