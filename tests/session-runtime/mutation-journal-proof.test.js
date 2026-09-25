'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { createMutationJournalProof, mutationReference } = require('../../services/session-runtime/mutation-journal-proof');
const ROOT = path.resolve(__dirname, '../..');
const PYTHON = path.join(ROOT, '.venv', 'Scripts', 'python.exe');
const SCRIPT = `
import json, sys
from pathlib import Path
from tests.sidecar.ai.tools.test_workspace_mutation_journal import _create_record
from sidecar.ai.tools.workspace_mutation_checkpoint import mutation_reference, checkpoint_transition
from sidecar.ai.tools.workspace_mutation_journal_store import WorkspaceMutationJournalStore
root=Path(sys.argv[1]); workspace=root/'workspace'; workspace.mkdir()
store=WorkspaceMutationJournalStore(root/'workspace-recovery')
record=_create_record(workspace,1,state='in_progress',operation_status=sys.argv[2])
if sys.argv[2]=='skipped': record['completed_sequences']=[]
record['coverage']['warning']='Unicode: café, Straße, 東京'
assert store.write_transition(record,workspace_root=workspace).ok
ref=mutation_reference(record)
attempt=dict(attempt_id='attempt_1',stream_id='stream_1',incarnation='incarnation_1',authority_revision='authority_1')
binding=dict(schema_version=1,work_id='work_1',decision_id='decision_1',source_attempt=attempt,mutation_ref=ref)
scope=dict(session_id=record['session_id'],turn_id=record['turn_id'],work_id='work_1')
refs=[dict(call_id='call_1',tool_id='write_file')]
result=checkpoint_transition(store,workspace,action='bind',scope=scope,reference=ref,binding=binding,completed_effects=refs)
assert result.ok, result.failure
result=checkpoint_transition(store,workspace,action='confirm',scope=scope,reference=ref,binding=binding,completed_effects=refs)
assert result.ok, result.failure
print(json.dumps(dict(reference=ref,record=result.record,attempt=attempt,refs=refs)))
`;
function fixture(t, status = 'applied') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-mutation-proof-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(PYTHON, ['-c', SCRIPT, root, status], { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  const work = { work_id: 'work_1', session_id: data.record.session_id, turn_id: data.record.turn_id,
    attempt: data.attempt, authority: { root_path: data.record.workspace.real_path,
      device_id: data.record.workspace.device_id, inode: data.record.workspace.file_id } };
  return { root, data, work, proof: createMutationJournalProof(root),
    input: { work, reference: data.reference, decision: { decision_id: 'decision_1' }, completedRefs: data.refs } };
}
test('Python journal bytes and immutable mutation reference have application parity', t => {
  const f = fixture(t);
  assert.deepEqual(mutationReference(f.data.record), f.data.reference);
  assert.equal(f.proof.verify(f.input).valid, true);
  assert.equal(f.proof.verify(f.input).released, false);
});
test('application proof rejects foreign scope, call coverage, prefix and source', t => {
  const f = fixture(t);
  for (const patch of [{ work: { ...f.work, session_id: 'foreign' } },
    { work: { ...f.work, turn_id: 'foreign' } }, { work: { ...f.work, work_id: 'foreign' } },
    { work: { ...f.work, attempt: { ...f.work.attempt, stream_id: 'foreign' } } },
    { work: { ...f.work, authority: { ...f.work.authority, inode: '1' } } },
    { reference: { ...f.data.reference, operations_sha256: 'a'.repeat(64) } },
    { completedRefs: [] }, { completedRefs: [{ call_id: 'call_1', tool_id: 'edit_file' }] },
    { decision: { decision_id: 'foreign' } }]) {
    assert.throws(() => f.proof.verify({ ...f.input, ...patch }), /journal_unproven/);
  }
});
test('application refuses corrupt owner bytes and oversized journals', t => {
  const f = fixture(t);
  const file = path.join(f.root, 'workspace-recovery', 'v1', f.data.reference.workspace_id,
    f.data.reference.change_set_id, 'journal.json');
  fs.writeFileSync(file, JSON.stringify(f.data.record));
  assert.throws(() => f.proof.verify(f.input), /journal_unproven/);
  fs.writeFileSync(file, Buffer.alloc(4 * 1024 * 1024 + 1));
  assert.throws(() => f.proof.verify(f.input), /journal_unproven/);
});

function ownerTransition(f, action, terminal = false) {
  const result = spawnSync(PYTHON, ['-c', `
import json,sys
from pathlib import Path
from sidecar.ai.tools.workspace_mutation_checkpoint import checkpoint_transition
from sidecar.ai.tools.workspace_mutation_journal_store import WorkspaceMutationJournalStore
root=Path(sys.argv[1]); data=json.loads(sys.argv[2]); store=WorkspaceMutationJournalStore(root/'workspace-recovery')
record=data['record']; ref=data['reference']; binding=record['extensions']['runtime_checkpoint']
scope=dict(session_id=record['session_id'],turn_id=record['turn_id'],work_id='work_1')
result=checkpoint_transition(store,root/'workspace',action=sys.argv[3],scope=scope,reference=ref,binding=binding,completed_effects=data['refs'])
assert result.ok, result.failure
if sys.argv[4]=='true':
    record=result.record; record['state']='committed'; record['termination_reason']='turn_completed'
    if not record['completed_sequences']:
        record['state']='rolled_back'; record['retention']['protected']=False
    record['wall_time']['terminal_at']=record['wall_time']['updated_at']
    written=store.write_transition(record,workspace_root=root/'workspace')
    assert written.ok, written.failure
`, f.root, JSON.stringify(f.data), action, String(terminal)], { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
}
test('claimed mutation history remains provable but cannot authorize another resume', t => {
  const f = fixture(t);
  ownerTransition(f, 'claim', true);
  assert.throws(() => f.proof.verify(f.input), /journal_unproven/);
  assert.equal(f.proof.verify({ ...f.input, historical: true, requireTerminal: true }).valid, true);
  assert.throws(() => f.proof.verify({ ...f.input, historical: true, decision: { decision_id: 'other' } }), /journal_unproven/);
});
test('active mutation history blocks retirement; owner release permits only cancellation proof', t => {
  const f = fixture(t);
  assert.throws(() => f.proof.verify({ ...f.input, historical: true, requireTerminal: true }), /journal_unproven/);
  ownerTransition(f, 'release');
  assert.throws(() => f.proof.verify(f.input), /journal_unproven/);
  assert.equal(f.proof.verify({ ...f.input, allowReleased: true }).released, true);
  assert.equal(f.proof.verify({ ...f.input, historical: true, requireTerminal: true }).valid, true);
});

test('fully skipped and unprotected terminal history can retire without granting resume', t => {
  const f = fixture(t, 'skipped');
  ownerTransition(f, 'claim', true);
  assert.equal(f.proof.verify({ ...f.input, historical: true, requireTerminal: true }).valid, true);
  assert.throws(() => f.proof.verify(f.input), /journal_unproven/);
});
