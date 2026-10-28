'use strict';

// Agent-driven launches (JENNY_AGENT_DEV, set by `node start.js --agent` and the
// automation harnesses) stay quiet by default so a run never interrupts the
// owner: the window reveals without taking focus, no OS toasts fire, and a
// fresh profile skips the "How Jenny works" disclosure and the first-run setup
// overlay. JENNY_AGENT_QUIET=0 restores a normal launch (to drive onboarding or
// notification behaviour), and an explicit JENNY_WINDOW_REVEAL_INACTIVE wins
// over the window default either way.

const ON_PATTERN = /^(1|true|yes|on)$/i;
const OFF_PATTERN = /^(0|false|no|off)$/i;

function envToken(value) {
  return String(value == null ? '' : value).trim();
}

function isAgentQuietLaunch(env = {}) {
  return ON_PATTERN.test(envToken(env.JENNY_AGENT_DEV))
    && !OFF_PATTERN.test(envToken(env.JENNY_AGENT_QUIET));
}

function shouldRevealWindowInactive(env = {}) {
  const explicit = envToken(env.JENNY_WINDOW_REVEAL_INACTIVE);
  if (explicit) return ON_PATTERN.test(explicit);
  return isAgentQuietLaunch(env);
}

const agentQuietLaunchMethods = {
  // Marks the disclosure acknowledged and the first-run flow done, once, so the
  // renderer never opens either overlay. Never touches a profile that already
  // acknowledged and finished (a real profile driven in agent mode).
  _seedAgentQuietSetupOnce() {
    if (!isAgentQuietLaunch(this.env)) return;
    // Lazy: the renderer scene module loads only for agent launches.
    const { DISCLOSURE_VERSION } = require('../renderer/features/setup-scenes/scene-utils');
    const setup = this.state.setup;
    const acknowledged = setup.acknowledgedVersion === DISCLOSURE_VERSION;
    if (acknowledged && (setup.firstRunCompleted || setup.setupComplete)) return;
    const nowIso = this._getNow().toISOString();
    this._writeState({
      ...this.state,
      setup: {
        ...setup,
        firstRunCompleted: true,
        ...(acknowledged ? {} : {
          acknowledgedVersion: DISCLOSURE_VERSION,
          acknowledgedAt: nowIso,
          steps: { ...setup.steps, acknowledgement: 'done' },
        }),
      },
    }, 'setup_seeded_for_agent_launch');
  },
};

module.exports = {
  agentQuietLaunchMethods,
  isAgentQuietLaunch,
  shouldRevealWindowInactive,
};
