'use strict';

// "Share this PC's GPU", saved per team (row 123 slice 4e; spec "4e as built"): sharing.json beside
// the team's client.json, { schema_version: 1, on, claim_seq } and, once the sharer chose one, `ollama_models`:
// the model names this PC shares from Ollama (at most 64, each a printable name; absent means the default share
// set, team-sharing.js). A save that names no `ollama_models` keeps the saved ones; null removes them. It is its own file so the client file
// an older Jenny reads stays exactly as it was. Read and written with the client file's safe IO
// (durable-json.js: no symlink or hard link followed, a size cap, an atomic write), and written only
// while the team's own directory exists as a real directory: a removed team is never brought back.
// The whole directory, this file with it, goes when the team is removed (client-file.js
// removeClientFile). A file that fails a rule reads as "not sharing" and is logged once per team a
// run. It holds no prompt, reply, URL or key.

const fs = require('node:fs');
const path = require('node:path');

const { readJson, writeJson } = require('../../host/durable-json');
const { clientFilePath } = require('../client-file');

const SCHEMA_VERSION = 1;
const MAX_BYTES = 16 * 1024; // room for a 64-name share set
const KEYS = Object.freeze(['claim_seq', 'on', 'schema_version']);
const MAX_SHARE_SET = 64;
const SHARE_NAME = /^[!-~][ -~]{0,127}$/u;
const NOT_SHARING = Object.freeze({ ok: true, on: false, claim_seq: 0 });

const isMark = (value) => Number.isSafeInteger(value) && value >= 0;

/** The share set as saved: a non-empty list of at most 64 distinct printable names, or null when it is not one. */
function cleanShareSet(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SHARE_SET) return null;
  const names = [];
  for (const name of value) {
    if (typeof name !== 'string' || !SHARE_NAME.test(name)) return null;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function sharingFilePath(userDataPath, teamId) {
  return path.join(path.dirname(clientFilePath(userDataPath, teamId)), 'sharing.json');
}

/** { ok: true, on, claim_seq }: off and 0 when nothing was saved; `bad: true` when the file failed a rule. */
function loadSharing(userDataPath, teamId) {
  let value;
  try {
    value = readJson(sharingFilePath(userDataPath, teamId), { maxBytes: MAX_BYTES });
  } catch {
    return { ...NOT_SHARING, bad: true };
  }
  if (value === null) return { ...NOT_SHARING };
  const { ollama_models: chosen, ...rest } = value;
  const keys = Object.keys(rest).sort();
  if (keys.length !== KEYS.length || keys.some((key, i) => key !== KEYS[i]) || value.schema_version !== SCHEMA_VERSION
    || typeof value.on !== 'boolean' || !isMark(value.claim_seq)) return { ...NOT_SHARING, bad: true };
  if (chosen === undefined) return { ok: true, on: value.on, claim_seq: value.claim_seq };
  const names = cleanShareSet(chosen);
  if (!names || names.length !== chosen.length) return { ...NOT_SHARING, bad: true };
  return { ok: true, on: value.on, claim_seq: value.claim_seq, ollama_models: names };
}

/**
 * Writes { on, claim_seq } (and `ollama_models` when named: a list sets it, null removes it, absent keeps the saved
 * one) in one atomic write while the team's directory exists; { ok } or { ok: false, reason }.
 */
function saveSharing(userDataPath, teamId, { on, claim_seq: claimSeq, ollama_models: chosen } = {}) {
  if (typeof on !== 'boolean' || !isMark(claimSeq)) return { ok: false, reason: 'team_sharing_invalid' };
  if (chosen !== undefined && chosen !== null && !cleanShareSet(chosen)) return { ok: false, reason: 'team_sharing_invalid' };
  let file;
  try {
    file = sharingFilePath(userDataPath, teamId);
    const dir = fs.lstatSync(path.dirname(file));
    if (!dir.isDirectory() || dir.isSymbolicLink()) return { ok: false, reason: 'team_client_missing' };
  } catch {
    return { ok: false, reason: 'team_client_missing' };
  }
  const names = chosen === undefined ? loadSharing(userDataPath, teamId).ollama_models : chosen && cleanShareSet(chosen);
  try {
    writeJson(file, { schema_version: SCHEMA_VERSION, on, claim_seq: claimSeq, ...(names ? { ollama_models: names } : {}) });
  } catch {
    return { ok: false, reason: 'team_client_write_failed' };
  }
  return { ok: true };
}

module.exports = { cleanShareSet, loadSharing, saveSharing, sharingFilePath };
