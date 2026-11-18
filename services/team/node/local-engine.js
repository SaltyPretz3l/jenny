'use strict';

// The engine a shared GPU forwards to (row 123 slice 4e; spec "Node side (N9)"): this PC's
// own local engine, read from the member's backend each time it is asked. Answers
// { url, kind, key } or null when this PC offers nothing:
// - a team model is selected (its endpoint is the team's own port: forwarding there would
//   send the team's requests back to the team), or the endpoint is the team engine port;
// - a hosted endpoint (the headless host composition) or an engine that is not local;
// - an Ollama daemon on another machine (only a loopback host is taken);
// - a managed llama-server or NInfer that is not ready;
// - an engine type with no OpenAI-compatible endpoint (mock, API providers).
// `kind` names the engine in the Offers line: 'llama-server', 'NInfer', 'Ollama' or 'local'
// (a member's own OpenAI-compatible server). `key` is a managed server's per-launch key, sent
// only to that server's own loopback origin (managed-server-owner.js), never logged, never
// answered to the renderer. The agent still checks the URL itself (loopback only), and an
// Ollama cloud model is never offered or forwarded (engine-forward.js).

const OWNER_KINDS = Object.freeze({ 'llama-server': 'llama-server', ninfer: 'NInfer' });
const DEFAULT_OLLAMA_PORT = 11434;
const LOOPBACK_HOSTS = Object.freeze({ '127.0.0.1': '127.0.0.1', localhost: 'localhost', '::1': '[::1]', '[::1]': '[::1]' });

// The backend reads, loaded on first use (the backend modules are heavy) and replaceable in tests.
const DEFAULT_READERS = Object.freeze({
  teamSelection: (backend) => require('../../backend/team-engine-models').liveTeamSelection(backend),
  hostedEndpoint: (backend) => require('../../backend/managed-sidecar-config-readers').getHostedModelEndpoint(backend),
  apiUrl: (backend) => require('../../backend/managed-sidecar-config-model').resolveOpenAICompatibleApiUrl(backend),
  owner: (backend, url) => require('../../backend/managed-server-owner').resolveManagedServerOwner(backend, url),
  ownerKey: (backend, url) => require('../../backend/managed-server-owner').managedServerApiKey(backend, url),
});

function safely(fn) {
  try { return fn(); } catch (_error) { return null; }
}

function resolveLocalEngine(backend, readers = DEFAULT_READERS) {
  if (!backend || typeof backend !== 'object') return null;
  if (safely(() => readers.teamSelection(backend))) return null;
  if (safely(() => readers.hostedEndpoint(backend))) return null;
  const engineType = String(backend.currentEngineType || '').trim().toLowerCase();
  if (engineType === 'ollama') {
    const ollama = backend.ollamaManager || {};
    const host = ollama._host === undefined || ollama._host === null || ollama._host === '' ? '127.0.0.1' : String(ollama._host);
    if (!Object.hasOwn(LOOPBACK_HOSTS, host)) return null;
    const port = Number.isSafeInteger(Number(ollama._port)) && Number(ollama._port) > 0 && Number(ollama._port) <= 65535
      ? Number(ollama._port) : DEFAULT_OLLAMA_PORT;
    return { url: `http://${LOOPBACK_HOSTS[host]}:${port}/v1`, kind: 'Ollama', key: '' };
  }
  if (engineType !== 'openai-compatible') return null;
  const url = safely(() => readers.apiUrl(backend));
  if (typeof url !== 'string' || !url) return null;
  const owner = safely(() => readers.owner(backend, url));
  if (owner?.kind === 'team-engine') return null;
  if (owner && owner.status?.state !== 'ready') return null;
  const key = owner ? String(safely(() => readers.ownerKey(backend, url)) || '') : '';
  return { url, kind: OWNER_KINDS[owner?.kind] || 'local', key };
}

// What each local model can do, from the member's own model list (the sidecar reads Ollama's capabilities and a
// managed server's flags; the TTL cache answers repeat reads): a Map of model name to `{ vision, thinking }`, or null
// when the list cannot be read. The node agent merges it into the rows it registers; the engine's `/v1/models` says
// neither. Only the engine a shared GPU forwards to is read.
async function readModelCapabilities(backend, list = (service, engineType) => require('../../backend/backend-model-list')
  .listModelsForEngine(service, engineType)) {
  if (!backend || typeof backend !== 'object') return null;
  const engineType = String(backend.currentEngineType || '').trim().toLowerCase();
  if (!engineType) return null;
  let answer;
  try { answer = await list(backend, engineType); } catch (_error) { return null; }
  if (!answer || !Array.isArray(answer.data)) return null;
  const capabilities = new Map();
  for (const entry of answer.data) {
    const name = entry && typeof entry.id === 'string' ? entry.id : '';
    const caps = entry && entry.capabilities && typeof entry.capabilities === 'object' ? entry.capabilities : null;
    if (!name || !caps || capabilities.has(name)) continue;
    capabilities.set(name, { vision: caps.vision === true, thinking: caps.thinking === true });
  }
  return capabilities;
}

module.exports = { DEFAULT_READERS, readModelCapabilities, resolveLocalEngine };
