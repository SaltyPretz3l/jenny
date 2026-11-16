'use strict';

// Row 142: llamaServer.chooseRuntimeFolder / runtimeOptions / useRuntimeBuild,
// and S3's runtimeDownloadStart / Status / Cancel and runtimeFolderSummary.
// A runtime folder is a place main will run programs from, so it enters only
// through this main dialog and the manager's folder-pick registry; the
// renderer then saves the list through engines.updateSettings, which keeps a
// new folder only if this dialog returned it. Build options name builds by an
// opaque per-session id; paths never cross IPC except the folder the user just
// picked (echoed for the list, as chooseLibraryFolder does). Results carry
// reason codes only, and so do the logs. The download channels take an
// architecture string at most: main (llama-server-runtime-download.js) owns the
// catalog, the URL and every path.

const fs = require('fs');

const { registerIpcInvokeHandlers } = require('../ipc-contract');
const { t } = require('../i18n-main');
const { buildFeatureFlags } = require('../feature-flags');
const { isLocalAbsolutePath, managedModelKey } = require('../shell-config-engines');
const { validateRuntimeExecutable } = require('./llama-server-runtime');

const REASON = /^[a-z][a-z0-9_]{0,79}$/;

function registerLlamaServerRuntimeIpcHandlers(ipcMainLike, {
  getManager = () => null,
  shellConfigService = null,
  dialogImpl = null,
  getMainWindow = () => null,
  authorization = null,
  log = () => {},
  env = process.env,
  fsImpl = fs,
  platform = process.platform,
  validateImpl = validateRuntimeExecutable,
  // Row 142 S3 "Get a build" (services/llama-server-runtime-download.js).
  runtimeDownload = null,
} = {}) {
  const enabled = () => buildFeatureFlags(env, shellConfigService?.getState?.()?.featureOverrides || {})
    .auto_runtime_pick === true;
  const finish = (action, result) => {
    try {
      log(result.ok ? 'INFO' : 'WARN', `llama.server.ipc_${action}`, {
        ok: result.ok,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(typeof result.picked === 'boolean' ? { picked: result.picked } : {}),
      });
    } catch (_error) { /* logging never breaks a result */ }
    return result;
  };
  const guarded = (action, call) => async (_event, payload) => {
    if (!enabled()) return finish(action, { ok: false, reason: 'flag_off' });
    try {
      return finish(action, await call(payload && typeof payload === 'object' ? payload : {}));
    } catch (error) {
      const reason = REASON.test(String(error?.reason || '')) ? error.reason : 'runtime_option_failed';
      return finish(action, { ok: false, reason });
    }
  };
  const managed = () => shellConfigService?.getLocalEngines?.()?.openaiCompatible?.managed || null;
  const entryFor = (modelTag) => {
    const key = managedModelKey(typeof modelTag === 'string' ? modelTag.slice(0, 512) : '');
    const perModel = managed()?.perModel;
    const entry = key && perModel && Object.prototype.hasOwnProperty.call(perModel, key) ? perModel[key] : null;
    return entry && entry.engine === 'llama-server' ? { key, entry } : null;
  };

  const chooseRuntimeFolder = guarded('choose_runtime_folder', async () => {
    const manager = getManager();
    if (!manager?.runtimeFolderPicks || !dialogImpl) return { ok: false, reason: 'manager_unavailable' };
    const picked = await dialogImpl.showOpenDialog(getMainWindow(), {
      title: t('main.dialog.llamaServer.selectRuntimeFolder', 'Select a folder of llama-server builds'),
      properties: ['openDirectory'],
    });
    if (picked.canceled) return { ok: true, picked: false, path: '' };
    const selected = String(picked.filePaths?.[0] || '');
    if (!isLocalAbsolutePath(selected, { platform })) return { ok: false, reason: 'network_path' };
    // A junction or symlink resolves somewhere the user did not pick.
    try {
      if (!fsImpl.lstatSync(selected).isDirectory()) return { ok: false, reason: 'link_folder' };
    } catch (_error) {
      return { ok: false, reason: 'folder_missing' };
    }
    manager.runtimeFolderPicks.record(selected);
    return { ok: true, picked: true, path: selected };
  });

  const runtimeOptions = guarded('runtime_options', async (payload) => {
    const chooser = getManager()?.runtimeChooser;
    if (!chooser) return { ok: false, reason: 'manager_unavailable' };
    const found = entryFor(payload.modelTag);
    if (!found) return { ok: false, reason: 'unknown_model' };
    await chooser.prepare({ retryFailed: true });
    const options = chooser.optionsFor({
      modelPath: found.entry.modelPath || '',
      savedRuntimePath: typeof found.entry.runtimePath === 'string' ? found.entry.runtimePath : '',
    });
    let download = null;
    if (runtimeDownload && options.architecture) {
      await runtimeDownload.warm?.();
      download = runtimeDownload.offerFor({ architecture: options.architecture });
    }
    return { ok: true, architecture: options.architecture, current: options.current, candidates: options.candidates, download };
  });

  // The renderer names an architecture; main re-checks the offer and runs the job.
  const runtimeDownloadStart = guarded('runtime_download_start', async (payload) => {
    const chooser = getManager()?.runtimeChooser;
    if (!runtimeDownload || !chooser) return { ok: false, reason: 'manager_unavailable' };
    await chooser.prepare();
    return runtimeDownload.start({
      architecture: typeof payload.architecture === 'string' ? payload.architecture.slice(0, 64) : '',
    });
  });
  // Polled once a second while a download runs, so it writes no log line of its own.
  const runtimeDownloadStatus = async () => {
    if (!enabled()) return { ok: false, reason: 'flag_off' };
    return runtimeDownload ? { ok: true, ...runtimeDownload.status() } : { ok: false, reason: 'manager_unavailable' };
  };
  const runtimeDownloadCancel = guarded('runtime_download_cancel', async () => (
    runtimeDownload ? runtimeDownload.cancel() : { ok: false, reason: 'manager_unavailable' }
  ));
  const runtimeFolderSummary = guarded('runtime_folder_summary', async () => {
    const chooser = getManager()?.runtimeChooser;
    if (!chooser) return { ok: false, reason: 'manager_unavailable' };
    // No saved folder: nothing to count, so no probe of every trusted build.
    const roots = managed()?.runtimeRoots;
    if (!Array.isArray(roots) || roots.length === 0) return { ok: true, folders: [] };
    await chooser.prepare();
    return { ok: true, folders: chooser.rootSummary() };
  });

  // The click is the user's choice, so the build becomes the model's saved
  // build, written by main after the build validates again.
  const useRuntimeBuild = guarded('use_runtime_build', async (payload) => {
    const chooser = getManager()?.runtimeChooser;
    if (!chooser || !shellConfigService?.updateManagedLlamaServer) return { ok: false, reason: 'manager_unavailable' };
    const found = entryFor(payload.modelTag);
    if (!found) return { ok: false, reason: 'unknown_model' };
    // The id must still name a trusted build now (a removed folder or a build that
    // stopped validating retires it), not merely one that was offered earlier.
    await chooser.prepare({ retryFailed: true });
    const binaryPath = chooser.pathForId(payload.id);
    if (!binaryPath || !chooser.isTrusted(binaryPath)) return { ok: false, reason: 'stale_option' };
    const checked = await validateImpl(binaryPath, { fsImpl, platform });
    if (!checked || checked.ok !== true || !checked.build) return { ok: false, reason: 'runtime_probe_failed' };
    // Re-read after the probe: a Tune save made meanwhile must not be overwritten.
    const fresh = entryFor(payload.modelTag);
    if (!fresh) return { ok: false, reason: 'unknown_model' };
    // "Use bundled" clears the saved build (Tune's Use bundled does the same), so the
    // install path is never saved and the automatic choice still applies later.
    const bundled = chooser.isBundled(binaryPath);
    const { runtimePath: _oldPath, runtimeBuild: _oldBuild, ...rest } = fresh.entry;
    shellConfigService.updateManagedLlamaServer({
      perModel: { [fresh.key]: bundled ? rest : { ...rest, runtimePath: binaryPath, runtimeBuild: checked.build } },
    });
    const saved = entryFor(payload.modelTag)?.entry;
    if ((saved?.runtimePath || '') !== (bundled ? '' : binaryPath)) return { ok: false, reason: 'not_saved' };
    return { ok: true, build: checked.build, ...(bundled ? { bundled: true } : {}) };
  });

  return registerIpcInvokeHandlers(ipcMainLike, {
    'llamaServer.chooseRuntimeFolder': chooseRuntimeFolder,
    'llamaServer.runtimeOptions': runtimeOptions,
    'llamaServer.useRuntimeBuild': useRuntimeBuild,
    'llamaServer.runtimeDownloadStart': runtimeDownloadStart,
    'llamaServer.runtimeDownloadStatus': runtimeDownloadStatus,
    'llamaServer.runtimeDownloadCancel': runtimeDownloadCancel,
    'llamaServer.runtimeFolderSummary': runtimeFolderSummary,
  // These hand main a place to run programs from, or choose one: a missing
  // authorizer trusts no sender (as llamaServer.chooseRuntime).
  }, typeof authorization?.authorize === 'function' ? authorization : { authorize: () => false });
}

module.exports = {
  registerLlamaServerRuntimeIpcHandlers,
};
