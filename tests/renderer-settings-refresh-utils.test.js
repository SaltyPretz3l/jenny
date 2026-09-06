const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runSettingsRefreshBatch,
} = require('../renderer/shell/renderer-settings-refresh-utils');

test('settings refresh batch isolates synchronous task failures', async () => {
  const state = {};
  const logs = [];
  const settled = await runSettingsRefreshBatch({
    sectionId: 'diagnostics',
    state,
    appendClientLog(level, event, payload) {
      logs.push({ level, event, payload });
    },
    tasks: [
      {
        name: 'phase_percentiles',
        run() {
          throw new Error('sync boom');
        },
      },
      {
        name: 'observability',
        run: async () => 'ok',
      },
    ],
  });

  assert.equal(settled.length, 2);
  assert.equal(settled[0].status, 'rejected');
  assert.equal(settled[1].status, 'fulfilled');
  assert.deepEqual(state.settingsRefresh.degradedBySection.diagnostics, [
    {
      source: 'phase_percentiles',
      message: 'sync boom',
    },
  ]);
  assert.deepEqual(logs, [
    {
      level: 'WARN',
      event: 'settings.section_refresh_source_failed',
      payload: {
        section: 'diagnostics',
        source: 'phase_percentiles',
        message: 'sync boom',
      },
    },
  ]);
});

test('settings refresh batch clears degraded state after a clean refresh', async () => {
  const state = {
    settingsRefresh: {
      degradedBySection: {
        diagnostics: [{ source: 'old', message: 'old' }],
      },
    },
  };

  await runSettingsRefreshBatch({
    sectionId: 'diagnostics',
    state,
    tasks: [
      {
        name: 'phase_percentiles',
        run: async () => 'ok',
      },
    ],
  });

  assert.equal(Object.hasOwn(state.settingsRefresh.degradedBySection, 'diagnostics'), false);
});
