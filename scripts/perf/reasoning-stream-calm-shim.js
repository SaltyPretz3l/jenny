/* global window */
'use strict';

// Browser-side entry of the reasoning-stream calm probe. esbuild bundles it
// together with the jsdom-free createShellStub from tests/helpers (aliased
// 'probe-harness', with ./renderer-shell-harness-dom swapped for the dom shim
// next to this file) and the probe injects the result before the first
// <script> of index.html, so window.jennyShell exists when the renderer boots.

const { loadRendererApp } = require('probe-harness');
const { buildFeatureFlagDefaults } = require('probe-feature-flags');

const config = window.__PROBE_CONFIG__ || {};
const SESSION_ID = 'sess_calm_probe';
const STREAM_ID = 'stream_calm_probe';

window.__jennyTestHooks = {
  captureRendererState(rendererState) {
    window.__rendererState = rendererState;
  },
};
// The starfield holds a warm start for ~1.6 s; the probe runs the plain curtain.
window.__JENNY_STARTUP_ANIMATION = 'off';

loadRendererApp({
  shell: {
    features: { state: { featureFlags: { ...buildFeatureFlagDefaults() } } },
    chatUi: {
      async getState() {
        return { transcriptViewDefault: config.view === 'answers' ? 'answers' : 'thinking' };
      },
    },
    chat: {
      async startStream(_payload, { state }) {
        state.sessions = [{
          id: SESSION_ID,
          title: 'Calm probe',
          conversation_mode: 'chat',
          preferred_model: 'gpt-test',
          updated_at: new Date().toISOString(),
          linked_session_ids: [],
          context_preferences: { history_scope: 'session', include_personality: true, include_memory: true },
        }];
        state.messagesBySession.set(SESSION_ID, []);
        return { sessionId: SESSION_ID, streamId: STREAM_ID };
      },
    },
  },
});

window.__calmProbeIds = { sessionId: SESSION_ID, streamId: STREAM_ID };
