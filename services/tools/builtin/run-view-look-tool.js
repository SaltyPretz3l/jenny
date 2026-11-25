'use strict';

/* services/tools/builtin/run-view-look-tool.js: `run_view_look` (roadmap row 197)
 *
 * One picture of the window of the program running in the project's Live tab, so the model can see
 * what its change did. The run service takes the picture (the helper captures the window; nothing
 * comes from the renderer) and this file maps it to a result. The picture goes to a model on this
 * computer only. Only the one text line is ever saved; the picture is forwarded as a preview image. */

const { isLocalEngine, openAiCompatibleUrlFromService } = require('../../backend/session-lockdown-gate');
const { manifestSchema } = require('./tool-result');
const { checkRunViewCall, failure, reasonWord } = require('./run-view-tool-support');

const KIND = 'run_view_look';
const NOT_RUNNING = 'Nothing is running in the Live tab. Use run_view_restart to build and start it.';
const MINIMIZED = 'The program\'s window is minimised, so there is nothing to look at. Ask the user to restore it, or use run_view_restart.';
const LOCAL_ONLY = 'Pictures of the program are only sent to a model running on this computer.';

function engineIsLocal(context) {
  try {
    const service = context.backendService;
    return isLocalEngine(service?.currentEngineType, openAiCompatibleUrlFromService(service));
  } catch (_error) {
    return false;
  }
}

function changeWords(changed) {
  if (changed === null) return 'first look at this run';
  return changed ? 'changed since the last look' : 'unchanged since the last look';
}

function toResult(picture) {
  const line = `Live picture: generation ${picture.generation}, frame ${picture.signature.slice(0, 8)}, ${changeWords(picture.changed)}.`;
  return {
    content: line,
    summary: 'Live: picture',
    isError: false,
    metadata: {
      result_kind: KIND, status: 'ok', step_summary: line,
      generation: picture.generation, signature: picture.signature, changed: picture.changed,
    },
    previewImage: {
      buffer: Buffer.from(picture.pngBase64, 'base64'), width: picture.width, height: picture.height, mime_type: 'image/png',
    },
  };
}

module.exports = {
  name: 'run_view_look', ...manifestSchema('run_view_look'), category: 'builtin', workspaceRequired: true,
  readOnly: true, sideEffecting: false,
  summarize: () => 'Live: look',
  async execute(input, context = {}) {
    const checked = checkRunViewCall(KIND, input, context, { restart: false });
    if (checked.failure) return checked.failure;
    if (!engineIsLocal(context)) return failure(KIND, 'refused', LOCAL_ONLY);
    try {
      const service = checked.holder.peek();
      if (!service) return failure(KIND, 'not_running', NOT_RUNNING);
      const outcome = await service.look({ projectId: checked.projectId });
      if (outcome?.ok === true) return toResult(outcome);
      if (outcome?.reason === 'not_running') return failure(KIND, 'not_running', NOT_RUNNING);
      if (outcome?.reason === 'minimized') return failure(KIND, 'minimized', MINIMIZED);
      return failure(KIND, 'failed', `The picture could not be taken (${reasonWord(outcome?.reason)}).`);
    } catch (_error) {
      return failure(KIND, 'failed', 'The picture could not be taken.');
    }
  },
};
