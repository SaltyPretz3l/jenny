'use strict';

// Place one file under a new name without ever replacing a file, extracted
// from Move and add (row 107, `services/llama-server-gguf-import.js`) with no
// behaviour change for the team model receiver (row 123 slice 6-4). Known
// duplicate, unassigned: row 140's `place()` in `services/gguf-companion-download.js`.
//
// The source is first renamed to `<from><stagedSuffix>`: that proves it can
// move (a program holding it open without delete sharing, as llama.cpp apps
// do, refuses the rename before anything is linked). It is then hard-linked
// to the target (a link never replaces a file, where a Windows rename would)
// and the staged name unlinked. A volume with no hard links falls back to a
// checked rename. Any failure after the rename puts the source back.
//
// The two pure family rules Move and add and the receiver share live here too
// (moved unchanged): `companionFiles` (what moves with a model) and
// `safeFolderName` (the family folder a model gets).

const path = require('path');

const { modelFamily, modelFolderName, pairProjector, splitGgufFiles } = require('./llama-server-gguf-files');

const SHARD = /^(.+)-(\d{5})-of-(\d{5})\.gguf$/i;

// What moves with a model: the other parts of a split set, the projector the
// shared pairing rule gives it, and drafters that name its family (or the one
// drafter beside a lone model). Generic files in a crowded folder stay, and so
// does any companion a model left behind still pairs with (a sibling quant
// keeps its projector and drafter).
function companionFiles(dir, file, names) {
  const split = splitGgufFiles(names);
  const shards = new Set();
  const shard = SHARD.exec(file);
  if (shard) {
    for (const name of split.main) {
      const part = SHARD.exec(name);
      if (name !== file && part && part[1].toLowerCase() === shard[1].toLowerCase() && part[3] === shard[3]) {
        shards.add(name);
      }
    }
  }
  const leftovers = split.main.filter((name) => name !== file && !shards.has(name));
  const companions = new Set(shards);
  const projector = pairProjector(dir, file, split);
  const leftBehindPairs = (candidate) => leftovers.some((name) => pairProjector(dir, name, split) === candidate);
  if (projector && !leftBehindPairs(projector)) companions.add(path.basename(projector));
  const family = modelFamily(file);
  const loneModel = leftovers.length === 0 && split.drafters.length === 1;
  for (const drafter of split.drafters) {
    const drafterFamily = modelFamily(drafter.replace(/^mtp-/i, ''));
    const leftBehindNames = leftovers.some((name) => modelFamily(name) === drafterFamily);
    if (!leftBehindNames && (loneModel || drafterFamily === family)) companions.add(drafter);
  }
  companions.delete(file);
  return [...companions].sort();
}

function safeFolderName(file) {
  const name = Array.from(modelFolderName(file))
    .map((character) => (character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '_' : character))
    .join('')
    .replace(/[. ]+$/, '');
  return name && name !== '.' && name !== '..' ? name : 'model';
}

// FAT32/exFAT answer a hard link with EISDIR on Windows (ERROR_INVALID_FUNCTION).
function noHardLinkCodes(platform) {
  return ['EPERM', 'ENOTSUP', 'ENOSYS', 'EINVAL', ...(platform === 'win32' ? ['EISDIR'] : [])];
}

const fail = (code) => Object.assign(new Error(code), { code });

/**
 * `createPlaceFile({ fs, platform, log, stagedSuffix, restoreFailedEvent })`
 * answers `placeFile(from, to)`, which throws `EEXIST` (the staged name or the
 * target exists), `EINUSE` (the source is held open) or the raw error.
 */
function createPlaceFile({ fs, platform, log = () => {}, stagedSuffix, restoreFailedEvent }) {
  const NO_HARD_LINKS = noHardLinkCodes(platform);
  return function placeFile(from, to) {
    const staged = `${from}${stagedSuffix}`;
    if (fs.existsSync(staged)) throw fail('EEXIST');
    try {
      fs.renameSync(from, staged);
    } catch (error) {
      throw ['EBUSY', 'EPERM', 'EACCES'].includes(error?.code) ? fail('EINUSE') : error;
    }
    let linked = false;
    try {
      try {
        fs.linkSync(staged, to);
        linked = true;
      } catch (error) {
        if (!NO_HARD_LINKS.includes(error?.code)) throw error;
        if (fs.existsSync(to)) throw fail('EEXIST');
        fs.renameSync(staged, to);
        return;
      }
      fs.unlinkSync(staged);
    } catch (error) {
      try {
        if (linked) fs.unlinkSync(to);
        fs.renameSync(staged, from);
      } catch (restoreError) {
        log('WARN', restoreFailedEvent, { code: restoreError?.code || 'unknown' });
      }
      throw error;
    }
  };
}

module.exports = { companionFiles, createPlaceFile, noHardLinkCodes, safeFolderName };
