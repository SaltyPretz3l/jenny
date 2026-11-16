'use strict';

// Placement of a verified model set (row 123 slice 6-4, TEAM_MODEL_SHARING_SPEC
// "6-4 as built", MI3, MI4). Nothing is listed by discovery until the set is
// whole, and a set never shares a folder with models it did not arrive with
// (review round two, R14-F01: discovery pairs a projector or drafter by
// listing the model's folder). Every item moves (link, then unlink, with
// `services/gguf-place.js`) into `<staging>/set/` under its final name, and
// that folder is renamed to the journal's folder in one step that never lands
// on anything. Before the rename the set sits inside `.jenny-incoming`, which
// discovery skips. A folder that appeared at that name meanwhile is never
// joined: the next free folder of the rule is taken (the journal and the
// provenance file record it), and with none left the placement rolls back as
// `model_exists`.
//
// Each item has a stage in the journal (0 staged, 1 moved, 2 final), saved
// after every move, so a cut anywhere resumes: a `.jenny-moving` name left by a
// cut inside `placeFile` is finished (its neighbour is the same file) or put
// back, and every item is then checked to be a regular file with one link and
// its size before anything moves. A conflict rolls the placement back from the
// journal to staging; a rollback that fails keeps the journal (phase
// `rollback`) so the next start finishes it.

const fs = require('node:fs');
const path = require('node:path');

const { MOVING_SUFFIX, PROVENANCE_SUFFIX } = require('../../server/team/model-manifest');
const { renameNoReplace } = require('../../server/team/file-checks');
const { createPlaceFile } = require('../gguf-place');
const { ownFolder, pickReceiveFolder, present, regularFile } = require('./model-receive-checks');
const { PROVENANCE_STAGED, ROLLBACK_REASONS, stagingFileName } = require('./model-receive-journal');

const SET_DIR = 'set';
// Folder renames tried at most: one per folder the rule allows.
const MAX_RENAMES = 16;

const placeError = (reason, extra = {}) => Object.assign(new Error(reason), { reason, ...extra });

