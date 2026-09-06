/**
 * Session templates for Jenny.
 *
 * Templates capture a named configuration preset (context preferences,
 * model, effort, conversation mode) that can be applied when creating
 * new sessions.  Templates are persisted in shell config.
 */

const { normalizeContextPreferences } = require('./context-preferences');

const MAX_TEMPLATES = 20;

function createTemplateId() {
  return `tpl_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function normalizeTemplate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const id = String(input.id || '').trim();
  const name = String(input.name || '').trim();
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name: name.slice(0, 80),
    description: String(input.description || '').trim().slice(0, 200),
    context_preferences: normalizeContextPreferences(input.context_preferences),
    preferred_model: String(input.preferred_model || '').trim(),
    reasoning_effort: normalizeEffort(input.reasoning_effort),
    conversation_mode: normalizeConvMode(input.conversation_mode),
    linked_session_ids: normalizeLinkedIds(input.linked_session_ids),
    created_at: String(input.created_at || new Date().toISOString()),
  };
}

function normalizeEffort(value) {
  const token = String(value || '').trim().toLowerCase();
  return ['low', 'medium', 'high'].includes(token) ? token : 'default';
}

function normalizeConvMode(value) {
  const token = String(value || '').trim().toLowerCase();
  return token === 'interactive' ? 'interactive' : 'chat';
}

function normalizeLinkedIds(value) {
  if (!Array.isArray(value)) { return []; }
  return value
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .slice(0, 8);
}

class SessionTemplateStore {
  /**
   * @param {Object} shellConfigService - Shell config service for persistence
   */
  constructor(shellConfigService) {
    this.shellConfigService = shellConfigService;
  }

  _readTemplates() {
    if (!this.shellConfigService || typeof this.shellConfigService.get !== 'function') {
      return [];
    }
    const raw = this.shellConfigService.get('session_templates');
    if (!Array.isArray(raw)) { return []; }
    return raw.map(normalizeTemplate).filter(Boolean);
  }

  _writeTemplates(templates) {
    if (!this.shellConfigService || typeof this.shellConfigService.set !== 'function') {
      return;
    }
    this.shellConfigService.set('session_templates', templates.slice(0, MAX_TEMPLATES));
  }

  list() {
    return this._readTemplates();
  }

  save(template) {
    const templates = this._readTemplates();
    const input = { ...template };
    if (!input.id) {
      input.id = createTemplateId();
    }
    const normalized = normalizeTemplate(input);
    if (!normalized) { return null; }

    const existingIndex = templates.findIndex((t) => t.id === normalized.id);
    if (existingIndex >= 0) {
      templates[existingIndex] = normalized;
    } else {
      templates.push(normalized);
    }
    this._writeTemplates(templates);
    return normalized;
  }

  delete(templateId) {
    const id = String(templateId || '').trim();
    if (!id) { return false; }
    const templates = this._readTemplates();
    const filtered = templates.filter((t) => t.id !== id);
    if (filtered.length === templates.length) { return false; }
    this._writeTemplates(filtered);
    return true;
  }

  /**
   * Apply a template to create a new session with the template's preferences.
   *
   * @param {string} templateId
   * @param {Object} sessionStore - ElectronSessionStore instance
   * @returns {Object|null} Session summary or null
   */
  apply(templateId, sessionStore) {
    const templates = this._readTemplates();
    const template = templates.find((t) => t.id === templateId);
    if (!template) { return null; }

    return sessionStore.createSession({
      title: `${template.name} session`,
      preferences: {
        preferred_model: template.preferred_model,
        reasoning_effort: template.reasoning_effort,
        conversation_mode: template.conversation_mode,
        context_preferences: template.context_preferences,
        linked_session_ids: template.linked_session_ids,
      },
    });
  }
}

module.exports = {
  SessionTemplateStore,
  normalizeTemplate,
  createTemplateId,
};
