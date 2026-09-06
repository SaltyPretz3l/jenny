'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');
const {
  ArtifactWorkspaceService,
  SESSION_ARTIFACT_ROOT,
} = require('../services/artifact-workspace-service');

function createWorkspaceRoot() {
  return createTrackedTempDir('jenny-artifacts-');
}

function makePngBuffer(width = 2, height = 3) {
  const header = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
  ]);
  const dimensions = Buffer.alloc(8);
  dimensions.writeUInt32BE(width, 0);
  dimensions.writeUInt32BE(height, 4);
  return Buffer.concat([
    header,
    dimensions,
    Buffer.from([
      0x08, 0x06, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x49, 0x45, 0x4e, 0x44,
      0x00, 0x00, 0x00, 0x00,
    ]),
  ]);
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('ArtifactWorkspaceService creates session-scoped scratch artifacts with metadata', async () => {
  const workspaceRoot = createWorkspaceRoot();
  const service = new ArtifactWorkspaceService({
    configService: {
      getState() {
        return { toolsWorkspaceRoot: workspaceRoot };
      },
    },
  });

  const created = await service.createArtifact('session-1', {
    artifact_kind: 'document',
    title: 'Scratch Plan',
    content: '# Plan',
    language: 'markdown',
  });

  const expectedDir = path.join(workspaceRoot, SESSION_ARTIFACT_ROOT, 'session-1');
  const expectedPath = path.join(expectedDir, created.metadata.file_name);
  assert.equal(fs.existsSync(expectedPath), true);
  assert.equal(fs.readFileSync(expectedPath, 'utf8'), '# Plan');
  assert.equal(created.metadata.display_path.startsWith('.jenny/artifacts/session-1/'), true);
  assert.equal(created.metadata.artifact_kind, 'document');
  assert.equal(created.metadata.editable, true);
});

test('ArtifactWorkspaceService creates capped binary image artifacts atomically', async () => {
  const workspaceRoot = createWorkspaceRoot();
  const service = new ArtifactWorkspaceService({
    configService: {
      getState() {
        return { toolsWorkspaceRoot: workspaceRoot };
      },
    },
  });
  const png = makePngBuffer(9, 7);

  const created = await service.createBinaryArtifact('session-image-artifact', {
    artifact_kind: 'image',
    title: 'Browser Screenshot',
    file_name: 'browser-screenshot.png',
    content: png,
    mime_type: 'image/png',
  });

  assert.equal(created.metadata.artifact_kind, 'image');
  assert.equal(created.metadata.mime_type, 'image/png');
  assert.equal(created.metadata.width, 9);
  assert.equal(created.metadata.height, 7);
  assert.equal(created.metadata.editable, false);
  assert.equal(created.metadata.file_name, 'browser-screenshot.png');
  assert.deepEqual(fs.readFileSync(created.metadata.absolute_path), png);
});

test('ArtifactWorkspaceService serializes concurrent artifact creation for the same filename', async () => {
  const workspaceRoot = createWorkspaceRoot();
  const service = new ArtifactWorkspaceService({
    configService: {
      getState() {
        return { toolsWorkspaceRoot: workspaceRoot };
      },
    },
    fsImpl: {
      ...fs.promises,
      async writeFile(targetPath, content, encoding) {
        if (String(targetPath).includes('scratch-plan.md.tmp-')) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return fs.promises.writeFile(targetPath, content, encoding);
      },
    },
  });

  const [first, second] = await Promise.all([
    service.createArtifact('session-create-lock', {
      artifact_kind: 'document',
      title: 'Scratch Plan',
      content: 'first',
      language: 'markdown',
    }),
    service.createArtifact('session-create-lock', {
      artifact_kind: 'document',
      title: 'Scratch Plan',
      content: 'second',
      language: 'markdown',
    }),
  ]);

  assert.notEqual(first.metadata.file_name, second.metadata.file_name);
  assert.equal(fs.existsSync(first.metadata.absolute_path), true);
  assert.equal(fs.existsSync(second.metadata.absolute_path), true);
});

