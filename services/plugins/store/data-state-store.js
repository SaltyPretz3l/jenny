'use strict';

const { validate } = require('../contracts/generated-plugin-contracts');
const { PUBLISHER_ID_RE, PLUGIN_ID_RE } = require('../identity/authority-id');
const { joinPath } = require('./fs-facade');
const { readJsonFile, writeJsonFileAtomic } = require('./json-file-io');

const FILE = 'data-state.json';
function pathFor(baseDir, publisherId, pluginId) { return joinPath(baseDir, 'data', publisherId, pluginId, FILE); }
function validAuthority(publisherId, pluginId) { return PUBLISHER_ID_RE.test(publisherId || '') && PLUGIN_ID_RE.test(pluginId || ''); }
async function readDataState(facade, baseDir, { publisherId, pluginId }) {
  if (!validAuthority(publisherId, pluginId)) return { ok: false, reason: 'data_state_authority_invalid' };
  const read = await readJsonFile(facade, pathFor(baseDir, publisherId, pluginId));
  if (read.status === 'missing') return { ok: false, reason: 'data_state_not_found' };
  if (read.status !== 'ok') return { ok: false, reason: 'data_state_corrupted' };
  const checked = validate('PluginDataStateV1', read.value);
  return checked.ok ? { ok: true, state: checked.value } : { ok: false, reason: 'data_state_invalid', detail: checked.error };
}
async function writeDataState(facade, baseDir, state, { expectedWatermark = null } = {}) {
  const checked = validate('PluginDataStateV1', state);
  if (!checked.ok) return { ok: false, reason: 'data_state_invalid', detail: checked.error };
  const current = await readDataState(facade, baseDir, { publisherId: state.publisher_id, pluginId: state.plugin_id });
  if (!current.ok && current.reason !== 'data_state_not_found') return current;
  if (expectedWatermark !== null && (!current.ok || current.state.mutation_watermark.sequence !== expectedWatermark)) {
    return { ok: false, reason: 'data_state_watermark_conflict' };
  }
  if (current.ok && state.mutation_watermark.sequence < current.state.mutation_watermark.sequence) {
    return { ok: false, reason: 'data_state_watermark_rollback' };
  }
  await writeJsonFileAtomic(facade, joinPath(baseDir, 'data', state.publisher_id, state.plugin_id), FILE, checked.value);
  return { ok: true, state: checked.value };
}
module.exports = { FILE, pathFor, readDataState, writeDataState };
