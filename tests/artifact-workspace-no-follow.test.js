'use strict';

// Artifact removals never enter a junction. Node's fs.rm (recursive or not) falls back on a Windows EPERM
// to stat() -> rmdir -> readdir THROUGH a junction, so one transient lock on a junction planted in a session
// scratch dir deleted files outside the workspace. These removals go through fs-remove-no-follow instead:
// a link is unlinked (retried on EPERM) and never listed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');
const { ArtifactWorkspaceService, SESSION_ARTIFACT_ROOT } = require('../services/artifact-workspace-service');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// fs/promises whose unlink fails once with EPERM on any link (a transient lock), and which records every
// rm call so a regression to Node's rm is caught even where the injected unlink cannot reach its rimraf.
function lockedLinkFs() {
  const realFs = require('fs/promises');
  const record = { rmCalls: [], injectedLocks: [] };
  const fsImpl = new Proxy(realFs, {
    get(target, prop) {
      if (prop === 'rm') {
        return async (targetPath, options) => { record.rmCalls.push(targetPath); return target.rm(targetPath, options); };
      }
      if (prop === 'unlink') {
        return async (targetPath) => {
          let isLink;
          try { isLink = fs.lstatSync(targetPath).isSymbolicLink(); } catch (_error) { isLink = false; }
          if (isLink && !record.injectedLocks.includes(targetPath)) {
            record.injectedLocks.push(targetPath);
            throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${targetPath}'`), { code: 'EPERM' });
          }
          return target.unlink(targetPath);
        };
      }
      return target[prop];
    },
  });
  return { fsImpl, record };
}

function outsideTree() {
  const outside = createTrackedTempDir('jenny-artifacts-outside-');
  fs.writeFileSync(path.join(outside, 'keep'), 'outside the workspace');
  return outside;
}

function serviceFor(workspaceRoot, fsImpl) {
  return new ArtifactWorkspaceService({
    configService: { getState: () => ({ toolsWorkspaceRoot: workspaceRoot }) },
    ...(fsImpl ? { fsImpl } : {}),
  });
}

async function seedSession(workspaceRoot, sessionId) {
  await serviceFor(workspaceRoot).createArtifact(sessionId, {
    artifact_kind: 'document', title: 'Plan', content: '# plan', language: 'markdown',
  });
  return path.join(workspaceRoot, SESSION_ARTIFACT_ROOT, sessionId);
}

test('session artifact deletion never enters a junction in the scratch dir, even when unlinking it fails transiently', async () => {
  const workspaceRoot = createTrackedTempDir('jenny-artifacts-no-follow-');
  const outside = outsideTree();
  const scratchDir = await seedSession(workspaceRoot, 'session-junction');
  const link = path.join(scratchDir, 'nested', 'linked');
  fs.mkdirSync(path.dirname(link));
  fs.symlinkSync(outside, link, 'junction');
  const { fsImpl, record } = lockedLinkFs();

  assert.deepEqual(await serviceFor(workspaceRoot, fsImpl).deleteSessionArtifacts('session-junction'), { deleted: true });

  assert.deepEqual(record.rmCalls, [], 'session deletion must not use fs.rm');
  assert.deepEqual(record.injectedLocks, [link], 'the transient lock fired on the junction');
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'outside the workspace');
  assert.equal(fs.existsSync(link), false);
  assert.equal(fs.existsSync(scratchDir), false);
});

test('orphan pruning never enters a junction inside an orphaned scratch dir', async () => {
  const workspaceRoot = createTrackedTempDir('jenny-artifacts-no-follow-');
  const outside = outsideTree();
  const orphanDir = await seedSession(workspaceRoot, 'session-orphan');
  const keptDir = await seedSession(workspaceRoot, 'session-active');
  const link = path.join(orphanDir, 'linked');
  fs.symlinkSync(outside, link, 'junction');
  const { fsImpl, record } = lockedLinkFs();

  assert.deepEqual(await serviceFor(workspaceRoot, fsImpl).pruneOrphanedArtifacts(['session-active']), { removed: 1 });

  assert.deepEqual(record.rmCalls, []);
  assert.deepEqual(record.injectedLocks, [link]);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'outside the workspace');
  assert.equal(fs.existsSync(orphanDir), false);
  assert.equal(fs.existsSync(keptDir), true);
});
