const SESSION_STORE_KEYS = [
  'sessionStore',
  'shadowStore',
  'turnEventJournal',
  'terminalRepairStore',
];

function drainSessionStoresSync(service) {
  for (const key of SESSION_STORE_KEYS) {
    const store = service ? service[key] : null;
    if (!store) {
      continue;
    }
    try {
      if (typeof store.dispose === 'function') {
        store.dispose();
      } else if (typeof store.flush === 'function') {
        store.flush();
      }
    } catch (_error) {
      // Best-effort shutdown drain.
    }
  }
}

async function flushSessionStoresAsync(service) {
  const drains = SESSION_STORE_KEYS.map((key) => {
    const store = service ? service[key] : null;
    if (!store) {
      return Promise.resolve();
    }
    return Promise.resolve()
      .then(() => {
        if (typeof store.flushAsync === 'function') {
          return store.flushAsync();
        }
        if (typeof store.flush === 'function') {
          return store.flush();
        }
        return undefined;
      })
      .catch(() => null);
  });
  await Promise.all(drains);
}

module.exports = {
  drainSessionStoresSync,
  flushSessionStoresAsync,
};
