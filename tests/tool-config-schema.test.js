const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TOOL_CONFIG_SCHEMA_VERSION,
  TOOL_SETTING_KEYS,
  buildToolConfigFieldsFromManifest,
  getToolConfigDefaults,
  getToolConfigFields,
  normalizeToolSettings,
} = require('../services/tool-config-schema');

test('tool config schema loads declarative fields from the tool manifest', () => {
  const fields = getToolConfigFields();
  const web = fields.find((field) => field.key === 'web');

  assert.equal(TOOL_CONFIG_SCHEMA_VERSION, 2);
  assert.ok(web);
  assert.equal(web.label, 'Web tools');
  assert.equal(web.fieldType, 'toggle');
  assert.equal(web.storage, 'config');
  assert.equal(web.default, false);
  assert.equal(web.configFlag, 'tools_web_enabled');
  assert.deepEqual(web.toolIds, ['web_search', 'fetch_url']);
  assert.ok(TOOL_SETTING_KEYS.includes('web'));
  assert.equal(getToolConfigDefaults().web, false);
});

test('tool config schema declares composer toggle preferences for bash and file tools', () => {
  const fields = getToolConfigFields();
  const bash = fields.find((field) => field.key === 'bash');
  const fileTools = fields.find((field) => field.key === 'fileTools');

  assert.ok(bash, 'bash preference field exists');
  assert.equal(bash.label, 'Terminal commands');
  assert.equal(bash.fieldType, 'toggle');
  assert.equal(bash.default, true, 'bash defaults on to preserve current behavior');
  assert.equal(bash.configFlag, '', 'send-time preference only; no sidecar availability flag');
  assert.deepEqual(bash.toolIds, [
    'run_command',
    'run_temp_script',
    'check_background_job',
    'stop_background_job',
  ]);

  assert.ok(fileTools, 'fileTools preference field exists');
  assert.equal(fileTools.label, 'File tools');
  assert.equal(fileTools.default, true, 'fileTools defaults on to preserve current behavior');
  assert.equal(fileTools.configFlag, '', 'send-time preference only; no sidecar availability flag');
  assert.deepEqual(
    fileTools.toolIds,
    ['read_file', 'write_file', 'edit_file', 'delete_file', 'move_file', 'glob_files', 'grep_search', 'list_dir', 'create_artifact']
  );

  assert.equal(getToolConfigDefaults().bash, true);
  assert.equal(getToolConfigDefaults().fileTools, true);
});

test('tool config schema defaults read-only delegation on with one public tool id', () => {
  const subagents = getToolConfigFields().find((field) => field.key === 'subagents');

  assert.ok(subagents);
  assert.equal(subagents.default, true);
  assert.equal(subagents.configFlag, 'tools_subagents_enabled');
  assert.deepEqual(subagents.toolIds, ['delegate']);
  assert.equal(getToolConfigDefaults().subagents, true);
});

test('tool config normalization merges schema defaults with saved settings', () => {
  const customFields = [
    {
      key: 'web',
      label: 'Web tools',
      fieldType: 'toggle',
      storage: 'config',
      default: false,
      toolIds: ['web_search', 'fetch_url'],
    },
    {
      key: 'futureTool',
      label: 'Future tool',
      fieldType: 'toggle',
      storage: 'config',
      default: true,
      toolIds: ['future_tool'],
    },
  ];

  assert.deepEqual(
    normalizeToolSettings({ web: true }, {}, customFields),
    {
      web: true,
      futureTool: true,
    }
  );
  assert.deepEqual(
    normalizeToolSettings({ web: 'yes', futureTool: false }, {}, customFields),
    {
      web: false,
      futureTool: false,
    }
  );
});

test('tool config normalization preserves legacy shell-config toggle aliases', () => {
  assert.equal(
    normalizeToolSettings({}, { tools_python_runtime_enabled: true }).pythonRuntime,
    true
  );
  assert.equal(
    normalizeToolSettings({ python_runtime: true }, {}).pythonRuntime,
    true
  );
  assert.equal(
    normalizeToolSettings({ image_read_enabled: true }, {}).imageRead,
    true
  );
});

