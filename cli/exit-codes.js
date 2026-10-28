'use strict';

// Frozen with the cli.v1 schema (Jenny CLI plan, decision 8): the numbers live
// with the projection so the result frame and the process exit never disagree.
const { EXIT_CODES } = require('../services/cli-host/event-projection');

const CLI_VERSION = '0.1.0';
const CLI_CONTRACT = 'cli.v1';

const EXIT_CODE_MEANINGS = Object.freeze({
  [EXIT_CODES.OK]: 'ok',
  [EXIT_CODES.RUNTIME_ERROR]: 'runtime or model error',
  [EXIT_CODES.USAGE]: 'usage or configuration error',
  [EXIT_CODES.POLICY_DENIED]: 'the turn ended on a policy denial',
  [EXIT_CODES.DECISION_REQUIRED]: 'a human decision or input was required',
  [EXIT_CODES.BUDGET]: 'a budget or timeout was reached',
  [EXIT_CODES.ENGINE_UNAVAILABLE]: 'the engine or profile is unavailable (retryable)',
  [EXIT_CODES.PROFILE_BUSY]: 'another Jenny CLI holds the profile',
  [EXIT_CODES.SIGINT]: 'interrupted',
  [EXIT_CODES.SIGTERM]: 'terminated',
});

module.exports = { CLI_CONTRACT, CLI_VERSION, EXIT_CODES, EXIT_CODE_MEANINGS };
