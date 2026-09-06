'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MAX_ITEM_CONTEXT_BYTES } = require('../../../services/plugins/data/declarative-content-validator');
const { MAX_DECLARATIVE_JSON_BYTES } = require(
  '../../../services/plugins/package/local-package-intake'
);
const { CHECKS, runChecks } = require('../../../scripts/plugins/validate/plugin-source-checks');
const { loadPluginSource } = require('../../../scripts/plugins/validate/plugin-source-loader');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const EXAMPLES = path.join(ROOT, 'docs', 'plugins', 'examples', 'declarative');
const PROMPT_EXAMPLE = path.join(ROOT, 'docs', 'plugins', 'examples', 'prompt-plugin');

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function tempCopy(example) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-validate-folder-'));
  const target = path.join(temp, 'plugin');
  fs.cpSync(path.join(EXAMPLES, example), target, { recursive: true });
  return { temp, target };
}

function readManifest(target) {
  return JSON.parse(fs.readFileSync(path.join(target, 'plugin.json'), 'utf8'));
}

function writeManifest(target, manifest) {
  fs.writeFileSync(path.join(target, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function contributionFile(target, manifest, index = 0) {
  return path.join(target, ...manifest.contributions[index].content_path.split('/'));
}

async function validateFolder(target) {
  return runChecks(await loadPluginSource(target));
}

function rows(result, id) {
  return result.checks.filter((row) => row.id === id);
}

function stage7PanelFolder(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-validate-panel-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const target = path.join(temp, 'plugin');
  const assetBytes = Buffer.from('<!doctype html><title>Panel</title>', 'utf8');
  const content = {
    content_schema_version: 5,
    view_kind: 'panel',
    entry_path: 'view/panel.html',
    entry_sha256: digest(assetBytes),
    assets: [{ path: 'view/panel.html', sha256: digest(assetBytes),
      media_type: 'text/html', bytes: assetBytes.length }],
    allowed_bridge_operations: [], allowed_event_topics: [], artifact_kinds: [], provider_ref: '',
  };
  const contentBytes = Buffer.from(JSON.stringify(content));
  const manifest = {
    manifest_schema_version: 5, publisher_id: 'example-labs', plugin_id: 'example-panel',
    name: 'Example Panel', version: '1.0.0',
    contract_versions: {
      manifest: 5, view_content: 5, provider_descriptor: 5, generation: 5,
      runtime_snapshot: 5, view_call: 5, view_result: 5, view_event: 5,
    },
    contributions: [{ kind: 'panel', contribution_id: 'panel-main', name: 'Main Panel',
      content_path: 'content/panel.json', content_sha256: digest(contentBytes) }],
    dependencies: [], requested_permissions: [],
  };
  fs.mkdirSync(path.join(target, 'content'), { recursive: true });
  fs.mkdirSync(path.join(target, 'view'), { recursive: true });
  fs.writeFileSync(path.join(target, 'plugin.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(target, 'content', 'panel.json'), contentBytes);
  fs.writeFileSync(path.join(target, 'view', 'panel.html'), assetBytes);
  return target;
}

for (const example of fs.readdirSync(EXAMPLES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name)) {
  test(`declarative ${example} example validates cleanly`, async () => {
    const result = await validateFolder(path.join(EXAMPLES, example));
    assert.equal(result.ok, true);
    assert.equal(rows(result, 'archive-structure')[0].status, 'skip');
    assert.equal(rows(result, 'signature-bundle-shape')[0].status, 'skip');
    assert.equal(rows(result, 'developer-profile-intake')[0].status, 'skip');
  });
}

test('theme semantic validation rejects a non-host V2 token with a path', async (t) => {
  const { temp, target } = tempCopy('theme');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const manifest = readManifest(target);
  const contentPath = contributionFile(target, manifest);
  const content = {
    content_schema_version: 2,
    publisher_id: manifest.publisher_id,
    plugin_id: manifest.plugin_id,
    contribution_id: manifest.contributions[0].contribution_id,
    payload: {
      kind: 'theme',
      tokens: [
        ['surface.chat', '#000000'], ['surface.message_user', '#000000'],
        ['surface.message_assistant', '#000000'], ['surface.tool', '#000000'],
        ['text.primary', '#FFFFFF'], ['text.muted', '#B3B3B3'], ['text.link', '#66CCFF'],
        ['border.default', '#777777'], ['border.focus', '#00FFFF'],
        ['color.accent', '#005FCC'], ['font.plugin_owned', '#FFFFFF'],
      ].map(([token, value]) => ({ token, value })),
    },
  };
  const bytes = Buffer.from(`${JSON.stringify(content, null, 2)}\n`);
  fs.writeFileSync(contentPath, bytes);
  manifest.contributions[0].content_sha256 = digest(bytes);
  writeManifest(target, manifest);

  const result = await validateFolder(target);
  const semantic = rows(result, 'content-semantics')[0];
  assert.equal(rows(result, 'content-schema')[0].status, 'pass');
  assert.equal(semantic.status, 'fail');
  assert.equal(semantic.problem, 'theme_token_set_incomplete');
  assert.equal(semantic.path, 'payload.tokens');
});

test('exact-byte digest failure does not invalidate content schema', async (t) => {
  const { temp, target } = tempCopy('skill');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const manifest = readManifest(target);
  fs.appendFileSync(contributionFile(target, manifest), ' ');

  const result = await validateFolder(target);
  assert.equal(rows(result, 'content-schema')[0].status, 'pass');
  assert.equal(rows(result, 'content-digests')[0].status, 'fail');
});

test('invalid manifest skips checks three through seven', async (t) => {
  const { temp, target } = tempCopy('skill');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const manifest = readManifest(target);
  delete manifest.plugin_id;
  writeManifest(target, manifest);

  const result = await validateFolder(target);
  assert.equal(rows(result, 'manifest-schema')[0].status, 'fail');
  for (const id of ['display-strings', 'content-schema', 'content-semantics', 'content-digests', 'budgets']) {
    assert.deepEqual(rows(result, id).map((row) => row.status), ['skip']);
    assert.equal(rows(result, id)[0].problem, 'manifest invalid');
  }
});

test('display string check owns bidi-control failures', async (t) => {
  const { temp, target } = tempCopy('skill');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const manifest = readManifest(target);
  manifest.name = 'Unsafe\u202eName';
  writeManifest(target, manifest);

  const result = await validateFolder(target);
  assert.equal(rows(result, 'manifest-schema')[0].status, 'pass');
  assert.equal(rows(result, 'display-strings')[0].status, 'fail');
  assert.match(rows(result, 'display-strings')[0].problem, /forbidden_codepoint/);
});

test('budgets reject an oversized skill body', async (t) => {
  const { temp, target } = tempCopy('skill');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const manifest = readManifest(target);
  const contentPath = contributionFile(target, manifest);
  const content = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
  content.payload.instructions = 'x'.repeat(MAX_ITEM_CONTEXT_BYTES + 1);
  const bytes = Buffer.from(JSON.stringify(content));
  fs.writeFileSync(contentPath, bytes);
  manifest.contributions[0].content_sha256 = digest(bytes);
  writeManifest(target, manifest);

  const result = await validateFolder(target);
  assert.equal(rows(result, 'budgets')[0].status, 'fail');
  assert.match(rows(result, 'budgets')[0].problem, /item context/);
});

test('oversized folder content is not read and still fails budgets', async (t) => {
  const { temp, target } = tempCopy('skill');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const manifest = readManifest(target);
  fs.writeFileSync(contributionFile(target, manifest), Buffer.alloc(MAX_DECLARATIVE_JSON_BYTES + 1, 0x20));

  const source = await loadPluginSource(target);
  assert.equal(source.contributions[0].bytes, null);
  assert.equal(source.contributions[0].byteLength, MAX_DECLARATIVE_JSON_BYTES + 1);
  assert.equal(source.contributions[0].parseError.reason, 'content_too_large');
  const result = await runChecks(source);
  assert.equal(rows(result, 'budgets')[0].status, 'fail');
});

test('parent directory links cannot redirect content or signature reads outside root', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-validate-linked-parent-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const target = path.join(temp, 'plugin');
  const outsideContent = path.join(temp, 'outside-content');
  const outsideMetadata = path.join(temp, 'outside-metadata');
  fs.cpSync(PROMPT_EXAMPLE, target, { recursive: true });
  fs.cpSync(path.join(target, 'content'), outsideContent, { recursive: true });
  fs.cpSync(path.join(target, 'META-JENNY'), outsideMetadata, { recursive: true });
  fs.rmSync(path.join(target, 'content'), { recursive: true });
  fs.rmSync(path.join(target, 'META-JENNY'), { recursive: true });
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    fs.symlinkSync(outsideContent, path.join(target, 'content'), linkType);
    fs.symlinkSync(outsideMetadata, path.join(target, 'META-JENNY'), linkType);
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('directory symlink creation requires additional permission');
      return;
    }
    throw error;
  }

  const source = await loadPluginSource(target);
  assert.equal(source.contributions[0].bytes, null);
  assert.equal(source.contributions[0].parseError.reason, 'content_path_unsafe');
  assert.equal(source.signatureBundleBytes, null);
  assert.equal(source.signatureBundleError.reason, 'signature_bundle_file_invalid');
  const result = await runChecks(source);
  assert.equal(rows(result, 'content-schema')[0].status, 'fail');
  assert.equal(rows(result, 'signature-bundle-shape')[0].status, 'fail');
});

test('Stage-7 panel content uses the view contract and skips declarative semantics', async (t) => {
  const result = await validateFolder(stage7PanelFolder(t));
  assert.equal(rows(result, 'content-schema')[0].status, 'pass');
  assert.equal(rows(result, 'content-semantics')[0].status, 'skip');
  assert.equal(rows(result, 'content-semantics')[0].problem, 'not declarative content');
});

test('folder traversal is a content-schema failure and never reads outside root', async (t) => {
  const { temp, target } = tempCopy('skill');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const manifest = readManifest(target);
  manifest.contributions[0].content_path = '../../x.json';
  writeManifest(target, manifest);
  const sentinel = path.resolve(target, '..', '..', 'x.json');
  fs.writeFileSync(sentinel, '{"sentinel":true}');
  const observed = [];
  const originalRead = fs.readFileSync;
  fs.readFileSync = function observedRead(filePath, ...args) {
    observed.push(path.resolve(filePath));
    return originalRead.call(this, filePath, ...args);
  };
  let source;
  try { source = await loadPluginSource(target); }
  finally { fs.readFileSync = originalRead; }
  const result = await runChecks(source);

  assert.equal(observed.includes(sentinel), false);
  assert.equal(rows(result, 'manifest-schema')[0].status, 'pass');
  const schema = rows(result, 'content-schema')[0];
  assert.equal(schema.status, 'fail');
  assert.equal(schema.hint, 'content_path must be a relative path inside the plugin folder');
});

test('emitted check ids retain the documented order', async () => {
  const result = await validateFolder(path.join(EXAMPLES, 'command'));
  const emitted = result.checks.map((row) => row.id)
    .filter((id, index, all) => index === 0 || id !== all[index - 1]);
  assert.deepEqual(emitted, CHECKS.map((check) => check.id));
});
