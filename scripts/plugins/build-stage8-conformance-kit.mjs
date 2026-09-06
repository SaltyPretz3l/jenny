#!/usr/bin/env node
/* global Buffer, process */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStage8UnsignedFixture } from './jenny-plugin-v6-packager.mjs';
import { CURRENT_KEY_ID, CURRENT_PUBLIC_KEY_SPKI_DER_BASE64 }
  from './sign-stage8-conformance-request.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CRATE_PREFIX = 'native/plugin-full-host-supervisor/';
const OFFLINE_SIGNER = 'scripts/plugins/sign-stage8-conformance-request.mjs';
const BUILD_TARGETS = Object.freeze({
  win32: Object.freeze({ architecture: 'x64', triple: 'x86_64-pc-windows-msvc' }),
  darwin: Object.freeze({ architecture: 'arm64', triple: 'aarch64-apple-darwin' }),
});
const SCRIPT_INPUTS = Object.freeze([
  'scripts/plugins/build-stage8-conformance-kit.mjs',
  'scripts/plugins/jenny-plugin-v6-packager.mjs',
  OFFLINE_SIGNER,
  'config/plugins/contract-lock-v6.json',
  'config/plugins/trusted-publishers.json',
]);
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, windowsHide: true,
    encoding: options.binary ? null : 'utf8', maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeout || 30_000 });
  if (result.status !== 0) throw new Error(options.reason || 'stage8_git_provenance_failed');
  return result.stdout;
}
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function committedBytes(commit, relative) {
  return Buffer.from(run('git', ['show', `${commit}:${relative}`], { binary: true }));
}
function assertScriptInputsClean() {
  if (String(run('git', ['status', '--porcelain', '--', ...SCRIPT_INPUTS, CRATE_PREFIX])).trim()) {
    throw new Error('stage8_signing_inputs_dirty');
  }
}
function assertTrustedRoot(commit) {
  const roots = JSON.parse(committedBytes(commit, 'config/plugins/trusted-publishers.json'));
  const publisher = roots.publishers?.find((item) => item.publisher_id === 'jenny-official');
  const key = publisher?.keys?.find((item) => item.key_id === publisher.current_key_id
    && item.status === 'active');
  if (!key || key.key_id !== CURRENT_KEY_ID
    || key.public_key_spki_der_base64 !== CURRENT_PUBLIC_KEY_SPKI_DER_BASE64) {
    throw new Error('stage8_offline_signer_root_mismatch');
  }
}
function materializeCommittedCrate(commit, destination) {
  const files = String(run('git', ['ls-tree', '-r', '--name-only', commit, '--', CRATE_PREFIX]))
    .trim().split(/\r?\n/).filter((item) => item.startsWith(CRATE_PREFIX));
  if (!files.includes(`${CRATE_PREFIX}Cargo.toml`)
    || !files.includes(`${CRATE_PREFIX}Cargo.lock`)
    || !files.includes(`${CRATE_PREFIX}src/bin/stage8_conformance_host.rs`)) {
    throw new Error('stage8_committed_fixture_source_missing');
  }
  const tree = crypto.createHash('sha256');
  for (const relative of files) {
    const bytes = committedBytes(commit, relative);
    tree.update(relative, 'utf8').update('\0').update(bytes).update('\0');
    const output = path.join(destination, relative.slice(CRATE_PREFIX.length));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, bytes, { flag: 'wx' });
  }
  return { files, sourceTreeDigest: tree.digest('hex') };
}
export function buildKit({ destination, platform = process.platform,
  architecture = process.arch } = {}) {
  const buildTarget = BUILD_TARGETS[platform];
  if (!buildTarget || platform !== process.platform || architecture !== buildTarget.architecture) {
    throw new Error('stage8_host_target_mismatch');
  }
  const resolved = fs.realpathSync(destination);
  const relative = path.relative(ROOT, resolved);
  const insideRepository = relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  if (!fs.lstatSync(resolved).isDirectory() || insideRepository) {
    throw new Error('stage8_kit_destination_invalid');
  }
  assertScriptInputsClean();
  const commit = String(run('git', ['rev-parse', 'HEAD'])).trim();
  assertTrustedRoot(commit);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-stage8-committed-'));
  let fixture;
  try {
    const source = materializeCommittedCrate(commit, temporary);
    run('cargo', ['build', '--release', '--locked', '--bin', 'stage8_conformance_host',
      '--manifest-path', path.join(temporary, 'Cargo.toml')],
    { timeout: 840_000, reason: 'stage8_fixture_build_failed' });
    const name = platform === 'win32' ? 'stage8_conformance_host.exe' : 'stage8_conformance_host';
    const binary = fs.readFileSync(path.join(temporary, 'target', 'release', name));
    const provenance = Buffer.from(`${JSON.stringify({
      provenance_schema_version: 1, source_commit: commit,
      source_tree_digest: source.sourceTreeDigest,
      source_files: source.files.map((relative) => ({ relative,
        sha256: digest(committedBytes(commit, relative)) })),
      build_script_sha256: digest(committedBytes(commit, SCRIPT_INPUTS[0])),
      packager_sha256: digest(committedBytes(commit, SCRIPT_INPUTS[1])),
      offline_signer_sha256: digest(committedBytes(commit, OFFLINE_SIGNER)),
      contract_lock_v6_sha256: digest(committedBytes(commit, 'config/plugins/contract-lock-v6.json')),
      trusted_publishers_sha256: digest(committedBytes(commit, 'config/plugins/trusted-publishers.json')),
      cargo_version: String(run('cargo', ['--version'])).trim(),
      rustc_version: String(run('rustc', ['--version'])).trim(),
      target: buildTarget.triple, architecture,
      binary_sha256: digest(binary),
    }, null, 2)}\n`, 'utf8');
    fixture = createStage8UnsignedFixture({ binaryBytes: binary, platform,
      provenanceBytes: provenance });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  assertScriptInputsClean();
  const kitName = `jenny-stage8-conformance-${crypto.randomBytes(6).toString('hex')}`;
  const kitRoot = path.join(resolved, kitName);
  fs.mkdirSync(kitRoot, { mode: 0o700 });
  fs.writeFileSync(path.join(kitRoot, 'unsigned-fixture.json'), JSON.stringify({
    manifest: fixture.manifest,
    entries: fixture.signedEntries.map((entry) => ({ path: entry.path,
      bytes_base64: entry.bytes.toString('base64') })), signed_payload: fixture.signedPayload,
  }), { flag: 'wx', mode: 0o600 });
  const signerBytes = committedBytes(commit, OFFLINE_SIGNER);
  fs.writeFileSync(path.join(kitRoot, path.basename(OFFLINE_SIGNER)), signerBytes,
    { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(kitRoot, 'signing-request.json'), `${JSON.stringify({
    signing_request_schema_version: 1, publisher_id: 'jenny-official',
    plugin_id: 'stage8-conformance', source_commit: commit,
    offline_signer_sha256: digest(signerBytes),
    canonical_payload_base64: fixture.canonicalBytes.toString('base64'),
    canonical_payload_sha256: crypto.createHash('sha256').update(fixture.canonicalBytes).digest('hex'),
  }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { kitRoot };
}
if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  const index = process.argv.indexOf('--destination');
  try { const result = buildKit({ destination: process.argv[index + 1] });
    process.stdout.write(`Stage 8 conformance kit: ${result.kitRoot}\n`); }
  catch (error) { process.stderr.write(`Stage 8 kit failed [${error.message}].\n`); process.exitCode = 1; }
}