test('ArtifactWorkspaceService infers mermaid language for .mmd artifacts', async () => {
  const workspaceRoot = createWorkspaceRoot();
  const service = new ArtifactWorkspaceService({
    configService: {
      getState() {
        return { toolsWorkspaceRoot: workspaceRoot };
      },
    },
  });

  const created = await service.createArtifact('session-mermaid', {
    artifact_kind: 'document',
    title: 'Butterfly Diagram',
    content: 'flowchart TD\nA-->B\n',
    file_name: 'butterfly-effect.mmd',
  });

  assert.equal(created.metadata.language, 'mermaid');
  assert.equal(created.metadata.file_name, 'butterfly-effect.mmd');
});

test('ArtifactWorkspaceService resolves, reads, and saves only session-owned artifacts', async () => {
  const workspaceRoot = createWorkspaceRoot();
  const artifactPath = path.join(workspaceRoot, '.jenny', 'artifacts', 'session-2', 'script.py');
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, 'print("hi")\n', 'utf8');

  const service = new ArtifactWorkspaceService({
    configService: {
      getState() {
        return { toolsWorkspaceRoot: workspaceRoot };
      },
    },
    sessionMessageReader: async () => ([
      {
        id: 'tool-result-1',
        kind: 'tool_result',
        tool_result: {
          generated_artifacts: [{
            artifact_id: 'artifact_file_session-2_script',
            artifact_kind: 'script',
            title: 'Helper Script',
            file_name: 'script.py',
            display_path: '.jenny/artifacts/session-2/script.py',
            absolute_path: artifactPath,
            language: 'python',
            editable: true,
            status: 'available',
          }],
        },
      },
    ]),
  });

  const read = await service.readArtifact('session-2', 'artifact_file_session-2_script');
  assert.match(read.content, /print/);
  assert.equal(read.artifact.absolute_path, '[redacted:path]');
  assert.equal(JSON.stringify(read).includes(artifactPath), false);

  await service.saveArtifact('session-2', 'artifact_file_session-2_script', 'print("updated")\n');
  assert.equal(fs.readFileSync(artifactPath, 'utf8'), 'print("updated")\n');
});

test('ArtifactWorkspaceService redacts paths from renderer-facing mutation results', async () => {
  const workspaceRoot = createWorkspaceRoot();
  const artifactPath = path.join(workspaceRoot, '.jenny', 'artifacts', 'session-safe', 'note.md');
  const filesystemPaths = [];
  let status = 'available';
  const service = new ArtifactWorkspaceService({
    openPathImpl: async (targetPath) => { filesystemPaths.push(targetPath); return ''; },
    showItemInFolderImpl: (targetPath) => { filesystemPaths.push(targetPath); },
  });
  service.resolveArtifact = async () => ({
    artifact_id: 'artifact_safe_note',
    absolute_path: artifactPath,
    file_name: 'note.md',
    editable: true,
    status,
  });
  service._writeFileAtomic = async (targetPath) => { filesystemPaths.push(targetPath); };
  service.getSessionScratchDir = async () => path.dirname(artifactPath);
  service._assertRealPathInside = async (targetPath) => { filesystemPaths.push(targetPath); };
  service._fs = { rm: async (targetPath) => { filesystemPaths.push(targetPath); } };

  const results = [
    await service.saveArtifact('session-safe', 'artifact_safe_note', 'updated'),
    await service.revealArtifact('session-safe', 'artifact_safe_note'),
    await service.openArtifactExternal('session-safe', 'artifact_safe_note'),
  ];
  status = 'missing';
  results.push(await service.deleteArtifact('session-safe', 'artifact_safe_note'));
  status = 'available';
  results.push(await service.deleteArtifact('session-safe', 'artifact_safe_note'));

  assert.equal(results.every((result) => result.artifact.absolute_path === '[redacted:path]'), true);
  assert.equal(JSON.stringify(results).includes(artifactPath), false);
  assert.equal(filesystemPaths.every((targetPath) => targetPath === artifactPath), true);
});

