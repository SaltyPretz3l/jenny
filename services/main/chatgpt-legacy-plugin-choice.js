'use strict';

// Plugin platform retirement, stage 2: the retired ChatGPT plugin's install
// receipt and desired state, read from the plugin store's files. Cloud models
// registration reads them before startup builds the sidecar secrets, so the
// user's old on/off choice holds from the first engine start. Read-only: the
// retired plugin store is left on disk (removed by the uninstaller).
//
// Plain JSON reads: the plugin platform is gone, so this reads the old store's
// layout directly: <userData>/plugins/provider-migrations/chatgpt-subscription.json,
// active-generation.json naming generations/<id>/control-plane.json.

const fs = require('node:fs');
const nodePath = require('node:path');

const PUBLISHER_ID = 'jenny-official';
const PLUGIN_ID = 'chatgpt-subscription';
const GENERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
// Bounds the history scan; retention normally keeps far fewer.
const MAX_GENERATIONS_SCANNED = 64;

async function readJson(readFile, filePath) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    return error?.code === 'ENOENT' ? { status: 'missing' } : { status: 'unreadable' };
  }
  try {
    return { status: 'ok', value: JSON.parse(raw) };
  } catch (_error) {
    return { status: 'unreadable' };
  }
}

// '' when nothing is committed or the committed generation lacks the plugin;
// null when the store cannot be read or does not hang together (unknown, not "off").
async function readDesiredState(readFile, storeDir) {
  const pointer = await readJson(readFile, nodePath.join(storeDir, 'active-generation.json'));
  if (pointer.status === 'missing') return '';
  const generationId = String(pointer.value?.generation_id || '');
  if (pointer.status !== 'ok' || !GENERATION_ID_RE.test(generationId)) return null;
  const record = await readJson(readFile,
    nodePath.join(storeDir, 'generations', generationId, 'control-plane.json'));
  if (record.status !== 'ok' || !Array.isArray(record.value?.plugins)
    || record.value.graph_hash !== pointer.value.generation_digest) return null;
  const entry = record.value.plugins.find((plugin) => plugin?.publisher_id === PUBLISHER_ID
    && plugin?.plugin_id === PLUGIN_ID);
  return String(entry?.desired_state || '');
}

// Whether any retained generation has the plugin active: the receipt's
// auto_enabled covers only the migration's own enable, not a user's later one.
// Evidence only; an unreadable directory or record counts as no evidence.
async function wasEverActive(readFile, readDir, storeDir) {
  let ids;
  try {
    ids = await readDir(nodePath.join(storeDir, 'generations'));
  } catch (_error) {
    return false;
  }
  for (const id of ids.filter((name) => GENERATION_ID_RE.test(String(name)))
    .slice(0, MAX_GENERATIONS_SCANNED)) {
    const record = await readJson(readFile,
      nodePath.join(storeDir, 'generations', String(id), 'control-plane.json'));
    if (record.status === 'ok' && Array.isArray(record.value?.plugins)
      && record.value.plugins.some((plugin) => plugin?.publisher_id === PUBLISHER_ID
        && plugin?.plugin_id === PLUGIN_ID && plugin?.desired_state === 'active')) return true;
  }
  return false;
}

// Returns null when the profile never had the plugin (no receipt), otherwise
// { receipt, desiredState, everActive } for chatgptChoiceFromRetiredPlugin.
async function readRetiredChatgptPluginFacts({ userDataDir, readFile = fs.promises.readFile,
  readDir = fs.promises.readdir } = {}) {
  const storeDir = nodePath.join(String(userDataDir), 'plugins');
  const receipt = await readJson(readFile,
    nodePath.join(storeDir, 'provider-migrations', `${PLUGIN_ID}.json`));
  if (receipt.status === 'missing') return null;
  return {
    receipt: receipt.status === 'ok' ? receipt.value : null,
    desiredState: await readDesiredState(readFile, storeDir),
    everActive: await wasEverActive(readFile, readDir, storeDir),
  };
}

module.exports = { readRetiredChatgptPluginFacts };
