'use strict';

const { validate } = require('../contracts/generated-plugin-contracts');
const { joinPath } = require('./fs-facade');
const { readJsonFile, writeJsonFileAtomic } = require('./json-file-io');

const CONTRACT_NAME = 'PluginRemoteMcpAuthorizationV1';
const REMOTE_MCP_DIR = 'remote-mcp';
const AUTHORIZATIONS_DIR = 'authorizations';
const DIGEST_RE = /^[0-9a-f]{64}$/;

function authorizationPath(baseDir, authProfileRef) {
  if (!DIGEST_RE.test(authProfileRef || '')) {
    return { ok: false, reason: 'auth_profile_ref_invalid' };
  }
  return {
    ok: true,
    path: joinPath(baseDir, REMOTE_MCP_DIR, AUTHORIZATIONS_DIR, `${authProfileRef}.json`),
  };
}

async function readRemoteMcpAuthorization(facade, baseDir, authProfileRef) {
  const pathResult = authorizationPath(baseDir, authProfileRef);
  if (!pathResult.ok) return pathResult;
  const read = await readJsonFile(facade, pathResult.path);
  if (read.status === 'missing') return { ok: false, reason: 'remote_mcp_authorization_not_found' };
  if (read.status !== 'ok') return { ok: false, reason: 'remote_mcp_authorization_corrupted' };
  const checked = validate(CONTRACT_NAME, read.value);
  if (!checked.ok || checked.value.auth_profile_ref !== authProfileRef) {
    return { ok: false, reason: 'remote_mcp_authorization_invalid' };
  }
  return { ok: true, authorization: checked.value };
}

async function writeRemoteMcpAuthorization(facade, baseDir, authorization) {
  const checked = validate(CONTRACT_NAME, authorization);
  if (!checked.ok) {
    return { ok: false, reason: 'remote_mcp_authorization_invalid', detail: checked.error };
  }
  await writeJsonFileAtomic(
    facade,
    joinPath(baseDir, REMOTE_MCP_DIR, AUTHORIZATIONS_DIR),
    `${checked.value.auth_profile_ref}.json`,
    checked.value
  );
  const reread = await readRemoteMcpAuthorization(
    facade,
    baseDir,
    checked.value.auth_profile_ref
  );
  return reread.ok ? { ok: true, authorization: reread.authorization } : reread;
}

module.exports = {
  CONTRACT_NAME,
  REMOTE_MCP_DIR,
  readRemoteMcpAuthorization,
  writeRemoteMcpAuthorization,
};
