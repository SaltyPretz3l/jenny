function applySingleInstance(app, onSecondInstance) {
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
