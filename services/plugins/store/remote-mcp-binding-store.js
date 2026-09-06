'use strict';

const crypto = require('node:crypto');
const { validate } = require('../contracts/generated-plugin-contracts');
const { stableStringify } = require('../package/canonical-metadata');
const { joinPath } = require('./fs-facade');
const { readJsonFile, writeJsonFileAtomic } = require('./json-file-io');

const CONTRACT_NAME = 'PluginRemoteMcpBindingV1';
const REMOTE_MCP_DIR = 'remote-mcp';
const BINDINGS_DIR = 'bindings';
const DIGEST_RE = /^[0-9a-f]{64}$/;

function bindingDigest(binding) {
  const { binding_digest: _ignored, ...authority } = binding || {};
  return crypto.createHash('sha256').update(stableStringify(authority), 'utf8').digest('hex');
}

function bindingPath(baseDir, digest) {
  if (!DIGEST_RE.test(digest || '')) return { ok: false, reason: 'binding_digest_invalid' };
  return { ok: true, path: joinPath(baseDir, REMOTE_MCP_DIR, BINDINGS_DIR, `${digest}.json`) };
}

async function writeRemoteMcpBinding(facade, baseDir, binding) {
  const checked = validate(CONTRACT_NAME, binding);
  if (!checked.ok) return { ok: false, reason: 'remote_mcp_binding_invalid', detail: checked.error };
  const digest = bindingDigest(checked.value);
  if (checked.value.binding_digest !== digest) {
    return { ok: false, reason: 'remote_mcp_binding_digest_mismatch' };
  }
  await writeJsonFileAtomic(
    facade,
    joinPath(baseDir, REMOTE_MCP_DIR, BINDINGS_DIR),
    `${digest}.json`,
    checked.value
  );
  const reread = await readRemoteMcpBinding(facade, baseDir, digest);
  return reread.ok ? { ok: true, digest, binding: reread.binding } : reread;
}

async function readRemoteMcpBinding(facade, baseDir, digest) {
  const pathResult = bindingPath(baseDir, digest);
  if (!pathResult.ok) return pathResult;
  const read = await readJsonFile(facade, pathResult.path);
  if (read.status === 'missing') return { ok: false, reason: 'remote_mcp_binding_not_found' };
  if (read.status !== 'ok') return { ok: false, reason: 'remote_mcp_binding_corrupted' };
  const checked = validate(CONTRACT_NAME, read.value);
  if (!checked.ok || bindingDigest(checked.value) !== digest || checked.value.binding_digest !== digest) {
    return { ok: false, reason: 'remote_mcp_binding_invalid' };
  }
  return { ok: true, binding: checked.value };
}

module.exports = {
  CONTRACT_NAME,
  REMOTE_MCP_DIR,
  BINDINGS_DIR,
  bindingDigest,
  bindingPath,
  writeRemoteMcpBinding,
  readRemoteMcpBinding,
};
