'use strict';

// Pinned NInfer provenance: the runtime zip and model artifact are only ever
// fetched from URLs derived from validated fields, never from the JSON itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadNinferRuntimeManifest,
  loadNinferArtifactManifest,
  runtimeDownloadUrl,
  artifactDownloadUrl,
  isHuggingFaceDownloadHost,
  NINFER_RUNTIME_DOWNLOAD_HOSTS,
} = require('../services/ninfer-manifests');
const { GITHUB_UPDATE_HOSTS } = require('../services/github-release-client');

const RUNTIME_SHA = 'd05f9df73feb43b47de23cb09ee9b9e79b040afb8d73ae30a0f4c93dea379060';
const ARTIFACT_SHA = '74d2c57145e6ff11d1d2faa79594477f9bc903a611af1fb20218189fbbb77d82';
const RUNTIME_URL = 'https://github.com/natpate/ninfer-windows/releases/download/v0.9.1/'
  + 'ninfer-windows-0.9.1-win64-cuda131.zip';
const ARTIFACT_URL = 'https://huggingface.co/neroued/Qwen3.8-27B-nvfp4-NInfer/resolve/a107ba1b5b0609d9ca90d5ed61439f5f5cc7d64d/'
  + 'qwen3_8_27b_nvfp4.ninfer';

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const REAL_RUNTIME = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'ninfer-runtime.json'), 'utf8'));
const REAL_ARTIFACTS = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'ninfer-artifacts.json'), 'utf8'));

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ninfer-manifests-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeManifest(t, value) {
  const file = path.join(tempDir(t), 'manifest.json');
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

function runtimeWith(t, patch) {
  return writeManifest(t, { ...structuredClone(REAL_RUNTIME), ...patch });
}

function artifactsWith(t, patchEntry, extra = []) {
  const entry = { ...structuredClone(REAL_ARTIFACTS.artifacts[0]), ...patchEntry };
  return writeManifest(t, { ...structuredClone(REAL_ARTIFACTS), artifacts: [entry, ...extra] });
}

function assertRuntimeInvalid(manifestPath) {
  assert.throws(() => loadNinferRuntimeManifest({ manifestPath }),
    (error) => error.reason === 'ninfer_runtime_manifest_invalid');
}

function assertArtifactsInvalid(manifestPath) {
  assert.throws(() => loadNinferArtifactManifest({ manifestPath }),
    (error) => error.reason === 'ninfer_artifact_manifest_invalid');
}

test('the shipped runtime manifest loads with the pinned values and derived URL', () => {
  const runtime = loadNinferRuntimeManifest();
  assert.equal(runtime.size_bytes, 450215373);
  assert.equal(runtime.sha256, RUNTIME_SHA);
  assert.equal(runtime.url, RUNTIME_URL);
  assert.equal(runtimeDownloadUrl(runtime), RUNTIME_URL);
  assert.equal(runtime.executable, 'ninfer-serve.exe');
  assert.equal(runtime.install_dirname, 'ninfer-0.9.1');
  assert.equal(runtime.sums_file, 'SHA256SUMS');
  assert.ok(runtime.expected_files.includes('ninfer-serve.exe'));
  assert.ok(runtime.expected_files.includes('SHA256SUMS'));
  assert.equal(runtime.expected_files.length, 12);
  assert.ok(Object.isFrozen(runtime));
  assert.ok(Object.isFrozen(runtime.expected_files));
  assert.ok(Object.isFrozen(runtime.extract_limits));
});

test('the shipped artifact manifest loads with the pinned values and derived URL', () => {
  const { artifacts } = loadNinferArtifactManifest();
  assert.equal(artifacts.length, 1);
  const [artifact] = artifacts;
  assert.equal(artifact.id, 'qwen3.8-27b-nvfp4');
  assert.equal(artifact.size_bytes, 23719715844);
  assert.equal(artifact.sha256, ARTIFACT_SHA);
  assert.equal(artifact.url, ARTIFACT_URL);
  assert.equal(artifactDownloadUrl(artifact), ARTIFACT_URL);
  assert.equal(artifact.model_id, 'qwen3.8-27b-nvfp4');
  assert.equal(artifact.format_version, 3);
  assert.equal(artifact.supports_mtp, true);
  assert.deepEqual([...artifact.context_windows], [16384, 32768, 65536, 131072, 153600, 196608, 262144]);
  // Above 128k the bf16 cache leaves no VRAM free on a 32 GB card (150k ran 6x slower): 8-bit cache.
  assert.deepEqual([...artifact.fp8_kv_windows], [153600, 196608, 262144]);
  assert.equal(artifact.default_context_window, 153600);
  assert.ok(Object.isFrozen(artifacts));
  assert.ok(Object.isFrozen(artifact));
  assert.ok(Object.isFrozen(artifact.context_windows));
});

test('upper-case sha256 is accepted and normalized to lower case', (t) => {
  const runtime = loadNinferRuntimeManifest({ manifestPath: runtimeWith(t, { sha256: RUNTIME_SHA.toUpperCase() }) });
  assert.equal(runtime.sha256, RUNTIME_SHA);
  const { artifacts } = loadNinferArtifactManifest({
    manifestPath: artifactsWith(t, { sha256: ARTIFACT_SHA.toUpperCase() }),
  });
  assert.equal(artifacts[0].sha256, ARTIFACT_SHA);
});

test('bad sha256 values are rejected', (t) => {
  assertRuntimeInvalid(runtimeWith(t, { sha256: RUNTIME_SHA.slice(1) }));
  assertRuntimeInvalid(runtimeWith(t, { sha256: `${RUNTIME_SHA.slice(1)}g` }));
  assertArtifactsInvalid(artifactsWith(t, { sha256: ARTIFACT_SHA.slice(1) }));
});

test('missing fields, unreadable files and malformed JSON are rejected', (t) => {
  for (const key of ['repo', 'release', 'asset', 'size_bytes', 'sha256', 'install_dirname', 'executable',
    'sums_file', 'expected_files', 'extract_limits']) {
    const manifest = structuredClone(REAL_RUNTIME);
    delete manifest[key];
    assertRuntimeInvalid(writeManifest(t, manifest));
  }
  for (const key of ['id', 'repo', 'revision', 'file', 'size_bytes', 'sha256', 'model_id', 'format_version',
    'context_windows', 'default_context_window']) {
    const entry = structuredClone(REAL_ARTIFACTS.artifacts[0]);
    delete entry[key];
    assertArtifactsInvalid(writeManifest(t, { schema_version: 1, artifacts: [entry] }));
  }
  assertRuntimeInvalid(path.join(tempDir(t), 'missing.json'));
  assertArtifactsInvalid(path.join(tempDir(t), 'missing.json'));
  assertRuntimeInvalid(writeManifest(t, '{not json'));
  assertArtifactsInvalid(writeManifest(t, '[]'));
  assertArtifactsInvalid(writeManifest(t, { schema_version: 1, artifacts: [] }));
});

test('a url field in the JSON is ignored; the derived URL wins', (t) => {
  const runtime = loadNinferRuntimeManifest({ manifestPath: runtimeWith(t, { url: 'https://evil.example/x.zip' }) });
  assert.equal(runtime.url, RUNTIME_URL);
  const { artifacts } = loadNinferArtifactManifest({
    manifestPath: artifactsWith(t, { url: 'https://evil.example/model.ninfer' }),
  });
  assert.equal(artifacts[0].url, ARTIFACT_URL);
});

test('release must carry the v prefix and names must be plain', (t) => {
  assertRuntimeInvalid(runtimeWith(t, { release: '0.9.1' }));
  assertRuntimeInvalid(runtimeWith(t, { repo: 'natpate/ninfer/windows' }));
  assertRuntimeInvalid(runtimeWith(t, { asset: '../evil.zip' }));
  assertRuntimeInvalid(runtimeWith(t, { asset: 'a..zip' }));
  assertRuntimeInvalid(runtimeWith(t, { executable: 'bin/ninfer-serve.exe' }));
  assertRuntimeInvalid(runtimeWith(t, { expected_files: ['ninfer-serve.exe', '..\\evil.dll'] }));
  assertRuntimeInvalid(runtimeWith(t, { install_dirname: '.hidden' }));
  assertRuntimeInvalid(runtimeWith(t, { size_bytes: 0 }));
  assertRuntimeInvalid(runtimeWith(t, { extract_limits: { max_entries: 64, max_entry_uncompressed_bytes: 1 } }));
  assertArtifactsInvalid(artifactsWith(t, { file: 'models/x.ninfer' }));
  assertArtifactsInvalid(artifactsWith(t, { format_version: 2 }));
  assertArtifactsInvalid(artifactsWith(t, { model_id: '-bad' }));
});

test('duplicate artifact ids are rejected', (t) => {
  assertArtifactsInvalid(artifactsWith(t, {}, [structuredClone(REAL_ARTIFACTS.artifacts[0])]));
});

test('context windows must be ascending positive integers containing the default', (t) => {
  assertArtifactsInvalid(artifactsWith(t, { context_windows: [16384, 32768] }));
  assertArtifactsInvalid(artifactsWith(t, { context_windows: [] }));
  assertArtifactsInvalid(artifactsWith(t, { context_windows: [65536, 32768] }));
  assertArtifactsInvalid(artifactsWith(t, { context_windows: [0, 65536] }));
});

test('fp8 KV windows are optional and must be offered context windows', (t) => {
  assertArtifactsInvalid(artifactsWith(t, { fp8_kv_windows: [524288] }));
  assertArtifactsInvalid(artifactsWith(t, { fp8_kv_windows: 262144 }));
  const raw = structuredClone(REAL_ARTIFACTS.artifacts[0]);
  delete raw.fp8_kv_windows;
  const { artifacts } = loadNinferArtifactManifest({ manifestPath: writeManifest(t, { ...structuredClone(REAL_ARTIFACTS), artifacts: [raw] }) });
  assert.deepEqual([...artifacts[0].fp8_kv_windows], []);
});

test('isHuggingFaceDownloadHost accepts Hugging Face hosts only', () => {
  for (const host of ['huggingface.co', 'HuggingFace.co', 'us.aws.cdn.hf.co', 'cdn-lfs.hf.co',
    'cdn-lfs-us-1.hf.co', 'cas-bridge.xethub.hf.co', 'cdn-lfs.huggingface.co']) {
    assert.equal(isHuggingFaceDownloadHost(host), true, host);
  }
  for (const host of ['evil-hf.co', 'hf.co.attacker.net', 'evilhuggingface.co', 'huggingface.co.evil.net',
    'hf.co', '', null, undefined, 42]) {
    assert.equal(isHuggingFaceDownloadHost(host), false, String(host));
  }
});

test('runtime download hosts are the GitHub update hosts', () => {
  assert.equal(NINFER_RUNTIME_DOWNLOAD_HOSTS, GITHUB_UPDATE_HOSTS);
  assert.ok(Object.isFrozen(NINFER_RUNTIME_DOWNLOAD_HOSTS));
});
