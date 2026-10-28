'use strict';

// The shared OS-opener allowlist (services/shared/external-open-policy.js) and
// its two main-process enforcement points: WorkspaceIdeService.openInDefaultApp
// and ArtifactWorkspaceService.openArtifactExternal / revealArtifact. Both
// must refuse with the typed CMP-ARTIFACT-0013 before the injected shell
// opener is ever called.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');
const {
  EXTERNAL_OPEN_ALLOWED_EXTENSIONS,
  EXTERNAL_OPEN_REFUSED_CODE,
  externalOpenExtension,
  isExternalOpenAllowed,
} = require('../services/shared/external-open-policy');
const { WorkspaceIdeService } = require('../services/workspace-ide-service');
const { WorkspaceRootCoordinator } = require('../services/workspace-root-coordinator');
const { ArtifactWorkspaceService } = require('../services/artifact-workspace-service');
const { ARTIFACT_ERROR_CODES } = require('../services/artifact-workspace-errors');

// Executable or script-capable types the old 27-entry artifact block list let
// through (F3), plus html/svg/sh and the classic executables (F2).
const REFUSED_EXTENSIONS = [
  'py', 'pyw', 'pyz', 'pif', 'msc', 'chm', 'hlp', 'appref-ms', 'application',
  'settingcontent-ms', 'scf', 'ws', 'wsc', 'psd1', 'ps1xml', 'inf', 'xll',
  'xlam', 'dotm', 'library-ms', 'search-ms', 'searchconnector-ms', 'diagcab',
  'msix', 'appx', 'appinstaller', 'iso', 'vhd', 'vhdx', 'img', 'cab', 'rdp',
  'theme', 'themepack', 'website', 'mht', 'xbap', 'gadget', 'one', 'wsb',
  'sct', 'shb', 'shs', 'vb', 'html', 'htm', 'svg', 'sh',
  'exe', 'scr', 'bat', 'cmd', 'com', 'js', 'vbs', 'ps1', 'msi', 'lnk', 'url',
  'hta', 'jar', 'reg', 'cpl', 'dll', 'zip',
];

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('external-open policy allows only passive document/media types', () => {
  for (const extension of EXTERNAL_OPEN_ALLOWED_EXTENSIONS) {
    assert.equal(isExternalOpenAllowed(`docs/file${extension}`), true, extension);
    assert.equal(isExternalOpenAllowed(`C:\\ws\\FILE${extension.toUpperCase()}`), true, extension);
  }
  for (const extension of REFUSED_EXTENSIONS) {
    assert.equal(isExternalOpenAllowed(`bin/tool.${extension}`), false, extension);
  }
  for (const value of ['', 'Makefile', 'bin/tool', '.md', 'notes.md.exe', 'notes.md.', 'notes.md ',
    'tool.exe:notes.md', 'notes.md::$DATA', 'C:\\ws\\run.exe', null, undefined]) {
    assert.equal(isExternalOpenAllowed(value), false, String(value));
  }
  assert.equal(externalOpenExtension('a/b/Report.PDF'), '.pdf');
  assert.equal(externalOpenExtension('a.b/noext'), '');
  assert.equal(EXTERNAL_OPEN_REFUSED_CODE, ARTIFACT_ERROR_CODES.DANGEROUS_EXTENSION);
});

function createWorkspaceService(root, openPathImpl) {
  const rootCoordinator = new WorkspaceRootCoordinator({
    initialRootPath: root,
    normalizeRootPath: (value) => String(value || ''),
    rootIdFactory: (value) => (value ? `root:${String(value).toLowerCase()}` : null),
  });
  return new WorkspaceIdeService({
    configService: {
      getToolsWorkspaceRoot: () => root,
      getState: () => ({ toolsWorkspaceRoot: root }),
      getWorkspaceRootStatus: () => ({ state: 'ready', message: '' }),
    },
    rootContextProvider: () => rootCoordinator,
    openPathImpl,
  });
}

test('openInDefaultApp refuses executables server-side and never calls the shell opener', async () => {
  const root = createTrackedTempDir('jenny-external-open-');
  fs.mkdirSync(path.join(root, 'bin'));
  fs.mkdirSync(path.join(root, 'scripts'));
  const refused = ['bin/tool.exe', 'scripts/x.scr', 'scripts/run.py', 'scripts/page.html', 'bin/tool'];
  for (const relPath of refused) fs.writeFileSync(path.join(root, relPath), 'MZ\0payload');
  const opened = [];
  const service = createWorkspaceService(root, async (target) => { opened.push(target); return ''; });

  for (const relPath of refused) {
    await assert.rejects(service.openInDefaultApp({ path: relPath }), (error) => {
      assert.equal(error.code, EXTERNAL_OPEN_REFUSED_CODE, relPath);
      assert.equal(error.error_code, EXTERNAL_OPEN_REFUSED_CODE, relPath);
      return true;
    });
  }
  assert.deepEqual(opened, [], 'shell.openPath must never see a refused type');
});

test('openInDefaultApp still opens an allowlisted document', async () => {
  const root = createTrackedTempDir('jenny-external-open-');
  fs.writeFileSync(path.join(root, 'notes.md'), '# notes\n', 'utf8');
  const opened = [];
  const service = createWorkspaceService(root, async (target) => { opened.push(target); return ''; });

  assert.deepEqual(await service.openInDefaultApp({ path: 'notes.md' }), { path: 'notes.md', opened: true });
  assert.deepEqual(opened, [fs.realpathSync(path.join(root, 'notes.md'))]);
});

function createArtifactService(fileName, artifactKind, mimeType) {
  const calls = { opened: [], revealed: [] };
  const service = new ArtifactWorkspaceService({
    openPathImpl: async (target) => { calls.opened.push(target); return ''; },
    showItemInFolderImpl: (target) => { calls.revealed.push(target); },
  });
  service._resolveArtifact = async () => ({
    artifact_id: 'artifact_policy',
    artifact_kind: artifactKind,
    mime_type: mimeType,
    file_name: fileName,
    absolute_path: path.join('C:\\ws\\.jenny\\artifacts\\session-policy', fileName),
    status: 'available',
  });
  return { service, calls };
}

test('artifact external open refuses every non-allowlisted extension; reveal only selects the file', async () => {
  for (const extension of REFUSED_EXTENSIONS) {
    const { service, calls } = createArtifactService(`artifact.${extension}`, 'document', 'text/plain');
    await assert.rejects(service.openArtifactExternal('session-policy', 'artifact_policy'), (error) => {
      assert.equal(error.code, ARTIFACT_ERROR_CODES.DANGEROUS_EXTENSION, `open .${extension}`);
      return true;
    });
    const revealed = await service.revealArtifact('session-policy', 'artifact_policy');
    assert.equal(revealed.ok, true, `reveal .${extension}`);
    assert.deepEqual(calls.opened, [], extension);
    assert.equal(calls.revealed.length, 1, extension);
  }
});

test('artifact external open still opens markdown and png artifacts', async () => {
  for (const [fileName, kind, mime] of [['note.md', 'document', 'text/markdown'], ['image.png', 'image', 'image/png']]) {
    const { service, calls } = createArtifactService(fileName, kind, mime);
    const result = await service.openArtifactExternal('session-policy', 'artifact_policy');
    assert.equal(result.ok, true, fileName);
    assert.equal(calls.opened.length, 1, fileName);
  }
});
