'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const HOST_API_VERSION = 1;
const HOST_MANIFEST_FILENAME = 'jenny-plugin-host.manifest.json';
const DIGEST_RE = /^[0-9a-f]{64}$/;

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function platformTarget(platform = process.platform, arch = process.arch) {
  const targets = { 'win32:x64': 'x86_64-pc-windows-msvc', 'darwin:arm64': 'aarch64-apple-darwin' };
  return targets[`${platform}:${arch}`] || null;
}

async function resolveRestrictedHostRuntime({
  fs, rootDir, expectedCommit, expectedAbiDigest, expectedProtocolDigest,
  platform = process.platform, arch = process.arch,
} = {}) {
  const target = platformTarget(platform, arch);
  if (!fs || !rootDir || !target) return { ok: false, reason: 'restricted_host_target_unsupported' };
  const manifestPath = path.join(rootDir, HOST_MANIFEST_FILENAME);
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); }
  catch (_error) { return { ok: false, reason: 'restricted_host_manifest_unavailable' }; }
  const allowedKeys = ['api_version', 'target', 'commit', 'wasmtime_version', 'binary_filename',
    'binary_sha256', 'abi_sha256', 'protocol_sha256', 'licenses', 'sbom_filename'];
  if (!manifest || Object.keys(manifest).some((key) => !allowedKeys.includes(key))
    || manifest.api_version !== HOST_API_VERSION || manifest.target !== target
    || manifest.commit !== expectedCommit || manifest.abi_sha256 !== expectedAbiDigest
    || manifest.protocol_sha256 !== expectedProtocolDigest || manifest.wasmtime_version !== '47.0.3'
    || !DIGEST_RE.test(String(manifest.binary_sha256 || ''))
    || !/^[A-Za-z0-9._-]{1,96}$/.test(String(manifest.binary_filename || ''))) {
    return { ok: false, reason: 'restricted_host_manifest_incompatible' };
  }
  const binaryPath = path.join(rootDir, manifest.binary_filename);
  let resolved;
  try {
    resolved = await Promise.all([
      fs.realpath(rootDir), fs.realpath(binaryPath), fs.readFile(binaryPath),
    ]);
  } catch (_error) { return { ok: false, reason: 'restricted_host_binary_unavailable' }; }
  const [realRoot, realBinary, binaryBytes] = resolved;
  const relative = path.relative(realRoot, realBinary);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, reason: 'restricted_host_binary_escape_rejected' };
  }
  if (sha256(binaryBytes) !== manifest.binary_sha256) {
    return { ok: false, reason: 'restricted_host_binary_digest_mismatch' };
  }
  return { ok: true, binary_path: realBinary, binary_digest: manifest.binary_sha256, manifest };
}

module.exports = { HOST_API_VERSION, HOST_MANIFEST_FILENAME, sha256, platformTarget, resolveRestrictedHostRuntime };
