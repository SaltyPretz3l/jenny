'use strict';

// What a member may send, and the checks before any byte is hashed (row 123 slice 6-5, decision 4). A model is named
// by its discovery tag, never by a path: the tag is looked up in the real discovery listing at the moment of the call
// (`listLocalGgufs`, late-bound, the list Settings > Models shows), and only a `root`, `persisted` or `library` entry
// is sendable; an Ollama copy has its own reason word. The files offered are the main model plus the subset of its
// `companionFiles` (Move and add's family rule) the caller ticked; shards always go with it. Before hashing, the
// manifest is built with stand-in digests and run through 6-1's validator and the receiver's own `checkOffer` and
// `provenanceBytes`, so a shard-name or lone-drafter mismatch and the 16 KiB provenance bound are refused here, never
// sent. The provenance is prefilled from the GGUF header (`general.license`, `general.source.url`, the name), each
// cleaned and cut to the manifest's limits. Nothing here loads a model or writes a setting; no answer or log carries a
// path except the resolved paths handed to the sender in memory.

const fs = require('node:fs');
const path = require('node:path');

const { companionFiles } = require('../gguf-place');
const { readGgufHeader } = require('../gguf-header');
const { splitGgufFiles } = require('../llama-server-gguf-files');
const { isCleanText } = require('../../server/team/member-schema');
const { MODEL_TRANSFER_LIMITS, validateModelManifest } = require('../../server/team/model-manifest');
const { checkOffer, provenanceBytes } = require('./model-receive-checks');

const SENDABLE_SOURCES = new Set(['root', 'persisted', 'library']);
const STAND_IN = '0'.repeat(64);
// Every control character but a line feed and a tab.
const CONTROL = /(?![\n\t])\p{Cc}/gu;
const LIMITS = MODEL_TRANSFER_LIMITS;

const refuse = (reason) => ({ ok: false, reason });

async function discovered(listLocalGgufs) {
  if (typeof listLocalGgufs !== 'function') return [];
  try {
    const entries = await listLocalGgufs();
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

const isOllama = (entry) => entry.source === 'ollama' || entry.ollamaBlob === true;
const whyNot = (entry) => (isOllama(entry) ? 'model_ollama_copy' : SENDABLE_SOURCES.has(entry.source) ? null : 'model_not_listed');

/** The discovery listing as sendable rows: { tag, name, size_bytes, sendable, reason }. */
async function sendableModels(listLocalGgufs) {
  const rows = [];
  for (const entry of await discovered(listLocalGgufs)) {
    if (typeof entry?.tag !== 'string' || !entry.tag || typeof entry.mainGguf !== 'string' || !entry.mainGguf) continue;
    const reason = whyNot(entry);
    rows.push({ tag: entry.tag, name: entry.tag, size_bytes: Number.isSafeInteger(entry.sizeBytes) ? entry.sizeBytes : 0,
      sendable: reason === null, reason });
  }
  return rows;
}

const regular = (file, fsImpl) => {
  try {
    const stat = fsImpl.lstatSync(file, { bigint: true });
    return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0n ? stat : null;
  } catch {
    return null;
  }
};

/** The file's identity as the push loop re-checks it: device, inode, size and modified time. */
const identityOf = (stat) => ({ dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs) });
const sameIdentity = (a, b) => Boolean(a && b) && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;

function kindOf(name) {
  const split = splitGgufFiles([name]);
  if (split.drafters.length) return 'drafter';
  if (split.projectors.length) return 'vision';
  return 'model';
}

/** `{ ok, tag, dir, main, files: [{ name, size, kind, required, path }] }` for a listed sendable tag, or a refusal. */
async function resolveModel(listLocalGgufs, tag, { fsImpl = fs } = {}) {
  const entry = (await discovered(listLocalGgufs)).find((row) => row?.tag === tag && typeof row.mainGguf === 'string');
  if (!entry || !entry.mainGguf) return refuse('model_not_listed');
  const reason = whyNot(entry);
  if (reason) return refuse(reason);
  const dir = String(entry.dir || '');
  if (!path.isAbsolute(dir) || !regular(path.join(dir, entry.mainGguf), fsImpl)) return refuse('model_not_listed');
  let names;
  try {
    names = fsImpl.readdirSync(dir).filter((name) => /\.gguf$/iu.test(name) && regular(path.join(dir, name), fsImpl));
  } catch {
    return refuse('model_not_listed');
  }
  const main = entry.mainGguf;
  const files = [main, ...companionFiles(dir, main, names)].map((name) => {
    const stat = regular(path.join(dir, name), fsImpl);
    const kind = kindOf(name);
    return stat ? { name, size: Number(stat.size), kind, required: name === main || kind === 'model', path: path.join(dir, name) } : null;
  });
  if (files.some((file) => file === null)) return refuse('model_not_listed');
  return { ok: true, tag: entry.tag, dir, main, files };
}

// Text from a header or the caller: control characters out (a line feed and a tab kept where allowed), CRLF to LF,
// NFC, trimmed, cut to `max` characters; '' when nothing is left.
function cleanText(value, max, { lines = false } = {}) {
  if (typeof value !== 'string') return '';
  let text = value.replace(/\r\n?/gu, '\n').normalize('NFC');
  text = lines ? text.replace(CONTROL, '') : text.replace(/[\n\t]/gu, ' ').replace(CONTROL, '');
  text = text.trim();
  if (text.length > max) text = text.slice(0, max).trim();
  if (typeof text.isWellFormed === 'function' && !text.isWellFormed()) text = text.toWellFormed();
  return text;
}

function cleanUrl(value) {
  const text = cleanText(value, LIMITS.maxSourceUrlChars);
  if (!text.startsWith('https://') || text.includes('\\') || !/^[\x21-\x7e]+$/u.test(text)) return '';
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && !url.username && !url.password ? text : '';
  } catch {
    return '';
  }
}