test('ArtifactWorkspaceService resolves redacted artifact paths from safe display path', async () => {
  const workspaceRoot = createWorkspaceRoot();
  const artifactPath = path.join(workspaceRoot, '.jenny', 'artifacts', 'session-redacted', 'note.md');
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, 'redacted path recovery', 'utf8');

  const service = new ArtifactWorkspaceService({
    configService: {
      getState() {
        return { toolsWorkspaceRoot: workspaceRoot };
      },
    },
    sessionMessageReader: async () => ([{
      id: 'tool-result-redacted',
      kind: 'tool_result',
      tool_result: {
        generated_artifacts: [{
          artifact_id: 'artifact_redacted_note',
          artifact_kind: 'document',
          title: 'Redacted Note',
          file_name: 'note.md',
          display_path: '.jenny/artifacts/session-redacted/note.md',
          absolute_path: '[redacted:path]',
          language: 'markdown',
          editable: true,
          status: 'available',
        }],
      },
    }]),
  });

  const read = await service.readArtifact('session-redacted', 'artifact_redacted_note');
  assert.equal(read.content, 'redacted path recovery');
  assert.equal(read.artifact.absolute_path, '[redacted:path]');
  assert.equal(JSON.stringify(read).includes(artifactPath), false);
});

test('ArtifactWorkspaceService reads redacted image artifacts as bounded data URLs', async () => {
  const workspaceRoot = createWorkspaceRoot();
  const png = makePngBuffer(8, 6);
  const artifactPath = path.join(workspaceRoot, '.jenny', 'artifacts', 'session-redacted-image', 'preview.png');
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, png);

  const service = new ArtifactWorkspaceService({
    configService: {
      getState() {
        return { toolsWorkspaceRoot: workspaceRoot };
      },
    },
    sessionMessageReader: async () => ([{
      id: 'tool-result-redacted-image',
      kind: 'tool_result',
      tool_result: {
        generated_artifacts: [{
          artifact_id: 'artifact_redacted_image',
          artifact_kind: 'image',
          title: 'Redacted Image',
          file_name: 'preview.png',
          display_path: '.jenny/artifacts/session-redacted-image/preview.png',
          absolute_path: '[redacted:path]',
          mime_type: 'image/png',
          editable: false,
          status: 'available',
        }],
      },
    }]),
  });

  const read = await service.readArtifact('session-redacted-image', 'artifact_redacted_image');
  assert.equal(read.content, '');
  assert.equal(read.artifact.absolute_path, '[redacted:path]');
  assert.equal(JSON.stringify(read).includes(artifactPath), false);
  assert.equal(read.asset_data_url, `data:image/png;base64,${png.toString('base64')}`);
});

test('ArtifactWorkspaceService emits structured CMP artifact codes for workspace and lookup failures', async () => {
  const service = new ArtifactWorkspaceService({
    configService: {
      getState() {
        return { toolsWorkspaceRoot: '' };
      },
    },
  });

  await assert.rejects(
    () => service.createArtifact('session-no-root', {
      artifact_kind: 'document',
      title: 'No Root',
      content: 'nope',
    }),
    (error) => error.code === 'CMP-ARTIFACT-0001'
  );

  const workspaceRoot = createWorkspaceRoot();
  const lookupService = new ArtifactWorkspaceService({
    configService: {
      getState() {
        return { toolsWorkspaceRoot: workspaceRoot };
      },
    },
    sessionMessageReader: async () => [],
  });

  await assert.rejects(
    () => lookupService.readArtifact('session-missing', 'artifact_missing'),
    (error) => error.code === 'CMP-ARTIFACT-0010'
  );
});

