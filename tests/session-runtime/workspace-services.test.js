'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { initializeApplicationProjects } = require('../../services/projects/application-project-scope');
const { createProjectWorkspaceServiceResolver } = require('../../services/projects/project-workspace-services');
const { WorkspaceGitOperationContext } = require('../../services/workspace-git-operation-context');
const { AutomationService } = require('../../services/automation-service');
const { SCHEDULED_TASKS_SCHEMA_VERSION } = require('../../services/scheduler-schema-version');

function fixture(t) {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scoped-workspace-'));
 t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
 const roots = ['alpha', 'beta'].map(name => path.join(directory, name));
 for (const root of roots) fs.mkdirSync(root);
 const service = { _emitServiceLog() {}, sessionStore: {}, hostMode: 'desktop',
  featureFlags: { workspace_git: true }, configService: { getState: () => ({ toolsWorkspaceRoot: roots[1] }) } };
 initializeApplicationProjects(service, { userDataPath: directory });
 const project = service.projectService.create({ name: 'Alpha' }).project;
 assert.equal(service.projectService.bindRoot(project.id, roots[0]).ok, true);
 const authority = service.projectAuthority.captureProject(project.id);
 const resolve = createProjectWorkspaceServiceResolver(service, { gitFactory: options => options });
 return { service, authority, roots, resolve };
}

test('captured workspace bundle ignores shell selection and invalidates on root rebind', t => {
 const { service, authority, roots, resolve } = fixture(t);
 const bundle = resolve(authority);
 assert.equal(bundle.configService.getToolsWorkspaceRoot(), roots[0]);
 assert.equal(bundle.configService.getState().toolsWorkspaceRoot, roots[0]);
 assert.equal(resolve(authority), bundle);
 const lease = bundle.workspaceGitService.rootContextProvider().acquireOperation();
 service.configService.getState = () => ({ toolsWorkspaceRoot: 'another-ui-choice' });
 assert.equal(lease.isCurrent(), true);
 assert.equal(bundle.configService.getToolsWorkspaceRoot(), roots[0]);
 assert.equal(service.projectService.bindRoot(authority.project_id, roots[1]).ok, true);
 assert.equal(lease.isCurrent(), false);
 assert.throws(() => bundle.configService.getToolsWorkspaceRoot(), /stale/i);
 assert.throws(() => resolve(authority), /stale/i);
 assert.equal(lease.release(), true);
 assert.equal(lease.release(), false);
});

test('hosted and sandbox restrictions remain live on an already captured Git service', t => {
 const { service, authority, resolve } = fixture(t);
 const flags = resolve(authority).workspaceGitService.featureFlagProvider;
 assert.equal(flags().workspace_git, true);
 service.commandSandbox = { enabled: true };
 assert.equal(flags().workspace_git, false);
 service.commandSandbox.enabled = false;
 service.hostMode = 'server';
 assert.equal(flags().workspace_git, false);
});

test('two projects sharing a physical root keep distinct authority while Git mutations serialize', async t => {
 const { service, authority, roots, resolve } = fixture(t);
 const second = service.projectService.create({ name: 'Other' }).project;
 service.projectService.bindRoot(second.id, roots[0]);
 const other = service.projectAuthority.captureProject(second.id);
 assert.notEqual(authority.project_id, other.project_id);
 assert.equal(authority.root_id, other.root_id);
 const firstContext = new WorkspaceGitOperationContext({ rootContextProvider: resolve(authority).workspaceGitService.rootContextProvider });
 const secondContext = new WorkspaceGitOperationContext({ rootContextProvider: resolve(other).workspaceGitService.rootContextProvider });
 let finishFirst;
 const gate = new Promise(resolveGate => { finishFirst = resolveGate; });
 const events = [];
 const first = firstContext.runSerialized(authority.root_id, async () => { events.push('first'); await gate; events.push('settled'); });
 const next = secondContext.runSerialized(other.root_id, async () => { events.push('second'); });
 await new Promise(resolveTick => setImmediate(resolveTick));
 assert.deepEqual(events, ['first']);
 finishFirst();
 await Promise.all([first, next]);
 assert.deepEqual(events, ['first', 'settled', 'second']);
});

test('failed serialized work releases the shared queue for subsequent owners', async () => {
 const first = new WorkspaceGitOperationContext();
 const second = new WorkspaceGitOperationContext();
 const key = 'test-failed-root';
 await assert.rejects(first.runSerialized(key, async () => { throw new Error('failed'); }), /failed/);
 assert.equal(await second.runSerialized(key, async () => 'next'), 'next');
 assert.equal(first._writeTails.has(key), false);
});

function writeAutomation(root, task) {
 const directory = path.join(root, '.jenny');
 fs.mkdirSync(directory, { recursive: true });
 fs.writeFileSync(path.join(directory, 'scheduled_tasks.json'), JSON.stringify({
  version: SCHEDULED_TASKS_SCHEMA_VERSION, tasks: [{ id: `automation:${task}`, task,
   kind: 'automation', enabled: true, trigger: { type: 'interval', interval_seconds: 86400 },
   input: { task_spec: task, isolation: { mode: 'read_only' } }, automation_runs: [] }],
 }));
}

test('automation inspection uses the captured root and cannot start scheduled work', async t => {
 const { service, authority, roots, resolve } = fixture(t);
 writeAutomation(roots[0], 'alpha');
 writeAutomation(roots[1], 'beta');
 service.automationService = new AutomationService({ userDataPath: path.dirname(roots[0]), configService: service.configService });
 const scoped = resolve(authority).automationService;
 assert.deepEqual(Object.keys(scoped).sort(), ['listAutomations', 'readAutomation']);
 assert.deepEqual((await scoped.listAutomations()).automations.map(row => row.task), ['alpha']);
 assert.equal((await scoped.readAutomation('automation:beta')).success, false);
 assert.equal((await scoped.readAutomation('automation:alpha')).automation.task_spec, 'alpha');
 service.projectService.bindRoot(authority.project_id, roots[1]);
 await assert.rejects(scoped.listAutomations(), /stale/i);
});

test('automation inspection cannot follow a state-directory junction into another workspace', async t => {
 const { service, authority, roots, resolve } = fixture(t);
 writeAutomation(roots[1], 'outside-secret');
 fs.symlinkSync(path.join(roots[1], '.jenny'), path.join(roots[0], '.jenny'), process.platform === 'win32' ? 'junction' : 'dir');
 service.automationService = new AutomationService({ userDataPath: path.dirname(roots[0]) });
 const result = await resolve(authority).automationService.listAutomations();
 assert.deepEqual(result.automations, []);
 assert.equal(JSON.stringify(result).includes('outside-secret'), false);
});

test('global Home preferences stay available while unbound automation inspection stays unavailable', t => {
 const { service, resolve } = fixture(t);
 service.automationService = new AutomationService({ userDataPath: 'unused' });
 service.homeAssistantService = { globalPreferences: true };
 const unbound = service.projectAuthority.captureProject('project_general');
 const scoped = resolve(unbound);
 assert.equal(scoped.automationService, null);
 assert.equal(scoped.homeAssistantService, service.homeAssistantService);
});
