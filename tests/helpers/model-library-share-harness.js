'use strict';

// Settings › Models with model sharing loaded (row 123, slice 6-7): the real Library section controller over the shared
// section harness, one library GGUF row (its discovery tag differs from its Library tag, so the path match is proven),
// an Ollama row, the real model store over a stubbed `jennyShell.team` whose every call is checked against main's real
// `validatePayload`, the share modules as page globals and a team store stub with the given teams.
// `openShare(t, options)` answers { h, store, push, calls, sent, answers, box, menuFor, row, rows, status, drawer, ... }.

const assert = require('node:assert/strict');
const { validatePayload } = require('../../services/team/ipc-methods');
const { normalizeLocalEngines } = require('../../services/shell-config-engines');
const { harness, flush, click } = require('./model-library-section-harness');

const TEAM = 'team_AAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'team_BBBBBBBBBBBBBBBBBBBBBB';
const DIR = 'D:\\models\\qwen';
const FILE = DIR + '\\Qwen3.8-27B-UD-Q6_K.gguf';
const LIB_TAG = 'qwen3.8-27b-ud-q6_k';
const LIB_KEY = 'qwen3-8-27b-ud-q6-k';
const CARD = LIB_TAG + ':latest';
const DISC = 'Qwen3.8-27B-UD-Q6_K';
const SHARE_GLOBALS = ['modelLibraryShareRows', 'modelLibraryShareSend', 'modelLibraryShareAccept', 'modelLibraryShareSection', 'rendererTeamModelStore', 'rendererTeamStore', 'rendererSettingsTeamStrings'];
const SHARE_MODULES = ['rows', 'send', 'accept', 'section'].map((n) => require.resolve(`../../renderer/shell/model-library/model-library-share-${n}`))
  .concat(require.resolve('../../renderer/team/renderer-team-model-store'));

const team = (team_id, over = {}) => ({ team_id, team_name: team_id === TEAM ? 'Studio' : 'Dot lab', state: 'online', member_state: 'active', role: 'member', ...over });
const transfer = (over = {}) => ({ transfer_id: 'mxfer_TX1aaaaaaaaaaaaaaaaaaa', member_id: 'member_maya', member_name: 'Maya', state: 'flowing', reason: null, queued: false,
  bytes_done: 400_000_000, bytes_total: 1_000_000_000, rate_bps: 2_000_000, ...over });
const outgoing = (over = {}) => ({ request_id: 'mreq_1', offer_id: 'offer_OUT1aaaaaaaaaaaaaaaaaa', tag: DISC, display_name: 'Qwen 27B', audience: 'member', member_id: 'member_maya',
  member_name: 'Maya', state: 'open', reason: null, files: 2, total_bytes: 1_000_000_000, read_done: 1_000_000_000, transfers: [], ...over });
const take = (over = {}) => ({ transfer_id: 'mxfer_TXINaaaaaaaaaaaaaaaaaa', state: 'pulling', reason: null, queued: false, bytes_done: 500_000_000, bytes_total: 2_000_000_000, rate_bps: 0, root_index: 0, ...over });
const incoming = (over = {}) => ({ offer_id: 'offer_IN1aaaaaaaaaaaaaaaaaaa', sender_member_id: 'member_arjun', sender_name: 'Arjun', audience: 'member', display_name: 'Bonsai 12B',
  files: 2, total_bytes: 2_000_000_000, state: 'open', reason: null, offered_at: new Date().toISOString(), transfer: null, ...over });
const stateAnswer = (over = {}) => ({ ok: true, sharing: 'on', sharing_reason: null, online: true, rate_mb_per_second: 0, outgoing: [], incoming: [], ...over });
const RECEIVERS = { ok: true, members: [{ member_id: 'member_owner', display_name: 'Brendan', role: 'owner', can_receive: true },
  { member_id: 'member_maya', display_name: 'Maya', role: 'member', can_receive: true },
  { member_id: 'member_tomas', display_name: 'Tomas', role: 'read_only', can_receive: false }] };
const FILES = { ok: true, tag: DISC, files: [{ name: 'Qwen3.8-27B-UD-Q6_K.gguf', size_bytes: 20_900_000_000, kind: 'model', required: true },
  { name: 'mtp-Qwen3.8-27B-Q4_0.gguf', size_bytes: 1_400_000_000, kind: 'drafter', required: false },
  { name: 'mmproj-Qwen3.8-27B-F16.gguf', size_bytes: 900_000_000, kind: 'vision', required: false }],
  provenance: { name: 'Qwen3.8-27B-UD-Q6_K', licence: 'apache-2.0', source_url: 'https://huggingface.co/unsloth/Qwen3.8-27B-GGUF' } };
const HASH = '9f2c41d7a0b35e18' + '6c0d94a7e2f1b8553a7e90c4d1f62b08e5a3c7719d4f0b26';
const offerRead = (over = {}, roots) => ({ ok: true, offer: { offer_id: 'offer_IN1aaaaaaaaaaaaaaaaaaa', sender_member_id: 'member_arjun', sender_name: 'Arjun', audience: 'member',
  display_name: 'Bonsai 12B', state: 'open', offered_at: new Date().toISOString(), total_bytes: 2_000_000_000,
  files: [{ name: 'Bonsai-12B-Q8_0.gguf', size_bytes: 1_900_000_000, sha256: HASH }, { name: 'mmproj-Bonsai-12B-F16.gguf', size_bytes: 100_000_000, sha256: HASH }],
  provenance: { licence: 'apache-2.0', source_url: 'https://example.invalid/bonsai', note: 'The Q8 I mentioned.' }, ...over },
roots: roots || [{ index: 0, display_path: 'D:\\models', free_bytes: 412_000_000_000, fits: true, exists: false },
  { index: 3, display_path: 'C:\\Users\\dot\\models', free_bytes: 900_000_000, fits: false, exists: false }] });