function createPlacer({ fsImpl = fs, log = () => {}, renameFolder = renameNoReplace } = {}) {
  const placeFile = createPlaceFile({
    fs: fsImpl, platform: process.platform, log, stagedSuffix: MOVING_SUFFIX, restoreFailedEvent: 'team.model.receive_restore_failed',
  });
  const sameFile = (left, right) => {
    const a = regularFile(left, { fsImpl }) || sameLinked(left);
    const b = regularFile(right, { fsImpl }) || sameLinked(right);
    return Boolean(a && b && a.ino !== 0n && a.dev === b.dev && a.ino === b.ino);
  };
  // A file mid-placeFile has two links until the unlink runs.
  const sameLinked = (file) => {
    try {
      const stat = fsImpl.lstatSync(file, { bigint: true });
      return stat.isFile() ? stat : null;
    } catch (_error) {
      return null;
    }
  };

  // Where each item stands at a stage: 0 staging, 1 `<staging>/set/<name>`, 2 `<root>/<journal folder>/<name>`.
  function itemsOf({ manifest, main, stagingDir, root }, journal) {
    const items = manifest.files.map((file, index) => ({
      index, name: file.name, size: file.size, staged: path.join(stagingDir, stagingFileName(index)),
    }));
    items.push({ index: items.length, name: `${main}${PROVENANCE_SUFFIX}`, size: null, staged: path.join(stagingDir, PROVENANCE_STAGED) });
    const mainItem = items.find((item) => item.name === main);
    const order = [...items.filter((item) => item !== mainItem), mainItem];
    const setDir = path.join(stagingDir, SET_DIR);
    const familyDir = path.join(root, journal.folder);
    const at = (item, stage) => {
      if (stage === 0) return item.staged;
      return stage === 2 ? path.join(familyDir, item.name) : path.join(setDir, item.name);
    };
    return { items, order, setDir, familyDir, at };
  }

  // A cut inside placeFile left `<location>.jenny-moving`: finish it or put it back. A rename fallback (no hard
  // links) may have moved the file to a neighbour stage. Then the item must be a regular file with one link and
  // its size where the journal says; anything else breaks the journal.
  function recoverItem(ctx, journal, item) {
    const { at } = itemsOf(ctx, journal);
    const { stages } = journal.placement;
    const stage = stages[item.index];
    const here = at(item, stage);
    const neighbours = [stage + 1, stage - 1].filter((next) => next >= 0 && next <= 1);
    const moving = `${here}${MOVING_SUFFIX}`;
    if (present(moving, fsImpl)) {
      const done = neighbours.find((next) => sameFile(moving, at(item, next)));
      if (done !== undefined) {
        fsImpl.unlinkSync(moving);
        stages[item.index] = done;
        return;
      }
      if (present(here, fsImpl)) throw placeError('model_journal_invalid');
      fsImpl.renameSync(moving, here);
    }
    if (regularFile(here, { size: item.size, fsImpl })) return;
    const moved = neighbours.find((next) => regularFile(at(item, next), { size: item.size, fsImpl }));
    if (moved === undefined || present(here, fsImpl)) throw placeError('model_journal_invalid');
    stages[item.index] = moved;
  }

  function recover(ctx, journal) {
    const { items, setDir, at } = itemsOf(ctx, journal);
    const { stages } = journal.placement;
    // A cut between the folder rename and its journal save.
    if (stages.every((stage) => stage === 1) && !present(setDir, fsImpl)
      && items.every((item) => regularFile(at(item, 2), { size: item.size, fsImpl }))) {
      stages.fill(2);
      return;
    }
    for (const item of items) recoverItem(ctx, journal, item);
  }

  // One move of an item to a stage; the target must be absent (never overwrite).
  async function move(ctx, journal, saveJournal, item, to) {
    const { at } = itemsOf(ctx, journal);
    const { stages } = journal.placement;
    const target = at(item, to);
    if (present(target, fsImpl)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    placeFile(at(item, stages[item.index]), target);
    stages[item.index] = to;
    saveJournal(journal);
  }

  /**
   * Moves every item back to staging from the journal, item by item, so one broken item does not stop the rest.
   * True when nothing of the set is left placed; false for a set already renamed into place.
   */
  async function rollBack(ctx, journal, saveJournal) {
    const { order } = itemsOf(ctx, journal);
    const { stages } = journal.placement;
    if (stages.every((stage) => stage === 2)) return false;
    let whole = true;
    for (const item of [...order].reverse()) {
      if (stages[item.index] === 0) continue;
      try {
        recoverItem(ctx, journal, item);
        if (stages[item.index] > 0) await move(ctx, journal, saveJournal, item, 0);
      } catch (error) {
        whole = false;
        log('WARN', 'team.model.receive_rollback_failed', { item: item.index, code: error?.code || error?.reason || 'unknown' });
      }
    }
    return whole && stages.every((stage) => stage === 0);
  }

  // A conflict rolls the placement back; a failed rollback keeps the journal for the next start.
  async function conflict(ctx, journal, saveJournal, reason) {
    journal.phase = 'rollback';
    journal.rollback_reason = reason;
    saveJournal(journal);
    const done = await rollBack(ctx, journal, saveJournal);
    // A journal that no longer matches the disk cannot be finished later: its staging goes whatever is left.
    throw placeError(reason, { kept: !done && reason !== 'model_journal_invalid' });
  }

  const conflictReason = (error) => {
    if (error?.code === 'EEXIST') return 'model_exists';
    return ROLLBACK_REASONS.includes(error?.reason) ? error.reason : '';
  };

  // The journal's folder is taken (it appeared since the accept): the next free folder of the rule, recorded in the
  // staged provenance file, then in the journal, before the rename is tried again (a cut between the two picks the
  // same folder again). None left is `model_exists`.
  function refolder(ctx, journal, saveJournal, setDir) {
    const picked = pickReceiveFolder(ctx.root, ctx.main, fsImpl);
    if (picked.refused) throw placeError(picked.refused);
    ctx.restamp?.(path.join(setDir, `${ctx.main}${PROVENANCE_SUFFIX}`), picked.folder);
    journal.folder = picked.folder;
    saveJournal(journal);
  }

  async function placeSet(ctx, journal, saveJournal, step, shouldYield) {
    const { items, setDir } = itemsOf(ctx, journal);
    const { stages } = journal.placement;
    if (!ownFolder(setDir, { create: true, fsImpl })) throw placeError('model_staging_failed');
    for (const item of items) {
      if (stages[item.index] !== 0) continue;
      await move(ctx, journal, saveJournal, item, 1);
      await step('moved', { index: item.index });
      if (shouldYield()) throw placeError('yield');
    }
    for (let tries = 0; tries < MAX_RENAMES; tries += 1) {
      const { familyDir } = itemsOf(ctx, journal);
      if (present(familyDir, fsImpl)) {
        refolder(ctx, journal, saveJournal, setDir);
        continue;
      }
      try {
        // A holder the rename could not remove is left at the name; the next pick of the folder rule removes it.
        await renameFolder(setDir, familyDir, { onLeft: () => log('WARN', 'team.model.receive_holder_left', {}) });
      } catch (error) {
        if (error?.code === 'EEXIST' && present(setDir, fsImpl)) continue;
        throw placeError('model_staging_failed');
      }
      stages.fill(2);
      saveJournal(journal);
      await step('renamed', {});
      return;
    }
    throw placeError('model_exists');
  }

  /**
   * Places the set from wherever the journal says it stands. `ctx` is `{ manifest, main, stagingDir, root, restamp }`
   * (`restamp(file, folder)` rewrites the staged provenance file for a new folder). `step(name, detail)` is awaited
   * after each move (a test seam); `shouldYield()` is asked between moves and stops the run there (dispose). Throws an
   * error with `reason`: a rollback reason (`kept` when its rollback failed), `model_staging_failed` (resumable) or
   * `yield`.
   */
  async function placeAll({ ctx, journal, saveJournal, step = async () => {}, shouldYield = () => false }) {
    if (journal.phase === 'rollback') return conflict(ctx, journal, saveJournal, journal.rollback_reason);
    if (!journal.placement) {
      journal.placement = { mode: 'new', stages: Array(ctx.manifest.files.length + 1).fill(0) };
      saveJournal(journal);
    }
    try {
      recover(ctx, journal);
      saveJournal(journal);
      if (journal.placement.stages.every((stage) => stage === 2)) return undefined;
      await placeSet(ctx, journal, saveJournal, step, shouldYield);
      return undefined;
    } catch (error) {
      const reason = conflictReason(error);
      if (reason) return conflict(ctx, journal, saveJournal, reason);
      if (error?.reason) throw error;
      log('WARN', 'team.model.receive_place_failed', { code: error?.code || 'unknown' });
      throw placeError('model_staging_failed');
    }
  }

  return Object.freeze({ placeAll, rollBack });
}

module.exports = { createPlacer };
