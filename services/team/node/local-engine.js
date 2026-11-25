'use strict';

// The engine a shared GPU forwards to (row 123 slice 4e; spec "Node side (N9)"): this PC's
// own local engine, read from the member's backend each time it is asked. Answers
// { url, kind, key } or null when this PC offers nothing. Which engine the owner's chat uses
// does not matter (row 201, OD-3): while the chat runs on a cloud engine (ChatGPT, an API
// provider, the Codex CLI) or a team model, the configured local engine is still shared, in
// this order: a ready NInfer, a ready llama-server, Ollama when Jenny runs or ran it, the
// configured local endpoint. Never the team's own port (forwarding there would send the team's
// requests back to the team). Nothing is offered when:
// - a hosted endpoint (the headless host composition) or an engine that is not local;
// - an Ollama daemon on another machine (only a loopback host is taken);
// - a managed llama-server or NInfer that is not ready;
// - an engine type with no OpenAI-compatible endpoint (mock, API providers).
// `kind` names the engine in the Offers line: 'llama-server', 'NInfer', 'Ollama' or 'local'
// (a member's own OpenAI-compatible server). `key` is a managed server's per-launch key, sent
// only to that server's own loopback origin (managed-server-owner.js), never logged, never
// answered to the renderer. The agent still checks the URL itself (loopback only), and an
// Ollama cloud model is never offered or forwarded (engine-forward.js).

const { createOllamaContextReader } = require('./ollama-context');

const OWNER_KINDS = Object.freeze({ 'llama-server': 'llama-server', ninfer: 'NInfer' });
// The engines a chat can run on besides this PC's own (model-size-class.js CLOUD_ENGINE_TYPES, restated).
const CLOUD_PRIMARIES = new Set(['chatgpt', 'codex-cli', 'api-provider']);
const DEFAULT_OLLAMA_PORT = 11434;
const defaultContextReader = createOllamaContextReader();
const LOOPBACK_HOSTS = Object.freeze({ '127.0.0.1': '127.0.0.1', localhost: 'localhost', '::1': '[::1]', '[::1]': '[::1]' });

// The backend reads, loaded on first use (the backend modules are heavy) and replaceable in tests.
const DEFAULT_READERS = Object.freeze({
  teamSelection: (backend) => require('../../backend/team-engine-models').liveTeamSelection(backend),
  hostedEndpoint: (backend) => require('../../backend/managed-sidecar-config-readers').getHostedModelEndpoint(backend),
  apiUrl: (backend) => require('../../backend/managed-sidecar-config-model').resolveOpenAICompatibleApiUrl(backend),
  owner: (backend, url) => require('../../backend/managed-server-owner').resolveManagedServerOwner(backend, url),
  ownerKey: (backend, url) => require('../../backend/managed-server-owner').managedServerApiKey(backend, url),
  // The managed server that is ready (NInfer first), as { url, kind, key }, whatever the owner's chat uses.
  managedLocal: (backend) => {
    const owners = require('../../backend/managed-server-owner');
    const candidates = [owners.ninferManagedOrigin(backend), String(backend.options?.getLlamaServerManager?.()?.getBaseUrl?.() || '')];
    for (const url of candidates) {
      const owner = url ? owners.resolveManagedServerOwner(backend, url) : null;
      if (owner && OWNER_KINDS[owner.kind] && owner.status?.state === 'ready') {
        return { url, kind: OWNER_KINDS[owner.kind], key: String(owners.managedServerApiKey(backend, url) || '') };
      }
    }
    return null;
  },
  // The configured local endpoint, with no team port or NInfer in front of it.
  configuredUrl: (backend) => {
    const state = require('../../backend/managed-sidecar-config-readers').getConfiguredLocalOpenAICompatibleState(backend);
    const explicit = typeof state?.apiUrl === 'string' ? state.apiUrl.trim() : '';
    if (explicit) return explicit;
    const port = Number(state?.port);
    return Number.isFinite(port) && port > 0 ? `http://127.0.0.1:${Math.trunc(port)}` : '';
  },
  // Whether Jenny runs, or ran, an Ollama daemon on this PC (the manager's own residue check).
  ollamaInUse: (backend) => backend.ollamaManager?.mightHaveLocalOllamaResidue?.() === true,
  // Whether a cloud primary also runs a local helper server for its delegate children (backend/local-subagent-engine.js).
  localHelper: (backend) => require('../../backend/local-subagent-engine').localSubagentEngineApplies(backend),
});

function safely(fn) {
  try { return fn(); } catch (_error) { return null; }
}

function ollamaEngine(backend) {
  const ollama = backend.ollamaManager || {};
  const host = ollama._host === undefined || ollama._host === null || ollama._host === '' ? '127.0.0.1' : String(ollama._host);
  if (!Object.hasOwn(LOOPBACK_HOSTS, host)) return null;
  const port = Number.isSafeInteger(Number(ollama._port)) && Number(ollama._port) > 0 && Number(ollama._port) <= 65535
    ? Number(ollama._port) : DEFAULT_OLLAMA_PORT;
  return { url: `http://${LOOPBACK_HOSTS[host]}:${port}/v1`, kind: 'Ollama', key: '' };
}

