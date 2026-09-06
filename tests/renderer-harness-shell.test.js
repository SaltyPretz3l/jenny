const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadRendererApp,
} = require('./helpers/renderer-shell-harness');
const { waitForUiState } = require('./helpers/wait-for-ui-state');

test('top-level Diagnostics renders phase percentiles and resets samples', async (t) => {
  let stallDiagnosticsStatus = false;
  const app = await loadRendererApp({
    shell: {
      diagnostics: {
        getJennyStatus() {
          // A stalled peer source must not prevent the independently completed
          // phase-percentile source from painting in Diagnostics.
          return stallDiagnosticsStatus
            ? new Promise(() => {})
            : Promise.resolve({ schema_version: 3, backend: { phase: 'ready' } });
        },
        phasePercentiles: {
          async get({ state }) {
            return state.phasePercentilesPayload || {
              generated_at: '2026-04-19T00:00:00.000Z',
              retention: { samples_per_phase: 256 },
              targets: {
                provider_request_start_to_first_chunk: { p50: 150, p95: 400 },
              },
              phases: {
                provider_request_start_to_first_chunk: {
                  count: 3,
                  p50: 120,
                  p95: 260,
                  p99: 280,
                  min: 90,
                  max: 280,
                  last_N: 3,
                },
              },
            };
          },
        },
      },
    },
  });
  t.after(async () => {
    await app.dispose();
  });

  const { window } = app;
  stallDiagnosticsStatus = true;
  const diagnosticsTab = window.document.querySelector('[data-tab-id="logs"]');
  assert.ok(diagnosticsTab);
  diagnosticsTab.click();
  await waitForUiState(
    window,
    () => /Provider start to first chunk/i.test(
      window.document.getElementById('phasePercentilesTable').textContent
    ),
    { message: 'Diagnostics did not render the phase percentile snapshot.' }
  );

  assert.equal(window.document.getElementById('logsView').getAttribute('aria-hidden'), 'false');
  assert.match(window.document.getElementById('diagnosticsBadge').textContent, /Healthy/i);
  assert.match(window.document.getElementById('phasePercentilesTable').textContent, /Provider start to first chunk/i);
  assert.match(window.document.getElementById('phasePercentilesTable').textContent, /120ms/i);
  assert.match(window.document.getElementById('phasePercentilesTable').textContent, /pass/i);

  window.document.getElementById('phasePercentilesResetButton').click();
  await waitForUiState(
    window,
    () => app.shell.__state.phasePercentilesResetCalls === 1
      && /0/i.test(window.document.getElementById('phasePercentilesTable').textContent),
    { message: 'Diagnostics did not render the reset phase percentile snapshot.' }
  );

  assert.equal(app.shell.__state.phasePercentilesResetCalls, 1);
  assert.match(window.document.getElementById('diagnosticsBadge').textContent, /Healthy/i);
  assert.match(window.document.getElementById('phasePercentilesTable').textContent, /0/i);
});
