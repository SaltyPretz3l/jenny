'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { WorkspacePresentationService } = require('../../services/workspace-presentation-service');
const { workspaceRootId } = require('../../services/workspace-root-identity');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('../helpers/resource-cleanup');

test.afterEach(cleanupTrackedResources);

const FIELDS = ['project_id', 'root_path', 'root_id', 'root_revision', 'device_id', 'inode'];

function sameAuthority(left, right) {
  return FIELDS.every((field) => left?.[field] === right?.[field]);
}

function fixture() {
  const root = createTrackedTempDir('workspace-presentation-project-');
  const otherRoot = createTrackedTempDir('workspace-presentation-other-');
  const make = (projectId, rootPath = root) => Object.freeze({
    project_id: projectId,
    root_path: rootPath,
    root_id: workspaceRootId(rootPath),
    root_revision: 1,
    device_id: '1',
    inode: '1',
  });
  const authorities = new Map([
    ['project_alpha', make('project_alpha')],
    ['project_beta', make('project_beta')],
  ]);
  const sessions = new Map([
    ['session_alpha', 'project_alpha'],
    ['session_beta', 'project_beta'],
  ]);
  const error = (reason) => Object.assign(new Error(reason), { reason });
  const provider = {
    captureSession(sessionId) {
      const authority = authorities.get(sessions.get(sessionId));
      if (!authority) throw error('session_not_found');
      return authority;
    },
    requireCurrent(authority) {
      if (!sameAuthority(authorities.get(authority?.project_id), authority)) {
        throw error('project_authority_stale');
      }
      return authority;
    },
  };
  return { root, otherRoot, authorities, sessions, provider };
}

test('scoped presentation sends session and workspace identity for every view on a shared root', () => {
  const f = fixture();
  const sent = [];
  const service = new WorkspacePresentationService({
    sendBridgeEvent: (_method, payload) => sent.push(payload),
    isRendererAvailable: () => true,
    getUiWorkspaceRoot: () => f.root,
    projectAuthorityProvider: () => f.provider,
  });
  const alpha = service.forSessionAuthority(f.authorities.get('project_alpha'), 'session_alpha');
  const beta = service.forSessionAuthority(f.authorities.get('project_beta'), 'session_beta');

  assert.equal(alpha.requestPresentation({ view: 'preview', path: 'docs/a.md' }).delivered, true);
  assert.equal(alpha.requestPresentation({ view: 'file_map' }).delivered, true);
  assert.equal(beta.requestPresentation({ view: 'change_diff', path: 'src/b.js' }).delivered, true);
  assert.deepEqual(sent.map((payload) => [payload.view, payload.session_id, payload.workspace_id]), [
    ['preview', 'session_alpha', workspaceRootId(f.root)],
    ['file_map', 'session_alpha', workspaceRootId(f.root)],
    ['change_diff', 'session_beta', workspaceRootId(f.root)],
  ]);
});

test('scoped presentation rejects session drift and a UI root switch immediately before dispatch', () => {
  const f = fixture();
  const sent = [];
  let uiRoot = f.root;
  let switchDuringAvailability = false;
  const service = new WorkspacePresentationService({
    sendBridgeEvent: (_method, payload) => sent.push(payload),
    isRendererAvailable: () => {
      if (switchDuringAvailability) uiRoot = f.otherRoot;
      return true;
    },
    getUiWorkspaceRoot: () => uiRoot,
    projectAuthorityProvider: f.provider,
  });
  const alpha = service.forSessionAuthority(f.authorities.get('project_alpha'), 'session_alpha');

  switchDuringAvailability = true;
  assert.equal(
    alpha.requestPresentation({ view: 'preview', path: 'docs/a.md' }).reason,
    'workspace_context_changed'
  );
  assert.equal(sent.length, 0);

  switchDuringAvailability = false;
  uiRoot = f.root;
  f.sessions.set('session_alpha', 'project_beta');
  assert.equal(
    alpha.requestPresentation({ view: 'file_map' }).reason,
    'workspace_context_changed'
  );
  assert.equal(sent.length, 0);
});
