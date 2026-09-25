'use strict';

const { fail, copy, validatePortableLineageSnapshot } = require('../session-runtime/lineage-contracts');
const { isRuntimeLedgerProjection } = require('./runtime-ledger-archive');

function matchesWork(work, root, identity) {
  return work && work.work_id === identity.work_id && work.turn_id === identity.turn_id
    && work.session_id === identity.session_id && work.project_id === root.project_id;
}

// Restore preserves source references as inert evidence. It does not grant fresh
// authority, adopt a same-ID session or make a recovered child eligible.
function validateLineageCrosslinks(lineage, { works, sessions, budgets }) {
  const roots = new Map(budgets.records.map(item => [item.root_run_id, item.document]));
  for (const { document: root } of lineage.records) {
    const work = works.get(root.root_work_id);
    const budget = roots.get(root.root_run_id);
    if (!matchesWork(work, root, { work_id: root.root_work_id, turn_id: root.root_turn_id,
      session_id: root.root_session_id }) || !sessions.has(root.root_session_id)
      || !budget || budget.authority_fingerprint !== root.authority_fingerprint
      || !budget.allowed_provider_ids.includes(root.provider_id)
      || work.input?.root_run?.root_run_id !== root.root_run_id
      || work.input.root_run.authority_fingerprint !== root.authority_fingerprint) {
      fail('runtime_lineage_root_crosslink_invalid');
    }
    for (const child of root.children) {
      const childWork = works.get(child.work_id);
      if (child.state !== 'preparing' && !sessions.has(child.session_id)) fail('runtime_lineage_session_missing');
      // An interrupted publication can leave work before the committed marker.
      // Preserve it, but only if its immutable ownership matches the intent.
      if (childWork && !matchesWork(childWork, root, child)) fail('runtime_lineage_child_crosslink_invalid');
      if (child.state === 'committed' && (!childWork || childWork.submission_hash !== (child.restored_submission_sha256 || child.submission_sha256))) {
        fail('runtime_lineage_work_proof_invalid');
      }
    }
  }
  return true;
}

function projectLineageForImport(lineage, ledgerProjection) {
  const projected = copy(lineage);
  if (!projected.records.length) return projected;
  if (!isRuntimeLedgerProjection(ledgerProjection)) {
    fail('runtime_lineage_projected_ledger_missing');
  }
  const imported = new Map(ledgerProjection.files.filter(file => file.relativePath !== 'index.json')
    .map(file => { const work = JSON.parse(file.bytes.toString('utf8')); return [work.work_id, work]; }));
  for (const { document: root } of projected.records) {
    if (root.revision >= Number.MAX_SAFE_INTEGER) fail('runtime_lineage_revision_exhausted');
    root.revision += 1;
    root.restored = true;
    for (const child of root.children) {
      if (child.state === 'committed') {
        const work = imported.get(child.work_id);
        if (!work) fail('runtime_lineage_projected_work_missing');
        child.restored_submission_sha256 = work.submission_hash;
      }
    }
  }
  return validatePortableLineageSnapshot(projected);
}

module.exports = { validateLineageCrosslinks, projectLineageForImport };
