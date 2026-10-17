'use strict';

// Loads and validates the pinned NInfer provenance manifests. Download URLs are
// always derived from validated fields so a tampered manifest cannot redirect a
// multi-gigabyte download to an arbitrary host or path.

const fs = require('node:fs');
const path = require('node:path');
const { GITHUB_UPDATE_HOSTS } = require('./github-release-client');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const RUNTIME_INVALID = 'ninfer_runtime_manifest_invalid';
const ARTIFACT_INVALID = 'ninfer_artifact_manifest_invalid';
const ARTIFACT_FORMAT_VERSION = 3;

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RELEASE = /^v\d+\.\d+\.\d+$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const DIRECTORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/i;

// The runtime zip comes from GitHub releases; reuse the updater's host list so
// both paths trust exactly the same redirect targets.
const NINFER_RUNTIME_DOWNLOAD_HOSTS = GITHUB_UPDATE_HOSTS;

function manifestError(reason) {
  return Object.assign(new Error(reason), { reason });
}

function check(condition, reason) {
  if (!condition) throw manifestError(reason);
}

function readJson(manifestPath, fsImpl, reason) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8'));
    check(parsed && typeof parsed === 'object' && !Array.isArray(parsed), reason);
    return parsed;
  } catch (error) {
    if (error?.reason === reason) throw error;
    throw manifestError(reason);
  }
}

