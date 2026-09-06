'use strict';

const { evaluateMigration } = require('./migration-interpreter');

const MIGRATIONS_PATH = 'META-JENNY/migrations.json';
const MAX_MIGRATIONS_BYTES = 256 * 1024;
function parseMigrations(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_MIGRATIONS_BYTES) return { ok: false, reason: 'migration_descriptor_invalid' };
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch (_error) { return { ok: false, reason: 'migration_descriptor_invalid' }; }
  if (!value || value.migrations_schema_version !== 1 || !Array.isArray(value.migrations) || value.migrations.length > 64) {
    return { ok: false, reason: 'migration_descriptor_invalid' };
  }
  const migrations = [];
  for (const item of value.migrations) {
    if (!item || !Number.isInteger(item.from_version) || !Number.isInteger(item.to_version)
      || item.to_version !== item.from_version + 1 || item.executorTier !== 'declarative'
      || !Array.isArray(item.steps)) return { ok: false, reason: 'migration_descriptor_invalid' };
    migrations.push(item);
  }
  return { ok: true, migrations };
}
function findMigrationPath(migrations, fromVersion, toVersion) {
  if (fromVersion === toVersion) return { ok: true, steps: [] };
  if (toVersion < fromVersion) return { ok: false, reason: 'migration_downgrade_unsupported' };
  const byFrom = new Map(migrations.map((item) => [item.from_version, item])); const steps = [];
  for (let cursor = fromVersion; cursor < toVersion; cursor += 1) {
    const step = byFrom.get(cursor);
    if (!step || step.to_version !== cursor + 1) return { ok: false, reason: 'migration_path_missing' };
    steps.push(step);
  }
  return { ok: true, steps };
}
function applyMigrationPath(value, steps, limits) {
  let current = value;
  for (const step of steps) {
    const result = evaluateMigration({ migration: { executorTier: 'declarative', steps: step.steps }, input: current, limits });
    if (!result.ok) return { ok: false, reason: 'declarative_migration_failed', detail: result.reason };
    current = result.value;
  }
  return { ok: true, value: current };
}
module.exports = { MIGRATIONS_PATH, MAX_MIGRATIONS_BYTES, parseMigrations, findMigrationPath, applyMigrationPath };
