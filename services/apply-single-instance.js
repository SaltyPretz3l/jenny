function defaultShowProfileOwnerError(title, message) {
  try {
    require('electron').dialog?.showErrorBox(title, message);
  } catch (_error) {
    // The Electron dialog is unavailable only in non-Electron harnesses.
  }
}

function applySingleInstance(app, onSecondInstance, dependencies = {}) {
  if (typeof app.getPath === 'function') {
    const claimDesktopProfile = dependencies.claimDesktopProfile
      || require('./host/profile-ownership').claimDesktopProfile;
    try {
      claimDesktopProfile(app.getPath('userData'));
    } catch (_error) {
      const showErrorBox = dependencies.showErrorBox || defaultShowProfileOwnerError;
      showErrorBox(
        'Jenny could not open this profile',
        'The Jenny profile ownership marker could not be read or repaired. Check profile permissions and try again.'
      );
      app.quit();
      return false;
    }
  }
  const hasLock = app.requestSingleInstanceLock();
  if (!hasLock) {
    app.quit();
    return false;
  }

  app.on('second-instance', (...args) => {
    if (typeof onSecondInstance === 'function') {
      onSecondInstance(...args);
    }
  });
  return true;
}

function startWhenSingleInstanceAvailable({
  acquireLock = () => true,
  onStart = () => {},
} = {}) {
  const hasLock = acquireLock();
  if (!hasLock) {
    return false;
  }

  onStart();
  return true;
}

module.exports = {
  applySingleInstance,
  startWhenSingleInstanceAvailable,
};
