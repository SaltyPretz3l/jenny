"use strict";
// Test Runner-owned ephemeral observations. Durable metadata remains in its history.
const MAX_COMPLETED = 200;
const MAX_OUTPUTS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
function scopeOf(value) {
  const source = value?.schema_version === 1 ? value : {};
  const id = key => typeof source[key] === 'string' ? source[key].slice(0, 200) : null;
  return Object.freeze({schema_version:1, project_id:id('project_id'), session_id:id('session_id'),
    root_id:id('root_id'), root_revision:Number.isSafeInteger(source.root_revision) ? source.root_revision : null});
}
function createTestRunnerObservation({now = () => new Date()} = {}) {
  const records = new Map(), outputs = new Map(), listeners = new Set();
  let expiry = null, disposed = false;
  const stamp = () => now().toISOString();
  function notify() {
    for (const listener of listeners) { try { listener(); } catch { /* observational only */ } }
  }
  function prune() {
    const completed = [...records.values()].filter(row => row.state === 'finished')
      .sort((a,b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    let removed = false, next = Infinity;
    for (const [index,row] of completed.entries()) {
      const expiresAt = Date.parse(row.updatedAt) + DAY_MS;
      if (index >= MAX_COMPLETED || now().getTime() > expiresAt) {
        records.delete(row.runId); outputs.delete(row.runId); removed = true;
      } else if (expiresAt < next) next = expiresAt;
    }
    // One one-shot wakeup for the next completed-record expiry, so an idle panel still loses it; never a poll.
    if (expiry) clearTimeout(expiry);
    expiry = null;
    if (!disposed && Number.isFinite(next)) {
      // A restored future-dated record would overflow Node's 32-bit timer (which fires after 1 ms);
      // the delay is capped and the absolute expiry is recomputed at the capped wakeup.
      const delay = Math.min(Math.max(0, next - now().getTime()) + 1, MAX_TIMER_DELAY_MS);
      expiry = setTimeout(() => { expiry = null; if (prune()) notify(); }, delay);
      expiry.unref?.();
    }
    return removed;
  }
  function begin({runId, configId, label, startedAt, scope}) {
    records.set(runId, {runId, configId, label:String(label || configId).slice(0,160),
      scope:scopeOf(scope), startedAt, finishedAt:null, updatedAt:stamp(), sourceRevision:1,
      state:'running', cleanup:'pending', result:null});
    prune(); notify();
    return {schema_version:1, label:records.get(runId).label, scope:scopeOf(scope)};
  }
  function change(runId, patch) {
    const row = records.get(runId); if (!row) return;
    Object.assign(row, patch, {updatedAt:stamp(), sourceRevision:row.sourceRevision + 1});
    prune(); notify();
  }
  function result(runId, record, output) {
    if (output) {
      const tail = value => Buffer.from(String(value || ''), 'utf8').subarray(-65536).toString('utf8');
      outputs.set(runId, {...record, runId, stdoutTail:tail(output.stdoutTail), stderrTail:tail(output.stderrTail)});
      while (outputs.size > MAX_OUTPUTS) outputs.delete(outputs.keys().next().value);
    }
    change(runId, {result:{status:record.status, exitCode:record.exitCode ?? null},
      finishedAt:record.finishedAt || stamp()});
  }
  function settle(runId, confirmed) {
    const output = outputs.get(runId); if (output) output.terminationConfirmed = confirmed;
    change(runId, {state:confirmed === false ? 'attention' : 'finished', cleanup:confirmed === true ? 'confirmed' : confirmed === false ? 'unconfirmed' : 'unknown'});
  }
  function restore(history) {
    for (const list of Object.values(history?.byConfig || {})) {
      for (const record of Array.isArray(list) ? list : []) {
        if (!record?.runId || records.has(record.runId) || record.activity?.schema_version !== 1) continue;
        records.set(record.runId, {runId:record.runId, configId:record.configId,
          label:String(record.activity.label || record.configId).slice(0,160), scope:scopeOf(record.activity.scope),
          startedAt:record.startedAt, finishedAt:record.finishedAt, updatedAt:record.finishedAt || record.startedAt,
          sourceRevision:1, state:record.terminationConfirmed === false ? 'attention' : 'finished',
          cleanup:record.terminationConfirmed === true ? 'confirmed' : record.terminationConfirmed === false ? 'unconfirmed' : 'unknown',
          result:{status:record.status,exitCode:record.exitCode ?? null}});
      }
    }
    prune();
  }
  return {begin, result, settle, restore,
    // Only a running row can be cancelling; a settled unconfirmed cleanup stays in Needs attention.
    cancelling:runId=>{if(records.get(runId)?.state === 'running') change(runId,{state:'cancelling'});},
    snapshot:()=>{prune(); return [...records.values()].map(row=>({...row,scope:{...row.scope},result:row.result && {...row.result},outputAvailable:outputs.has(row.runId)}));},
    output:runId=>outputs.has(runId) ? {...outputs.get(runId)} : null,
    subscribe:listener=>{listeners.add(listener); return ()=>listeners.delete(listener);},
    dispose:()=>{disposed = true; if (expiry) clearTimeout(expiry); expiry = null; listeners.clear();}};
}
module.exports = {createTestRunnerObservation, scopeOf};
