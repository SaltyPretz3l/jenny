'use strict';

// The member's project file transfers for one team (row 123 slice 3-9, commit 3; TEAM_PROJECTS_SPEC "Upload and
// download"): `uploadFolder`, `uploadCancel`, `downloadProject` and `downloadCancel`, built by team-projects.js per
// team. The folder is picked here, in main (the renderer never names a path): `pickFolder()` answers an absolute
// path or null for a cancelled dialog (the default is the host launcher's Electron folder dialog, loaded lazily).
//
// One upload and one download per team at a time (`team_transfer_busy`); the slot is claimed before the folder dialog
// opens, so two quick calls open one dialog and one walk. An upload's folder walk and caps are checked
// in the call, so a refusal answers it; the hashing, parts and commit run after the answer and report on the
// `team.onProject` push (`kind: 'transfer'`, at most twice a second, every state change at once). Cancel stops within
// one part and discards the host's staged upload. A revoke, a leave, a Force local hold and the app's stop end every
// transfer of the team at once (`stop`) and send nothing more; the host's idle sweep removes a staged upload left so.
// Pushes and logs carry team and project ids, counts, byte totals and reason words; a download's done push names the
// folder the member picked, an upload's push names the picked folder's own name only.

const path = require('node:path');

const { forceLocalFailure } = require('./force-local-hold');
const { invalidRequest } = require('./team-errors');
const { TransferEnd, createReconnectWaiters, progressPusher } = require('./transfer-common');
const { folderRefusal, runDownload } = require('./transfer-download');
const { planUpload, runUpload } = require('./transfer-upload');

const defaultPickFolder = () => require('./host/host-launch').electronPickFolder();

function createProjectTransfers({
  manager, teamId, push = () => {}, log = () => {}, isHeld = () => false, online = () => false,
  pickFolder = defaultPickFolder, clock = Date.now,
}) {
  const running = { upload: null, download: null }; // direction -> { projectId, controller, task }
  const waiters = createReconnectWaiters();
  let stopped = false;
  const say = (level, event, fields = {}) => { try { log(level, event, { team_id: teamId, ...fields }); } catch { /* best effort */ } };
  const send = (payload) => { if (!stopped) { try { push(payload); } catch { say('WARN', 'team.transfer.push_failed'); } } };

  async function picked() {
    try {
      const folder = await pickFolder();
      return typeof folder === 'string' && path.isAbsolute(folder) ? folder : null;
    } catch {
      return null;
    }
  }

  // The direction's slot, held from before the folder dialog until the transfer ends (or the call refuses).
  function claim(direction, projectId) {
    const entry = { projectId, controller: new AbortController(), task: null };
    running[direction] = entry;
    return entry;
  }

  function unclaim(direction, entry) {
    if (running[direction] === entry && entry.task === null) running[direction] = null;
  }

  // A refusal while the slot is held: Force local, the app's stop, a cancel during the dialog or the walk.
  function interrupted(entry) {
    if (isHeld()) return forceLocalFailure();
    if (stopped) return invalidRequest('team_disposed');
    return entry.controller.signal.aborted ? { ok: true, started: false } : null;
  }

  // Runs `work` after the call has answered; its end is pushed once (done, failed or cancelled).
  function start(direction, entry, work) {
    const { projectId, controller } = entry;
    const progress = progressPusher(send, clock, { direction, project_id: projectId });
    entry.task = (async () => {
      try {
        const result = await work({ signal: controller.signal, progress });
        progress({ state: 'done', ...result }, true);
        say('INFO', 'team.transfer.done', { direction, project_id: projectId, files: result.files, bytes: result.bytes });
      } catch (error) {
        const reason = error instanceof TransferEnd ? error.reason : 'team_transfer_failed';
        if (reason === 'aborted') progress({ state: 'cancelled' }, true);
        else progress({ state: 'failed', reason }, true);
        say(reason === 'aborted' ? 'INFO' : 'WARN', 'team.transfer.ended', { direction, project_id: projectId, reason });
        if (!(error instanceof TransferEnd)) say('ERROR', 'team.transfer.error', { direction, project_id: projectId });
      } finally {
        if (running[direction] === entry) running[direction] = null;
      }
    })();
    return entry;
  }

  // A lost answer while the team still reads as online (a timed-out part) goes on at once; the stall count bounds it.
  const deps = (signal, progress) => ({ manager, signal, progress, stopped: () => stopped,
    waitReconnect: (s) => (online() ? Promise.resolve() : waiters.wait(s)) });

  async function uploadFolder({ project_id: projectId }) {
    if (running.upload) return invalidRequest('team_transfer_busy');
    const entry = claim('upload', projectId);
    try {
      return await beginUpload(entry, projectId);
    } finally {
      unclaim('upload', entry);
    }
  }

  async function beginUpload(entry, projectId) {
    const folder = await picked();
    if (!folder) return { ok: true, started: false };
    const early = interrupted(entry); if (early) return early;
    const planned = await planUpload(folder).catch(() => ({ ok: false, reason: 'team_upload_unreadable' }));
    if (!planned.ok) return invalidRequest(planned.reason);
    const late = interrupted(entry); if (late) return late;
    start('upload', entry, async ({ signal, progress }) => {
      try {
        return await runUpload({ ...deps(signal, progress), projectId, plan: planned });
      } catch (error) {
        // Anything but a commit that answered leaves the host's staged upload to discard (not after stop).
        if (planned.uploadId && !planned.committed && !stopped) {
          await manager.command('team.project.upload.discard', { project_id: projectId, upload_id: planned.uploadId })
            .catch(() => {});
        }
        throw error;
      }
    });
    return { ok: true, started: true, folder: planned.folderName, files: planned.files.length, bytes: planned.bytes,
      links_skipped: planned.links, unreadable: planned.unreadable };
  }

  async function downloadProject({ project_id: projectId }) {
    if (running.download) return invalidRequest('team_transfer_busy');
    const entry = claim('download', projectId);
    try {
      const folder = await picked();
      if (!folder) return { ok: true, started: false };
      const early = interrupted(entry); if (early) return early;
      const refused = await folderRefusal(folder);
      if (refused) return invalidRequest(refused);
      const late = interrupted(entry); if (late) return late;
      start('download', entry, ({ signal, progress }) => runDownload({ ...deps(signal, progress), projectId, folder }));
      return { ok: true, started: true };
    } finally {
      unclaim('download', entry);
    }
  }

  async function cancel(direction) {
    const entry = running[direction];
    if (!entry) return { ok: true };
    entry.controller.abort();
    if (entry.task) await entry.task;
    return { ok: true };
  }

  async function call(method, value) {
    if (isHeld()) return forceLocalFailure();
    if (stopped) return invalidRequest('team_disposed');
    // A cancel is local and works offline; a start needs the team online.
    if (method === 'uploadCancel') return cancel('upload');
    if (method === 'downloadCancel') return cancel('download');
    if (!online()) return invalidRequest('team_not_connected');
    if (method === 'uploadFolder') return uploadFolder(value);
    if (method === 'downloadProject') return downloadProject(value);
    return invalidRequest();
  }

  function stop() {
    stopped = true;
    for (const entry of Object.values(running)) entry?.controller.abort();
  }

  return {
    call, stop,
    reconnected: () => waiters.reconnected(),
    settled: () => Promise.all(Object.values(running).map((entry) => entry?.task)),
    resources: () => ({ transfers: (running.upload ? 1 : 0) + (running.download ? 1 : 0), timers: 0, waiting: waiters.size() }),
  };
}

module.exports = { createProjectTransfers };
