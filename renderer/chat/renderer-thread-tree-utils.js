(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererThreadTreeUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function normalizeId(value) {
    return String(value || '').trim();
  }

  function normalizeKind(message) {
    return normalizeId(message && message.kind || '').toLowerCase();
  }

  function normalizeRole(message) {
    return normalizeId(message && message.role || '').toLowerCase();
  }

  function isStandaloneAssistantKind(kind) {
    return kind === 'proactive_suggestion' || kind === 'slash_command_output';
  }

  function extractMessageStreamId(message) {
    var directId = normalizeId(
      message && (
        message.streamId
        || message.stream_id
        || message.request_id
        || message.requestId
      )
    );
    if (directId) {
      return directId;
    }
    var messageId = normalizeId(message && message.id);
    if (!messageId) {
      return '';
    }
    if (messageId.indexOf('assistant_') === 0) {
      return messageId
        .slice('assistant_'.length)
        .replace(/_seg\d+$/i, '');
    }
    if (messageId.indexOf('question_batch_') === 0) {
      return messageId.slice('question_batch_'.length);
    }
    if (messageId.indexOf('interactive_round_recap_') === 0) {
      return messageId.slice('interactive_round_recap_'.length);
    }
    return '';
  }

  function extractToolParentStreamId(message) {
    return normalizeId(
      message
      && message.tool_call
      && message.tool_call.parent_stream_id
    );
  }

  function createThreadRecord(message, index, userAnchorId, buildInteractiveRecapViewModel) {
    var kind = normalizeKind(message);
    return {
      id: normalizeId(message && message.id) || ('thread_node_' + index),
      index: index,
      role: normalizeRole(message),
      kind: kind,
      message: message,
      userAnchorId: normalizeId(userAnchorId),
      streamId: extractMessageStreamId(message),
      recapModel: kind === 'interactive_round_recap' && typeof buildInteractiveRecapViewModel === 'function'
        ? buildInteractiveRecapViewModel(message)
        : null,
    };
  }

  function buildTranscriptThreadTree(messages, options) {
    var settings = options || {};
    var buildInteractiveRecapViewModel = settings.buildInteractiveRecapViewModel;
    var list = Array.isArray(messages) ? messages : [];
    var records = [];
    var nodeById = new Map();
    var roots = [];
    var currentUserAnchorId = '';

    for (var index = 0; index < list.length; index += 1) {
      var message = list[index];
      if (!message || normalizeKind(message) === 'tool_result') {
        continue;
      }

      var role = normalizeRole(message);
      var record = createThreadRecord(message, index, currentUserAnchorId, buildInteractiveRecapViewModel);
      records.push(record);

      if (role === 'user') {
        currentUserAnchorId = record.id;
        record.userAnchorId = record.id;
      }
    }

    for (var recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
      var current = records[recordIndex];
      nodeById.set(current.id, {
        id: current.id,
        index: current.index,
        role: current.role,
        kind: current.kind,
        message: current.message,
        streamId: current.streamId,
        userAnchorId: current.userAnchorId,
        recapModel: current.recapModel,
        parentId: '',
        children: [],
      });
    }

    var latestAssistantByStreamId = new Map();
    var latestQuestionBatchByStreamId = new Map();

    for (var attachIndex = 0; attachIndex < records.length; attachIndex += 1) {
      var entry = records[attachIndex];
      var node = nodeById.get(entry.id);
      var parentId = '';
      var streamId = normalizeId(entry.streamId);

      if (entry.role === 'user') {
        parentId = '';
      } else if (entry.kind === 'tool_use') {
        var parentStreamId = extractToolParentStreamId(entry.message);
        parentId = normalizeId(
          latestAssistantByStreamId.get(parentStreamId)
          || latestQuestionBatchByStreamId.get(parentStreamId)
          || entry.userAnchorId
        );
      } else if (entry.kind === 'interactive_round_recap') {
        var recapRequestId = normalizeId(
          entry.recapModel && entry.recapModel.requestId
          || entry.message && (entry.message.request_id || entry.message.requestId)
          || entry.streamId
        );
        parentId = normalizeId(
          latestAssistantByStreamId.get(recapRequestId)
          || latestQuestionBatchByStreamId.get(recapRequestId)
          || entry.userAnchorId
        );
      } else if (isStandaloneAssistantKind(entry.kind)) {
        parentId = '';
      } else if (entry.kind === 'question_batch') {
        parentId = normalizeId(entry.userAnchorId);
      } else if (entry.role === 'assistant') {
        // Keep repeated assistant iterations as siblings under the stable turn
        // anchor; tools still nest under the latest assistant for the stream.
        parentId = normalizeId(
          latestQuestionBatchByStreamId.get(streamId)
          || entry.userAnchorId
        );
      }

      if (parentId && parentId !== entry.id && nodeById.has(parentId)) {
        node.parentId = parentId;
        nodeById.get(parentId).children.push(node);
      } else {
        node.parentId = '';
        roots.push(node);
      }

      if (entry.kind === 'question_batch' && streamId) {
        latestQuestionBatchByStreamId.set(streamId, entry.id);
      } else if (
        entry.role === 'assistant'
        && streamId
        && entry.kind !== 'interactive_round_recap'
        && !isStandaloneAssistantKind(entry.kind)
      ) {
        latestAssistantByStreamId.set(streamId, entry.id);
      }
    }

    return {
      roots: roots,
      nodeById: nodeById,
      hasNestedNodes: records.some(function (record) {
        var node = nodeById.get(record.id);
        return Boolean(node && node.parentId);
      }),
    };
  }

  function collectThreadLineageIds(nodeById, messageId, options) {
    var ids = new Set();
    if (!nodeById || typeof nodeById.get !== 'function') {
      return ids;
    }
    var settings = options || {};
    var currentId = normalizeId(messageId);
    if (!currentId) {
      return ids;
    }
    if (!nodeById.get(currentId)) {
      return ids;
    }
    if (settings.includeSelf) {
      ids.add(currentId);
    }
    var visitedNodeIds = new Set();
    while (currentId) {
      if (visitedNodeIds.has(currentId)) {
        break;
      }
      visitedNodeIds.add(currentId);
      var cursor = nodeById.get(currentId) || null;
      if (!cursor) {
        break;
      }
      var parentId = normalizeId(cursor.parentId);
      if (!parentId || parentId === currentId || visitedNodeIds.has(parentId) || ids.has(parentId)) {
        break;
      }
      ids.add(parentId);
      currentId = parentId;
    }
    return ids;
  }

  function collectThreadAncestorIds(nodeById, messageId) {
    return collectThreadLineageIds(nodeById, messageId);
  }

  function collectThreadBranchIds(nodeById, messageId) {
    return collectThreadLineageIds(nodeById, messageId, { includeSelf: true });
  }

  function shouldShowThreadToggle(node) {
    if (!node || normalizeRole(node.message) !== 'assistant') {
      return false;
    }
    if (normalizeKind(node.message) === 'tool_use') {
      return false;
    }
    var children = Array.isArray(node.children) ? node.children : [];
    if (!children.length) {
      return false;
    }
    var toolChildCount = 0;
    var nonToolChildCount = 0;
    for (var index = 0; index < children.length; index += 1) {
      var child = children[index];
      if (normalizeKind(child && child.message) === 'tool_use') {
        toolChildCount += 1;
      } else {
        nonToolChildCount += 1;
      }
    }
    return nonToolChildCount > 0 || toolChildCount > 1;
  }

    return {
      buildTranscriptThreadTree: buildTranscriptThreadTree,
      collectThreadAncestorIds: collectThreadAncestorIds,
      collectThreadBranchIds: collectThreadBranchIds,
      extractMessageStreamId: extractMessageStreamId,
      extractToolParentStreamId: extractToolParentStreamId,
      shouldShowThreadToggle: shouldShowThreadToggle,
  };
});