test('tool config schema rejects password fields until secure storage exists', () => {
  assert.throws(
    () =>
      buildToolConfigFieldsFromManifest({
        tools: [
          {
            name: 'secret_tool',
            config_schema: [
              {
                key: 'apiKey',
                label: 'API key',
                field_type: 'password',
                storage: 'config',
                default: '',
              },
            ],
          },
        ],
      }),
    /secret_tool.*config_schema.*field_type/
  );
});

test('tool config schema rejects non-boolean toggle defaults', () => {
  assert.throws(
    () =>
      buildToolConfigFieldsFromManifest({
        tools: [
          {
            name: 'bad_toggle',
            config_schema: [
              {
                key: 'badToggle',
                label: 'Bad toggle',
                field_type: 'toggle',
                storage: 'config',
                default: 'true',
              },
            ],
          },
        ],
      }),
    /bad_toggle.*config_schema.*default/
  );
});

test('tool config schema rejects malformed optional metadata fields', () => {
  assert.throws(
    () =>
      buildToolConfigFieldsFromManifest({
        tools: [
          {
            name: 'bad_flag',
            config_schema: [
              {
                key: 'badFlag',
                label: 'Bad flag',
                field_type: 'toggle',
                storage: 'config',
                default: false,
                config_flag: false,
              },
            ],
          },
        ],
      }),
    /bad_flag.*config_schema.*config_flag/
  );

  assert.throws(
    () =>
      buildToolConfigFieldsFromManifest({
        tools: [
          {
            name: 'bad_tool_ids',
            config_schema: [
              {
                key: 'badToolIds',
                label: 'Bad tool ids',
                field_type: 'toggle',
                storage: 'config',
                default: false,
                tool_ids: 'bad_tool_ids',
              },
            ],
          },
        ],
      }),
    /bad_tool_ids.*config_schema.*tool_ids/
  );
});

test('tool config schema rejects malformed tool and config_schema containers', () => {
  assert.throws(
    () =>
      buildToolConfigFieldsFromManifest({
        tools: [null],
      }),
    /tool manifest entry 0 must be an object/
  );

  assert.throws(
    () =>
      buildToolConfigFieldsFromManifest({
        tools: [
          {
            name: 'bad_schema',
            config_schema: {
              key: 'bad',
            },
          },
        ],
      }),
    /bad_schema.*config_schema must be a list/
  );
});

test('tool config schema rejects unsupported non-toggle fields', () => {
  assert.throws(
    () =>
      buildToolConfigFieldsFromManifest({
        tools: [
          {
            name: 'text_tool',
            config_schema: [
              {
                key: 'label',
                label: 'Label',
                field_type: 'text',
                storage: 'config',
                default: '',
              },
            ],
          },
        ],
      }),
    /text_tool.*config_schema.*field_type/
  );
});

test('tool config schema rejects conflicting duplicate field definitions', () => {
  assert.throws(
    () =>
      buildToolConfigFieldsFromManifest({
        tools: [
          {
            name: 'first_tool',
            config_schema: [
              {
                key: 'shared',
                label: 'Shared',
                field_type: 'toggle',
                storage: 'config',
                default: false,
                tool_ids: ['first_tool'],
              },
            ],
          },
          {
            name: 'second_tool',
            config_schema: [
              {
                key: 'shared',
                label: 'Different shared',
                field_type: 'toggle',
                storage: 'config',
                default: false,
                tool_ids: ['second_tool'],
              },
            ],
          },
        ],
      }),
    /shared.*conflicting/
  );
});

test('tool config schema merges duplicate field tool ids when definitions match', () => {
  assert.deepEqual(
    buildToolConfigFieldsFromManifest({
      tools: [
        {
          name: 'first_tool',
          config_schema: [
            {
              key: 'shared',
              label: 'Shared',
              field_type: 'toggle',
              storage: 'config',
              default: false,
              tool_ids: ['first_tool'],
            },
          ],
        },
        {
          name: 'second_tool',
          config_schema: [
            {
              key: 'shared',
              label: 'Shared',
              field_type: 'toggle',
              storage: 'config',
              default: false,
              tool_ids: ['second_tool'],
            },
          ],
        },
      ],
    }),
    [
      {
        key: 'shared',
        label: 'Shared',
        fieldType: 'toggle',
        storage: 'config',
        default: false,
        helpText: '',
        configFlag: '',
        toolIds: ['first_tool', 'second_tool'],
      },
    ]
  );
});