test('ArtifactWorkspaceService refuses a workspace root that is Jenny\'s own .jenny state directory', async () => {
  const workspaceRoot = createWorkspaceRoot();
  const stateDirRoot = path.join(workspaceRoot, '.jenny');
  const service = new ArtifactWorkspaceService({
    configService: {
      getState() {
        return { toolsWorkspaceRoot: stateDirRoot };
      },
    },
  });

  await assert.rejects(
    () => service.createArtifact('session-state-dir', {
      artifact_kind: 'document',
      title: 'Should not write',
      content: 'nope',
    }),
    (error) => error.code === 'CMP-ARTIFACT-0016'
  );
  // The state-dir guard fires before any directory-existence check: this
  // root was never created on disk.
  assert.equal(fs.existsSync(stateDirRoot), false);

  // Only an exact final .jenny segment is rejected; a real directory that
  // merely starts with .jenny is a normal (if unusual) workspace root.
  const lookalikeRoot = path.join(workspaceRoot, '.jenny-archive');
  fs.mkdirSync(lookalikeRoot, { recursive: true });
  const lookalikeService = new ArtifactWorkspaceService({
    configService: {
      getState() {
        return { toolsWorkspaceRoot: lookalikeRoot };
      },
    },
  });
  const created = await lookalikeService.createArtifact('session-state-dir-lookalike', {
    artifact_kind: 'document',
    title: 'Should write',
    content: 'ok',
  });
  assert.equal(created.metadata.status, 'available');
});

test('ArtifactWorkspaceService serializes concurrent saves for the same artifact', async () => {
  const workspaceRoot = createWorkspaceRoot();
  const artifactPath = path.join(workspaceRoot, '.jenny', 'artifacts', 'session-save-lock', 'doc.md');
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, 'initial', 'utf8');
  const writes = [];
  const service = new ArtifactWorkspaceService({
    configService: {
      getState() {
        return { toolsWorkspaceRoot: workspaceRoot };
      },
    },
    fsImpl: {
      ...fs.promises,
      async writeFile(targetPath, content, encoding) {
        writes.push({ targetPath, content: String(content) });
        if (String(content).includes('first')) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return fs.promises.writeFile(targetPath, content, encoding);
      },
    },
    sessionMessageReader: async () => ([{
      id: 'tool-result-save-lock',
      kind: 'tool_result',
      tool_result: {
        generated_artifacts: [{
          artifact_id: 'artifact_save_lock',
          artifact_kind: 'document',
          title: 'Doc',
          file_name: 'doc.md',
          display_path: '.jenny/artifacts/session-save-lock/doc.md',
          absolute_path: artifactPath,
          language: 'markdown',
          editable: true,
          status: 'available',
        }],
      },
    }]),
  });

  await Promise.all([
    service.saveArtifact('session-save-lock', 'artifact_save_lock', 'first'),
    service.saveArtifact('session-save-lock', 'artifact_save_lock', 'second'),
  ]);

  assert.equal(fs.readFileSync(artifactPath, 'utf8'), 'second');
  assert.equal(
    writes.filter((entry) => entry.targetPath.includes('.tmp-')).length,
    2,
    'each of the two concurrent saves writes exactly one atomic tmp file (no extra writes)'
  );
});

test('ArtifactWorkspaceService rejects artifact metadata that escapes the workspace root', async () => {
  const workspaceRoot = createWorkspaceRoot();
  const outsideRoot = createTrackedTempDir('jenny-artifacts-outside-');
  const outsidePath = path.join(outsideRoot, 'outside-artifact.txt');
  fs.writeFileSync(outsidePath, 'bad', 'utf8');

  const service = new ArtifactWorkspaceService({
    configService: {
      getState() {
        return { toolsWorkspaceRoot: workspaceRoot };
      },
    },
    sessionMessageReader: async () => ([
      {
        id: 'tool-result-escape',
        kind: 'tool_result',
        tool_result: {
          generated_artifacts: [{
            artifact_id: 'artifact_escape',
            artifact_kind: 'document',
            title: 'Escape',
            file_name: 'escape.txt',
            display_path: '.jenny/artifacts/session-3/escape.txt',
            absolute_path: outsidePath,
            language: 'plaintext',
            editable: true,
            status: 'available',
          }],
        },
      },
    ]),
  });

  await assert.rejects(
    () => service.readArtifact('session-3', 'artifact_escape'),
    /outside the configured workspace root/i
  );
});