/**
 * options: { teams, answers (method -> value | fn), withShare (default true), state (modelState answer), contextMenu }
 */
async function openShare(t, options = {}) {
  for (const path of SHARE_MODULES) delete require.cache[path];
  const box = { teams: options.teams || [team(TEAM)] };
  const calls = [];
  const refused = [];
  const answers = { modelState: stateAnswer(), modelSendable: { ok: true, models: [{ tag: DISC, name: DISC, size_bytes: 1, sendable: true, reason: null }] },
    modelReceivers: RECEIVERS, modelFiles: FILES, modelProvenance: { ok: false, error: { code: 'CMP-TEAM-0011', reason: 'team_not_found' } }, modelOfferRead: offerRead(),
    ...(options.answers || {}) };
  const subscribers = new Set();
  const hidden = { count: 0 };
  const shown = [];
  const contextMenu = options.contextMenu || { show(config) { shown.push(config); }, hide() { hidden.count += 1; } };
  const saved = {};
  for (const key of SHARE_GLOBALS) saved[key] = globalThis[key];
  const h = harness(t, {
    state: {
      features: { featureFlags: { llama_server_acceleration: true, team: true } },
      localEngines: normalizeLocalEngines({ openaiCompatible: { managed: { enabled: true, perModel: { [LIB_KEY]: { engine: 'llama-server', tag: LIB_TAG, modelPath: FILE, mtp: { mode: 'off' } } } } } }),
      status: { model: '' }, offline: { preferredLocalModel: '' }, ui: { activeSettingsSection: 'models' },
    },
    llamaServer: { async listLocalGgufs() { return { ok: true, entries: [{ tag: DISC, source: 'library', dir: DIR, mainGguf: 'Qwen3.8-27B-UD-Q6_K.gguf', drafterGguf: '', sizeBytes: 20_900_000_000 }] }; } },
    inventoryContextMenu: contextMenu,
  });
  h.windowRef.jennyShell.team = new Proxy({}, {
    get(_target, name) {
      if (name === 'onModel') return (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); };
      return (payload) => {
        calls.push({ method: name, payload });
        if (!validatePayload(name, payload).ok) refused.push(name + ' ' + JSON.stringify(payload));
        const answer = Object.hasOwn(answers, name) ? answers[name] : { ok: true };
        return Promise.resolve(typeof answer === 'function' ? answer(payload) : answer);
      };
    },
  });
  const storeModule = require('../../renderer/team/renderer-team-model-store');
  const store = storeModule.createModelStore({ windowRef: h.windowRef, teams: () => box.teams });
  globalThis.rendererTeamStore = { getTeamStore: () => ({ snapshot: () => ({ teams: box.teams }) }) };
  globalThis.rendererTeamModelStore = { peekModelStore: () => store, eligibleTeams: storeModule.eligibleTeams };
  globalThis.rendererSettingsTeamStrings = require('../../renderer/shell/renderer-settings-team-strings');
  if (options.withShare !== false) {
    globalThis.modelLibraryShareRows = require(SHARE_MODULES[0]);
    globalThis.modelLibraryShareSend = require(SHARE_MODULES[1]);
    globalThis.modelLibraryShareAccept = require(SHARE_MODULES[2]);
    globalThis.modelLibraryShareSection = require(SHARE_MODULES[3]);
  } else {
    for (const key of ['modelLibraryShareRows', 'modelLibraryShareSend', 'modelLibraryShareAccept', 'modelLibraryShareSection']) delete globalThis[key];
  }
  const release = store.use();
  t.after(() => {
    release();
    store.dispose();
    for (const id of ['modelShareSendDrawer', 'modelShareAcceptDrawer']) h.document.getElementById(id)?.remove();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
    assert.deepEqual(refused, [], 'main would refuse these payloads');
  });
  h.controller.bind();
  await flush();
  await flush();
  const host = () => h.document.getElementById('modelLibrarySectionHost');
  const row = (key) => [...host().querySelectorAll('.mrow[data-model-key]')].find((el) => el.getAttribute('data-model-key') === key);
  const menuFor = (key) => { click(h.windowRef, row(key).querySelector('[data-model-card-action="menu"]')); return shown[shown.length - 1].items; };
  return {
    h, store, box, calls, answers, hidden, host, row, menuFor,
    push: (payload) => { for (const fn of [...subscribers]) fn({ team_id: TEAM, ...payload }); },
    sent: (method) => calls.filter((c) => c.method === method).map((c) => c.payload),
    rows: () => [...host().querySelectorAll('[data-model-key], .mrow-sep')].map((el) => el.getAttribute('data-model-key') || 'sep:' + el.textContent.trim()),
    status: () => h.card.querySelector('.model-library-section-status').textContent,
    drawer: (id) => h.document.getElementById(id),
    act: (action, scope) => (scope || host()).querySelector(`[data-mshare-action="${action}"]`),
    clickAct: async (action, scope) => { click(h.windowRef, (scope || host()).querySelector(`[data-mshare-action="${action}"]`)); await flush(); },
    text: (el) => el.textContent.replace(/\s+/g, ' ').trim(),
    flush,
  };
}

module.exports = { TEAM, OTHER, CARD, DISC, LIB_TAG, HASH, team, transfer, outgoing, incoming, take, stateAnswer, offerRead, RECEIVERS, FILES, openShare, flush, click };
