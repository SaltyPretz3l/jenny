// Pending session-store migration scheduler.
//
// Debounces pending-migration runs across the primary session store and the
// shadow store via a single unref'd setImmediate, guarded by backend lifecycle
// flags.

function schedulePendingSessionMigrations(service) {
  if (service._disposed || service._stopping || service._pendingSessionMigrationScheduled) {
    return;
  }
  const stores = [
    ['session_store', service.sessionStore],
    ['session_shadow_store', service.shadowStore],
  ].filter(([, store]) => typeof store?.hasPendingMigrations === 'function' && store.hasPendingMigrations());
  if (!stores.length) {
    return;
  }
  service._pendingSessionMigrationScheduled = true;
  service._emitServiceLog('INFO', 'backend.session_migrations_queued', {
    stores: stores.map(([name]) => name),
  });
  service._pendingSessionMigrationImmediate = setImmediate(() => {
    service._pendingSessionMigrationImmediate = null;
    if (service._disposed || service._stopping) {
      service._pendingSessionMigrationScheduled = false;
      service._emitServiceLog('DEBUG', 'backend.session_migrations_skipped', {
        reason: service._disposed ? 'disposed' : 'stopping',
      });
      return;
    }
    void service.runPendingMigrations();
  });
  if (typeof service._pendingSessionMigrationImmediate.unref === 'function') {
    service._pendingSessionMigrationImmediate.unref();
  }
}

function clearPendingSessionMigrationSchedule(service) {
  if (service._pendingSessionMigrationImmediate) {
    clearImmediate(service._pendingSessionMigrationImmediate);
    service._pendingSessionMigrationImmediate = null;
  }
  service._pendingSessionMigrationScheduled = false;
}

async function runPendingMigrations(service) {
  const stores = [
    ['session_store', service.sessionStore],
    ['session_shadow_store', service.shadowStore],
  ];
  const results = [];
  try {
    for (const [name, store] of stores) {
      if (service._disposed || service._stopping) {
        break;
      }
      if (typeof store?.hasPendingMigrations !== 'function' || !store.hasPendingMigrations()) {
        continue;
      }
      try {
        const result = await store.runPendingMigrations();
        if (service._disposed || service._stopping) {
          break;
        }
        results.push({ name, ...result });
        service._emitServiceLog(result.success ? 'INFO' : 'WARN', 'backend.session_migration_completed', {
          store: name,
          success: result.success === true,
          sessionCount: Number(result.sessionCount || 0),
        });
      } catch (error) {
        if (service._disposed || service._stopping) {
          break;
        }
        results.push({ name, success: false, error: String(error?.message || error) });
        service._emitServiceLog('WARN', 'backend.session_migration_failed', {
          store: name,
          message: String(error?.message || error),
        });
      }
    }
    return results;
  } finally {
    service._pendingSessionMigrationScheduled = false;
  }
}

module.exports = {
  schedulePendingSessionMigrations,
  clearPendingSessionMigrationSchedule,
  runPendingMigrations,
};