test('ArtifactWorkspaceService rejects metadata that points to non-scratch workspace files', async () => {
  const workspaceRoot = createWorkspaceRoot();
  const repoFilePath = path.join(workspaceRoot, 'src', 'app.js');
  fs.mkdirSync(path.dirname(repoFilePath), { recursive: true });
  fs.writeFileSync(repoFilePath, 'export const ready = true;\n', 'utf8');

  const service = new ArtifactWorkspaceService({
    configService: {
      getState() {
        return { toolsWorkspaceRoot: workspaceRoot };
      },
    },
    sessionMessageReader: async () => ([
      {
        id: 'tool-result-repo-file',
        kind: 'tool_result',
        tool_result: {
          generated_artifacts: [{
            artifact_id: 'artifact_repo_file',
            artifact_kind: 'script',
            title: 'Repo File',
            file_name: 'app.js',
            display_path: 'src/app.js',
            absolute_path: repoFilePath,
            language: 'javascript',
            editable: true,
            status: 'available',
          }],
        },
      },
    ]),
  });

  await assert.rejects(
    () => service.readArtifact('session-4', 'artifact_repo_file'),
    /outside the session scratch directory/i
  );
});

test('ArtifactWorkspaceService rejects unsafe extension overrides', async () => {
  const workspaceRoot = createWorkspaceRoot();
  const service = new ArtifactWorkspaceService({
    configService: {
      getState() {
        return { toolsWorkspaceRoot: workspaceRoot };
      },
    },
  });

  await assert.rejects(
    () => service.createArtifact('session-unsafe-extension', {
      artifact_kind: 'document',
      title: 'Unsafe',
      content: 'nope',
      extension: '../../escape',
    }),
    /simple file extension/i
  );
});

test('ArtifactWorkspaceService refuses to reveal or externally open dangerous extensions', async () => {
  const workspaceRoot = createWorkspaceRoot();
  const artifactPath = path.join(workspaceRoot, '.jenny', 'artifacts', 'session-dangerous', 'run-me.bat');
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, '@echo off\n', 'utf8');
  const openedPaths = [];
  const revealedPaths = [];
  const service = new ArtifactWorkspaceService({
    configService: {
      getState() {
        return { toolsWorkspaceRoot: workspaceRoot };
      },
    },
    openPathImpl: async (targetPath) => {
      openedPaths.push(targetPath);
      return '';
    },
    showItemInFolderImpl: (targetPath) => {
      revealedPaths.push(targetPath);
    },
    sessionMessageReader: async () => ([{
      id: 'tool-result-dangerous',
      kind: 'tool_result',
      tool_result: {
        generated_artifacts: [{
          artifact_id: 'artifact_dangerous',
          artifact_kind: 'script',
          title: 'Dangerous',
          file_name: 'run-me.bat',
          display_path: '.jenny/artifacts/session-dangerous/run-me.bat',
          absolute_path: artifactPath,
          language: 'shell',
          editable: true,
          status: 'available',
        }],
      },
    }]),
  });

  await assert.rejects(
    () => service.openArtifactExternal('session-dangerous', 'artifact_dangerous'),
    /dangerous|cannot be opened/i
  );
  await assert.rejects(
    () => service.revealArtifact('session-dangerous', 'artifact_dangerous'),
    /dangerous|cannot be revealed/i
  );
  assert.deepEqual(openedPaths, []);
  assert.deepEqual(revealedPaths, []);
});

test('ArtifactWorkspaceService rejects missing artifacts below symlinked parents', async () => {
  const workspaceRoot = createWorkspaceRoot();
  const outsideRoot = createTrackedTempDir('jenny-artifacts-symlink-target-');
  const scratchDir = path.join(workspaceRoot, '.jenny', 'artifacts', 'session-symlink');
  const linkParent = path.join(scratchDir, 'linked-parent');
  const missingArtifactPath = path.join(linkParent, 'missing.txt');
  fs.mkdirSync(scratchDir, { recursive: true });
  fs.symlinkSync(outsideRoot, linkParent, process.platform === 'win32' ? 'junction' : 'dir');

  const service = new ArtifactWorkspaceService({
    configService: {
      getState() {
        return { toolsWorkspaceRoot: workspaceRoot };
      },
    },
    sessionMessageReader: async () => ([{
      id: 'tool-result-symlink-missing',
      kind: 'tool_result',
      tool_result: {
        generated_artifacts: [{
          artifact_id: 'artifact_symlink_missing',
          artifact_kind: 'document',
          title: 'Missing via link',
          file_name: 'missing.txt',
          display_path: '.jenny/artifacts/session-symlink/linked-parent/missing.txt',
          absolute_path: missingArtifactPath,
          language: 'plaintext',
          editable: true,
          status: 'available',
        }],
      },
    }]),
  });

  await assert.rejects(
    () => service.resolveArtifact('session-symlink', 'artifact_symlink_missing'),
    /escapes the session scratch directory/i
  );
});