function isPlainName(value) {
  return typeof value === 'string' && FILE_NAME.test(value) && !value.includes('..');
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizedSha(value, reason) {
  check(typeof value === 'string' && SHA256.test(value), reason);
  return value.toLowerCase();
}

function runtimeDownloadUrl(runtime) {
  return `https://github.com/${runtime.repo}/releases/download/${runtime.release}/${runtime.asset}`;
}

function artifactDownloadUrl(artifact) {
  return `https://huggingface.co/${artifact.repo}/resolve/${artifact.revision}/${artifact.file}`;
}

// Hugging Face resolves to huggingface.co and then redirects to CDN hosts under
// hf.co (cdn-lfs, us.aws.cdn, cas-bridge.xethub); a suffix match on the dotted
// domain keeps look-alikes such as evil-hf.co or hf.co.attacker.net out.
function isHuggingFaceDownloadHost(hostname) {
  if (typeof hostname !== 'string' || !hostname) return false;
  const host = hostname.toLowerCase();
  return host === 'huggingface.co' || host.endsWith('.hf.co') || host.endsWith('.huggingface.co');
}

function validateRuntime(raw) {
  const reason = RUNTIME_INVALID;
  check(raw.schema_version === 1, reason);
  check(raw.engine === 'ninfer-windows', reason);
  check(typeof raw.repo === 'string' && REPO.test(raw.repo), reason);
  check(typeof raw.release === 'string' && RELEASE.test(raw.release), reason);
  check(typeof raw.version === 'string' && VERSION.test(raw.version), reason);
  check(isPlainName(raw.asset), reason);
  check(isPositiveInteger(raw.size_bytes), reason);
  const sha256 = normalizedSha(raw.sha256, reason);
  check(typeof raw.install_dirname === 'string' && DIRECTORY_NAME.test(raw.install_dirname), reason);
  check(isPlainName(raw.executable), reason);
  check(isPlainName(raw.sums_file), reason);
  check(Array.isArray(raw.expected_files) && raw.expected_files.length > 0
    && raw.expected_files.every(isPlainName) && raw.expected_files.includes(raw.executable), reason);
  const limits = raw.extract_limits;
  check(limits && typeof limits === 'object' && isPositiveInteger(limits.max_entries)
    && isPositiveInteger(limits.max_entry_uncompressed_bytes)
    && isPositiveInteger(limits.max_total_uncompressed_bytes), reason);
  for (const key of ['license', 'license_url', 'project_url']) check(isNonEmptyString(raw[key]), reason);
  // Pick known fields only: anything else in the JSON (such as a url) is dropped.
  const runtime = {
    engine: raw.engine, repo: raw.repo, release: raw.release, version: raw.version, asset: raw.asset,
    size_bytes: raw.size_bytes, sha256, install_dirname: raw.install_dirname, executable: raw.executable,
    sums_file: raw.sums_file, expected_files: Object.freeze([...raw.expected_files]),
    extract_limits: Object.freeze({
      max_entries: limits.max_entries,
      max_entry_uncompressed_bytes: limits.max_entry_uncompressed_bytes,
      max_total_uncompressed_bytes: limits.max_total_uncompressed_bytes,
    }),
    license: raw.license, license_url: raw.license_url, project_url: raw.project_url,
  };
  runtime.url = runtimeDownloadUrl(runtime);
  return Object.freeze(runtime);
}

function validContextWindows(windows, fallback) {
  return Array.isArray(windows) && windows.length > 0 && windows.every(isPositiveInteger)
    && windows.every((value, index) => index === 0 || value > windows[index - 1])
    && windows.includes(fallback);
}

function validateArtifact(raw) {
  const reason = ARTIFACT_INVALID;
  check(raw && typeof raw === 'object' && !Array.isArray(raw), reason);
  check(typeof raw.id === 'string' && DIRECTORY_NAME.test(raw.id), reason);
  check(isNonEmptyString(raw.display_name), reason);
  check(typeof raw.repo === 'string' && REPO.test(raw.repo), reason);
  check(typeof raw.revision === 'string' && DIRECTORY_NAME.test(raw.revision), reason);
  check(isPlainName(raw.file), reason);
  check(isPositiveInteger(raw.size_bytes), reason);
  const sha256 = normalizedSha(raw.sha256, reason);
  check(typeof raw.model_id === 'string' && DIRECTORY_NAME.test(raw.model_id), reason);
  check(raw.format_version === ARTIFACT_FORMAT_VERSION, reason);
  check(typeof raw.supports_mtp === 'boolean', reason);
  check(validContextWindows(raw.context_windows, raw.default_context_window), reason);
  // Optional: the windows that launch with an 8-bit KV cache (a subset of context_windows).
  const fp8KvWindows = raw.fp8_kv_windows === undefined ? [] : raw.fp8_kv_windows;
  check(Array.isArray(fp8KvWindows) && fp8KvWindows.every((value) => raw.context_windows.includes(value)), reason);
  const artifact = {
    id: raw.id, display_name: raw.display_name, repo: raw.repo, revision: raw.revision, file: raw.file,
    size_bytes: raw.size_bytes, sha256, model_id: raw.model_id, format_version: raw.format_version,
    supports_mtp: raw.supports_mtp, context_windows: Object.freeze([...raw.context_windows]),
    fp8_kv_windows: Object.freeze([...fp8KvWindows]),
    default_context_window: raw.default_context_window,
  };
  artifact.url = artifactDownloadUrl(artifact);
  return Object.freeze(artifact);
}

function loadNinferRuntimeManifest({
  manifestPath = path.join(CONFIG_DIR, 'ninfer-runtime.json'),
  fsImpl = fs,
} = {}) {
  return validateRuntime(readJson(manifestPath, fsImpl, RUNTIME_INVALID));
}

function loadNinferArtifactManifest({
  manifestPath = path.join(CONFIG_DIR, 'ninfer-artifacts.json'),
  fsImpl = fs,
} = {}) {
  const raw = readJson(manifestPath, fsImpl, ARTIFACT_INVALID);
  check(raw.schema_version === 1, ARTIFACT_INVALID);
  check(Array.isArray(raw.artifacts) && raw.artifacts.length > 0, ARTIFACT_INVALID);
  const artifacts = raw.artifacts.map(validateArtifact);
  check(new Set(artifacts.map((artifact) => artifact.id)).size === artifacts.length, ARTIFACT_INVALID);
  return Object.freeze({ artifacts: Object.freeze(artifacts) });
}

module.exports = {
  loadNinferRuntimeManifest,
  loadNinferArtifactManifest,
  runtimeDownloadUrl,
  artifactDownloadUrl,
  isHuggingFaceDownloadHost,
  NINFER_RUNTIME_DOWNLOAD_HOSTS,
};
