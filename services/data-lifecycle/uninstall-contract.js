'use strict';

const UNINSTALL_CHANNELS = Object.freeze({
  getOverview: 'data-lifecycle-uninstall:get-overview',
  chooseArchiveDestination: 'data-lifecycle-uninstall:choose-archive-destination',
  createArchive: 'data-lifecycle-uninstall:create-archive',
  previewWorkspaceArchive: 'data-lifecycle-uninstall:preview-workspace-archive',
  prepareRemoval: 'data-lifecycle-uninstall:prepare-removal',
  cancel: 'data-lifecycle-uninstall:cancel',
  complete: 'data-lifecycle-uninstall:complete',
  progress: 'data-lifecycle-uninstall:progress',
});

const UNINSTALL_EXIT_CODES = Object.freeze({
  CANCEL: 20,
  APP_ONLY: 21,
  ARCHIVE_AND_REMOVE: 22,
  PERMANENT: 23,
  HELPER_FAILURE: 24,
});

module.exports = { UNINSTALL_CHANNELS, UNINSTALL_EXIT_CODES };
