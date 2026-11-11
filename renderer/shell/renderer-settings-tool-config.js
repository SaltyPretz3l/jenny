/* renderer/shell/renderer-settings-tool-config.js - the Tools page switch-field model.
 *
 * Split out of renderer-settings-support.js (which keeps re-exporting the surface): the built-in
 * switch fields, the normalizers for the backend's toolConfig payload and the render-time field list.
 * Loads after renderer-settings-field-descriptors.js, whose copy the built-in fields read.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsToolConfig = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function isPlainObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  // The switch copy (label, help, detail) is written once, on the descriptors
  // (settings-tool-config-<key>); every reader of these fields still finds it here.
  const toolDescriptors = globalThis.rendererSettingsFieldDescriptors || (typeof require === 'function' ? require('./renderer-settings-field-descriptors.js') : null);
  const DEFAULT_TOOL_CONFIG_FIELDS = Object.freeze([
    {
      key: 'fileTools',
      fieldType: 'toggle',
      storage: 'config',
      default: true,
      configFlag: '',
      toolIds: Object.freeze(['read_file', 'write_file', 'edit_file', 'delete_file', 'glob_files', 'grep_search', 'list_dir', 'create_artifact']),
    },
    {
      key: 'richFiles',
      fieldType: 'toggle',
      storage: 'config',
      default: true,
      configFlag: 'tools_rich_files_enabled',
      toolIds: Object.freeze(['read_file']),
    },
    {
      key: 'imageRead',
      fieldType: 'toggle',
      storage: 'config',
      default: false,
      configFlag: 'tools_image_read_enabled',
      toolIds: Object.freeze(['read_file']),
    },
    {
      key: 'web',
      fieldType: 'toggle',
      storage: 'config',
      default: false,
      configFlag: 'tools_web_enabled',
      toolIds: Object.freeze(['web_search', 'fetch_url']),
    },
    {
      key: 'bash',
      fieldType: 'toggle',
      storage: 'config',
      default: true,
      configFlag: '',
      toolIds: Object.freeze(['run_command', 'run_temp_script', 'check_background_job', 'stop_background_job']),
    },
    {
      key: 'pythonRuntime',
      fieldType: 'toggle',
      storage: 'config',
      default: false,
      configFlag: 'tools_python_runtime_enabled',
      toolIds: Object.freeze(['python_execute']),
    },
    {
      key: 'lsp',
      fieldType: 'toggle',
      storage: 'config',
      default: false,
      configFlag: 'tools_lsp_enabled',
      toolIds: Object.freeze(['lsp']),
    },
    {
      key: 'worktree',
      fieldType: 'toggle',
      storage: 'config',
      default: false,
      configFlag: 'tools_worktree_enabled',
      toolIds: Object.freeze(['worktree_list', 'worktree_create', 'worktree_select', 'worktree_delete']),
    },
    {
      key: 'subagents',
      fieldType: 'toggle',
      storage: 'config',
      default: true,
      configFlag: 'tools_subagents_enabled',
      toolIds: Object.freeze(['delegate']),
    },
  ].map((field) => {
    const copy = toolDescriptors.getSettingDescriptor('settings-tool-config-' + field.key).copy;
    return Object.freeze(Object.assign(field, { label: copy.label, helpText: copy.description, detail: copy.detail }));
  }));

  function readMetadataField(source, keys) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        return source[key];
      }
    }
    return undefined;
  }

  function normalizeToolIds(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    const ids = [];
    for (const entry of value) {
      const id = normalizeString(entry);
      if (id && !ids.includes(id)) {
        ids.push(id);
      }
    }
    return ids;
  }

  function cloneToolConfigField(field) {
    return {
      key: field.key,
      label: field.label,
      fieldType: field.fieldType,
      storage: field.storage,
      default: field.default === true,
      helpText: field.helpText,
      configFlag: field.configFlag,
      toolIds: [...(field.toolIds || [])],
    };
  }

  function hasControlCharacter(value) {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code < 32 || code === 127) {
        return true;
      }
    }
    return false;
  }

  function normalizeToolConfigField(rawField) {
    if (!isPlainObject(rawField)) {
      return null;
    }
    const key = normalizeString(rawField.key);
    if (!key || hasControlCharacter(key)) {
      return null;
    }
    const label = normalizeString(rawField.label);
    if (!label) return null;
    const fieldType = normalizeString(readMetadataField(rawField, ['fieldType', 'field_type'])) || 'toggle';
    const storage = normalizeString(rawField.storage) || 'config';
    if (fieldType !== 'toggle' || storage !== 'config') {
      return null;
    }
    if (
      Object.prototype.hasOwnProperty.call(rawField, 'default')
      && typeof rawField.default !== 'boolean'
    ) {
      return null;
    }
    return {
      key,
      label,
      fieldType,
      storage,
      default: rawField.default === true,
      helpText: normalizeString(readMetadataField(rawField, ['helpText', 'help_text'])),
      configFlag: normalizeString(readMetadataField(rawField, ['configFlag', 'config_flag'])),
      toolIds: normalizeToolIds(readMetadataField(rawField, ['toolIds', 'tool_ids'])),
    };
  }

  function normalizeToolConfigFields(fields) {
    return (Array.isArray(fields) ? fields : [])
      .map(normalizeToolConfigField)
      .filter(Boolean);
  }

  function normalizeToolConfig(toolConfig) {
    if (!isPlainObject(toolConfig)) {
      return { schemaVersion: 0, fields: [] };
    }
    const schemaVersion = Number(toolConfig.schemaVersion);
    return {
      schemaVersion: Number.isSafeInteger(schemaVersion) && schemaVersion >= 0 ? schemaVersion : 0,
      fields: normalizeToolConfigFields(toolConfig.fields),
    };
  }

  function getToolConfigFieldsForRender(featureState) {
    const normalizedConfig = normalizeToolConfig(featureState?.toolConfig);
    const fields = normalizedConfig.fields.length
      ? normalizedConfig.fields
      : DEFAULT_TOOL_CONFIG_FIELDS;
    return fields.map(cloneToolConfigField);
  }

  return {
    DEFAULT_TOOL_CONFIG_FIELDS,
    normalizeToolConfig,
    normalizeToolConfigFields,
    getToolConfigFieldsForRender,
  };
});
