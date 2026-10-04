'use strict';

const OFFICIAL_PUBLISHER_ID = 'jenny-official';
const SUPPORTED_KINDS = Object.freeze(['skill', 'prompt']);
const SUPPORTED_KIND_SET = new Set(SUPPORTED_KINDS);
const STAGE4B_KINDS = Object.freeze([
  'skill', 'prompt', 'theme', 'settings_schema', 'command', 'workflow', 'mcp_descriptor',
]);
const STAGE4B_KIND_SET = new Set(STAGE4B_KINDS);
const STAGE5_KINDS = Object.freeze(['skill', 'prompt', 'mcp_descriptor']);
const STAGE5_KIND_SET = new Set(STAGE5_KINDS);
const SNAPSHOT_ARRAY_BY_KIND = Object.freeze({
  skill: 'skill_scopes', prompt: 'prompts', theme: 'themes', settings_schema: 'settings_schemas',
  command: 'commands', workflow: 'workflows', mcp_descriptor: 'mcp_descriptors',
});
const EMPTY_DECLARATIVE_CONTENT = Object.freeze({
  skill_scopes: Object.freeze([]), prompts: Object.freeze([]), themes: Object.freeze([]),
  settings_schemas: Object.freeze([]), commands: Object.freeze([]),
  workflows: Object.freeze([]), mcp_descriptors: Object.freeze([]),
});
// Contribution kinds whose runtime tiers are retired. Installed packages that
// declare them stay listed, but the kinds compile to nothing.
const RETIRED_CONTRIBUTION_KINDS = Object.freeze([
  'mcp_descriptor',
  'restricted_transform', 'restricted_formatter', 'restricted_renderer', 'restricted_compute',
  'native_mcp', 'session_provider', 'engine_adapter', 'hook',
  'provider_descriptor', 'setup_scene',
  'command', 'workflow',
]);
const RETIRED_CONTRIBUTION_KIND_SET = new Set(RETIRED_CONTRIBUTION_KINDS);
const declaresRetiredKind = (manifest) => Array.isArray(manifest?.contributions)
  && manifest.contributions.some((item) => RETIRED_CONTRIBUTION_KIND_SET.has(item?.kind));
const ELIGIBILITY_REASON_CODES = Object.freeze([
  'eligible', 'already_active', 'safe_mode', 'store_read_only', 'not_first_party',
  'publisher_key_not_current', 'permissions_requested', 'dependencies_not_supported',
  'no_supported_contributions', 'mixed_or_unsupported_contributions',
  'package_record_unavailable',
]);

module.exports = {
  OFFICIAL_PUBLISHER_ID, SUPPORTED_KINDS, SUPPORTED_KIND_SET, STAGE4B_KINDS,
  STAGE4B_KIND_SET, STAGE5_KINDS, STAGE5_KIND_SET, SNAPSHOT_ARRAY_BY_KIND,
  EMPTY_DECLARATIVE_CONTENT, ELIGIBILITY_REASON_CODES,
  RETIRED_CONTRIBUTION_KINDS, RETIRED_CONTRIBUTION_KIND_SET, declaresRetiredKind,
};
