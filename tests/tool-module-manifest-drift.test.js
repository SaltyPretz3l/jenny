'use strict';

// withManifestSchema overrides parameters and policy fields but NOT the
// description, so a module literal that drifts from the manifest is what the
// registry (and every consumer of tool.description) actually serves. These
// modules take both from the manifest via tool-result.manifestSchema; this
// fails if a literal is reintroduced and disagrees.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const manifest = require('../services/tools/tool-manifest.json');

const BUILTIN = path.join(__dirname, '..', 'services', 'tools', 'builtin');
const MODULES = [
  'ask-user-tool', 'automation-list-tool', 'automation-read-tool', 'complete-session-handoff-tool',
  'home-tool', 'image-generate-tool', 'jenny-status-tool', 'project-notes-tool',
  'propose-command-tool', 'propose-git-action-tool', 'propose-session-tool', 'session-message-tool',
  'task-board-tool', 'verify-tool', 'workspace-present-tool', 'worktree-create-tool',
  'worktree-delete-tool', 'worktree-list-tool', 'worktree-select-tool',
];

function toolsOf(file) {
  const exported = require(path.join(BUILTIN, file));
  if (Array.isArray(exported)) return exported;
  if (typeof exported.name === 'string') return [exported];
  return Object.values(exported).filter((value) => value && typeof value.name === 'string' && typeof value.execute === 'function');
}

const byName = new Map(manifest.tools.map((entry) => [entry.name, entry]));
const files = [...MODULES, 'session-runtime-tools', 'conversations-tool'];

test('fenced builtin modules serve the manifest description and schema', () => {
  let checked = 0;
  for (const file of files) {
    for (const tool of toolsOf(file)) {
      const entry = byName.get(tool.name);
      assert.ok(entry, `${tool.name} is in the manifest`);
      assert.equal(entry.owner, 'electron', `${tool.name} is Electron-owned`);
      assert.equal(tool.description, entry.description, `${file}: ${tool.name} description drifts from the manifest`);
      assert.deepEqual(tool.parameters, entry.parameters, `${file}: ${tool.name} parameters drift from the manifest`);
      checked += 1;
    }
  }
  assert.equal(checked, 25);
});

test('fenced builtin modules carry no description or parameters literal', () => {
  for (const file of files) {
    const source = fs.readFileSync(path.join(BUILTIN, `${file}.js`), 'utf8');
    assert.doesNotMatch(source, /^\s+description:\s*['"`]/mu, `${file} has a description literal`);
    assert.doesNotMatch(source, /^\s+parameters:\s*[{a-zA-Z]/mu, `${file} has a parameters literal`);
    assert.match(source, /manifestSchema\(/u, `${file} reads its schema from the manifest`);
  }
});