// The local engine of an owner whose chat runs elsewhere (a cloud engine or a team model).
function configuredLocalEngine(backend, readers) {
  const managed = safely(() => readers.managedLocal(backend));
  if (managed?.url) return managed;
  if (safely(() => readers.ollamaInUse(backend))) return ollamaEngine(backend);
  const url = safely(() => readers.configuredUrl(backend));
  // A managed server that is not ready offers nothing.
  if (typeof url !== 'string' || !url || safely(() => readers.owner(backend, url))) return null;
  return { url, kind: 'local', key: '' };
}

function resolveLocalEngine(backend, readers = DEFAULT_READERS) {
  if (!backend || typeof backend !== 'object') return null;
  if (safely(() => readers.hostedEndpoint(backend))) return null;
  const engineType = String(backend.currentEngineType || '').trim().toLowerCase();
  const onTeam = Boolean(safely(() => readers.teamSelection(backend)));
  if (onTeam || CLOUD_PRIMARIES.has(engineType)) return configuredLocalEngine(backend, readers);
  if (engineType === 'ollama') return ollamaEngine(backend);
  if (engineType !== 'openai-compatible') return null;
  const url = safely(() => readers.apiUrl(backend));
  if (typeof url !== 'string' || !url) return null;
  const owner = safely(() => readers.owner(backend, url));
  if (owner?.kind === 'team-engine') return null;
  if (owner && owner.status?.state !== 'ready') return null;
  const key = owner ? String(safely(() => readers.ownerKey(backend, url)) || '') : '';
  return { url, kind: OWNER_KINDS[owner?.kind] || 'local', key };
}

// True while the owner's running chat could be using this PC's engine; the caller already knows a chat stream runs. A chat
// on a cloud engine or on a team model leaves the local GPU free (OD-3), unless a cloud primary also runs a local helper
// server for its delegate children. An unreadable backend or an engine this module does not know counts as busy.
function ownInferenceUsesLocalEngine(backend, readers = DEFAULT_READERS) {
  if (!backend || typeof backend !== 'object') return true;
  const engineType = String(backend.currentEngineType || '').trim().toLowerCase();
  if (safely(() => readers.teamSelection(backend))) return false;
  if (CLOUD_PRIMARIES.has(engineType)) return safely(() => readers.localHelper(backend)) !== false;
  return true;
}

// What each local model can do, from the member's own model list (the sidecar reads Ollama's capabilities and a
// managed server's flags; the TTL cache answers repeat reads): a Map of model name to `{ vision, thinking }` and, when
// the engine's own list or (Ollama) its `/api/show` says it, `context_length`, or null when the list cannot be read. The
// node agent merges it into the rows it registers; the engine's `/v1/models` says neither (and, on Ollama, no length). Only the engine a shared GPU forwards to is read: `forEngine` names it ('ollama' or 'openai-compatible') when
// the owner's current engine is not it (a cloud chat, a team model), else the current engine is read.
async function readModelCapabilities(backend, list = (service, engineType) => require('../../backend/backend-model-list')
  .listModelsForEngine(service, engineType), forEngine = '', contextOf = defaultContextReader) {
  if (!backend || typeof backend !== 'object') return null;
  const engineType = String(forEngine || backend.currentEngineType || '').trim().toLowerCase();
  if (!engineType) return null;
  let answer;
  try { answer = await list(backend, engineType); } catch (_error) { return null; }
  if (!answer || !Array.isArray(answer.data)) return null;
  const capabilities = new Map();
  const asking = [];
  for (const entry of answer.data) {
    const name = entry && typeof entry.id === 'string' ? entry.id : '';
    const caps = entry && entry.capabilities && typeof entry.capabilities === 'object' ? entry.capabilities : null;
    const own = Number.isSafeInteger(entry?.context_length) && entry.context_length > 0 ? entry.context_length : null;
    if (!name || capabilities.has(name) || (!caps && own === null)) continue;
    const row = { vision: caps?.vision === true, thinking: caps?.thinking === true };
    if (own !== null) row.context_length = own;
    capabilities.set(name, row);
    if (own === null && engineType === 'ollama') asking.push([row, name, typeof entry.digest === 'string' ? entry.digest : '']);
  }
  // Ollama's list carries no context length: one bounded `/api/show` per model, cached by name and digest.
  const daemon = asking.length > 0 ? ollamaEngine(backend) : null;
  if (daemon) {
    const { hostname, port } = new URL(daemon.url);
    await Promise.all(asking.map(async ([row, name, digest]) => {
      const length = await Promise.resolve(contextOf(hostname.replace(/^\[|\]$/gu, ''), Number(port), name, digest)).catch(() => null);
      if (Number.isSafeInteger(length) && length > 0) row.context_length = length;
    }));
  }
  return capabilities;
}

module.exports = { DEFAULT_READERS, ownInferenceUsesLocalEngine, readModelCapabilities, resolveLocalEngine };