test('ArtifactWorkspaceService refuses reveal and open actions for missing artifacts', async () => {
  const workspaceRoot = createWorkspaceRoot();
  const missingArtifactPath = path.join(
    workspaceRoot,
    '.jenny',
    'artifacts',
    'session-missing-action',
    'missing.md'
  );
  fs.mkdirSync(path.dirname(missingArtifactPath), { recursive: true });
  const openedPaths = [];
  const revealedPaths = [];
  const service = new ArtifactWorkspaceService({
    configService: {
      getState() {
        return { toolsWorkspaceRoot: workspaceRoot };
      },
    },
    openPathImpl: async (targetPath) => {
      openedPaths.push(targetPath);
      return '';
    },
    showItemInFolderImpl: (targetPath) => {
      revealedPaths.push(targetPath);
    },
    sessionMessageReader: async () => ([{
      id: 'tool-result-missing-action',
      kind: 'tool_result',
      tool_result: {
        generated_artifacts: [{
          artifact_id: 'artifact_missing_action',
          artifact_kind: 'document',
          title: 'Missing',
          file_name: 'missing.md',
          display_path: '.jenny/artifacts/session-missing-action/missing.md',
          absolute_path: missingArtifactPath,
          language: 'markdown',
          editable: true,
          status: 'available',
        }],
      },
    }]),
  });

  await assert.rejects(
    () => service.openArtifactExternal('session-missing-action', 'artifact_missing_action'),
    /unavailable/i
  );
  await assert.rejects(
    () => service.revealArtifact('session-missing-action', 'artifact_missing_action'),
    /unavailable/i
  );
  assert.deepEqual(openedPaths, []);
  assert.deepEqual(revealedPaths, []);
});

test('ArtifactWorkspaceService marks oversized artifacts read-only and rejects oversized inline saves', async () => {
  const workspaceRoot = createWorkspaceRoot();
  const service = new ArtifactWorkspaceService({
    configService: {
      getState() {
        return { toolsWorkspaceRoot: workspaceRoot };
      },
    },
  });
  const largeContent = 'a'.repeat(600 * 1024);

  const created = await service.createArtifact('session-large-artifact', {
    artifact_kind: 'document',
    title: 'Large Scratch Plan',
    content: largeContent,
    extension: '.md',
  });
  assert.equal(created.metadata.editable, false);

  const readOnlyArtifactPath = path.join(
    workspaceRoot,
    '.jenny',
    'artifacts',
    'session-large-artifact',
    created.metadata.file_name
  );

  const readOnlyService = new ArtifactWorkspaceService({
    configService: {
      getState() {
        return { toolsWorkspaceRoot: workspaceRoot };
      },
    },
    sessionMessageReader: async () => ([
      {
        id: 'tool-result-large-file',
        kind: 'tool_result',
        tool_result: {
          generated_artifacts: [{
            artifact_id: created.metadata.artifact_id,
            artifact_kind: 'document',
            title: 'Large Scratch Plan',
            file_name: created.metadata.file_name,
            display_path: created.metadata.display_path,
            absolute_path: readOnlyArtifactPath,
            language: 'markdown',
            editable: true,
            status: 'available',
          }],
        },
      },
    ]),
  });

  const read = await readOnlyService.readArtifact(
    'session-large-artifact',
    created.metadata.artifact_id
  );
  assert.equal(read.artifact.editable, false);
  assert.equal(read.content, '');

  await assert.rejects(
    () => readOnlyService.saveArtifact(
      'session-large-artifact',
      created.metadata.artifact_id,
      largeContent
    ),
    /not editable in Jenny|512 KB inline editor limit/i
  );
});
