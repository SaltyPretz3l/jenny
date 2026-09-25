"use strict";
const fs = require('node:fs');
const path = require('node:path');
const { createBackend, waitFor } = require('./session-runtime-stdio-fixture');
async function main() {
  const root = process.argv[2];
  const crash = ['-c', [
    'from sidecar.__main__ import main', 'import os',
    'from sidecar.runtime.mutation_continuation import FrozenMutationCheckpoint',
    'original=FrozenMutationCheckpoint.transition',
    'def transition(self,action,*args):',
    '    if action=="confirm": os._exit(86)',
    '    return original(self,action,*args)',
    'FrozenMutationCheckpoint.transition=transition', 'main()',
  ].join('\n')];
  const backend = createBackend(path.join(root, 'profile'), path.join(root, 'project'), [], [], 'user_questions', crash);
  await backend.start();
  // The application dies with the worker, before any asynchronous settlement or graceful cancellation.
  backend.sidecarManager.process.prependOnceListener('exit', () => process.exit(86));
  const session = (await backend.createSession({ title: 'Published crash' })).data.id;
  const projects = backend.projectApplicationService;
  const project = projects.createProject({ name: 'Published recovery' }).project;
  if (!projects.bindProjectRoot({ project_id: project.id, root_path: path.join(root, 'project'), expected_root_revision: project.root_revision }).ok) throw new Error('bind_failed');
  if (!projects.assignSessionProject({ session_id: session, project_id: project.id }).ok) throw new Error('assign_failed');
  const start = await backend.runtimeApplicationService.start({ session_id: session, prompt: 'Write then ask.',
    idempotency_key: 'published_crash', purpose: 'Published crash recovery',
    limits: { inference_requests: 3, input_tokens: 1000000, output_tokens: 1000000 } });
  if (!start.ok) throw new Error('start_failed');
  fs.writeFileSync(path.join(root, 'identity.json'), JSON.stringify({ session, work_id: start.work_id }));
  const [approval] = await waitFor(() => [...backend.pendingToolApprovals.entries()][0]);
  if (!backend.approveToolCall(approval)) throw new Error('approval_failed');
  await waitFor(() => backend.pendingUserQuestions.size > 0);
  const work = backend.sessionRuntime.store.get(start.work_id);
  if (!backend.runtimeApplicationService.pause({ work_id: work.work_id, expected_revision: work.revision }).ok) throw new Error('pause_failed');
}
main().catch(error => { process.stderr.write(error.stack); process.exit(1); });