/** The provenance prefill from the main file's header: { name, licence, source_url }, each cleaned ('' when absent). */
function provenancePrefill(file, tag) {
  let kv;
  try { kv = readGgufHeader(file).kv || {}; } catch { kv = {}; }
  const fromHeader = cleanText(kv['general.name'], LIMITS.maxDisplayNameChars);
  const name = isCleanText(fromHeader, LIMITS.maxDisplayNameChars) ? fromHeader : cleanText(tag, LIMITS.maxDisplayNameChars);
  return { name, licence: cleanText(kv['general.license'], LIMITS.maxLicenceChars, { lines: true }),
    source_url: cleanUrl(kv['general.source.url']) };
}

/** The manifest the host and the receiver check; `hashes` (per file { sha256, segments }) or stand-ins before hashing. */
function buildManifest({ requestId, audience, displayName, files, provenance, hashes = null }) {
  return {
    request_id: requestId,
    audience: audience.kind === 'member' ? { kind: 'member', member_id: audience.member_id } : { kind: 'team' },
    display_name: displayName,
    files: files.map((file, index) => ({
      name: file.name, size: file.size,
      sha256: hashes ? hashes[index].sha256 : STAND_IN,
      segments: hashes ? [...hashes[index].segments]
        : Array.from({ length: Math.ceil(file.size / LIMITS.segmentBytes) }, () => STAND_IN),
    })),
    provenance: { licence: provenance.licence, source_url: provenance.source_url || null, note: provenance.note },
  };
}

/**
 * The checks before hashing: 6-1's validator, then the receiver's own offer check (names re-classified by the family
 * rule) and the provenance file bound, as the receiver will run them. `{ ok: true }` or a refusal.
 */
function precheck({ manifest, teamId, sender, validate = validateModelManifest }) {
  if (!validate(manifest).ok) return refuse('model_manifest_invalid');
  const offer = { offerId: 'offer_precheck', teamId, sender, manifest };
  if (!checkOffer(offer, validate).ok) return refuse('model_manifest_invalid');
  if (provenanceBytes(offer) > LIMITS.provenanceFileBytes) return refuse('model_provenance_too_large');
  return { ok: true };
}

module.exports = {
  buildManifest, cleanText, cleanUrl, identityOf, precheck, provenancePrefill, resolveModel, sameIdentity, sendableModels,
};
