'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SkillsService } = require('../../services/skills-service');
const { PersonalityWorkspaceService } = require('../../services/personality-workspace-service');

function directory(t) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-context-scope-'));
 t.after(() => fs.rmSync(root, { recursive: true, force: true }));
 return root;
}

test('historical personality notes remain General while voice and user preferences are shared', async t => {
 const userDataPath = directory(t);
 const service = new PersonalityWorkspaceService({ userDataPath });
 await service.ensureSeeded();
 fs.writeFileSync(path.join(service.workspacePath, 'PERSONALITY.md'), '# Voice\nGlobal voice preference.');
 fs.writeFileSync(path.join(service.workspacePath, 'USER.md'), '# User\nGlobal user preference.');
 fs.writeFileSync(path.join(service.workspacePath, 'MEMORY.md'), '# Notes\nPrivate historical project fact.');
 const general = await service.getCompiledContext();
 assert.match(general, /Private historical project fact/);
 const [alpha, beta] = await Promise.all([
  service.getCompiledContext({ projectId: 'project_alpha' }),
  service.getCompiledContext({ projectId: 'project_beta' }),
 ]);
 assert.equal(alpha, beta);
 assert.match(alpha, /Global voice preference/);
 assert.match(alpha, /Global user preference/);
 assert.doesNotMatch(alpha, /Private historical|### Notes/);
 assert.equal(await service.getCompiledContext(), general);
 await assert.rejects(service.getCompiledContext({ projectId: null }), /Invalid project/);
});

test('scoped skills configuration allocates no additional watcher and ignores selected root', t => {
 const root = directory(t);
 let selectedRoot = path.join(root, 'selected');
 const service = new SkillsService({
  configService: { getState: () => ({ toolsWorkspaceRoot: selectedRoot,
   skills: { projectEnabled: true, userEnabled: true, bundledEnabled: true } }) },
  bundledRoot: path.join(root, 'bundled'), homedir: () => root,
  watchIntervalMs: 0,
 });
 t.after(() => service.dispose());
 const authority = Object.freeze({ project_id: 'project_alpha', root_path: path.join(root, 'alpha') });
 const scoped = service.getSidecarConfig({ authority });
 selectedRoot = path.join(root, 'other');
 assert.deepEqual(service.getSidecarConfig({ authority }), scoped);
 assert.equal(scoped.skills_project_root, path.join(root, 'alpha', '.jenny', 'skills'));
 assert.equal(service._watchTimer, null);
 const unbound = service.getSidecarConfig({ authority: { project_id: 'project_general', root_path: null } });
 assert.equal(unbound.skills_project_root, null);
 assert.equal(unbound.skills_project_enabled, false);
 assert.equal(unbound.skills_user_root, scoped.skills_user_root);
 assert.throws(() => service.getSidecarConfig({ authority: { project_id: 'project_alpha', root_path: '../outside' } }), /Invalid project/);
});
