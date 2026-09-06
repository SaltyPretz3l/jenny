'use strict';

/**
 * Scheduler persistence schema versions.
 *
 * v2 — original builtin_memory + sub_agent task records with scalar last_*
 *      result fields.
 * v3 — adds `kind: 'automation'` task discriminator + nested
 *      `automation_runs: [...]` array under each automation record (per
 *      Section 18 Option A of the monitors/automations plan).
 *
 * Forward-version safety (per scheduler-service.js): files with a version
 * newer than this constant log a warning and return an empty state instead
 * of throwing, so older builds continue to load.
 */
// v4 retires builtin-memory and sub-agent planner/verifier rows. The current
// store accepts v2/v3 as migration inputs and writes automation-only v4.
const SCHEDULED_TASKS_SCHEMA_VERSION = 4;

module.exports = {
  SCHEDULED_TASKS_SCHEMA_VERSION,
};
