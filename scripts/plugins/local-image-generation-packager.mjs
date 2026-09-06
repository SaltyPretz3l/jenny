#!/usr/bin/env node
/* global Buffer */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStableBoundedFile } from './bounded-file-read.mjs';
import { createV6UnsignedPackage } from './jenny-plugin-v6-packager.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_SOURCE_ROOT = path.join(ROOT, 'plugins', 'official', 'local-image-generation');
const VIEW_PATHS = Object.freeze(['view/index.html', 'view/styles.css', 'view/app.js']);
const HOST_PATH = 'host/local-image-generation-host.exe';
const MAX_HOST_BYTES = 256 * 1024 * 1024;
const QUALIFICATION_HEADROOM = 0.8;
const MIN_PROVISIONING_QUALIFICATION_MS = 4 * 60 * 60 * 1000;

function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'); }

function fixedFile(root, relativePath, maxBytes = 4 * 1024 * 1024) {
  const resolvedRoot = fs.realpathSync(root);
  const lexical = path.resolve(resolvedRoot, ...relativePath.split('/'));
  if (!lexical.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('local_image_source_path_unsafe');
  }
  let resolved;
  try {
    if (fs.lstatSync(lexical).isSymbolicLink()) throw new Error('symlink');
    resolved = fs.realpathSync(lexical);
  } catch (error) {
    throw new Error('local_image_source_file_invalid', { cause: error });
  }
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('local_image_source_path_unsafe');
  }
  const read = readStableBoundedFile(resolved, maxBytes);
  if (!read.ok) throw new Error(read.reason === 'changed'
    ? 'local_image_source_file_changed' : 'local_image_source_file_invalid');
  return read.bytes;
}

function assertIdentity(manifest) {
  const kinds = manifest.contributions?.map((item) => item.kind).sort();
  if (manifest.publisher_id !== 'jenny-official'
    || manifest.plugin_id !== 'local-image-generation'
    || manifest.version !== '1.0.0'
    || JSON.stringify(kinds) !== JSON.stringify(['panel', 'session_provider'])
    || JSON.stringify(manifest.requested_permissions) !== JSON.stringify(['ui.view', 'runtime.full_host'])) {
    throw new Error('local_image_manifest_identity_invalid');
  }
}

export function assertWorkloadQualification(manifest) {
  const ledger = JSON.parse(fixedFile(ROOT, 'config/plugins/workload-profiles-v1.json', 256 * 1024));
  const profile = ledger.profiles?.find((item) => item.profile_id === 'gpu_image_v1');
  const modelBytes = Number(manifest?.model?.totalBytes);
  const bootstrapBytes = Object.values(manifest?.bootstrap || {}).reduce((total, value) => (
    total + (Number(value?.sizeBytes) || 0)
  ), 0);
  const upstreamBytes = (manifest?.upstream?.files || []).reduce((total, value) => (
    total + (Number(value?.sizeBytes) || 0)
  ), 0);
  const preflight = manifest?.preflight || {};
  const staticRetainedFloor = modelBytes + bootstrapBytes + upstreamBytes;
  const staticTransientFloor = (modelBytes * 2) + bootstrapBytes + upstreamBytes;
  if (!profile || !Number.isSafeInteger(modelBytes) || modelBytes <= 0
    || profile.provisioning_deadline_ms < MIN_PROVISIONING_QUALIFICATION_MS
    || staticRetainedFloor > profile.retained_data_budget_bytes * QUALIFICATION_HEADROOM
    || staticTransientFloor > profile.transient_data_budget_bytes * QUALIFICATION_HEADROOM
    || profile.minimum_free_disk_bytes < Number(preflight.minFreeDiskBytes)
    || profile.minimum_total_vram_bytes < Number(preflight.minTotalVramMb) * 1024 * 1024
    || profile.minimum_free_vram_bytes < Number(preflight.minFreeVramMb) * 1024 * 1024) {
    throw new Error('local_image_workload_qualification_invalid');
  }
  return Object.freeze({ staticRetainedFloor, staticTransientFloor });
}

export function createLocalImageGenerationFixture({
  sourceRoot = DEFAULT_SOURCE_ROOT,
  executableBytes,
  provenanceBytes,
} = {}) {
  if (!Buffer.isBuffer(executableBytes) || executableBytes.length <= 0
    || executableBytes.length > MAX_HOST_BYTES
    || !Buffer.isBuffer(provenanceBytes) || provenanceBytes.length <= 0) {
    throw new Error('local_image_package_input_invalid');
  }
  const manifest = JSON.parse(fixedFile(sourceRoot, 'manifest.template.json', 256 * 1024));
  const runtimeManifest = JSON.parse(fixedFile(
    sourceRoot, 'runtime/image-gen-manifest.json', 512 * 1024,
  ));
  assertWorkloadQualification(runtimeManifest);
  const panelBytes = fixedFile(sourceRoot, 'content/image-workspace.json', 256 * 1024);
  const panel = JSON.parse(panelBytes);
  const viewEntries = VIEW_PATHS.map((entryPath) => ({ path: entryPath,
    bytes: fixedFile(sourceRoot, entryPath) }));
  const viewByPath = new Map(viewEntries.map((entry) => [entry.path, entry]));
  for (const asset of panel.assets || []) {
    const entry = viewByPath.get(asset.path);
    if (!entry || entry.bytes.length !== asset.bytes || digest(entry.bytes) !== asset.sha256) {
      throw new Error('local_image_view_asset_mismatch');
    }
  }
  if (panel.entry_sha256 !== digest(viewByPath.get(panel.entry_path)?.bytes || Buffer.alloc(0))) {
    throw new Error('local_image_view_entry_mismatch');
  }
  assertIdentity(manifest);
  const executableDigest = digest(executableBytes);
  const provider = JSON.parse(fixedFile(
    sourceRoot, 'content/image-session-provider.template.json', 256 * 1024,
  ));
  Object.assign(provider, {
    artifact_digest: executableDigest,
    executable_digest: executableDigest,
    executable_bytes: executableBytes.length,
    containment_profile_digest: digest(Buffer.from('win32:gpu_image_v1', 'utf8')),
    build_provenance_digest: digest(provenanceBytes),
  });
  const providerBytes = jsonBytes(provider);
  const panelContribution = manifest.contributions.find((item) => item.kind === 'panel');
  const providerContribution = manifest.contributions.find((item) => item.kind === 'session_provider');
  Object.assign(panelContribution, { content_sha256: digest(panelBytes) });
  Object.assign(providerContribution, {
    content_sha256: digest(providerBytes),
    executable_sha256: executableDigest,
    executable_bytes: executableBytes.length,
  });
  const entries = [
    { path: panelContribution.content_path, bytes: panelBytes },
    { path: providerContribution.content_path, bytes: providerBytes },
    ...viewEntries,
    { path: HOST_PATH, bytes: executableBytes },
    { path: 'META-JENNY/provenance.json', bytes: provenanceBytes },
  ];
  return createV6UnsignedPackage({ manifest, entries });
}
